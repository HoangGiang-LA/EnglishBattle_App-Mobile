import {randomUUID} from "node:crypto";
import {Database} from "firebase-admin/database";
import {HttpsError} from "firebase-functions/v2/https";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {adminDb} from "../config/firebaseAdmin";
import {adminRange, Data} from "./contracts";
import {adminSnapshotPage, scanAdminTime} from "./pages";
import {safeAuditReason, normalizeAdminSearch as normalizeUserSearch} from "./shared";
import {ADMIN_POLICY as P} from "./policy";

/** Bracket create-once audit writes so a concurrent scan cannot claim a torn total. */
export async function writeAdminAudit(db: Database, id: string, entry: Data) {
  const ticket = randomUUID(); const ref = db.ref("adminAuditMeta");
  await transactionWithRetry(ref, (c) => ({...c, version: (c?.version || 0) + 1,
    writers: {...c?.writers, [ticket]: Date.now()}}));
  try {
    await transactionWithRetry(db.ref(`adminAudit/${id}`), (c) => c || {...entry,
      reason: safeAuditReason(entry.reason)});
  } finally {
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      const writers = {...c.writers}; delete writers[ticket];
      return {...c, writers, version: (c.version || 0) + 1};
    });
  }
}

export async function recoverAuditWriters(db: Database = adminDb) {
  await transactionWithRetry(db.ref("adminAuditMeta"), (c) => {
    if (!c) return c;
    const writers = {...c.writers};
    const old = Object.keys(writers).filter((id) => Number(writers[id]) < Date.now() - 90000);
    if (!old.length) return c;
    for (const id of old) delete writers[id];
    return {...c, writers, version: (c.version || 0) + 1};
  });
}

export function auditDto(row: Data): Data {
  return {id: row.id, operationId: row.operationId, actor: row.actor, action: row.action,
    target: row.target, at: row.at, reason: safeAuditReason(row.reason), result: row.result,
    ...(row.errorCode ? {errorCode: row.errorCode} : {})};
}

export async function listAdminAudit(uid: string, query: Data = {}) {
  const filters = {q: normalizeUserSearch(String(query.q || "")), actor: String(query.actor || ""),
    action: String(query.action || ""), target: String(query.target || ""), result: String(query.result || ""),
    range: query.range || null};
  return adminSnapshotPage("audit", uid, query, filters, async () => {
    const asOf = Date.now(); const range = query.range ? adminRange(query.range) :
      {from: asOf - P.auditMs, until: asOf + 1};
    const before = (await adminDb.ref("adminAuditMeta").get()).val();
    if (Object.keys(before?.writers || {}).length) throw new HttpsError("aborted", "Audit is updating.");
    const rows: Data[] = [];
    await scanAdminTime("adminAudit", range.from, Math.min(range.until, asOf + 1), (row) => {
      if (Number(row.expiresAt || 0) <= asOf) return;
      const dto = auditDto(row);
      if ((!filters.actor || dto.actor === filters.actor) && (!filters.action || dto.action === filters.action) &&
          (!filters.target || String(dto.target).includes(filters.target)) &&
          (!filters.result || dto.result === filters.result) && (!filters.q ||
            normalizeUserSearch([dto.actor, dto.action, dto.target, dto.reason].join(" ")).includes(filters.q))) rows.push(dto);
    });
    const after = (await adminDb.ref("adminAuditMeta").get()).val();
    if (Number(before?.version || 0) !== Number(after?.version || 0) || Object.keys(after?.writers || {}).length) {
      throw new HttpsError("aborted", "Audit changed. Retry this query.");
    }
    return {rows, asOf};
  });
}
