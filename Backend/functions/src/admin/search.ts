import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {Data} from "./contracts";
import {adminScanLimits} from "./pages";
import {adminKey, normalizeAdminSearch} from "./shared";
import {readAdminUser} from "./userModel";

/** Search existing private indexes; only route-safe, whitelisted result DTOs leave the server. */
export async function searchAdmin(value: string) {
  const q = normalizeAdminSearch(value);
  const items: Array<Data & {rank: number}> = [];
  for (const kind of ["users", "questions", "battles"] as const) {
    const path = kind === "users" ? "adminUserIndex" : kind === "questions" ? "adminQuestionIndex" : "adminBattleIndex";
    const meta = kind === "users" ? "adminUserIndexMeta" : kind === "questions" ?
      "adminQuestionIndexMeta" : "adminMonitoringControl/battles";
    const before = (await adminDb.ref(meta).get()).val();
    if (!before?.ready) {
      throw new HttpsError("failed-precondition", "Search indexes are being built.", {
        reason: "search-not-ready",
      });
    }
    if (before.owner || Object.keys(before.writers || {}).length) throw new HttpsError("aborted", "Search index is updating.");
    let after = ""; let rows = 0; let bytes = 0; const deadline = Date.now() + adminScanLimits.ms;
    for (;;) {
      let query = adminDb.ref(path).orderByKey();
      if (after) query = query.startAfter(after);
      const batch = await query.limitToFirst(100).get();
      batch.forEach((child) => {
        const row = child.val(); after = child.key!; rows++;
        bytes += Buffer.byteLength(JSON.stringify(row), "utf8");
        if (rows > adminScanLimits.rows || bytes > adminScanLimits.bytes || Date.now() > deadline) {
          throw new HttpsError("resource-exhausted", "Narrow the search; its index scan is too large.");
        }
        if (row.status === "deleted" || !String(row.searchKey || "").includes(q)) return;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(child.key!) || row.id !== child.key) {
          throw new HttpsError("failed-precondition", "Search index needs review.");
        }
        const rank = [row.id, row.code].some((s) => normalizeAdminSearch(String(s)) === q) ? 0 : 1;
        items.push({id: `search_${adminKey(kind, row.id)}`, label: String(kind === "users" ? row.name :
          kind === "questions" ? row.prompt : row.code).slice(0, 200),
        detail: String(kind === "users" ? row.email : kind === "questions" ? `${row.code} · Question` :
          `Quick battle · ${row.status}`).slice(0, 500),
        page: kind === "questions" ? "content" : kind, query: row.id, rank});
      });
      if (batch.numChildren() < 100) break;
    }
    const end = (await adminDb.ref(meta).get()).val();
    if (!end?.ready || end.owner || Object.keys(end.writers || {}).length ||
        Number(end.version || end.sequence || 0) !== Number(before.version || before.sequence || 0)) {
      throw new HttpsError("aborted", "Search index changed. Retry.");
    }
  }
  items.sort((a, b) => a.rank - b.rank || String(a.id).localeCompare(String(b.id), "en"));
  const result: Data[] = [];
  for (const {rank, ...item} of items) {
    void rank;
    if (item.page === "users") {
      try {
        const user = await readAdminUser(String(item.query), true);
        if (user.status === "deleted") continue;
        item.label = user.name; item.detail = user.email;
      } catch (error) {
        if (error instanceof HttpsError && error.code === "not-found") continue;
        throw error;
      }
    }
    result.push(item);
    if (result.length === 20) break;
  }
  return result;
}
