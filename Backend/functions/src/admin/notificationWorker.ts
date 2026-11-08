import {randomUUID} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {Data} from "./contracts";
import {ADMIN_POLICY as P} from "./policy";
import {adminKey} from "./shared";

interface Notice {id: string; title: string; body: string; page: string; at: number}
export async function publishAdminNotice(event: Notice) {
  if (event.at < Date.now() - P.notificationMs || event.at > Date.now()) return;
  const ref = adminDb.ref(`adminNotificationEvents/${event.id}`);
  if ((await ref.get()).exists()) return;
  const meta = adminDb.ref("adminNotificationMeta"); const ticket = randomUUID();
  await transactionWithRetry(meta, (c) => ({...c, version: (c?.version || 0) + 1,
    writers: {...c?.writers, [ticket]: Date.now()}}));
  try {
    await transactionWithRetry(ref, (c) => c || {...event, publishedAt: Date.now(),
      expiresAt: event.at + P.notificationMs});
  } finally {
    await transactionWithRetry(meta, (c) => {
      if (!c) return c;
      const writers = {...c.writers}; delete writers[ticket];
      return {...c, writers, version: (c.version || 0) + 1};
    });
  }
}

function sourceNotice(kind: string, row: Data): Notice | null {
  const at = Number(row.at);
  if (!Number.isSafeInteger(at) || at <= 0) throw new HttpsError("failed-precondition", "Invalid notification source.");
  if (kind === "audit") {
    if (row.action === "adminMarkNotificationsRead") return null;
    const action = /^(admin[A-Za-z]+|serverGrantAdmin|serverRevokeAdmin)$/.test(String(row.action)) ?
      String(row.action) : "Administrative action";
    if (!["succeeded", "failed", "blocked"].includes(String(row.result))) {
      throw new HttpsError("failed-precondition", "Invalid audit notification source.");
    }
    const page = /Question|Content/.test(action) ? "content" : action === "adminExportReport" ? "analytics" : "users";
    return {id: `notice_${adminKey("audit", row.id)}`, at, page,
      title: row.result === "blocked" ? "Admin operation needs review" :
        row.result === "failed" ? "Admin operation rejected" : "Admin change recorded",
      body: `${action} · ${String(row.result)}`};
  }
  const type = String(row.type);
  if (!["user", "lesson", "battle"].includes(type) || !row.sourceId || !row.userId) {
    throw new HttpsError("failed-precondition", "Invalid notification activity.");
  }
  return {id: `notice_${adminKey(type, type === "battle" ? "" : row.userId, row.sourceId)}`, at,
    page: type === "user" ? "users" : type === "battle" ? "battles" : "analytics",
    title: type === "user" ? "New account registered" : type === "battle" ? "Battle result available" :
      row.completed ? "Learning session completed" : "Learning session ended",
    body: type === "user" ? "A Firebase user account was registered." : type === "battle" ?
      "A quick battle has a recorded result." : "A learning session has a recorded outcome."};
}

