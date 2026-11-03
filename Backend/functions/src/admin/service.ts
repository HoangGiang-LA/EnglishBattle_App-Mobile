import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {createAdminRuntime} from "./runtime";
import {userReadHandlers, userOperationHandlers} from "./users";
import {readAdminCatalog, readAdminQuestion} from "./contentModel";
import {catalogOperationHandlers} from "./catalog";
import {questionOperationHandlers} from "./questions";
import {listAdminQuestions} from "./questionIndex";

export const adminRuntime = createAdminRuntime(adminAuth, adminDb, {
  ...userReadHandlers,
  adminGetCatalog: async () => ({catalog: await readAdminCatalog()}),
  adminGetQuestion: async (_actor, data) => ({question: await readAdminQuestion(String(data.id))}),
  adminListQuestions: async (actor, data) => ({
    page: await listAdminQuestions(actor.uid, data.query as Record<string, unknown>),
  }),
}, {...userOperationHandlers, ...catalogOperationHandlers, ...questionOperationHandlers});
