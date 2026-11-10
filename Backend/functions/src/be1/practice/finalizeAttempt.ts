import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {transactionWithRetry} from "../databaseTransaction";
import type {BattleAchievement} from "../battle/battleAchievements";
import {unlockPracticeAchievement} from "../community/practiceNotifications";
import {refreshDailyAchievements} from "../community/dailyAchievements";
import {projectLearningActivity} from "../reporting/activity";
import {
  initializeAttemptAnswers, projectAttemptState, StoredAnswer, StoredAttempt,
  updateAttemptCounts,
} from "./attemptState";
import {enqueueLearningWork, learningWorkKey} from "./learningWork";
import {
  buildAttemptResponse,
  dailyEndsAt,
  getDateKey,
  isDailyExpired,
  normalizeMode,
  WireAttempt,
  WireResult,
} from "./attemptHelper";

export interface FinalizeOutput {
  serverNow: number;
  attempt: WireAttempt;
  result: WireResult | Record<string, unknown>;
}

export interface GrantRecord {
  attemptId: string;
  outcome: "completed" | "abandoned" | "win" | "loss" | "draw" | "left";
  coinDelta: number;
  correctCount: number;
  answeredCount: number;
  settledAt: number;
  ratingDelta?: number;
  ratingBefore?: number;
  ratingAfter?: number;
  sourceType?: "battle";
}

export interface UserSettlementModel {
  coinBalance: number;
  grants: Record<string, GrantRecord>;
  progress: Record<string, number>;
  initializedAt?: number;
  rating?: number;
  battleAchievements?: Record<string, BattleAchievement>;
  battleAchievementRevision?: number;
  battleAchievementPublishedRevision?: number;
  battleStats?: {
    wins: number; losses: number; draws: number;
    matchesPlayed: number; winStreak: number; bestWinStreak: number;
  };
}

type FinalOutcome = "completed" | "abandoned";
const finalizers = new Map<string, {
  outcome: FinalOutcome;
  promise: Promise<FinalizeOutput>;
}>();

/**
 * Authoritative user settlement at userSettlements/{uid}.
 * Apply rewards once, with idempotent replays and safe crash recovery.
 * @param {string} uid Owner of the attempt.
 * @param {string} attemptId Attempt to settle.
 * @param {string} outcome Requested terminal outcome.
 * @return {Promise<FinalizeOutput>} Saved, immutable result.
 */
export function finalizeAttemptLogic(
  uid: string,
  attemptId: string,
  outcome: FinalOutcome = "completed",
): Promise<FinalizeOutput> {
  const key = JSON.stringify([uid, attemptId]);
  const previous = finalizers.get(key);
  if (previous?.outcome === outcome) return previous.promise;
  // Local set/update projections can cancel another pending SDK transaction.
  // Share identical requests and serialize conflicting outcomes per attempt;
  // independent processes still arbitrate through the canonical transaction.
  const execute = async () => {
    if (previous) await previous.promise.catch(() => undefined);
    return finalizeAttemptStored(uid, attemptId, outcome);
  };
  const entry = {outcome, promise: execute()};
  finalizers.set(key, entry);
  const clear = () => {
    if (finalizers.get(key) === entry) finalizers.delete(key);
  };
  void entry.promise.then(clear, clear);
  return entry.promise;
}

/**
 * Execute one finalization after earlier requests for this attempt finish.
 * @param {string} uid Owner.
 * @param {string} attemptId Attempt.
 * @param {FinalOutcome} outcome Requested immutable terminal outcome.
 * @return {Promise<FinalizeOutput>} Saved result.
 */
