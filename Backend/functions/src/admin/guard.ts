import {Auth, UserRecord} from "firebase-admin/auth";
import {Database} from "firebase-admin/database";
import {CallableRequest, HttpsError} from "firebase-functions/v2/https";

export interface AdminActor {uid: string; authTime: number}

/** Recheck the original actor during recovery without persisting an ID token. */
export async function requireCurrentAdmin(
  auth: Auth, db: Database, actor: AdminActor,
): Promise<UserRecord> {
  let user: UserRecord;
  try {
    user = await auth.getUser(actor.uid);
  } catch (error) {
    if ((error as {code?: string}).code === "auth/user-not-found") {
      throw new HttpsError("permission-denied", "Account unavailable.", {reason: "account-unavailable"});
    }
    throw error;
  }
  if (user.disabled || user.customClaims?.admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access required.", {reason: "admin-required"});
  }
  if (!Number.isFinite(actor.authTime) ||
      actor.authTime < Date.parse(user.tokensValidAfterTime || "1970-01-01")) {
    throw new HttpsError("unauthenticated", "Sign in again.", {reason: "session-revoked"});
  }
  const access = (await db.ref(`accountAccess/${actor.uid}`).get()).val();
  if (access?.status !== "active") {
    throw new HttpsError("permission-denied", "Account is not active.", {
      reason: access?.status === "deleted" ? "account-deleted" : "account-inactive",
    });
  }
  return user;
}

/** Callable verification alone does not check revocation or current claims. */
export async function requireAdmin(
  request: CallableRequest, auth: Auth, db: Database,
): Promise<AdminActor> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const header = request.rawRequest?.headers?.authorization;
  const token = typeof header === "string" && /^Bearer ([^\s]+)$/i.exec(header)?.[1];
  if (!token) throw new HttpsError("unauthenticated", "A Firebase ID token is required.");
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token, true);
  } catch (error) {
    const code = String((error as {code?: string}).code);
    if (code === "auth/user-disabled") {
      throw new HttpsError("permission-denied", "Account is disabled.");
    }
    if (["auth/id-token-revoked", "auth/id-token-expired", "auth/invalid-id-token",
      "auth/argument-error", "auth/user-not-found"].includes(code)) {
      throw new HttpsError("unauthenticated", "Sign in again.");
    }
    throw new HttpsError("unavailable", "Authentication is temporarily unavailable.");
  }
  if (decoded.uid !== request.auth.uid || decoded.admin !== true ||
      request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access required.", {reason: "admin-required"});
  }
  const actor = {uid: decoded.uid, authTime: decoded.auth_time * 1000};
  await requireCurrentAdmin(auth, db, actor);
  return actor;
}
