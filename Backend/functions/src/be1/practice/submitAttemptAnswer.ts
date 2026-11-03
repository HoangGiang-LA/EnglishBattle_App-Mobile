import {enforceUserSession} from "../auth/userSession";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../../config/firebaseAdmin";
import {contentId} from "./contentValidation";
import {submitLearningAnswer} from "./attemptState";
import {readAttemptResponse} from "./finalizeAttempt";
import {battleId, battleSession} from "../battle/battleAccess";
import {memberBattleResponse} from "../battle/battleService";

export const submitAttemptAnswer = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  async (request) => {
    await enforceUserSession(request);
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
    const authUser = await adminAuth.getUser(uid);
    const access = (await adminDb.ref(`accountAccess/${uid}`).get()).val();
    if (authUser.disabled || access?.status !== "active") {
      throw new HttpsError(
        "permission-denied",
        "This account is not active.",
      );
    }
    if (battleId(attemptId)) {
      return memberBattleResponse(uid, attemptId,
        battleSession(request.data?.clientSessionId),
        {type: "submit", questionId, optionId, requestId});
    }
    const attempt = await submitLearningAnswer(
      uid,
      attemptId,
      questionId,
      optionId,
      requestId,
    );
    return readAttemptResponse(uid, attemptId, attempt);
  },
);
