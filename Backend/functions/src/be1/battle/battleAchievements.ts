import {createHash} from "node:crypto";
import {adminDb} from "../../config/firebaseAdmin";
import type {UserSettlementModel} from "../practice/finalizeAttempt";
import {contentId, record} from "../practice/contentValidation";
import {transactionWithRetry} from "../databaseTransaction";
import {enqueueBattleWork} from "./battleWork";
import {publishNotification} from "../community/notifications";

type Condition = "battle_wins" | "battle_win_streak" | "settled_battle_count";
export interface BattleAchievement {
  progress: number;
  threshold: number;
  conditionType: Condition;
  ruleVersion: string;
  title: string;
  unlockedAt?: number;
  sourceId?: string;
  notificationId?: string;
}
export interface BattleAchievementDefinition {
  id: string;
  conditionType: Condition;
  threshold: number;
  ruleVersion: string;
  title: string;
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ?
    value : 0;

const latestBattle = (s: UserSettlementModel) =>
  Object.values(s.grants || {}).filter((g) => g.sourceType === "battle")
    .sort((a, b) => b.settledAt - a.settledAt ||
      a.attemptId.localeCompare(b.attemptId))[0];

export const battleAchievementDefinitions = (value: unknown) =>
  Object.entries(record(value)).flatMap(([id, raw]) => {
    const d = record(raw);
    if (!contentId(id) || d.status !== "published" ||
        !["battle_wins", "battle_win_streak", "settled_battle_count"]
          .includes(String(d.conditionType)) ||
        !count(d.threshold) || typeof d.ruleVersion !== "string" ||
        !d.ruleVersion.trim() || typeof d.title !== "string" ||
        !d.title.trim()) return [];
    return [{id, conditionType: d.conditionType as Condition,
      threshold: count(d.threshold), ruleVersion: d.ruleVersion,
      title: d.title}];
  });

/**
 * Decide unlocks with the same transaction as ratings, grants and win streaks.
 * @param {UserSettlementModel} settlement Canonical per-user state.
 * @param {Array} definitions Published, validated definitions.
 * @param {unknown} legacy Previously projected user achievements.
 * @param {string} matchId Source match.
 * @param {number} at Frozen finish time.
 */
export function applyBattleAchievements(
  settlement: UserSettlementModel,
  definitions: BattleAchievementDefinition[],
  legacy: unknown,
  matchId: string,
  at: number,
): void {
  const stats = settlement.battleStats!;
  settlement.battleAchievements ||= {};
  const before = JSON.stringify(settlement.battleAchievements);
  const latest = latestBattle(settlement);
  for (const d of definitions) {
    const previous = settlement.battleAchievements[d.id];
    const imported = record(record(legacy)[d.id]);
    const achievement: BattleAchievement = previous || {
      ...d, progress: count(imported.progress),
      ...(count(imported.unlockedAt) ?
        {unlockedAt: count(imported.unlockedAt)} : {}),
    };
    const condition = achievement.unlockedAt ?
      achievement.conditionType : d.conditionType;
    const value = condition === "battle_wins" ? stats.wins :
      condition === "battle_win_streak" ? stats.bestWinStreak :
        stats.matchesPlayed;
    achievement.progress = achievement.unlockedAt ?
      Math.max(achievement.progress, value) : value;
    if (!achievement.unlockedAt) {
      achievement.threshold = d.threshold;
      achievement.ruleVersion = d.ruleVersion;
      achievement.conditionType = d.conditionType;
      achievement.title = d.title;
      if (value >= d.threshold) {
        achievement.unlockedAt = Math.max(at, latest?.settledAt || 0);
      }
    }
    if (achievement.unlockedAt) {
      achievement.sourceId ||= latest?.attemptId || matchId;
      achievement.notificationId ||= "battle_achievement_" +
        createHash("sha256").update(d.id).digest("hex").slice(0, 32);
    }
    settlement.battleAchievements[d.id] = achievement;
  }
  if (before !== JSON.stringify(settlement.battleAchievements)) {
    settlement.battleAchievementRevision =
      count(settlement.battleAchievementRevision) + 1;
  }
}

/**
 * Publish durable unlock decisions without resetting a notification's readAt.
 * @param {string} uid Owner.
 * @param {UserSettlementModel} settlement Committed canonical state.
 */
export async function projectBattleAchievements(
  uid: string,
  settlement: UserSettlementModel,
): Promise<void> {
  const revision = count(settlement.battleAchievementRevision);
  for (const [id, achievement] of Object.entries(
    settlement.battleAchievements || {},
  )) {
    await transactionWithRetry(adminDb.ref(`userAchievements/${uid}/${id}`),
      (stored) => {
        if (count(stored?.battleProjectionRevision) > revision) return;
        return {
          ...stored,
          progress: count(stored?.unlockedAt) ?
            Math.max(count(stored?.progress), achievement.progress) :
            achievement.progress,
          conditionType: achievement.conditionType,
          threshold: achievement.threshold,
          battleProjectionRevision: revision,
          ruleVersion: count(stored?.unlockedAt) &&
            typeof stored.ruleVersion === "string" ?
            stored.ruleVersion : achievement.ruleVersion,
          ...(achievement.unlockedAt ? {
            unlockedAt: count(stored?.unlockedAt) || achievement.unlockedAt,
            sourceType: "battle", sourceId: achievement.sourceId,
          } : {}),
        };
      });
    if (!achievement.unlockedAt || !achievement.notificationId) continue;
    await publishNotification(uid, achievement.notificationId, {
      title: "Mở khóa thành tích",
      body: `Bạn đã mở khóa thành tích: ${achievement.title}.`,
      targetType: "Achievements",
      sourceType: "battle_achievement", sourceId: id,
      createdAt: achievement.unlockedAt,
    });
  }
  await transactionWithRetry(adminDb.ref(`userSettlements/${uid}`), (s) => {
    if (!s) return s;
    s.battleAchievementPublishedRevision = Math.max(
      count(s.battleAchievementPublishedRevision),
      count(settlement.battleAchievementRevision),
    );
    return s;
  });
}

/**
 * Backfill old battle grants or newly published badges when opening dashboard.
 * A forced battle job is durable before the decision, including notification
 * failures; later worker passes finish the same effects without new rewards.
 * @param {string} uid Active owner.
 * @param {unknown} definitions Stored definitions already read by dashboard.
 * @param {unknown} legacy Projected achievements already read by dashboard.
 * @return {Promise<object|null>} Refreshed views only when reconciliation ran.
 */
export async function refreshBattleAchievements(
  uid: string,
  definitions: unknown,
  legacy: unknown,
): Promise<{achievements: unknown; notifications: unknown} | null> {
  const ref = adminDb.ref(`userSettlements/${uid}`);
  const stored = (await ref.get()).val() as UserSettlementModel | null;
  if (!stored?.battleStats) return null;
  const latest = latestBattle(stored);
  if (!latest) return null;
  const published = battleAchievementDefinitions(definitions);
  const preview = structuredClone(stored);
  applyBattleAchievements(preview, published, legacy,
    latest.attemptId, latest.settledAt);
  if (count(preview.battleAchievementRevision) <=
      count(stored.battleAchievementPublishedRevision)) return null;
  await enqueueBattleWork(latest.attemptId, undefined, false, true);
  const tx = await transactionWithRetry(ref,
    (s: UserSettlementModel | null) => {
      if (!s?.battleStats) return s;
      applyBattleAchievements(s, published, legacy,
        latest.attemptId, latest.settledAt);
      return s;
    });
  if (!tx.snapshot.exists()) return null;
  await projectBattleAchievements(uid, tx.snapshot.val());
  const [achievements, notifications] = await Promise.all([
    adminDb.ref(`userAchievements/${uid}`).get(),
    adminDb.ref(`notifications/${uid}`).orderByChild("createdAt")
      .limitToLast(50).get(),
  ]);
  return {achievements: achievements.val(), notifications: notifications.val()};
}
