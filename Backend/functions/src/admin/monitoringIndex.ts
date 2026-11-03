import {createHash, randomUUID} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {Data, adminRange} from "./contracts";
import {canonicalJson} from "./operations";
import {ADMIN_POLICY as P} from "./policy";
import {
  monitoringCount as count, monitoringId, monitoringParticipant, monitoringSkill, readMonitoringBattle,
} from "./monitoringModel";
import {normalizeUserSearch} from "./userIndex";

type Kind = "battles" | "activities";
const indexPath = (kind: Kind) => kind === "battles" ? "adminBattleIndex" : "adminActivityIndex";
const controlPath = (kind: Kind) => `adminMonitoringControl/${kind}`;
const eventId = (type: string, uid: string, id: string) => "act_" +
  createHash("sha256").update(canonicalJson([type, uid, id])).digest("hex");

/** One fenced writer per projection. Lost leases restart discovery before claiming readiness. */
async function maintain(
  kind: Kind, run: (state: Data, write: (id: string, row: Data) => Promise<void>) => Promise<Data>,
) {
  const ref = adminDb.ref(controlPath(kind)); const owner = randomUUID();
  const lease = await transactionWithRetry(ref, (c) => {
    if (c?.leaseUntil > Date.now() || c?.nextRunAt > Date.now()) return;
    const restart = c?.owner;
    return {...(restart ? {sequence: c.sequence, ready: false} : c), owner,
      sequence: count(c?.sequence) + 1, leaseUntil: Date.now() + 90000,
      scanStartedAt: restart ? Date.now() : c?.scanStartedAt || Date.now()};
  });
  if (!lease.committed) return;
  const state = lease.snapshot.val();
  try {
    const write = async (id: string, row: Data) => {
      const current = (await ref.get()).val();
      if (current?.owner !== owner || current.leaseUntil <= Date.now()) {
        throw new HttpsError("aborted", "Monitoring lease lost.");
      }
      if (current.leaseUntil - Date.now() < 30000) {
        const renewed = await transactionWithRetry(ref, (c) => {
          if (!c) return c;
          if (c.owner !== owner || c.leaseUntil <= Date.now()) return;
          return {...c, leaseUntil: Date.now() + 90000};
        });
        if (!renewed.committed) throw new HttpsError("aborted", "Monitoring lease lost.");
      }
      await transactionWithRetry(adminDb.ref(`${indexPath(kind)}/${id}`), (c) =>
        count(c?.sequence) > state.sequence ? c : {...row, sequence: state.sequence});
    };
    const next = await run(state, write);
    const result = await transactionWithRetry(ref, (c) => {
      if (!c) return c; // Let a cold SDK transaction load the server value before testing ownership.
      if (c?.owner !== owner || c.leaseUntil <= Date.now()) return;
      return {...c, ...next, owner: null, leaseUntil: null,
        errorCode: null, lastBatchAt: Date.now(),
        nextRunAt: Date.now() + (next.complete ? 10000 : 1000), complete: null,
        ...(next.complete ? {ready: true, asOf: c.scanStartedAt, scanStartedAt: null} : {})};
    });
    if (!result.committed) throw new HttpsError("aborted", "Monitoring lease lost.");
  } catch (error) {
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner) return;
      return {...c, ready: false, owner: null, leaseUntil: null,
        errorCode: error instanceof HttpsError ? error.code : "unavailable", nextRunAt: Date.now() + 2000};
    });
    throw error;
  }
}

/** Bounded canonical-room scan; no reads of reviews/keys are stored in the index. */
export async function runBattleIndexMaintenance(): Promise<void> {
  await maintain("battles", async (state, write) => {
    let query = adminDb.ref("battleRooms").orderByKey();
    if (state.after) query = query.startAfter(String(state.after));
    const batch = await query.limitToFirst(25).get();
    const ids: string[] = [];
    batch.forEach((child) => {
      ids.push(child.key!);
    });
    for (const id of ids) {
      const battle = await readMonitoringBattle(id);
      // Detail owns the timeline; list snapshots stay small and contain no names.
      await write(id, {...battle, logs: [], searchKey: normalizeUserSearch(`${id} ${battle.code}`)});
    }
    return {after: ids.length === 25 ? ids[ids.length - 1] : null, complete: ids.length < 25};
  });
}

