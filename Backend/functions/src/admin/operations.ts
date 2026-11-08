import {createHash, randomUUID} from "node:crypto";
import {Auth} from "firebase-admin/auth";
import {Database} from "firebase-admin/database";
import {HttpsError, FunctionsErrorCode} from "firebase-functions/v2/https";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {AdminAction, Data, validateAdminResponse} from "./contracts";
import {AdminActor, requireCurrentAdmin} from "./guard";
import {ADMIN_POLICY as P} from "./policy";
import {acquireMembership, releaseMembership} from "./membership";
import {canonicalJson, safeAuditReason} from "./shared";
import {writeAdminAudit} from "./audit";
export {canonicalJson} from "./shared";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const adminOperationId = (uid: string, action: string, requestId: string) =>
  hash(JSON.stringify([uid, action, requestId]));

type Phase = "pending" | "running" | "succeeded" | "failed" | "blocked";
interface Receipt {done?: boolean; external?: boolean; inFlight?: boolean; valueJson?: string}
export interface AdminOperation {
  id: string;
  action: AdminAction;
  actor: AdminActor;
  fingerprint: string;
  handlerVersion: number;
  target: string;
  reason: string;
  inputJson?: string;
  responseJson?: string;
  phase: Phase;
  createdAt: number;
  completedAt?: number;
  owner?: string;
  leaseUntil?: number;
  dueAt?: number;
  cleanupAt?: number;
  attempts: number;
  steps?: Record<string, Receipt>;
  locks?: Record<string, boolean>;
  errorCode?: FunctionsErrorCode;
  failureReason?: string;
  compacted?: boolean;
}

export interface OperationContext {
  id: string;
  actor: AdminActor;
  createdAt: number;
  /** Stable Auth UID/content ID for creates, allocated before any effect. */
  resourceId: string;
  acquireLock(resource: string): Promise<void>;
  /** Only replay-safe, deterministic RTDB/index effects belong here. */
  step<T>(name: string, apply: () => Promise<T>): Promise<T>;
  /** Unknown Auth/email outcomes hold the resource for operator review. */
  externalStep(name: string, apply: () => Promise<void>): Promise<void>;
  /** Pure transaction reducer, revision check and durable receipt together. */
  mutateRecord(name: string, path: string, expectedRevision: number,
    update: (current: Data) => Data): Promise<void>;
}
export interface OperationHandler {
  version: number;
  lockMembership?: boolean;
  target(data: Data, operationId: string, actor: AdminActor): string;
  run(context: OperationContext, data: Data): Promise<Data>;
}
export type OperationHandlers = Partial<Record<AdminAction, OperationHandler>>;
/** Only throw after a handler has proved no external effect or completed compensation. */
export class SafeOperationError extends HttpsError {}

const pendingError = (id: string, reason = "operation-pending") =>
  new HttpsError("aborted", "Retry with the same requestId and payload.", {
    operationId: id, reason, retryAfterMs: 2000,
  });
const terminal = (op: AdminOperation) =>
  ["succeeded", "failed", "blocked"].includes(op.phase);

/** Durable orchestration; external systems are deliberately not one transaction. */
export class AdminOperations {
  constructor(
    private readonly auth: Auth,
    private readonly db: Database,
    private readonly handlers: OperationHandlers,
  ) {}

  async execute(action: AdminAction, actor: AdminActor, data: Data): Promise<Data> {
    const handler = this.handlers[action];
    if (!handler) throw new HttpsError("unimplemented", "This admin API is not implemented yet.");
    const id = adminOperationId(actor.uid, action, String(data.requestId));
    const fingerprint = hash(canonicalJson(data));
    const target = handler.target(data, id, actor);
    if (!/^[A-Za-z0-9_:/-]{1,256}$/.test(target)) {
      throw new HttpsError("internal", "Invalid operation target.");
    }
    const ref = this.db.ref(`adminOperations/${id}`);
    const tx = await transactionWithRetry(ref, (current: AdminOperation | null) => {
      if (current) return current;
      return {
        id, action, actor, fingerprint, handlerVersion: handler.version, target,
        reason: safeAuditReason(data.reason, action),
        inputJson: canonicalJson({...data, ...(data.reason ? {reason: safeAuditReason(data.reason, action)} : {})}),
        phase: "pending", createdAt: Date.now(), dueAt: Date.now(), attempts: 0,
      };
    });
    const op = tx.snapshot.val() as AdminOperation;
    if (op.fingerprint !== fingerprint) {
      throw new HttpsError("already-exists", "requestId was already used with another payload.", {
        reason: "request-id-conflict", operationId: id,
      });
    }
    if (op.compacted) {
      throw new HttpsError("failed-precondition", "The stored result expired. Read the resource to verify it.", {
        reason: "operation-result-expired", operationId: id,
      });
    }
    return this.process(id);
  }

