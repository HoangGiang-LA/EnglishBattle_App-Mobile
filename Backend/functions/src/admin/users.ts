import {createHash} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {ServerValue} from "firebase-admin/database";
import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {createUserDefault, provisionUserProfile} from "../be1/auth/userProvisioning";
import {syncLeaderboardPlayer} from "../be1/community/leaderboardProjection";
import {finalizeAttemptLogic} from "../be1/practice/finalizeAttempt";
import {transactBattle} from "../be1/battle/battleService";
import {cancelQueuedBattle, flushBattleCoordinator} from "../be1/battle/matchmaking";
import {Data} from "./contracts";
import {OperationContext, OperationHandlers, SafeOperationError} from "./operations";
import {ReadHandlers} from "./runtime";
import {ensureUserIdentity, getAuthUser, notFound, readAdminProfile, readAdminUser, UserIdentity} from "./userModel";
import {listAdminUsers, syncAdminUserIndex} from "./userIndex";
import {protectLastAdmin} from "./membership";
import {checkInvitationResend, queueInvitation} from "./invitations";

const conflict = () => new HttpsError("failed-precondition", "The user has changed. Reload before editing.", {
  reason: "version-conflict",
});
const userId = (data: Data, id: string) => String(data.id || `admin_${id.slice(0, 40)}`);
const cleanEmail = (value: unknown) => String(value).trim().toLowerCase();

async function uniqueEmail(ctx: OperationContext, email: string, uid: string): Promise<void> {
  const key = createHash("sha256").update(email).digest("hex");
  await ctx.acquireLock(`email/${key}`);
  try {
    const other = await adminAuth.getUserByEmail(email);
    if (other.uid !== uid) {
      throw new HttpsError("already-exists", "This email is already in use.", {reason: "email-already-exists"});
    }
  } catch (error) {
    if (!notFound(error)) throw error;
  }
}

async function editable(ctx: OperationContext, uid: string, expected: unknown): Promise<UserIdentity> {
  const state = await ensureUserIdentity(uid);
  const access = (await adminDb.ref(`accountAccess/${uid}/status`).get()).val();
  const own = state.pendingOperation === ctx.id || state.lastOperationId === ctx.id;
  if (!own && (state.deleted || access === "deleted")) {
    throw new HttpsError("failed-precondition", "Deleted accounts cannot be restored or edited.", {reason: "account-deleted"});
  }
  if (!own && (state.pendingOperation || state.revision !== expected)) throw conflict();
  return state;
}

async function reserve(ctx: OperationContext, uid: string, expected: number): Promise<void> {
  await ctx.mutateRecord("reserve", `adminUserState/${uid}`, expected,
    (current) => ({...current, pendingOperation: ctx.id}));
}

/** All identity projections use the reserved revision; wallet/stats are never patched. */
async function commitIdentity(
  ctx: OperationContext, uid: string, name: string, email: string, status?: string, reason?: string,
): Promise<void> {
  const state = (await adminDb.ref(`adminUserState/${uid}`).get()).val() as UserIdentity;
  if (state.pendingOperation !== ctx.id && state.lastOperationId !== ctx.id) throw conflict();
  const updates: Data = {
    [`users/${uid}/displayName`]: name, [`users/${uid}/updatedAt`]: ctx.createdAt,
    [`users/${uid}/revision`]: state.revision, [`userPrivate/${uid}/email`]: email,
    [`userPrivate/${uid}/updatedAt`]: ctx.createdAt, [`userPrivate/${uid}/revision`]: state.revision,
  };
  if (status) {
    updates[`accountAccess/${uid}/status`] = status;
    updates[`accountAccess/${uid}/updatedAt`] = ctx.createdAt;
    updates[`accountAccess/${uid}/reason`] = reason || "";
  }
  await adminDb.ref().update(updates);
  await transactionWithRetry(adminDb.ref(`adminUserState/${uid}`), (current) => {
    if (!current) return current;
    if (current.lastOperationId === ctx.id && !current.pendingOperation) return current;
    if (current.pendingOperation !== ctx.id) return;
    return {...current, name, email, deleted: status === "deleted" || current.deleted || null,
      updatedAt: ctx.createdAt, pendingOperation: null, lastOperationId: ctx.id};
  });
}

