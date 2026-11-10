import {CallableRequest, HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../../config/firebaseAdmin";

/** Check the server revocation fence even after a banned account is reopened. */
export async function enforceUserSession(request: CallableRequest) {
  const uid = request.auth?.uid;
  if (!uid) return;
  const access = (await adminDb.ref(`accountAccess/${uid}`).get()).val();
  if (access?.status === "active" && access.sessionsValidAfter) {
    const authTime = Number(request.auth?.token?.auth_time) * 1000;
    if (!Number.isFinite(authTime) || authTime < access.sessionsValidAfter) {
      throw new HttpsError("unauthenticated", "Sign in again.");
    }
  }
  return access as {status?: string} | null;
}

/** Check the account and its session fence with a single access-record read. */
export async function requireActiveUserSession(request: CallableRequest): Promise<string> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "You must sign in first.");
  const [access, user] = await Promise.all([
    enforceUserSession(request),
    adminAuth.getUser(uid),
  ]);
  if (user.disabled || access?.status !== "active") {
    throw new HttpsError("permission-denied", "This account is not active.");
  }
  return uid;
}
