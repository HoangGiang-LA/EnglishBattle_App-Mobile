import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test as nodeTest} from 'node:test';
import {once} from 'node:events';
import {mobileContract, assertAttemptSemantics} from '../../../../frontend/contracts/mobile.v1.mjs';

// Check every destination before importing Admin SDK or writing any fixture.
assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-finalization');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9199');
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:9100');
assert.equal(process.env.FUNCTIONS_EMULATOR_HOST, '127.0.0.1:5002');
const require = createRequire(new URL('../../../functions/package.json', import.meta.url));
const {adminDb, adminAuth} = require('./lib/config/firebaseAdmin.js');
const {deleteApp} = require('firebase-admin/app');
assert.match(adminDb.ref().toString(), /^http:\/\/127\.0\.0\.1:9100\//);
const Ajv = require('ajv');
const ajv = new Ajv({strict: false});
const validators = Object.fromEntries(Object.entries(mobileContract.methods)
  .map(([name, method]) => [name, ajv.compile(method.response)]));
const seed = JSON.parse(readFileSync(new URL('../../../database/english-battle.seed.json', import.meta.url), 'utf8'));
const namespace = new URL(adminDb.app.options.databaseURL).hostname.split('.')[0];
let base = 'http://127.0.0.1:5002/demo-englishbattle-finalization/asia-southeast1';
let mobileServer;
if (process.env.ENGLISH_BATTLE_ACCEPTANCE_MOBILE_API === 'true') {
  // Only the isolated test process may supply an emulator Auth verifier.
  // The production launcher explicitly refuses every emulator setting.
  const {createMobileApi, mobileHandlers} = await import('../../../functions/tools/mobile-api/http.mjs');
  mobileServer = createMobileApi({handlers: mobileHandlers(require('./lib/index.js')),
    verifyToken: (token, checkRevoked) => adminAuth.verifyIdToken(token, checkRevoked)});
  mobileServer.listen(0, '127.0.0.1');
  await once(mobileServer, 'listening');
  base = `http://127.0.0.1:${mobileServer.address().port}/api`;
}
const covered = new Set();
const read = async path => (await adminDb.ref(path).get()).val();
const test = (name, run) => nodeTest(name, {timeout: 240000}, run);
const sessionMethods = new Set(['findBattle', 'getBattleTicket', 'cancelBattleSearch', 'resumeAttempt',
  'submitAttemptAnswer', 'saveAttemptSelection', 'advanceAttempt', 'leaveAttempt', 'getAttemptResult']);
async function call(name, user, data = {}) {
  const response = await fetch(`${base}/${name}`, {
    method: 'POST', signal: AbortSignal.timeout(65000),
    headers: {'Content-Type': 'application/json', ...(user ? {Authorization: `Bearer ${user.idToken}`} : {})},
    body: JSON.stringify({data: {...data, ...(user && sessionMethods.has(name) ? {clientSessionId: user.sid} : {})}}),
  });
  const envelope = await response.json();
  if (response.ok) {
    assert.ok(validators[name](envelope.result), `${name}: ${JSON.stringify(validators[name].errors)}`);
    if (envelope.result.attempt) assertAttemptSemantics(envelope.result.attempt);
    covered.add(name);
  }
  return {status: response.status, value: envelope.result, error: envelope.error};
}
async function ok(name, user, data = {}) {
  const result = await call(name, user, data);
  assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}
async function rejected(name, user, data, status) {
  const result = await call(name, user, data);
  assert.equal(result.status, status, `${name}: expected ${status}, received ${JSON.stringify(result.error)}`);
}
async function authApi(operation, data) {
  const response = await fetch(`http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:${operation}?key=fake-api-key`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
  });
  assert.equal(response.status, 200, `Auth emulator ${operation} failed`);
  return response.json();
}
async function user() {
  const email = `acceptance-${randomUUID()}@example.test`;
  const password = `Qa-${randomUUID()}!`;
  const account = await authApi('signUp', {email, password, returnSecureToken: true});
  const signedIn = await authApi('signInWithPassword', {email, password, returnSecureToken: true});
  assert.equal(signedIn.localId, account.localId);
  return {...signedIn, uid: signedIn.localId, sid: randomUUID(), email};
}
const start = async (u, mode, requestId = randomUUID()) => (await ok('startAttempt', u,
  {mode, requestId, ...(mode === 'PRACTICE' ? {topicId: 'vocabulary_daily_life'} : {})})).attempt;