  private async auditAndRelease(op: AdminOperation): Promise<void> {
    const entry = {
      id: op.id, operationId: op.id, actor: op.actor.uid, action: op.action,
      target: op.target, at: op.completedAt!, reason: op.reason,
      result: op.phase, ...(op.errorCode ? {errorCode: op.errorCode} : {}),
      expiresAt: op.completedAt! + P.auditMs,
    };
    // Deterministic key and create-once transaction: retry never duplicates audit.
    await writeAdminAudit(this.db, op.id, entry);
    await transactionWithRetry(this.db.ref(`adminOperations/${op.id}`), (current) => {
      if (!current) return current;
      if (!terminal(current)) return;
      return {...current, dueAt: null, cleanupAt: current.phase === "blocked" ? null :
        current.completedAt + P.operationDataMs};
    });
    // Partially applied/ambiguous operations deliberately retain their target lock.
    if (op.phase !== "blocked") {
      for (const key of new Set([hash(op.target), ...Object.keys(op.locks || {})])) {
        await transactionWithRetry(this.db.ref(`adminResourceLocks/${key}`), (current) =>
          !current || current.operationId === op.id ? null : undefined);
      }
      await releaseMembership(this.db, op.id);
    }
  }

  private replay(op: AdminOperation): Data {
    if (op.phase === "succeeded" && op.responseJson) return JSON.parse(op.responseJson);
    throw new HttpsError(op.phase === "blocked" ? "failed-precondition" : op.errorCode || "internal",
      op.phase === "blocked" ? "Operation requires server-side review." : "Operation was rejected.", {
        operationId: op.id, reason: op.failureReason || "operation-rejected",
        operationPhase: op.phase,
      });
  }

