import {HttpsError} from "firebase-functions/v2/https";
import {BattleRecord, Activity, ListQuery, SkillId, Overview} from "./model";
import {
  allow,
  choice,
  collection,
  data,
  endpoint,
  key,
  read,
  skills,
  text,
  Obj,
} from "./core";
import {
  idInput,
  matches,
  onlyQuery,
  paginate,
  query,
  range,
} from "./validation";
import {filterUsers, user, users} from "./users";
import {catalog} from "./content";

export async function battles(): Promise<BattleRecord[]> {
  const rows = await collection("battleRooms", 500);
  if (!rows.length) {
    // Empty RTDB roots disappear. Do not mistake a missing battle engine for zero activity.
    const source = await read("systemStatus/adminSources/battles", false);
    if (source.initialized !== true || source.schemaVersion !== 1) {
      throw new HttpsError(
        "failed-precondition",
        "Battle source is not initialized by its owner.",
        {reason: "battle-source-unavailable"}
      );
    }
  }
  const out: BattleRecord[] = [];
  for (const [id, r] of rows) {
    const ids = Object.keys(data(r.participants));
    if (
      ids.length !== 2 ||
      typeof r.startedAt !== "number" ||
      typeof r.questionCount !== "number"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Unsupported battle source schema."
      );
    }
    const state = choice(
      r.status,
      ["playing", "reconnecting", "completed", "settled", "abandoned"] as const,
      "battle state"
    );
    const ongoing = state === "playing" || state === "reconnecting";
    const result = await read(`battleResults/${id}`, false);
    if (!ongoing && state !== "abandoned" && result.status !== "settled") {
      throw new HttpsError(
        "failed-precondition",
        "Battle settlement is incomplete."
      );
    }
    const scores = ongoing ?
      data(r.correctCounts) :
      state === "abandoned" && !result.correctCounts ?
        data(r.correctCounts) :
        data(result.correctCounts);
    if (
      ids.some(
        (uid) => typeof scores[uid] !== "number" || Number(scores[uid]) < 0
      )
    ) {
      throw new HttpsError("failed-precondition", "Battle scores unavailable.");
    }
    const [p1, p2] = await Promise.all(ids.map((uid) => user(key(uid))));
    const endedAt = ongoing ? null : Number(result.finishedAt || r.finishedAt);
    if (endedAt !== null && !Number.isFinite(endedAt)) {
      throw new HttpsError(
        "failed-precondition",
        "Battle finish timestamp unavailable."
      );
    }
    out.push({
      id,
      code: String(r.displayCode || id),
      player1: ids[0],
      player2: ids[1],
      player1Name: p1.name,
      player2Name: p2.name,
      score1: Number(scores[ids[0]]),
      score2: Number(scores[ids[1]]),
      status: ongoing ?
        "ongoing" :
        state === "abandoned" ?
          "abandoned" :
          "completed",
      mode: choice(
        r.mode,
        ["quick", "daily", "private"] as const,
        "battle mode"
      ),
      categoryId: choice(
        r.categoryId,
        [...skills, "mixed"] as const,
        "battle category"
      ),
      startedAt: r.startedAt,
      endedAt,
      // Only lifecycle facts; never copy answer_accepted/pending submissions into admin logs.
      logs: [
        {
          id: "started",
          at: r.startedAt,
          type: "started",
          message: "Battle started",
        },
        ...(endedAt ?
          [{id: "ended", at: endedAt, type: "ended", message: "Battle ended"}] :
          []),
      ],
    });
  }
  return out.sort(
    (a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id)
  );
}
export function filterBattles(
  rows: BattleRecord[],
  q: ListQuery
): BattleRecord[] {
  return rows.filter(
    (r) =>
      matches(`${r.id} ${r.code}`, q.q) &&
      (!q.status || q.status === r.status) &&
      (!q.mode || q.mode === r.mode) &&
      (!q.categoryId || q.categoryId === r.categoryId)
  );
}
export const adminListBattles = endpoint(async (input) => {
  const q = onlyQuery(input);
  return {
    serverNow: Date.now(),
    page: paginate(filterBattles(await battles(), q), q),
  };
});
export const adminGetBattle = endpoint(async (input) => {
  const id = idInput(input);
  const battle = (await battles()).find((r) => r.id === id);
  if (!battle) throw new HttpsError("not-found", "Battle not found.");
  return {
    serverNow: Date.now(),
    detail: {
      battle,
      player1: await user(battle.player1),
      player2: await user(battle.player2),
    },
  };
});
type Event = Activity & {
  userName: string;
  participants: string[];
  sourceId: string;
};
export async function activities(): Promise<Event[]> {
  const people = await users();
  const rooms = await battles();
  const out: Event[] = [];
  let count = 0;
  for (const person of people) {
    out.push({
      id: `user_${person.id}`,
      userId: person.id,
      userName: person.name,
      participants: [person.id],
      sourceId: person.id,
      type: "user",
      text: "Account registered",
      at: person.createdAt,
      categoryId: "mixed",
      answered: 0,
      correct: 0,
      completed: true,
    });
    const attempts = await collection(`practiceAttempts/${person.id}`, 200);
    count += attempts.length;
    if (count > 2000) {
      throw new HttpsError(
        "resource-exhausted",
        "Activity snapshot exceeds 2000 attempts."
      );
    }
    for (const [id, r] of attempts) {
      const state = choice(
        r.status,
        ["active", "waiting", "completed", "abandoned"] as const,
        "attempt state"
      );
      const category = skills.includes(r.categoryId as SkillId) ?
        (r.categoryId as SkillId) :
        "mixed";
      const at =
        state === "completed" || state === "abandoned" ?
          r.finishedAt :
          r.startedAt;
      if (
        typeof at !== "number" ||
        typeof r.answeredCount !== "number" ||
        typeof r.correctCount !== "number"
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Attempt aggregates are incomplete."
        );
      }
      out.push({
        id: `lesson_${person.id}_${id}`,
        userId: person.id,
        userName: person.name,
        participants: [person.id],
        sourceId: id,
        type: "lesson",
        text: `${String(r.mode)} session ${state}`,
        at,
        categoryId: category,
        answered: r.answeredCount,
        correct: r.correctCount,
        completed: state === "completed",
      });
    }
  }
  for (const room of rooms) {
    const raw = await read(`battleRooms/${room.id}`);
    const completed = room.status === "completed";
    out.push({
      id: `battle_${room.id}`,
      userId: room.player1,
      userName: room.player1Name,
      participants: [room.player1, room.player2],
      sourceId: room.id,
      type: "battle",
      text: `Battle ${room.status}: ${room.code}`,
      at: room.endedAt || room.startedAt,
      categoryId: room.categoryId,
      answered: completed ? Number(raw.questionCount) * 2 : 0,
      correct: completed ? room.score1 + room.score2 : 0,
      completed,
    });
  }
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
function publicEvent(event: Event): Activity & {userName: string} {
  return {
    id: event.id,
    userId: event.userId,
    userName: event.userName,
    text: event.text,
    type: event.type,
    at: event.at,
    categoryId: event.categoryId,
    answered: event.answered,
    correct: event.correct,
    completed: event.completed,
  };
}
export const adminListActivities = endpoint(async (input) => {
  const q = onlyQuery(input);
  const events = (await activities()).filter(
    (e) =>
      (!q.categoryId || e.categoryId === q.categoryId) &&
      matches(`${e.text} ${e.userName}`, q.q)
  );
  return {serverNow: Date.now(), page: paginate(events.map(publicEvent), q)};
});
export async function overview(input: Obj): Promise<Overview> {
  const {start, end} = range(input.range);
  const categoryId = input.categoryId ?
    choice(input.categoryId, [...skills, "mixed"] as const, "categoryId") :
    "";
  const [people, events, content] = await Promise.all([
    users(),
    activities(),
    catalog(),
  ]);
  const duration = end - start;
  const inRange = (from: number, to: number): Event[] =>
    events.filter(
      (e) =>
        e.at >= from &&
        e.at < to &&
        (!categoryId || e.categoryId === categoryId)
    );
  const current = inRange(start, end);
  const previous = inRange(start - duration, start);
  const active = (rows: Event[]): number =>
    new Set(
      rows.filter((r) => r.type !== "user").flatMap((r) => r.participants)
    ).size;
  const completedBattles = (rows: Event[]): number =>
    rows.filter((r) => r.type === "battle" && r.completed).length;
  const registered = (from: number, to: number): number =>
    people.filter((p) => p.createdAt >= from && p.createdAt < to).length;
  const pct = (n: number, old: number): number | null =>
    old === 0 ? null : Math.round(((n - old) / old) * 1000) / 10;
  const series: Overview["series"] = [];
  for (let at = start; at < end; at += 86400000) {
    const rows = current.filter((e) => e.at >= at && e.at < at + 86400000);
    series.push({
      date: new Date(at + 7 * 3600000).toISOString().slice(0, 10),
      users: people.filter(
        (p) => p.status !== "deleted" && p.createdAt < at + 86400000
      ).length,
      previous: people.filter(
        (p) => p.status !== "deleted" && p.createdAt < at + 86400000 - duration
      ).length,
      lessons: rows.filter((r) => r.type === "lesson" && r.completed).length,
      battles: completedBattles(rows),
      active: active(rows),
    });
  }
  const sessions = current.filter((e) => e.type !== "user");
  const answered = sessions.reduce((n, e) => n + e.answered, 0);
  return {
    totalUsers: people.filter((p) => p.status !== "deleted").length,
    newUsers: registered(start, end),
    activeUsers: active(current),
    completedBattles: completedBattles(current),
    completedLessons: current.filter((e) => e.type === "lesson" && e.completed)
      .length,
    growth: {
      users: pct(registered(start, end), registered(start - duration, start)),
      active: pct(active(current), active(previous)),
      battles: pct(completedBattles(current), completedBattles(previous)),
    },
    series,
    categories: content.categories
      .filter((c) => !categoryId || c.id === categoryId)
      .map((c) => {
        const rows = sessions.filter((e) => e.categoryId === c.id);
        return {
          id: c.id,
          name: c.name,
          lessons: rows.filter((e) => e.type === "lesson" && e.completed)
            .length,
          battles: rows.filter((e) => e.type === "battle").length,
          answered: rows.reduce((n, e) => n + e.answered, 0),
          correct: rows.reduce((n, e) => n + e.correct, 0),
          completed: rows.filter((e) => e.completed).length,
          started: rows.length,
        };
      }),
    accuracy: answered ?
      (sessions.reduce((n, e) => n + e.correct, 0) / answered) * 100 :
      null,
    completion: sessions.length ?
      (sessions.filter((e) => e.completed).length / sessions.length) * 100 :
      null,
    recent: current.slice(0, 5).map(publicEvent),
    asOf: Date.now(),
  };
}
export const adminGetOverview = endpoint(async (input) => {
  allow(input, ["range", "categoryId"]);
  return {serverNow: Date.now(), overview: await overview(input)};
});
// Reusable sources for the remaining read-only endpoints.
export {filterUsers, query, text};
