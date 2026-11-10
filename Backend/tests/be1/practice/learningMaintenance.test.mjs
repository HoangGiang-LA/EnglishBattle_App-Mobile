import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9199');
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:9100');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-finalization');
const require = createRequire(new URL('../../../functions/package.json', import.meta.url));
const {ensureUserProfile} = require('./lib/be1/auth/ensureUserProfile.js');
const {startAttempt} = require('./lib/be1/practice/startAttempt.js');
const {submitAttemptAnswer} = require('./lib/be1/practice/submitAttemptAnswer.js');
const {advanceAttempt} = require('./lib/be1/practice/advanceAttempt.js');
const {resumeAttempt} = require('./lib/be1/practice/resumeAttempt.js');
const {saveAttemptSelection} = require('./lib/be1/practice/saveAttemptSelection.js');
const {finalizeAttemptLogic, readAttemptResponse} = require('./lib/be1/practice/finalizeAttempt.js');
const {drainLearningWork, discoverLearningWork, runLearningMaintenance, repairExpiredDailySlot} =
  require('./lib/be1/practice/learningMaintenance.js');
const {learningWorkKey, enqueueLearningWork} = require('./lib/be1/practice/learningWork.js');
const {getDateKey, dailyEndsAt} = require('./lib/be1/practice/attemptHelper.js');
const {adminAuth, adminDb} = require('./lib/config/firebaseAdmin.js');
const {deleteApp} = require('firebase-admin/app');
assert.match(adminDb.ref().toString(), /^http:\/\/127\.0\.0\.1:9100\//);
const seed = JSON.parse(readFileSync(new URL('../../../database/english-battle.seed.json', import.meta.url), 'utf8'));
const invoke = (fn, uid, data = {}) => fn.run({auth: {uid}, data});
const read = async path => (await adminDb.ref(path).get()).val();
const path = (uid, a) => `practiceAttempts/${uid}/${a.id}`;
const work = (uid, a) => `learningWork/${learningWorkKey(uid, a.id)}`;
const correct = q => seed.questionAnswers[q.id][q.version].correctOptionId;

async function fresh(mode = 'PRACTICE') {
  await adminDb.ref().set(seed);
  const user = await adminAuth.createUser({email: `maintenance-${randomUUID()}@example.test`});
  await invoke(ensureUserProfile, user.uid);
  const {attempt} = await invoke(startAttempt, user.uid, {
    mode, ...(mode === 'PRACTICE' ? {topicId: 'vocabulary_daily_life'} : {}), requestId: randomUUID(),
  });
  return {uid: user.uid, a: attempt};
}
async function choose(uid, a, optionId = correct(a.questions[0]), question = a.questions[0]) {
  return invoke(saveAttemptSelection, uid, {attemptId: a.id, questionId: question.id,
    optionId, requestId: randomUUID()});
}
async function expire(uid, a, deadline = Date.now() + 20) {
  await adminDb.ref().update({[`${path(uid, a)}/deadlineAt`]: deadline,
    [`${work(uid, a)}/dueAt`]: deadline});
  if (deadline > Date.now()) await new Promise(resolve => setTimeout(resolve, deadline - Date.now() + 5));
  return deadline;
}
async function waiting(uid, a) {
  const answers = Object.fromEntries(a.questions.map((q, ordinal) => [ordinal, {
    questionId: q.id, selectedOptionId: correct(q), isCorrect: true,
    timedOut: false, ordinal, requestId: randomUUID(), receivedAt: Date.now(),
  }]));
  await adminDb.ref().update({
    [`${path(uid, a)}/status`]: 'waiting', [`${path(uid, a)}/answers`]: answers,
    [`${path(uid, a)}/answerStateVersion`]: 1,
    [`${path(uid, a)}/currentIndex`]: a.questions.length - 1,
    [`${path(uid, a)}/answeredCount`]: a.questions.length,
    [`${path(uid, a)}/correctCount`]: a.questions.length,
    [`${path(uid, a)}/finishedAt`]: Date.now(), [`${work(uid, a)}/dueAt`]: 0,
  });
}
async function settled(uid, a, coins) {
  const saved = await read(path(uid, a));
  assert.equal(saved.status, 'completed');
  assert.equal(saved.settlementVersion, 1);
  assert.equal(saved.answeredCount, a.questions.length);
  assert.equal(saved.coinsAwarded, coins);
  assert.equal(await read(`wallets/${uid}/coinBalance`), coins);
  assert.equal(Object.keys(await read(`coinLedger/${uid}`)).length, 1);
  assert.equal(Object.keys(await read(`attemptReviews/${uid}/${a.id}`)).length, a.questions.length);
  assert.equal(await read(work(uid, a)), null);
  return saved;
}

function runWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../functions/tools/learning-worker.mjs', import.meta.url)), '--once'], {
      env: {...process.env}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Worker timeout: ' + output)); }, 30000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(output)); });
  });
}

