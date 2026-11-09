import {randomUUID} from "node:crypto";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {adminDb} from "../../config/firebaseAdmin";
import {BattleCoordinator, BattleMatch} from "./battleTypes";
import {battleDueAt} from "./battleState";
import {enqueueBattleWork} from "./battleWork";
import {transactBattle} from "./battleService";
import {settleBattle} from "./battleSettlement";
import {flushBattleCoordinator, releaseBattle} from "./matchmaking";
import {battleNow, syncBattleClock} from "./battleClock";

const discover = async () => {
  const ref = adminDb.ref("battleMaintenance/discovery");
  const owner = randomUUID();
  const claim = await ref.transaction(
    (cursor) => {
      const now = battleNow();
      if (cursor?.leaseUntil > now || cursor?.nextRunAt > now) {
        return;
      }
      return {...cursor, owner, leaseUntil: now + 90000};
    },
    undefined,
    false,
  );
  if (!claim.committed) return;
  const cursor = claim.snapshot.val();
  try {
    const state = (
      await adminDb.ref("battleCoordinator").get()
    ).val() as BattleCoordinator | null;
    const ids = [
      ...new Set(
        Object.values(state?.users || {}).flatMap((binding) =>
          binding.matchId ? [binding.matchId] : [],
        ),
      ),
    ].sort();
    const remaining = ids.filter((id) => !cursor.after || id > cursor.after);
    const page = remaining.slice(0, 25);
    for (const id of page) {
      const match = (
        await adminDb.ref(`battleRooms/${id}`).get()
      ).val() as BattleMatch | null;
      if (!match) continue; // An allocation outbox may still be retrying.
      if (match.status === "completed" && match.settlementVersion === 1 &&
          match.battleEffectsVersion === 1) {
        await releaseBattle(match);
      } else await enqueueBattleWork(id, battleDueAt(match, battleNow()), true);
    }
    await ref.transaction(
      (current) => {
        if (!current) return current;
        if (current.owner !== owner) return;
        return remaining.length > 25 ?
          {after: page[page.length - 1], nextRunAt: battleNow() + 1000} :
          {nextRunAt: battleNow() + 60000};
      },
      undefined,
      false,
    );
  } catch (error) {
    await ref.transaction(
      (current) => {
        if (!current) return current;
        if (current.owner !== owner) return;
        return {
          ...current,
          owner: null,
          leaseUntil: null,
          nextRunAt: battleNow() + 10000,
        };
      },
      undefined,
      false,
    );
    throw error;
  }
};

/**
 * Resolve due matches using leased jobs and isolate each retry failure.
 * @return {Promise<void>} Completion.
 */
export async function drainBattleWork(): Promise<void> {
  await syncBattleClock();
  const due = await adminDb
    .ref("battleWork")
    .orderByChild("dueAt")
    .endAt(battleNow())
    .limitToFirst(25)
    .get();
  const ids: string[] = [];
  due.forEach((child) => {
    ids.push(child.key!);
  });
  for (const id of ids) {
    const ref = adminDb.ref(`battleWork/${id}`);
    const owner = randomUUID();
    try {
      const claim = await ref.transaction(
        (job) => {
          if (!job) return job;
          const now = battleNow();
          if (job.dueAt > now || job.leaseUntil > now) return;
          return {
            ...job,
            leaseOwner: owner,
            leaseUntil: now + 90000,
            dueAt: now + 90000,
            wakeAt: null,
          };
        },
        undefined,
        false,
      );
      if (!claim.committed || !claim.snapshot.exists()) continue;
      const job = claim.snapshot.val();
      const stored = (await adminDb.ref(`battleRooms/${id}`).get())
        .val() as BattleMatch | null;
      let match = stored;
      if (stored?.status === "completed" && job.refreshEffects) {
        await settleBattle(id, true);
      } else if (stored) match = (await transactBattle(id)).match;
      const next =
        !match || match.status === "completed" ?
          null : battleDueAt(match, battleNow());
      await ref.transaction(
        (current) => {
          if (!current) return current;
          if (current.leaseOwner !== owner) return;
          if (next === null && current.revision === job.revision) return null;
          if (next === null) {
            return {
              matchId: id, generation: current.generation,
              revision: current.revision, dueAt: battleNow(),
              refreshEffects: current.refreshEffects || null,
            };
          }
          const wake = Number.isFinite(current.wakeAt) ?
            current.wakeAt :
            current.dueAt;
          return {
            matchId: id,
            generation: current.generation,
            refreshEffects: current.refreshEffects || null,
            revision: current.revision,
            dueAt:
              current.revision === job.revision ? next : Math.min(wake, next),
          };
        },
        undefined,
        false,
      );
    } catch (error) {
      const code = String(
        (error as {code?: string}).code || "battle-worker-error",
      );
      try {
        await ref.transaction(
          (current) => {
            if (!current) return current;
            if (current.leaseOwner !== owner) return;
            const retryCount = (Number(current.retryCount) || 0) + 1;
            return {
              ...current,
              leaseOwner: null,
              leaseUntil: null,
              wakeAt: null,
              retryCount,
              lastErrorCode: code,
              dueAt:
                battleNow() +
                Math.min(60000, 1000 * 2 ** Math.min(retryCount - 1, 6)),
            };
          },
          undefined,
          false,
        );
      } catch {
        console.error("Battle retry state failed", {id});
      }
      console.error("Battle worker retry", {id, code});
    }
  }
}

/** Recover matchmaking outboxes and every due match without an open app. */
export async function runBattleMaintenance(): Promise<void> {
  await syncBattleClock();
  try {
    await flushBattleCoordinator();
    await discover();
  } finally {
    await drainBattleWork();
  }
}

export const maintainBattles = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "asia-southeast1",
    timeZone: "Asia/Ho_Chi_Minh",
    maxInstances: 1,
    timeoutSeconds: 540,
  },
  runBattleMaintenance,
);
