import {enforceUserSession} from "./userSession";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {provisionUserProfile} from "./userProvisioning";

export const ensureUserProfile = onCall({region: "asia-southeast1", maxInstances: 10}, async (request) => {
  await enforceUserSession(request);
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "You must sign in first.");
  try {
    await provisionUserProfile(uid);
    return {serverNow: Date.now()};
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("ensureUserProfile failed", {uid, code: "profile-unavailable"});
    throw new HttpsError("internal", "Unable to initialize user profile.");
  }
});
