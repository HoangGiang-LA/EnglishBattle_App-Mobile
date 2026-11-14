import {HttpsError, onCall} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {transactionWithRetry} from "../databaseTransaction";
import {enforceUserSession} from "../auth/userSession";
import {activeBattleUser} from "../battle/battleAccess";

export const setNotificationPreference = onCall(
  {region: "asia-southeast1", maxInstances: 10}, async (request) => {
    await enforceUserSession(request);
    const uid = request.auth?.uid;
    await activeBattleUser(uid);
    const data = request.data || {};
    if (Object.keys(data).some((key) =>
      !["enabled", "accountUid"].includes(key)) ||
        typeof data.enabled !== "boolean" || data.accountUid !== uid) {
      throw new HttpsError("invalid-argument", "Invalid preference.");
    }
    await transactionWithRetry(adminDb.ref(`notifications/${uid}`),
      (current) => ({...current,
        _settings: {enabled: data.enabled, updatedAt: Date.now()},
      }));
    await adminDb.ref(`userSettings/${uid}`).update({
      notificationsEnabled: data.enabled, updatedAt: Date.now(),
    });
    return {serverNow: Date.now(), enabled: data.enabled};
  },
);
