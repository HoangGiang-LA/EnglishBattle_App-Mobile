import {createHash} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {normalizeMode} from "../be1/practice/attemptHelper";
import {canonicalJson} from "./operations";

export const analyticsSkills = ["vocabulary", "grammar", "listening", "reading"];
export type Raw = Record<string, unknown>;
export const analyticsRecord = (v: unknown): Raw => v && typeof v === "object" ? v as Raw : {};
export const analyticsTime = (v: unknown): number =>
  Number.isSafeInteger(v) && Number(v) > 0 ? Number(v) : 0;
export const analyticsId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const analyticsKey = (...parts: string[]) => createHash("sha256").update(canonicalJson(parts)).digest("hex");
export const analyticsDay = (at: number) => new Date(at + 7 * 3600000).toISOString().slice(0, 10);
export const invalidAnalytics = (): never => {
  throw new HttpsError("failed-precondition", "Analytics source needs review.", {reason: "invalid-analytics-source"});
};
const count = (v: unknown): number => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : invalidAnalytics();
export interface AnswerCounts {answered: number; correct: number}
export interface AnalyticsPlayer extends AnswerCounts {
  skills: Record<string, AnswerCounts>; days: string[]; outcome?: string;
}
export interface AnalyticsFact {
  id: string; sourceId: string; type: "learning" | "battle"; startedAt: number; endedAt: number;
  completed: boolean; skills: string[]; players: Record<string, AnalyticsPlayer>;
  unknownSkills: boolean; unknownAnswers: boolean; incompleteParticipants: boolean;
  startNotApplicable?: boolean;
  unknownBattleCompletion?: boolean;
}
export function hydrateAnalyticsFact(value: unknown): AnalyticsFact {
  const v = value as AnalyticsFact;
  return {...v, skills: Object.values(v.skills || {}), players: Object.fromEntries(
    Object.entries(v.players || {}).map(([uid, p]) =>
      [uid, {...p, skills: p.skills || {}, days: Object.values(p.days || {})}]),
  )};
}
const questionSkills = (questions: Raw, total: number) => {
  const values = Object.values(questions).map((q) => analyticsRecord(q).categoryId);
  return {ids: [...new Set(values.filter((s) => analyticsSkills.includes(String(s))).map(String))],
    unknown: values.length !== total || values.some((s) => !analyticsSkills.includes(String(s)))};
};
function player(
  answers: Raw, questions: Raw, answered: number, correct: number, times: number[], asOf: number,
): AnalyticsPlayer {
  if (correct > answered || answered > 20) return invalidAnalytics();
  const skills: Record<string, AnswerCounts> = {};
  for (const [index, raw] of Object.entries(answers)) {
    const a = analyticsRecord(raw);
    const skill = String(analyticsRecord(questions[index]).categoryId || "");
    if (typeof a.isCorrect !== "boolean") return invalidAnalytics();
    const at = analyticsTime(a.receivedAt);
    if (at) times.push(at);
    if (!analyticsSkills.includes(skill)) continue;
    const counts = (skills[skill] ||= {answered: 0, correct: 0});
    counts.answered++; if (a.isCorrect) counts.correct++;
  }
  const mapped = Object.values(skills).reduce((n, s) => n + s.answered, 0);
  const mappedCorrect = Object.values(skills).reduce((n, s) => n + s.correct, 0);
  if (mapped > answered || mappedCorrect > correct) return invalidAnalytics();
  return {answered, correct, skills,
    days: [...new Set(times.filter((at) => at > 0 && at <= asOf).map(analyticsDay))].sort()};
}