const correct = q => seed.questionAnswers[q.id][q.version].correctOptionId;
async function finish(u, attempt, right = () => true, invoke = ok) {
  for (let i = 0; i < attempt.questions.length; i++) {
    const q = attempt.questions[i];
    const optionId = right(i) ? correct(q) : q.options.find(o => o.id !== correct(q)).id;
    await invoke('saveAttemptSelection', u, {attemptId: attempt.id, questionId: q.id, optionId, requestId: randomUUID()});
    const result = await invoke('submitAttemptAnswer', u, {attemptId: attempt.id, questionId: q.id, optionId, requestId: randomUUID()});
    if (i + 1 < attempt.questions.length) {
      assert.equal(result.attempt.receipts[i].correct, right(i));
      await invoke('advanceAttempt', u, {attemptId: attempt.id, expectedIndex: i, requestId: randomUUID()});
    } else assert.ok(['waiting', 'completed'].includes(result.attempt.status));
  }
  return (await invoke('getAttemptResult', u, {attemptId: attempt.id})).result;
}
async function clientRead(path, u, query = '') {
  return fetch(`http://127.0.0.1:9100/${path}.json?ns=${namespace}${u ? `&auth=${encodeURIComponent(u.idToken)}` : ''}${query}`);
}
async function worker() {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../functions/tools/learning-worker.mjs', import.meta.url)), '--once'],
      {env: {...process.env}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.on('error', reject); child.on('exit', code => resolve({code, output}));
  });
  assert.equal(result.code, 0, result.output);
}

