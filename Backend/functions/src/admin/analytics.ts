import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {adminRange, Data} from "./contracts";
import {analyticsDay, analyticsSkills} from "./analyticsModel";
import {ANALYTICS_LIMITS as L, analyticsRoot, analyticsSkillNames, emptyAnalyticsMetric} from "./analyticsProjection";
import {monitoringParticipant} from "./monitoringModel";

type Metric = ReturnType<typeof emptyAnalyticsMetric>;
interface Day {
  metric?: Metric; skills?: Record<string, Metric>; registrations?: number; registeredTotal?: number;
  unknownSkills?: number; unknownAnswers?: number; unclassifiedAnswers?: number; incompleteParticipants?: number;
}
function sumMetric(target: Metric, source?: Metric) {
  if (!source) return;
  for (const key of ["lessons", "battles", "answered", "correct", "started", "completed"] as const) {
    target[key] += source[key] || 0;
  }
  Object.assign(target.active, source.active || {});
}
const percentage = (n: number, d: number) => d ? n / d * 100 : null;
const growth = (n: number, d: number) => d ? Math.round((n - d) / d * 1000) / 10 : null;
const selectMetric = (day: Day | undefined, skill: string) => skill ? day?.skills?.[skill] : day?.metric;
const groupKey = (date: string, granularity: string) => {
  if (granularity === "month") return `${date.slice(0, 7)}-01`;
  if (granularity === "week") {
    const at = Date.parse(`${date}T00:00:00Z`); const weekday = (new Date(at).getUTCDay() + 6) % 7;
    return new Date(at - weekday * 86400000).toISOString().slice(0, 10);
  }
  return date;
};

