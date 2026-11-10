import {requireActiveUserSession} from "../auth/userSession";
import {CallableRequest, onCall, HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {WireQuestion, getDateKey, normalizeMode} from "./attemptHelper";
import {readAttemptResponse as buildAttemptResponse} from "./finalizeAttempt";
import {startDailyAttempt} from "./startDailyAttempt";
import {initialLearningWork, learningWorkKey} from "./learningWork";
import {
  contentId,
  playableQuestion,
  publishedTopic,
  record,
} from "./contentValidation";

const QUESTION_TIME_LIMIT_SECONDS = 30;
// Recover stale pending operations after a ten-second lease.
const OPERATION_LEASE_MS = 10_000;
const REQUEST_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

const QUESTION_COUNTS: Record<string, number> = {
  PRACTICE: 10,
  TEST: 20,
  DAILY: 5,
  BATTLE: 10,
};

/**
 * Shuffle array using Fisher-Yates.
 * @param {Array} arr Input array to copy and shuffle.
 * @return {Array} Shuffled copy of the input.
 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Select random published questions filtered by topicId
 * (for PRACTICE) or unfiltered (for TEST/DAILY).
 * @param {string} mode Mode selecting the question count and pool.
 * @param {string|null} topicId Topic filter for practice mode.
 */
export async function selectQuestions(
  mode: string,
  topicId: string | null,
): Promise<WireQuestion[]> {
  const count = QUESTION_COUNTS[mode];
  if (!count) {
    throw new HttpsError("invalid-argument", `Unsupported mode: ${mode}`);
  }

  const templateId = mode === "BATTLE" ? "battle_mixed" :
    mode === "TEST" ? "test_mixed" : "daily_mixed";
  const [categories, topics, lessons, assets, questionsSnap, templateSnap] =
    await Promise.all([
      adminDb.ref("categories").get(),
      adminDb.ref("topics").get(),
      adminDb.ref("lessons").get(),
      adminDb.ref("contentAssets").get(),
      adminDb.ref("questions").get(),
      mode === "PRACTICE" ? null :
        adminDb.ref(`quizTemplates/${templateId}`).get(),
    ]);
  const relations = {
    categories: record(categories.val()),
    topics: record(topics.val()),
    lessons: record(lessons.val()),
    assets: record(assets.val()),
  };
  if (mode === "PRACTICE" && !publishedTopic(topicId, relations)) {
    throw new HttpsError(
      "failed-precondition",
      "Practice topic or its skill is missing or not published.",
    );
  }

  let pool: Record<string, unknown> = {};
  if (mode !== "PRACTICE") {
    const template = templateSnap?.val();
    if (
      !template ||
      template.status !== "published" ||
      normalizeMode(template.mode) !== mode ||
      template.questionCount !== count ||
      template.questionTimeLimitSeconds !== 30 ||
      template.completionCoins !== (mode === "BATTLE" ? 0 : 2) ||
      (mode === "BATTLE" && (template.sharedQuestionSet !== true ||
        template.winCoins !== 5 || template.winRating !== 5 ||
        template.lossRating !== -2 || template.ratingFloor !== 0 ||
        template.lossCoins !== 0 || template.drawCoins !== 0 ||
        template.drawRating !== 0)) ||
      template.completionPolicy !== "all_questions_resolved"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Learning template is missing or invalid.",
      );
    }
    pool = template.questionPool || {};
    if (
      pool.scope !== "all_categories" &&
      typeof pool.categoryId !== "string"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Question pool scope is not configured.",
      );
    }
  }

  // Filter published questions in memory without requiring an .indexOn entry.
  if (!questionsSnap.exists()) {
    throw new HttpsError(
      "failed-precondition",
      "Not enough questions available.",
    );
  }

  const allQuestions: Array<{
    id: string;
    meta: Record<string, unknown>;
  }> = [];

  questionsSnap.forEach((child) => {
    const meta = record(child.val());
    if (meta.status !== "published") return;
    if (!contentId(meta.currentVersion) ||
        !publishedTopic(meta.topicId, relations)) return;
    if (pool.categoryId && meta.categoryId !== pool.categoryId) return;
    if (pool.topicId && meta.topicId !== pool.topicId) return;

    // PRACTICE must filter by topicId
    if (mode === "PRACTICE" && topicId) {
      if (meta.topicId !== topicId) return;
    }

    allQuestions.push({id: child.key!, meta});
  });

  if (allQuestions.length < count) {
    throw new HttpsError(
      "failed-precondition",
      "Not enough questions available for this topic.",
    );
  }

  // Select random subset
  const selected = shuffle(allQuestions);

  // Read batches in shuffled order, filling gaps for invalid candidates.
  const wireQuestions: WireQuestion[] = [];

  let offset = 0;
  while (offset < selected.length && wireQuestions.length < count) {
    const size = Math.min(8, count - wireQuestions.length);
    const batch = selected.slice(offset, offset + size);
    const candidates = await Promise.all(batch.map(async ({id, meta}) => {
      const [version, answer] = await Promise.all([
        adminDb.ref(`questionVersions/${id}/${meta.currentVersion}`).get(),
        adminDb.ref(`questionAnswers/${id}/${meta.currentVersion}`).get(),
      ]);
      return playableQuestion(id, meta, version.val(), answer.val(), relations);
    }));
    for (const question of candidates) {
      if (question) wireQuestions.push(question);
    }
    offset += batch.length;
  }
  if (wireQuestions.length !== count) {
    throw new HttpsError(
      "failed-precondition",
      "Not enough questions with valid content and answers.",
    );
  }

  return wireQuestions;
}

