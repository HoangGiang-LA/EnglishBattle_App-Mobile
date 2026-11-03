import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {record, contentId, ContentRelations} from "../be1/practice/contentValidation";
import {Data, validateAdminResponse} from "./contracts";

export const contentSkills = ["vocabulary", "grammar", "listening", "reading"];
export const normalizeContent = (value: string) => value.normalize("NFKC").trim().toLowerCase();
export const contentConflict = () => new HttpsError("failed-precondition", "Content changed. Reload before editing.", {
  reason: "version-conflict",
});
export const invalidContent = (reason = "invalid-content-relation") =>
  new HttpsError("failed-precondition", "Content or its parent relation is invalid.", {reason});
export const contentRevision = (value: Data) => Number(value.revision || 0);

/** Bounded source reads. Never fetch the database root or silently truncate a catalog. */
export async function readCatalogSource(): Promise<ContentRelations> {
  const limits = {categories: 4, topics: 500, lessons: 5000};
  const result: ContentRelations = {categories: {}, topics: {}, lessons: {}, assets: {}};
  for (const [path, limit] of Object.entries(limits)) {
    const snap = await adminDb.ref(path).orderByKey().limitToFirst(limit + 1).get();
    if (snap.numChildren() > limit) throw new HttpsError("resource-exhausted", "Catalog limit exceeded.");
    result[path as "categories" | "topics" | "lessons"] = record(snap.val());
  }
  if (Object.keys(result.categories).some((id) => !contentSkills.includes(id))) throw invalidContent("invalid-skill");
  return result;
}

export async function readAdminCatalog() {
  const source = await readCatalogSource();
  const categories = contentSkills.filter((id) => source.categories[id]).map((id) => {
    const value = record(source.categories[id]);
    return {id, name: value.name, description: value.description || "", status: value.status,
      revision: contentRevision(value)};
  });
  const topics = Object.entries(source.topics).map(([id, raw]) => {
    const value = record(raw);
    return {id, categoryId: value.categoryId, title: value.title, description: value.description || "",
      status: value.status, revision: contentRevision(value)};
  });
  const lessons = Object.entries(source.lessons).map(([id, raw]) => {
    const value = record(raw);
    return {id, topicId: value.topicId, title: value.title, description: value.description || "",
      difficulty: value.difficulty, status: value.status, revision: contentRevision(value)};
  });
  topics.sort((a, b) => a.id.localeCompare(b.id));
  lessons.sort((a, b) => a.id.localeCompare(b.id));
  const catalog = {categories, topics, lessons};
  validateAdminResponse("adminGetCatalog", {catalog, serverNow: Date.now()});
  return catalog;
}

/** Parent publication gates new sessions; descendants keep their own status/history. */
export function requireQuestionParents(input: Data, source: ContentRelations): void {
  const category = record(source.categories[String(input.categoryId)]);
  const topic = record(source.topics[String(input.topicId)]);
  const lesson = record(source.lessons[String(input.lessonId)]);
  if (!category.status || topic.categoryId !== input.categoryId ||
      lesson.topicId !== input.topicId || lesson.categoryId !== input.categoryId) throw invalidContent();
  if (input.status === "published" && [category, topic, lesson].some((p) => p.status !== "published")) {
    throw invalidContent("parent-not-published");
  }
}

export const versionNumber = (value: unknown): number => {
  if (typeof value !== "string" || !/^v[1-9]\d*$/.test(value)) throw invalidContent("invalid-stored-content");
  const version = Number(value.slice(1));
  if (!Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) throw invalidContent("invalid-stored-content");
  return version;
};

/** Explicit allowlist; answers are returned only through the guarded admin dispatcher. */
export async function readAdminQuestion(id: string, suppliedMeta?: Data): Promise<Data> {
  const meta = suppliedMeta || (await adminDb.ref(`questions/${id}`).get()).val();
  if (!meta) throw new HttpsError("not-found", "Question not found.");
  const version = versionNumber(meta.currentVersion);
  const [versionSnap, answerSnap] = await Promise.all([
    adminDb.ref(`questionVersions/${id}/v${version}`).get(), adminDb.ref(`questionAnswers/${id}/v${version}`).get(),
  ]);
  const content = record(versionSnap.val());
  const answer = record(answerSnap.val());
  let audioText = content.audioText || "";
  if (content.audioAssetId) {
    if (!contentId(content.audioAssetId)) throw invalidContent("invalid-stored-content");
    const asset = record((await adminDb.ref(`contentAssets/${content.audioAssetId}`).get()).val());
    if (asset.kind !== "tts" || typeof asset.speechText !== "string") throw invalidContent("unsupported-audio-content");
    audioText = asset.speechText;
  }
  const options = Object.entries(record(content.options)).map(([optionId, raw]) => ({
    id: optionId, text: record(raw).text, order: Number(record(raw).order),
  })).sort((a, b) => a.order - b.order).map(({id: optionId, text}) => ({id: optionId, text}));
  const question: Data = {id, code: meta.displayCode || id, categoryId: meta.categoryId,
    topicId: meta.topicId, lessonId: meta.lessonId, difficulty: meta.difficulty, status: meta.status,
    prompt: content.prompt, options, correctOptionId: answer.correctOptionId, explanation: answer.explanation || "",
    passage: content.passage || "", audioText, audioUrl: "", version,
    createdAt: Number(meta.createdAt || 0), updatedAt: Number(meta.updatedAt || 0)};
  validateAdminResponse("adminGetQuestion", {question, serverNow: Date.now()});
  return question;
}