/** Read only the published aggregate generation, never source roots or the latest 50 activities. */
export async function getAdminOverview(data: Data, generationId?: string) {
  const range = adminRange(data.range); const duration = range.days * 86400000;
  const skill = String(data.categoryId || ""); const granularity = String(data.granularity || "day");
  const control = (await adminDb.ref("adminAnalyticsControl").get()).val();
  const generation = generationId || control?.activeGeneration as string | undefined;
  const meta = generation ? (await adminDb.ref(`adminAnalyticsGenerationMeta/${generation}`).get()).val() : null;
  if (!generation || !meta?.ready || generationId && meta.expiresAt <= Date.now()) {
    throw new HttpsError("failed-precondition", "Analytics is being built.", {
      reason: "overview-not-ready",
    });
  }
  const lagMs = Math.max(0, Date.now() - meta.asOf);
  if (lagMs > L.generationMs) {
    throw new HttpsError("failed-precondition", "Analytics needs a fresh rebuild.", {
      reason: "overview-stale",
    });
  }
  const root = analyticsRoot(generation);
  const from = analyticsDay(range.from - duration); const until = analyticsDay(range.until);
  const baseline = await adminDb.ref(`${root}/daily`).orderByKey().endBefore(from).limitToLast(1).get();
  let cumulative = 0; let bytes = 0;
  baseline.forEach((child) => {
    cumulative = child.val().registeredTotal || 0;
    bytes += Buffer.byteLength(JSON.stringify(child.val()), "utf8");
  });
  const days = new Map<string, Day>();
  let after = "";
  for (;;) {
    let query = adminDb.ref(`${root}/daily`).orderByKey();
    query = after ? query.startAfter(after) : query.startAt(from);
    const batch = await query.endBefore(until).limitToFirst(7).get();
    batch.forEach((child) => {
      const value = child.val();
      bytes += Buffer.byteLength(JSON.stringify(value), "utf8");
      if (bytes > L.queryBytes) throw new HttpsError("resource-exhausted", "Analytics range exceeds 8 MiB.");
      const {receipts, ...row} = value; void receipts;
      days.set(child.key!, row); after = child.key!;
    });
    if (batch.numChildren() < 7) break;
  }
  if ([...days.values()].some((d) => d.incompleteParticipants)) {
    throw new HttpsError("failed-precondition", "Historical battles lack complete source data.", {
      reason: "overview-history-incomplete",
    });
  }
  if (skill && [...days.values()].some((d) => d.unknownSkills || d.unknownAnswers)) {
    throw new HttpsError("failed-precondition", "Historical skill allocation is incomplete.", {
      reason: "overview-skill-history-incomplete",
    });
  }
  const current = emptyAnalyticsMetric(); const previous = emptyAnalyticsMetric();
  const perSkill = Object.fromEntries(analyticsSkills.map((id) => [id, emptyAnalyticsMetric()]));
  const registered = new Map<string, number>();
  let newUsers = 0; let previousNewUsers = 0;
  let unknownSkills = false; let unknownAnswers = false; let unclassifiedAnswers = 0;
  for (let at = range.from - duration; at < range.until; at += 86400000) {
    const date = analyticsDay(at); const day = days.get(date); const inPeriod = at >= range.from;
    cumulative += Number(day?.registrations || 0); registered.set(date, cumulative);
    if (inPeriod) {
      newUsers += Number(day?.registrations || 0);
      unknownSkills ||= Boolean(day?.unknownSkills); unknownAnswers ||= Boolean(day?.unknownAnswers);
      unclassifiedAnswers += day?.unclassifiedAnswers || 0;
      sumMetric(current, selectMetric(day, skill));
      for (const id of analyticsSkills) sumMetric(perSkill[id], day?.skills?.[id]);
    } else {
      previousNewUsers += Number(day?.registrations || 0); sumMetric(previous, selectMetric(day, skill));
    }
  }
  const groups = new Map<string, {date: string; users: number; previous: number; lessons: number; battles: number;
    active: number; uids: Record<string, true>} >();
  for (let at = range.from; at < range.until; at += 86400000) {
    const date = analyticsDay(at); const key = groupKey(date, granularity);
    const metric = selectMetric(days.get(date), skill);
    const row = groups.get(key) || {date: key, users: 0, previous: 0, lessons: 0, battles: 0, active: 0, uids: {}};
    row.users = registered.get(date) || 0; row.previous = registered.get(analyticsDay(at - duration)) || 0;
    row.lessons += metric?.lessons || 0; row.battles += metric?.battles || 0;
    Object.assign(row.uids, metric?.active || {}); row.active = Object.keys(row.uids).length;
    groups.set(key, row);
  }
  const series = [...groups.values()].map(({uids, ...row}) => {
    void uids; return row;
  });
  const unknownStart = Number(meta.latestUnknownStartEnd || 0) >= range.from;
  const categories = unknownSkills || unknownAnswers ? [] : analyticsSkills.filter((id) => !skill || id === skill)
    .map((id) => ({id, name: analyticsSkillNames[id], ...Object.fromEntries(
      ["lessons", "battles", "answered", "correct", "started", "completed"].map((key) =>
        [key, perSkill[id][key as "lessons"]]),
    ), completion: unknownStart ? null : percentage(perSkill[id].completed, perSkill[id].started)}));
  const recentSnapshot = await adminDb.ref(`${root}/events/${skill || "all"}`).orderByChild("at")
    .startAt(range.from).endBefore(range.until).limitToLast(5).get();
  const recent: Data[] = [];
  recentSnapshot.forEach((child) => {
    recent.push(child.val());
  });
  recent.sort((a, b) => Number(b.at) - Number(a.at) || (String(a.id) < String(b.id) ? -1 : 1));
  for (const event of recent) event.userName = (await monitoringParticipant(String(event.userId))).name;
  return {totalUsers: meta.totalUsers, newUsers, activeUsers: Object.keys(current.active).length,
    completedBattles: current.battles, completedLessons: current.lessons,
    growth: {users: growth(newUsers, previousNewUsers), active: growth(Object.keys(current.active).length,
      Object.keys(previous.active).length), battles: growth(current.battles, previous.battles)}, series, categories,
    accuracy: unknownAnswers ? null : percentage(current.correct, current.answered),
    completion: unknownStart ? null : percentage(current.completed, current.started), recent,
    asOf: meta.asOf, lagMs, ready: true, generation, granularity, timeZone: "Asia/Ho_Chi_Minh",
    denominators: {answered: unknownAnswers ? null : current.answered, correct: unknownAnswers ? null : current.correct,
      started: current.started, completed: current.completed},
    coverage: {unknownStartSessions: meta.unknownStartSessions, unclassifiedAnswers, unknownAnswers,
      skillBreakdownComplete: !unknownSkills && !unknownAnswers, partialPeriod: range.until > meta.asOf,
      accountScope: "retained-auth", completionBasis: "started-in-period"}};
}