async function finalizeAttemptStored(
  uid: string,
  attemptId: string,
  outcome: "completed" | "abandoned" = "completed",
): Promise<FinalizeOutput> {
  const attemptRef = adminDb.ref(`practiceAttempts/${uid}/${attemptId}`);
  const attemptSnap = await attemptRef.get();

  if (!attemptSnap.exists()) {
    throw new HttpsError("not-found", "Attempt not found or access denied.");
  }

  const attemptData = attemptSnap.val() as Record<string, unknown>;
  const now = Date.now();
  const grantId = `grant_${attemptId}`;
  const modeRaw = normalizeMode(attemptData.mode || "practice");
  // Expiry must be decided inside the attempt transaction. This snapshot can
  // be stale when the final answer commits just before midnight.
  if (
    modeRaw === "DAILY" &&
    attemptData.status !== "completed" &&
    attemptData.status !== "abandoned"
  ) {
    const dateKey = getDateKey(
      Number(attemptData.startedAt || attemptData.createdAt),
    );
    const slotTx = await adminDb
      .ref(`userDailyChallenges/${uid}/${dateKey}`)
      .transaction(
        (slot) =>
          slot || {
            attemptId,
            challengeId: "daily_mixed",
            status: attemptData.status,
            startedAt: attemptData.startedAt,
          },
      );
    if (slotTx.snapshot.val()?.attemptId !== attemptId) outcome = "abandoned";
  }

  // Legacy answers are imported once into the attempt transaction boundary.
  const aSnap = await adminDb.ref(`attemptAnswers/${uid}/${attemptId}`).get();
  const legacyAnswers = (aSnap.val() || {}) as Record<string, StoredAnswer>;
  await enqueueLearningWork(uid, attemptId, now);

  // Atomic final-outcome decision on practiceAttempts
  // Prevents concurrent conflict between completed and abandoned calls
  // Keep speculative transaction values out of parallel result reads.
  const txOutcome = await transactionWithRetry(attemptRef,
    (att: StoredAttempt | null) => {
      if (!att) return att;
      const answers = initializeAttemptAnswers(att, legacyAnswers);
      // Already in a terminal state: keep immutable
      if (att.status === "completed" || att.status === "abandoned") {
        return att;
      }
      const expired = isDailyExpired(att);
      if (outcome === "completed" && !expired) {
        if (att.status !== "waiting") {
          return; // Aborts transaction if not ready
        }
        if (Object.keys(answers).length < att.questionCount) {
          throw new HttpsError("failed-precondition", "Questions unresolved.");
        }
        att.status = "completed";
      } else {
        att.status = "abandoned";
      }
      att.finishedAt = expired ? dailyEndsAt(att) : att.finishedAt || now;
      updateAttemptCounts(att);
      att.updatedAt = now;
      return att;
    });

  if (!txOutcome.committed) {
    throw new HttpsError(
      "failed-precondition",
      "Cannot finalize attempt: attempt is not in a valid state.",
    );
  }

  const committedAttempt = txOutcome.snapshot.val() as StoredAttempt;
  const finalOutcome = committedAttempt.status as "completed" | "abandoned";
  const correctCount = Number(committedAttempt.correctCount) || 0;
  const answeredCount = Number(committedAttempt.answeredCount) || 0;
  const allAnswers = committedAttempt.answers || {};
  await projectAttemptState(uid, attemptId, committedAttempt);

  // Step 2: Read wallet, progress and legacy grants before initialization.
  const [walletSnap, progSnap, rewardGrantsSnap] = await Promise.all([
    adminDb.ref(`wallets/${uid}`).get(),
    adminDb.ref(`learningProgress/${uid}`).get(),
    adminDb.ref(`rewardGrants/${uid}`).get(),
  ]);

  const baselineCoinBalance = (walletSnap.val()?.coinBalance as number) ?? 0;
  const baselineProgress: Record<string, number> = {};
  if (progSnap.exists()) {
    const pData = progSnap.val() as Record<string, unknown>;
    for (const [tId, v] of Object.entries(pData || {})) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as Record<string, unknown>).completedAttempts === "number"
      ) {
        baselineProgress[tId] = (v as Record<string, unknown>)
          .completedAttempts as number;
      }
    }
  }

  // Import legacy rewardGrants only when their status is "completed".
  const baselineGrants: Record<string, GrantRecord> = {};
  if (rewardGrantsSnap.exists()) {
    const rgData = rewardGrantsSnap.val() as Record<string, unknown>;
    for (const [rgId, rgVal] of Object.entries(rgData || {})) {
      if (rgVal && typeof rgVal === "object") {
        const valObj = rgVal as Record<string, unknown>;
        if (valObj.status === "completed") {
          baselineGrants[rgId] = {
            attemptId:
              (valObj.sourceId as string) || rgId.replace(/^grant_/, ""),
            outcome: "completed",
            coinDelta: (valObj.coinDelta as number) || 0,
            correctCount: 0,
            answeredCount: 0,
            settledAt: (valObj.grantedAt as number) || now,
          };
        }
      }
    }
  }

  // Calculate intended coin delta based on atomically decided finalOutcome
  let coinDelta = 0;
  if (finalOutcome === "completed") {
    if (modeRaw === "PRACTICE") coinDelta = 1;
    else if (modeRaw === "TEST") coinDelta = 2;
    else if (modeRaw === "DAILY") coinDelta = 2;
  }

  const topicId = (attemptData.topicId as string) || "";

  // Step 3: Authoritative transaction on userSettlements/{uid}
  // Pure transaction without external variable mutation
  const settlementTx = await adminDb
    .ref(`userSettlements/${uid}`)
    .transaction((current: UserSettlementModel | null) => {
      // Safe initialization from baseline if node does not exist yet
      if (!current) {
        current = {
          coinBalance: baselineCoinBalance,
          grants: {...baselineGrants},
          progress: baselineProgress,
          initializedAt: now,
        };
      } else {
        current.grants = current.grants || {};
        for (const [bgId, bgVal] of Object.entries(baselineGrants)) {
          if (!current.grants[bgId]) {
            current.grants[bgId] = bgVal;
          }
        }
      }

      current.grants = current.grants || {};
      current.progress = current.progress || {};

      // 1. Preserve an existing grant and its terminal outcome on retries.
      if (current.grants[grantId]) {
        return current; // Unchanged return: do not increment again
      }

      // 2. Grant new settlement
      const newGrant: GrantRecord = {
        attemptId,
        outcome: finalOutcome,
        coinDelta,
        correctCount,
        answeredCount,
        settledAt: Number(committedAttempt.finishedAt) || now,
      };

      current.grants[grantId] = newGrant;
      if (coinDelta > 0) {
        current.coinBalance = (current.coinBalance || 0) + coinDelta;
      }

      if (finalOutcome === "completed" && modeRaw === "PRACTICE" && topicId) {
        current.progress[topicId] = (current.progress[topicId] || 0) + 1;
      }

      return current;
    });

  if (!settlementTx.committed) {
    throw new HttpsError(
      "internal",
      "Failed to commit authoritative user settlement.",
    );
  }

  // Derive authoritative output strictly from committed transaction snapshot
  const finalSettlement = settlementTx.snapshot.val() as UserSettlementModel;
  const grant = finalSettlement?.grants?.[grantId];
  if (!grant) {
    throw new HttpsError(
      "internal",
      "Settlement grant missing from committed snapshot.",
    );
  }
  const authoritativeProgress =
    (topicId && finalSettlement?.progress?.[topicId]) || 0;

  // Step 4: Project authoritative settlement into application nodes.
  // 4.1 Sync wallets/{uid} safely using appliedGrants tracking
  const wasPreCreditedInBaseline = Boolean(baselineGrants[grantId]);

  await adminDb.ref(`wallets/${uid}`).transaction((w) => {
    if (!w) {
      return {
        coinBalance: finalSettlement.coinBalance,
        appliedGrants: {
          ...Object.fromEntries(
            Object.keys(finalSettlement.grants).map((k) => [k, true]),
          ),
          [grantId]: true,
        },
        updatedAt: now,
      };
    }
    w.appliedGrants = w.appliedGrants || {};
    for (const bgId of Object.keys(baselineGrants)) {
      w.appliedGrants[bgId] = true;
    }
    if (w.appliedGrants[grantId]) {
      return w; // Already applied to this wallet: replay is no-op
    }
    if (!wasPreCreditedInBaseline && grant.coinDelta > 0) {
      w.coinBalance = (w.coinBalance || 0) + grant.coinDelta;
    }
    w.appliedGrants[grantId] = true;
    w.updatedAt = now;
    return w;
  });

  // 4.2 Sync coinLedger and rewardGrants idempotently using grantId.
  if (grant.coinDelta > 0) {
    await adminDb.ref(`coinLedger/${uid}/${grantId}`).set({
      id: grantId,
      label: `${modeRaw} Completion`,
      delta: grant.coinDelta,
      createdAt: grant.settledAt,
    });

    await adminDb.ref(`rewardGrants/${uid}/${grantId}`).set({
      sourceType: modeRaw.toLowerCase(),
      sourceId: attemptId,
      coinDelta: grant.coinDelta,
      status: "completed",
      grantedAt: grant.settledAt,
    });
  }

  // 4.3 Sync learningProgress (ONLY for completed PRACTICE mode)
  if (grant.outcome === "completed" && modeRaw === "PRACTICE" && topicId) {
    const progressTx = await adminDb
      .ref(`learningProgress/${uid}/${topicId}`)
      .transaction((p) => {
        p ||= {completionTarget: 20, correctCount: 0, answeredCount: 0};
        // Another completion may have projected a newer settlement already.
        // Repair old regressions on replay, even if this grant was applied.
        p.completedAttempts = Math.max(
          Number(p.completedAttempts) || 0, authoritativeProgress,
        );
        p.lastCompletedAt = Math.max(
          Number(p.lastCompletedAt) || 0, grant.settledAt,
        );
        p.appliedGrants ||= {};
        if (!p.appliedGrants[grantId]) {
          p.correctCount = (p.correctCount || 0) + grant.correctCount;
          p.answeredCount = (p.answeredCount || 0) + grant.answeredCount;
          p.appliedGrants[grantId] = true;
        }
        return p;
      });

    // Check achievement unlock for practice 20 (idempotent)
    if (Number(progressTx.snapshot.val()?.completedAttempts) >= 20) {
      const unlockedAt = Date.now();
      await unlockPracticeAchievement(uid, topicId, unlockedAt);
    }
  }

  // Mixed TEST/DAILY attempts must count answers in each question's skill.
  if (grant.outcome === "completed") {
    const questions =
      (await adminDb.ref(`attemptQuestions/${uid}/${attemptId}`).get()).val() ||
      {};
    const skills: Record<string, {answered: number; correct: number}> = {};
    for (const [ordinal, question] of Object.entries(questions)) {
      const categoryId = (question as Record<string, unknown>)
        .categoryId as string;
      const answer = allAnswers[ordinal];
      if (
        !answer ||
        !["vocabulary", "grammar", "listening", "reading"].includes(categoryId)
      ) {
        continue;
      }
      const counts = (skills[categoryId] ||= {answered: 0, correct: 0});
      counts.answered++;
      if (answer.isCorrect) counts.correct++;
    }
    for (const [categoryId, counts] of Object.entries(skills)) {
      await adminDb
        .ref(`userSkillStats/${uid}/${categoryId}`)
        .transaction((s) => {
          if (!s) {
            return {
              answeredCount: counts.answered,
              correctCount: counts.correct,
              completedAttempts: 1,
              appliedGrants: {[grantId]: true},
              updatedAt: now,
            };
          }
          s.appliedGrants = s.appliedGrants || {};
          if (s.appliedGrants[grantId]) return s;
          s.answeredCount = (s.answeredCount || 0) + counts.answered;
          s.correctCount = (s.correctCount || 0) + counts.correct;
          s.completedAttempts = (s.completedAttempts || 0) + 1;
          s.appliedGrants[grantId] = true;
          s.updatedAt = now;
          return s;
        });
    }
  }

  // 4.6 Update practiceAttempts record
  const finishedAt = (committedAttempt.finishedAt as number) || grant.settledAt;
  const updates: Record<string, unknown> = {
    status: grant.outcome,
    finishedAt,
    correctCount: grant.correctCount,
    answeredCount: grant.answeredCount,
    coinsAwarded: grant.coinDelta,
    rewardGrantId: grant.coinDelta > 0 ? grantId : null,
    updatedAt: now,
  };

  await attemptRef.update(updates);

  // Publish the daily terminal status after all settlement projections. If a
  // worker crashes earlier, midnight cleanup can find and replay its slot.
  if (modeRaw === "DAILY") {
    const originalDate = Number(attemptData.startedAt || attemptData.createdAt);
    const dateKey = getDateKey(originalDate);
    await adminDb
      .ref(`userDailyChallenges/${uid}/${dateKey}`)
      .transaction((slot) => {
        if (slot?.attemptId && slot.attemptId !== attemptId) return;
        return {
          ...slot,
          challengeId: slot?.challengeId || "daily_mixed",
          attemptId,
          status: grant.outcome,
          startedAt: originalDate,
          completedQuestionCount: grant.answeredCount,
          completedAt: grant.settledAt,
          ...(grant.coinDelta > 0 ?
            {rewardClaimedAt: grant.settledAt, rewardGrantId: grantId} :
            {}),
        };
      });
    if (grant.outcome === "completed") await refreshDailyAchievements(uid);
  }

  const finalAttemptData = {
    ...committedAttempt,
    ...updates,
  };

  const durationMs = await projectLearningActivity(uid, attemptId,
    finalAttemptData);

  const response = await buildAttemptResponse(uid, attemptId,
    {...finalAttemptData, durationMs: durationMs ?? null});
  // This marker and queue removal are atomic and come after every projection,
  // including reviews. A crash at any earlier step leaves durable retry work.
  await adminDb.ref().update({
    [`practiceAttempts/${uid}/${attemptId}/settlementVersion`]: 1,
    [`practiceAttempts/${uid}/${attemptId}/settlementCompletedAt`]: Date.now(),
    [`learningWork/${learningWorkKey(uid, attemptId)}`]: null,
  });
  return {
    serverNow: response.serverNow,
    attempt: response.attempt,
    result: response.attempt.result || {},
  };
}

