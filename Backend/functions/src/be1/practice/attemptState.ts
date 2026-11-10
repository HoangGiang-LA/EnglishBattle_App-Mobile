import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {transactionWithRetry} from "../databaseTransaction";
import {dailyEndsAt, isDailyExpired, normalizeMode} from "./attemptHelper";
import {enqueueLearningWork} from "./learningWork";

export interface StoredAnswer {
  questionId: string;
  selectedOptionId: string | null;
  isCorrect: boolean;
  timedOut: boolean;
  ordinal: number;
  requestId: string;
  receivedAt: number;
}
interface Timing {
  openedAt: number;
  deadlineAt: number;
}
interface Selection {
  optionId: string;
  requestId: string;
  selectedAt: number;
}
interface StoredQuestion extends Record<string, unknown> {
  questionId: string;
  version: string;
  options: Array<{id: string; text: string}>;
  openedAt?: number;
  deadlineAt?: number;
}
export interface StoredAttempt extends Record<string, unknown> {
  status: string;
  mode: string;
  currentIndex: number;
  questionCount: number;
  deadlineAt: number;
  answers?: Record<string, StoredAnswer>;
  answerStateVersion?: number;
  questionTimings?: Record<string, Timing>;
  advanceOperations?: Record<string, Record<string, unknown>>;
  selections?: Record<string, Selection>;
}

/**
 * Load snapshots for migrating legacy attempts.
 * @param {string} uid Owner.
 * @param {string} attemptId Attempt.
 */
async function context(uid: string, attemptId: string) {
  const [attempt, questions, answers] = await Promise.all([
    adminDb.ref(`practiceAttempts/${uid}/${attemptId}`).get(),
    adminDb.ref(`attemptQuestions/${uid}/${attemptId}`).get(),
    adminDb.ref(`attemptAnswers/${uid}/${attemptId}`).get(),
  ]);
  if (!attempt.exists()) {
    throw new HttpsError("not-found", "Attempt not found.");
  }
  return {
    attempt: attempt.val() as StoredAttempt,
    questions: (questions.val() || {}) as Record<string, StoredQuestion>,
    answers: (answers.val() || {}) as Record<string, StoredAnswer>,
  };
}

/**
 * Answers and terminal decisions share one transaction boundary.
 * @param {StoredAttempt} attempt Current state.
 * @param {object} legacy Legacy answers.
 * @return {object} Canonical answers.
 */
export function initializeAttemptAnswers(
  attempt: StoredAttempt,
  legacy: Record<string, StoredAnswer>,
): Record<string, StoredAnswer> {
  if (attempt.answerStateVersion !== 1) {
    attempt.answers = {...legacy};
    attempt.answerStateVersion = 1;
  }
  return (attempt.answers ||= {});
}

/**
 * Count answers committed with the current attempt state.
 * @param {StoredAttempt} attempt Current state.
 */
export function updateAttemptCounts(attempt: StoredAttempt): void {
  const answers = Object.values(attempt.answers || {});
  attempt.answeredCount = answers.length;
  attempt.correctCount = answers.filter((answer) => answer.isCorrect).length;
}

/**
 * Mirror immutable answers/timings without deleting newer entries.
 * @param {string} uid Owner.
 * @param {string} attemptId Attempt.
 * @param {StoredAttempt} attempt Current state.
 */
export async function projectAttemptState(
  uid: string,
  attemptId: string,
  attempt: StoredAttempt,
): Promise<void> {
  const updates: Record<string, unknown> = {};
  for (const [index, answer] of Object.entries(attempt.answers || {})) {
    updates[`attemptAnswers/${uid}/${attemptId}/${index}`] = answer;
  }
  for (const [index, timing] of Object.entries(
    attempt.questionTimings || {},
  )) {
    updates[`attemptQuestions/${uid}/${attemptId}/${index}/openedAt`] =
      timing.openedAt;
    updates[`attemptQuestions/${uid}/${attemptId}/${index}/deadlineAt`] =
      timing.deadlineAt;
  }
  if (Object.keys(updates).length) await adminDb.ref().update(updates);
}

