import {randomUUID} from "node:crypto";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {adminDb} from "../../config/firebaseAdmin";
import {transactionWithRetry} from "../databaseTransaction";
import {syncLeaderboardPlayer} from "./leaderboardProjection";
import {drainNotificationReads} from "./notifications";
import {refreshPracticeNotifications} from "./practiceNotifications";
import {refreshDailyAchievements} from "./dailyAchievements";

export const runCommunityMaintenance = async (): Promise<void> => {
  const ref = adminDb.ref("communityMaintenance/discovery");
  const owner = randomUUID();
  const tx = await transactionWithRetry(ref, (c) => {
    if (c?.leaseUntil > Date.now() || c?.nextRunAt > Date.now()) return;
    return {...c, owner, leaseUntil: Date.now() + 90000};
  });
  if (tx.committed) {
    const cursor = tx.snapshot.val();
    try {
      let query = adminDb.ref("users").orderByKey();
      if (cursor.after) query = query.startAfter(cursor.after);
      const page = await query.limitToFirst(100).get();
      const ids: string[] = [];
      page.forEach((child) => {
        ids.push(child.key!);
      });
      for (let offset = 0; offset < ids.length; offset += 10) {
        const batch = await Promise.allSettled(
          ids.slice(offset, offset + 10).map(async (uid) => {
            await syncLeaderboardPlayer(uid);
            try {
              await drainNotificationReads(uid);
              await refreshPracticeNotifications(uid);
              await refreshDailyAchievements(uid);
            } catch (error) {
              console.error("Community inbox retry", {uid,
                code: (error as {code?: string}).code || "inbox-error"});
            }
          }),
        );
        const failure = batch.find((item) => item.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      const done = ids.length < 100;
      await transactionWithRetry(ref, (c) => {
        if (!c) return c;
        if (c.owner !== owner) return;
        return {
          ready: c.ready || done,
          after: done ? null : ids[ids.length - 1],
          nextRunAt: Date.now() + (done ? 60000 : 0),
        };
      });
    } catch (error) {
      await transactionWithRetry(ref, (c) => {
        if (!c) return c;
        if (c.owner !== owner) return;
        return {
          ...c,
          owner: null,
          leaseUntil: null,
          nextRunAt: Date.now() + 1000,
        };
      });
      throw error;
    }
  }
  for (const path of ["communityCursors", "communityRankings"]) {
    const expired = await adminDb
      .ref(path)
      .orderByChild("expiresAt")
      .endAt(Date.now())
      .limitToFirst(25)
      .get();
    const updates: Record<string, null> = {};
    expired.forEach((child) => {
      updates[child.key!] = null;
    });
    if (Object.keys(updates).length) {
      await adminDb.ref(path).update(updates);
    }
  }
};

export const maintainCommunity = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "asia-southeast1",
    timeZone: "Asia/Ho_Chi_Minh",
    maxInstances: 1,
  },
  runCommunityMaintenance,
);
