import {createHash, randomUUID} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {canonicalJson} from "./operations";
import {Data} from "./contracts";
import {ADMIN_POLICY as P} from "./policy";
import {readAdminUser, UserDto} from "./userModel";

export const normalizeUserSearch = (value: string) => value.normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase().trim();

/** Writers bracket each row change so a paged scan cannot publish a torn snapshot. */
export async function syncAdminUserIndex(uid: string, privacyChange = false): Promise<void> {
  const ticket = randomUUID();
  const meta = adminDb.ref("adminUserIndexMeta");
  await transactionWithRetry(meta, (c) => ({...c, version: (c?.version || 0) + 1,
    writers: {...c?.writers, [ticket]: {uid, startedAt: Date.now()}}}));
  try {
    let row: UserDto | null;
    try {
      row = await readAdminUser(uid, true);
    } catch (error) {
      if (!(error instanceof HttpsError) || error.code !== "not-found") throw error;
      row = null;
    }
    await transactionWithRetry(adminDb.ref(`adminUserIndex/${uid}`), (current) => {
      if (!row) return null;
      if (current && current.revision > row.revision) return current;
      return {...row, searchKey: normalizeUserSearch(`${row.id} ${row.code} ${row.name} ${row.email}`)};
    });
  } finally {
    await transactionWithRetry(meta, (c) => {
      if (!c) return c;
      const writers = {...c.writers};
      delete writers[ticket];
      return {...c, writers, version: (c.version || 0) + 1, asOf: Date.now(),
        privacyRevision: (c.privacyRevision || 0) + (privacyChange ? 1 : 0)};
    });
  }
}

/** Auth is paged, not inferred from the latest 50 RTDB profiles. */
export async function runUserIndexMaintenance(): Promise<void> {
  const ref = adminDb.ref("adminUserIndexControl");
  const owner = randomUUID();
  const lease = await transactionWithRetry(ref, (c) => {
    if (c?.leaseUntil > Date.now() || c?.nextRunAt > Date.now()) return;
    return {...c, owner, leaseUntil: Date.now() + 90000};
  });
  if (!lease.committed) return;
  const state = lease.snapshot.val();
  try {
    const metaRef = adminDb.ref("adminUserIndexMeta");
    const recovery = await transactionWithRetry(metaRef, (c) => {
      if (!c) return c;
      const writers = {...c.writers};
      const stale = Object.keys(writers).filter((key) => writers[key].startedAt < Date.now() - 90000);
      if (!stale.length) return c;
      for (const key of stale) delete writers[key];
      return {...c, writers, ready: false, version: (c.version || 0) + 1, rebuildEpoch: (c.rebuildEpoch || 0) + 1};
    });
    const rebuildEpoch = Number(recovery.snapshot.val()?.rebuildEpoch || 0);
    if (Number(state.rebuildEpoch || 0) !== rebuildEpoch) state.pageToken = null;
    const page = await adminAuth.listUsers(50, state.pageToken || undefined);
    for (let offset = 0; offset < page.users.length; offset += 5) {
      const results = await Promise.allSettled(
        page.users.slice(offset, offset + 5).map((u) => syncAdminUserIndex(u.uid)),
      );
      const failure = results.find((r) => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    if (!page.pageToken) {
      await transactionWithRetry(adminDb.ref("adminUserIndexMeta"), (c) => ({...c, ready: true, asOf: Date.now()}));
    }
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner) return;
      return {rebuildEpoch, pageToken: page.pageToken || null,
        nextRunAt: Date.now() + (page.pageToken ? 1000 : 10000)};
    });
  } catch (error) {
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner) return;
      return {...c, owner: null, leaseUntil: null, nextRunAt: Date.now() + 2000};
    });
    throw error;
  }
}

