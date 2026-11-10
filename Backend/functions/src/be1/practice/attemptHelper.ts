import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";

export interface WireOption {
  id: string;
  text: string;
}

export interface WireQuestion {
  id: string;
  version: string;
  categoryId: string;
  topicId: string;
  prompt: string;
  options: WireOption[];
  passage: string;
  audioText: string;
}

export interface WireReceipt {
  questionId: string;
  optionId: string | null;
  correct: boolean | null;
}

export interface WireReview {
  question: WireQuestion;
  pickedId: string | null;
  correctId: string;
  explanation: string;
}

export interface WireResult {
  attemptId: string;
  mode: string;
  correct: number;
  total: number;
  coins: number;
  ratingDelta: number;
  outcome: string;
  opponentName: string;
  opponentCorrect: number;
  completedAt: number;
  reviews: WireReview[];
  durationMs?: number | null;
}

export interface WireAttempt {
  id: string;
  mode: string;
  topicId: string;
  questions: WireQuestion[];
  index: number;
  deadlineAt: number;
  receipts: WireReceipt[];
  status: string;
  opponentName: string;
  result: WireResult | null;
  reconnectDeadlineAt: number | null;
  selectedOptionId?: string | null;
}

/**
 * Build reviews using trusted questionAnswers and cached attemptReviews.
 * @param {string} uid Owner of the attempt.
 * @param {string} attemptId Attempt to review.
 * @param {string} status Current attempt status.
 * @param {WireQuestion[]} questions Questions selected for the attempt.
 * @param {object} answersRecord Previously loaded answers, if available.
 */
export async function buildAttemptReviews(
  uid: string,
  attemptId: string,
  status: string,
  questions: WireQuestion[],
  answersRecord?: Record<string, Record<string, unknown>> | null,
): Promise<WireReview[]> {
  // Only terminal attempts may generate or cache reviews with correct answers.
  if (status !== "completed" && status !== "abandoned") {
    throw new HttpsError(
      "failed-precondition",
      "Reviews can only be generated or cached " +
        "for completed or abandoned attempts.",
    );
  }

  const reviews: WireReview[] = [];
  if (!questions || questions.length === 0) {
    return reviews;
  }

  // Pre-read any existing attemptReviews (if already persisted)
  const existingReviewsSnap = await adminDb
    .ref(`attemptReviews/${uid}/${attemptId}`)
    .get();
  const existingReviews = (existingReviewsSnap.val() || {}) as Record<
    string,
    Record<string, unknown>
  >;

  const answers = (answersRecord || {}) as Record<
    string,
    Record<string, unknown>
  >;
  const newReviewsToPersist: Record<string, unknown> = {};
  const now = Date.now();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const key = i.toString();

    // 1. User's picked option
    const ans =
      answers[key] ||
      Object.values(answers).find(
        (a) => a && (a as Record<string, unknown>).questionId === q.id,
      );

    let pickedId: string | null = null;
    if (ans && typeof ans.selectedOptionId === "string") {
      pickedId = ans.selectedOptionId;
    }

    // 2. Correct answer & explanation
    const existing = existingReviews[key];
    let correctId = (existing?.correctOptionId as string) || "";
    let explanation = (existing?.explanation as string) || "";

    // Load trusted answers when the cached correctOptionId is invalid.
    if (
      !correctId ||
      typeof correctId !== "string" ||
      correctId.trim().length === 0
    ) {
      const qaSnap = await adminDb
        .ref(`questionAnswers/${q.id}/${q.version}`)
        .get();

      if (!qaSnap.exists()) {
        throw new HttpsError(
          "internal",
          "Trusted question answer configuration is missing on server for " +
            `${q.id}/${q.version}`,
        );
      }

      const qa = qaSnap.val() as Record<string, unknown>;
      correctId = (qa.correctOptionId as string) || "";
      explanation = typeof qa.explanation === "string" ? qa.explanation : "";
    }

    // Never return or cache reviews with an empty or invalid correctId.
    if (
      !correctId ||
      typeof correctId !== "string" ||
      correctId.trim().length === 0
    ) {
      throw new HttpsError(
        "internal",
        "Trusted question answer configuration is invalid or missing " +
          `correctOptionId for ${q.id}/${q.version}`,
      );
    }

    const optionExists =
      q.options && q.options.some((opt) => opt.id === correctId);
    if (!optionExists) {
      throw new HttpsError(
        "internal",
        `Correct answer ${correctId} does not match any valid option ` +
          `for question ${q.id}/${q.version}`,
      );
    }

    // Cache only verified reviews that are absent from existingReviews.
    if (!existingReviews[key]) {
      newReviewsToPersist[key] = {
        questionId: q.id,
        version: q.version,
        correctOptionId: correctId,
        explanation,
        releasedAt: now,
      };
    }

    reviews.push({
      question: {
        id: q.id,
        version: q.version,
        categoryId: q.categoryId,
        topicId: q.topicId,
        prompt: q.prompt,
        options: q.options,
        passage: q.passage || "",
        audioText: q.audioText || "",
      },
      pickedId,
      correctId,
      explanation,
    });
  }

  // Persist attemptReviews only for verified terminal attempts
  if (Object.keys(newReviewsToPersist).length > 0) {
    await adminDb
      .ref(`attemptReviews/${uid}/${attemptId}`)
      .update(newReviewsToPersist);
  }

  return reviews;
}