/** Canonical start/abandon/active states are retained; only terminal answers enter accuracy. */
export function learningFact(
  uid: string, id: string, value: unknown, questionsValue: unknown, legacyAnswers: unknown,
  studyValue: unknown, asOf: number,
): AnalyticsFact | null {
  if (!analyticsId(uid) || !analyticsId(id)) return invalidAnalytics();
  const a = analyticsRecord(value); const study = analyticsRecord(studyValue);
  const entry = analyticsRecord(study.entry);
  const mode = normalizeMode(a.mode || entry.mode);
  if (!["PRACTICE", "TEST", "DAILY"].includes(mode)) return invalidAnalytics();
  const status = String(a.status || entry.outcome || "");
  if (!["active", "waiting", "completed", "abandoned", "expired"].includes(status)) return invalidAnalytics();
  const start = analyticsTime(a.startedAt) || analyticsTime(a.createdAt);
  if (start > asOf) return null;
  const terminal = ["completed", "abandoned", "expired"].includes(status);
  const finish = terminal ? analyticsTime(a.finishedAt) || analyticsTime(entry.completedAt) : 0;
  if (terminal && (!finish || start && finish < start)) return invalidAnalytics();
  const end = finish <= asOf ? finish : 0;
  const total = count(a.questionCount ?? entry.total);
  if (!total || total > 20) return invalidAnalytics();
  const questions = analyticsRecord(questionsValue);
  const answers = analyticsRecord(a.answers || legacyAnswers);
  const answered = end ? count(a.answeredCount ?? (Object.keys(answers).length ? Object.keys(answers).length :
    study.answered ?? (status === "completed" ? total : 0))) : Object.keys(answers).length;
  const correct = end ? count(a.correctCount ?? entry.correct ??
    Object.values(answers).filter((v) => analyticsRecord(v).isCorrect === true).length) :
    Object.values(answers).filter((v) => analyticsRecord(v).isCorrect === true).length;
  const unknownAnswers = Boolean(end && (
    (a.answeredCount === undefined && study.answered === undefined && !Object.keys(answers).length &&
      status !== "completed") ||
    (a.correctCount === undefined && entry.correct === undefined && Object.keys(answers).length !== answered)));
  if (answered > total || correct > total) return invalidAnalytics();
  const p = player(unknownAnswers ? {} : answers, questions, unknownAnswers ? 0 : answered,
    unknownAnswers ? 0 : correct, [start, end], asOf);
  const skill = questionSkills(questions, total);
  // Legacy summaries may have reliable answer allocation even after question snapshots were removed.
  if (!unknownAnswers && !Object.keys(answers).length && end && study.skills) {
    for (const [id, raw] of Object.entries(analyticsRecord(study.skills))) {
      if (!analyticsSkills.includes(id)) continue;
      const v = analyticsRecord(raw); const s = {answered: count(v.answered), correct: count(v.correct)};
      if (s.correct > s.answered) return invalidAnalytics();
      p.skills[id] = s;
    }
  }
  const mapped = Object.values(p.skills).reduce((n, s) => n + s.answered, 0);
  const mappedCorrect = Object.values(p.skills).reduce((n, s) => n + s.correct, 0);
  if (mapped > answered || mappedCorrect > correct) return invalidAnalytics();
  return {id: analyticsKey("learning", uid, id), sourceId: id, type: "learning", startedAt: start, endedAt: end,
    completed: Boolean(end && status === "completed"), players: {[uid]: p}, skills: skill.ids,
    unknownSkills: skill.unknown || mapped !== answered || mappedCorrect !== correct,
    unknownAnswers, incompleteParticipants: false};
}

