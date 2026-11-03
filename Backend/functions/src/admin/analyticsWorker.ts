import {randomUUID} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {
  AnalyticsFact, Raw, analyticsId, analyticsKey, analyticsRecord as record, analyticsTime as time,
  battleFact, historicalBattleFact, hydrateAnalyticsFact, invalidAnalytics, learningFact,
} from "./analyticsModel";
import {
  ANALYTICS_LIMITS as L, analyticsRoot, projectAnalyticsAccount, projectAnalyticsFact,
} from "./analyticsProjection";

type Phase = "auth" | "profiles" | "learning" | "rooms" | "results" | "history" |
  "accounts" | "facts" | "cumulative" | "publish";
interface Checkpoint {
  generation: string; asOf: number; phase: Phase; after: string | null; uid: string | null;
  uidAfter: string | null; pageToken: string | null; sourceRecords: number; totalUsers: number;
  accounts: number; facts: number; unknownStartSessions: number; latestUnknownStartEnd: number;
  registeredTotal: number;
}
const nextPhase = (s: Checkpoint, phase: Phase): Checkpoint =>
  ({...s, phase, after: null, uid: null, uidAfter: null, pageToken: null});
async function page(path: string, after: string | null, size = 25) {
  let query = adminDb.ref(path).orderByKey();
  if (after) query = query.startAfter(after);
  const rows: Array<{id: string; value: Raw}> = [];
  (await query.limitToFirst(size).get()).forEach((child) => {
    rows.push({id: child.key!, value: child.val()});
  });
  return rows;
}
async function ownedPage(s: Checkpoint, source: string) {
  const roster = `${analyticsRoot(s.generation)}/accounts`;
  let cursor = s;
  for (let empty = 0; empty < 10; empty++) {
    const uid = cursor.uid || (await page(roster, cursor.uidAfter, 1))[0]?.id;
    if (!uid) return null;
    const rows = await page(`${source}/${uid}`, cursor.after);
    const next = rows.length === 25 ? {...cursor, uid, after: rows[rows.length - 1].id} :
      {...cursor, uid: null, uidAfter: uid, after: null};
    if (rows.length || empty === 9) return {uid, rows, next};
    cursor = next;
  }
  return null;
}
async function saveFact(s: Checkpoint, fact: AnalyticsFact | null) {
  if (fact) await adminDb.ref(`${analyticsRoot(s.generation)}/facts/${fact.id}`).set(fact);
}
async function step(s: Checkpoint, renew: () => Promise<void>): Promise<Checkpoint> {
  const root = analyticsRoot(s.generation);
  if (s.phase === "auth") {
    const batch = await adminAuth.listUsers(25, s.pageToken || undefined);
    for (const user of batch.users) {
      await renew();
      if (!analyticsId(user.uid)) return invalidAnalytics();
      const createdAt = time(Date.parse(user.metadata.creationTime));
      if (!createdAt) return invalidAnalytics();
      const access = (await adminDb.ref(`accountAccess/${user.uid}`).get()).val();
      const deleted = access?.status === "deleted" && (!time(access.updatedAt) || time(access.updatedAt) <= s.asOf);
      await adminDb.ref(`${root}/accounts/${user.uid}`).set({uid: user.uid, createdAt, auth: true,
        current: createdAt <= s.asOf && !deleted});
    }
    return batch.pageToken ? {...s, pageToken: batch.pageToken,
      sourceRecords: s.sourceRecords + batch.users.length} :
      nextPhase({...s, sourceRecords: s.sourceRecords + batch.users.length}, "profiles");
  }
  if (s.phase === "profiles") {
    const rows = await page("users", s.after);
    for (const {id} of rows) {
      await renew();
      if (!analyticsId(id)) return invalidAnalytics();
      await transactionWithRetry(adminDb.ref(`${root}/accounts/${id}`), (c) => c ||
        {uid: id, auth: false, createdAt: 0, current: false});
    }
    const next = {...s, sourceRecords: s.sourceRecords + rows.length};
    return rows.length === 25 ? {...next, after: rows[rows.length - 1].id} : nextPhase(next, "learning");
  }
  if (s.phase === "learning" || s.phase === "history") {
    const batch = await ownedPage(s, s.phase === "learning" ? "practiceAttempts" : "studyActivities");
    if (!batch) return nextPhase(s, s.phase === "learning" ? "rooms" : "accounts");
    for (const {id, value} of batch.rows) {
      await renew();
      const uid = batch.uid;
      if (s.phase === "learning") {
        const [qs, answers, study] = await Promise.all([
          adminDb.ref(`attemptQuestions/${uid}/${id}`).get(), adminDb.ref(`attemptAnswers/${uid}/${id}`).get(),
          adminDb.ref(`studyActivities/${uid}/learning_${id}`).get(),
        ]);
        await saveFact(s, learningFact(uid, id, value, qs.val(), answers.val(), study.val(), s.asOf));
      } else {
        const entry = record(value.entry); const sourceId = String(entry.attemptId || "");
        if (!analyticsId(sourceId)) return invalidAnalytics();
        const battle = entry.mode === "BATTLE"; const key = battle ? analyticsKey("battle", sourceId) :
          analyticsKey("learning", uid, sourceId);
        const existing = (await adminDb.ref(`${root}/facts/${key}`).get()).val();
        if (existing && !existing.historicalEntries) continue;
        if (battle) {
          const entries = {...existing?.historicalEntries, [uid]: {
            entry: {completedAt: entry.completedAt, correct: entry.correct, outcome: entry.outcome},
            answered: value.answered,
          }};
          const fact = historicalBattleFact(sourceId, entries, s.asOf);
          if (fact) await adminDb.ref(`${root}/facts/${key}`).set({...fact, historicalEntries: entries});
        } else {
          const qs = await adminDb.ref(`attemptQuestions/${uid}/${sourceId}`).get();
          await saveFact(s, learningFact(uid, sourceId, {}, qs.val(), {}, value, s.asOf));
        }
      }
    }
    return {...batch.next, sourceRecords: s.sourceRecords + batch.rows.length};
  }
  if (s.phase === "rooms" || s.phase === "results") {
    const rows = await page(s.phase === "rooms" ? "battleRooms" : "battleResults", s.after);
    for (const {id, value} of rows) {
      await renew();
      if (s.phase === "rooms") {
        const result = await adminDb.ref(`battleResults/${id}`).get();
        await saveFact(s, battleFact(id, value, result.val(), s.asOf));
      } else if (!(await adminDb.ref(`${root}/facts/${analyticsKey("battle", id)}`).get()).exists()) {
        if (value.status !== "settled") return invalidAnalytics();
        const at = time(value.finishedAt);
        if (!at) return invalidAnalytics();
        if (at > s.asOf) continue;
        const entries: Record<string, unknown> = {};
        const uids = Object.keys(record(value.players));
        if (uids.length !== 2 || !uids.every(analyticsId)) return invalidAnalytics();
        let unknownAnswers = false;
        for (const uid of uids) {
          const [study, grant] = await Promise.all([
            adminDb.ref(`studyActivities/${uid}/battle_${id}`).get(),
            adminDb.ref(`userSettlements/${uid}/grants/grant_${id}`).get(),
          ]);
          if (study.exists()) entries[uid] = study.val();
          else {
            const g = grant.val(); const outcome = record(record(value.players)[uid]).outcome;
            const missingCounts = !g || g.correctCount === undefined || g.answeredCount === undefined;
            unknownAnswers ||= missingCounts;
            entries[uid] = {entry: {completedAt: at, outcome, correct: missingCounts ? 0 : g.correctCount},
              answered: missingCounts ? 0 : g.answeredCount};
          }
        }
        const fact = historicalBattleFact(id, entries, s.asOf);
        if (fact) {
          await saveFact(s, {...fact, unknownAnswers, unknownBattleCompletion: false,
            startNotApplicable: value.endReason === "ready_timeout",
            completed: !["ready_timeout", "both_left", "both_disconnected"].includes(String(value.endReason)),
            ...(value.endReason === "ready_timeout" ? {
              players: Object.fromEntries(Object.entries(fact.players).map(([uid, p]) => [uid, {...p, days: []}])),
            } : {})});
        }
      }
    }
    const next = {...s, sourceRecords: s.sourceRecords + rows.length};
    return rows.length === 25 ? {...next, after: rows[rows.length - 1].id} :
      nextPhase(next, s.phase === "rooms" ? "results" : "history");
  }
  if (s.phase === "accounts" || s.phase === "facts") {
    const rows = await page(`${root}/${s.phase}`, s.after);
    const next = {...s};
    for (const {id, value} of rows) {
      await renew();
      if (s.phase === "accounts") {
        next.accounts++;
        if (value.current) next.totalUsers++;
        if (value.auth && time(value.createdAt) <= s.asOf) {
          await projectAnalyticsAccount(s.generation, id, time(value.createdAt));
        }
      } else {
        next.facts++;
        const fact = hydrateAnalyticsFact(value);
        if (!fact.startedAt && fact.endedAt && !fact.startNotApplicable) {
          next.unknownStartSessions++; next.latestUnknownStartEnd = Math.max(next.latestUnknownStartEnd, fact.endedAt);
        }
        await projectAnalyticsFact(s.generation, fact);
      }
      if (next.accounts > L.accounts || next.facts > L.facts) {
        throw new HttpsError("resource-exhausted", "Analytics generation exceeds its account/session limit.");
      }
    }
    return rows.length === 25 ? {...next, after: rows[rows.length - 1].id} :
      nextPhase(next, s.phase === "accounts" ? "facts" : "cumulative");
  }
  if (s.phase === "cumulative") {
    const rows = await page(`${root}/daily`, s.after, 7);
    const next = {...s};
    for (const {id, value} of rows) {
      await renew();
      next.registeredTotal += Number(value.registrations || 0);
      await adminDb.ref(`${root}/daily/${id}/registeredTotal`).set(next.registeredTotal);
    }
    return rows.length === 7 ? {...next, after: rows[rows.length - 1].id} : nextPhase(next, "publish");
  }
  return s;
}

