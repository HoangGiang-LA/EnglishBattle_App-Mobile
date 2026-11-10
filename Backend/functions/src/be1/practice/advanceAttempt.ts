import {requireActiveUserSession} from "../auth/userSession";
import {CallableRequest, onCall, HttpsError} from "firebase-functions/v2/https";
import {contentId} from "./contentValidation";
import {advanceLearningAttempt} from "./attemptState";
import {readAttemptResponse} from "./finalizeAttempt";
import {battleId, battleSession} from "../battle/battleAccess";
import {memberBattleResponse} from "../battle/battleService";

export const handleAdvanceAttempt =
  async (request: CallableRequest) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "You must sign in first.");
    }
    const {attemptId, requestId, expectedIndex} = request.data || {};
    if (
      !contentId(attemptId) ||
      typeof requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
      (expectedIndex !== undefined &&
        (!Number.isInteger(expectedIndex) ||
          expectedIndex < 0 ||
          expectedIndex > 19))
    ) {
      throw new HttpsError("invalid-argument", "Invalid advance request.");
    }
    await requireActiveUserSession(request);

    if (battleId(attemptId)) {
      return memberBattleResponse(uid, attemptId,
        battleSession(request.data?.clientSessionId),
        {type: "advance", requestId});
    }
    const {attempt, questions} = await advanceLearningAttempt(
      uid,
      attemptId,
      requestId,
      expectedIndex,
    );
    return readAttemptResponse(uid, attemptId, attempt, questions);
  };

export const advanceAttempt = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  handleAdvanceAttempt,
);
