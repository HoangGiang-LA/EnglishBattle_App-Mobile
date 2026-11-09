import {adminDb} from "../../config/firebaseAdmin";
import {transactionWithRetry} from "../databaseTransaction";
import {randomUUID} from "node:crypto";
import {battleNow, syncBattleClock} from "./battleClock";

/**
 * Wake a durable battle job without making leased jobs block the due query.
 * @param {string} matchId Match.
 * @param {number} [dueAt] Earliest pending deadline, defaults to now.
 * @param {boolean} onlyIfMissing Preserve work during discovery.
 * @param {boolean} refreshEffects Reconcile previously settled achievements.
 * @return {Promise<object>} Generation and revision of this wakeup.
 */
export async function enqueueBattleWork(
  matchId: string,
  dueAt?: number,
  onlyIfMissing = false,
  refreshEffects = false,
): Promise<{generation: string; revision: number}> {
  await syncBattleClock();
  const deadline = dueAt ?? battleNow();
  const generation = randomUUID();
  const tx = await transactionWithRetry(adminDb.ref(`battleWork/${matchId}`),
    (job) => {
      if (job && onlyIfMissing) return;
      const leased = Number(job?.leaseUntil) > battleNow();
      const previousDue = Number.isFinite(job?.dueAt) ? job.dueAt : deadline;
      const previousWake = Number.isFinite(job?.wakeAt) ? job.wakeAt : deadline;
      return {
        ...job,
        matchId,
        generation: job?.generation || generation,
        dueAt: leased ? job.leaseUntil : Math.min(previousDue, deadline),
        wakeAt: leased ? Math.min(previousWake, deadline) : null,
        revision: (Number(job?.revision) || 0) + 1,
        refreshEffects: refreshEffects || job?.refreshEffects || null,
      };
    },
  );
  const committed = tx.snapshot.val();
  return {generation: committed.generation, revision: committed.revision};
}
