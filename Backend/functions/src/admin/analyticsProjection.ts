import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {AnalyticsFact, analyticsDay, analyticsKey, analyticsSkills} from "./analyticsModel";

export const ANALYTICS_LIMITS = Object.freeze({accounts: 10000, facts: 25000,
  bucketBytes: 1024 * 1024, queryBytes: 8 * 1024 * 1024, generationMs: 24 * 3600000});
export const analyticsRoot = (generation: string) => `adminAnalyticsGenerations/${generation}`;
export const emptyAnalyticsMetric = () => ({lessons: 0, battles: 0, answered: 0, correct: 0,
  started: 0, completed: 0, active: {} as Record<string, true>});
type Metric = ReturnType<typeof emptyAnalyticsMetric>;
export interface AnalyticsDay {
  metric: Metric; skills: Record<string, Metric>; registrations: number; registeredTotal: number;
  unknownSkills: number; unknownAnswers: number; unclassifiedAnswers: number; incompleteParticipants: number;
  receipts: Record<string, true>;
}
export const emptyAnalyticsDay = (): AnalyticsDay => ({metric: emptyAnalyticsMetric(), skills: {},
  registrations: 0, registeredTotal: 0, unknownSkills: 0, unknownAnswers: 0, unclassifiedAnswers: 0,
  incompleteParticipants: 0, receipts: {}});
const addMetric = (target: Metric, source: Metric) => {
  for (const key of ["lessons", "battles", "answered", "correct", "started", "completed"] as const) {
    target[key] += source[key];
  }
  Object.assign(target.active, source.active);
};

/** Each fact/day has a deterministic receipt. A lost acknowledgement cannot increment twice. */
export async function writeAnalyticsDay(generation: string, day: string, receipt: string, delta: AnalyticsDay) {
  const ref = adminDb.ref(`${analyticsRoot(generation)}/daily/${day}`);
  await transactionWithRetry(ref, (current: AnalyticsDay | null) => {
    const c = current || emptyAnalyticsDay();
    c.receipts ||= {};
    if (c.receipts[receipt]) return c;
    c.metric ||= emptyAnalyticsMetric(); c.metric.active ||= {}; c.skills ||= {};
    addMetric(c.metric, delta.metric);
    for (const [id, values] of Object.entries(delta.skills)) {
      c.skills[id] ||= emptyAnalyticsMetric(); c.skills[id].active ||= {};
      addMetric(c.skills[id], values);
    }
    for (const key of ["registrations", "unknownSkills", "unknownAnswers", "unclassifiedAnswers",
      "incompleteParticipants"] as const) c[key] = (c[key] || 0) + delta[key];
    c.receipts[receipt] = true;
    if (Buffer.byteLength(JSON.stringify(c), "utf8") > ANALYTICS_LIMITS.bucketBytes) {
      throw new HttpsError("resource-exhausted", "Analytics day exceeds 1 MiB.");
    }
    return c;
  });
}

export async function projectAnalyticsAccount(generation: string, uid: string, createdAt: number) {
  if (!createdAt) return;
  const delta = emptyAnalyticsDay(); delta.registrations = 1;
  await writeAnalyticsDay(generation, analyticsDay(createdAt), analyticsKey("account", uid), delta);
  const event = {id: `act_${analyticsKey("user", uid, uid)}`, userId: uid, userName: "", text: "Account registered",
    type: "user", at: createdAt, categoryId: "mixed", answered: 0, correct: 0, completed: false,
    sourceId: uid, outcome: "registered"};
  await adminDb.ref(`${analyticsRoot(generation)}/events/all/${event.id}`).set(event);
}

export async function projectAnalyticsFact(generation: string, fact: AnalyticsFact) {
  const days = new Map<string, AnalyticsDay>();
  const day = (date: string) => {
    if (!days.has(date)) days.set(date, emptyAnalyticsDay());
    return days.get(date)!;
  };
  const metrics = (d: AnalyticsDay) => [d.metric, ...fact.skills.map((id) =>
    d.skills[id] ||= emptyAnalyticsMetric())];
  if (fact.startedAt) {
    const d = day(analyticsDay(fact.startedAt));
    for (const m of metrics(d)) {
      m.started++; if (fact.completed) m.completed++;
    }
  }
  if (fact.endedAt) {
    const d = day(analyticsDay(fact.endedAt));
    for (const m of metrics(d)) {
      if (fact.completed) m[fact.type === "battle" ? "battles" : "lessons"]++;
    }
    if (fact.unknownAnswers) d.unknownAnswers++;
    for (const p of Object.values(fact.players)) {
      if (!fact.unknownAnswers) {
        d.metric.answered += p.answered; d.metric.correct += p.correct;
      }
      const mapped = Object.values(p.skills).reduce((n, s) => n + s.answered, 0);
      d.unclassifiedAnswers += Math.max(0, p.answered - mapped);
      for (const [skill, counts] of Object.entries(p.skills)) {
        const m = (d.skills[skill] ||= emptyAnalyticsMetric());
        m.answered += counts.answered; m.correct += counts.correct;
      }
    }
  }
  for (const [uid, p] of Object.entries(fact.players)) {
    for (const at of p.days) for (const m of metrics(day(at))) m.active[uid] = true;
    if (fact.unknownAnswers || fact.incompleteParticipants) continue;
    const at = fact.endedAt || fact.startedAt;
    if (!at) continue;
    const type = fact.type === "battle" ? "battle" : "lesson";
    const text = `${fact.type === "battle" ? "Battle" : "Learning session"} ${fact.endedAt ?
      fact.completed ? "completed" : "abandoned" : "started"}`;
    const event = {id: `act_${analyticsKey(type, uid, fact.sourceId)}`, userId: uid, userName: "", text, type, at,
      categoryId: fact.skills.length === 1 ? fact.skills[0] : "mixed", answered: fact.endedAt ? p.answered : 0,
      correct: fact.endedAt ? p.correct : 0, completed: fact.completed, sourceId: fact.sourceId,
      ...(fact.endedAt ? {outcome: fact.completed ? "completed" : "abandoned"} : {})};
    const updates: Record<string, unknown> = {};
    for (const key of ["all", ...fact.skills]) updates[`events/${key}/${event.id}`] = event;
    await adminDb.ref(analyticsRoot(generation)).update(updates);
  }
  for (const [date, d] of days) {
    if (fact.unknownSkills) d.unknownSkills = 1;
    if (fact.incompleteParticipants || fact.unknownBattleCompletion) d.incompleteParticipants = 1;
    await writeAnalyticsDay(generation, date, fact.id, d);
  }
}

export const analyticsSkillNames: Record<string, string> = Object.fromEntries(
  analyticsSkills.map((id) => [id, id[0].toUpperCase() + id.slice(1)]),
);
