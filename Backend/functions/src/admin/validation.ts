import {HttpsError} from "firebase-functions/v2/https";
import {ListQuery, Page, DateRange} from "./model";
import {allow, choice, data, integer, key, skills, text, Obj} from "./core";
export function query(v: unknown = {}): ListQuery {
  const q = data(v);
  allow(q, [
    "q",
    "status",
    "categoryId",
    "difficulty",
    "mode",
    "page",
    "pageSize",
  ]);
  const out: ListQuery = {};
  for (const field of [
    "q",
    "status",
    "categoryId",
    "difficulty",
    "mode",
  ] as const) {
    if (q[field] !== undefined) {
      out[field] = text(q[field], field, 0, field === "q" ? 120 : 32);
    }
  }
  out.page = q.page === undefined ? 1 : integer(q.page, "page", 1, 10000);
  out.pageSize =
    q.pageSize === undefined ? 10 : integer(q.pageSize, "pageSize", 1, 50);
  if (out.categoryId) {
    choice(out.categoryId, [...skills, "mixed"], "categoryId");
  }
  if (out.status) {
    choice(
      out.status,
      [
        "active",
        "banned",
        "deleted",
        "draft",
        "published",
        "archived",
        "ongoing",
        "completed",
        "abandoned",
      ],
      "status"
    );
  }
  if (out.difficulty) {
    choice(out.difficulty, ["easy", "medium", "hard"], "difficulty");
  }
  if (out.mode) choice(out.mode, ["quick", "daily", "private"], "mode");
  return out;
}
export function paginate<T>(rows: T[], q: ListQuery): Page<T> {
  const pageSize = q.pageSize || 10;
  const page = q.page || 1;
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
  };
}
export const normalize = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
export const matches = (s: string, q?: string): boolean =>
  !q || normalize(s).includes(normalize(q.trim()));
export function range(v: unknown): {
  range: DateRange;
  start: number;
  end: number;
} {
  const r = data(v);
  allow(r, ["from", "to"]);
  const from = text(r.from, "from", 10, 10);
  const to = text(r.to, "to", 10, 10);
  const valid = (s: string): boolean =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(from) || !valid(to)) {
    throw new HttpsError("invalid-argument", "Invalid date range.");
  }
  const start = Date.parse(from + "T00:00:00+07:00");
  const end = Date.parse(to + "T00:00:00+07:00") + 86400000;
  if (start >= end || end - start > 93 * 86400000) {
    throw new HttpsError(
      "invalid-argument",
      "Date range must contain 1 to 93 days."
    );
  }
  return {range: {from, to}, start, end};
}
export function onlyQuery(input: Obj): ListQuery {
  allow(input, ["query"]);
  return query(input.query);
}
export function idInput(input: Obj): string {
  allow(input, ["id"]);
  return key(input.id);
}
