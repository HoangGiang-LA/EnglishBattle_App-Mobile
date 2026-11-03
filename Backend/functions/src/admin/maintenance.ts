import {Database} from "firebase-admin/database";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {HttpsError} from "firebase-functions/v2/https";
import {randomUUID} from "node:crypto";
import {adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {AdminOperations} from "./operations";
import {ADMIN_POLICY as P} from "./policy";
import {adminRuntime} from "./service";
import {runUserIndexMaintenance} from "./userIndex";
import {runInvitationMaintenance} from "./invitations";
import {runRoleMaintenance} from "./roles";
import {runQuestionIndexMaintenance} from "./questionIndex";

/** Bounded due-index recovery, with an independent lease for housekeeping. */
export async function runAdminMaintenance(
  db: Database = adminDb, operations: AdminOperations = adminRuntime.operations,
) {
  const owner = randomUUID();
  const leaseRef = db.ref("adminMaintenance/cleanup");
  const lease = await transactionWithRetry(leaseRef, (current) => {
    if (current?.leaseUntil > Date.now() || current?.nextRunAt > Date.now()) return;
    return {...current, owner, leaseUntil: Date.now() + P.leaseMs};
  });
  if (!lease.committed) return;
  try {
    // Isolated tasks: an email/index failure must not starve operation recovery.
    const projections = await Promise.allSettled([
      runUserIndexMaintenance(), runInvitationMaintenance(), runRoleMaintenance(db), runQuestionIndexMaintenance(),
    ]);
    for (const result of projections) {
      if (result.status === "rejected") console.warn("Admin projection deferred", {code: "unavailable"});
    }
    const due = await db.ref("adminOperations").orderByChild("dueAt")
      .startAt(0).endAt(Date.now()).limitToFirst(P.maintenanceBatch).get();
    const ids: string[] = [];
    due.forEach((child) => {
      ids.push(child.key!);
    });
    for (const id of ids) {
      try {
        await operations.process(id);
      } catch (error) {
        // Log only fixed codes and opaque IDs; never an exception or payload.
        console.warn("Admin operation deferred", {id,
          code: error instanceof HttpsError ? error.code : "unavailable"});
      }
    }

    for (const [path, index] of [
      ["adminSnapshots", "expiresAt"], ["adminReports", "expiresAt"],
      ["adminRateLimits", "expiresAt"], ["adminAudit", "expiresAt"],
    ]) {
      const expired = await db.ref(path).orderByChild(index)
        .startAt(0).endAt(Date.now()).limitToFirst(P.maintenanceBatch).get();
      const keys: string[] = [];
      expired.forEach((child) => {
        keys.push(child.key!);
      });
      for (const key of keys) {
        // Recheck expiry inside the transaction: never delete a refreshed snapshot.
        await transactionWithRetry(db.ref(`${path}/${key}`), (current) => {
          if (!current) return current;
          if (current && current[index] <= Date.now()) return null;
          return;
        });
      }
    }
    const old = await db.ref("adminOperations").orderByChild("cleanupAt")
      .startAt(0).endAt(Date.now()).limitToFirst(P.maintenanceBatch).get();
    const keys: string[] = [];
    old.forEach((child) => {
      keys.push(child.key!);
    });
    for (const key of keys) {
      await transactionWithRetry(db.ref(`adminOperations/${key}`), (current) => {
        if (!current) return current;
        if (!["succeeded", "failed"].includes(current.phase) ||
            !current.cleanupAt || current.cleanupAt > Date.now()) return;
        // Keep permanent deduplication tombstones. Never reuse a requestId.
        return {
          id: current.id, actor: current.actor, action: current.action,
          fingerprint: current.fingerprint, handlerVersion: current.handlerVersion,
          target: current.target, phase: current.phase, createdAt: current.createdAt,
          completedAt: current.completedAt, compacted: true,
        };
      });
    }
    for (const path of ["adminRoleOperations", "adminInvitations"]) {
      const expired = await db.ref(path).orderByChild("cleanupAt").startAt(0).endAt(Date.now())
        .limitToFirst(P.maintenanceBatch).get();
      const ids: string[] = [];
      expired.forEach((child) => {
        ids.push(child.key!);
      });
      for (const id of ids) {
        await transactionWithRetry(db.ref(`${path}/${id}`), (c) => {
          if (!c) return c;
          if (!c.cleanupAt || c.cleanupAt > Date.now()) return;
          if (path === "adminInvitations") {
            if (!["sent", "failed", "unknown"].includes(c.status)) return;
            return {uid: c.uid, operationId: c.operationId, status: c.status,
              createdAt: c.createdAt, completedAt: c.completedAt};
          }
          if (!["succeeded", "failed"].includes(c.phase)) return;
          return {id: c.id, uid: c.uid, action: c.action, requestId: c.requestId,
            phase: c.phase, fingerprint: c.fingerprint, createdAt: c.createdAt,
            completedAt: c.completedAt, errorCode: c.errorCode || null, compacted: true};
        });
      }
    }
  } finally {
    await transactionWithRetry(leaseRef, (current) => !current ? null : current.owner === owner ?
      {nextRunAt: Date.now() + 10000} : undefined);
  }
}

export const maintainAdmin = onSchedule({
  region: P.region, schedule: "every 1 minutes", timeZone: P.timeZone, maxInstances: 1,
}, () => runAdminMaintenance());