/**
 * Save an unconfirmed selection without exposing correctness.
 * @param {string} uid Owner.
 * @param {string} attemptId Attempt.
 * @param {string} questionId Current question.
 * @param {string} optionId Selected option.
 * @param {string} requestId Idempotency key.
 * @param {number} receivedAt Server time at callable entry.
 * @return {Promise<boolean>} Whether the selection was accepted.
 */
export async function saveLearningSelection(
  uid: string,
  attemptId: string,
  questionId: string,
  optionId: string,
  requestId: string,
  receivedAt = Date.now(),
): Promise<boolean> {
  const loaded = await context(uid, attemptId);
  const entry = Object.entries(loaded.questions).find(
    ([, question]) => question.questionId === questionId,
  );
  if (!entry || !entry[1].options.some((o) => o.id === optionId)) {
    throw new HttpsError("invalid-argument", "Invalid question or option.");
  }
  const ordinal = Number(entry[0]);
  await enqueueLearningWork(uid, attemptId, loaded.attempt.deadlineAt, true);
  const tx = await transactionWithRetry(
    adminDb.ref(`practiceAttempts/${uid}/${attemptId}`),
    (attempt: StoredAttempt | null) => {
      if (!attempt) return attempt;
      if (
        attempt.status !== "active" ||
          isDailyExpired(attempt) ||
          attempt.currentIndex !== ordinal
      ) {
        return;
      }
      const answers = initializeAttemptAnswers(attempt, loaded.answers);
      if (answers[ordinal] || receivedAt >= attempt.deadlineAt) return;
      attempt.selections ||= {};
      const previous = attempt.selections[ordinal];
      if (previous?.requestId === requestId) {
        if (previous.optionId !== optionId) {
          throw new HttpsError(
            "invalid-argument",
            "requestId payload changed.",
          );
        }
        return attempt;
      }
      if (previous && previous.selectedAt > receivedAt) return;
      attempt.selections[ordinal] = {
        optionId,
        requestId,
        selectedAt: receivedAt,
      };
      return attempt;
    },
  );
  return tx.committed && tx.snapshot.exists() &&
    tx.snapshot.val().selections?.[ordinal]?.requestId === requestId;
}

/**
 * Read a trusted key before entering a pure transaction.
 * @param {StoredQuestion} question Assigned question.
 * @return {Promise<string>} Trusted correct option.
 */
async function correctOption(question: StoredQuestion): Promise<string> {
  const trusted = (
    await adminDb
      .ref(`questionAnswers/${question.questionId}/${question.version}`)
      .get()
  ).val();
  if (
    !trusted ||
    !question.options.some((o) => o.id === trusted.correctOptionId)
  ) {
    throw new HttpsError(
      "internal",
      "Trusted answer configuration is invalid.",
    );
  }
  return trusted.correctOptionId;
}

/**
 * Freeze the last choice received before the deadline, including no choice.
 * @param {StoredAttempt} attempt Current state.
 * @param {StoredQuestion} question Assigned question.
 * @param {string} correctId Trusted answer.
 * @return {StoredAnswer} Immutable timeout answer.
 */
function timeoutAnswer(
  attempt: StoredAttempt,
  question: StoredQuestion,
  correctId: string,
): StoredAnswer {
  const ordinal = attempt.currentIndex;
  const selection = attempt.selections?.[ordinal];
  const selectedOptionId =
    selection && selection.selectedAt < attempt.deadlineAt ?
      selection.optionId :
      null;
  return {
    questionId: question.questionId,
    selectedOptionId,
    isCorrect: selectedOptionId === correctId,
    timedOut: true,
    ordinal,
    requestId: `timeout_${ordinal}`,
    receivedAt: attempt.deadlineAt,
  };
}

