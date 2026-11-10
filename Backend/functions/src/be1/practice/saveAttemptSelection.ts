import {requireActiveUserSession} from "../auth/userSession";
import {CallableRequest, onCall, HttpsError} from "firebase-functions/v2/https";
import {contentId} from "./contentValidation";
import {saveLearningSelection} from "./attemptState";
import {battleId, battleSession} from "../battle/battleAccess";
import {transactBattle} from "../battle/battleService";
import {battleNow} from "../battle/battleClock";

export const handleSaveAttemptSelection =
  async (request: CallableRequest) => {
    const receivedAt = Date.now();
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const {attemptId, questionId, optionId, requestId} = request.data || {};
    if (!contentId(attemptId) || !contentId(questionId) ||
        !contentId(optionId) || typeof requestId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
      throw new HttpsError("invalid-argument", "Invalid selection request.");
    }
    await requireActiveUserSession(request);

    if (battleId(attemptId)) {
      const {accepted} = await transactBattle(attemptId, {uid,
        sessionId: battleSession(request.data?.clientSessionId),
        action: {type: "select", questionId, optionId, requestId}});
      return {serverNow: battleNow(), accepted};
    }
    const accepted = await saveLearningSelection(
      uid, attemptId, questionId, optionId, requestId, receivedAt,
    );
    return {serverNow: Date.now(), accepted};
  };

export const saveAttemptSelection = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  handleSaveAttemptSelection,
);
