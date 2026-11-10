import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {getDateKey, WireQuestion} from "./attemptHelper";
import {readAttemptResponse} from "./finalizeAttempt";
import {enqueueLearningWork} from "./learningWork";

/**
 * The UID/date slot elects one attempt. Questions and attempt records are
 * first-write-wins transactions, so an interrupted start can be resumed by
 * another request without replacing questions, deadlines or a terminal result.
 * @param {string} uid Owner of the daily challenge slot.
 * @param {string} candidateId Suggested attempt identifier.
 * @param {string} requestId Identifier used for retry deduplication.
 * @param {Function} selectQuestions Loader for the selected daily questions.
 */
export async function startDailyAttempt(
  uid: string,
  candidateId: string,
  requestId: string,
  selectQuestions: () => Promise<WireQuestion[]>,
) {
  const dateKey = /^daily_\d{4}-\d{2}-\d{2}$/.test(candidateId) ?
    candidateId.slice(6) :
    getDateKey();
  const endsAt = Date.parse(`${dateKey}T00:00:00+07:00`) + 86400000;
  const slotRef = adminDb.ref(`userDailyChallenges/${uid}/${dateKey}`);
  const existingSlot = (await slotRef.get()).val();

  if (existingSlot?.attemptId) {
    const existing = (
      await adminDb
        .ref(`practiceAttempts/${uid}/${existingSlot.attemptId}`)
        .get()
    ).val();
    if (existing) {
      if (existing.status === "completed" || existing.status === "abandoned") {
        throw new HttpsError(
          "already-exists",
          "Daily challenge already used today.",
        );
      }
      return readAttemptResponse(uid, existingSlot.attemptId, existing);
    }
  }

  // Validate content BEFORE reserving a previously unused daily slot.
  const existingQuestions = existingSlot?.attemptId ?
    (
      await adminDb
        .ref(`attemptQuestions/${uid}/${existingSlot.attemptId}`)
        .get()
    ).val() :
    null;
  const questions = existingQuestions ? [] : await selectQuestions();
  if (!existingSlot && Date.now() >= endsAt) {
    throw new HttpsError(
      "failed-precondition",
      "Daily challenge date has expired.",
    );
  }
  const startedAt = Date.now();
  const challengeRef = adminDb.ref(`dailyChallenges/${dateKey}/daily_mixed`);
  const challengeTx = await challengeRef.transaction(
    (challenge) =>
      challenge || {
        templateId: "daily_mixed",
        title: "Thử thách hôm nay",
        status: "published",
        questionCount: 5,
        questionTimeLimitSeconds: 30,
        selectionMode: "random_without_replacement",
        completionCoins: 2,
        maxAttemptsPerUserPerDay: 1,
        startsAt: endsAt - 86400000,
        endsAt,
      },
  );
  const challenge = challengeTx.snapshot.val();
  if (
    challenge.status !== "published" ||
    challenge.templateId !== "daily_mixed" ||
    challenge.questionCount !== 5 ||
    challenge.questionTimeLimitSeconds !== 30 ||
    challenge.completionCoins !== 2 ||
    challenge.maxAttemptsPerUserPerDay !== 1 ||
    challenge.endsAt !== endsAt ||
    challenge.startsAt !== endsAt - 86400000
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Daily challenge configuration is invalid.",
    );
  }
  const slotTx = await slotRef.transaction((slot) => {
    if (slot) return slot;
    if (Date.now() >= endsAt) return;
    return {
      challengeId: "daily_mixed",
      attemptId: candidateId,
      status: "active",
      startedAt,
    };
  });
  const slot = slotTx.snapshot.val();
  if (!slot?.attemptId) {
    throw new HttpsError("internal", "Daily slot reservation failed.");
  }
  if (slot.status === "completed" || slot.status === "abandoned") {
    throw new HttpsError(
      "already-exists",
      "Daily challenge already used today.",
    );
  }
  const attemptId = slot.attemptId as string;
  const firstOpenedAt = Math.min(Date.now(), endsAt - 1);
  const questionRecord = Object.fromEntries(
    questions.map((q, ordinal) => [
      ordinal,
      {
        questionId: q.id,
        version: q.version,
        categoryId: q.categoryId,
        topicId: q.topicId,
        prompt: q.prompt,
        options: q.options,
        passage: q.passage,
        audioText: q.audioText,
        ordinal,
        ...(ordinal === 0 ? {
          openedAt: firstOpenedAt,
          deadlineAt: Math.min(firstOpenedAt + 30000, endsAt),
        } : {}),
      },
    ]),
  );
  const qTx = await adminDb
    .ref(`attemptQuestions/${uid}/${attemptId}`)
    .transaction((current) => current || existingQuestions || questionRecord);
  const storedQuestions = qTx.snapshot.val();
  if (Object.keys(storedQuestions || {}).length !== 5) {
    throw new HttpsError(
      "failed-precondition",
      "Daily requires five valid questions.",
    );
  }
  const openedAt =
    Number(storedQuestions[0]?.openedAt) || Number(slot.startedAt);
  const deadlineAt = Math.min(
    Number(storedQuestions[0]?.deadlineAt) || openedAt + 30000, endsAt,
  );
  const attemptTx = await adminDb
    .ref(`practiceAttempts/${uid}/${attemptId}`)
    .transaction(
      (current) =>
        current || {
          templateId: "daily_mixed",
          mode: "dailyChallenge",
          categoryId: "",
          topicId: "",
          status: "active",
          startedAt: Number(slot.startedAt),
          questionCount: 5,
          correctCount: 0,
          answeredCount: 0,
          coinsAwarded: 0,
          currentIndex: 0,
          deadlineAt,
          requestId,
          createdAt: openedAt,
          updatedAt: openedAt,
        },
    );
  await enqueueLearningWork(uid, attemptId, deadlineAt);
  return readAttemptResponse(
    uid, attemptId, attemptTx.snapshot.val(), storedQuestions,
  );
}