/**
 * Resolve an answer using the current question and deadline.
 * @param {string} uid Owner.
 * @param {string} attemptId Attempt.
 * @param {string} questionId Question.
 * @param {string|null} optionId Confirmed choice or timeout request.
 * @param {string} requestId Idempotency key.
 * @param {number} receivedAt Server time at callable entry.
 */
export async function submitLearningAnswer(
  uid: string,
  attemptId: string,
  questionId: string,
  optionId: string | null,
  requestId: string,
  receivedAt = Date.now(),
) {
  const loaded = await context(uid, attemptId);
  const entry = Object.entries(loaded.questions).find(
    ([, question]) => question.questionId === questionId,
  );
  if (!entry) {
    throw new HttpsError("failed-precondition", "Unknown question.");
  }
  const ordinal = Number(entry[0]);
  const question = entry[1];
  if (optionId !== null && !question.options.some((o) => o.id === optionId)) {
    throw new HttpsError("invalid-argument", "Invalid optionId.");
  }
  const [correctId] = await Promise.all([
    correctOption(question),
    enqueueLearningWork(uid, attemptId, loaded.attempt.deadlineAt, true),
  ]);
  const tx = await transactionWithRetry(
    adminDb.ref(`practiceAttempts/${uid}/${attemptId}`),
    (attempt: StoredAttempt | null) => {
      if (!attempt) return attempt;
      if (
        attempt.status !== "active" ||
          isDailyExpired(attempt) ||
          attempt.currentIndex !== ordinal
      ) {
        return;
      }
      const answers = initializeAttemptAnswers(attempt, loaded.answers);
      if (answers[ordinal]) return attempt;
      const now = Date.now();
      const deadline =
          Number(attempt.deadlineAt) || question.deadlineAt || 0;
      if (deadline <= 0 || (optionId === null && now < deadline)) return;
      const timedOut = optionId === null || receivedAt >= deadline;
      answers[ordinal] =
          timedOut ?
            timeoutAnswer(attempt, question, correctId) :
            {
              questionId,
              selectedOptionId: optionId,
              isCorrect: optionId === correctId,
              timedOut: false,
              ordinal,
              requestId,
              receivedAt,
            };
      updateAttemptCounts(attempt);
      // The final confirmed answer completes the session even when the app
      // closes before sending advance. Preserve this time across midnight.
      if (ordinal === attempt.questionCount - 1 &&
            attempt.answeredCount === attempt.questionCount) {
        attempt.status = "waiting";
        attempt.finishedAt = answers[ordinal].receivedAt;
      }
      attempt.updatedAt = now;
      return attempt;
    },
  );
  const attempt = tx.snapshot.val() as StoredAttempt;
  if (!attempt) throw new HttpsError("not-found", "Attempt not found.");
  const answer = attempt.answers?.[ordinal];
  if (
    attempt.status === "active" &&
    attempt.currentIndex === ordinal &&
    !isDailyExpired(attempt)
  ) {
    if (!answer) {
      throw new HttpsError(
        "failed-precondition",
        "Question deadline not valid.",
      );
    }
    if (answer.requestId !== requestId && !answer.timedOut) {
      throw new HttpsError(
        "failed-precondition",
        "Question already answered.",
      );
    }
    if (
      !answer.timedOut &&
      answer.requestId === requestId &&
      answer.selectedOptionId !== optionId
    ) {
      throw new HttpsError(
        "invalid-argument",
        "requestId payload has changed.",
      );
    }
  }
  await projectAttemptState(uid, attemptId, attempt);
  if (attempt.status === "waiting") {
    await enqueueLearningWork(uid, attemptId, Date.now());
  }
  return {attempt, questions: loaded.questions};
}

/**
 * Shared transition; workers use the original deadline as the next start.
 * @param {string} uid Owner.
 * @param {string} attemptId Attempt.
 * @param {string} requestId Idempotency key.
 * @param {number} expectedIndex Stale client guard.
 * @param {boolean} background Use authoritative deadline boundaries.
 */
