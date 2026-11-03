import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {playableQuestion} from "../be1/practice/contentValidation";
import {Data} from "./contracts";
import {canonicalJson, OperationContext, OperationHandlers} from "./operations";
import {contentConflict, invalidContent, readAdminQuestion, readCatalogSource, requireQuestionParents, versionNumber} from "./contentModel";
import {syncAdminQuestionIndex} from "./questionIndex";

async function immutable(path: string, value: Data): Promise<void> {
  const tx = await transactionWithRetry(adminDb.ref(path), (current) => current || value);
  if (canonicalJson(tx.snapshot.val()) !== canonicalJson(value)) throw invalidContent("immutable-version-conflict");
}

async function save(ctx: OperationContext, data: Data, archive: boolean): Promise<Data> {
  await ctx.acquireLock("content/catalog");
  const plan = await ctx.step("plan", async () => {
    const id = String(data.id || `q_${ctx.resourceId}`);
    const current = (await adminDb.ref(`questions/${id}`).get()).val();
    if (data.id && !current) throw new HttpsError("not-found", "Question not found.");
    if (current && versionNumber(current.currentVersion) !== data.expectedVersion) throw contentConflict();
    const input = archive ? {...await readAdminQuestion(id), status: "archived"} : data.input as Data;
    const relations = await readCatalogSource();
    requireQuestionParents(input, relations);
    const version = current ? versionNumber(current.currentVersion) + 1 : 1;
    const versionKey = `v${version}`;
    const metadata = {categoryId: input.categoryId, topicId: input.topicId, lessonId: input.lessonId,
      difficulty: input.difficulty, status: input.status, currentVersion: versionKey,
      type: input.categoryId === "reading" ? "reading_single_choice" :
        input.categoryId === "listening" ? "listening_single_choice" : "single_choice",
      displayCode: current?.displayCode || `Q-${id}`, createdAt: current?.createdAt || ctx.createdAt,
      updatedAt: ctx.createdAt, lastAdminOperation: ctx.id};
    const content = {version: versionKey, language: "en", questionTimeLimitSeconds: 30,
      prompt: String(input.prompt).trim(), passage: String(input.passage).trim(),
      audioText: String(input.audioText).trim(),
      options: Object.fromEntries((input.options as {id: string; text: string}[])
        .map((o, i) => [o.id, {text: o.text.trim(), order: i + 1}]))};
    const answer = {correctOptionId: input.correctOptionId, explanation: String(input.explanation).trim(),
      explanationLanguage: "vi", scoringType: "correct_count", correctPoints: 1, incorrectPoints: 0};
    if (input.status === "published" && !playableQuestion(id, metadata, content, answer, relations)) {
      throw invalidContent("invalid-published-question");
    }
    return {id, version, versionKey, metadata, content, answer,
      expected: current?.currentVersion || null, previousLesson: current?.lessonId || null};
  });
  await ctx.step("version", () => immutable(`questionVersions/${plan.id}/${plan.versionKey}`, plan.content));
  await ctx.step("answer", () => immutable(`questionAnswers/${plan.id}/${plan.versionKey}`, plan.answer));
  await ctx.step("commit", async () => {
    const tx = await transactionWithRetry(adminDb.ref(`questions/${plan.id}`), (current) => {
      if (current?.lastAdminOperation === ctx.id) return current;
      if ((current?.currentVersion || null) !== plan.expected) return current;
      return {...current, ...plan.metadata};
    });
    if (tx.snapshot.val()?.lastAdminOperation !== ctx.id) throw contentConflict();
  });
  await ctx.step("lesson-index", async () => {
    for (const lesson of new Set([plan.metadata.lessonId, plan.previousLesson].filter(Boolean))) {
      await transactionWithRetry(adminDb.ref(`lessonQuestions/${lesson}/${plan.id}`), (current) => {
        if (current?.adminVersion > plan.version) return current;
        return {...current, order: current?.order || plan.metadata.createdAt, adminVersion: plan.version,
          status: lesson === plan.metadata.lessonId ? plan.metadata.status : "archived",
          removed: lesson !== plan.metadata.lessonId};
      });
    }
  });
  await ctx.step("index", () => syncAdminQuestionIndex(plan.id));
  return archive ? {} : {question: await readAdminQuestion(plan.id)};
}

export const questionOperationHandlers: OperationHandlers = {
  adminSaveQuestion: {version: 1, target: (data, id) => `question/${data.id || `q_admin_${id.slice(0, 40)}`}`,
    run: (ctx, data) => save(ctx, data, false)},
  adminArchiveQuestion: {version: 1, target: (data) => `question/${data.id}`,
    run: (ctx, data) => save(ctx, data, true)},
};
