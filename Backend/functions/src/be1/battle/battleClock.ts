import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";

let offsetMs: number | undefined;
let initialSync: Promise<void> | undefined;

/** Wait for Firebase's clock offset before using battle deadlines. */
export async function syncBattleClock(): Promise<void> {
  if (offsetMs !== undefined) return;
  initialSync ??= new Promise<void>((resolve, reject) => {
    const offset = adminDb.ref(".info/serverTimeOffset");
    const onOffset: Parameters<typeof offset.on>[1] = (snapshot) => {
      const value = snapshot.val();
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      offsetMs = value;
      clearTimeout(timer);
      resolve();
    };
    const fail = () => {
      clearTimeout(timer);
      offset.off("value", onOffset);
      reject(new HttpsError("unavailable", "Battle clock is unavailable."));
    };
    const timer = setTimeout(fail, 5000);
    // Keep listening so the SDK can correct the offset after reconnecting.
    offset.on("value", onOffset, fail);
  }).catch((error) => {
    initialSync = undefined;
    throw error;
  });
  await initialSync;
}

/** @return {number} Estimated Realtime Database time in milliseconds. */
export function battleNow(): number {
  if (offsetMs === undefined) {
    throw new HttpsError("unavailable", "Battle clock is unavailable.");
  }
  return Date.now() + offsetMs;
}
