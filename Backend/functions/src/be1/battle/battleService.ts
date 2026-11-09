import {HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../../config/firebaseAdmin";
import {transactionWithRetry} from "../databaseTransaction";
import {WireAttempt, WireResult} from "../practice/attemptHelper";
import {
  applyBattleAction,
  BattleAction,
  battleDueAt,
  resolveUnavailablePlayers,
} from "./battleState";
import {BattleMatch, RECONNECT_MS} from "./battleTypes";
import {enqueueBattleWork} from "./battleWork";
import {settleBattle} from "./battleSettlement";
import {visibleOpponentName} from "../auth/userPrivacy";
import {battleNow, syncBattleClock} from "./battleClock";

const unavailablePlayers = async (match: BattleMatch) => {
  const unavailable: string[] = [];
  for (const uid of Object.keys(match.players)) {
    const access = (await adminDb.ref(`accountAccess/${uid}`).get()).val();
    let invalid = access?.status !== "active";
    try {
      invalid ||= (await adminAuth.getUser(uid)).disabled;
    } catch (error) {
      if ((error as {code?: string}).code !== "auth/user-not-found") {
        throw error;
      }
      invalid = true;
    }
    if (invalid) unavailable.push(uid);
  }
  return unavailable;
};

/**
 * Read a sanitized member view; trusted keys and opponent answers stay private.
 * @param {string} uid Authenticated member.
 * @param {BattleMatch} match Committed match.
 * @return {Promise<object>} Callable response.
 */
export async function battleResponse(
  uid: string,
  match: BattleMatch,
): Promise<{
  serverNow: number;
  attempt: WireAttempt;
}> {
  if (!match.players[uid]) {
    throw new HttpsError("not-found", "Battle not found.");
  }
  let result: WireResult | null = null;
  if (match.status === "completed") {
    if (match.settlementVersion !== 1) await settleBattle(match.id);
    result = (
      await adminDb.ref(`battleReviews/${match.id}/${uid}`).get()
    ).val();
    if (!result) throw new HttpsError("internal", "Result not saved.");
    // RTDB omits null object properties; restore the transport contract.
    result = {
      ...result,
      reviews: result.reviews.map((review) => ({
        ...review,
        pickedId: review.pickedId ?? null,
      })),
    };
  }
  const player = match.players[uid];
  const opponent = Object.keys(match.players).find((id) => id !== uid)!;
  const opponentName = await visibleOpponentName(
    match.id, uid, match.players[opponent].name,
  );
  if (result) result = {...result, opponentName};
  const waiting =
    match.status === "ready" ||
    !!match.leaveDeadlineAt ||
    !!player.answers?.[match.currentIndex];
  const receipts = Object.entries(player.answers || {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, answer]) => ({
      questionId: answer.questionId,
      optionId: answer.selectedOptionId ?? null,
      correct: result ? answer.isCorrect : null,
    }));
  return {
    serverNow: battleNow(),
    attempt: {
      id: match.id,
      mode: "BATTLE",
      topicId: "",
      questions: match.questions,
      index: match.currentIndex,
      deadlineAt: match.deadlineAt,
      receipts,
      status: result ? "completed" : waiting ? "waiting" : "active",
      opponentName,
      result,
      reconnectDeadlineAt:
        result || match.leaveDeadlineAt ?
          null :
          player.lastSeenAt + RECONNECT_MS,
      selectedOptionId:
        player.selections?.[match.currentIndex]?.optionId || null,
    },
  };
}

/**
 * Own answers, heartbeats, timeouts and decisions in one transaction.
 * @param {string} matchId Match identifier.
 * @param {object} member Member action; absent for background work.
 * @return {Promise<object>} Committed state and optional member response.
 */
export async function transactBattle(
  matchId: string,
  member?: {uid: string; sessionId: string; action: BattleAction},
): Promise<{match: BattleMatch; accepted: boolean}> {
  await syncBattleClock();
  const ref = adminDb.ref(`battleRooms/${matchId}`);
  const loaded = (await ref.get()).val() as BattleMatch | null;
  if (!loaded || (member && !loaded.players[member.uid])) {
    throw new HttpsError("not-found", "Battle not found.");
  }
  if (
    member &&
    loaded.status !== "completed" &&
    loaded.players[member.uid].clientSessionId !== member.sessionId
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Battle belongs to another session.",
    );
  }
  if (loaded.status === "completed" && loaded.settlementVersion === 1) {
    await settleBattle(matchId);
    return {match: loaded, accepted: false};
  }
  if (member && ["select", "submit"].includes(member.action.type)) {
    const assigned = loaded.questions.find(
      (q) => q.id === member.action.questionId,
    );
    if (!assigned) {
      throw new HttpsError("failed-precondition", "Question not assigned.");
    }
    const optionId = member.action.optionId;
    if (
      optionId != null &&
      !assigned.options.some((o) => o.id === optionId)
    ) {
      throw new HttpsError("invalid-argument", "Invalid option.");
    }
  }
  await enqueueBattleWork(matchId, battleDueAt(loaded, battleNow()));
  const unavailable =
    loaded.status === "completed" ? [] : await unavailablePlayers(loaded);
  const reduce = (stored: BattleMatch) => {
    const next = structuredClone(stored);
    const now = battleNow();
    resolveUnavailablePlayers(next, unavailable, now);
    if (member) {
      applyBattleAction(
        next,
        member.uid,
        member.sessionId,
        member.action,
        now,
      );
    }
    return next;
  };
  const tx = await transactionWithRetry(ref,
    (match: BattleMatch | null) => {
      if (!match) return match;
      // A callback can run again asynchronously after a cache miss. Abort
      // invalid actions, then raise their error outside the SDK callback.
      try {
        return reduce(match);
      } catch {
        return;
      }
    },
  );
  const match = tx.snapshot.val() as BattleMatch | null;
  if (!match) throw new HttpsError("not-found", "Battle not found.");
  if (!tx.committed) {
    reduce(match);
    throw new HttpsError("failed-precondition", "Battle changed; retry.");
  }
  if (match.status === "completed") {
    await settleBattle(matchId);
    match.settlementVersion = 1;
  } else await enqueueBattleWork(matchId, battleDueAt(match, battleNow()));
  const ordinal = member?.action.questionId ?
    match.questions.findIndex((q) => q.id === member.action.questionId) :
    -1;
  const selection = member && match.players[member.uid].selections?.[ordinal];
  return {
    match,
    accepted:
      !!member &&
      member.action.type === "select" &&
      selection?.requestId === member.action.requestId,
  };
}

/**
 * Execute one authenticated member action and return its public view.
 * @param {string} uid Member.
 * @param {string} matchId Match.
 * @param {string} sessionId Installation.
 * @param {BattleAction} action Operation.
 * @return {Promise<object>} Callable response.
 */
export async function memberBattleResponse(
  uid: string,
  matchId: string,
  sessionId: string,
  action: BattleAction,
): Promise<{serverNow: number; attempt: WireAttempt}> {
  const {match} = await transactBattle(matchId, {uid, sessionId, action});
  return battleResponse(uid, match);
}