/** Repeatable paged discovery; event identities survive settlement, backfill and worker retries. */
export async function runAdminNotificationMaintenance() {
  const ref = adminDb.ref("adminNotificationControl"); const owner = randomUUID();
  const lease = await transactionWithRetry(ref, (c) => {
    if (c?.leaseUntil > Date.now() || c?.nextRunAt > Date.now()) return;
    const fresh = !c?.phase || c.owner;
    return {...c, ...(fresh ? {phase: "activities", afterAt: null, afterId: null,
      scanStartedAt: Date.now(), scanned: 0} : {}), owner, leaseUntil: Date.now() + 90000};
  });
  if (!lease.committed) return;
  let state = lease.snapshot.val();
  try {
    const source = (await adminDb.ref("adminMonitoringControl/activities").get()).val();
    if (!source?.ready) throw new HttpsError("failed-precondition", "Activity discovery is not ready.");
    await transactionWithRetry(adminDb.ref("adminNotificationMeta"), (c) => {
      const writers = {...c?.writers};
      const stale = Object.keys(writers).filter((id) => Number(writers[id]) < Date.now() - 90000);
      for (const id of stale) delete writers[id];
      return {...c, writers, version: (c?.version || 0) + (stale.length ? 1 : 0)};
    });
    for (let n = 0; n < 2; n++) {
      const kind = state.phase;
      let query = adminDb.ref(kind === "activities" ? "adminActivityIndex" : "adminAudit").orderByChild("at");
      query = state.afterId ? query.startAfter(state.afterAt, state.afterId) :
        query.startAt(state.scanStartedAt - P.notificationMs);
      const batch = await query.endAt(state.scanStartedAt).limitToFirst(25).get();
      const rows: Data[] = [];
      batch.forEach((child) => {
        rows.push({...child.val(), id: child.key!});
      });
      for (const row of rows) {
        const renewed = await transactionWithRetry(ref, (c) => {
          if (!c) return c;
          if (c.owner !== owner || c.leaseUntil <= Date.now()) return;
          return {...c, leaseUntil: Date.now() + 90000};
        });
        if (!renewed.committed) throw new HttpsError("aborted", "Notification lease lost.");
        const notice = sourceNotice(kind, row);
        if (notice) await publishAdminNotice(notice);
      }
      state = {...state, scanned: state.scanned + rows.length};
      if (state.scanned > 10000) throw new HttpsError("resource-exhausted", "Notification discovery exceeds 10,000 events.");
      const finished = rows.length < 25 && kind === "audit";
      const last = rows[rows.length - 1];
      state = {...state, ...(rows.length < 25 ? {phase: finished ? null : "audit", afterAt: null, afterId: null,
        scanned: 0} : {afterAt: last.at, afterId: last.id})};
      const saved = await transactionWithRetry(ref, (c) => {
        if (!c) return c;
        if (c.owner !== owner || c.leaseUntil <= Date.now()) return;
        return {...state, owner, leaseUntil: Date.now() + 90000,
          ...(finished ? {ready: true, asOf: state.scanStartedAt} : {})};
      });
      if (!saved.committed) throw new HttpsError("aborted", "Notification lease lost.");
      if (finished) break;
    }
    const expired = await adminDb.ref("adminNotificationEvents").orderByChild("expiresAt")
      .startAt(0).endAt(Date.now()).limitToFirst(P.maintenanceBatch).get();
    const ids: string[] = [];
    expired.forEach((child) => {
      ids.push(child.key!);
    });
    for (const id of ids) await adminDb.ref(`adminNotificationEvents/${id}`).remove();
    let inboxQuery = adminDb.ref("adminNotificationInboxes").orderByKey();
    if (state.cleanupAfter) inboxQuery = inboxQuery.startAfter(state.cleanupAfter);
    const inboxes = await inboxQuery.limitToFirst(5).get();
    const inboxIds: string[] = [];
    inboxes.forEach((child) => {
      inboxIds.push(child.key!);
    });
    for (const uid of inboxIds) {
      await transactionWithRetry(adminDb.ref(`adminNotificationInboxes/${uid}`), (c) => {
        if (!c) return c;
        const reads = {...c.reads}; let changed = false;
        for (const [id, raw] of Object.entries(reads)) {
          if (Number((raw as Data).expiresAt) <= Date.now()) {
            delete reads[id]; changed = true;
          }
        }
        return changed ? {...c, reads, revision: Number(c.revision || 0) + 1} : c;
      });
    }
    await transactionWithRetry(ref, (c) => !c ? c : c.owner !== owner ? undefined : {...c,
      cleanupAfter: inboxIds.length === 5 ? inboxIds[inboxIds.length - 1] : null});
  } finally {
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner) return;
      return {...c, owner: null, leaseUntil: null, nextRunAt: Date.now() + (c.phase ? 1000 : 10000)};
    });
  }
}
