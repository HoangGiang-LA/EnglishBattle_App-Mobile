import {onCall} from "firebase-functions/v2/https";
import {AdminAction} from "./contracts";
import {ADMIN_POLICY} from "./policy";
import {adminRuntime} from "./service";

const callable = (action: AdminAction) => onCall({
  region: ADMIN_POLICY.region,
  maxInstances: 10,
  timeoutSeconds: 60,
}, (request) => adminRuntime.invoke(action, request));

export const adminGetProfile = callable("adminGetProfile");
export const adminUpdateProfile = callable("adminUpdateProfile");
export const adminGetOverview = callable("adminGetOverview");
export const adminListUsers = callable("adminListUsers");
export const adminGetUser = callable("adminGetUser");
export const adminSaveUser = callable("adminSaveUser");
export const adminSetUserStatus = callable("adminSetUserStatus");
export const adminGetCatalog = callable("adminGetCatalog");
export const adminSaveContent = callable("adminSaveContent");
export const adminListQuestions = callable("adminListQuestions");
export const adminGetQuestion = callable("adminGetQuestion");
export const adminSaveQuestion = callable("adminSaveQuestion");
export const adminArchiveQuestion = callable("adminArchiveQuestion");
export const adminListBattles = callable("adminListBattles");
export const adminGetBattle = callable("adminGetBattle");
export const adminListActivities = callable("adminListActivities");
export const adminSearch = callable("adminSearch");
export const adminListNotifications = callable("adminListNotifications");
export const adminMarkNotificationsRead = callable("adminMarkNotificationsRead");
export const adminListAudit = callable("adminListAudit");
export const adminExportReport = callable("adminExportReport");