/**
 * Assemble the client response from stored attempt records.
 * @param {string} uid Owner of the attempt.
 * @param {string} attemptId Attempt to read.
 * @param {object} attemptData Current attempt state.
 * @param {object} storedQuestions Immutable question snapshot, if already read.
 * @return {Promise<object>} Attempt response with the current server time.
 */
export async function buildAttemptResponse(
  uid: string,
  attemptId: string,
  attemptData: Record<string, unknown>,
  storedQuestions?: Record<string, Record<string, unknown>>,
): Promise<{serverNow: number; attempt: WireAttempt}> {
  const [questionSnapshot, legacyAnswers] = await Promise.all([
    storedQuestions ? null :
      adminDb.ref(`attemptQuestions/${uid}/${attemptId}`).get(),
    attemptData.answerStateVersion === 1 ? null :
      adminDb.ref(`attemptAnswers/${uid}/${attemptId}`).get(),
  ]);
  const questionData: Record<string, Record<string, unknown>> | null =
    storedQuestions ?? questionSnapshot?.val() ?? null;

  const questions: WireQuestion[] = [];
  if (questionData) {
    const sorted = Object.values(questionData).sort(
      (a, b) => ((a.ordinal as number) ?? 0) - ((b.ordinal as number) ?? 0),
    );

    for (const q of sorted) {
      const optionsRaw = (q.options as Array<{id: string; text: string}>) ?? [];
      questions.push({
        id: (q.questionId as string) || (q.id as string) || "",
        version: (q.version as string) ?? "v1",
        categoryId: (q.categoryId as string) ?? "",
        topicId: (q.topicId as string) ?? "",
        prompt: (q.prompt as string) ?? "",
        options: optionsRaw.map((o) => ({
          id: o.id,
          text: o.text,
        })),
        passage: (q.passage as string) ?? "",
        audioText: (q.audioText as string) ?? "",
      });
    }
  }

  // Load answers/receipts
  const answers = attemptData.answerStateVersion === 1 ?
    attemptData.answers || {} :
    legacyAnswers?.val() || {};

  const receipts: WireReceipt[] = [];

  if (Object.keys(answers).length) {
    const aData = answers as Record<string, Record<string, unknown>>;

    const sortedAnswers = Object.values(aData).sort(
      (a, b) => ((a.ordinal as number) ?? 0) - ((b.ordinal as number) ?? 0),
    );

    for (const ans of sortedAnswers) {
      receipts.push({
        questionId: (ans.questionId as string) ?? "",
        optionId: (ans.selectedOptionId as string) ?? null,
        correct: typeof ans.isCorrect === "boolean" ? ans.isCorrect : null,
      });
    }
  }

  const modeRaw = (attemptData.mode as string) ?? "practice";
  const mode = normalizeMode(modeRaw);
  const currentIndex = (attemptData.currentIndex as number) ?? 0;
  const status = (attemptData.status as string) ?? "active";
  const topicId = (attemptData.topicId as string) ?? "";
  const deadlineAt = (attemptData.deadlineAt as number) ?? 0;
  const selections = attemptData.selections as Record<
    string, {optionId: string}
  > | undefined;

  // Build result if completed or abandoned
  let result: WireResult | null = null;
  if (status === "completed" || status === "abandoned") {
    const reviews = await buildAttemptReviews(
      uid,
      attemptId,
      status,
      questions,
      answers as Record<string, Record<string, unknown>>,
    );
    result = {
      attemptId,
      mode,
      correct: (attemptData.correctCount as number) ?? 0,
      total: (attemptData.questionCount as number) ?? questions.length,
      coins: (attemptData.coinsAwarded as number) ?? 0,
      ratingDelta: 0,
      outcome: status,
      opponentName: "",
      opponentCorrect: 0,
      completedAt: (attemptData.finishedAt as number) ?? 0,
      reviews,
      durationMs: typeof attemptData.durationMs === "number" ?
        attemptData.durationMs : null,
    };
  }

  return {
    serverNow: Date.now(),
    attempt: {
      id: attemptId,
      mode,
      topicId,
      questions,
      index: currentIndex,
      deadlineAt,
      receipts,
      status,
      opponentName: "",
      result,
      reconnectDeadlineAt: null,
      selectedOptionId: selections?.[currentIndex]?.optionId || null,
    },
  };
}

