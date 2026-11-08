import {createHash, randomUUID} from "node:crypto";
import {Auth} from "firebase-admin/auth";
import {Database} from "firebase-admin/database";
import {HttpsError} from "firebase-functions/v2/https";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {acquireMembership, protectLastAdmin, releaseMembership, userLockKey} from "./membership";
import {ADMIN_POLICY as P} from "./policy";
import {writeAdminAudit} from "./audit";

export interface RoleChange {action: "grant" | "revoke"; uid: string; requestId: string; reason: string}
interface RoleOperation extends RoleChange {
  id: string; phase: string; createdAt: number; completedAt?: number; dueAt?: number;
  owner?: string; leaseUntil?: number; claimDone?: boolean; revokeDone?: boolean; inFlight?: string; errorCode?: string;
  fingerprint?: string; compacted?: boolean;
}

async function finishRole(db: Database, op: RoleOperation): Promise<void> {
  await writeAdminAudit(db, op.id, {
    id: op.id, operationId: op.id, actor: "server_operator", actorType: "service",
    action: `server${op.action === "grant" ? "Grant" : "Revoke"}Admin`, target: `user/${op.uid}`,
    reason: /password|token|private.?key|bearer/i.test(op.reason) ? "[redacted sensitive reason]" : op.reason,
    result: op.phase, at: op.completedAt, expiresAt: op.completedAt! + P.auditMs,
    ...(op.errorCode ? {errorCode: op.errorCode} : {}),
  });
  if (op.phase !== "blocked") {
    await transactionWithRetry(db.ref(`adminResourceLocks/${userLockKey(op.uid)}`), (c) =>
      !c || c.operationId === op.id ? null : undefined);
    await releaseMembership(db, op.id);
  }
  await db.ref(`adminRoleOperations/${op.id}`).update({dueAt: null,
    cleanupAt: op.phase === "blocked" ? null : op.completedAt! + P.operationDataMs});
}

