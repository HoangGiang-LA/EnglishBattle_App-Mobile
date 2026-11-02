import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {test as nodeTest} from "node:test";
const test = (name, run) => nodeTest(name, {timeout: 30000}, run);

assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9199");
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, "127.0.0.1:9100");
assert.equal(process.env.GCLOUD_PROJECT, "demo-englishbattle-finalization");
const require = createRequire(new URL("../../../functions/package.json", import.meta.url));
const {ensureUserProfile} = require("./lib/be1/auth/ensureUserProfile.js");
const {startAttempt} = require("./lib/be1/practice/startAttempt.js");
const {getAttemptResult} = require("./lib/be1/practice/getAttemptResult.js");
const {leaveAttempt} = require("./lib/be1/practice/leaveAttempt.js");
const {getUserDashboard} = require("./lib/be1/user/getUserDashboard.js");
const {finalizeAttemptLogic} = require("./lib/be1/practice/finalizeAttempt.js");
const {adminAuth, adminDb} = require("./lib/config/firebaseAdmin.js");
const {deleteApp} = require("firebase-admin/app");
assert.match(adminDb.ref().toString(), /^http:\/\/127\.0\.0\.1:9100\//);

const seed = JSON.parse(readFileSync(new URL("../../../database/english-battle.seed.json", import.meta.url), "utf8"));
const topicId = "vocabulary_daily_life";
const achievementId = `practice_20_${topicId}`;
const invoke = (fn, uid, data = {}) => fn.run({auth: {uid}, data});
const read = async path => (await adminDb.ref(path).get()).val();
const progressPath = uid => `learningProgress/${uid}/${topicId}`;
const finish = (uid, attempt) => invoke(getAttemptResult, uid, {attemptId: attempt.id});

async function newUser(completed = 0) {
  const user = await adminAuth.createUser({email: `progress-${randomUUID()}@example.test`});
  await invoke(ensureUserProfile, user.uid);
  if (completed) await adminDb.ref(progressPath(user.uid)).set({
    completedAttempts: completed, completionTarget: 20,
    correctCount: completed * 10, answeredCount: completed * 10,
    lastCompletedAt: Date.now() - 60_000,
  });
  return user.uid;
}

// These tests exercise settlement. Seed resolved answers on the isolated DB;
// attemptCompletion.test.mjs separately covers the complete submit/advance flow.
async function waitingAttempt(uid, mode = "PRACTICE") {
  const {attempt} = await invoke(startAttempt, uid, {
    mode, ...(mode === "PRACTICE" ? {topicId} : {}), requestId: randomUUID(),
  });
  const answers = Object.fromEntries(attempt.questions.map((q, ordinal) => [ordinal, {
    questionId: q.id, selectedOptionId: seed.questionAnswers[q.id][q.version].correctOptionId,
    isCorrect: true, timedOut: false, ordinal, requestId: randomUUID(), receivedAt: Date.now(),
  }]));
  await adminDb.ref().update({
    [`attemptAnswers/${uid}/${attempt.id}`]: answers,
    [`practiceAttempts/${uid}/${attempt.id}/status`]: "waiting",
    [`practiceAttempts/${uid}/${attempt.id}/currentIndex`]: attempt.questions.length - 1,
    [`practiceAttempts/${uid}/${attempt.id}/answeredCount`]: attempt.questions.length,
    [`practiceAttempts/${uid}/${attempt.id}/correctCount`]: attempt.questions.length,
    [`practiceAttempts/${uid}/${attempt.id}/finishedAt`]: Date.now(),
  });
  return attempt;
}

async function assertTotals(uid, completions, newGrants, answered) {
  const progress = await read(progressPath(uid));
  assert.equal(progress.completedAttempts, completions);
  assert.equal(progress.answeredCount, answered);
  assert.equal(progress.correctCount, answered);
  assert.equal(Object.keys(progress.appliedGrants || {}).length, newGrants);
  assert.equal((await read(`userSettlements/${uid}`)).progress[topicId], completions);
  assert.equal((await read(`wallets/${uid}`)).coinBalance, newGrants);
  assert.equal(Object.keys(await read(`coinLedger/${uid}`)).length, newGrants);
}

try {
  const namespace = new URL(adminDb.app.options.databaseURL).hostname.split(".")[0];
  const rulesResponse = await fetch(`http://127.0.0.1:9100/.settings/rules.json?ns=${namespace}`, {
    method: "PUT", headers: {Authorization: "Bearer owner", "Content-Type": "application/json"},
    body: readFileSync(new URL("../../../../database.rules.json", import.meta.url), "utf8"),
  });
  assert.equal(rulesResponse.status, 200);
  await adminDb.ref().set(seed);

  await test("Dashboard: return published definitions only and unlocks belonging to this UID", async () => {
    const uid = await newUser();
    const otherUid = await newUser();
    await adminDb.ref().update({
      "achievements/test_draft": {title: "Draft", status: "draft"},
      "achievements/test_archived": {title: "Archived", status: "archived"},
      "achievements/test_active": {title: "Unsupported legacy status", status: "active"},
      "achievements/test_invalid": "invalid definition",
      [`userAchievements/${uid}/${achievementId}`]: {unlockedAt: Date.now()},
      [`userAchievements/${otherUid}/first_win`]: {unlockedAt: Date.now()},
    });
    const {dashboard} = await invoke(getUserDashboard, uid);
    assert.deepEqual(dashboard.achievements.map(a => a.id).sort(), Object.keys(seed.achievements).sort());
    assert.deepEqual(dashboard.achievements.filter(a => a.unlocked).map(a => a.id), [achievementId]);
  });

  await test("Practice 19/20/21: unlock the matching topic once without extra achievement coins", async () => {
    const uid = await newUser(18);
    let unlocked;
    for (const count of [19, 20, 21]) {
      const attempt = await waitingAttempt(uid);
      const {result} = await finish(uid, attempt);
      assert.equal(result.coins, 1);
      await assertTotals(uid, count, count - 18, count * 10);
      const records = await read(`userAchievements/${uid}`);
      if (count === 19) assert.equal(records, null);
      else {
        assert.deepEqual(Object.keys(records), [achievementId]);
        assert.equal(records[achievementId].progress, 20);
        assert.ok(records[achievementId].unlockedAt > 0);
        if (unlocked) assert.deepEqual(records[achievementId], unlocked);
        unlocked = records[achievementId];
      }
      await finish(uid, attempt);
      await assertTotals(uid, count, count - 18, count * 10);
      const {dashboard} = await invoke(getUserDashboard, uid);
      assert.equal(dashboard.progress[topicId], count);
      assert.equal(dashboard.achievements.find(a => a.id === achievementId).unlocked, count >= 20);
    }
  });

  await test("Concurrent retries of one attempt increment progress and award coins once", async () => {
    const uid = await newUser();
    const attempt = await waitingAttempt(uid);
    const responses = await Promise.all(Array.from({length: 8}, () => finish(uid, attempt)));
    responses.forEach(response => assert.deepEqual(response.result, responses[0].result));
    await assertTotals(uid, 1, 1, 10);
    assert.equal(await read(`userAchievements/${uid}`), null);
  });

  await test("Rejected completion does not prevent a later valid leave from finalizing", async () => {
    const uid = await newUser();
    const {attempt} = await invoke(startAttempt, uid, {
      mode: "PRACTICE", topicId, requestId: randomUUID(),
    });
    await assert.rejects(finalizeAttemptLogic(uid, attempt.id), {code: "failed-precondition"});
    const left = await invoke(leaveAttempt, uid, {attemptId: attempt.id, requestId: randomUUID()});
    assert.equal(left.attempt.status, "abandoned");
    assert.equal(left.attempt.result.coins, 0);
    const replay = await finish(uid, attempt);
    assert.equal(replay.result.outcome, "abandoned");
    assert.equal(await read(`wallets/${uid}/coinBalance`), 0);
  });

  await test("Three concurrent completions: delayed progress 19 cannot overwrite 21 or the latest timestamp", async () => {
    const uid = await newUser(18);
    const attempts = [];
    for (let i = 0; i < 3; i++) attempts.push(await waitingAttempt(uid));
    let resume;
    let paused;
    let intercepted = false;
    const release = new Promise(resolve => { resume = resolve; });
    const reached = new Promise(resolve => { paused = resolve; });
    const originalRef = adminDb.ref;
    adminDb.ref = function(path) {
      const ref = originalRef.call(this, path);
      if (path === progressPath(uid)) {
        const transaction = ref.transaction.bind(ref);
        ref.transaction = async (...args) => {
          if (!intercepted) { intercepted = true; paused(); await release; }
          return transaction(...args);
        };
      }
      return ref;
    };
    const delayed = finish(uid, attempts[0]);
    try {
      await reached;
      await Promise.all(attempts.slice(1).map(attempt => finish(uid, attempt)));
    } finally {
      resume();
      try { await delayed; }
      finally { adminDb.ref = originalRef; }
    }
    await assertTotals(uid, 21, 3, 210);
    const expectedTime = Math.max(...await Promise.all(attempts.map(a => read(`practiceAttempts/${uid}/${a.id}/finishedAt`))));
    assert.equal((await read(progressPath(uid))).lastCompletedAt, expectedTime);
    const unlocked = await read(`userAchievements/${uid}/${achievementId}`);
    assert.ok(unlocked.unlockedAt > 0);
    await Promise.all(attempts.flatMap(a => [finish(uid, a), finish(uid, a)]));
    await assertTotals(uid, 21, 3, 210);
    assert.deepEqual(await read(`userAchievements/${uid}/${achievementId}`), unlocked);
  });

  await test("Replay repairs a previously regressed projection without counting an applied grant twice", async () => {
    const uid = await newUser(19);
    const attempt = await waitingAttempt(uid);
    await finish(uid, attempt);
    const unlocked = await read(`userAchievements/${uid}/${achievementId}`);
    await adminDb.ref(`${progressPath(uid)}/completedAttempts`).set(19);
    await finish(uid, attempt);
    await assertTotals(uid, 20, 1, 200);
    assert.deepEqual(await read(`userAchievements/${uid}/${achievementId}`), unlocked);
  });

  await test("TEST, DAILY and abandoned practice do not increase practice progress or unlock the milestone", async () => {
    const uid = await newUser(19);
    const before = await read(progressPath(uid));
    for (const mode of ["TEST", "DAILY"]) await finish(uid, await waitingAttempt(uid, mode));
    const abandoned = await waitingAttempt(uid);
    await invoke(leaveAttempt, uid, {attemptId: abandoned.id, requestId: randomUUID()});
    assert.deepEqual(await read(progressPath(uid)), before);
    const achievements = await read(`userAchievements/${uid}`);
    assert.equal(achievements?.[achievementId], undefined);
    assert.equal(achievements?.seven_daily_challenges?.progress, 1);
    assert.ok(Object.values(achievements || {}).every(a => !a.unlockedAt));
    assert.equal((await read(`wallets/${uid}`)).coinBalance, 4);
  });
} finally {
  await deleteApp(adminDb.app);
}
