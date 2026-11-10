import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {AdminNotification, AuditEntry, CsvReport, PageId} from "./model";
import {
  allow,
  audit,
  choice,
  collection,
  endpoint,
  key,
  mutate,
  text,
  Obj,
} from "./core";
import {matches, query, range} from "./validation";
import {filterUsers, users} from "./users";
import {filterQuestions, questions, questionSummaries} from "./content";
import {battles, filterBattles, overview} from "./monitoring";
const pages = [
  "dashboard",
  "users",
  "content",
  "battles",
  "analytics",
] as const;
async function notifications(uid: string): Promise<AdminNotification[]> {
  return (await collection(`adminNotifications/${uid}`, 500))
    .map(([id, r]) => {
      if (typeof r.createdAt !== "number" || typeof r.title !== "string") {
        throw new HttpsError(
          "failed-precondition",
          "Notification schema is invalid."
        );
      }
      return {
        id,
        title: r.title,
        body: String(r.body || ""),
        at: r.createdAt,
        read: typeof r.readAt === "number",
        page: choice(r.page || "dashboard", pages, "notification page"),
      };
    })
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
export const adminListNotifications = endpoint(async (input, actor) => {
  allow(input, []);
  return {serverNow: Date.now(), items: await notifications(actor.uid)};
});
export const adminMarkNotificationsRead = endpoint(async (input, actor) => {
  allow(input, ["id", "requestId"]);
  const id = input.id === undefined ? undefined : key(input.id);
  return mutate(
    actor,
    "notifications.read",
    input,
    [`notifications_${actor.uid}`],
    async (now, opId) => {
      const rows = await notifications(actor.uid);
      const targets = id ? rows.filter((r) => r.id === id) : rows;
      if (id && !targets.length) {
        throw new HttpsError("not-found", "Notification not found.");
      }
      const updates: Obj = audit(
        actor,
        "notifications.read",
        id || actor.uid,
        now,
        opId
      );
      for (const row of targets) {
        if (!row.read) {
          updates[`adminNotifications/${actor.uid}/${row.id}/readAt`] = now;
        }
      }
      return {updates, result: {serverNow: now}};
    }
  );
});
export const adminListAudit = endpoint(async (input) => {
  allow(input, ["query"]);
  const q = query(input.query);
  const snap = await adminDb
    .ref("adminAuditRecent")
    .orderByChild("serverAt")
    .limitToLast(200)
    .get();
  const items: AuditEntry[] = [];
  snap.forEach((child) => {
    const r = child.val() as Obj;
    if (
      !r ||
      typeof r.actorUid !== "string" ||
      typeof r.action !== "string" ||
      typeof r.targetId !== "string" ||
      typeof r.serverAt !== "number" ||
      !Number.isFinite(r.serverAt)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Audit projection schema is invalid."
      );
    }
    items.push({
      id: child.key!,
      actor: String(r.actorUid),
      action: String(r.action),
      target: String(r.targetId),
      at: Number(r.serverAt),
      reason: String(r.reason || ""),
    });
  });
  return {
    serverNow: Date.now(),
    items: items
      .filter((r) =>
        matches(`${r.actor} ${r.action} ${r.target} ${r.reason}`, q.q)
      )
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)),
  };
});
export const adminSearch = endpoint(async (input) => {
  allow(input, ["q"]);
  const q = text(input.q, "q", 0, 120);
  if (q.length < 2) return {serverNow: Date.now(), items: []};
  const [people, bank] = await Promise.all([users(), questionSummaries({q})]);
  const items: {
    id: string;
    label: string;
    detail: string;
    page: PageId;
    query: string;
  }[] = [
    ...filterUsers(people, {q})
      .slice(0, 10)
      .map((u) => ({
        id: `user_${u.id}`,
        label: u.name,
        detail: u.email,
        page: "users" as const,
        query: u.code,
      })),
    ...bank.slice(0, 10).map((r) => ({
      id: `question_${r.id}`,
      label: r.prompt.slice(0, 150),
      detail: String(r.meta.displayCode || r.id),
      page: "content" as const,
      query: String(r.meta.displayCode || r.id),
    })),
  ];
  // Search has an explicit user/question scope; missing battle engine cannot suppress these results.
  return {serverNow: Date.now(), items: items.slice(0, 20)};
});
export function csvCell(value: string): string {
  return /^[\s\uFEFF]*[=+@-]/u.test(value) ? "'" + value : value;
}
export const adminExportReport = endpoint(async (input) => {
  allow(input, ["kind", "query", "range"]);
  const kind = choice(
    input.kind,
    ["users", "questions", "battles", "analytics"] as const,
    "kind"
  );
  const q = query(input.query);
  range(input.range);
  let columns: string[];
  let rows: (string | number)[][];
  if (kind === "users") {
    columns = ["ID", "Name", "Email", "Status", "Rating", "Coins"];
    rows = filterUsers(await users(), q).map((u) => [
      u.id,
      u.name,
      u.email,
      u.status,
      u.rating,
      u.coins,
    ]);
  } else if (kind === "questions") {
    columns = ["ID", "Code", "Prompt", "Category", "Status", "Version"];
    rows = filterQuestions(await questions(), q).map((r) => [
      r.id,
      r.code,
      r.prompt,
      r.categoryId,
      r.status,
      r.version,
    ]);
  } else if (kind === "battles") {
    columns = [
      "ID",
      "Code",
      "Player 1",
      "Player 2",
      "Score 1",
      "Score 2",
      "Status",
      "Mode",
    ];
    rows = filterBattles(await battles(), q).map((b) => [
      b.id,
      b.code,
      b.player1Name,
      b.player2Name,
      b.score1,
      b.score2,
      b.status,
      b.mode,
    ]);
  } else {
    const result = await overview({
      range: input.range,
      categoryId: q.categoryId,
    });
    columns = ["Date", "Users", "Lessons", "Battles", "Active"];
    rows = result.series.map((r) => [
      r.date,
      r.users,
      r.lessons,
      r.battles,
      r.active,
    ]);
  }
  if (
    rows.length > 1000 ||
    Buffer.byteLength(JSON.stringify(rows), "utf8") > 1_000_000
  ) {
    throw new HttpsError(
      "resource-exhausted",
      "Report is too large; narrow the filter."
    );
  }
  const report: CsvReport = {
    filename: `english-battle-${kind}.csv`,
    columns,
    rows: rows.map((r) =>
      r.map((cell) => (typeof cell === "string" ? csvCell(cell) : cell))
    ),
  };
  return {serverNow: Date.now(), report};
});