/**
 * Format a date in the daily challenge's timezone.
 * @param {Date|number} dateInput Date or timestamp, defaulting to now.
 * @return {string} Calendar date in Asia/Ho_Chi_Minh.
 */
export function getDateKey(dateInput?: Date | number): string {
  const date = dateInput !== undefined ? new Date(dateInput) : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Normalize mode names, including the legacy daily challenge alias.
 * @param {unknown} mode Mode supplied by stored data or a request.
 * @return {string} Uppercase mode name.
 */
export function normalizeMode(mode: unknown): string {
  const value = typeof mode === "string" ? mode.toUpperCase() : "";
  return value === "DAILYCHALLENGE" ? "DAILY" : value;
}

/**
 * Calculate the midnight deadline for a daily attempt.
 * @param {object} attempt Attempt with a valid start timestamp.
 * @return {number} End of the challenge day in milliseconds.
 */
export function dailyEndsAt(attempt: Record<string, unknown>): number {
  const startedAt = Number(attempt.startedAt || attempt.createdAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    throw new HttpsError("failed-precondition", "Daily start time is missing.");
  }
  return Date.parse(`${getDateKey(startedAt)}T00:00:00+07:00`) + 86400000;
}

/**
 * Check whether an unfinished daily attempt has reached its deadline.
 * @param {object} attempt Current attempt state.
 * @param {number} now Time used to check expiration.
 * @return {boolean} Whether the daily attempt has expired.
 */
export function isDailyExpired(
  attempt: Record<string, unknown>,
  now = Date.now(),
): boolean {
  if (normalizeMode(attempt.mode) !== "DAILY" ||
      attempt.status === "completed" || attempt.status === "abandoned") {
    return false;
  }
  const endsAt = dailyEndsAt(attempt);
  // A fully resolved session finished before midnight may settle after a
  // worker restart. Unfinished sessions still expire at midnight.
  const finishedAt = Number(attempt.finishedAt);
  if (attempt.status === "waiting" && finishedAt > 0 && finishedAt < endsAt) {
    return false;
  }
  return (
    attempt.status !== "completed" &&
    attempt.status !== "abandoned" &&
    now >= endsAt
  );
}

/**
 * Recover the current question's timestamps from attemptData if needed.
 * @param {string} uid Owner of the attempt.
 * @param {string} attemptId Attempt containing the question.
 * @param {number} index Current question index.
 * @param {object} qData Stored question state.
 * @param {object} attemptData Current attempt state.
 */
export async function ensureQuestionDeadline(
  uid: string,
  attemptId: string,
  index: number,
  qData: Record<string, unknown>,
  attemptData: Record<string, unknown>,
): Promise<number> {
  let deadlineAt =
    (qData.deadlineAt as number) || (attemptData.deadlineAt as number) || 0;
  if (!deadlineAt || deadlineAt <= 0) {
    if (typeof qData.openedAt === "number" && qData.openedAt > 0) {
      deadlineAt = qData.openedAt + 30000;
    }
  }

  if (normalizeMode(attemptData.mode) === "DAILY" && deadlineAt > 0) {
    deadlineAt = Math.min(deadlineAt, dailyEndsAt(attemptData));
  }

  // Self-healing recovery: persist missing values to attemptQuestions
  if (
    deadlineAt > 0 &&
    (qData.deadlineAt !== deadlineAt || qData.openedAt == null)
  ) {
    const openedAt = (qData.openedAt as number) || deadlineAt - 30000;
    await adminDb
      .ref(`attemptQuestions/${uid}/${attemptId}/${index}`)
      .update({
        openedAt,
        deadlineAt,
      })
      .catch(() => {});
  }

  return deadlineAt;
}
