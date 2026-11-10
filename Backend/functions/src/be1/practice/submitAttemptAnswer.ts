import {requireActiveUserSession} from "../auth/userSession";
import {CallableRequest, onCall, HttpsError} from "firebase-functions/v2/https";
import {contentId} from "./contentValidation";
import {submitLearningAnswer} from "./attemptState";
import {readAttemptResponse} from "./finalizeAttempt";
import {battleId, battleSession} from "../battle/battleAccess";
import {memberBattleResponse} from "../battle/battleService";

export const handleSubmitAttemptAnswer =
  async (request: CallableRequest) => {
    const receivedAt = Date.now();
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "You must sign in first.");
    }
    const {
      attemptId,
      questionId,
      optionId = null,
      requestId,
    } = request.data || {};
    if (
      !contentId(attemptId) ||
      !contentId(questionId) ||
      (optionId !== null && !contentId(optionId)) ||
      typeof requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
    ) {
      throw new HttpsError("invalid-argument", "Invalid answer request.");
    }
    await requireActiveUserSession(request);

    if (battleId(attemptId)) {
      return memberBattleResponse(uid, attemptId,
        battleSession(request.data?.clientSessionId),
        {type: "submit", questionId, optionId, requestId});
    }
    const {attempt, questions} = await submitLearningAnswer(
      uid,
      attemptId,
      questionId,
      optionId,
      requestId,
      receivedAt,
    );
    return readAttemptResponse(uid, attemptId, attempt, questions);
  };

export const submitAttemptAnswer = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  handleSubmitAttemptAnswer,
);
