import {createHash, randomUUID} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {Data} from "./contracts";
import {canonicalJson} from "./operations";
import {readAdminQuestion} from "./contentModel";
import {ADMIN_POLICY as P} from "./policy";

export const questionSearch = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[đĐ]/g, "d").toLowerCase().trim();

export async function syncAdminQuestionIndex(id: string): Promise<void> {
  const meta = adminDb.ref("adminQuestionIndexMeta");
  const ticket = randomUUID();
  await transactionWithRetry(meta, (c) => ({...c, version: (c?.version || 0) + 1,
    writers: {...c?.writers, [ticket]: {startedAt: Date.now(), id}}}));
  try {
    const question = await readAdminQuestion(id);
    await transactionWithRetry(adminDb.ref(`adminQuestionIndex/${id}`), (c) => {
      if (c?.version > Number(question.version)) return c;
      return {...question, searchKey: questionSearch(`${id} ${question.code} ${question.prompt}`)};
    });
  } finally {
    await transactionWithRetry(meta, (c) => {
      if (!c) return c;
      const writers = {...c.writers}; delete writers[ticket];
      return {...c, writers, version: (c.version || 0) + 1, asOf: Date.now()};
    });
  }
}

/** Paged checkpointed backfill. Malformed source data prevents claiming an exact total. */
export async function runQuestionIndexMaintenance(): Promise<void> {
  const ref = adminDb.ref("adminQuestionIndexControl");
  const owner = randomUUID();
  const lease = await transactionWithRetry(ref, (c) => {
    if (c?.leaseUntil > Date.now() || c?.nextRunAt > Date.now()) return;
    return {...c, owner, leaseUntil: Date.now() + 90000};
  });
  if (!lease.committed) return;
  const state = lease.snapshot.val();
  try {
    const metaRef = adminDb.ref("adminQuestionIndexMeta");
    const recovery = await transactionWithRetry(metaRef, (c) => {
      if (!c) return c;
      const writers = {...c.writers};
      const stale = Object.keys(writers).filter((key) => writers[key].startedAt < Date.now() - 90000);
      if (!stale.length) return c;
      for (const key of stale) delete writers[key];
      return {...c, writers, ready: false, version: (c.version || 0) + 1, rebuildEpoch: (c.rebuildEpoch || 0) + 1};
    });
    const epoch = Number(recovery.snapshot.val()?.rebuildEpoch || 0);
    if (Number(state.rebuildEpoch || 0) !== epoch) state.after = null;
    let query = adminDb.ref("questions").orderByKey();
    if (state.after) query = query.startAfter(state.after);
    const page = await query.limitToFirst(50).get();
    const ids: string[] = [];
    page.forEach((child) => {
      ids.push(child.key!);
    });
    for (let offset = 0; offset < ids.length; offset += 5) {
      const results = await Promise.allSettled(ids.slice(offset, offset + 5).map(syncAdminQuestionIndex));
      const failure = results.find((r) => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    if (ids.length < 50) {
      await transactionWithRetry(metaRef, (c) => ({...c, ready: true, asOf: Date.now()}));
    }
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner) return;
      return {rebuildEpoch: epoch, after: ids.length === 50 ? ids[ids.length - 1] : null,
        nextRunAt: Date.now() + (ids.length === 50 ? 1000 : 10000)};
    });
  } catch (error) {
    await adminDb.ref("adminQuestionIndexMeta/ready").set(false);
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner) return;
      return {...c, owner: null, leaseUntil: null, nextRunAt: Date.now() + 2000};
    });
    throw error;
  }
}

export async function listAdminQuestions(uid: string, query: Data) {
  const page = Number(query.page || 1); const size = Number(query.pageSize || 10);
  const filters = {q: questionSearch(String(query.q || "")), categoryId: String(query.categoryId || ""),
    difficulty: String(query.difficulty || ""), status: String(query.status || ""), pageSize: size};
  const fingerprint = createHash("sha256").update(canonicalJson(["questions", filters])).digest("hex");
  let snapshotId = query.snapshotId as string | undefined;
  let stored: {uid: string; fingerprint: string; kind: string; rowsJson: string; expiresAt: number};
  if (snapshotId) {
    stored = (await adminDb.ref(`adminSnapshots/${snapshotId}`).get()).val();
    if (!stored || stored.kind !== "questions" || stored.uid !== uid || stored.fingerprint !== fingerprint ||
        stored.expiresAt <= Date.now()) throw new HttpsError("failed-precondition", "Refresh questions.", {reason: "snapshot-expired"});
    if (query.cursor && query.cursor !== `${snapshotId}:${page}`) throw new HttpsError("invalid-argument", "Cursor mismatch.");
  } else {
    if (page !== 1) throw new HttpsError("failed-precondition", "Load page one first.", {reason: "snapshot-required"});
    const before = (await adminDb.ref("adminQuestionIndexMeta").get()).val();
    if (!before?.ready) throw new HttpsError("failed-precondition", "Question index is being built.", {reason: "question-index-not-ready"});
    if (Object.keys(before.writers || {}).length) throw new HttpsError("aborted", "Question index is updating.");
    const rows: Data[] = [];
    let after: string | undefined; let scanned = 0; let bytes = 2;
    for (let batchNumber = 0; batchNumber <= 100; batchNumber++) {
      let source = adminDb.ref("adminQuestionIndex").orderByKey();
      if (after) source = source.startAfter(after);
      const batch = await source.limitToFirst(100).get();
      batch.forEach((child) => {
        scanned++; after = child.key!;
        const row = child.val();
        if ((!filters.q || row.searchKey.includes(filters.q)) &&
            (!filters.status || row.status === filters.status) &&
            (!filters.categoryId || row.categoryId === filters.categoryId) &&
            (!filters.difficulty || row.difficulty === filters.difficulty)) {
          const {searchKey: unused, ...dto} = row; void unused;
          bytes += Buffer.byteLength(JSON.stringify(dto), "utf8") + 1;
          if (bytes > 8 * 1024 * 1024) throw new HttpsError("resource-exhausted", "Question snapshot exceeds 8 MiB.");
          rows.push(dto);
        }
      });
      if (scanned > 10000) throw new HttpsError("resource-exhausted", "Question scan exceeds 10,000 records.");
      if (batch.numChildren() < 100) break;
    }
    const end = (await adminDb.ref("adminQuestionIndexMeta").get()).val();
    if (!end?.ready || end.version !== before.version || Object.keys(end.writers || {}).length) {
      throw new HttpsError("aborted", "Question index changed. Retry this query.");
    }
    rows.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt) ||
      (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    const rowsJson = JSON.stringify(rows);
    snapshotId = randomUUID();
    stored = {uid, fingerprint, kind: "questions", rowsJson, expiresAt: Date.now() + P.snapshotMs};
    await adminDb.ref(`adminSnapshots/${snapshotId}`).set(stored);
  }
  const rows = JSON.parse(stored.rowsJson) as Data[];
  return {items: rows.slice((page - 1) * size, page * size), total: rows.length, page, pageSize: size,
    snapshotId, expiresAt: stored.expiresAt,
    nextCursor: page * size < rows.length ? `${snapshotId}:${page + 1}` : null};
}
