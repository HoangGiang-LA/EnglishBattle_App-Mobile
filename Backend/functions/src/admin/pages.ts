import {randomUUID} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {Data} from "./contracts";
import {ADMIN_POLICY as P} from "./policy";
import {adminKey} from "./shared";

export const adminScanLimits = {rows: 10000, bytes: 8 * 1024 * 1024, ms: 20000};
export const expiredSnapshot = () => new HttpsError("failed-precondition", "Refresh this list.", {
  reason: "snapshot-expired",
});

/** Time plus key cursor: equal timestamps cannot skip or repeat rows between source pages. */
export async function scanAdminTime(
  path: string, from: number, until: number, visit: (row: Data, id: string) => void,
) {
  let after: {at: number; id: string} | undefined;
  let count = 0; let bytes = 0; const deadline = Date.now() + adminScanLimits.ms;
  for (;;) {
    let query = adminDb.ref(path).orderByChild("at");
    query = after ? query.startAfter(after.at, after.id) : query.startAt(from);
    const batch = await query.endBefore(until).limitToFirst(100).get();
    batch.forEach((child) => {
      const value = child.val(); count++; bytes += Buffer.byteLength(JSON.stringify(value), "utf8");
      if (count > adminScanLimits.rows || bytes > adminScanLimits.bytes || Date.now() > deadline) {
        throw new HttpsError("resource-exhausted", "Narrow the query; the admin scan limit was exceeded.");
      }
      visit(value, child.key!); after = {id: child.key!, at: value.at};
    });
    if (batch.numChildren() < 100) break;
  }
}

interface Capture {rows: Data[]; asOf: number; extras?: Data}
/** Snapshots contain only whitelisted DTOs, and are bound to the actor, filters and read revision. */
export async function adminSnapshotPage(
  kind: string, uid: string, query: Data, filters: Data, capture: () => Promise<Capture>, stamp = "",
) {
  const page = Number(query.page || 1); const size = Number(query.pageSize || 10);
  const fingerprint = adminKey(kind, filters, size);
  let snapshotId = String(query.snapshotId || "");
  let stored: {uid: string; kind: string; fingerprint: string; rowsJson: string; stamp: string;
    expiresAt: number; asOf: number; extras?: Data};
  if (snapshotId) {
    stored = (await adminDb.ref(`adminSnapshots/${snapshotId}`).get()).val();
    if (!stored || stored.uid !== uid || stored.kind !== kind || stored.fingerprint !== fingerprint ||
        stored.stamp !== stamp || stored.expiresAt <= Date.now()) throw expiredSnapshot();
    if (query.cursor && query.cursor !== `${snapshotId}:${page}`) throw new HttpsError("invalid-argument", "Invalid cursor.");
  } else {
    if (page !== 1) throw new HttpsError("failed-precondition", "Load page one first.", {reason: "snapshot-required"});
    const result = await capture();
    result.rows.sort((a, b) => Number(b.at) - Number(a.at) || String(a.id).localeCompare(String(b.id), "en"));
    const rowsJson = JSON.stringify(result.rows);
    if (Buffer.byteLength(rowsJson, "utf8") > adminScanLimits.bytes) {
      throw new HttpsError("resource-exhausted", "This admin snapshot is too large.");
    }
    snapshotId = randomUUID();
    stored = {uid, kind, fingerprint, stamp, rowsJson, asOf: result.asOf,
      expiresAt: Date.now() + P.snapshotMs, extras: result.extras || {}};
    await adminDb.ref(`adminSnapshots/${snapshotId}`).set(stored);
  }
  const rows = JSON.parse(stored.rowsJson) as Data[];
  return {items: rows.slice((page - 1) * size, page * size), total: rows.length, page, pageSize: size,
    snapshotId, expiresAt: stored.expiresAt, nextCursor: page * size < rows.length ? `${snapshotId}:${page + 1}` : null,
    asOf: stored.asOf, ...stored.extras};
}
