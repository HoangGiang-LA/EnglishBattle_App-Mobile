import Ajv, {ValidateFunction} from "ajv";
import {HttpsError} from "firebase-functions/v2/https";
import {ADMIN_POLICY as P} from "./policy";

type Schema = Record<string, unknown>;
export type Data = Record<string, unknown>;
const object = (properties: Schema, required = Object.keys(properties)) => ({
  type: "object", additionalProperties: false, properties, required,
});
const text = (maxLength: number, minLength = 0) => ({
  type: "string", minLength, maxLength,
});
const nonempty = (max: number) => ({...text(max, 1), pattern: "\\S"});
const enumeration = (...values: string[]) => ({type: "string", enum: values});
const integer = (minimum = 0) => ({type: "integer", minimum});
const array = (items: Schema, maxItems: number) => ({
  type: "array", items, maxItems,
});
const ref = (name: string) => ({$ref: `#/$defs/${name}`});
const id = {type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$"};
const revision = integer();
const skill = enumeration("vocabulary", "grammar", "reading", "listening");
const contentStatus = enumeration("draft", "published", "archived");
const userStatus = enumeration("active", "banned", "deleted");
const difficulty = enumeration("easy", "medium", "hard");
const battleStatus = enumeration("ongoing", "completed", "abandoned");
const mode = enumeration("quick", "daily", "private");
const pageId = enumeration("dashboard", "users", "content", "battles", "analytics");
const email = {...text(254, 3), pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"};
const nullableNumber = {anyOf: [{type: "number"}, {type: "null"}]};
const mixedSkill = {anyOf: [skill, {const: "mixed"}]};
const reason = nonempty(500);
const option = object({id: {...id, pattern: "^[A-Za-z_][A-Za-z0-9_-]{0,127}$"}, text: nonempty(2000)});
const queryBase = {
  q: text(100), page: {...integer(1), maximum: P.maxPage},
  pageSize: {type: "integer", enum: [10, 20, 50]},
  cursor: text(512, 1), snapshotId: id,
};
const query = (extra: Schema) => object({...queryBase, ...extra}, []);
const userInput = object({name: nonempty(100), email});
const questionFields = {
  categoryId: skill, topicId: id, lessonId: id, prompt: nonempty(10000),
  options: {...array(option, 4), minItems: 4}, correctOptionId: id,
  explanation: text(20000), passage: text(30000),
  audioUrl: {const: ""}, audioText: text(20000),
  difficulty, status: contentStatus,
};
const questionInput = object(questionFields);
const contentInput = object({
  kind: enumeration("category", "topic", "lesson"), id,
  title: nonempty(200), description: text(5000), status: contentStatus,
  categoryId: skill, topicId: id, difficulty,
}, ["kind", "title", "description", "status"]);
const category = object({
  id: skill, name: nonempty(200), description: text(5000),
  status: contentStatus, revision,
});
const topic = object({
  id, categoryId: skill, title: nonempty(200), description: text(5000),
  status: contentStatus, revision,
});
const lesson = object({
  id, topicId: id, title: nonempty(200), description: text(5000),
  difficulty, status: contentStatus, revision,
});
const audit = object({
  id, actor: id, action: text(64, 1), target: text(256, 1),
  at: integer(), reason: text(500), operationId: id,
  result: enumeration("succeeded", "failed", "blocked"),
  errorCode: text(64),
}, ["id", "actor", "action", "target", "at", "reason", "operationId", "result"]);
const activity = object({
  id, userId: id, text: text(1000), type: enumeration("battle", "lesson", "user"),
  at: integer(), categoryId: mixedSkill, answered: integer(), correct: integer(),
  completed: {type: "boolean"}, userName: text(100),
  sourceId: id, outcome: enumeration("registered", "completed", "abandoned", "win", "loss", "draw", "left"),
}, ["id", "userId", "text", "type", "at", "categoryId", "answered", "correct", "completed", "userName"]);
const battle = object({
  id, code: text(150), player1: id, player2: id,
  player1Name: text(100), player2Name: text(100),
  score1: integer(), score2: integer(), status: battleStatus, mode,
  categoryId: mixedSkill, startedAt: integer(),
  endedAt: {anyOf: [integer(), {type: "null"}]},
  logs: array(object({id, at: integer(), type: text(64), message: text(1000), actorId: id},
    ["id", "at", "type", "message"]), 1000),
  endReason: text(128),
  createdAt: integer(), playStartedAt: {anyOf: [integer(), {type: "null"}]},
  phase: enumeration("ready", "playing", "reconnecting", "completed"),
  questionCount: {...integer(1), maximum: 10}, roundTimeLimitSeconds: {const: 30},
  settlementStatus: enumeration("not_due", "pending", "settled"),
  outcome1: {anyOf: [enumeration("win", "loss", "draw", "left"), {type: "null"}]},
  outcome2: {anyOf: [enumeration("win", "loss", "draw", "left"), {type: "null"}]},
}, ["id", "code", "player1", "player2", "player1Name", "player2Name", "score1",
  "score2", "status", "mode", "categoryId", "startedAt", "endedAt", "logs"]);
const user = object({
  id, code: text(150), name: nonempty(100), email: {anyOf: [email, {const: ""}]}, status: userStatus,
  createdAt: integer(), updatedAt: integer(), rating: integer(), coins: integer(),
  reason: text(500), revision,
  pendingOperation: id,
  invitationStatus: enumeration("not_requested", "pending", "sending", "sent", "failed", "unknown"),
}, ["id", "code", "name", "email", "status", "createdAt", "updatedAt",
  "rating", "coins", "revision"]);
const profile = object({
  id, name: nonempty(100), email, role: {const: "administrator"}, revision,
});
const overview = object({
  totalUsers: integer(), newUsers: integer(), activeUsers: integer(),
  completedBattles: integer(), completedLessons: integer(),
  growth: object({users: nullableNumber, active: nullableNumber, battles: nullableNumber}),
  series: array(object({
    date: text(10, 10), users: integer(), previous: integer(),
    lessons: integer(), battles: integer(), active: integer(),
  }), P.maxRangeDays),
  categories: array(object({
    id: skill, name: text(200), lessons: integer(), battles: integer(),
    answered: integer(), correct: integer(), completed: integer(), started: integer(),
  }), 4),
  accuracy: nullableNumber, completion: nullableNumber,
  recent: array(ref("activity"), 50), asOf: integer(),
  ready: {const: true}, lagMs: integer(),
});

export const adminDefinitions = {
  user, profile, category, topic, lesson, activity, battle, audit, overview,
  participant: object({id, code: text(150), name: nonempty(100), status: userStatus}),
  question: object({
    ...questionFields, id, code: text(150), version: integer(1),
    createdAt: integer(), updatedAt: integer(),
  }),
  catalog: object({
    categories: array(ref("category"), 4), topics: array(ref("topic"), 500),
    lessons: array(ref("lesson"), 5000),
  }),
  notification: object({
    id, title: text(200), body: text(2000), at: integer(),
    read: {type: "boolean"}, page: pageId,
  }),
  searchItem: object({
    id, label: text(200), detail: text(500),
    page: enumeration("users", "content", "battles"), query: text(150),
  }),
  report: object({
    filename: {type: "string", pattern: "^[A-Za-z0-9_-]+\\.csv$", maxLength: 100},
    columns: {...array(text(100, 1), 50), minItems: 1},
    rows: array(array({anyOf: [{type: "string"}, {type: "number"}]}, 50), P.maxExportRows),
    total: integer(), expiresAt: integer(),
  }),
  range: object({
    from: {type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$"},
    to: {type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$"},
  }),
  usersQuery: query({status: userStatus}),
  questionsQuery: query({status: contentStatus, categoryId: skill, difficulty}),
  battlesQuery: query({status: battleStatus, mode, categoryId: mixedSkill, range: ref("range")}),
  activitiesQuery: query({type: enumeration("user", "lesson", "battle"), categoryId: mixedSkill, range: ref("range")}),
  auditQuery: query({actor: id, action: text(64, 1), result: audit.properties.result,
    range: ref("range")}),
  notificationsQuery: query({unreadOnly: {type: "boolean"}}),
};

const page = (item: string, maxItems = 50) => object({
  items: array(ref(item), maxItems), total: integer(), page: {...integer(1), maximum: P.maxPage},
  pageSize: {type: "integer", enum: [10, 20, 50]}, snapshotId: id, expiresAt: integer(),
  nextCursor: {anyOf: [text(512, 1), {type: "null"}]},
  asOf: integer(), lagMs: integer(), ready: {const: true},
}, ["items", "total", "page", "pageSize", "snapshotId", "expiresAt", "nextCursor"]);
const envelope = (payloadKey?: string, payload?: Schema, write = false) => object({
  serverNow: integer(), ...(write ? {operationId: id} : {}),
  ...(payloadKey ? {[payloadKey]: payload} : {}),
});
const request = (fields: Schema, required = Object.keys(fields)) => object(fields, required);
const writeFields = {requestId: id, reason};

export const adminContracts = {
  adminGetProfile: {request: request({}), response: envelope("profile", ref("profile"))},
  adminUpdateProfile: {
    request: request({...writeFields, name: nonempty(100), expectedRevision: revision},
      ["requestId", "name", "expectedRevision"]),
    response: envelope("profile", ref("profile"), true), operation: true,
  },
  adminGetOverview: {
    request: request({range: ref("range"), categoryId: skill,
      granularity: enumeration("day", "week", "month")}, ["range"]),
    response: envelope("overview", ref("overview")),
  },
  adminListUsers: {request: request({query: ref("usersQuery")}), response: envelope("page", page("user"))},
  adminGetUser: {request: request({id}), response: envelope("user", ref("user"))},
  adminSaveUser: {
    request: request({...writeFields, input: userInput, id, expectedRevision: revision,
      resendInvitation: {type: "boolean"}}, ["requestId", "input"]),
    response: envelope("user", ref("user"), true), operation: true,
  },
  adminSetUserStatus: {
    request: request({...writeFields, id, status: userStatus, expectedRevision: revision}),
    response: envelope(undefined, undefined, true), operation: true,
  },
  adminListQuestions: {request: request({query: ref("questionsQuery")}), response: envelope("page", page("question"))},
  adminGetQuestion: {request: request({id}), response: envelope("question", ref("question"))},
  adminSaveQuestion: {
    request: request({...writeFields, input: questionInput, id, expectedVersion: integer(1)}, ["requestId", "input"]),
    response: envelope("question", ref("question"), true), operation: true,
  },
  adminArchiveQuestion: {
    request: request({...writeFields, id, expectedVersion: integer(1)}, ["requestId", "id", "expectedVersion"]),
    response: envelope(undefined, undefined, true), operation: true,
  },
  adminGetCatalog: {request: request({}), response: envelope("catalog", ref("catalog"))},
  adminSaveContent: {
    request: request({...writeFields, input: contentInput, expectedRevision: revision}, ["requestId", "input"]),
    response: envelope(undefined, undefined, true), operation: true,
  },
  adminListBattles: {request: request({query: ref("battlesQuery")}), response: envelope("page", page("battle"))},
  adminGetBattle: {
    request: request({id}), response: envelope("detail", object({
      battle: ref("battle"), player1: ref("participant"), player2: ref("participant"),
    })),
  },
  adminListActivities: {request: request({query: ref("activitiesQuery")}), response: envelope("page", page("activity"))},
  adminSearch: {request: request({q: nonempty(100)}), response: envelope("items", array(ref("searchItem"), 20))},
  adminListNotifications: {
    request: request({query: ref("notificationsQuery")}, []), response: envelope("page", page("notification")),
  },
  adminMarkNotificationsRead: {
    request: request({...writeFields, id, throughAt: integer()}, ["requestId"]),
    response: envelope(undefined, undefined, true), operation: true,
  },
  adminListAudit: {request: request({query: ref("auditQuery")}, []), response: envelope("page", page("audit"))},
  adminExportReport: {
    request: request({...writeFields, kind: enumeration("users", "questions", "battles", "analytics"),
      query: {type: "object"}, range: ref("range")}, ["requestId", "kind", "query", "range"]),
    response: envelope("report", ref("report"), true), operation: true,
  },
} satisfies Record<string, {request: Schema; response: Schema; operation?: boolean}>;

export type AdminAction = keyof typeof adminContracts;
export const adminActions = Object.keys(adminContracts) as AdminAction[];
export const isOperation = (action: AdminAction): boolean =>
  "operation" in adminContracts[action];

const ajv = new Ajv({allErrors: true, ownProperties: true, strict: false});
const validators = new Map<string, ValidateFunction>();
const validate = (key: string, schema: Schema, value: unknown) => {
  if (!validators.has(key)) {
    validators.set(key, ajv.compile({$defs: adminDefinitions, ...schema}));
  }
  return validators.get(key)!(value);
};

/** Inclusive Vietnamese calendar days, converted once at the API boundary. */
export const adminRange = (value: unknown) => {
  const range = value as {from?: string; to?: string};
  const from = Date.parse(`${range?.from}T00:00:00+07:00`);
  const to = Date.parse(`${range?.to}T00:00:00+07:00`);
  const localDay = (n: number) => new Date(n + 7 * 3600000).toISOString().slice(0, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) ||
      localDay(from) !== range.from || localDay(to) !== range.to ||
      to < from || (to - from) / 86400000 + 1 > P.maxRangeDays) {
    throw new HttpsError("invalid-argument", "Invalid date range.", {reason: "invalid-range"});
  }
  return {from, until: to + 86400000, days: (to - from) / 86400000 + 1};
};

/** Validate both shape and cross-field constraints; never coerce or strip fields. */
export function validateAdminRequest(action: AdminAction, value: unknown): Data {
  if (Buffer.byteLength(JSON.stringify(value) || "", "utf8") > P.requestBytes ||
      !validate(`${action}:request`, adminContracts[action].request, value)) {
    throw new HttpsError("invalid-argument", "Invalid admin request.", {reason: "invalid-request"});
  }
  const data = value as Data;
  if (action === "adminSaveUser" && data.resendInvitation && !data.id) {
    throw new HttpsError("invalid-argument", "Resend requires an existing user.");
  }
  const q = data.query as Data | undefined;
  if (data.range) adminRange(data.range);
  if (q?.range) adminRange(q.range);
  if (q?.cursor && !q.snapshotId) {
    throw new HttpsError("invalid-argument", "A cursor requires its snapshotId.");
  }
  if ((data.id && action === "adminSaveUser" && data.expectedRevision === undefined) ||
      (data.id && action === "adminSaveQuestion" && data.expectedVersion === undefined) ||
      (!data.id && action === "adminSaveUser" && data.expectedRevision !== undefined) ||
      (!data.id && action === "adminSaveQuestion" && data.expectedVersion !== undefined)) {
    throw new HttpsError("invalid-argument", "An edit requires its current revision.");
  }
  if (action === "adminSaveQuestion") {
    const input = data.input as Data;
    const options = input.options as {id: string; text: string}[];
    if (new Set(options.map((o) => o.id)).size !== 4 ||
        new Set(options.map((o) => o.text.normalize("NFKC").trim().toLowerCase())).size !== 4 ||
        !options.some((o) => o.id === input.correctOptionId) ||
        (input.status === "published" &&
          (!(input.explanation as string).trim() ||
          (input.categoryId === "reading" && !(input.passage as string).trim()) ||
          (input.categoryId === "listening" && !(input.audioText as string).trim())))) {
      throw new HttpsError("invalid-argument", "Invalid question content.");
    }
  }
  if (action === "adminSaveContent") {
    const input = data.input as Data;
    if ((input.id && data.expectedRevision === undefined) ||
        (!input.id && data.expectedRevision !== undefined) ||
        (input.kind === "category" && !["vocabulary", "grammar", "reading", "listening"].includes(String(input.id))) ||
        (input.kind === "topic" && !input.categoryId) ||
        (input.kind === "lesson" && (!input.topicId || !input.difficulty))) {
      throw new HttpsError("invalid-argument", "Invalid content relation or revision.");
    }
  }
  if (action === "adminMarkNotificationsRead" && (!!data.id === (data.throughAt !== undefined))) {
    throw new HttpsError("invalid-argument", "Select an ID or a read-all cutoff.");
  }
  if (action === "adminExportReport") {
    const kind = String(data.kind);
    const schema = kind === "analytics" ? object({categoryId: skill}, []) : ref(`${kind}Query`);
    if (!validate(`export:${kind}`, schema, data.query) ||
        ["page", "pageSize", "cursor", "snapshotId"].some((key) => q?.[key] !== undefined)) {
      throw new HttpsError("invalid-argument", "Export requires filters for the complete result set.");
    }
  }
  return data;
}

/** Response allowlists prevent accidental disclosure of private server fields. */
export function validateAdminResponse(action: AdminAction, value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value) || "", "utf8") > P.responseBytes ||
      !validate(`${action}:response`, adminContracts[action].response, value)) {
    throw new HttpsError("internal", "Invalid admin response.");
  }
  const pageValue = (value as Data).page as Data | undefined;
  if (pageValue && ((pageValue.items as unknown[]).length > Number(pageValue.pageSize) ||
      Number(pageValue.total) < (pageValue.items as unknown[]).length)) {
    throw new HttpsError("internal", "Invalid admin page.");
  }
  if (action === "adminExportReport") {
    const report = (value as Data).report as {rows: unknown[][]; columns: string[]; total: number};
    if (report.rows.length !== report.total || report.rows.some((row) => row.length !== report.columns.length)) {
      throw new HttpsError("internal", "Incomplete admin report.");
    }
  }
}
