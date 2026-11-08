import {HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {Data} from "./contracts";
import {AdminActor, requireCurrentAdmin} from "./guard";
import {OperationHandlers, SafeOperationError} from "./operations";
import {listAdminUsers} from "./userIndex";
import {listAdminQuestions} from "./questionIndex";
import {listMonitoring} from "./monitoringIndex";
import {getAdminOverview} from "./analytics";
import {ADMIN_POLICY as P} from "./policy";
import {transactionWithRetry} from "../be1/databaseTransaction";

type Cell = string | number;
interface Report {
  id: string; filename: string; columns: string[]; rows: Cell[][]; total: number; expiresAt: number; asOf: number;
}
export const safeCsvCell = (value: Cell): Cell => {
  // Leading controls must not hide a spreadsheet formula prefix.
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? `'${value}` : value;
};
export const adminCsvText = (columns: string[], rows: Cell[][]) => "\uFEFF" + [columns, ...rows]
  .map((row) => row.map((v) => `"${String(safeCsvCell(v)).replace(/"/g, "\"\"")}"`).join(",")).join("\r\n");
const tooLarge = () => new SafeOperationError("resource-exhausted", "Report exceeds 5,000 rows or 1 MiB.", {
  reason: "report-too-large",
});
const reportMeta = (r: Report) => ({id: r.id, filename: r.filename,
  total: r.total, expiresAt: r.expiresAt, asOf: r.asOf});

async function boundedReportData(uid: string, data: Data) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The timed task only reads/captures snapshots. Artifact publication happens after this await,
    // so a late source response cannot publish a report after the operation timed out.
    return await Promise.race([reportData(uid, data), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SafeOperationError("resource-exhausted", "Report took too long.", {
        reason: "report-timeout",
      })), 20000);
      timer.unref();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function reportData(uid: string, data: Data): Promise<{columns: string[]; rows: Cell[][]; asOf: number}> {
  const kind = String(data.kind); const filters = data.query as Data;
  const deadline = Date.now() + 20000; const capturedAt = Date.now();
  if (kind === "analytics") {
    const overview = await getAdminOverview({range: data.range, categoryId: filters.categoryId,
      granularity: filters.granularity || "day"}, filters.generation as string | undefined);
    const rows: Cell[][] = [];
    const emit = (section: string, date: string, skill: string, metric: string, value: unknown) =>
      rows.push([section, date, skill, metric, value === null ? "N/A" : value as Cell, overview.asOf]);
    for (const name of ["totalUsers", "newUsers", "activeUsers", "completedBattles", "completedLessons",
      "accuracy", "completion"] as const) emit("KPI", "", String(filters.categoryId || "all"), name, overview[name]);
    for (const [name, value] of Object.entries(overview.denominators)) emit("Denominator", "", "", name, value);
    for (const [name, value] of Object.entries(overview.growth)) emit("Growth (%)", "", "", name, value);
    for (const [name, value] of Object.entries(overview.coverage)) {
      emit("Coverage", "", "", name, typeof value === "boolean" ? String(value) : value);
    }
    for (const row of overview.series) {
      for (const name of ["users", "previous", "active", "lessons", "battles"] as const) {
        emit("Series", row.date, String(filters.categoryId || "all"), name, row[name]);
      }
    }
    for (const skill of overview.categories) {
      for (const name of ["lessons", "battles", "answered", "correct", "started", "completed", "completion"] as const) {
        emit("Skill", "", String(skill.id), name, (skill as Data)[name]);
      }
    }
    return {columns: ["Section", "Date (Asia/Ho_Chi_Minh)", "Skill", "Metric", "Value", "As of (epoch ms)"],
      rows, asOf: overview.asOf};
  }
  const all: Data[] = []; let page = 1; let snapshotId: string | undefined;
  let sourceAsOf = capturedAt;
  for (;;) {
    if (Date.now() > deadline) {
      throw new SafeOperationError("resource-exhausted", "Report took too long.", {
        reason: "report-timeout",
      });
    }
    const query = {...filters, pageSize: 50, page, ...(snapshotId ? {snapshotId} : {})};
    const result = kind === "users" ? await listAdminUsers(uid, query) : kind === "questions" ?
      await listAdminQuestions(uid, query) : await listMonitoring("battles", uid, query);
    if (result.total > P.maxExportRows) throw tooLarge();
    if ("asOf" in result) sourceAsOf = Number(result.asOf);
    all.push(...result.items as unknown as Data[]); snapshotId = result.snapshotId;
    if (all.length === result.total) break;
    if (!result.items.length || page >= 100) throw new HttpsError("failed-precondition", "Incomplete report snapshot.");
    page++;
  }
  if (kind === "users") {
    return {columns: ["UID", "ID", "Name", "Email", "Status", "Rating", "Coins", "Joined (UTC)"],
      rows: all.map((u) => [String(u.id), String(u.code), String(u.name), String(u.email), String(u.status),
        Number(u.rating), Number(u.coins), new Date(Number(u.createdAt)).toISOString()]), asOf: sourceAsOf};
  }
  if (kind === "questions") {
    return {columns: ["ID", "Question", "Skill", "Difficulty", "Status", "Version"],
      rows: all.map((q) => [String(q.code), String(q.prompt), String(q.categoryId), String(q.difficulty),
        String(q.status), Number(q.version)]), asOf: sourceAsOf};
  }
  return {columns: ["Match", "Mode", "Player 1", "Player 2", "Score 1", "Score 2", "Status", "End reason", "Started (UTC)"],
    rows: all.map((b) => [String(b.code), String(b.mode), String(b.player1Name), String(b.player2Name),
      Number(b.score1), Number(b.score2), String(b.status), String(b.endReason || ""),
      new Date(Number(b.startedAt)).toISOString()]), asOf: sourceAsOf};
}

/** Every delivery (including a create retry) checks current access, actor ownership, expiry and deletion privacy. */
export async function receiveAdminReport(actor: AdminActor, id: string, rows: boolean) {
  await requireCurrentAdmin(adminAuth, adminDb, actor);
  const record = (await adminDb.ref(`adminReports/${id}`).get()).val();
  if (!record || record.uid !== actor.uid || record.report.expiresAt <= Date.now()) {
    throw new HttpsError("failed-precondition", "Report expired or unavailable. Create it again.", {reason: "report-expired"});
  }
  const privacy = Number((await adminDb.ref("adminUserIndexMeta/privacyRevision").get()).val() || 0);
  if (record.privacyRevision !== privacy) {
    throw new HttpsError("failed-precondition", "Account visibility changed.", {
      reason: "report-privacy-changed",
    });
  }
  return rows ? record.report as Report : reportMeta(record.report);
}

export const reportOperationHandlers: OperationHandlers = {
  adminExportReport: {
    version: 1, target: (data, id) => `report/${String(data.kind)}/${id}`,
    async run(ctx, data) {
      const report = await ctx.step("capture_report", async () => {
        const ref = adminDb.ref(`adminReports/${ctx.id}`);
        const old = (await ref.get()).val();
        if (old) return reportMeta(old.report);
        const privacy = Number((await adminDb.ref("adminUserIndexMeta/privacyRevision").get()).val() || 0);
        const content = await boundedReportData(ctx.actor.uid, data);
        const result: Report = {...content, rows: content.rows.map((r) => r.map(safeCsvCell)), id: ctx.id,
          filename: `english-battle-${String(data.kind)}-${ctx.id.slice(0, 12)}.csv`,
          total: content.rows.length, expiresAt: Date.now() + P.reportMs};
        if (result.total > P.maxExportRows || Buffer.byteLength(adminCsvText(result.columns, result.rows), "utf8") >
            P.maxReportBytes || Buffer.byteLength(JSON.stringify(result), "utf8") > P.responseBytes - 4096) throw tooLarge();
        const current = Number((await adminDb.ref("adminUserIndexMeta/privacyRevision").get()).val() || 0);
        if (current !== privacy) throw new SafeOperationError("aborted", "Account visibility changed during export.");
        const saved = await transactionWithRetry(ref, (c) => c || {uid: ctx.actor.uid, privacyRevision: privacy,
          expiresAt: result.expiresAt, report: result});
        return reportMeta(saved.snapshot.val().report);
      });
      return {report};
    },
  },
};
