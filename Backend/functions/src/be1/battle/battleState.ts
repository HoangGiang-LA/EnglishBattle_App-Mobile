import {HttpsError} from "firebase-functions/v2/https";
import {
  BattleMatch,
  BattleOutcome,
  BATTLE_QUESTION_MS,
  DOUBLE_LEAVE_MS,
  RECONNECT_MS,
} from "./battleTypes";

export type BattleAction = {
  type: "resume" | "heartbeat" | "select" | "submit" | "advance" | "leave";
  questionId?: string;
  optionId?: string | null;
  requestId?: string;
};

const correctCount = (match: BattleMatch, uid: string) =>
  Object.values(match.players[uid].answers || {}).filter((a) => a.isCorrect)
    .length;

const event = (
  match: BattleMatch,
  type: string,
  at: number,
  uid?: string,
) => {
  match.events ||= {};
  const keys = Object.keys(match.events);
  if (keys.length >= 100) delete match.events[keys[0]];
  const id = String(Number(keys[keys.length - 1] || 0) + 1).padStart(5, "0");
  match.events[id] = {type, at, ...(uid ? {uid} : {})};
};

const freeze = (
  match: BattleMatch,
  reason: string,
  outcomes: Record<string, BattleOutcome>,
  at: number,
) => {
  if (match.finish) return;
  const uids = Object.keys(match.players);
  match.status = "completed";
  match.finish = {
    reason,
    outcomes,
    at,
    correct: Object.fromEntries(
      uids.map((uid) => [uid, correctCount(match, uid)]),
    ),
    answered: Object.fromEntries(
      uids.map((uid) => [
        uid,
        Object.keys(match.players[uid].answers || {}).length,
      ]),
    ),
  };
  event(match, reason, at);
};

const forfeit = (
  match: BattleMatch,
  loser: string | null,
  reason: string,
  at: number,
) =>
  freeze(
    match,
    reason,
    Object.fromEntries(
      Object.keys(match.players).map((uid) => [
        uid,
        !loser ?
          "draw" :
          uid !== loser ?
            "win" :
            reason === "leave" ?
              "left" :
              "loss",
      ]),
    ),
    at,
  );

/**
 * Reconcile server deadlines before accepting a new heartbeat or action.
 * @param {BattleMatch} match Canonical match, mutated only in its transaction.
 * @param {number} now Authoritative server time.
 */
export function resolveBattle(match: BattleMatch, now: number): void {
  if (match.status === "completed") return;
  const uids = Object.keys(match.players);
  if (uids.length !== 2) throw new HttpsError("internal", "Invalid players.");
  if (match.leaveDeadlineAt) {
    const left = uids.filter((uid) => match.players[uid].leftAt);
    if (left.length === 2) {
      forfeit(match, null, "both_left", now);
    } else if (now >= match.leaveDeadlineAt) {
      forfeit(match, left[0], "leave", match.leaveDeadlineAt);
    }
    return;
  }
  if (match.status === "ready") {
    if (now >= match.readyDeadlineAt) {
      const present = uids.filter(
        (uid) =>
          match.players[uid].joinedAt &&
          now < match.players[uid].lastSeenAt + RECONNECT_MS,
      );
      const absent =
        present.length === 1 ? uids.find((uid) => uid !== present[0])! : null;
      forfeit(match, absent, "ready_timeout", match.readyDeadlineAt);
    }
    return;
  }
  const expired = uids.filter(
    (uid) => now >= match.players[uid].lastSeenAt + RECONNECT_MS,
  );
  if (expired.length) {
    forfeit(
      match,
      expired.length === 2 ? null : expired[0],
      expired.length === 2 ? "both_disconnected" : "disconnect",
      now,
    );
    return;
  }
  for (let round = 0; round < 10; round++) {
    const index = match.currentIndex;
    const question = match.questions[index];
    if (!question) throw new HttpsError("internal", "Round missing.");
    const expiredRound = now >= match.deadlineAt;
    if (expiredRound) {
      for (const uid of uids) {
        const player = match.players[uid];
        player.answers ||= {};
        if (player.answers[index]) continue;
        const selection = player.selections?.[index];
        const optionId =
          selection && selection.selectedAt < match.deadlineAt ?
            selection.optionId :
            null;
        player.answers[index] = {
          questionId: question.id,
          selectedOptionId: optionId,
          isCorrect: optionId === match.keys[question.id].correctOptionId,
          timedOut: true,
          requestId: `timeout_${index}`,
          receivedAt: match.deadlineAt,
        };
      }
    }
    if (!uids.every((uid) => match.players[uid].answers?.[index])) return;
    const boundary = expiredRound ? match.deadlineAt : now;
    event(match, "round_resolved", boundary);
    if (index === 9) {
      const [a, b] = uids;
      const aScore = correctCount(match, a);
      const bScore = correctCount(match, b);
      freeze(
        match,
        "answers",
        {
          [a]: aScore === bScore ? "draw" : aScore > bScore ? "win" : "loss",
          [b]: aScore === bScore ? "draw" : bScore > aScore ? "win" : "loss",
        },
        boundary,
      );
      return;
    }
    match.currentIndex++;
    match.openedAt = boundary;
    match.deadlineAt = boundary + BATTLE_QUESTION_MS;
    match.questionTimings ||= {};
    match.questionTimings[match.currentIndex] = {
      openedAt: match.openedAt, deadlineAt: match.deadlineAt,
    };
    if (!expiredRound) return;
  }
}

