import {enforceUserSession} from "../auth/userSession";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../../config/firebaseAdmin";
import {contentId} from "./contentValidation";
import {saveLearningSelection} from "./attemptState";
import {battleId, battleSession} from "../battle/battleAccess";
import {transactBattle} from "../battle/battleService";
import {battleNow} from "../battle/battleClock";

export const saveAttemptSelection = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  async (request) => {
    await enforceUserSession(request);
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const {attemptId, questionId, optionId, requestId} = request.data || {};
    if (!contentId(attemptId) || !contentId(questionId) ||
        !contentId(optionId) || typeof requestId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
      throw new HttpsError("invalid-argument", "Invalid selection request.");
    }
    const user = await adminAuth.getUser(uid);
    const access = (await adminDb.ref(`accountAccess/${uid}`).get()).val();
    if (user.disabled || access?.status !== "active") {
      throw new HttpsError("permission-denied", "This account is not active.");
    }
    if (battleId(attemptId)) {
      const {accepted} = await transactBattle(attemptId, {uid,
        sessionId: battleSession(request.data?.clientSessionId),
        action: {type: "select", questionId, optionId, requestId}});
      return {serverNow: battleNow(), accepted};
    }
    const accepted = await saveLearningSelection(
      uid, attemptId, questionId, optionId, requestId,
    );
    return {serverNow: Date.now(), accepted};
  },
);
