import {createHash} from "node:crypto";
import {adminDb} from "../../config/firebaseAdmin";
import {transactionWithRetry} from "../databaseTransaction";
import {getDateKey, normalizeMode} from "../practice/attemptHelper";
import {contentId, record} from "../practice/contentValidation";
import {integer, publishNotification} from "./notifications";

const condition = "completed_daily_challenge_count";
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Count successful days, checking source attempts rather than trusting slots.
 * Stop when all defined milestones are satisfied; progress then saturates.
 * @param {string} uid Owner.
 * @param {number} limit Highest published milestone.
 * @return {Promise<object[]>} Distinct successful days, newest first.
 */
async function completedDays(uid: string, limit: number) {
  const completed: {id: string; at: number}[] = [];
  let before: string | undefined;
  while (completed.length < limit) {
    let query = adminDb.ref(`userDailyChallenges/${uid}`).orderByKey();
    if (before) query = query.endBefore(before);
    const page = await query.limitToLast(25).get();
    const slots: {date: string; value: Record<string, unknown>}[] = [];
    page.forEach((child) => {
      slots.push({date: child.key!, value: record(child.val())});
    });
    const checked = await Promise.all(slots.map(async ({date, value}) => {
      if (value.status !== "completed" || !contentId(value.attemptId)) {
        return null;
      }
      const source = record((await adminDb.ref(
        `practiceAttempts/${uid}/${value.attemptId}`,
      ).get()).val());
      const start = source.startedAt || source.createdAt;
      const at = source.finishedAt;
      if (normalizeMode(source.mode) !== "DAILY" ||
          source.status !== "completed" || source.questionCount !== 5 ||
          !positive(start) || !positive(at) || at < start || at > Date.now() ||
          getDateKey(start) !== date || getDateKey(at) !== date ||
          !Number.isSafeInteger(source.correctCount) ||
          Number(source.correctCount) < 0 || Number(source.correctCount) > 5) {
        return null;
      }
      return {id: value.attemptId, at};
    }));
    completed.push(...checked.filter((v): v is {id: string; at: number} =>
      v !== null).reverse());
    if (slots.length < 25) break;
    before = slots[0].date;
  }
  return completed.slice(0, limit);
}

/**
 * Rebuild daily milestones from completed slots and immutable source results.
 * The earned record includes a durable notification, so archive or retries
 * cannot lose an unlock or create another reward. No coins are granted here.
 * @param {string} uid Owner.
 * @param {unknown} definitions Optional definitions already read by dashboard.
 * @return {Promise<object>} Fresh achievement records, including other types.
 */
export async function refreshDailyAchievements(
  uid: string,
  definitions?: unknown,
): Promise<Record<string, Record<string, unknown>>> {
  const raw = definitions ?? (await adminDb.ref("achievements").get()).val();
  const allowed = Object.entries(record(raw)).flatMap(([id, value]) => {
    const d = record(value);
    if (!contentId(id) || d.status !== "published" ||
        d.conditionType !== condition || !positive(d.threshold) ||
        typeof d.title !== "string" || !d.title.trim() ||
        d.title.length > 512) return [];
    return [{id, threshold: d.threshold, title: d.title,
      ruleVersion: typeof d.ruleVersion === "string" ? d.ruleVersion : "v1"}];
  });
  const completed = allowed.length ?
    await completedDays(uid, Math.max(...allowed.map((d) => d.threshold))) :
    [];
  for (const d of allowed) {
    await transactionWithRetry(adminDb.ref(`userAchievements/${uid}/${d.id}`),
      (stored) => {
        const s = record(stored);
        if (!completed.length && !Object.keys(s).length) return stored;
        // Successful source days only grow. An older concurrent scan must
        // not overwrite progress or a newly committed unlock.
        const progress = Math.max(completed.length,
          s.conditionType === condition ? integer(s.progress) : 0);
        const earned = integer(s.unlockedAt) > 0;
        const at = integer(s.unlockedAt) || completed[0]?.at || 0;
        const next = {...s, conditionType: condition, progress,
          threshold: earned ? s.threshold || d.threshold : d.threshold,
          ruleVersion: earned ? s.ruleVersion || d.ruleVersion : d.ruleVersion};
        if (earned || completed.length >= d.threshold) {
          const event = s.notification || {
            id: "daily_achievement_" + createHash("sha256")
              .update(d.id).digest("hex").slice(0, 32),
            title: "Mở khóa thành tích",
            body: `Bạn đã mở khóa thành tích: ${d.title}.`,
            targetType: "Achievements", sourceType: "daily_achievement",
            sourceId: d.id, createdAt: at,
          };
          return {...next, unlockedAt: at, notification: event};
        }
        return next;
      });
  }
  const records = record((
    await adminDb.ref(`userAchievements/${uid}`).get()
  ).val()) as Record<string, Record<string, unknown>>;
  for (const raw of Object.values(records)) {
    const value = record(raw);
    if (value.conditionType !== condition || !integer(value.unlockedAt)) {
      continue;
    }
    const event = record(value.notification);
    if (contentId(event.id)) await publishNotification(uid, event.id, event);
  }
  return records;
}