async function settleUnavailable(uid: string): Promise<void> {
  for (const status of ["active", "waiting"]) {
    const page = await adminDb.ref(`practiceAttempts/${uid}`).orderByChild("status").equalTo(status)
      .limitToFirst(101).get();
    const ids: string[] = [];
    page.forEach((child) => {
      ids.push(child.key!);
    });
    for (const id of ids.slice(0, 100)) await finalizeAttemptLogic(uid, id, "abandoned");
    if (ids.length > 100) throw new Error("More account attempts remain for recovery");
  }
  const binding = (await adminDb.ref(`battleCoordinator/users/${uid}`).get()).val();
  if (binding?.ticketId) {
    const ticket = (await adminDb.ref(`battleCoordinator/tickets/${binding.ticketId}`).get()).val();
    if (ticket?.uid === uid && ticket.status === "searching") {
      await cancelQueuedBattle(uid, binding.ticketId, ticket.clientSessionId);
    }
  }
  await flushBattleCoordinator();
  const active = (await adminDb.ref(`activeBattles/${uid}`).get()).val();
  const matchId = active?.roomId || binding?.matchId;
  if (matchId && (await adminDb.ref(`battleRooms/${matchId}`).get()).exists()) await transactBattle(matchId);
}

async function persistSessionCutoff(uid: string): Promise<void> {
  const user = await getAuthUser(uid);
  const cutoff = Date.parse(user.tokensValidAfterTime || "1970-01-01");
  await transactionWithRetry(adminDb.ref(`accountAccess/${uid}/sessionsValidAfter`), (current) =>
    Math.max(Number(current || 0), cutoff));
}

export const userReadHandlers: ReadHandlers = {
  adminGetProfile: async (actor) => ({profile: await readAdminProfile(actor.uid)}),
  adminGetUser: async (_actor, data) => ({user: await readAdminUser(String(data.id), true)}),
  adminListUsers: async (actor, data) => ({page: await listAdminUsers(actor.uid, data.query as Data)}),
};