export async function advanceLearningAttempt(
  uid: string,
  attemptId: string,
  requestId: string,
  expectedIndex?: number,
  background = false,
) {
  const loaded = await context(uid, attemptId);
  const loadedIndex = loaded.attempt.currentIndex;
  const currentQuestion = loaded.questions[loadedIndex];
  const resolved = loaded.attempt.answerStateVersion === 1 &&
    loaded.attempt.answers?.[loadedIndex];
  const [correctId] = await Promise.all([
    currentQuestion && !resolved ? correctOption(currentQuestion) : "",
    enqueueLearningWork(uid, attemptId, loaded.attempt.deadlineAt, true),
  ]);
  const tx = await transactionWithRetry(
    adminDb.ref(`practiceAttempts/${uid}/${attemptId}`),
    (attempt: StoredAttempt | null) => {
      if (!attempt) return attempt;
      if (
        attempt.status !== "active" ||
          isDailyExpired(attempt) ||
          attempt.advanceOperations?.[requestId] ||
          attempt.currentIndex !== loadedIndex ||
          (expectedIndex !== undefined && loadedIndex !== expectedIndex)
      ) {
        return;
      }
      const index = attempt.currentIndex;
      const question = loaded.questions[index];
      if (!question) throw new HttpsError("internal", "Question missing.");
      const deadline =
          Number(attempt.deadlineAt) || question.deadlineAt || 0;
      if (deadline <= 0) {
        throw new HttpsError(
          "failed-precondition",
          "Question deadline missing.",
        );
      }
      const now = Date.now();
      const answers = initializeAttemptAnswers(attempt, loaded.answers);
      if ((background || !answers[index]) && now < deadline) return;
      const deadlineTransition = background || !answers[index];
      answers[index] ||= timeoutAnswer(attempt, question, correctId);
      updateAttemptCounts(attempt);
      const nextIndex = index + 1;
      if (nextIndex >= attempt.questionCount) {
        attempt.status = "waiting";
        attempt.finishedAt = deadlineTransition ? deadline : now;
      } else {
        const next = loaded.questions[nextIndex];
        if (!next) {
          throw new HttpsError("internal", "Next question missing.");
        }
        const stored = attempt.questionTimings?.[nextIndex] || next;
        const openedAt =
            Number(stored.openedAt) || (deadlineTransition ? deadline : now);
        const deadlineAt = Math.min(
          Number(stored.deadlineAt) || openedAt + 30000,
          normalizeMode(attempt.mode) === "DAILY" ?
            dailyEndsAt(attempt) :
            Infinity,
        );
        attempt.questionTimings ||= {};
        attempt.questionTimings[nextIndex] = {openedAt, deadlineAt};
        attempt.currentIndex = nextIndex;
        attempt.deadlineAt = deadlineAt;
      }
      attempt.advanceOperations ||= {};
      attempt.advanceOperations[requestId] = {
        fromIndex: index,
        completedAt: now,
      };
      attempt.updatedAt = now;
      return attempt;
    },
  );
  const attempt = tx.snapshot.val() as StoredAttempt;
  if (!attempt) throw new HttpsError("not-found", "Attempt not found.");
  if (
    !background &&
    !tx.committed &&
    attempt.status === "active" &&
    !isDailyExpired(attempt) &&
    attempt.currentIndex === (expectedIndex ?? loaded.attempt.currentIndex) &&
    !attempt.advanceOperations?.[requestId]
  ) {
    throw new HttpsError("failed-precondition", "Question is not resolved.");
  }
  await projectAttemptState(uid, attemptId, attempt);
  if (attempt.status === "waiting") {
    await enqueueLearningWork(uid, attemptId, Date.now());
  }
  return {attempt, questions: loaded.questions};
}
