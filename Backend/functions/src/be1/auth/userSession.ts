import {CallableRequest, HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";

/** Check the server revocation fence even after a banned account is reopened. */
export async function enforceUserSession(request: CallableRequest): Promise<void> {
  const uid = request.auth?.uid;
  if (!uid) return;
  const access = (await adminDb.ref(`accountAccess/${uid}`).get()).val();
  if (access?.status !== "active" || !access.sessionsValidAfter) return;
  const authTime = Number(request.auth?.token?.auth_time) * 1000;
  if (!Number.isFinite(authTime) || authTime < access.sessionsValidAfter) {
    throw new HttpsError("unauthenticated", "Sign in again.");
  }
}
