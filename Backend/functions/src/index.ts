/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import {setGlobalOptions} from "firebase-functions";
// import {onRequest} from "firebase-functions/https";
// import * as logger from "firebase-functions/logger";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({maxInstances: 10});

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

export {ensureUserProfile} from "./be1/auth/ensureUserProfile";
export {getUserDashboard} from "./be1/user/getUserDashboard";
export {markNotificationsRead} from "./be1/user/markNotificationsRead";
export {getLeaderboard} from "./be1/community/getLeaderboard";
export {getNotifications} from "./be1/community/getNotifications";
export {maintainCommunity} from "./be1/community/communityMaintenance";
export {getStudyStatistics} from "./be1/reporting/getStudyStatistics";
export {getHistory} from "./be1/reporting/getHistory";
export {getCoinLedger} from "./be1/reporting/getCoinLedger";
export {maintainReporting} from "./be1/reporting/maintenance";
export {learningAttempt} from "./be1/practice/learningAttempt";
export {startAttempt} from "./be1/practice/startAttempt";
export {resumeAttempt} from "./be1/practice/resumeAttempt";
export {submitAttemptAnswer} from "./be1/practice/submitAttemptAnswer";
export {advanceAttempt} from "./be1/practice/advanceAttempt";
export {saveAttemptSelection} from "./be1/practice/saveAttemptSelection";
export {getAttemptResult} from "./be1/practice/getAttemptResult";
export {leaveAttempt} from "./be1/practice/leaveAttempt";
export {expireDailyAttempts} from "./be1/practice/expireDailyAttempts";
export {maintainLearningAttempts} from "./be1/practice/learningMaintenance";
export {
  findBattle, getBattleTicket, cancelBattleSearch,
} from "./be1/battle/battleCallables";
export {maintainBattles} from "./be1/battle/battleMaintenance";
export * from "./admin/callables";
export {maintainAdmin} from "./admin/maintenance";
