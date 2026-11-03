import {enforceUserSession} from "../auth/userSession";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {activeBattleUser} from "../battle/battleAccess";
import {notificationCounts, notificationSlice} from "./notifications";
import {
  newCursor,
  PAGE_SIZE,
  PAGE_TTL_MS,
  readCursor,
} from "./pagination";

export const getNotifications = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  async (request) => {
    await enforceUserSession(request);
    const uid = request.auth?.uid;
    await activeBattleUser(uid);
    const {cursor} = request.data || {};
    if (Object.keys(request.data || {}).some((key) => key !== "cursor")) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid notification query.",
      );
    }
    const token =
      cursor == null ?
        null :
        await readCursor(uid!, "notifications", cursor);
    const expiresAt = token?.expiresAt || Date.now() + PAGE_TTL_MS;
    const counts = await notificationCounts(uid!);
    const {entries, more, time, key} = await notificationSlice(
      uid!,
      counts,
      PAGE_SIZE,
      token?.data,
    );
    const nextCursor =
      more && key ?
        await newCursor(uid!, "notifications", {time, key}, expiresAt) :
        null;
    return {
      serverNow: Date.now(),
      page: {
        entries,
        nextCursor,
        unreadCount: counts.unreadCount,
        totalCount: counts.totalCount,
      },
    };
  },
);
