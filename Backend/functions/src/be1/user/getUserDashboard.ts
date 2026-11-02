import {onCall, HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../../config/firebaseAdmin";
import {refreshBattleAchievements} from "../battle/battleAchievements";
import {refreshDailyAchievements} from "../community/dailyAchievements";
import {notificationCounts, notificationSlice} from
  "../community/notifications";
import {isStudyDayActive, studyStreak} from "../reporting/activity";
import {periodBounds} from "../reporting/getStudyStatistics";

const getDateKey = (now: number): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")}`;
};

const nonNegativeInt = (value: unknown): number => {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 ? value : 0;
};

const dailyStatuses = [
  "available",
  "active",
  "waiting",
  "completed",
  "abandoned",
] as const;

type DailyStatus = typeof dailyStatuses[number];

export const getUserDashboard = onCall(
  {
    region: "asia-southeast1",
    maxInstances: 10,
  },
  async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError(
        "unauthenticated",
        "You must sign in first."
      );
    }

    try {
      const now = Date.now();
      const authUser = await adminAuth.getUser(uid);

      if (authUser.disabled) {
        throw new HttpsError(
          "permission-denied",
          "This account is disabled."
        );
      }

      const dateKey = getDateKey(now);


      const [
        accessSnap,
        statsSnap,
        walletSnap,
        dailySnap,
        progressSnap,
        skillsSnap,
        achievementsSnap,
        userAchievementsSnap,
        ledgerSnap,
        practiceHistorySnap,
        battleHistorySnap,
      ] = await Promise.all([
        adminDb.ref(`accountAccess/${uid}`).get(),
        adminDb.ref(`userStats/${uid}`).get(),
        adminDb.ref(`wallets/${uid}`).get(),
        adminDb.ref(`userDailyChallenges/${uid}/${dateKey}`).get(),
        adminDb.ref(`learningProgress/${uid}`).get(),
        adminDb.ref(`userSkillStats/${uid}`).get(),
        adminDb.ref("achievements").get(),
        adminDb.ref(`userAchievements/${uid}`).get(),


        adminDb.ref(`coinLedger/${uid}`)
          .orderByChild("createdAt")
          .limitToLast(50)
          .get(),

        adminDb.ref(`practiceAttempts/${uid}`)
          .orderByChild("finishedAt")
          .limitToLast(50)
          .get(),
        adminDb.ref(`battleHistory/${uid}`)
          .orderByChild("finishedAt")
          .limitToLast(50)
          .get(),
      ]);


      const access = accessSnap.val();

      if (access?.status !== "active") {
        throw new HttpsError(
          "permission-denied",
          "This account is not active."
        );
      }

      if (!statsSnap.exists() || !walletSnap.exists()) {
        throw new HttpsError(
          "failed-precondition",
          "User profile is not initialized."
        );
      }

      const stats = statsSnap.val();
      const wallet = walletSnap.val();
      const daily = dailySnap.val();
      await refreshBattleAchievements(uid,
        achievementsSnap.val(), userAchievementsSnap.val());
      const refreshedAchievements = await refreshDailyAchievements(uid,
        achievementsSnap.val());

      let dailyStatus: DailyStatus = "available";

      if (daily !== null) {
        if (!dailyStatuses.includes(daily.status)) {
          throw new HttpsError(
            "internal",
            "Invalid daily challenge status."
          );
        }
        dailyStatus = daily.status;
      }


      const progressData = progressSnap.val() ?? {};
      const progress: Record<string, number> = {};

      for (const [topicId, value] of Object.entries(progressData)) {
        if (
          value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
        ) {
          continue;
        }

        const item = value as Record<string, unknown>;

        progress[topicId] = nonNegativeInt(
          item.completedAttempts
        );
      }

      const skillNames: Record<string, string> = {
        vocabulary: "Vocabulary",
        grammar: "Grammar",
        listening: "Listening",
        reading: "Reading",
      };

      const skillsData = skillsSnap.val() ?? {};

      const skills = Object.entries(skillsData).flatMap(
        ([categoryId, value]) => {
          if (!Object.prototype.hasOwnProperty.call(skillNames, categoryId)) {
            return [];
          }
          if (
            value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
          ) {
            return [];
          }

          const item = value as Record<string, unknown>;

          const answered = nonNegativeInt(item.answeredCount);
          const correct = Math.min(
            nonNegativeInt(item.correctCount),
            answered
          );

          return [{
            id: categoryId,
            name: skillNames[categoryId],
            answered,
            correct,
          }];
        }
      );
      const achievementDefinitions =
  achievementsSnap.val() ?? {};

      const userAchievementData =
  refreshedAchievements;

      const achievements = Object.entries(
        achievementDefinitions
      ).flatMap(([achievementId, value]) => {
        if (
          value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
        ) {
          return [];
        }

        const definition = value as Record<string, unknown>;

        // Achievement definitions use the content publication status.
        if (definition.status !== "published") {
          return [];
        }

        const userRecord = userAchievementData[achievementId];

        const unlocked =
    typeof userRecord?.unlockedAt === "number" &&
    Number.isSafeInteger(userRecord.unlockedAt) &&
    userRecord.unlockedAt > 0;

        const threshold = nonNegativeInt(definition.threshold) || 1;
        const progressValue = definition.conditionType ===
          "practice_completion_count" ?
          progress[String(definition.targetId)] || 0 :
          nonNegativeInt(userRecord?.progress);
        const description = typeof definition.description === "string" ?
          definition.description :
          definition.conditionType === "battle_wins" ?
            `Thắng ${threshold} trận đấu.` :
            definition.conditionType === "battle_win_streak" ?
              `Thắng ${threshold} trận liên tiếp.` :
              definition.conditionType === "settled_battle_count" ?
                `Hoàn tất ${threshold} trận đấu.` :
                definition.conditionType ===
                    "completed_daily_challenge_count" ?
                  `Hoàn thành ${threshold} thử thách hằng ngày.` : "";

        return [{
          id: achievementId,
          title: typeof definition.title === "string" ?
            definition.title : achievementId,
          description,
          unlocked,
          progress: progressValue,
          threshold,
        }];
      });

      const counts = await notificationCounts(uid);
      const notifications = (await notificationSlice(uid, counts, 50)).entries;
      const studyDates: string[] = [];
      const weekStart = periodBounds("week", now).from;
      const [learningStreak, activeDays] = await Promise.all([
        studyStreak(uid, dateKey),
        adminDb.ref(`studyActiveDays/${uid}`).orderByKey()
          .startAt(weekStart).endAt(dateKey).get(),
      ]);
      activeDays.forEach((child) => {
        if (isStudyDayActive(child.val())) studyDates.push(child.key!);
      });

      const ledgerData = ledgerSnap.val() ?? {};

      const ledger = Object.entries(ledgerData)
        .flatMap(([entryId, value]) => {
          if (
            value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
          ) {
            return [];
          }

          const item = value as Record<string, unknown>;

          if (
            typeof item.delta !== "number" ||
      !Number.isSafeInteger(item.delta)
          ) {
            return [];
          }

          if (
            typeof item.label !== "string" ||
      item.label.trim().length === 0
          ) {
            return [];
          }

          const createdAt = nonNegativeInt(
            item.createdAt
          );

          return [{
            id: entryId,
            label: item.label,
            delta: item.delta,
            createdAt,
          }];
        })
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);

