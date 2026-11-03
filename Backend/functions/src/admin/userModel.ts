import {HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";

export interface UserDto {
  id: string; code: string; name: string; email: string;
  status: "active" | "banned" | "deleted";
  createdAt: number; updatedAt: number; rating: number; coins: number;
  revision: number; reason?: string; invitationStatus: string;
  pendingOperation?: string;
}
export interface UserIdentity {
  name: string; email: string; revision: number; updatedAt: number;
  pendingOperation?: string; deleted?: boolean; createdByOperation?: string; lastOperationId?: string;
}
export const notFound = (error: unknown) => (error as {code?: string}).code === "auth/user-not-found";
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

export async function getAuthUser(uid: string) {
  try {
    return await adminAuth.getUser(uid);
  } catch (error) {
    if (notFound(error)) throw new HttpsError("not-found", "User not found.");
    throw error;
  }
}

/** Canonical revision is separate from wallet/stats and public profile projections. */
export async function ensureUserIdentity(uid: string): Promise<UserIdentity> {
  const ref = adminDb.ref(`adminUserState/${uid}`);
  const existing = (await ref.get()).val();
  if (existing) return existing;
  const [user, profile, access] = await Promise.all([
    getAuthUser(uid), adminDb.ref(`users/${uid}`).get(), adminDb.ref(`accountAccess/${uid}`).get(),
  ]);
  const deleted = access.val()?.status === "deleted";
  const tx = await transactionWithRetry(ref, (current) => current || {
    name: deleted ? "Tài khoản đã xóa" : (user.displayName || profile.val()?.displayName || "New Player").slice(0, 100),
    email: deleted ? "" : user.email || "", revision: count(profile.val()?.revision),
    updatedAt: count(profile.val()?.updatedAt) || Date.parse(user.metadata.creationTime) || Date.now(),
    ...(deleted ? {deleted: true} : {}),
  });
  return tx.snapshot.val();
}

export async function readAdminUser(uid: string, allowPending = false): Promise<UserDto> {
  const [user, profile, access, stats, wallet, invitation, state] = await Promise.all([
    getAuthUser(uid), adminDb.ref(`users/${uid}`).get(), adminDb.ref(`accountAccess/${uid}`).get(),
    adminDb.ref(`userStats/${uid}`).get(), adminDb.ref(`wallets/${uid}`).get(),
    adminDb.ref(`adminInvitations/${uid}`).get(), ensureUserIdentity(uid),
  ]);
  if (state.pendingOperation && !allowPending) {
    throw new HttpsError("aborted", "A user update is still pending.", {reason: "user-update-pending"});
  }
  const deleted = access.val()?.status === "deleted" || state.deleted;
  const status = deleted ? "deleted" : user.disabled || access.val()?.status !== "active" ? "banned" : "active";
  return {
    id: uid, code: String(profile.val()?.displayCode || `EB-${uid}`).slice(0, 150),
    name: deleted ? "Tài khoản đã xóa" : state.pendingOperation ? state.name :
      String(user.displayName || profile.val()?.displayName || "New Player").slice(0, 100),
    email: deleted ? "" : state.pendingOperation ? state.email : user.email || "", status,
    createdAt: Date.parse(user.metadata.creationTime) || count(profile.val()?.createdAt),
    updatedAt: Math.max(count(profile.val()?.updatedAt), count(access.val()?.updatedAt), count(state.updatedAt)),
    rating: count(stats.val()?.rating), coins: count(wallet.val()?.coinBalance), revision: state.revision,
    ...(access.val()?.reason ? {reason: String(access.val().reason).slice(0, 500)} : {}),
    invitationStatus: deleted ? "not_requested" : invitation.val()?.status || "not_requested",
    ...(state.pendingOperation ? {pendingOperation: state.pendingOperation} : {}),
  };
}

export async function readAdminProfile(uid: string) {
  const user = await readAdminUser(uid);
  return {id: uid, name: user.name, email: user.email, role: "administrator", revision: user.revision};
}