let a, b, practice, exam, daily, abandoned, battleId;
try {
  const rules = await fetch(`http://127.0.0.1:9100/.settings/rules.json?ns=${namespace}`, {
    method: 'PUT', headers: {Authorization: 'Bearer owner', 'Content-Type': 'application/json'},
    body: readFileSync(new URL('../../../../database.rules.json', import.meta.url), 'utf8'),
  });
  assert.equal(rules.status, 200);
  await adminDb.ref().set(seed);

  await test('HTTP: all exported callable endpoints reject absent or invalid Firebase tokens', async () => {
    await Promise.all([
      rejected('learningAttempt', null, {}, 401),
      rejected('learningAttempt', null, {}, 401),
    ]);
    for (const name of Object.keys(mobileContract.methods)) {
      await rejected(name, null, {}, 401);
      await rejected(name, {idToken: 'invalid-token', sid: randomUUID()}, {}, 401);
    }
  });
  await test('HTTP Auth -> provision -> published catalog -> empty dashboard; retries preserve the same profile', async () => {
    [a, b] = await Promise.all([user(), user()]);
    assert.equal((await clientRead('categories', a, '&orderBy=%22status%22&equalTo=%22published%22')).status, 401);
    await Promise.all([ok('ensureUserProfile', a), ok('ensureUserProfile', a), ok('ensureUserProfile', b)]);
    for (const path of ['users', 'userPrivate', 'accountAccess', 'userStats', 'wallets']) assert.ok(await read(`${path}/${a.uid}`));
    for (const path of ['practiceAttempts', 'battleHistory', 'coinLedger']) assert.equal(await read(`${path}/${a.uid}`), null);
    const {dashboard} = await ok('getUserDashboard', a);
    assert.equal(dashboard.coins, 0); assert.equal(dashboard.rating, 0); assert.equal(dashboard.history.length, 0);
    for (const path of ['categories', 'topics']) {
      const response = await clientRead(path, a, '&orderBy=%22status%22&equalTo=%22published%22');
      assert.equal(response.status, 200);
      const values = await response.json();
      assert.ok(Object.keys(values).length > 0);
      assert.ok(Object.values(values).every(v => v.status === 'published'));
    }
    await adminAuth.updateUser(a.uid, {displayName: 'Acceptance learner'});
    await ok('ensureUserProfile', a);
    assert.equal((await read(`users/${a.uid}`)).displayName, 'Acceptance learner');
    await authApi('sendOobCode', {requestType: 'PASSWORD_RESET', email: a.email});
    const messages = await (await fetch('http://127.0.0.1:9199/emulator/v1/projects/demo-englishbattle-finalization/oobCodes')).json();
    assert.ok(messages.oobCodes.some(v => v.email === a.email && v.requestType === 'PASSWORD_RESET'));
  });
  await test('Production Rules: clients cannot enumerate catalogs, read secrets or write privileged/server data', async () => {
    for (const u of [null, a, b]) {
      for (const path of ['', 'categories', `userPrivate/${a.uid}`, `wallets/${a.uid}`,
        'questions', 'questionVersions', 'questionAnswers', 'battleQuestionSets', 'appConfig/server',
        'learningWork', 'battleWork', 'userSettlements', 'communityCursors', 'reportingBackfill', 'studyActivities']) {
        assert.equal((await clientRead(path, u)).status, 401, `Unexpected read permission: ${path}`);
      }
    }
    for (const path of [`wallets/${a.uid}/coinBalance`, `userStats/${a.uid}/rating`, `accountAccess/${a.uid}/status`,
      `practiceAttempts/${a.uid}/fake`, `userActivityDaily/${a.uid}/2099-01-01`, `notifications/${a.uid}/fake`]) {
      const response = await fetch(`http://127.0.0.1:9100/${path}.json?ns=${namespace}&auth=${encodeURIComponent(a.idToken)}`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(999),
      });
      assert.equal(response.status, 401, `Unexpected write permission: ${path}`);
    }
  });
  await test('HTTP practice: stable snapshots, foreign UID rejection, 10 answers, final result and one reward', async () => {
    const requestId = randomUUID(); practice = await start(a, 'PRACTICE', requestId);
    const retry = await start(a, 'PRACTICE', requestId); assert.equal(retry.id, practice.id);
    assert.deepEqual(retry.questions, practice.questions); assert.equal(retry.deadlineAt, practice.deadlineAt);
    assert.equal(practice.questions.length, 10);
    assert.ok(practice.questions.every(q => q.categoryId === 'vocabulary' && !('explanation' in q) && !('correctId' in q)));
    for (const name of ['resumeAttempt', 'getAttemptResult', 'leaveAttempt'])
      await rejected(name, b, {attemptId: practice.id, requestId: randomUUID()}, 404);
    await rejected('submitAttemptAnswer', b, {attemptId: practice.id, questionId: practice.questions[0].id,
      optionId: correct(practice.questions[0]), requestId: randomUUID()}, 404);
    assert.deepEqual((await ok('resumeAttempt', a, {attemptId: practice.id})).attempt.questions, practice.questions);
    const result = await finish(a, practice);
    assert.equal(result.correct, 10); assert.equal(result.coins, 1); assert.equal(result.reviews.length, 10);
    assert.equal(result.outcome, 'completed'); assert.ok(result.durationMs >= 0 && result.durationMs <= 300000);
    await Promise.all([ok('getAttemptResult', a, {attemptId: practice.id}), ok('leaveAttempt', a, {attemptId: practice.id, requestId: randomUUID()})]);
    assert.equal(await read(`wallets/${a.uid}/coinBalance`), 1);
    assert.equal((await read(`learningProgress/${a.uid}/vocabulary_daily_life`)).completedAttempts, 1);
  });
  await test('HTTP learning callable: routes every quiz action and shares state with the legacy endpoints', async () => {
    const learner = await user();
    await ok('ensureUserProfile', learner);
    const invoke = (action, u, payload) => ok('learningAttempt', u, {action, payload});
    const payload = {mode: 'PRACTICE', topicId: 'vocabulary_daily_life', requestId: randomUUID()};
    const {attempt} = await invoke('startAttempt', learner, payload);
    assert.equal((await start(learner, 'PRACTICE', payload.requestId)).id, attempt.id);
    const ref = {attemptId: attempt.id};
    assert.deepEqual((await invoke('resumeAttempt', learner, ref)).attempt.questions, attempt.questions);
    await rejected('learningAttempt', b, {action: 'resumeAttempt', payload: ref}, 404);
    await rejected('learningAttempt', learner, {action: 'getUserDashboard', payload: {}}, 400);
    await rejected('learningAttempt', learner, {action: 'resumeAttempt', payload: {attemptId: 'battle_invalid'}}, 400);
    const result = await finish(learner, attempt, i => i !== 0, invoke);
    assert.equal(result.correct, 9);
    assert.equal(result.coins, 1);
    const replay = await invoke('leaveAttempt', learner, {...ref, requestId: randomUUID()});
    assert.deepEqual(replay.attempt.result, result);
    assert.equal(await read(`wallets/${learner.uid}/coinBalance`), 1);
  });
  await test('HTTP test and daily: 20/5 questions, unique daily slot, terminal result and exact reward totals', async () => {
    exam = await start(a, 'TEST'); assert.equal(exam.questions.length, 20);
    const examResult = await finish(a, exam, i => i % 2 === 0);
    assert.equal(examResult.correct, 10); assert.equal(examResult.coins, 2);
    const starts = await Promise.all([start(a, 'DAILY'), start(a, 'DAILY')]);
    daily = starts[0]; assert.equal(daily.id, starts[1].id); assert.equal(daily.questions.length, 5);
    const dailyResult = await finish(a, daily);
    assert.equal(dailyResult.correct, 5); assert.equal(dailyResult.coins, 2);
    await rejected('startAttempt', a, {mode: 'DAILY', requestId: randomUUID()}, 409);
    assert.equal(await read(`wallets/${a.uid}/coinBalance`), 5);
    assert.equal((await read(`learningProgress/${a.uid}/vocabulary_daily_life`)).completedAttempts, 1);
    abandoned = await start(a, 'PRACTICE');
    const left = await ok('leaveAttempt', a, {attemptId: abandoned.id, requestId: randomUUID()});
    assert.equal(left.attempt.status, 'abandoned'); assert.equal(left.attempt.result.coins, 0);
  });
  await test('HTTP quick battle: cancellation, deferred modes, two tokens, common rounds, immutable result and rewards', async () => {
    for (const kind of ['daily', 'create', 'join']) await rejected('findBattle', a, {kind, roomCode: 'ABC123', requestId: randomUUID()}, 501);
    const cancelled = (await ok('findBattle', a, {kind: 'quick', requestId: randomUUID()})).ticket;
    await ok('cancelBattleSearch', a, {ticketId: cancelled.id});
    assert.equal((await ok('getBattleTicket', a, {ticketId: cancelled.id})).ticket.status, 'cancelled');
    const t1 = (await ok('findBattle', a, {kind: 'quick', requestId: randomUUID()})).ticket;
    const t2 = (await ok('findBattle', b, {kind: 'quick', requestId: randomUUID()})).ticket;
    assert.equal(t2.status, 'matched'); battleId = t2.attemptId;
    assert.equal((await ok('getBattleTicket', a, {ticketId: t1.id})).ticket.attemptId, battleId);
    await ok('resumeAttempt', a, {attemptId: battleId}); await ok('resumeAttempt', b, {attemptId: battleId});
    const attempt = (await ok('resumeAttempt', a, {attemptId: battleId})).attempt;
    const other = (await ok('resumeAttempt', b, {attemptId: battleId})).attempt;
    assert.deepEqual(attempt.questions, other.questions); assert.equal(attempt.deadlineAt, other.deadlineAt);
    for (const q of attempt.questions) {
      const answered = (await ok('submitAttemptAnswer', a, {attemptId: battleId, questionId: q.id, optionId: correct(q), requestId: randomUUID()})).attempt;
      assert.equal(answered.receipts.at(-1).correct, null);
      await ok('submitAttemptAnswer', b, {attemptId: battleId, questionId: q.id,
        optionId: q.options.find(o => o.id !== correct(q)).id, requestId: randomUUID()});
    }
    const win = (await ok('getAttemptResult', a, {attemptId: battleId})).result;
    const loss = (await ok('getAttemptResult', b, {attemptId: battleId})).result;
    assert.equal(win.outcome, 'win'); assert.equal(win.ratingDelta, 5); assert.equal(win.coins, 5);
    assert.equal(loss.outcome, 'loss'); assert.equal(loss.ratingDelta, 0); assert.equal(loss.coins, 0);
    assert.equal(win.reviews.length, 10); assert.equal(loss.reviews.length, 10);
    await ok('leaveAttempt', a, {attemptId: battleId, requestId: randomUUID()});
    assert.deepEqual((await ok('getAttemptResult', a, {attemptId: battleId})).result, win);
  });
  await test('HTTP projections: statistics, history, leaderboard, notifications and ledger match committed source results', async () => {
    const {dashboard} = await ok('getUserDashboard', a);
    assert.equal(dashboard.coins, 10); assert.equal(dashboard.rating, 5); assert.equal(dashboard.wins, 1);
    for (const period of ['week', 'month']) {
      const {statistics} = await ok('getStudyStatistics', a, {period});
      assert.equal(statistics.current.sessions, 4); assert.equal(statistics.current.answered, 45);
      assert.equal(statistics.current.correct, 35); assert.equal(statistics.current.unknownDurationSessions, 0);
    }
    const learning = (await ok('getHistory', a, {kind: 'learning'})).page.entries;
    assert.equal(learning.length, 4); assert.ok(learning.every(e => e.reviews.length === 0));
    const battles = (await ok('getHistory', a, {kind: 'battle'})).page.entries;
    assert.equal(battles.length, 1); assert.equal(battles[0].attemptId, battleId);
    const ledger = (await ok('getCoinLedger', a)).page.entries;
    assert.equal(ledger.reduce((total, e) => total + e.delta, 0), dashboard.coins);
    const week = (await ok('getLeaderboard', a, {period: 'week'})).page;
    const month = (await ok('getLeaderboard', a, {period: 'month'})).page;
    assert.deepEqual(week.entries, month.entries); assert.equal(week.self.uid, a.uid); assert.equal(week.self.rank, 1);
    const notifications = (await ok('getNotifications', a)).page;
    assert.ok(notifications.unreadCount > 0);
    await ok('markNotificationsRead', b, {ids: notifications.entries.map(n => n.id)});
    assert.equal((await ok('getNotifications', a)).page.unreadCount, notifications.unreadCount);
    await ok('markNotificationsRead', a, {all: true});
    assert.equal((await ok('getNotifications', a)).page.unreadCount, 0);
    await worker(); await worker();
    assert.equal((await ok('getNotifications', a)).page.unreadCount, 0);
    assert.equal((await ok('getUserDashboard', a)).dashboard.coins, 10);
    assert.equal((await read(`userSettlements/${a.uid}`)).coinBalance, 10);
  });
  await test('HTTP: all callable endpoints enforce banned/deleted/disabled account access without side effects', async () => {
    const payloads = {
      ensureUserProfile: {}, getUserDashboard: {}, getStudyStatistics: {period: 'week'}, getHistory: {kind: 'learning'}, getCoinLedger: {},
      startAttempt: {mode: 'PRACTICE', topicId: 'vocabulary_daily_life', requestId: randomUUID()},
      resumeAttempt: {attemptId: practice.id}, getAttemptResult: {attemptId: practice.id},
      learningAttempt: {action: 'resumeAttempt', payload: {attemptId: practice.id}},
      saveAttemptSelection: {attemptId: practice.id, questionId: practice.questions[0].id, optionId: correct(practice.questions[0]), requestId: randomUUID()},
      submitAttemptAnswer: {attemptId: practice.id, questionId: practice.questions[0].id, optionId: correct(practice.questions[0]), requestId: randomUUID()},
      advanceAttempt: {attemptId: practice.id, requestId: randomUUID()}, leaveAttempt: {attemptId: practice.id, requestId: randomUUID()},
      findBattle: {kind: 'quick', requestId: randomUUID()}, getBattleTicket: {ticketId: randomUUID()}, cancelBattleSearch: {ticketId: randomUUID()},
      getLeaderboard: {period: 'week'}, getNotifications: {}, markNotificationsRead: {all: true},
    };
    for (const status of ['banned', 'deleted', 'disabled']) {
      await adminDb.ref(`accountAccess/${a.uid}/status`).set(status === 'disabled' ? 'active' : status);
      await adminAuth.updateUser(a.uid, {disabled: status === 'disabled'});
      for (const [name, data] of Object.entries(payloads)) await rejected(name, a, data, 403);
      if (status !== 'disabled') assert.equal((await clientRead('categories', a, '&orderBy=%22status%22&equalTo=%22published%22')).status, 401);
      assert.equal(await read(`wallets/${a.uid}/coinBalance`), 10);
    }
    await adminAuth.updateUser(a.uid, {disabled: false});
    await adminDb.ref(`accountAccess/${a.uid}/status`).set('active');
  });
  await test('HTTP + real worker: after 30 seconds an unconfirmed correct/wrong/missing selection is graded without app callbacks', async () => {
    const cases = [];
    for (const kind of ['correct', 'wrong', 'none']) {
      const u = await user(); await ok('ensureUserProfile', u);
      const attempt = await start(u, 'PRACTICE');
      const q = attempt.questions[0];
      const optionId = kind === 'none' ? null : kind === 'correct' ? correct(q) : q.options.find(o => o.id !== correct(q)).id;
      if (optionId) await ok('saveAttemptSelection', u, {attemptId: attempt.id, questionId: q.id, optionId, requestId: randomUUID()});
      cases.push({kind, u, attempt, optionId});
    }
    // Real wall clock, no fixture edits and no resume/advance/submit callbacks.
    await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, Math.max(...cases.map(c => c.attempt.deadlineAt)) - Date.now() + 100)));
    await worker();
    for (const {kind, u, attempt, optionId} of cases) {
      const stored = await read(`practiceAttempts/${u.uid}/${attempt.id}`);
      assert.equal(stored.currentIndex, 1);
      assert.equal(stored.answers[0].selectedOptionId ?? null, optionId);
      assert.equal(stored.answers[0].isCorrect, kind === 'correct');
      assert.equal(stored.answers[0].timedOut, true);
      await ok('leaveAttempt', u, {attemptId: attempt.id, requestId: randomUUID()});
      assert.equal(await read(`wallets/${u.uid}/coinBalance`), 0);
    }
  });
  await test('HTTP acceptance exercised every current callable successfully', () => {
    assert.deepEqual([...covered].sort(), Object.keys(mobileContract.methods).sort());
  });
} finally {
  if (mobileServer) await new Promise(resolve => {
    mobileServer.close(resolve); mobileServer.closeAllConnections();
  });
  await deleteApp(adminDb.app);
}
