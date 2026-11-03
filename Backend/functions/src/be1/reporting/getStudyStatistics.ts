import {enforceUserSession} from "../auth/userSession";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {activeBattleUser} from "../battle/battleAccess";
import {getDateKey} from "../practice/attemptHelper";
import {integer} from "../community/notifications";
import {backfillReporting} from "./maintenance";
import {emptyMetric, Metric, skillIds, studyStreak} from "./activity";

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const periodBounds = (period: string, now: number) => {
  const today = getDateKey(now);
  const day = Date.parse(`${today}T00:00:00Z`);
  const d = new Date(day);
  const from = period === "week" ?
    day - ((d.getUTCDay() + 6) % 7) * 86400000 :
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const to = period === "week" ? from + 7 * 86400000 :
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const previous = period === "week" ? from - 7 * 86400000 :
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  return {today, from: date(from), to: date(to), previousFrom: date(previous),
    previousTo: date(from)};
};
const add = (target: Metric, raw: Record<string, unknown>) => {
  for (const key of ["sessions", "answered", "correct", "durationMs",
    "unknownDurationSessions"] as const) target[key] += integer(raw[key]);
  const skills = raw.skills as Metric["skills"] | undefined;
  for (const id of skillIds) {
    target.skills[id] ||= {answered: 0, correct: 0};
    target.skills[id].answered += integer(skills?.[id]?.answered);
    target.skills[id].correct += integer(skills?.[id]?.correct);
  }
};
export const getStudyStatistics = onCall({region: "asia-southeast1",
  timeoutSeconds: 120, maxInstances: 10}, async (request) => {
  await enforceUserSession(request);
  const uid = request.auth?.uid;
  await activeBattleUser(uid);
  const {period} = request.data || {};
  if (!["week", "month"].includes(period) ||
      Object.keys(request.data || {}).some((key) => key !== "period")) {
    throw new HttpsError("invalid-argument", "Invalid statistics period.");
  }
  if (!await backfillReporting(uid!, 4)) {
    throw new HttpsError("unavailable",
      "Preparing complete statistics; retry.");
  }
  const now = Date.now();
  const bounds = periodBounds(period, now);
  const snapshot = await adminDb.ref(`userActivityDaily/${uid}`).orderByKey()
    .startAt(bounds.previousFrom).endBefore(bounds.to).get();
  const raw = snapshot.val() || {};
  const current = emptyMetric();
  const previous = emptyMetric();
  for (const [day, value] of Object.entries(raw)) {
    if (day <= bounds.today) {
      add(day >= bounds.from ? current : previous,
      value as Record<string, unknown>);
    }
  }
  const days = [];
  for (let at = Date.parse(`${bounds.from}T00:00:00Z`);
    date(at) < bounds.to; at += 86400000) {
    const key = date(at);
    const metric = emptyMetric();
    if (key <= bounds.today && raw[key]) add(metric, raw[key]);
    days.push({date: key, ...metric});
  }
  const accuracyDelta = current.answered && previous.answered ?
    (current.correct / current.answered -
      previous.correct / previous.answered) * 100 : null;
  return {serverNow: now, statistics: {...bounds, period,
    timeZone: "Asia/Ho_Chi_Minh", current, previous, days,
    accuracyDelta, streak: await studyStreak(uid!, bounds.today)}};
});