export async function listAdminUsers(actorUid: string, query: Data) {
  const page = Number(query.page || 1);
  const size = Number(query.pageSize || 10);
  const filters = {q: normalizeUserSearch(String(query.q || "")), status: String(query.status || ""), pageSize: size};
  const fingerprint = createHash("sha256").update(canonicalJson(filters)).digest("hex");
  const before = (await adminDb.ref("adminUserIndexMeta").get()).val();
  let snapshotId = query.snapshotId as string | undefined;
  let stored: {uid: string; fingerprint: string; rowsJson: string; expiresAt: number; privacyRevision: number};
  if (snapshotId) {
    stored = (await adminDb.ref(`adminSnapshots/${snapshotId}`).get()).val();
    if (!stored || stored.uid !== actorUid || stored.fingerprint !== fingerprint ||
        stored.expiresAt <= Date.now() || stored.privacyRevision !== Number(before?.privacyRevision || 0)) {
      throw new HttpsError("failed-precondition", "Refresh the user list.", {reason: "snapshot-expired"});
    }
    if (query.cursor && query.cursor !== `${snapshotId}:${page}`) {
      throw new HttpsError("invalid-argument", "Cursor does not match this page.");
    }
  } else {
    if (page !== 1) throw new HttpsError("failed-precondition", "Load page one first.", {reason: "snapshot-required"});
    if (!before?.ready) {
      throw new HttpsError("failed-precondition", "The user index is being built. Try again shortly.", {
        reason: "user-index-not-ready",
      });
    }
    if (Object.keys(before.writers || {}).length) throw new HttpsError("aborted", "The user index is updating. Retry shortly.");
    const rows: UserDto[] = [];
    let after: string | undefined;
    let scanned = 0;
    for (let batchNumber = 0; batchNumber <= 100; batchNumber++) {
      let source = adminDb.ref("adminUserIndex").orderByKey();
      if (after) source = source.startAfter(after);
      const batch = await source.limitToFirst(100).get();
      let count = 0;
      batch.forEach((child) => {
        count++; scanned++; after = child.key!;
        const row = child.val();
        if ((filters.status ? row.status === filters.status : row.status !== "deleted") &&
            (!filters.q || row.searchKey.includes(filters.q))) {
          const {searchKey: ignored, ...dto} = row;
          void ignored;
          rows.push(dto);
        }
      });
      if (scanned > 10000) throw new HttpsError("resource-exhausted", "Narrow the user query; the index scan exceeds 10,000 users.");
      if (count < 100) break;
    }
    const end = (await adminDb.ref("adminUserIndexMeta").get()).val();
    if (end?.version !== before.version || end?.privacyRevision !== before.privacyRevision ||
        Object.keys(end?.writers || {}).length) {
      throw new HttpsError("aborted", "The user index changed. Retry this query.");
    }
    rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const rowsJson = JSON.stringify(rows);
    if (Buffer.byteLength(rowsJson, "utf8") > 8 * 1024 * 1024) {
      throw new HttpsError("resource-exhausted", "Narrow the user query; this snapshot is too large.");
    }
    snapshotId = randomUUID();
    stored = {uid: actorUid, fingerprint, rowsJson, expiresAt: Date.now() + P.snapshotMs,
      privacyRevision: Number(end.privacyRevision || 0)};
    await adminDb.ref(`adminSnapshots/${snapshotId}`).set(stored);
  }
  const rows = JSON.parse(stored.rowsJson) as UserDto[];
  const items = rows.slice((page - 1) * size, page * size);
  const statuses = await Promise.all(items.map((row) => adminDb.ref(`accountAccess/${row.id}/status`).get()));
  if (items.some((row, i) => statuses[i].val() === "deleted" &&
      (row.status !== "deleted" || row.email || row.name !== "Tài khoản đã xóa"))) {
    throw new HttpsError("failed-precondition", "Refresh the user list.", {reason: "snapshot-expired"});
  }
  return {items, total: rows.length, page, pageSize: size,
    snapshotId, expiresAt: stored.expiresAt,
    nextCursor: page * size < rows.length ? `${snapshotId}:${page + 1}` : null};
}
