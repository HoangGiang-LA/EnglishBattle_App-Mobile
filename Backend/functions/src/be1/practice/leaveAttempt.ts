import {enforceUserSession} from "../auth/userSession";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {battleId, battleSession} from "../battle/battleAccess";
import {memberBattleResponse} from "../battle/battleService";
import {adminAuth, adminDb} from "../../config/firebaseAdmin";
import {
  finalizeAttemptLogic,
  readAttemptResponse as buildAttemptResponse,
} from "./finalizeAttempt";

const REQUEST_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

export const leaveAttempt = onCall(
  {
    region: "asia-southeast1",
    maxInstances: 10,
  },
  async (request) => {
    await enforceUserSession(request);
    // 1. Auth check
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "You must sign in first.");
    }

    const {attemptId, requestId} = (request.data || {}) as {
      attemptId?: string;
      requestId?: string;
    };

    if (
      !attemptId ||
      typeof attemptId !== "string" ||
      attemptId.trim().length === 0
    ) {
      throw new HttpsError("invalid-argument", "attemptId is required.");
    }
    if (
      !requestId ||
      typeof requestId !== "string" ||
      !REQUEST_ID_REGEX.test(requestId)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "requestId is required and must match ^[A-Za-z0-9_-]{1,128}$",
      );
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
        return memberBattleResponse(uid, attemptId,
          battleSession(request.data?.clientSessionId), {type: "leave"});
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

      // If already finalized, return current attempt
      if (status === "completed" || status === "abandoned") {
        const res = await buildAttemptResponse(uid, attemptId, attemptData);
        return {
          serverNow: res.serverNow,
          attempt: res.attempt,
        };
      }

      // Finalize as abandoned (0 coins awarded, no stats/progress increments)
      const finalized = await finalizeAttemptLogic(uid, attemptId, "abandoned");
      return {
        serverNow: finalized.serverNow,
        attempt: finalized.attempt,
      };
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      console.error("leaveAttempt failed", {uid, attemptId, error});
      throw new HttpsError("internal", "Unable to leave attempt.");
    }
  },
);