type HistoryResult = {
  attemptId: string;
  mode: "PRACTICE" | "TEST" | "DAILY" | "BATTLE";
  correct: number;
  total: number;
  coins: number;
  outcome: "completed" | "abandoned" |
    "win" | "loss" | "draw" | "left";
  completedAt?: number;
  reviews: [];
};

const modeMap: Record<string, HistoryResult["mode"]> = {
  practice: "PRACTICE",
  test: "TEST",
  daily: "DAILY",
  dailyChallenge: "DAILY",
  dailychallenge: "DAILY",
  PRACTICE: "PRACTICE",
  TEST: "TEST",
  DAILY: "DAILY",
};

const practiceData = practiceHistorySnap.val() ?? {};

const practiceHistory: HistoryResult[] = Object.entries(
  practiceData
).flatMap(([attemptId, value]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return [];
  }

  const item = value as Record<string, unknown>;

  if (
    typeof item.mode !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      modeMap,
      item.mode
    )
  ) {
    return [];
  }

  // Chi lay cac phien da co ket qua cuoi.
  if (
    item.status !== "completed" &&
    item.status !== "abandoned" &&
    item.status !== "expired"
  ) {
    return [];
  }

  const total = nonNegativeInt(item.questionCount);

  if (total === 0) {
    return [];
  }

  const correct = nonNegativeInt(item.correctCount);

  if (correct > total) {
    return [];
  }

  const outcome = item.status === "completed" ?
    "completed" : "abandoned";

  const completedAt =
    nonNegativeInt(item.finishedAt);

  return [{
    attemptId,
    mode: modeMap[item.mode],
    correct,
    total,
    coins: nonNegativeInt(item.coinsAwarded),
    outcome,
    completedAt,
    reviews: [],
  }];
});

const battleHistory: HistoryResult[] = Object.entries(
  battleHistorySnap.val() || {}
).flatMap(([attemptId, value]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  if (!["win", "loss", "draw", "left"].includes(String(item.outcome))) {
    return [];
  }
  return [{
    attemptId, mode: "BATTLE" as const,
    correct: nonNegativeInt(item.correct), total: 10,
    coins: nonNegativeInt(item.coins),
    outcome: item.outcome as "win" | "loss" | "draw" | "left",
    completedAt: nonNegativeInt(item.finishedAt), reviews: [],
    ratingDelta: typeof item.ratingDelta === "number" ? item.ratingDelta : 0,
    opponentName: typeof item.opponentName === "string" ?
      item.opponentName : "",
    opponentCorrect: nonNegativeInt(item.opponentCorrect),
  }];
});

const history = [...practiceHistory, ...battleHistory]
  .sort((a, b) =>
    (b.completedAt ?? 0) - (a.completedAt ?? 0)
  )
  .slice(0, 50);

return {
  serverNow: Date.now(),
  dashboard: {
    rating: nonNegativeInt(stats.rating),
    coins: nonNegativeInt(wallet.coinBalance),
    wins: nonNegativeInt(stats.wins),
    losses: nonNegativeInt(stats.losses),
    draws: nonNegativeInt(stats.draws),
    streak: nonNegativeInt(stats.winStreak),

    // Cac nhom du lieu se duoc bo sung o giai doan 2
    progress,
    daily: {
      status: dailyStatus,
      attemptId: daily?.attemptId ?? null,
    },
    history,
    achievements,
    notifications,
    unreadNotificationCount: counts.unreadCount,
    studyStreak: learningStreak,
    studyDates,
    ledger,
    skills,
  },
};
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }

      console.error("getUserDashboard failed", {
        uid,
        error,
      });

      throw new HttpsError(
        "internal",
        "Unable to load dashboard."
      );
    }
  }
);
