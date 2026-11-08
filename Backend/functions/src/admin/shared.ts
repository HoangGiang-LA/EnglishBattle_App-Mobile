import {createHash} from "node:crypto";

/** Stable serialization shared by operations, cursors and derived event identities. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
export const adminKey = (...parts: unknown[]) => createHash("sha256").update(canonicalJson(parts)).digest("hex");
export const normalizeAdminSearch = (value: string) => value.normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase().trim();

export const safeAuditReason = (value: unknown, fallback = "Administrative action") => {
  const text = typeof value === "string" ? value.trim().slice(0, 500) : fallback;
  const sensitive = /(?:bearer\s|password|passwd|token|private[_ -]?key|-----BEGIN)/i.test(text) ||
    /eyJ[\w-]+\.[\w-]+\.[\w-]*|gh[pousr]_|github_pat_/i.test(text);
  return sensitive ?
    "[redacted sensitive reason]" : text;
};
