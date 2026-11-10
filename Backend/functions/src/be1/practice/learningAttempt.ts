import {HttpsError, onCall} from "firebase-functions/v2/https";
import {battleId} from "../battle/battleAccess";
import {handleStartAttempt} from "./startAttempt";
import {handleResumeAttempt} from "./resumeAttempt";
import {handleSaveAttemptSelection} from "./saveAttemptSelection";
import {handleSubmitAttemptAnswer} from "./submitAttemptAnswer";
import {handleAdvanceAttempt} from "./advanceAttempt";
import {handleGetAttemptResult} from "./getAttemptResult";
import {handleLeaveAttempt} from "./leaveAttempt";

const actions = {
  startAttempt: handleStartAttempt,
  resumeAttempt: handleResumeAttempt,
  saveAttemptSelection: handleSaveAttemptSelection,
  submitAttemptAnswer: handleSubmitAttemptAnswer,
  advanceAttempt: handleAdvanceAttempt,
  getAttemptResult: handleGetAttemptResult,
  leaveAttempt: handleLeaveAttempt,
};

// One callable lets successive quiz actions reuse the same warm runtime.
export const learningAttempt = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "You must sign in first.");
    }
    const {action, payload} = request.data || {};
    if (typeof action !== "string" ||
        !Object.prototype.hasOwnProperty.call(actions, action) ||
        !payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new HttpsError("invalid-argument", "Invalid learning action.");
    }
    if (typeof payload.attemptId === "string" && battleId(payload.attemptId)) {
      throw new HttpsError("invalid-argument", "Invalid learning attempt.");
    }
    return actions[action as keyof typeof actions]({...request, data: payload});
  },
);
