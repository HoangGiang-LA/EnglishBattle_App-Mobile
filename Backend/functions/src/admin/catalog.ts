import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {record} from "../be1/practice/contentValidation";
import {Data} from "./contracts";
import {OperationHandlers} from "./operations";
import {contentConflict, contentRevision, invalidContent, normalizeContent, readCatalogSource} from "./contentModel";

export const catalogOperationHandlers: OperationHandlers = {
  adminSaveContent: {
    version: 1, target: (data, id) => {
      const input = data.input as Data;
      return `content/${input.kind}/${input.id || `admin_${id.slice(0, 40)}`}`;
    },
    run: async (ctx, data) => {
      await ctx.acquireLock("content/catalog");
      const plan = await ctx.step("plan", async () => {
        const input = data.input as Data;
        const kind = String(input.kind);
        const path = kind === "category" ? "categories" : kind === "topic" ? "topics" : "lessons";
        const id = String(input.id || ctx.resourceId);
        const source = await readCatalogSource();
        const values = source[path];
        const exists = Object.prototype.hasOwnProperty.call(values, id);
        const current = exists ? record(values[id]) : {};
        if (input.id && !exists) throw new HttpsError("not-found", "Content not found.");
        if (exists && contentRevision(current) !== data.expectedRevision) throw contentConflict();
        if (!input.id && Object.keys(values).length >= (kind === "topic" ? 500 : 5000)) {
          throw new HttpsError("resource-exhausted", "Catalog limit exceeded.");
        }
        const fields: Data = {description: String(input.description).trim(), status: input.status,
          updatedAt: ctx.createdAt, createdAt: current.createdAt || ctx.createdAt};
        const title = String(input.title).trim();
        if (kind === "category") fields.name = title;
        else {
          fields.title = title;
          if (kind === "topic") {
            fields.categoryId = input.categoryId;
            const parent = record(source.categories[String(input.categoryId)]);
            if (!parent.status) throw invalidContent();
            if ((id === "vocabulary_idioms" || normalizeContent(title) === "idioms & phrases") &&
                input.categoryId !== "vocabulary") throw invalidContent("idioms-belongs-to-vocabulary");
            if (input.status === "published" && parent.status !== "published") throw invalidContent("parent-not-published");
            if (current.categoryId && current.categoryId !== input.categoryId) {
              const referenced = await adminDb.ref("questions").orderByChild("topicId").equalTo(id).limitToFirst(1).get();
              if (referenced.exists() || Object.values(source.lessons).some((l) => record(l).topicId === id)) {
                throw invalidContent("content-has-children");
              }
            }
          } else {
            const topic = record(source.topics[String(input.topicId)]);
            const category = record(source.categories[String(topic.categoryId)]);
            if (!topic.status || !category.status || (input.categoryId && input.categoryId !== topic.categoryId)) {
              throw invalidContent();
            }
            if (input.status === "published" && (topic.status !== "published" || category.status !== "published")) {
              throw invalidContent("parent-not-published");
            }
            fields.topicId = input.topicId; fields.categoryId = topic.categoryId; fields.difficulty = input.difficulty;
            if (current.topicId && current.topicId !== input.topicId) {
              const referenced = await adminDb.ref("questions").orderByChild("lessonId").equalTo(id).limitToFirst(1).get();
              if (referenced.exists()) throw invalidContent("content-has-children");
            }
          }
          if (Object.entries(values).some(([key, raw]) => key !== id &&
              normalizeContent(String(record(raw).title)) === normalizeContent(title) &&
              (kind === "topic" ? record(raw).categoryId === fields.categoryId : record(raw).topicId === fields.topicId))) {
            throw new HttpsError("already-exists", "This title already exists under the selected parent.", {reason: "duplicate-content-title"});
          }
        }
        return {path: `${path}/${id}`, expected: Number(data.expectedRevision || 0), fields};
      });
      await ctx.mutateRecord("commit", plan.path, plan.expected, (current) => ({...current, ...plan.fields}));
      return {};
    },
  },
};
