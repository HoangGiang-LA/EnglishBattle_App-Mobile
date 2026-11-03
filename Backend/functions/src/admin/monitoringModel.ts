import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {RECONNECT_MS, BATTLE_QUESTION_MS} from "../be1/battle/battleTypes";
import {Data} from "./contracts";

export const monitoringId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const monitoringCount = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const record = (value: unknown): Data => value && typeof value === "object" ? value as Data : {};
const skills = ["vocabulary", "grammar", "listening", "reading"];
export const monitoringSkill = (values: unknown[]): string => {
  const unique = [...new Set(values.filter((v) => skills.includes(String(v))))];
  return unique.length === 1 ? String(unique[0]) : "mixed";
};
const invalidBattle = (): never => {
  throw new HttpsError("failed-precondition", "Stored battle needs review.", {reason: "invalid-stored-battle"});
};

/** Identity is resolved on every read, including frozen pages after soft deletion. */
export async function monitoringParticipant(uid: string) {
  const [access, profile, identity] = await Promise.all([
    adminDb.ref(`accountAccess/${uid}`).get(), adminDb.ref(`users/${uid}`).get(),
    adminDb.ref(`adminUserState/${uid}`).get(),
  ]);
  const deleted = !access.exists() || access.val().status === "deleted" || identity.val()?.deleted;
  return {id: uid, code: String(profile.val()?.displayCode || `EB-${uid}`).slice(0, 150),
    name: deleted ? "Tài khoản đã xóa" :
      String(identity.val()?.name || profile.val()?.displayName || "Người chơi").slice(0, 100),
    status: deleted ? "deleted" : access.val()?.status === "active" ? "active" : "banned"};
}

// No raw event message, answer, key, selection or clientSessionId crosses this allowlist.
const eventMessages: Record<string, string> = {
  joined: "Player joined the match.", started: "The match started.",
  answered: "Player submitted an answer.", round_resolved: "The round was resolved.",
  left: "Player left the match.", answers: "All rounds were completed.",
  both_left: "Both players left.", ready_timeout: "The ready deadline elapsed.",
  both_disconnected: "Both players disconnected.", disconnect: "The reconnect deadline elapsed.",
  leave: "The match ended after a player left.",
  account_unavailable: "The match ended because an account became unavailable.",
};

/** Pure projection: observing a match never reconciles a deadline or settles rewards. */
export function monitoringBattle(id: string, value: unknown, resultValue: unknown, logValue?: unknown) {
  const room = record(value); const result = record(resultValue); const finish = record(room.finish);
  const players = record(room.players); const uids = Object.keys(players).sort();
  if (!monitoringId(id) || room.kind !== "quick" || uids.length !== 2 ||
      !uids.every(monitoringId) || !["ready", "active", "completed"].includes(String(room.status)) ||
      !monitoringCount(room.createdAt)) return invalidBattle();
  const terminal = room.status === "completed";
  const events = {...(terminal ? record(logValue) : {}), ...record(room.events)};
  const logs = Object.entries(events).flatMap(([key, raw]) => {
    const e = record(raw); const type = String(e.type);
    return monitoringId(key) && Object.prototype.hasOwnProperty.call(eventMessages, type) && monitoringCount(e.at) ?
      [{id: key, at: monitoringCount(e.at), type, message: eventMessages[type],
        ...(uids.includes(String(e.uid)) ? {actorId: String(e.uid)} : {})}] : [];
  }).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  if (logs.length > 1000) return invalidBattle();
  const questions = Object.values(record(room.questions)).map(record);
  const questionCount = questions.length;
  if (!questionCount || questionCount > 10) return invalidBattle();
  const start = monitoringCount(record(record(room.questionTimings)["0"]).openedAt) ||
    logs.find((e) => e.type === "started")?.at || 0;
  const endedAt = terminal ? monitoringCount(finish.at) || monitoringCount(result.finishedAt) : 0;
  if (terminal && !endedAt) return invalidBattle();
  const reason = String(finish.reason || result.endReason || "unknown");
  const endReason = terminal ? Object.prototype.hasOwnProperty.call(eventMessages, reason) ? reason : "unknown" : "";
  const finalScores = Object.keys(record(finish.correct)).length ?
    record(finish.correct) : record(result.correctCounts);
  const scores = uids.map((uid) => {
    if (terminal) {
      if (!Number.isSafeInteger(finalScores[uid]) || Number(finalScores[uid]) < 0 ||
          Number(finalScores[uid]) > questionCount) return invalidBattle();
      return monitoringCount(finalScores[uid]);
    }
    // A single submitted answer does not reveal the current round's correctness.
    let score = 0;
    for (let index = 0; index < Math.min(monitoringCount(room.currentIndex), questionCount); index++) {
      if (!uids.every((u) => record(record(players[u]).answers)[String(index)])) continue;
      if (record(record(record(players[uid]).answers)[String(index)]).isCorrect === true) score++;
    }
    return score;
  });
  const reconnecting = room.status === "active" && Object.values(players).some((p) =>
    Date.now() - monitoringCount(record(p).lastSeenAt) >= RECONNECT_MS);
  const outcome = (uid: string) => {
    const value = record(finish.outcomes)[uid] || record(record(result.players)[uid]).outcome;
    return terminal && ["win", "loss", "draw", "left"].includes(String(value)) ? String(value) : null;
  };
  return {id, code: `B-${id}`, player1: uids[0], player2: uids[1], player1Name: "", player2Name: "",
    score1: scores[0], score2: scores[1],
    outcome1: outcome(uids[0]), outcome2: outcome(uids[1]),
    status: terminal ? ["both_left", "both_disconnected", "ready_timeout"].includes(endReason) ?
      "abandoned" : "completed" : "ongoing",
    mode: "quick", categoryId: monitoringSkill(questions.map((q) => q.categoryId)),
    startedAt: start || monitoringCount(room.createdAt), createdAt: monitoringCount(room.createdAt),
    playStartedAt: start || null, endedAt: endedAt || null, endReason, logs,
    phase: terminal ? "completed" : room.status === "ready" ? "ready" : reconnecting ? "reconnecting" : "playing",
    questionCount, roundTimeLimitSeconds: BATTLE_QUESTION_MS / 1000,
    settlementStatus: !terminal ? "not_due" : result.status === "settled" && room.settlementVersion === 1 ?
      "settled" : "pending"};
}

export async function readMonitoringBattle(id: string) {
  const [room, result, logs] = await Promise.all([
    adminDb.ref(`battleRooms/${id}`).get(), adminDb.ref(`battleResults/${id}`).get(),
    adminDb.ref(`battleLogs/${id}`).get(),
  ]);
  if (!room.exists()) throw new HttpsError("not-found", "Battle not found.");
  return monitoringBattle(id, room.val(), result.val(), logs.val());
}

export async function getMonitoringBattle(id: string) {
  const battle = await readMonitoringBattle(id);
  const [player1, player2] = await Promise.all([
    monitoringParticipant(battle.player1), monitoringParticipant(battle.player2),
  ]);
  return {battle: {...battle, player1Name: player1.name, player2Name: player2.name}, player1, player2};
}
