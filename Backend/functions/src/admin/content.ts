import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {
  Catalog,
  QuestionRecord,
  QuestionInput,
  SkillId,
  ListQuery,
} from "./model";
import {
  allow,
  audit,
  choice,
  collection,
  data,
  difficulties,
  endpoint,
  fingerprint,
  integer,
  key,
  mutate,
  read,
  skills,
  statuses,
  text,
  Obj,
} from "./core";
import {idInput, matches, onlyQuery, paginate} from "./validation";

export async function catalog(): Promise<Catalog> {
  const [categories, topics, lessons] = await Promise.all([
    collection("categories", 4),
    collection("topics", 300),
    collection("lessons", 500),
  ]);
  if (!categories.length) {
    throw new HttpsError("failed-precondition", "Catalog is not initialized.");
  }
  return {
    categories: categories.map(([id, r]) => ({
      id: choice(id, skills, "stored category"),
      name: String(r.englishName || r.name || ""),
      description: String(r.description || ""),
      status: choice(r.status, statuses, "stored status"),
    })),
    topics: topics.map(([id, r]) => ({
      id,
      categoryId: choice(r.categoryId, skills, "stored category"),
      title: String(r.title || ""),
      description: String(r.description || ""),
      status: choice(r.status, statuses, "stored status"),
    })),
    lessons: lessons.map(([id, r]) => ({
      id,
      topicId: String(r.topicId),
      title: String(r.title || ""),
      description: String(r.description || ""),
      difficulty: choice(r.difficulty, difficulties, "stored difficulty"),
      status: choice(r.status, statuses, "stored status"),
    })),
  };
}
export async function question(
  id: string,
  source?: Obj
): Promise<QuestionRecord> {
  const m = source || (await read(`questions/${id}`, false));
  if (!Object.keys(m).length) {
    throw new HttpsError("not-found", "Question not found.");
  }
  if (
    typeof m.currentVersion !== "string" ||
    !/^v[1-9]\d*$/.test(m.currentVersion)
  ) {
    throw new HttpsError("failed-precondition", "Invalid stored version.");
  }
  const [v, a] = await Promise.all([
    read(`questionVersions/${id}/${m.currentVersion}`),
    read(`questionAnswers/${id}/${m.currentVersion}`),
  ]);
  const asset =
    typeof v.audioAssetId === "string" ?
      await read(`contentAssets/${key(v.audioAssetId)}`) :
      {};
  const options = Object.entries(data(v.options))
    .map(([optionId, option]) => ({
      id: optionId,
      text: String(data(option).text),
      order: Number(data(option).order),
    }))
    .sort((x, y) => x.order - y.order)
    .map(({id: optionId, text: value}) => ({id: optionId, text: value}));
  return {
    id,
    code: String(m.displayCode || id),
    categoryId: choice(m.categoryId, skills, "stored category"),
    topicId: String(m.topicId),
    lessonId: String(m.lessonId || ""),
    prompt: String(v.prompt),
    options,
    correctOptionId: String(a.correctOptionId),
    explanation: String(a.explanation || ""),
    passage: String(v.passage || ""),
    audioUrl: String(v.audioUrl || asset.url || ""),
    audioText: String(v.audioText || asset.speechText || ""),
    difficulty: choice(m.difficulty, difficulties, "stored difficulty"),
    status: choice(m.status, statuses, "stored status"),
    version: Number(m.currentVersion.slice(1)),
    createdAt: Number(m.createdAt),
    updatedAt: Number(m.updatedAt),
  };
}
export async function questionSummaries(
  q: ListQuery
): Promise<{id: string; meta: Obj; prompt: string}[]> {
  const [metadata, projections] = await Promise.all([
    collection("questions", 1000),
    collection("adminViews/questions", 1000),
  ]);
  const views = new Map(projections);
  const rows: {id: string; meta: Obj; prompt: string}[] = [];
  for (const [id, meta] of metadata) {
    if (
      (q.status && meta.status !== q.status) ||
      (q.categoryId && meta.categoryId !== q.categoryId) ||
      (q.difficulty && meta.difficulty !== q.difficulty)
    ) {
      continue;
    }
    const view = views.get(id);
    let prompt: string;
    if (
      view &&
      view.currentVersion === meta.currentVersion &&
      view.updatedAt === meta.updatedAt &&
      typeof view.prompt === "string"
    ) {
      prompt = view.prompt;
    } else {
      const version = text(meta.currentVersion, "stored version");
      if (!/^v[1-9]\d*$/.test(version)) {
        throw new HttpsError("failed-precondition", "Invalid stored version.");
      }
      const canonical = await read(`questionVersions/${id}/${version}`);
      if (typeof canonical.prompt !== "string") {
        throw new HttpsError(
          "failed-precondition",
          "Question prompt source is invalid."
        );
      }
      prompt = canonical.prompt;
    }
    if (matches(`${id} ${String(meta.displayCode || id)} ${prompt}`, q.q)) {
      rows.push({id, meta, prompt});
    }
  }
  return rows.sort(
    (a, b) =>
      Number(b.meta.updatedAt) - Number(a.meta.updatedAt) ||
      a.id.localeCompare(b.id)
  );
}
export async function questions(): Promise<QuestionRecord[]> {
  const rows = await collection("questions", 1000);
  const out: QuestionRecord[] = [];
  for (let i = 0; i < rows.length; i += 20) {
    out.push(
      ...(await Promise.all(
        rows.slice(i, i + 20).map(([id, m]) => question(id, m))
      ))
    );
  }
  return out;
}
export function filterQuestions(
  rows: QuestionRecord[],
  q: ListQuery
): QuestionRecord[] {
  return rows
    .filter(
      (r) =>
        matches(`${r.id} ${r.code} ${r.prompt}`, q.q) &&
        (!q.status || q.status === r.status) &&
        (!q.categoryId || r.categoryId === q.categoryId) &&
        (!q.difficulty || r.difficulty === q.difficulty)
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
async function parents(
  categoryId: SkillId,
  topicId: string,
  lessonId: string,
  published: boolean
): Promise<void> {
  const [category, topic, lesson] = await Promise.all([
    read(`categories/${categoryId}`),
    read(`topics/${topicId}`),
    lessonId ? read(`lessons/${lessonId}`) : Promise.resolve(null),
  ]);
  if (
    topic.categoryId !== categoryId ||
    (lesson && lesson.topicId !== topicId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Content parent relationship does not match."
    );
  }
  if (
    published &&
    (category.status !== "published" ||
      topic.status !== "published" ||
      (lesson && lesson.status !== "published"))
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Publish the parent content first."
    );
  }
}
export function questionInput(raw: unknown): QuestionInput {
  const f = data(raw);
  allow(f, [
    "categoryId",
    "topicId",
    "lessonId",
    "prompt",
    "options",
    "correctOptionId",
    "explanation",
    "passage",
    "audioUrl",
    "audioText",
    "difficulty",
    "status",
  ]);
  if (!Array.isArray(f.options) || f.options.length !== 4) {
    throw new HttpsError(
      "invalid-argument",
      "Exactly four options are required."
    );
  }
  const options = f.options.map((v) => {
    const o = data(v);
    allow(o, ["id", "text"]);
    return {
      id: key(o.id, "option id"),
      text: text(o.text, "option text", 1, 1000),
    };
  });
  if (
    new Set(options.map((o) => o.id)).size !== 4 ||
    new Set(
      options.map((o) =>
        o.text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")
      )
    ).size !== 4
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Option IDs and texts must be distinct."
    );
  }
  const result: QuestionInput = {
    categoryId: choice(f.categoryId, skills, "categoryId"),
    topicId: key(f.topicId, "topicId"),
    lessonId: text(f.lessonId, "lessonId", 0, 128) ?
      key(f.lessonId, "lessonId") :
      "",
    prompt: text(f.prompt, "prompt", 5, 3000),
    options,
    correctOptionId: key(f.correctOptionId, "correctOptionId"),
    explanation: text(f.explanation, "explanation", 0, 5000),
    passage: text(f.passage, "passage", 0, 10000),
    audioUrl: text(f.audioUrl, "audioUrl", 0, 2000),
    audioText: text(f.audioText, "audioText", 0, 5000),
    difficulty: choice(f.difficulty, difficulties, "difficulty"),
    status: choice(f.status, statuses, "status"),
  };
  if (!options.some((o) => o.id === result.correctOptionId)) {
    throw new HttpsError(
      "invalid-argument",
      "Answer must reference an option."
    );
  }
  if (result.audioUrl) {
    let valid = false;
    try {
      const url = new URL(result.audioUrl);
      valid = url.protocol === "https:" && !url.username && !url.password;
    } catch {
      /* validation below */
    }
    if (!valid) {
      throw new HttpsError(
        "invalid-argument",
        "Audio must be an HTTPS URL, never base64."
      );
    }
  }
  if (
    result.status === "published" &&
    (!result.explanation ||
      (result.categoryId === "reading" && !result.passage) ||
      (result.categoryId === "listening" &&
        !result.audioText &&
        !result.audioUrl))
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Published content is incomplete."
    );
  }
  if (
    result.status === "published" &&
    result.categoryId === "listening" &&
    !result.audioText
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Current BE1 playback requires audioText. HTTPS file playback needs a mobile contract update."
    );
  }
  return result;
}
export const adminGetCatalog = endpoint(async (input) => {
  allow(input, []);
  return {serverNow: Date.now(), catalog: await catalog()};
});
export const adminListQuestions = endpoint(async (input) => {
  const q = onlyQuery(input);
  const rows = await questionSummaries(q);
  const selected = paginate(rows, q);
  return {
    serverNow: Date.now(),
    page: {
      ...selected,
      items: await Promise.all(
        selected.items.map((row) => question(row.id, row.meta))
      ),
    },
  };
});
export const adminGetQuestion = endpoint(async (input) => ({
  serverNow: Date.now(),
  question: await question(idInput(input)),
}));
export const adminSaveQuestion = endpoint(async (input, actor) => {
  allow(input, ["input", "id", "expectedVersion", "requestId"]);
  const form = questionInput(input.input);
  const existingId = input.id === undefined ? undefined : key(input.id);
  if (existingId) integer(input.expectedVersion, "expectedVersion", 1, 1000000);
  else if (input.expectedVersion !== undefined) {
    throw new HttpsError(
      "invalid-argument",
      "A new question has no expectedVersion."
    );
  }
  const id =
    existingId ||
    `q_${fingerprint([actor.uid, key(input.requestId)]).slice(0, 24)}`;
  return mutate(
    actor,
    "question.save",
    input,
    ["content"],
    async (now, opId) => {
      await parents(
        form.categoryId,
        form.topicId,
        form.lessonId,
        form.status === "published"
      );
      const previous = existingId ? await question(id) : undefined;
      if (previous && previous.version !== input.expectedVersion) {
        throw new HttpsError("aborted", "Question version changed.", {
          reason: "version-conflict",
          currentVersion: previous.version,
        });
      }
      if (
        previous &&
        previous.options
          .map((o) => o.id)
          .sort()
          .join("|") !==
          form.options
            .map((o) => o.id)
            .sort()
            .join("|")
      ) {
        throw new HttpsError(
          "invalid-argument",
          "Existing option IDs must stay stable."
        );
      }
      const version = previous ? previous.version + 1 : 1;
      const versionKey = `v${version}`;
      if (
        (
          await adminDb.ref(`questionVersions/${id}/${versionKey}`).get()
        ).exists()
      ) {
        throw new HttpsError(
          "already-exists",
          "Immutable version already exists."
        );
      }
      const record: QuestionRecord = {
        ...form,
        id,
        code: previous?.code || `Q-${id.slice(2, 14).toUpperCase()}`,
        version,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };
      const oldMeta = previous ? await read(`questions/${id}`) : {};
      const meta = {
        ...oldMeta,
        displayCode: record.code,
        categoryId: form.categoryId,
        topicId: form.topicId,
        lessonId: form.lessonId,
        difficulty: form.difficulty,
        type: `${form.categoryId === "listening" ? "listening_" : form.categoryId === "reading" ? "reading_" : ""}single_choice`,
        currentVersion: versionKey,
        status: form.status,
        createdAt: record.createdAt,
        updatedAt: now,
      };
      const content = {
        version: versionKey,
        language: "en",
        questionTimeLimitSeconds: 30,
        prompt: form.prompt,
        passage: form.passage,
        audioText: form.audioText,
        audioUrl: form.audioUrl,
        options: Object.fromEntries(
          form.options.map((o, i) => [o.id, {text: o.text, order: i + 1}])
        ),
      };
      const updates: Obj = {
        ...audit(actor, "question.save", id, now, opId),
        [`questions/${id}`]: meta,
        [`questionVersions/${id}/${versionKey}`]: content,
        [`questionAnswers/${id}/${versionKey}`]: {
          correctOptionId: form.correctOptionId,
          explanation: form.explanation,
          explanationLanguage: "vi",
          scoringType: "correct_count",
          correctPoints: 1,
          incorrectPoints: 0,
        },
        [`adminViews/questions/${id}`]: {
          ...meta,
          prompt: form.prompt,
          searchText: form.prompt.toLowerCase(),
        },
      };
      if (previous?.lessonId && previous.lessonId !== form.lessonId) {
        updates[`lessonQuestions/${previous.lessonId}/${id}`] = null;
      }
      if (form.lessonId) {
        const oldLink = await read(
          `lessonQuestions/${form.lessonId}/${id}`,
          false
        );
        updates[`lessonQuestions/${form.lessonId}/${id}`] = {
          ...oldLink,
          order: typeof oldLink.order === "number" ? oldLink.order : now,
          version: versionKey,
          enabled: form.status === "published",
        };
      }
      return {updates, result: {serverNow: now, question: record}};
    }
  );
});
export const adminArchiveQuestion = endpoint(async (input, actor) => {
  allow(input, ["id", "expectedVersion", "requestId"]);
  const id = key(input.id);
  const version = integer(input.expectedVersion, "expectedVersion", 1, 1000000);
  return mutate(
    actor,
    "question.archive",
    input,
    ["content"],
    async (now, opId) => {
      const before = await question(id);
      if (before.version !== version) {
        throw new HttpsError("aborted", "Question version changed.", {
          reason: "version-conflict",
          currentVersion: before.version,
        });
      }
      const nextVersion = "v" + (version + 1);
      const [oldContent, oldAnswer] = await Promise.all([
        read(`questionVersions/${id}/v${version}`),
        read(`questionAnswers/${id}/v${version}`),
      ]);
      if (
        (
          await adminDb.ref(`questionVersions/${id}/${nextVersion}`).get()
        ).exists()
      ) {
        throw new HttpsError(
          "already-exists",
          "Immutable version already exists."
        );
      }
      const archivedMeta = {
        ...(await read(`questions/${id}`)),
        currentVersion: nextVersion,
        status: "archived",
        updatedAt: now,
      };
      const updates: Obj = {
        ...audit(actor, "question.archive", id, now, opId),
        [`questions/${id}`]: archivedMeta,
        [`adminViews/questions/${id}`]: {
          ...archivedMeta,
          prompt: before.prompt,
          searchText: before.prompt.toLowerCase(),
        },
        [`questionVersions/${id}/${nextVersion}`]: {
          ...oldContent,
          version: nextVersion,
        },
        [`questionAnswers/${id}/${nextVersion}`]: oldAnswer,
      };
      if (before.lessonId) {
        updates[`lessonQuestions/${before.lessonId}/${id}/enabled`] = false;
        updates[`lessonQuestions/${before.lessonId}/${id}/version`] =
          nextVersion;
      }
      return {updates, result: {serverNow: now}};
    }
  );
});
export const adminSaveContent = endpoint(async (input, actor) => {
  allow(input, ["input", "requestId"]);
  const f = data(input.input);
  allow(f, [
    "kind",
    "id",
    "title",
    "description",
    "status",
    "categoryId",
    "topicId",
    "difficulty",
  ]);
  const kind = choice(f.kind, ["category", "topic", "lesson"] as const, "kind");
  const title = text(f.title, "title", 2, 150);
  const description = text(f.description, "description", 0, 3000);
  const status = choice(f.status, statuses, "status");
  const id =
    f.id === undefined ?
      `${kind}_${fingerprint([actor.uid, key(input.requestId)]).slice(0, 24)}` :
      key(f.id);
  const root =
    kind === "category" ?
      "categories" :
      kind === "topic" ?
        "topics" :
        "lessons";
  if (kind === "category") choice(id, skills, "category id");
  return mutate(
    actor,
    "content.save",
    input,
    ["content"],
    async (now, opId) => {
      const previous = await read(`${root}/${id}`, false);
      let value: Obj = {
        ...previous,
        title,
        description,
        status,
        updatedAt: now,
      };
      if (kind === "category") {
        value = {
          ...previous,
          name: title,
          englishName: title,
          description,
          status,
          updatedAt: now,
        };
      }
      if (kind === "topic") {
        const categoryId = choice(f.categoryId, skills, "categoryId");
        const parent = await read(`categories/${categoryId}`);
        if (status === "published" && parent.status !== "published") {
          throw new HttpsError(
            "failed-precondition",
            "Publish category first."
          );
        }
        value.categoryId = categoryId;
      }
      if (kind === "lesson") {
        const topicId = key(f.topicId, "topicId");
        const parent = await read(`topics/${topicId}`);
        if (status === "published" && parent.status !== "published") {
          throw new HttpsError("failed-precondition", "Publish topic first.");
        }
        const category = await read(`categories/${key(parent.categoryId)}`);
        if (status === "published" && category.status !== "published") {
          throw new HttpsError(
            "failed-precondition",
            "Publish category first."
          );
        }
        value.topicId = topicId;
        value.categoryId = parent.categoryId;
        value.difficulty = choice(f.difficulty, difficulties, "difficulty");
      }
      const [questionsMeta, topics, lessons] = await Promise.all([
        collection("questions", 1000),
        collection("topics", 300),
        collection("lessons", 500),
      ]);
      const children = [
        ...questionsMeta,
        ...(kind === "category" ? topics : kind === "topic" ? lessons : []),
      ]
        .map(([, r]) => r)
        .filter((r) =>
          kind === "category" ?
            r.categoryId === id :
            kind === "topic" ?
              r.topicId === id :
              r.lessonId === id
        );
      if (
        status !== "published" &&
        children.some((r) => r.status === "published")
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Archive published children first."
        );
      }
      if (
        children.length &&
        ((previous.categoryId && previous.categoryId !== value.categoryId) ||
          (previous.topicId && previous.topicId !== value.topicId))
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Referenced content cannot move to a different parent."
        );
      }
      return {
        updates: {
          ...audit(actor, "content.save", id, now, opId),
          [`${root}/${id}`]: value,
        },
        result: {serverNow: now},
      };
    }
  );
});