export const handleStartAttempt =
  async (request: CallableRequest) => {
    // 1. Auth check
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "You must sign in first.");
    }

    const data = request.data as {
      mode?: string;
      topicId?: string | null;
      requestId?: string;
    };

    const mode = data?.mode;
    const topicId = data?.topicId ?? null;
    const requestId = data?.requestId;

    if (topicId !== null && !contentId(topicId)) {
      throw new HttpsError(
        "invalid-argument",
        "topicId must be a valid database key or null.",
      );
    }

    // 2. Validate input format and safe key characters
    if (!mode || !requestId) {
      throw new HttpsError(
        "invalid-argument",
        "mode and requestId are required.",
      );
    }

    if (typeof requestId !== "string" || !REQUEST_ID_REGEX.test(requestId)) {
      throw new HttpsError(
        "invalid-argument",
        "requestId must be a string matching ^[A-Za-z0-9_-]{1,128}$",
      );
    }

    if (!["PRACTICE", "TEST", "DAILY"].includes(mode)) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid mode for this endpoint.",
      );
    }

    if (mode === "PRACTICE" && (!topicId || topicId.length === 0)) {
      throw new HttpsError(
        "invalid-argument",
        "topicId is required for PRACTICE mode.",
      );
    }

    let opKey: string | null = null;
    let acquiredLock = false;
    const workerToken = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      // 3. Verify account is active
      await requireActiveUserSession(request);

      // 4. Idempotency & Concurrency: acquire operation lock with lease
      const now = Date.now();
      opKey = `operations/${uid}_start_${requestId}`;
      const opRef = adminDb.ref(opKey);

      let existingAttemptId: string | null = null;
      let existingAttemptData: Record<string, unknown> | null = null;

      // 4a. Reuse completed operations or previously persisted attempt data.
      const opSnap = await opRef.get();
      if (opSnap.exists()) {
        const opVal = opSnap.val() as Record<string, unknown>;
        if (opVal.attemptId) {
          // Validate parameter consistency
          const opMode = (opVal.mode as string) || "";
          const opTopic = (opVal.topicId as string) || "";
          if (opMode !== mode.toUpperCase() || opTopic !== (topicId ?? "")) {
            throw new HttpsError(
              "invalid-argument",
              "requestId has already been used with different parameters.",
            );
          }

          // Check if attempt record already exists in database
          const aSnap = await adminDb
            .ref(`practiceAttempts/${uid}/${opVal.attemptId}`)
            .get();

          if (aSnap.exists()) {
            existingAttemptId = opVal.attemptId as string;
            existingAttemptData = aSnap.val() as Record<string, unknown>;
            if (opVal.status === "committing") {
              // Ensure operation status is updated to completed
              await opRef
                .update({status: "completed", completedAt: Date.now()})
                .catch(() => {});
            }
          }
        }
      }

      // 4b. Fallback: check recent attempts for backwards compatibility
      if (!existingAttemptId) {
        const existingSnap = await adminDb
          .ref(`practiceAttempts/${uid}`)
          .limitToLast(50)
          .get();

        if (existingSnap.exists()) {
          existingSnap.forEach((child) => {
            const val = child.val() as Record<string, unknown>;
            if (val.requestId === requestId) {
              existingAttemptId = child.key;
              existingAttemptData = val;
            }
          });
        }
      }

      if (existingAttemptId) {
        if (!existingAttemptData) {
          const aSnap = await adminDb
            .ref(`practiceAttempts/${uid}/${existingAttemptId}`)
            .get();
          if (aSnap.exists()) {
            existingAttemptData = aSnap.val() as Record<string, unknown>;
          }
        }
        if (existingAttemptData) {
          // Validate parameter consistency on attempt record
          const attMode = normalizeMode(existingAttemptData.mode);
          const attTopic = (existingAttemptData.topicId as string) || "";
          if (
            attMode !== mode.toUpperCase() ||
            (mode === "PRACTICE" && attTopic !== (topicId ?? ""))
          ) {
            throw new HttpsError(
              "invalid-argument",
              "requestId has already been used with different parameters.",
            );
          }
          return buildAttemptResponse(
            uid,
            existingAttemptId,
            existingAttemptData,
          );
        }
      }

      // 4c. Atomic reservation with lease TTL and deterministic attempt ID
      const assignedAttemptId =
        mode === "DAILY" ?
          `daily_${getDateKey(now)}` :
          adminDb.ref(`practiceAttempts/${uid}`).push().key!;
      const txResult = await opRef.transaction((current) => {
        if (current !== null) {
          // If already completed, do not overwrite
          if (current.status === "completed") {
            return;
          }
          // If pending or committing, check if active lease has expired
          const lockTime =
            (current.status === "committing" ?
              current.committedAt :
              current.createdAt) || 0;
          if (
            (current.status === "pending" || current.status === "committing") &&
            typeof lockTime === "number" &&
            now - lockTime < OPERATION_LEASE_MS
          ) {
            return;
          }
        }
        // Preserve the attemptId when reclaiming a stale lease.
        return {
          status: "pending",
          workerToken,
          attemptId: current?.attemptId || assignedAttemptId,
          mode: mode.toUpperCase(),
          topicId: topicId ?? "",
          createdAt: now,
        };
      });

      if (!txResult.committed) {
        acquiredLock = false;
        // The winning request may still be selecting/validating its questions.
        // Poll the operation, including when its attemptId is already reserved.
        for (let retry = 0; retry < 40; retry++) {
          const waitingOp = (await opRef.get()).val();
          const waitAttemptId = waitingOp?.attemptId as string | undefined;
          if (waitAttemptId) {
            const aSnap = await adminDb
              .ref(`practiceAttempts/${uid}/${waitAttemptId}`)
              .get();
            if (aSnap.exists()) {
              const aData = aSnap.val() as Record<string, unknown>;
              const attMode = normalizeMode(aData.mode);
              const attTopic = (aData.topicId as string) || "";
              if (
                attMode !== mode.toUpperCase() ||
                (mode === "PRACTICE" && attTopic !== (topicId ?? ""))
              ) {
                throw new HttpsError(
                  "invalid-argument",
                  "requestId has already been used with different parameters.",
                );
              }
              return buildAttemptResponse(uid, waitAttemptId, aData);
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        throw new HttpsError(
          "already-exists",
          "Attempt creation is already in progress.",
        );
      }

      // Successfully acquired lease
      acquiredLock = true;
      const attemptId =
        txResult.snapshot.val()?.attemptId || assignedAttemptId!;

      if (mode === "DAILY") {
        const response = await startDailyAttempt(
          uid,
          attemptId,
          requestId,
          () => selectQuestions(mode, null),
        );
        await opRef.transaction((current) => {
          if (current?.workerToken !== workerToken) return;
          return {
            ...current,
            status: "completed",
            attemptId: response.attempt.id,
            completedAt: Date.now(),
          };
        });
        return response;
      }

      // 6. Select questions
      const questions = await selectQuestions(mode, topicId);

      // 7. Verify atomically that this worker still owns the lease.
      const committingTime = Date.now();
      const commitLockTx = await opRef.transaction((current) => {
        if (current === null) {
          // Optimistically use our workerToken when the local cache is empty.
          // RTDB compares server state and retries with the actual data.
          return {
            status: "committing",
            workerToken,
            attemptId,
            committedAt: committingTime,
          };
        }
        if (
          current.workerToken !== workerToken ||
          current.status !== "pending"
        ) {
          // Another worker owns the lease according to server state.
          return;
        }
        return {
          ...current,
          status: "committing",
          committedAt: committingTime,
        };
      });

      if (!commitLockTx.committed) {
        // Lease expired during question selection and was overtaken.
        // Avoid creating a second attempt after losing the lease.
        // The new owner is responsible for cleanup.
        acquiredLock = false;
        throw new HttpsError(
          "aborted",
          "Operation lease expired and was overtaken by another request.",
        );
      }

      // Do not recover by blindly overwriting an already persisted attempt
      const attemptCheck = await adminDb
        .ref(`practiceAttempts/${uid}/${attemptId}`)
        .get();
      if (attemptCheck.exists()) {
        const persistedData = attemptCheck.val() as Record<string, unknown>;
        await opRef
          .update({status: "completed", completedAt: Date.now()})
          .catch(() => {});
        return buildAttemptResponse(uid, attemptId, persistedData);
      }

      // 8. Capture a fresh server timestamp immediately before writing.
      const openedAt = Date.now();
      const deadlineAt = openedAt + QUESTION_TIME_LIMIT_SECONDS * 1000;
      const questionCount = QUESTION_COUNTS[mode]!;

      const attemptRecord: Record<string, unknown> = {
        mode: mode.toLowerCase(),
        ...(mode === "TEST" ? {templateId: "test_mixed"} : {}),
        categoryId: mode === "PRACTICE" ? (questions[0]?.categoryId ?? "") : "",
        topicId: topicId ?? "",
        status: "active",
        startedAt: openedAt,
        finishedAt: null,
        questionCount,
        correctCount: 0,
        answeredCount: 0,
        coinsAwarded: 0,
        currentIndex: 0,
        deadlineAt,
        requestId,
        createdAt: openedAt,
        updatedAt: openedAt,
      };

      const questionsRecord: Record<string, unknown> = {};
      questions.forEach((q, i) => {
        questionsRecord[i.toString()] = {
          questionId: q.id,
          version: q.version,
          categoryId: q.categoryId,
          topicId: q.topicId,
          prompt: q.prompt,
          options: q.options.map((o) => ({
            id: o.id,
            text: o.text,
          })),
          passage: q.passage,
          audioText: q.audioText,
          ordinal: i,
          openedAt: i === 0 ? openedAt : null,
          deadlineAt: i === 0 ? deadlineAt : null,
        };
      });

      // 9. Write atomically (all-or-nothing consistency)
      const updates: Record<string, unknown> = {};
      updates[`practiceAttempts/${uid}/${attemptId}`] = attemptRecord;
      updates[`attemptQuestions/${uid}/${attemptId}`] = questionsRecord;
      updates[`learningWork/${learningWorkKey(uid, attemptId)}`] =
        initialLearningWork(uid, attemptId, deadlineAt);
      updates[opKey] = {
        status: "completed",
        workerToken,
        attemptId,
        mode: mode.toUpperCase(),
        topicId: topicId ?? "",
        completedAt: openedAt,
      };

      await adminDb.ref().update(updates);

      // 10. Build response
      return {
        serverNow: Date.now(),
        attempt: {
          id: attemptId,
          mode,
          topicId: topicId ?? "",
          questions,
          index: 0,
          deadlineAt,
          receipts: [],
          status: "active",
          opponentName: "",
          result: null,
          reconnectDeadlineAt: null,
        },
      };
    } catch (error) {
      // Clean up only if this worker acquired and still owns the pending lock.
      if (opKey && acquiredLock) {
        try {
          await adminDb.ref(opKey).transaction((current) => {
            if (current === null) {
              return null;
            }
            if (
              current.workerToken === workerToken &&
              current.status === "pending"
            ) {
              return null; // Safely delete only owned pending lock
            }
            return; // Overtaken or completed; do not touch
          });
        } catch {
          // ignore cleanup errors
        }
      }

      if (error instanceof HttpsError) {
        throw error;
      }

      console.error("startAttempt failed", {uid, error});

      throw new HttpsError("internal", "Unable to start attempt.");
    }
  };

export const startAttempt = onCall(
  {
    region: "asia-southeast1",
    maxInstances: 10,
  },
  handleStartAttempt,
);