/** Build a separate generation, atomically publish its pointer, retain the last complete generation on failure. */
export async function runAdminAnalyticsMaintenance(pages = 2): Promise<void> {
  if (!Number.isInteger(pages) || pages < 1 || pages > 4) throw new Error("Invalid analytics worker batch.");
  const ref = adminDb.ref("adminAnalyticsControl"); const owner = randomUUID();
  const candidate = randomUUID(); const now = Date.now();
  const lease = await transactionWithRetry(ref, (c) => {
    if (c?.leaseUntil > Date.now() || c?.nextRunAt > Date.now()) return;
    const pending = !c?.pending || c.owner ? {generation: candidate, asOf: now, phase: "auth",
      after: null, uid: null, uidAfter: null, pageToken: null, sourceRecords: 0, totalUsers: 0,
      accounts: 0, facts: 0, unknownStartSessions: 0, latestUnknownStartEnd: 0, registeredTotal: 0} : c.pending;
    return {...c, owner, pending, leaseUntil: Date.now() + 90000};
  });
  if (!lease.committed) return;
  let state = lease.snapshot.val().pending as Checkpoint;
  const renew = async () => {
    const current = (await ref.get()).val();
    if (current?.owner !== owner || current.pending?.generation !== state.generation ||
        current.leaseUntil <= Date.now()) {
      throw new HttpsError("aborted", "Analytics lease lost.");
    }
    if (current.leaseUntil - Date.now() < 30000) {
      const tx = await transactionWithRetry(ref, (c) => {
        if (!c) return c;
        if (c.owner !== owner || c.leaseUntil <= Date.now()) return;
        return {...c, leaseUntil: Date.now() + 90000};
      });
      if (!tx.committed) throw new HttpsError("aborted", "Analytics lease lost.");
    }
  };
  try {
    await transactionWithRetry(adminDb.ref(`adminAnalyticsGenerationMeta/${state.generation}`), (c) => c ||
      {createdAt: state.asOf, expiresAt: Date.now() + L.generationMs, ready: false});
    for (let n = 0; n < pages; n++) {
      await renew();
      if (state.phase === "publish") {
        await adminDb.ref(`adminAnalyticsGenerationMeta/${state.generation}`).update({...state, ready: true,
          publishedAt: Date.now(), expiresAt: Date.now() + L.generationMs});
        const published = await transactionWithRetry(ref, (c) => {
          if (!c) return c;
          if (c.owner !== owner || c.pending?.generation !== state.generation || c.leaseUntil <= Date.now()) return;
          return {activeGeneration: state.generation, asOf: state.asOf, pending: null,
            nextRunAt: Date.now() + 60000, lastPublishedAt: Date.now()};
        });
        if (!published.committed) throw new HttpsError("aborted", "Analytics lease lost.");
        break;
      }
      const next = await step(state, renew);
      if (next.sourceRecords > 100000) throw new HttpsError("resource-exhausted", "Analytics discovery exceeds 100,000 source rows.");
      const saved = await transactionWithRetry(ref, (c) => {
        if (!c) return c;
        if (c.owner !== owner || c.leaseUntil <= Date.now()) return;
        return {...c, pending: next, leaseUntil: Date.now() + 90000, errorCode: null};
      });
      if (!saved.committed) throw new HttpsError("aborted", "Analytics lease lost.");
      state = next;
    }
    const expired = await adminDb.ref("adminAnalyticsGenerationMeta").orderByChild("expiresAt")
      .startAt(0).endAt(Date.now()).limitToFirst(5).get();
    const candidates: string[] = [];
    expired.forEach((child) => {
      candidates.push(child.key!);
    });
    for (const id of candidates) {
      const current = (await ref.get()).val();
      if ([current?.activeGeneration, current?.pending?.generation].includes(id)) continue;
      await adminDb.ref(analyticsRoot(id)).remove();
      await adminDb.ref(`adminAnalyticsGenerationMeta/${id}`).remove();
    }
  } catch (error) {
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner) return;
      return {...c, errorCode: error instanceof HttpsError ? error.code : "unavailable"};
    });
    throw error;
  } finally {
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner) return;
      return {...c, owner: null, leaseUntil: null, nextRunAt: Date.now() + 1000};
    });
  }
}
