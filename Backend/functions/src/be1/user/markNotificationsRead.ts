import {enforceUserSession} from "../auth/userSession";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {activeBattleUser} from "../battle/battleAccess";
import {contentId} from "../practice/contentValidation";
import {readNotification, readAllNotifications, drainNotificationReads} from
  "../community/notifications";

export const markNotificationsRead = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  async (request) => {
    await enforceUserSession(request);
    const uid = request.auth?.uid;
    await activeBattleUser(uid);
    const data = request.data || {};
    if (data.all === true && Object.keys(data).length === 1) {
      await readAllNotifications(uid!);
      await drainNotificationReads(uid!);
      return {serverNow: Date.now()};
    }
    const ids = data.ids;
    if (Object.keys(data).some((key) => key !== "ids") ||
        !Array.isArray(ids) || ids.length > 50 || ids.some((id) =>
      !contentId(id) || id.length > 512)) {
      throw new HttpsError("invalid-argument", "Invalid notification IDs.");
    }
    await Promise.all([...new Set<string>(ids)].map((id) =>
      readNotification(uid!, id)));
    await drainNotificationReads(uid!);
    return {serverNow: Date.now()};
  },
);
