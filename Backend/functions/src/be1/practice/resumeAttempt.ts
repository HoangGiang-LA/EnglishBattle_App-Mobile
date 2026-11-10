import {requireActiveUserSession} from "../auth/userSession";
import {CallableRequest, onCall, HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {readAttemptResponse as buildAttemptResponse} from "./finalizeAttempt";
import {battleId, battleSession} from "../battle/battleAccess";
import {memberBattleResponse} from "../battle/battleService";

export const handleResumeAttempt =
  async (request: CallableRequest) => {
    // 1. Auth check
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "You must sign in first.");
    }

    const data = request.data as {attemptId?: string};
    const attemptId = data?.attemptId;

    // 2. Validate input
    if (
      !attemptId ||
      typeof attemptId !== "string" ||
      attemptId.trim().length === 0
    ) {
      throw new HttpsError("invalid-argument", "attemptId is required.");
    }

    try {
      // 3. Verify account is active
      await requireActiveUserSession(request);

      if (battleId(attemptId)) {
        return memberBattleResponse(uid, attemptId,
          battleSession(request.data?.clientSessionId), {type: "resume"});
      }
      // 4. Verify attempt existence and ownership
      const attemptSnap = await adminDb
        .ref(`practiceAttempts/${uid}/${attemptId}`)
        .get();

      if (!attemptSnap.exists()) {
        throw new HttpsError(
          "not-found",
          "Attempt not found or access denied.",
        );
      }

      const attemptData = attemptSnap.val() as Record<string, unknown>;

      // 5. Reconstruct response with stable questions and receipts
      return await buildAttemptResponse(uid, attemptId, attemptData);
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }

      console.error("resumeAttempt failed", {uid, attemptId, error});

      throw new HttpsError("internal", "Unable to resume attempt.");
    }
  };

export const resumeAttempt = onCall(
  {
    region: "asia-southeast1",
    maxInstances: 10,
  },
  handleResumeAttempt,
);
