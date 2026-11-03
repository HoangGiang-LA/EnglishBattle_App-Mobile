import {createHash, randomUUID} from "node:crypto";
import {Auth} from "firebase-admin/auth";
import {Database} from "firebase-admin/database";
import {CallableRequest, HttpsError} from "firebase-functions/v2/https";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {AdminAction, Data, isOperation, validateAdminRequest, validateAdminResponse} from "./contracts";
import {AdminActor, requireAdmin} from "./guard";
import {AdminOperations, OperationHandlers} from "./operations";
import {ADMIN_POLICY as P} from "./policy";

export type ReadHandlers = Partial<Record<AdminAction, (actor: AdminActor, data: Data) => Promise<Data>>>;

/** Shared distributed rate budget across all instances, separately for exports. */
export async function consumeAdminRate(db: Database, uid: string, action: AdminAction): Promise<void> {
  const group = action === "adminExportReport" ? "export" : isOperation(action) ? "write" : "read";
  const limit = group === "export" ? P.exportsPerMinute : group === "write" ? P.writesPerMinute : P.readsPerMinute;
  const minute = Math.floor(Date.now() / 60000);
  const ticket = randomUUID();
  const key = createHash("sha256").update(JSON.stringify([uid, group, minute])).digest("hex");
  const tx = await transactionWithRetry(db.ref(`adminRateLimits/${key}`), (current) => {
    if ((current?.count || 0) >= limit) return current;
    return {count: (current?.count || 0) + 1, ticket, minute, expiresAt: Date.now() + P.rateDataMs};
  });
  if (tx.snapshot.val().ticket !== ticket) {
    throw new HttpsError("resource-exhausted", "Admin request limit reached.", {
      reason: "rate-limited", retryAfterMs: (minute + 1) * 60000 - Date.now(),
    });
  }
}

/** Only this dispatcher is exported as callables; handlers cannot bypass guards. */
export function createAdminRuntime(auth: Auth, db: Database, reads: ReadHandlers = {}, writes: OperationHandlers = {}) {
  const operations = new AdminOperations(auth, db, writes);
  return {
    operations,
    async invoke(action: AdminAction, request: CallableRequest): Promise<Data> {
      try {
        const actor = await requireAdmin(request, auth, db);
        const data = validateAdminRequest(action, request.data);
        await consumeAdminRate(db, actor.uid, action);
        if (action === "adminSetUserStatus" && data.id === actor.uid && data.status !== "active") {
          throw new HttpsError("failed-precondition", "Administrators cannot block their own account.", {
            reason: "admin-self-protection",
          });
        }
        if (isOperation(action)) return await operations.execute(action, actor, data);
        const handler = reads[action];
        if (!handler) throw new HttpsError("unimplemented", "This admin API is not implemented yet.");
        const response = {...await handler(actor, data), serverNow: Date.now()};
        validateAdminResponse(action, response);
        return response;
      } catch (error) {
        if (error instanceof HttpsError) throw error;
        // Do not log errors, request bodies, email links or credentials here.
        throw new HttpsError("unavailable", "The admin service is temporarily unavailable.");
      }
    },
  };
}