/** Retained RTDB profiles enumerate UIDs; activity children are separately paged, never loaded as a root. */
export async function runActivityIndexMaintenance(): Promise<void> {
  await maintain("activities", async (state, write) => {
    let uid = String(state.uid || ""); let eventAfter = String(state.eventAfter || "");
    let afterUid = String(state.afterUid || "");
    let scanned = 0;
    // A busy user is split across ticks; empty/new accounts do not consume an entire tick each.
    for (let userBatch = 0; userBatch < 10 && scanned < 200; userBatch++) {
      if (!uid) {
        let source = adminDb.ref("users").orderByKey();
        if (afterUid) source = source.startAfter(afterUid);
        const batch = await source.limitToFirst(1).get();
        batch.forEach((child) => {
          uid = child.key!;
        });
        if (!uid) return {uid: null, eventAfter: null, afterUid: null, complete: true};
        if (!monitoringId(uid)) throw new HttpsError("failed-precondition", "Invalid source UID.");
        const createdAt = count((await adminDb.ref(`users/${uid}/createdAt`).get()).val());
        // Legacy profiles without a creation timestamp do not get an invented registration.
        if (createdAt) {
          await write(eventId("user", uid, uid), {
            id: eventId("user", uid, uid), userId: uid, text: "Account registered", type: "user", at: createdAt,
            categoryId: "mixed", answered: 0, correct: 0, completed: false, userName: "",
            sourceId: uid, outcome: "registered", searchKey: normalizeUserSearch(`${uid} account registered`),
          });
        }
      }
      let source = adminDb.ref(`studyActivities/${uid}`).orderByKey();
      if (eventAfter) source = source.startAfter(eventAfter);
      const batchSize = Math.min(50, 200 - scanned);
      const batch = await source.limitToFirst(batchSize).get();
      scanned += batch.numChildren();
      const rows: Array<{key: string; value: Data}> = [];
      batch.forEach((child) => {
        rows.push({key: child.key!, value: child.val()});
      });
      for (const {key, value} of rows) {
        const entry = value.entry as Data | undefined;
        if (!entry || !monitoringId(entry.attemptId) || !count(entry.completedAt) ||
          !["PRACTICE", "TEST", "DAILY", "BATTLE"].includes(String(entry.mode)) ||
            !(entry.mode === "BATTLE" ? ["win", "loss", "draw", "left"] :
              ["completed", "abandoned"]).includes(String(entry.outcome)) ||
            !Number.isSafeInteger(value.answered) || Number(value.answered) < 0 ||
            !Number.isSafeInteger(entry.correct) || Number(entry.correct) < 0 ||
            !count(entry.total) || count(value.answered) > count(entry.total) ||
            count(value.answered) < count(entry.correct)) {
          throw new HttpsError("failed-precondition", "Stored activity needs review.", {reason: "invalid-stored-activity"});
        }
        const type = entry.mode === "BATTLE" ? "battle" : "lesson";
        // Deduplication uses business identity, independent of settlement/reporting retry versions.
        const id = eventId(type, uid, String(entry.attemptId));
        const skillValues = Object.entries(value.skills || {}).filter(([, v]) => count((v as Data).answered))
          .map(([skill]) => skill);
        const completed = type === "battle" || entry.outcome === "completed";
        const text = type === "battle" ? `Battle ended (${entry.outcome})` :
          `${entry.mode === "PRACTICE" ? "Lesson" : entry.mode === "TEST" ? "Test" : "Daily study"} ${entry.outcome}`;
        await write(id, {id, userId: uid, text, type, at: count(entry.completedAt),
          categoryId: monitoringSkill(skillValues), answered: count(value.answered), correct: count(entry.correct),
          completed, userName: "", sourceId: entry.attemptId, outcome: entry.outcome,
          searchKey: normalizeUserSearch(`${uid} ${entry.attemptId} ${text}`)});
        eventAfter = key;
      }
      if (rows.length < batchSize) {
        afterUid = uid; uid = ""; eventAfter = "";
      }
    }
    return {uid: uid || null, eventAfter: eventAfter || null, afterUid: afterUid || null};
  });
}