/**
 * Apply a member's authenticated action using server timing and frozen answers.
 * @param {BattleMatch} match Canonical match.
 * @param {string} uid Authenticated member.
 * @param {string} sessionId Installation session owning this participant.
 * @param {BattleAction} action Requested action.
 * @param {number} now Server time.
 * @return {boolean} Whether an unconfirmed selection was accepted.
 */
export function applyBattleAction(
  match: BattleMatch,
  uid: string,
  sessionId: string,
  action: BattleAction,
  now: number,
): boolean {
  const player = match.players[uid];
  if (!player) throw new HttpsError("not-found", "Battle not found.");
  if (match.status === "completed") return false;
  if (player.clientSessionId !== sessionId) {
    throw new HttpsError(
      "failed-precondition",
      "Battle belongs to another session.",
    );
  }
  resolveBattle(match, now);
  if (match.finish) return false;
  if (action.type === "leave") {
    player.leftAt ||= now;
    match.leaveDeadlineAt ||= now + DOUBLE_LEAVE_MS;
    event(match, "left", now, uid);
    resolveBattle(match, now);
    return false;
  }
  if (match.leaveDeadlineAt) return false;
  player.lastSeenAt = Math.max(player.lastSeenAt, now);
  if (action.type === "resume" && !player.joinedAt) {
    player.joinedAt = now;
    event(match, "joined", now, uid);
  }
  if (
    match.status === "ready" &&
    Object.values(match.players).every((p) => p.joinedAt)
  ) {
    match.status = "active";
    match.openedAt = now;
    match.deadlineAt = now + BATTLE_QUESTION_MS;
    match.questionTimings = {0: {openedAt: now,
      deadlineAt: match.deadlineAt}};
    event(match, "started", now);
  }
  if (
    match.status !== "active" ||
    !player.joinedAt ||
    !["select", "submit"].includes(action.type)
  ) {
    return false;
  }
  const index = match.currentIndex;
  const question = match.questions[index];
  if (question.id !== action.questionId) return false;
  const optionId = action.optionId ?? null;
  if (optionId !== null && !question.options.some((o) => o.id === optionId)) {
    throw new HttpsError("invalid-argument", "Invalid option.");
  }
  const previous = player.answers?.[index];
  if (previous) {
    if (
      previous.requestId === action.requestId &&
      previous.selectedOptionId !== optionId
    ) {
      throw new HttpsError("invalid-argument", "requestId payload changed.");
    }
    return false;
  }
  if (action.type === "select") {
    if (optionId === null) {
      throw new HttpsError("invalid-argument", "Choose an option.");
    }
    player.selections ||= {};
    const saved = player.selections[index];
    if (
      saved?.requestId === action.requestId &&
      saved.optionId !== optionId
    ) {
      throw new HttpsError("invalid-argument", "requestId payload changed.");
    }
    player.selections[index] = {
      optionId,
      selectedAt: now,
      requestId: action.requestId!,
    };
    return true;
  }
  if (optionId === null) {
    throw new HttpsError("failed-precondition", "Question has not expired.");
  }
  player.answers ||= {};
  player.answers[index] = {
    questionId: question.id,
    selectedOptionId: optionId,
    isCorrect: optionId === match.keys[question.id].correctOptionId,
    timedOut: false,
    requestId: action.requestId!,
    receivedAt: now,
  };
  event(match, "answered", now, uid);
  resolveBattle(match, now);
  return false;
}

/**
 * Apply account unavailability while preserving frozen results.
 * @param {BattleMatch} match Canonical match.
 * @param {string[]} unavailable Members with banned/deleted/disabled accounts.
 * @param {number} now Server time.
 */
export function resolveUnavailablePlayers(
  match: BattleMatch,
  unavailable: string[],
  now: number,
): void {
  resolveBattle(match, now);
  if (match.status === "completed" || !unavailable.length) return;
  forfeit(
    match,
    unavailable.length === 2 ? null : unavailable[0],
    "account_unavailable",
    now,
  );
}

/**
 * Earliest server deadline needing background reconciliation.
 * @param {BattleMatch} match Canonical match.
 * @param {number} now Authoritative server time.
 * @return {number} Next work time.
 */
export function battleDueAt(match: BattleMatch, now: number): number {
  if (match.status === "completed") return now;
  if (match.leaveDeadlineAt) return match.leaveDeadlineAt;
  return Math.min(
    match.status === "ready" ? match.readyDeadlineAt : match.deadlineAt,
    ...Object.values(match.players).map((p) => p.lastSeenAt + RECONNECT_MS),
  );
}