try {
  const ns = new URL(adminDb.app.options.databaseURL).hostname.split('.')[0];
  const rules = await fetch(`http://127.0.0.1:9100/.settings/rules.json?ns=${ns}`, {
    method: 'PUT', headers: {Authorization: 'Bearer owner', 'Content-Type': 'application/json'},
    body: readFileSync(new URL('../../../../database.rules.json', import.meta.url), 'utf8'),
  });
  assert.equal(rules.status, 200);

  for (const choice of ['correct', 'wrong', 'none']) await test(`Timeout grades unconfirmed ${choice} choice without a client callback`, async () => {
    const {uid, a} = await fresh();
    const q = a.questions[0];
    const selected = choice === 'correct' ? correct(q) : q.options.find(o => o.id !== correct(q)).id;
    if (choice !== 'none') {
      assert.equal((await choose(uid, a, selected)).accepted, true);
      assert.equal(await read(`${path(uid, a)}/answers`), null);
      const resumed = (await invoke(resumeAttempt, uid, {attemptId: a.id})).attempt;
      assert.equal(resumed.selectedOptionId, selected);
      assert.equal(resumed.receipts.length, 0);
      assert.equal(resumed.result, null);
      assert.equal('correctOptionId' in resumed.questions[0], false);
    }
    const deadline = await expire(uid, a);
    await drainLearningWork();
    const saved = await read(path(uid, a));
    assert.equal(saved.currentIndex, 1);
    assert.equal(saved.answers[0].selectedOptionId ?? null, choice === 'none' ? null : selected);
    assert.equal(saved.answers[0].isCorrect, choice === 'correct');
    assert.equal(saved.answers[0].timedOut, true);
    assert.equal(saved.deadlineAt, deadline + 30000);
    assert.equal(saved.questionTimings[1].openedAt, deadline);
  });

  await test('Latest choice wins; a late choice or late confirmation cannot replace the saved choice', async () => {
    const {uid, a} = await fresh();
    const q = a.questions[0];
    const wrong = q.options.find(o => o.id !== correct(q)).id;
    await choose(uid, a, wrong);
    await choose(uid, a);
    await expire(uid, a);
    assert.equal((await choose(uid, a, wrong)).accepted, false);
    await invoke(submitAttemptAnswer, uid, {attemptId: a.id, questionId: q.id,
      optionId: wrong, requestId: randomUUID()});
    assert.equal((await read(path(uid, a))).answers[0].selectedOptionId, correct(q));
    await drainLearningWork();
    assert.equal((await read(path(uid, a))).correctCount, 1);
  });

  await test('Timeout exactly at the deadline includes a prior selection; deadline itself rejects new selections', async () => {
    const {uid, a} = await fresh();
    await choose(uid, a);
    const clock = Date.now;
    Date.now = () => a.deadlineAt;
    try {
      assert.equal((await choose(uid, a)).accepted, false);
      await invoke(submitAttemptAnswer, uid, {attemptId: a.id, questionId: a.questions[0].id,
        optionId: null, requestId: randomUUID()});
      assert.equal((await read(path(uid, a))).answers[0].isCorrect, true);
    } finally { Date.now = clock; }
  });

  await test('Grading delay does not expire an answer received on time or shorten the next question', async () => {
    const {uid, a} = await fresh();
    const question = a.questions[0];
    const originalRef = adminDb.ref;
    const originalClock = Date.now;
    const receivedAt = a.deadlineAt - 100;
    const afterGrading = a.deadlineAt + 2000;
    Date.now = () => receivedAt;
    adminDb.ref = function(refPath) {
      const ref = originalRef.call(this, refPath);
      if (refPath === `questionAnswers/${question.id}/${question.version}`) {
        const get = ref.get.bind(ref);
        ref.get = async () => {
          const snapshot = await get();
          Date.now = () => afterGrading;
          return snapshot;
        };
      }
      return ref;
    };
    try {
      const {attempt} = await invoke(submitAttemptAnswer, uid, {attemptId: a.id,
        questionId: question.id, optionId: correct(question), requestId: randomUUID()});
      assert.equal(attempt.receipts[0].correct, true);
      const answer = (await read(path(uid, a))).answers[0];
      assert.equal(answer.timedOut, false);
      assert.equal(answer.receivedAt, receivedAt);
      const next = await invoke(advanceAttempt, uid, {attemptId: a.id,
        expectedIndex: 0, requestId: randomUUID()});
      assert.equal(next.attempt.index, 1);
      assert.equal(next.attempt.deadlineAt, afterGrading + 30000);
    } finally {
      adminDb.ref = originalRef;
      Date.now = originalClock;
    }
  });

  for (const [mode, coins] of [['PRACTICE', 1], ['TEST', 2]]) await test(`${mode}: restart catches up all missed deadlines and settles once`, async () => {
    const {uid, a} = await fresh(mode);
    const firstDeadline = await expire(uid, a, Date.now() - a.questions.length * 30000 - 1000);
    await Promise.all([drainLearningWork(), drainLearningWork()]);
    const saved = await settled(uid, a, coins);
    assert.equal(saved.correctCount, 0);
    assert.equal(saved.finishedAt, firstDeadline + (a.questions.length - 1) * 30000);
    assert.ok(Object.values(saved.answers).every(answer => answer.timedOut && !answer.isCorrect));
    await runLearningMaintenance();
    await settled(uid, a, coins);
  });

  for (const mode of ['PRACTICE', 'TEST', 'DAILY']) await test(`${mode}: waiting is finalized without the app fetching a result`, async () => {
    const {uid, a} = await fresh(mode);
    await waiting(uid, a);
    await drainLearningWork();
    await settled(uid, a, mode === 'PRACTICE' ? 1 : 2);
  });

  await test('Last unconfirmed answer is graded, reviewed and saved automatically', async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    const answers = await read(`${path(uid, a)}/answers`);
    delete answers[a.questions.length - 1];
    const last = a.questions.at(-1);
    await adminDb.ref(path(uid, a)).update({status: 'active', answers,
      answeredCount: a.questions.length - 1, correctCount: a.questions.length - 1,
      deadlineAt: Date.now() + 30000});
    await choose(uid, a, correct(last), last);
    await expire(uid, a);
    await drainLearningWork();
    const saved = await settled(uid, a, 1);
    assert.equal(saved.correctCount, a.questions.length);
    const {attempt} = await invoke(resumeAttempt, uid, {attemptId: a.id});
    assert.equal(attempt.result.reviews.at(-1).pickedId, correct(last));
  });

  for (const mode of ['PRACTICE', 'TEST', 'DAILY']) await test(`${mode}: confirmed last answer settles without advance or waiting for timeout`, async () => {
    const {uid, a} = await fresh(mode);
    await waiting(uid, a);
    const answers = await read(`${path(uid, a)}/answers`);
    delete answers[a.questions.length - 1];
    const last = a.questions.at(-1);
    await adminDb.ref(path(uid, a)).update({status: 'active', answers,
      answeredCount: a.questions.length - 1, correctCount: a.questions.length - 1,
      finishedAt: null, deadlineAt: Date.now() + 30000});
    const {attempt} = await invoke(submitAttemptAnswer, uid, {attemptId: a.id,
      questionId: last.id, optionId: correct(last), requestId: randomUUID()});
    assert.equal(attempt.status, 'waiting');
    assert.ok((await read(work(uid, a))).dueAt <= Date.now());
    await drainLearningWork();
    assert.equal((await settled(uid, a, mode === 'PRACTICE' ? 1 : 2)).correctCount, a.questions.length);
  });

  await test('Confirming the final daily answer before midnight survives a restart after midnight without advance', async () => {
    const {uid, a} = await fresh('DAILY');
    await waiting(uid, a);
    const answers = await read(`${path(uid, a)}/answers`);
    delete answers[4];
    const endsAt = dailyEndsAt(await read(path(uid, a)));
    await adminDb.ref(path(uid, a)).update({status: 'active', answers,
      answeredCount: 4, correctCount: 4, finishedAt: null, deadlineAt: endsAt});
    const clock = Date.now;
    Date.now = () => endsAt - 1000;
    try {
      await invoke(submitAttemptAnswer, uid, {attemptId: a.id, questionId: a.questions[4].id,
        optionId: correct(a.questions[4]), requestId: randomUUID()});
      Date.now = () => endsAt + 1000;
      await drainLearningWork();
      const saved = await settled(uid, a, 2);
      assert.equal(saved.finishedAt, endsAt - 1000);
    } finally { Date.now = clock; }
  });

  await test('Midnight abandons yesterday daily before catch-up; no reward and a fresh slot today', async () => {
    const {uid, a: initial} = await fresh('DAILY');
    const yesterday = Date.now() - 86400000;
    const oldDate = getDateKey(yesterday);
    const today = getDateKey();
    const a = {...initial, id: `daily_${oldDate}`};
    await adminDb.ref().update({
      [path(uid, a)]: {...await read(path(uid, initial)), startedAt: yesterday},
      [path(uid, initial)]: null,
      [`attemptQuestions/${uid}/${a.id}`]: await read(`attemptQuestions/${uid}/${initial.id}`),
      [`attemptQuestions/${uid}/${initial.id}`]: null,
      [work(uid, a)]: {uid, attemptId: a.id, revision: 1, dueAt: 0},
      [work(uid, initial)]: null,
      [`userDailyChallenges/${uid}/${oldDate}`]: {attemptId: a.id, status: 'active', startedAt: yesterday},
      [`userDailyChallenges/${uid}/${today}`]: null});
    await expire(uid, a, dailyEndsAt({mode: 'DAILY', startedAt: yesterday}));
    await drainLearningWork();
    const saved = await read(path(uid, a));
    assert.equal(saved.status, 'abandoned');
    assert.equal(saved.coinsAwarded, 0);
    assert.equal(saved.answeredCount, 0);
    assert.equal(await read(`wallets/${uid}/coinBalance`), 0);
    assert.equal((await read(`userDailyChallenges/${uid}/${oldDate}`)).status, 'abandoned');
    const next = (await invoke(startAttempt, uid, {mode: 'DAILY', requestId: randomUUID()})).attempt;
    assert.notEqual(next.id, a.id);
    assert.equal(next.status, 'active');
  });

  await test('Discovery recreates missing jobs and retires an orphan daily slot', async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    await adminDb.ref(work(uid, a)).remove();
    const yesterday = getDateKey(Date.now() - 86400000);
    await adminDb.ref(`userDailyChallenges/${uid}/${yesterday}`).set({status: 'active', attemptId: 'lost_attempt'});
    await discoverLearningWork();
    assert.ok(await read(work(uid, a)));
    assert.equal((await read(`userDailyChallenges/${uid}/${yesterday}`)).status, 'abandoned');
    await drainLearningWork();
    await settled(uid, a, 1);
    await repairExpiredDailySlot(uid, yesterday);
    assert.equal(await read('practiceAttempts/lost_attempt'), null);
  });

  await test('Daily finished before midnight retains its reward after worker restart next day', async () => {
    const {uid, a} = await fresh('DAILY');
    await waiting(uid, a);
    const startedAt = Date.now() - 86400000;
    const endsAt = dailyEndsAt({mode: 'DAILY', startedAt});
    await adminDb.ref(path(uid, a)).update({startedAt, finishedAt: endsAt - 1});
    await adminDb.ref(`userDailyChallenges/${uid}/${getDateKey(startedAt)}`).set({
      attemptId: a.id, startedAt, status: 'waiting', completedQuestionCount: 5,
    });
    await drainLearningWork();
    const saved = await settled(uid, a, 2);
    assert.equal(saved.finishedAt, endsAt - 1);
    assert.equal((await read(`userDailyChallenges/${uid}/${getDateKey(startedAt)}`)).status, 'completed');
  });

  for (const stage of ['settlement', 'wallet', 'ledger', 'progress', 'skills', 'reviews', 'marker']) await test(`Interrupted ${stage} projection is retried without duplicate rewards`, async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    const targets = {settlement: [`userSettlements/${uid}`, 'transaction'],
      wallet: [`wallets/${uid}`, 'transaction'], ledger: [`coinLedger/${uid}/grant_${a.id}`, 'set'],
      progress: [`learningProgress/${uid}/${a.topicId}`, 'transaction'],
      skills: [`userSkillStats/${uid}/vocabulary`, 'transaction'], reviews: [`attemptReviews/${uid}/${a.id}`, 'update'],
      marker: [undefined, 'update']};
    const [target, method] = targets[stage];
    const original = adminDb.ref;
    let injected = false;
    adminDb.ref = function(refPath) {
      const ref = original.call(this, refPath);
      if (refPath === target) {
        const run = ref[method].bind(ref);
        ref[method] = async (...args) => {
          const isTarget = stage !== 'marker' || Object.keys(args[0]).some(k => k.endsWith('/settlementVersion'));
          if (!injected && isTarget) { injected = true; throw new Error('injected-storage-failure'); }
          return run(...args);
        };
      }
      return ref;
    };
    try { await drainLearningWork(); } finally { adminDb.ref = original; }
    assert.ok(injected, `must inject ${stage} failure`);
    assert.equal((await read(path(uid, a))).status, 'completed');
    assert.notEqual((await read(path(uid, a))).settlementVersion, 1);
    assert.ok(await read(work(uid, a)));
    await adminDb.ref(`${work(uid, a)}/dueAt`).set(0);
    await drainLearningWork();
    await settled(uid, a, 1);
    assert.equal((await read(`learningProgress/${uid}/${a.topicId}`)).completedAttempts, 1);
    assert.equal((await read(`userSkillStats/${uid}/vocabulary`)).completedAttempts, 1);
  });

  await test('Recreating a missing wallet includes every concurrent grant without double credit', async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    const b = (await invoke(startAttempt, uid, {mode: 'PRACTICE', topicId: a.topicId, requestId: randomUUID()})).attempt;
    await waiting(uid, b);
    await adminDb.ref(`wallets/${uid}`).remove();
    let pause, release;
    const reached = new Promise(resolve => { pause = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    const original = adminDb.ref;
    let intercepted = false;
    adminDb.ref = function(refPath) {
      const ref = original.call(this, refPath);
      if (refPath === `wallets/${uid}`) {
        const transaction = ref.transaction.bind(ref);
        ref.transaction = async (...args) => {
          if (!intercepted) { intercepted = true; pause(); await resume; }
          return transaction(...args);
        };
      }
      return ref;
    };
    const first = finalizeAttemptLogic(uid, a.id);
    try { await reached; await finalizeAttemptLogic(uid, b.id); }
    finally { release(); try { await first; } finally { adminDb.ref = original; } }
    assert.equal(await read(`wallets/${uid}/coinBalance`), 2);
    assert.equal(Object.keys(await read(`wallets/${uid}/appliedGrants`)).length, 2);
    assert.equal((await read(`learningProgress/${uid}/${a.topicId}`)).completedAttempts, 2);
  });

  await test('A crashed lease is reclaimed; concurrent stale advances cannot skip a question', async () => {
    const {uid, a} = await fresh();
    await choose(uid, a);
    await expire(uid, a);
    await adminDb.ref(work(uid, a)).update({leaseOwner: 'crashed', leaseUntil: Date.now() - 1});
    await Promise.all([drainLearningWork(), invoke(advanceAttempt, uid, {
      attemptId: a.id, expectedIndex: 0, requestId: randomUUID()})]);
    await invoke(advanceAttempt, uid, {attemptId: a.id, expectedIndex: 0, requestId: randomUUID()});
    assert.equal((await read(path(uid, a))).currentIndex, 1);
    assert.equal((await read(path(uid, a))).answeredCount, 1);
  });

  await test('Deleted or disabled account is abandoned without rewards', async () => {
    const {uid, a} = await fresh();
    await adminAuth.updateUser(uid, {disabled: true});
    await expire(uid, a);
    await drainLearningWork();
    assert.equal((await read(path(uid, a))).status, 'abandoned');
    assert.equal(await read(`wallets/${uid}/coinBalance`), 0);
  });

  await test('Late submits cannot mutate a terminal decision or its result', async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    // The local worker / scheduled function and callable run in separate
    // processes, with independent Admin SDK transaction caches.
    await Promise.all([
      runWorker(), finalizeAttemptLogic(uid, a.id, 'abandoned'),
    ]);
    const saved = await read(path(uid, a));
    await choose(uid, a, a.questions[0].options[0].id);
    await invoke(submitAttemptAnswer, uid, {attemptId: a.id, questionId: a.questions[0].id,
      optionId: a.questions[0].options[0].id, requestId: randomUUID()});
    const after = await read(path(uid, a));
    assert.equal(after.status, saved.status);
    assert.deepEqual(after.answers, saved.answers);
    assert.equal(after.coinsAwarded, saved.coinsAwarded);
  });

  await test('Private local runner executes one pass against the isolated emulators', async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    await runWorker();
    await settled(uid, a, 1);
  });

  await test('Queue isolation: client wakeups on 25 leased jobs cannot starve a ready attempt', async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    await adminDb.ref(`${work(uid, a)}/dueAt`).set(1);
    const leaseUntil = Date.now() + 90000;
    for (let i = 0; i < 25; i++) {
      const attemptId = `leased_${i}`;
      await adminDb.ref(`learningWork/${learningWorkKey(uid, attemptId)}`).set({
        uid, attemptId, dueAt: leaseUntil, revision: 1, leaseOwner: 'another-worker', leaseUntil,
      });
      await enqueueLearningWork(uid, attemptId, 0);
    }
    await drainLearningWork();
    await settled(uid, a, 1);
    const leased = await read(`learningWork/${learningWorkKey(uid, 'leased_0')}`);
    assert.equal(leased.leaseOwner, 'another-worker');
    assert.ok(leased.dueAt >= leaseUntil);
  });

  await test('Queue isolation: discovery failure still drains already queued work', async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    const original = adminDb.ref;
    adminDb.ref = function(refPath) {
      const ref = original.call(this, refPath);
      if (refPath === 'learningMaintenance/discovery') {
        ref.transaction = async () => { throw new Error('injected-discovery-failure'); };
      }
      return ref;
    };
    try { await assert.rejects(runLearningMaintenance(), /injected-discovery-failure/); }
    finally { adminDb.ref = original; }
    await settled(uid, a, 1);
  });

  await test('Queue isolation: malformed legacy daily keeps retry work without blocking discovery', async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    const broken = {id: '000_broken_daily'};
    await adminDb.ref(path(uid, broken)).set({mode: 'dailyChallenge', status: 'active',
      deadlineAt: Date.now() - 1, questionCount: 5, currentIndex: 0});
    await runLearningMaintenance();
    await settled(uid, a, 1);
    assert.equal((await read(work(uid, broken))).retryCount, 1);
    const cursor = await read('learningMaintenance/discovery');
    assert.equal(cursor.owner, undefined);
    assert.equal((await read(path(uid, broken))).status, 'active');
  });

  for (const stage of ['claim', 'retry-write']) await test(`Queue isolation: failed ${stage} cannot stop other jobs and remains recoverable`, async () => {
    const {uid, a} = await fresh();
    await waiting(uid, a);
    const b = (await invoke(startAttempt, uid, {mode: 'PRACTICE', topicId: a.topicId, requestId: randomUUID()})).attempt;
    await waiting(uid, b);
    await adminDb.ref(`${work(uid, b)}/dueAt`).set(1);
    const original = adminDb.ref;
    let injected = false, processingFailed = false;
    adminDb.ref = function(refPath) {
      const ref = original.call(this, refPath);
      if (stage === 'retry-write' && refPath === `wallets/${uid}`) {
        const transaction = ref.transaction.bind(ref);
        ref.transaction = async (...args) => {
          if (!processingFailed) { processingFailed = true; throw new Error('injected-projection-failure'); }
          return transaction(...args);
        };
      }
      if (refPath === work(uid, a)) {
        const transaction = ref.transaction.bind(ref);
        ref.transaction = async (...args) => {
          if (!injected && (stage === 'claim' || processingFailed)) {
            injected = true; throw new Error(`injected-${stage}-failure`);
          }
          return transaction(...args);
        };
      }
      return ref;
    };
    try { await drainLearningWork(); } finally { adminDb.ref = original; }
    assert.ok(injected);
    assert.equal((await read(path(uid, b))).settlementVersion, 1);
    assert.ok(await read(work(uid, a)));
    await adminDb.ref(work(uid, a)).update({dueAt: 0, leaseUntil: 0});
    await drainLearningWork();
    assert.equal((await read(path(uid, a))).settlementVersion, 1);
    assert.equal(await read(`wallets/${uid}/coinBalance`), 2);
    assert.equal(Object.keys(await read(`coinLedger/${uid}`)).length, 2);
  });

  await test('Queue isolation: a client wakeup during processing survives lease release', async () => {
    const {uid, a} = await fresh();
    await adminDb.ref(`${work(uid, a)}/dueAt`).set(0);
    const original = adminDb.ref;
    let reached, release, paused = false;
    const started = new Promise(resolve => { reached = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    adminDb.ref = function(refPath) {
      const ref = original.call(this, refPath);
      if (refPath === path(uid, a)) {
        const get = ref.get.bind(ref);
        ref.get = async () => {
          const snapshot = await get();
          if (!paused) { paused = true; reached(); await resume; }
          return snapshot;
        };
      }
      return ref;
    };
    const running = drainLearningWork();
    try { await started; await enqueueLearningWork(uid, a.id, 0); }
    finally { release(); try { await running; } finally { adminDb.ref = original; } }
    const job = await read(work(uid, a));
    assert.equal(job.dueAt, 0);
    assert.equal(job.leaseOwner, undefined);
    await drainLearningWork();
    assert.equal((await read(work(uid, a))).dueAt, a.deadlineAt);
    assert.equal((await read(path(uid, a))).currentIndex, 0);
  });

  await test('Discovery persists its cursor after eight pages and recovers a missing job on the next pass', async () => {
    const {uid, a: initial} = await fresh();
    await waiting(uid, initial);
    const a = {...initial, id: 'zz_pending'};
    const updates = {
      [path(uid, a)]: await read(path(uid, initial)), [path(uid, initial)]: null,
      [`attemptQuestions/${uid}/${a.id}`]: await read(`attemptQuestions/${uid}/${initial.id}`),
      [`attemptQuestions/${uid}/${initial.id}`]: null, [work(uid, initial)]: null,
    };
    for (let i = 0; i < 401; i++) updates[`practiceAttempts/${uid}/history_${String(i).padStart(3, '0')}`] = {
      mode: 'practice', status: 'completed', settlementVersion: 1,
    };
    await adminDb.ref().update(updates);
    await discoverLearningWork();
    assert.equal(await read(work(uid, a)), null);
    const cursor = await read('learningMaintenance/discovery');
    assert.equal(cursor.uid, uid);
    assert.equal(cursor.afterItem, 'history_399');
    await adminDb.ref('learningMaintenance/discovery/nextRunAt').set(0);
    await discoverLearningWork();
    assert.ok(await read(work(uid, a)));
    await drainLearningWork();
    await settled(uid, a, 1);
  });

  for (const source of ['finalizer', 'worker', 'resume']) await test(`Midnight race: stale ${source} snapshot cannot abandon a daily finished before midnight`, async () => {
    const {uid, a} = await fresh('DAILY');
    await waiting(uid, a);
    const answers = await read(`${path(uid, a)}/answers`);
    delete answers[4];
    const endsAt = dailyEndsAt(await read(path(uid, a)));
    await adminDb.ref(path(uid, a)).update({status: 'active', answers,
      answeredCount: 4, correctCount: 4, finishedAt: null, deadlineAt: endsAt});
    const stale = await read(path(uid, a));
    const original = adminDb.ref;
    const clock = Date.now;
    let reached, release, paused = false, pending;
    const started = new Promise(resolve => { reached = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    Date.now = () => endsAt - 1000;
    if (source !== 'resume') adminDb.ref = function(refPath) {
      const ref = original.call(this, refPath);
      if (refPath === path(uid, a)) {
        const get = ref.get.bind(ref);
        ref.get = async () => {
          const snapshot = await get();
          if (!paused) { paused = true; reached(); await resume; }
          return snapshot;
        };
      }
      return ref;
    };
    try {
      if (source !== 'resume') {
        pending = source === 'worker' ? drainLearningWork() : finalizeAttemptLogic(uid, a.id);
        await started;
      }
      await invoke(submitAttemptAnswer, uid, {attemptId: a.id, questionId: a.questions[4].id,
        optionId: correct(a.questions[4]), requestId: randomUUID()});
      Date.now = () => endsAt + 1000;
      release();
      if (source === 'resume') await readAttemptResponse(uid, a.id, stale);
      else await pending;
      const saved = await settled(uid, a, 2);
      assert.equal(saved.finishedAt, endsAt - 1000);
      assert.equal(saved.correctCount, 5);
    } finally {
      release();
      try { if (pending) await pending; }
      finally { adminDb.ref = original; Date.now = clock; }
    }
  });
} finally { await deleteApp(adminDb.app); }