export function battleFact(id: string, value: unknown, resultValue: unknown, asOf: number): AnalyticsFact | null {
  const room = analyticsRecord(value); const result = analyticsRecord(resultValue);
  const finish = analyticsRecord(room.finish);
  const players = analyticsRecord(room.players); const uids = Object.keys(players);
  if (!analyticsId(id) || room.kind !== "quick" || uids.length !== 2 || !uids.every(analyticsId) ||
      !["ready", "active", "completed"].includes(String(room.status))) return invalidAnalytics();
  const events = Object.values(analyticsRecord(room.events)).map(analyticsRecord);
  const start = analyticsTime(analyticsRecord(analyticsRecord(room.questionTimings)["0"]).openedAt) ||
    analyticsTime(events.find((e) => e.type === "started")?.at);
  if (start > asOf || analyticsTime(room.createdAt) > asOf) return null;
  const terminal = room.status === "completed";
  const finishAt = terminal ? analyticsTime(finish.at) || analyticsTime(result.finishedAt) : 0;
  if (terminal && (!finishAt || start && finishAt < start)) return invalidAnalytics();
  const end = finishAt <= asOf ? finishAt : 0;
  const questions = analyticsRecord(room.questions); const total = Object.keys(questions).length;
  if (!total || total > 10) return invalidAnalytics();
  const members: Record<string, AnalyticsPlayer> = {};
  let unknownAnswers = false;
  const reason = String(finish.reason || result.endReason || "");
  for (const uid of uids) {
    const raw = analyticsRecord(players[uid]); const answers = analyticsRecord(raw.answers);
    const finalCorrect = analyticsRecord(finish.correct)[uid] ?? analyticsRecord(result.correctCounts)[uid];
    const finalAnswered = analyticsRecord(finish.answered)[uid];
    const answered = end ? count(finalAnswered ?? Object.keys(answers).length) : Object.keys(answers).length;
    const correct = end ? count(finalCorrect ??
      Object.values(answers).filter((v) => analyticsRecord(v).isCorrect === true).length) :
      Object.values(answers).filter((v) => analyticsRecord(v).isCorrect === true).length;
    const missingAnswers = Boolean(end && (
      (finalAnswered === undefined && Object.keys(answers).length === 0) ||
      (finalCorrect === undefined && Object.keys(answers).length !== answered)));
    unknownAnswers ||= missingAnswers;
    const times = [start, analyticsTime(raw.joinedAt)];
    if (end && (start || raw.joinedAt || Object.keys(answers).length || reason !== "ready_timeout")) times.push(end);
    if (answered > total || correct > total) return invalidAnalytics();
    const p = missingAnswers ? player({}, {}, 0, 0, times, asOf) :
      player(answers, questions, answered, correct, times, asOf);
    members[uid] = p;
  }
  const skill = questionSkills(questions, total);
  const unmapped = Object.values(members).some((p) =>
    Object.values(p.skills).reduce((n, s) => n + s.answered, 0) !== p.answered ||
    Object.values(p.skills).reduce((n, s) => n + s.correct, 0) !== p.correct);
  return {id: analyticsKey("battle", id), sourceId: id, type: "battle", startedAt: start, endedAt: end,
    completed: Boolean(end && !["ready_timeout", "both_left", "both_disconnected"].includes(reason)),
    skills: skill.ids, players: members,
    unknownSkills: skill.unknown || unmapped, unknownAnswers, incompleteParticipants: false,
    startNotApplicable: reason === "ready_timeout"};
}

/** Summary-only history keeps its real terminal time; it never invents a cohort start. */
export function historicalBattleFact(id: string, entries: Record<string, unknown>, asOf: number): AnalyticsFact | null {
  const players: Record<string, AnalyticsPlayer> = {};
  let endedAt = 0;
  for (const [uid, raw] of Object.entries(entries)) {
    if (!analyticsId(uid)) return invalidAnalytics();
    const study = analyticsRecord(raw); const e = analyticsRecord(study.entry);
    const at = analyticsTime(e.completedAt);
    if (!at || !["win", "loss", "draw", "left"].includes(String(e.outcome))) return invalidAnalytics();
    if (at > asOf) continue;
    if (endedAt && endedAt !== at) return invalidAnalytics();
    endedAt = at;
    const p = player({}, {}, count(study.answered), count(e.correct), [at], asOf);
    players[uid] = {...p, outcome: String(e.outcome)};
  }
  if (!endedAt) return null;
  return {id: analyticsKey("battle", id), sourceId: id, type: "battle", startedAt: 0, endedAt,
    completed: true, skills: [], players, unknownSkills: true, unknownAnswers: false,
    incompleteParticipants: Object.keys(players).length !== 2, unknownBattleCompletion: true};
}
