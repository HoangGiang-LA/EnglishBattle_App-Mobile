import {enforceUserSession} from "../auth/userSession";
import {CallableRequest, onCall, HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../../config/firebaseAdmin";
import {finalizeAttemptLogic} from "./finalizeAttempt";
import {isDailyExpired} from "./attemptHelper";
import {battleId, battleSession} from "../battle/battleAccess";
import {memberBattleResponse} from "../battle/battleService";

export const handleGetAttemptResult =
  async (request: CallableRequest) => {
    await enforceUserSession(request);
    // 1. Auth check
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "You must sign in first.");
    }

    const {attemptId} = (request.data || {}) as {attemptId?: string};
    if (
      !attemptId ||
      typeof attemptId !== "string" ||
      attemptId.trim().length === 0
    ) {
      throw new HttpsError("invalid-argument", "attemptId is required.");
    }

    try {
      // 2. Verify account is active
      const authUser = await adminAuth.getUser(uid);
      if (authUser.disabled) {
        throw new HttpsError(
          "permission-denied",
          "This account has been disabled.",
        );
      }

      const accessSnap = await adminDb.ref(`accountAccess/${uid}`).get();
      if (accessSnap.val()?.status !== "active") {
        throw new HttpsError(
          "permission-denied",
          "This account is not active.",
        );
      }

      if (battleId(attemptId)) {
        const {serverNow, attempt} = await memberBattleResponse(uid, attemptId,
          battleSession(request.data?.clientSessionId), {type: "heartbeat"});
        if (!attempt.result) {
          throw new HttpsError("failed-precondition", "Battle is active.");
        }
        return {serverNow, result: attempt.result};
      }
      // 3. Verify attempt existence and ownership
      const attemptRef = adminDb.ref(`practiceAttempts/${uid}/${attemptId}`);
      const attemptSnap = await attemptRef.get();

      if (!attemptSnap.exists()) {
        throw new HttpsError(
          "not-found",
          "Attempt not found or access denied.",
        );
      }

      const attemptData = attemptSnap.val() as Record<string, unknown>;
      const status = (attemptData.status as string) || "active";

      // 4. Finalize waiting attempts or replay existing terminal results.
      if (status === "waiting" || isDailyExpired(attemptData)) {
        const finalized = await finalizeAttemptLogic(
          uid,
          attemptId,
          "completed",
        );
        return {
          serverNow: finalized.serverNow,
          result: finalized.result,
        };
      }

      if (status === "completed" || status === "abandoned") {
        const res = await finalizeAttemptLogic(
          uid,
          attemptId,
          status === "completed" ? "completed" : "abandoned",
        );
        return {
          serverNow: res.serverNow,
          result: res.result,
        };
      }

      // Attempt is still active and has not reached the final question
      throw new HttpsError(
        "failed-precondition",
        "Attempt is still active and has not reached a final result.",
      );
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      console.error("getAttemptResult failed", {uid, attemptId, error});
      throw new HttpsError("internal", "Unable to get attempt result.");
    }
  };

export const getAttemptResult = onCall(
  {
    region: "asia-southeast1",
    maxInstances: 10,
  },
  handleGetAttemptResult,
);