/**
 * Resolve expiry and interrupted settlement before exposing results.
 * @param {string} uid Owner of the attempt.
 * @param {string} attemptId Attempt to read.
 * @param {object} attempt Current attempt state.
 * @param {object} questions Immutable question snapshot, if already read.
 */
export async function readAttemptResponse(
  uid: string,
  attemptId: string,
  attempt: Record<string, unknown>,
  questions?: Record<string, Record<string, unknown>>,
): Promise<{serverNow: number; attempt: WireAttempt}> {
  if (
    attempt.status === "completed" ||
    attempt.status === "abandoned" ||
    isDailyExpired(attempt)
  ) {
    const finalized = await finalizeAttemptLogic(
      uid,
      attemptId,
      attempt.status === "abandoned" ? "abandoned" : "completed",
    );
    return {serverNow: finalized.serverNow, attempt: finalized.attempt};
  }
  if (normalizeMode(attempt.mode) === "DAILY") {
    const dateKey = getDateKey(Number(attempt.startedAt || attempt.createdAt));
    await adminDb
      .ref(`userDailyChallenges/${uid}/${dateKey}`)
      .transaction((slot) => {
        slot ||= {
          attemptId,
          startedAt: Number(attempt.startedAt || attempt.createdAt),
        };
        if (
          slot.attemptId !== attemptId ||
          slot.status === "completed" ||
          slot.status === "abandoned"
        ) {
          return;
        }
        if (slot.status === "waiting" && attempt.status === "active") return;
        const completedQuestionCount = Math.max(
          Number(slot.completedQuestionCount) || 0,
          Number(attempt.answeredCount) || 0,
        );
        if (slot.status === attempt.status &&
            slot.completedQuestionCount === completedQuestionCount) return;
        return {
          ...slot,
          status: attempt.status,
          completedQuestionCount,
        };
      });
  }
  return buildAttemptResponse(uid, attemptId, attempt, questions);
}