  async process(id: string): Promise<Data> {
    const ref = this.db.ref(`adminOperations/${id}`);
    const initial = (await ref.get()).val() as AdminOperation | null;
    if (!initial) throw new HttpsError("not-found", "Operation not found.");
    if (initial.compacted) {
      throw new HttpsError("failed-precondition", "The stored result expired.", {reason: "operation-result-expired"});
    }
    if (terminal(initial)) {
      await this.auditAndRelease(initial);
      return this.replay(initial);
    }
    const handler = this.handlers[initial.action];
    if (!handler || handler.version !== initial.handlerVersion) {
      await transactionWithRetry(ref, (current) => {
        if (!current) return current;
        if (terminal(current) || current.leaseUntil > Date.now()) return;
        return {...current, dueAt: Date.now() + P.leaseMs};
      });
      throw pendingError(id, "handler-unavailable");
    }
    const owner = randomUUID();
    const lease = await transactionWithRetry(ref, (current: AdminOperation | null) => {
      // Returning null probes the server CAS; undefined would abort on an empty
      // local cache even though a durable operation already exists remotely.
      if (!current) return current;
      if (terminal(current) || (current.leaseUntil || 0) > Date.now()) return;
      return {...current, phase: "running", owner, leaseUntil: Date.now() + P.leaseMs,
        dueAt: Date.now() + P.leaseMs, attempts: current.attempts + 1};
    });
    if (!lease.committed || lease.snapshot.val()?.owner !== owner) throw pendingError(id);
    const op = lease.snapshot.val() as AdminOperation;
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void transactionWithRetry(ref, (current) => {
        if (!current) return current;
        if (current?.owner !== owner || current.phase !== "running" || current.leaseUntil <= Date.now()) return;
        return {...current, leaseUntil: Date.now() + P.leaseMs, dueAt: Date.now() + P.leaseMs};
      }).catch(() => {/* Ownership is checked again before each effect. */})
        .finally(() => {
          heartbeatBusy = false;
        });
    }, P.leaseMs / 4);
    heartbeat.unref();

    const check = async () => {
      const current = (await ref.get()).val() as AdminOperation;
      if (current?.owner !== owner || current.phase !== "running" || current.leaseUntil! <= Date.now()) {
        throw pendingError(id, "lease-lost");
      }
      await requireCurrentAdmin(this.auth, this.db, op.actor);
    };
    const runStep = async <T>(name: string, apply: () => Promise<T>, external: boolean): Promise<T> => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error("Invalid step name");
      await check();
      const receipt = (await ref.child(`steps/${name}`).get()).val() as Receipt | null;
      if (receipt?.done) return JSON.parse(receipt.valueJson || "null") as T;
      if (receipt?.inFlight && receipt.external) {
        throw new HttpsError("failed-precondition", "External outcome needs review.", {reason: "external-outcome-unknown"});
      }
      if (external) {
        await transactionWithRetry(ref, (current) => {
          if (!current) return current;
          if (current?.owner !== owner || current.phase !== "running" || current.leaseUntil <= Date.now()) return;
          return {...current, steps: {...current.steps, [name]: {external: true, inFlight: true}}};
        });
        await check();
      }
      const value = await apply();
      if (external && value !== undefined) {
        // Do not persist Auth records, credentials or password-reset links.
        throw new Error("External steps must not return a value");
      }
      await check();
      const done = await transactionWithRetry(ref, (current) => {
        if (!current) return current;
        if (current?.owner !== owner || current.phase !== "running" || current.leaseUntil <= Date.now()) return;
        return {...current, steps: {...current.steps,
          [name]: {done: true, external, valueJson: JSON.stringify(value ?? null)}}};
      });
      if (!done.committed) throw pendingError(id, "lease-lost");
      return value;
    };

    try {
      await check();
      // Always acquire membership BEFORE a user lock, including in the CLI.
      if (handler.lockMembership) await acquireMembership(this.db, id);
      const lock = await transactionWithRetry(this.db.ref(`adminResourceLocks/${hash(op.target)}`), (current) => {
        if (current && current.operationId !== id) return;
        return {operationId: id, createdAt: op.createdAt};
      });
      if (!lock.committed) throw pendingError(id, "target-busy");
      const context: OperationContext = {
        id, actor: op.actor, createdAt: op.createdAt, resourceId: `admin_${id.slice(0, 40)}`,
        acquireLock: async (resource) => {
          await check();
          const key = hash(resource);
          await transactionWithRetry(ref, (current) => {
            if (!current) return current;
            if (current.owner !== owner || current.phase !== "running") return;
            return {...current, locks: {...current.locks, [key]: true}};
          });
          await check();
          const locked = await transactionWithRetry(this.db.ref(`adminResourceLocks/${key}`), (current) => {
            if (current && current.operationId !== id) return;
            return {operationId: id, createdAt: op.createdAt};
          });
          if (!locked.committed) throw pendingError(id, "resource-busy");
        },
        step: (name, apply) => runStep(name, apply, false),
        externalStep: (name, apply) => runStep(name, apply, true),
        mutateRecord: async (name, path, expectedRevision, update) => {
          if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+$/.test(path) ||
              !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            throw new Error("Invalid record mutation");
          }
          await runStep(name, async () => {
            const receiptKey = hash(`${id}:${name}`);
            const tx = await transactionWithRetry(this.db.ref(path), (current) => {
              if (current?._adminApplied?.[receiptKey]) return current;
              if (Number(current?.revision || 0) !== expectedRevision) return current;
              const next = update(current || {});
              return {...next, revision: expectedRevision + 1,
                _adminApplied: {...current?._adminApplied, [receiptKey]: true}};
            });
            if (!tx.snapshot.val()?._adminApplied?.[receiptKey]) {
              throw new HttpsError("failed-precondition", "The record has changed.", {reason: "version-conflict"});
            }
          }, false);
        },
      };
      const payload = await handler.run(context, JSON.parse(op.inputJson!));
      const response = {...payload, serverNow: Date.now(), operationId: id};
      validateAdminResponse(op.action, response);
      await check();
      const completed = await transactionWithRetry(ref, (current) => {
        if (!current) return current;
        if (current?.owner !== owner || current.phase !== "running" || current.leaseUntil <= Date.now()) return;
        return {...current, phase: "succeeded", responseJson: JSON.stringify(response),
          completedAt: Date.now(), owner: null, leaseUntil: null, dueAt: Date.now()};
      });
      if (!completed.committed) throw pendingError(id, "lease-lost");
      await this.auditAndRelease(completed.snapshot.val());
      return response;
    } catch (error) {
      const known = error instanceof HttpsError;
      const code = known ? error.code : "unavailable";
      const reason = known ? (error.details as Data | undefined)?.reason : undefined;
      const terminalError = ["invalid-argument", "already-exists", "not-found", "permission-denied",
        "unauthenticated", "failed-precondition", "resource-exhausted"].includes(code);
      const failed = await transactionWithRetry(ref, (current: AdminOperation | null) => {
        if (!current) return current;
        if (current?.owner !== owner || current.phase !== "running") return;
        const uncertain = Object.values(current.steps || {}).some((s) => s.inFlight && s.external);
        const progressed = Object.values(current.steps || {}).some((s) => s.done);
        const blocked = !(error instanceof SafeOperationError) && (uncertain || (terminalError && progressed));
        return {...current, phase: blocked ? "blocked" : terminalError ? "failed" : "pending",
          errorCode: code, failureReason: uncertain && !(error instanceof SafeOperationError) ? "external-outcome-unknown" :
            ["version-conflict", "session-revoked", "last-active-admin", "account-deleted",
              "email-already-exists", "admin-self-protection", "invitation-busy", "invalid-content-relation",
              "parent-not-published", "idioms-belongs-to-vocabulary", "content-has-children",
              "duplicate-content-title", "invalid-published-question", "invalid-stored-content",
              "report-too-large", "report-timeout", "report-expired", "report-privacy-changed",
              "overview-not-ready", "overview-stale", "overview-history-incomplete", "overview-skill-history-incomplete",
              "snapshot-expired", "snapshot-required", "user-index-not-ready", "question-index-not-ready",
              "monitoring-index-not-ready",
              "immutable-version-conflict", "unsupported-audio-content"].includes(String(reason)) ? reason :
              blocked ? "partial-operation-needs-review" : "operation-rejected",
          completedAt: terminalError || blocked ? Date.now() : null,
          owner: null, leaseUntil: null, dueAt: Date.now() + (terminalError || blocked ? 0 : 2000)};
      });
      const state = failed.snapshot.val() as AdminOperation;
      if (state && terminal(state)) {
        await this.auditAndRelease(state);
        return this.replay(state);
      }
      throw pendingError(id);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
