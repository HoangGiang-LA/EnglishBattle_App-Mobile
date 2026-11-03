import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {test} from "node:test";

assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9199");
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, "127.0.0.1:9100");
assert.equal(process.env.GCLOUD_PROJECT, "demo-englishbattle-finalization");
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const {ensureUserProfile} = require("./lib/be1/auth/ensureUserProfile.js");
const {startAttempt} = require("./lib/be1/practice/startAttempt.js");
const {resumeAttempt} = require("./lib/be1/practice/resumeAttempt.js");
const {playableQuestion} = require("./lib/be1/practice/contentValidation.js");
const {adminAuth, adminDb} = require("./lib/config/firebaseAdmin.js");
const {deleteApp} = require("firebase-admin/app");
assert.match(adminDb.ref().toString(), /^http:\/\/127\.0\.0\.1:9100\//);

const seed = JSON.parse(readFileSync(new URL("../../database/english-battle.seed.json", import.meta.url), "utf8"));
const topicId = "vocabulary_daily_life";
const lessonId = `lesson_${topicId}`;
const questionId = `q_${topicId}_001`;
const invoke = (fn, uid, data = {}) => fn.run({auth: {uid}, data});
const read = async path => (await adminDb.ref(path).get()).val();
const freshContent = async () => {
  await adminDb.ref().update(Object.fromEntries(
    ["categories", "topics", "lessons", "questions", "questionVersions", "questionAnswers", "contentAssets", "quizTemplates"]
      .map(root => [root, seed[root]]),
  ));
};
const user = async () => {
  const value = await adminAuth.createUser({email: `${randomUUID()}@example.test`,
    password: "TestOnly123!", displayName: "Original name"});
  await invoke(ensureUserProfile, value.uid);
  return value;
};
const start = (uid, mode = "PRACTICE", requestId = randomUUID()) => invoke(startAttempt, uid,
  {mode, requestId, ...(mode === "PRACTICE" ? {topicId} : {})});
const authRest = async (method, body) => {
  const response = await fetch(`http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:${method}?key=test-key`, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
};

try {
  await adminDb.ref().set(seed);

  await test("Profile: trusted Auth values sync atomically without resetting account data", async () => {
    const u = await user();
    await adminDb.ref().update({
      [`users/${u.uid}/avatarPath`]: "existing-avatar",
      [`userPrivate/${u.uid}/keepField`]: "preserved",
      [`userStats/${u.uid}/rating`]: 37,
      [`wallets/${u.uid}/coinBalance`]: 9,
      [`learningProgress/${u.uid}/${topicId}/completedAttempts`]: 12,
    });
    const protectedPaths = ["accountAccess", "userStats", "wallets", "learningProgress", "userSettings"];
    const before = await Promise.all(protectedPaths.map(path => read(`${path}/${u.uid}`)));
    await adminAuth.updateUser(u.uid, {displayName: "Updated in Auth", email: `updated-${randomUUID()}@example.test`});
    await invoke(ensureUserProfile, u.uid, {uid: "someone-else", displayName: "Forged", email: "forged@example.test", admin: true});
    const auth = await adminAuth.getUser(u.uid);
    const profile = await read(`users/${u.uid}`);
    const privateData = await read(`userPrivate/${u.uid}`);
    assert.equal(profile.displayName, auth.displayName);
    assert.equal(profile.avatarPath, "existing-avatar");
    assert.equal(privateData.email, auth.email);
    assert.equal(privateData.keepField, "preserved");
    assert.equal(await read("users/someone-else"), null);
    assert.deepEqual(await Promise.all(protectedPaths.map(path => read(`${path}/${u.uid}`))), before);
    await invoke(ensureUserProfile, u.uid);
    assert.deepEqual(await read(`users/${u.uid}`), profile);
    assert.deepEqual(await read(`userPrivate/${u.uid}`), privateData);
  });

  await test("Profile: verify-before-update-email stays private until the email action is applied", async () => {
    const u = await user();
    const signedIn = await authRest("signInWithPassword", {email: u.email, password: "TestOnly123!", returnSecureToken: true});
    const newEmail = `verified-${randomUUID()}@example.test`;
    await authRest("sendOobCode", {requestType: "VERIFY_AND_CHANGE_EMAIL", idToken: signedIn.idToken, newEmail});
    await invoke(ensureUserProfile, u.uid, {email: newEmail});
    assert.equal((await read(`userPrivate/${u.uid}`)).email, u.email);
    const codes = await (await fetch("http://127.0.0.1:9199/emulator/v1/projects/demo-englishbattle-finalization/oobCodes")).json();
    const action = codes.oobCodes.find(code => code.requestType === "VERIFY_AND_CHANGE_EMAIL" && code.newEmail === newEmail);
    assert.ok(action, "Auth emulator must create the email verification action");
    await authRest("update", {oobCode: action.oobCode});
    await invoke(ensureUserProfile, u.uid);
    assert.equal((await read(`userPrivate/${u.uid}`)).email, newEmail);
  });

  await test("Profile: a failed RTDB sync is recoverable after Auth succeeds", async () => {
    const u = await user();
    await adminAuth.updateUser(u.uid, {displayName: "Saved before network failure", email: `retry-${randomUUID()}@example.test`});
    const originalRef = adminDb.ref;
    let injected = false;
    adminDb.ref = function(path) {
      const ref = originalRef.call(this, path);
      if (path === `adminUserState/${u.uid}`) {
        ref.transaction = async () => { injected = true; throw new Error("Injected local database interruption"); };
      }
      return ref;
    };
    try { await assert.rejects(invoke(ensureUserProfile, u.uid), {code: "internal"}); }
    finally { adminDb.ref = originalRef; }
    assert.ok(injected);
    assert.equal((await read(`users/${u.uid}`)).displayName, "Original name");
    await invoke(ensureUserProfile, u.uid);
    assert.equal((await read(`users/${u.uid}`)).displayName, "Saved before network failure");
    assert.equal((await read(`userPrivate/${u.uid}`)).email, (await adminAuth.getUser(u.uid)).email);
    assert.equal((await read(`wallets/${u.uid}`)).coinBalance, 0);
  });

  for (const status of ["banned", "deleted", "disabled"]) {
    await test(`Profile: ${status} accounts cannot sync or restore access`, async () => {
      const u = await user();
      const before = await read(`users/${u.uid}`);
      await adminAuth.updateUser(u.uid, {displayName: "Must not sync", ...(status === "disabled" ? {disabled: true} : {})});
      if (status !== "disabled") await adminDb.ref(`accountAccess/${u.uid}/status`).set(status);
      await assert.rejects(invoke(ensureUserProfile, u.uid), {code: "permission-denied"});
      assert.deepEqual(await read(`users/${u.uid}`), before);
      assert.equal((await read(`accountAccess/${u.uid}`)).status, status === "disabled" ? "active" : status);
    });
  }

  await test("Content: all 250 seed questions are valid, including TTS; no answers leak", () => {
    const relations = {categories: seed.categories, topics: seed.topics, lessons: seed.lessons, assets: seed.contentAssets};
    for (const [id, meta] of Object.entries(seed.questions)) {
      const question = playableQuestion(id, meta, seed.questionVersions[id][meta.currentVersion], seed.questionAnswers[id][meta.currentVersion], relations);
      assert.ok(question, id);
      assert.equal(question.options.length, 4);
      assert.ok(!("correctOptionId" in question) && !("explanation" in question));
      if (meta.categoryId === "listening") assert.equal(question.audioText, seed.contentAssets[seed.questionVersions[id][meta.currentVersion].audioAssetId].speechText);
    }
  });

  const invalidContent = [
    ["archived skill", {"categories/vocabulary/status": "archived"}],
    ["missing skill", {"categories/vocabulary": null}],
    ["archived topic", {[`topics/${topicId}/status`]: "archived"}],
    ["missing topic", {[`topics/${topicId}`]: null}],
    ["topic belongs to another skill", {[`topics/${topicId}/categoryId`]: "grammar"}],
    ["archived lesson", {[`lessons/${lessonId}/status`]: "archived"}],
    ["missing lesson", {[`lessons/${lessonId}`]: null}],
    ["lesson belongs to another topic", {[`lessons/${lessonId}/topicId`]: "grammar_tenses"}],
    ["lesson belongs to another skill", {[`lessons/${lessonId}/categoryId`]: "grammar"}],
    ["question has no lesson", {[`questions/${questionId}/lessonId`]: null}],
    ["question skill mismatches topic", {[`questions/${questionId}/categoryId`]: "grammar"}],
    ["unsupported question type", {[`questions/${questionId}/type`]: "essay"}],
    ["unsafe version key", {[`questions/${questionId}/currentVersion`]: "../v1"}],
    ["missing version", {[`questionVersions/${questionId}/v1`]: null}],
    ["version mismatches key", {[`questionVersions/${questionId}/v1/version`]: "v2"}],
    ["empty prompt", {[`questionVersions/${questionId}/v1/prompt`]: "   "}],
    ["only three options", {[`questionVersions/${questionId}/v1/options/opt_4`]: null}],
    ["duplicate options", {[`questionVersions/${questionId}/v1/options/opt_2/text`]: seed.questionVersions[questionId].v1.options.opt_1.text}],
    ["invalid option order", {[`questionVersions/${questionId}/v1/options/opt_2/order`]: 1}],
    ["missing answer", {[`questionAnswers/${questionId}/v1`]: null}],
    ["missing explanation", {[`questionAnswers/${questionId}/v1/explanation`]: ""}],
    ["answer not in options", {[`questionAnswers/${questionId}/v1/correctOptionId`]: "unknown-option"}],
  ];
  for (const [name, patch] of invalidContent) {
    await test(`Content: practice refuses ${name}, with no attempt or reward`, async () => {
      await freshContent();
      const u = await user();
      await adminDb.ref().update(patch);
      await assert.rejects(start(u.uid), {code: "failed-precondition"});
      assert.equal(await read(`practiceAttempts/${u.uid}`), null);
      assert.equal(await read(`rewardGrants/${u.uid}`), null);
      assert.equal((await read(`wallets/${u.uid}`)).coinBalance, 0);
    });
  }

  const listeningId = "q_listening_daily_life_001";
  const audioAssetId = seed.questionVersions[listeningId].v1.audioAssetId;
  for (const [name, targetTopic, patch] of [
    ["missing reading passage", "reading_daily_life", {"questionVersions/q_reading_daily_life_001/v1/passage": ""}],
    ["archived TTS", "listening_daily_life", {[`contentAssets/${audioAssetId}/status`]: "archived"}],
    ["missing TTS", "listening_daily_life", {[`contentAssets/${audioAssetId}`]: null}],
    ["empty TTS", "listening_daily_life", {[`contentAssets/${audioAssetId}/speechText`]: ""}],
  ]) {
    await test(`Content: practice refuses ${name}`, async () => {
      await freshContent();
      const u = await user();
      await adminDb.ref().update(patch);
      await assert.rejects(invoke(startAttempt, u.uid, {mode: "PRACTICE", topicId: targetTopic, requestId: randomUUID()}), {code: "failed-precondition"});
      assert.equal(await read(`practiceAttempts/${u.uid}`), null);
    });
  }

  await test("Content: mixed test excludes unpublished parents while keeping 20 questions", async () => {
    await freshContent();
    const u = await user();
    await adminDb.ref("categories/vocabulary/status").set("archived");
    const {attempt} = await start(u.uid, "TEST");
    assert.equal(attempt.questions.length, 20);
    assert.ok(attempt.questions.every(q => q.categoryId !== "vocabulary"));
  });

  await test("Content: invalid daily bank cannot consume the day; retry works after repair", async () => {
    await freshContent();
    const u = await user();
    await adminDb.ref("categories").set({});
    await assert.rejects(start(u.uid, "DAILY"), {code: "failed-precondition"});
    assert.equal(await read(`userDailyChallenges/${u.uid}`), null);
    await freshContent();
    const {attempt} = await start(u.uid, "DAILY");
    assert.equal(attempt.questions.length, 5);
  });

  await test("Content: existing attempts preserve their snapshots after parent archive and a new version", async () => {
    await freshContent();
    const u = await user();
    const {attempt} = await start(u.uid);
    await adminDb.ref().update({
      [`topics/${topicId}/status`]: "archived",
      [`questions/${questionId}/currentVersion`]: "v2",
      [`questionVersions/${questionId}/v2`]: {...seed.questionVersions[questionId].v1, version: "v2", prompt: "Changed for new attempts"},
    });
    const {attempt: resumed} = await invoke(resumeAttempt, u.uid, {attemptId: attempt.id});
    assert.deepEqual(resumed.questions, attempt.questions);
    assert.equal(resumed.deadlineAt, attempt.deadlineAt);
  });
} finally {
  await deleteApp(adminDb.app);
}