export const userOperationHandlers: OperationHandlers = {
  adminUpdateProfile: {
    version: 1, target: (_data, _id, actor) => `user/${actor.uid}`,
    run: async (ctx, data) => {
      await editable(ctx, ctx.actor.uid, data.expectedRevision);
      await reserve(ctx, ctx.actor.uid, Number(data.expectedRevision));
      const name = String(data.name).trim();
      await ctx.externalStep("auth-name", async () => {
        await adminAuth.updateUser(ctx.actor.uid, {displayName: name});
      });
      const user = await getAuthUser(ctx.actor.uid);
      await ctx.step("identity", () => commitIdentity(ctx, ctx.actor.uid, name, user.email || ""));
      await ctx.step("index", () => syncAdminUserIndex(ctx.actor.uid));
      await ctx.step("leaderboard", () => syncLeaderboardPlayer(ctx.actor.uid));
      return {profile: await readAdminProfile(ctx.actor.uid)};
    },
  },
  adminSaveUser: {
    version: 1, target: (data, id) => `user/${userId(data, id)}`,
    run: async (ctx, data) => {
      const uid = userId(data, ctx.id);
      const input = data.input as {name: string; email: string};
      const name = input.name.trim();
      const email = cleanEmail(input.email);
      await uniqueEmail(ctx, email, uid);
      if (!data.id) {
        await ctx.step("reserve", async () => {
          await createUserDefault(`adminUserState/${uid}`, {
            name, email, revision: 1, pendingOperation: ctx.id, createdByOperation: ctx.id, updatedAt: ctx.createdAt,
          });
          const state = await ensureUserIdentity(uid);
          if (state.createdByOperation !== ctx.id || state.deleted) throw conflict();
          await createUserDefault(`accountAccess/${uid}`, {
            status: "provisioning", createdAt: ctx.createdAt, updatedAt: ctx.createdAt,
          });
        });
        // Auth create is replay-safe with a reserved, deterministic UID. It cannot overwrite an existing user.
        await ctx.step("create-auth", async () => {
          try {
            const existing = await adminAuth.getUser(uid);
            if (existing.email?.toLowerCase() !== email) throw conflict();
          } catch (error) {
            if (!notFound(error)) throw error;
            try {
              await adminAuth.createUser({uid, email, displayName: name, emailVerified: false});
            } catch (createError) {
              const code = (createError as {code?: string}).code;
              if (code === "auth/uid-already-exists") return;
              if (code !== "auth/email-already-exists") throw createError;
              try {
                await adminAuth.getUser(uid); throw createError;
              } catch (checkError) {
                if (!notFound(checkError)) throw checkError;
              }
              await adminDb.ref().update({[`adminUserState/${uid}`]: null, [`accountAccess/${uid}`]: null});
              throw new SafeOperationError("already-exists", "This email is already in use.", {reason: "email-already-exists"});
            }
          }
        });
        await ctx.step("provision", () => provisionUserProfile(uid, true));
        await ctx.step("identity", () => commitIdentity(ctx, uid, name, email, "active"));
        await ctx.step("invitation", () => queueInvitation(uid, email, ctx.id));
      } else {
        const state = await editable(ctx, uid, data.expectedRevision);
        if (uid === ctx.actor.uid && state.email.toLowerCase() !== email) {
          throw new HttpsError("failed-precondition", "Use the signed-in account's email change flow.", {reason: "admin-self-protection"});
        }
        if (data.resendInvitation && state.pendingOperation !== ctx.id && state.lastOperationId !== ctx.id) {
          await checkInvitationResend(uid);
        }
        const before = await ctx.step("before", async () => ({name: state.name, email: state.email}));
        await reserve(ctx, uid, Number(data.expectedRevision));
        await ctx.externalStep("auth-identity", async () => {
          try {
            await adminAuth.updateUser(uid, {displayName: name, email});
          } catch (error) {
            if ((error as {code?: string}).code !== "auth/email-already-exists") throw error;
            const actual = await getAuthUser(uid);
            if (actual.email !== before.email || actual.displayName !== before.name) throw error;
            // This definitive Auth rejection changed no identity projection.
            // Restore only our unpublished reservation so the corrected form
            // can keep its original visible revision.
            await transactionWithRetry(adminDb.ref(`adminUserState/${uid}`), (current) => {
              if (!current) return current;
              if (current.pendingOperation !== ctx.id) return;
              return {...current, revision: Number(data.expectedRevision), pendingOperation: null};
            });
            throw new SafeOperationError("already-exists", "This email is already in use.", {reason: "email-already-exists"});
          }
        });
        if (before.email.toLowerCase() !== email) {
          await ctx.externalStep("revoke", async () => {
            await adminAuth.revokeRefreshTokens(uid);
          });
          await ctx.step("session-cutoff", () => persistSessionCutoff(uid));
        }
        await ctx.step("identity", () => commitIdentity(ctx, uid, name, email));
        if (data.resendInvitation) await ctx.step("invitation", () => queueInvitation(uid, email, ctx.id));
      }
      await ctx.step("index", () => syncAdminUserIndex(uid));
      await ctx.step("leaderboard", () => syncLeaderboardPlayer(uid));
      return {user: await readAdminUser(uid)};
    },
  },
  adminSetUserStatus: {
    version: 1, lockMembership: true, target: (data) => `user/${data.id}`,
    run: async (ctx, data) => {
      const uid = String(data.id);
      const status = String(data.status);
      if (uid === ctx.actor.uid && status !== "active") {
        throw new HttpsError("failed-precondition", "Administrators cannot block themselves.", {reason: "admin-self-protection"});
      }
      const state = await editable(ctx, uid, data.expectedRevision);
      if (status !== "active") await protectLastAdmin(adminAuth, adminDb, uid);
      await reserve(ctx, uid, Number(data.expectedRevision));
      if (status !== "active") {
        await ctx.step("restrict", async () => {
          await adminDb.ref().update({
            [`accountAccess/${uid}/status`]: status,
            [`accountAccess/${uid}/reason`]: String(data.reason),
            [`accountAccess/${uid}/updatedAt`]: ctx.createdAt,
            ...(status === "deleted" ? {"adminUserIndexMeta/privacyRevision": ServerValue.increment(1)} : {}),
          });
        });
      }
      await ctx.externalStep("auth-status", async () => {
        await adminAuth.updateUser(uid, {disabled: status !== "active", ...(status === "deleted" ? {
          displayName: "Tài khoản đã xóa", email: `deleted-${uid}@deleted.invalid`,
        } : {})});
      });
      if (status === "deleted") {
        await ctx.externalStep("remove-admin", async () => {
          const user = await getAuthUser(uid);
          const claims = {...user.customClaims};
          delete claims.admin;
          await adminAuth.setCustomUserClaims(uid, claims);
        });
      }
      if (status !== "active") {
        await ctx.externalStep("revoke", async () => {
          await adminAuth.revokeRefreshTokens(uid);
        });
        await ctx.step("session-cutoff", () => persistSessionCutoff(uid));
        await ctx.step("sessions", () => settleUnavailable(uid));
      }
      await ctx.step("identity", () => commitIdentity(ctx, uid,
        status === "deleted" ? "Tài khoản đã xóa" : state.name,
        status === "deleted" ? "" : state.email, status, String(data.reason)));
      await ctx.step("index", () => syncAdminUserIndex(uid));
      await ctx.step("leaderboard", () => syncLeaderboardPlayer(uid));
      return {};
    },
  },
};
