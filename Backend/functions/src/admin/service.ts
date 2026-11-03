import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {createAdminRuntime} from "./runtime";
import {userReadHandlers, userOperationHandlers} from "./users";
import {readAdminCatalog, readAdminQuestion} from "./contentModel";
import {catalogOperationHandlers} from "./catalog";
import {questionOperationHandlers} from "./questions";
import {listAdminQuestions} from "./questionIndex";
import {getMonitoringBattle} from "./monitoringModel";
import {listMonitoring} from "./monitoringIndex";
import {getAdminOverview} from "./analytics";

export const adminRuntime = createAdminRuntime(adminAuth, adminDb, {
  ...userReadHandlers,
  adminGetOverview: async (_actor, data) => ({overview: await getAdminOverview(data)}),
  adminGetBattle: async (_actor, data) => ({detail: await getMonitoringBattle(String(data.id))}),
  adminListBattles: async (actor, data) => ({page: await listMonitoring("battles", actor.uid, data.query as Record<string, unknown>)}),
  adminListActivities: async (actor, data) => ({page: await listMonitoring("activities", actor.uid, data.query as Record<string, unknown>)}),
  adminGetCatalog: async () => ({catalog: await readAdminCatalog()}),
  adminGetQuestion: async (_actor, data) => ({question: await readAdminQuestion(String(data.id))}),
  adminListQuestions: async (actor, data) => ({
    page: await listAdminQuestions(actor.uid, data.query as Record<string, unknown>),
  }),
}, {...userOperationHandlers, ...catalogOperationHandlers, ...questionOperationHandlers});