/** Exact indexed totals, stable numbered pages and explicit projection freshness. */
export async function listMonitoring(kind: Kind, uid: string, query: Data) {
  if (kind === "battles" && query.mode && query.mode !== "quick") {
    throw new HttpsError("unimplemented", "Daily and private battle monitoring is not implemented.");
  }
  const page = Number(query.page || 1); const size = Number(query.pageSize || 10);
  const filters = {q: normalizeUserSearch(String(query.q || "")), status: String(query.status || ""),
    mode: String(query.mode || ""), type: String(query.type || ""), categoryId: String(query.categoryId || ""),
    range: query.range || null, pageSize: size};
  const range = query.range ? adminRange(query.range) : null;
  const fingerprint = createHash("sha256").update(canonicalJson([kind, filters])).digest("hex");
  let snapshotId = query.snapshotId as string | undefined;
  let stored: {uid: string; kind: string; fingerprint: string; rowsJson: string; expiresAt: number; asOf: number};
  if (snapshotId) {
    stored = (await adminDb.ref(`adminSnapshots/${snapshotId}`).get()).val();
    if (!stored || stored.uid !== uid || stored.kind !== kind || stored.fingerprint !== fingerprint ||
        stored.expiresAt <= Date.now()) {
      throw new HttpsError("failed-precondition", "Refresh the monitoring list.", {reason: "snapshot-expired"});
    }
    if (query.cursor && query.cursor !== `${snapshotId}:${page}`) throw new HttpsError("invalid-argument", "Cursor mismatch.");
  } else {
    if (page !== 1) throw new HttpsError("failed-precondition", "Load page one first.", {reason: "snapshot-required"});
    const before = (await adminDb.ref(controlPath(kind)).get()).val();
    if (!before?.ready) {
      throw new HttpsError("failed-precondition", "Monitoring index is being built.", {
        reason: "monitoring-index-not-ready",
      });
    }
    if (before.owner) throw new HttpsError("aborted", "Monitoring index is updating.");
    const rows: Data[] = [];
    let after = ""; let scanned = 0; let bytes = 2;
    for (;;) {
      let source = adminDb.ref(indexPath(kind)).orderByKey();
      if (after) source = source.startAfter(after);
      const batch = await source.limitToFirst(100).get();
      batch.forEach((child) => {
        after = child.key!; scanned++;
        const row = child.val(); const time = kind === "battles" ? row.startedAt : row.at;
        if ((!filters.q || row.searchKey.includes(filters.q)) && (!filters.status || row.status === filters.status) &&
            (!filters.mode || row.mode === filters.mode) && (!filters.type || row.type === filters.type) &&
            (!filters.categoryId || row.categoryId === filters.categoryId) &&
            (!range || time >= range.from && time < range.until)) {
          const {searchKey, sequence, ...raw} = row; void searchKey; void sequence;
          const dto = kind === "battles" ? {...raw, logs: [], endedAt: raw.endedAt ?? null,
            playStartedAt: raw.playStartedAt ?? null,
            outcome1: raw.outcome1 ?? null, outcome2: raw.outcome2 ?? null} : raw;
          bytes += Buffer.byteLength(JSON.stringify(dto), "utf8") + 1;
          if (bytes > 8 * 1024 * 1024) throw new HttpsError("resource-exhausted", "Monitoring snapshot exceeds 8 MiB.");
          rows.push(dto);
        }
      });
      if (scanned > 10000) throw new HttpsError("resource-exhausted", "Monitoring scan exceeds 10,000 records.");
      if (batch.numChildren() < 100) break;
    }
    const end = (await adminDb.ref(controlPath(kind)).get()).val();
    if (!end?.ready || end.owner || end.sequence !== before.sequence) {
      throw new HttpsError("aborted", "Monitoring index changed. Retry this query.");
    }
    rows.sort((a, b) => Number(kind === "battles" ? b.startedAt : b.at) -
      Number(kind === "battles" ? a.startedAt : a.at) || (String(a.id) < String(b.id) ? -1 : 1));
    snapshotId = randomUUID();
    stored = {uid, kind, fingerprint, rowsJson: JSON.stringify(rows),
      expiresAt: Date.now() + P.snapshotMs, asOf: count(end.asOf)};
    await adminDb.ref(`adminSnapshots/${snapshotId}`).set(stored);
  }
  const rows = (JSON.parse(stored.rowsJson) as Data[]).slice((page - 1) * size, page * size);
  const participants = new Map<string, Awaited<ReturnType<typeof monitoringParticipant>>>();
  const uids = [...new Set(rows.flatMap((row) => kind === "battles" ?
    [String(row.player1), String(row.player2)] : [String(row.userId)]))];
  for (let i = 0; i < uids.length; i += 5) {
    await Promise.all(uids.slice(i, i + 5).map(async (id) => participants.set(id, await monitoringParticipant(id))));
  }
  const items = rows.map((row) => kind === "battles" ? {...row,
    player1Name: participants.get(String(row.player1))!.name,
    player2Name: participants.get(String(row.player2))!.name} :
    {...row, userName: participants.get(String(row.userId))!.name});
  const total = (JSON.parse(stored.rowsJson) as Data[]).length;
  return {items, total, page, pageSize: size, snapshotId, expiresAt: stored.expiresAt,
    nextCursor: page * size < total ? `${snapshotId}:${page + 1}` : null,
    asOf: stored.asOf, lagMs: Math.max(0, Date.now() - stored.asOf), ready: true};
}