/** SDK server authority only. No callable or browser can create role operations. */
export async function changeAdminRole(auth: Auth, db: Database, input: RoleChange): Promise<void> {
  if (!["grant", "revoke"].includes(input.action) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.uid) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || !input.reason.trim() || input.reason.length > 500) {
    throw new HttpsError("invalid-argument", "Invalid server role operation.");
  }
  const id = createHash("sha256").update(JSON.stringify(["server-role", input.uid, input.action, input.requestId]))
    .digest("hex");
  const ref = db.ref(`adminRoleOperations/${id}`);
  const fingerprint = createHash("sha256").update(JSON.stringify([input.action, input.uid, input.requestId, input.reason]))
    .digest("hex");
  const reserved = await transactionWithRetry(ref, (c) => c || {
    ...input, id, fingerprint, phase: "pending", createdAt: Date.now(), dueAt: Date.now(),
  });
  const initial = reserved.snapshot.val() as RoleOperation;
  if (initial.fingerprint ? initial.fingerprint !== fingerprint : initial.reason !== input.reason) {
    throw new HttpsError("already-exists", "requestId payload conflict.");
  }
  if (initial.compacted) {
    if (initial.phase === "succeeded") return;
    throw new HttpsError("failed-precondition", "Role change was previously rejected.", {reason: initial.errorCode});
  }
  if (["succeeded", "failed", "blocked"].includes(initial.phase)) {
    await finishRole(db, initial);
    if (initial.phase !== "succeeded") {
      throw new HttpsError("failed-precondition", "Role change rejected or needs review.", {
        reason: initial.errorCode || "role-change-blocked",
      });
    }
    return;
  }
  const owner = randomUUID();
  const lease = await transactionWithRetry(ref, (c: RoleOperation | null) => {
    if (!c) return c;
    if (c.leaseUntil && c.leaseUntil > Date.now()) return;
    if (c.inFlight) return {...c, phase: "blocked", completedAt: Date.now(), errorCode: "external-outcome-unknown"};
    return {...c, owner, phase: "running", leaseUntil: Date.now() + P.leaseMs};
  });
  if (!lease.committed) throw new HttpsError("aborted", "Role operation is running. Retry the same requestId.");
  if (lease.snapshot.val()?.phase === "blocked") {
    await finishRole(db, lease.snapshot.val());
    throw new HttpsError("failed-precondition", "External role change outcome requires review.");
  }
  const check = async () => {
    const op = (await ref.get()).val() as RoleOperation;
    if (op.owner !== owner || op.phase !== "running" || op.leaseUntil! <= Date.now()) {
      throw new HttpsError("aborted", "Role operation lease lost.");
    }
    return op;
  };
  const external = async (step: "claimDone" | "revokeDone", apply: () => Promise<void>) => {
    if ((await check())[step]) return;
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner || c.phase !== "running") return;
      return {...c, inFlight: step};
    });
    await check();
    await apply();
    await check();
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner || c.phase !== "running") return;
      return {...c, [step]: true, inFlight: null};
    });
  };
  try {
    await acquireMembership(db, id);
    const locked = await transactionWithRetry(db.ref(`adminResourceLocks/${userLockKey(input.uid)}`), (c) => {
      if (c && c.operationId !== id) return;
      return {operationId: id};
    });
    if (!locked.committed) throw new HttpsError("aborted", "A user operation is pending.");
    const user = await auth.getUser(input.uid).catch((error) => {
      if (error.code === "auth/user-not-found") throw new HttpsError("not-found", "User not found.");
      throw error;
    });
    if (input.action === "grant") {
      const access = (await db.ref(`accountAccess/${input.uid}/status`).get()).val();
      if (user.disabled || access !== "active") throw new HttpsError("failed-precondition", "Grant requires an active user.");
    } else await protectLastAdmin(auth, db, input.uid);
    await external("claimDone", async () => {
      const fresh = await auth.getUser(input.uid);
      const claims = {...fresh.customClaims};
      if (input.action === "grant") claims.admin = true;
      else delete claims.admin;
      await auth.setCustomUserClaims(input.uid, claims);
    });
    if (input.action === "revoke") {
      await external("revokeDone", () => auth.revokeRefreshTokens(input.uid));
      const currentUser = await auth.getUser(input.uid);
      const cutoff = Date.parse(currentUser.tokensValidAfterTime || "1970-01-01");
      await transactionWithRetry(db.ref(`accountAccess/${input.uid}/sessionsValidAfter`),
        (c) => Math.max(c || 0, cutoff));
    }
    const completed = await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner || c.phase !== "running") return;
      return {...c, phase: "succeeded", completedAt: Date.now(), owner: null, leaseUntil: null};
    });
    if (completed.snapshot.val()?.phase !== "succeeded") throw new HttpsError("aborted", "Role operation lease lost.");
    await finishRole(db, completed.snapshot.val());
  } catch (error) {
    const rejected = error instanceof HttpsError && ["failed-precondition", "not-found"].includes(error.code);
    const result = await transactionWithRetry(ref, (c: RoleOperation | null) => {
      if (!c) return c;
      if (c.owner !== owner || c.phase !== "running") return;
      const phase = c.inFlight ? "blocked" : rejected ? "failed" : "pending";
      return {...c, phase, owner: null, leaseUntil: null, dueAt: Date.now() + 2000,
        completedAt: phase === "pending" ? null : Date.now(),
        errorCode: c.inFlight ? "external-outcome-unknown" : error instanceof HttpsError ?
          String((error.details as {reason?: string})?.reason || error.code) : "unavailable"};
    });
    const op = result.snapshot.val() as RoleOperation;
    if (["failed", "blocked", "succeeded"].includes(op?.phase)) await finishRole(db, op);
    throw new HttpsError(op?.phase === "blocked" ? "failed-precondition" : error instanceof HttpsError ? error.code : "unavailable",
      "Role change was not completed. Retry using the original requestId.", {reason: op?.errorCode, operationId: id});
  }
}

/** Housekeeping only. Database intents must never cause background role grants. */
export async function runRoleMaintenance(db: Database): Promise<void> {
  const due = await db.ref("adminRoleOperations").orderByChild("dueAt").startAt(0).endAt(Date.now()).limitToFirst(10).get();
  const inputs: RoleOperation[] = [];
  due.forEach((c) => {
    inputs.push({...c.val(), id: c.key!});
  });
  for (const input of inputs) {
    if (["succeeded", "failed", "blocked"].includes(input.phase)) await finishRole(db, input);
    else {
      await transactionWithRetry(db.ref(`adminRoleOperations/${input.id}`), (c) => {
        if (!c) return c;
        if (!["pending", "running"].includes(c.phase)) return;
        return {...c, dueAt: Date.now() + P.leaseMs};
      });
    }
  }
}
