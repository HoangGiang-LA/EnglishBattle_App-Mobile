import {createHash, createHmac, randomUUID} from "node:crypto";
import {HttpsError, CallableRequest, onCall} from "firebase-functions/v2/https";
import {UserRecord as AuthUser} from "firebase-admin/auth";
import {adminAuth, adminDb} from "../config/firebaseAdmin";

export type Obj = Record<string, unknown>;
export function object(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
export function data(v: unknown): Obj {
  if (!object(v)) {
    throw new HttpsError("invalid-argument", "Expected an object.");
  }
  return v;
}
export function allow(v: Obj, keys: string[]): void {
  if (Object.keys(v).some((k) => !keys.includes(k))) {
    throw new HttpsError("invalid-argument", "Unexpected input field.");
  }
}
export function text(v: unknown, field: string, min = 1, max = 128): string {
  if (typeof v !== "string" || v.trim().length < min || v.length > max) {
    throw new HttpsError("invalid-argument", `Invalid ${field}.`);
  }
  return v.trim();
}
export function key(v: unknown, field = "id"): string {
  const s = text(v, field);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new HttpsError("invalid-argument", `Invalid ${field}.`);
  }
  return s;
}
export function choice<T extends string>(
  v: unknown,
  values: readonly T[],
  field: string
): T {
  if (!values.includes(v as T)) {
    throw new HttpsError("invalid-argument", `Invalid ${field}.`);
  }
  return v as T;
}
export const skills = [
  "vocabulary",
  "grammar",
  "listening",
  "reading",
] as const;
export const statuses = ["draft", "published", "archived"] as const;
export const difficulties = ["easy", "medium", "hard"] as const;
export function integer(
  v: unknown,
  field: string,
  min: number,
  max: number
): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new HttpsError("invalid-argument", `Invalid ${field}.`);
  }
  return v;
}
export async function read(path: string, required = true): Promise<Obj> {
  const v: unknown = (await adminDb.ref(path).get()).val();
  if (v === null && !required) return {};
  if (!object(v)) {
    throw new HttpsError(
      "failed-precondition",
      "Source record is missing or invalid.",
      {path}
    );
  }
  return v;
}
// Complete bounded snapshots: NEVER compute totals from a truncated prefix.
export async function collection(
  path: string,
  limit = 500
): Promise<[string, Obj][]> {
  const snap = await adminDb
    .ref(path)
    .orderByKey()
    .limitToFirst(limit + 1)
    .get();
  if (snap.numChildren() > limit) {
    throw new HttpsError(
      "resource-exhausted",
      "Collection exceeds admin snapshot capacity.",
      {path, limit}
    );
  }
  const rows: [string, Obj][] = [];
  snap.forEach((child) => {
    if (!object(child.val())) {
      throw new HttpsError("failed-precondition", "Invalid source row.", {
        path,
      });
    }
    rows.push([child.key!, child.val() as Obj]);
  });
  return rows;
}
export async function requireAdmin(
  request: CallableRequest<unknown>
): Promise<AuthUser> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const bearer = /^Bearer (\S+)$/.exec(
    request.rawRequest.headers.authorization || ""
  );
  if (!bearer) {
    throw new HttpsError("unauthenticated", "A Firebase ID token is required.");
  }
  let user: AuthUser;
  try {
    const decoded = await adminAuth.verifyIdToken(bearer[1], true);
    if (decoded.uid !== request.auth.uid) {
      throw new HttpsError("unauthenticated", "Invalid session.");
    }
    user = await adminAuth.getUser(decoded.uid);
    if (
      decoded.admin !== true ||
      request.auth.token.admin !== true ||
      user.customClaims?.admin !== true ||
      user.disabled
    ) {
      throw new HttpsError(
        "permission-denied",
        "Administrator access required."
      );
    }
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    const code =
      object(error) && typeof error.code === "string" ? error.code : "";
    if (code === "auth/user-disabled") {
      throw new HttpsError("permission-denied", "Account is disabled.");
    }
    if (code.startsWith("auth/")) {
      throw new HttpsError("unauthenticated", "Sign in again.");
    }
    throw new HttpsError(
      "unavailable",
      "Authentication verification unavailable."
    );
  }
  const access = await read(`accountAccess/${user.uid}`, false);
  if (access.status !== "active") {
    throw new HttpsError("permission-denied", "Account access is blocked.");
  }
  return user;
}
export function endpoint(
  handler: (input: Obj, actor: AuthUser) => Promise<Obj>
) {
  return onCall(
    {region: "asia-southeast1", timeoutSeconds: 60, maxInstances: 10},
    async (request) => {
      const actor = await requireAdmin(request);
      const input = data(request.data);
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 48_000) {
        throw new HttpsError("invalid-argument", "Input is too large.");
      }
      try {
        return await handler(input, actor);
      } catch (error) {
        if (error instanceof HttpsError) throw error;
        const code = object(error) ? String(error.code) : "";
        if (code === "auth/email-already-exists") {
          throw new HttpsError("already-exists", "Email is already in use.");
        }
        if (code === "auth/invalid-email") {
          throw new HttpsError("invalid-argument", "Invalid email.");
        }
        if (code === "auth/user-not-found") {
          throw new HttpsError("not-found", "Account not found.");
        }
        console.error("Admin operation failed", {code: code || "unknown"});
        throw new HttpsError(
          "unavailable",
          "Operation could not finish. Retry with the same requestId."
        );
      }
    }
  );
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
export function fingerprint(v: unknown): string {
  return createHash("sha256").update(canonical(v)).digest("hex");
}
export interface Plan {
  updates: Obj;
  result: Obj;
  auth?: {
    uid: string;
    name?: string;
    email?: string;
    disabled?: boolean;
    revoke?: boolean;
    create?: boolean;
  };
}
// No expiring lock: an interrupted worker cannot later overwrite a newer write.
// A hard-killed worker requires operator recovery after its termination is confirmed.
export async function mutate(
  actor: AuthUser,
  action: string,
  input: Obj,
  locks: string[],
  prepare: (now: number, operationId: string) => Promise<Plan>
): Promise<Obj> {
  const requestId = key(input.requestId, "requestId");
  const path = `adminOperations/${actor.uid}/${action.replace(/\./g, "_")}/${requestId}`;
  const opRef = adminDb.ref(path);
  const owner = randomUUID();
  const passwordInput =
    object(input.input) && typeof input.input.password === "string";
  const hmacKey = process.env.ADMIN_REQUEST_HMAC_KEY;
  if (passwordInput && (!hmacKey || hmacKey.length < 32)) {
    throw new HttpsError(
      "failed-precondition",
      "Account creation needs the server request HMAC key configured."
    );
  }
  // Password-bearing requests use a keyed binding, never a plaintext/password hash.
  const hash = passwordInput ?
    createHmac("sha256", hmacKey!).update(canonical(input)).digest("hex") :
    fingerprint(input);
  await opRef.get();
  const reservation = await opRef.transaction((current) => {
    if (
      current &&
      (current.hash !== hash || current.owner || current.resultJson)
    ) {
      return;
    }
    return {
      ...current,
      hash,
      owner,
      createdAt: current?.createdAt || Date.now(),
    };
  });
  let op = reservation.snapshot.val() as Obj;
  if (op?.hash !== hash) {
    throw new HttpsError(
      "already-exists",
      "requestId was used with a different payload."
    );
  }
  if (typeof op.resultJson === "string") return data(JSON.parse(op.resultJson));
  if (!reservation.committed) {
    throw new HttpsError(
      "aborted",
      "Operation is in progress. Retry the same requestId."
    );
  }
  const lockPaths = [...new Set(locks)].sort().map((id) => `adminLocks/${id}`);
  const acquired: string[] = [];
  let plan: Plan | undefined;
  try {
    for (const lockPath of lockPaths) {
      await adminDb.ref(lockPath).get();
      const result = await adminDb
        .ref(lockPath)
        .transaction((v) => (v === null || v === path ? path : undefined));
      if (!result.committed) {
        throw new HttpsError(
          "aborted",
          "Target has another pending operation."
        );
      }
      acquired.push(lockPath);
    }
    op = await read(path);
    if (typeof op.planJson === "string") plan = JSON.parse(op.planJson) as Plan;
    else {
      plan = await prepare(Number(op.createdAt), fingerprint(path));
      await opRef.child("planJson").set(JSON.stringify(plan));
    }
    // Auth and RTDB do not share a transaction. Persist the plan BEFORE touching Auth.
    if (plan.auth) {
      const a = plan.auth;
      if (a.create) {
        const form = data(input.input);
        let existing: AuthUser | undefined;
        try {
          existing = await adminAuth.getUser(a.uid);
        } catch (error) {
          if (!object(error) || error.code !== "auth/user-not-found") {
            throw error;
          }
        }
        if (existing) {
          if (
            existing.email !== a.email ||
            existing.customClaims?.admin === true
          ) {
            throw new HttpsError(
              "failed-precondition",
              "Reserved account identity changed; operator recovery required."
            );
          }
        } else {
          await adminAuth.createUser({
            uid: a.uid,
            email: a.email,
            displayName: a.name,
            password: String(form.password),
            disabled: true,
          });
        }
        await adminDb.ref(`accountAccess/${a.uid}/status`).set("pending");
        await adminAuth.updateUser(a.uid, {disabled: false});
      } else {
        if (a.disabled === true) {
          // Fail closed even if Auth or token revocation subsequently fails.
          const statusPath = `accountAccess/${a.uid}/status`;
          const plannedStatus = plan.updates[statusPath];
          if (plannedStatus === "banned" || plannedStatus === "deleted") {
            await adminDb.ref(statusPath).set(plannedStatus);
          }
        }
        await adminAuth.updateUser(a.uid, {
          ...(a.name !== undefined ? {displayName: a.name} : {}),
          ...(a.email !== undefined ?
            {email: a.email, emailVerified: false} :
            {}),
          ...(a.disabled !== undefined ? {disabled: a.disabled} : {}),
        });
        if (a.revoke) await adminAuth.revokeRefreshTokens(a.uid);
      }
    }
    // A single atomic multi-location update publishes source, audit, operation result and unlock.
    const update: Obj = {
      ...plan.updates,
      [`${path}/resultJson`]: JSON.stringify(plan.result),
      [`${path}/owner`]: null,
      [`${path}/planJson`]: null,
    };
    for (const lockPath of lockPaths) update[lockPath] = null;
    await adminDb.ref().update(update);
    return plan.result;
  } catch (error) {
    // Known failures are retryable by the same request only. Once a plan exists retain target locks.
    const knownAuthRejection =
      object(error) &&
      [
        "auth/email-already-exists",
        "auth/invalid-email",
        "auth/invalid-password",
      ].includes(String(error.code));
    if (!plan || (knownAuthRejection && plan.auth?.disabled === undefined)) {
      await opRef.child("planJson").remove();
      for (const lockPath of acquired) {
        await adminDb.ref(lockPath).get();
        await adminDb
          .ref(lockPath)
          .transaction((v) => (v === null || v === path ? null : undefined));
      }
    }
    if (plan && !knownAuthRejection && !(error instanceof HttpsError)) {
      const notice = adminDb.ref(
        `adminNotifications/${actor.uid}/${fingerprint(path)}`
      );
      try {
        await notice.get();
        await notice.transaction(
          (v) =>
            v || {
              type: "operation_failed",
              title: "Admin operation needs attention",
              body: "An operation could not finish. Retry its original request or ask an operator.",
              operationId: path,
              createdAt: Date.now(),
              page:
                action.startsWith("question") || action.startsWith("content") ?
                  "content" :
                  action.startsWith("user") ?
                    "users" :
                    "dashboard",
            }
        );
      } catch {
        console.error("Admin failure notification unavailable");
      }
    }
    await opRef
      .child("owner")
      .transaction((v) => (v === null || v === owner ? null : undefined));
    throw error;
  }
}
export function audit(
  actor: AuthUser,
  action: string,
  target: string,
  now: number,
  id: string,
  reason = ""
): Obj {
  const day = new Date(now + 7 * 3600000).toISOString().slice(0, 10);
  const entry = {
    actorUid: actor.uid,
    action,
    targetId: target,
    serverAt: now,
    reason,
    result: "success",
  };
  return {
    [`adminAuditLogs/${day}/${id}`]: entry,
    [`adminAuditRecent/${id}`]: entry,
  };
}
