import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {createAdminRuntime} from "./runtime";
import {userReadHandlers, userOperationHandlers} from "./users";

export const adminRuntime = createAdminRuntime(adminAuth, adminDb, userReadHandlers, userOperationHandlers);
