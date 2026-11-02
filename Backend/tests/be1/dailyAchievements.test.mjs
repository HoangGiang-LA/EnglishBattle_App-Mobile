import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {test as nodeTest} from 'node:test';

assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-finalization');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9199');
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:9100');
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const {adminDb, adminAuth} = require('./lib/config/firebaseAdmin.js');
const {deleteApp} = require('firebase-admin/app');
assert.match(adminDb.ref().toString(), /^http:\/\/127\.0\.0\.1:9100\//);
const {refreshDailyAchievements} = require('./lib/be1/community/dailyAchievements.js');
const {runCommunityMaintenance} = require('./lib/be1/community/communityMaintenance.js');
const {ensureUserProfile} = require('./lib/be1/auth/ensureUserProfile.js');
const {getUserDashboard} = require('./lib/be1/user/getUserDashboard.js');
const {startAttempt} = require('./lib/be1/practice/startAttempt.js');
const {getAttemptResult} = require('./lib/be1/practice/getAttemptResult.js');
const {getDateKey} = require('./lib/be1/practice/attemptHelper.js');
const seed = JSON.parse(readFileSync(new URL('../../database/english-battle.seed.json', import.meta.url), 'utf8'));
const test = (name, run) => nodeTest(name, {timeout: 60000}, run);
const read = async path => (await adminDb.ref(path).get()).val();
const call = (fn, uid, data = {}) => fn.run({auth: {uid}, data});
const badge = 'seven_daily_challenges';
let uid;
async function fresh() {
  await adminDb.ref().set(seed);
  const user = await adminAuth.createUser({email: `daily-achievement-${randomUUID()}@example.test`});
  uid = user.uid; await call(ensureUserProfile, uid);
}
async function day(daysAgo, changes = {}) {
  const date = getDateKey(Date.now() - daysAgo * 86400000);
  const startedAt = Date.parse(`${date}T10:00:00+07:00`);
  const id = `daily_${date}`;
  const source = {mode: 'daily', status: 'completed', questionCount: 5,
    correctCount: 4, answeredCount: 5, coinsAwarded: 2, startedAt,
    finishedAt: startedAt + 60000, ...changes};
  await adminDb.ref(`practiceAttempts/${uid}/${id}`).set(source);
  await adminDb.ref(`userDailyChallenges/${uid}/${date}`).set({attemptId: id, status: source.status});
  return {date, id, source};
}
try {
  const ns = new URL(adminDb.app.options.databaseURL).hostname.split('.')[0];
  const rules = await fetch(`http://127.0.0.1:9100/.settings/rules.json?ns=${ns}`, {
    method: 'PUT', headers: {Authorization: 'Bearer owner', 'Content-Type': 'application/json'},
    body: readFileSync(new URL('../../../database.rules.json', import.meta.url), 'utf8'),
  });
  assert.equal(rules.status, 200);

  await test('Daily achievements: six locked, seventh unlocked, eighth/retries preserve one notification with no extra coins', async () => {
    await fresh();
    await refreshDailyAchievements(uid);
    assert.equal(await read(`userAchievements/${uid}`), null);
    for (let i = 2; i <= 7; i++) await day(i);
    await refreshDailyAchievements(uid);
    let record = await read(`userAchievements/${uid}/${badge}`);
    assert.equal(record.progress, 6); assert.equal(record.unlockedAt, undefined);
    assert.equal(await read(`notifications/${uid}`), null);
    await day(1);
    await adminDb.ref(`achievements/${badge}/rewardCoins`).set(999);
    await Promise.all(Array.from({length: 8}, () => refreshDailyAchievements(uid)));
    record = await read(`userAchievements/${uid}/${badge}`);
    assert.equal(record.progress, 7); assert.ok(record.unlockedAt);
    const first = record.unlockedAt;
    await day(8); await refreshDailyAchievements(uid);
    assert.equal((await read(`userAchievements/${uid}/${badge}`)).unlockedAt, first);
    assert.equal(Object.keys(await read(`notifications/${uid}`)).length, 1);
    assert.equal(await read(`wallets/${uid}/coinBalance`), 0);
    assert.equal(await read(`coinLedger/${uid}`), null);
    const dashboard = (await call(getUserDashboard, uid)).dashboard;
    assert.equal(dashboard.achievements.find(a => a.id === badge).unlocked, true);
    assert.equal(dashboard.achievements.find(a => a.id === badge).progress, 7);
  });
  await test('Daily achievements: actual finalization of the seventh day unlocks before settlement marker and retries award only two coins', async () => {
    await fresh();
    for (let i = 1; i <= 6; i++) await day(i);
    const {attempt} = await call(startAttempt, uid, {mode: 'DAILY', requestId: randomUUID()});
    const answers = Object.fromEntries(attempt.questions.map((q, i) => [i, {
      questionId: q.id, selectedOptionId: seed.questionAnswers[q.id][q.version].correctOptionId,
      isCorrect: true, timedOut: false, ordinal: i, requestId: randomUUID(), receivedAt: Date.now(),
    }]));
    await adminDb.ref(`practiceAttempts/${uid}/${attempt.id}`).update({status: 'waiting', answers,
      answerStateVersion: 1, currentIndex: 4, correctCount: 5, answeredCount: 5, finishedAt: Date.now()});
    const result = await call(getAttemptResult, uid, {attemptId: attempt.id});
    assert.equal(result.result.coins, 2);
    assert.ok((await read(`userAchievements/${uid}/${badge}`)).unlockedAt);
    assert.equal(await read(`practiceAttempts/${uid}/${attempt.id}/settlementVersion`), 1);
    await Promise.all(Array.from({length: 5}, () => call(getAttemptResult, uid, {attemptId: attempt.id})));
    assert.equal(await read(`wallets/${uid}/coinBalance`), 2);
    assert.equal(Object.keys(await read(`coinLedger/${uid}`)).length, 1);
  });
  await test('Daily achievements: a failed notification is recovered by the worker after definition archive with its frozen text', async () => {
    await fresh();
    for (let i = 1; i <= 7; i++) await day(i);
    const original = adminDb.ref; let injected = false;
    adminDb.ref = function(path) {
      const ref = original.call(this, path);
      if (path === `notificationCounts/${uid}` && !injected) {
        ref.transaction = async () => { injected = true; throw new Error('daily-notification-failure'); };
      }
      return ref;
    };
    try { await assert.rejects(refreshDailyAchievements(uid), /daily-notification-failure/); }
    finally { adminDb.ref = original; }
    assert.ok(injected);
    const earned = await read(`userAchievements/${uid}/${badge}`);
    assert.ok(earned.unlockedAt); assert.ok(earned.notification);
    await adminDb.ref(`achievements/${badge}`).update({status: 'archived', title: 'Changed after unlock'});
    await runCommunityMaintenance();
    const events = Object.values(await read(`notifications/${uid}`));
    assert.equal(events.length, 1); assert.equal(events[0].body, earned.notification.body);
    assert.equal(await read(`wallets/${uid}/coinBalance`), 0);
  });
  await test('Daily achievements: paginate past abandoned days and reject forged slots, wrong modes and duplicate source dates', async () => {
    await fresh();
    for (let i = 1; i <= 28; i++) await day(i, {status: 'abandoned'});
    for (let i = 29; i <= 35; i++) await day(i);
    const invalid = await day(1, {mode: 'test'});
    await day(2, {questionCount: 20});
    const wrongDate = await day(3);
    await adminDb.ref(`practiceAttempts/${uid}/${wrongDate.id}`).update({startedAt: invalid.source.startedAt});
    await adminDb.ref(`userDailyChallenges/${uid}/${getDateKey(Date.now())}`).set({status: 'completed', attemptId: 'missing-source'});
    await refreshDailyAchievements(uid);
    const record = await read(`userAchievements/${uid}/${badge}`);
    assert.equal(record.progress, 7); assert.ok(record.unlockedAt);
    assert.equal(await read(`wallets/${uid}/coinBalance`), 0);
  });
  await test('Daily achievements: a delayed scan of six days cannot overwrite the seventh-day unlock', async () => {
    await fresh();
    for (let i = 2; i <= 7; i++) await day(i);
    const original = adminDb.ref;
    let release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    let held = false;
    adminDb.ref = function(path) {
      const ref = original.call(this, path);
      if (path === `userAchievements/${uid}/${badge}` && !held) {
        const transaction = ref.transaction.bind(ref);
        ref.transaction = async (...args) => { held = true; entered(); await blocked; return transaction(...args); };
      }
      return ref;
    };
    const old = refreshDailyAchievements(uid);
    try {
      await reached; await day(1); await refreshDailyAchievements(uid); release(); await old;
    } finally { release(); adminDb.ref = original; }
    const record = await read(`userAchievements/${uid}/${badge}`);
    assert.equal(record.progress, 7); assert.ok(record.unlockedAt);
    assert.equal(Object.keys(await read(`notifications/${uid}`)).length, 1);
  });
  await test('Daily achievements: draft and invalid rules do not unlock and malformed legacy records do not break dashboard', async () => {
    await fresh();
    for (let i = 1; i <= 7; i++) await day(i);
    await adminDb.ref(`achievements/${badge}/status`).set('draft');
    await adminDb.ref(`userAchievements/${uid}/malformed`).set(123);
    await refreshDailyAchievements(uid);
    assert.equal(await read(`userAchievements/${uid}/${badge}`), null);
    await adminDb.ref(`achievements/${badge}`).update({status: 'published', threshold: -1});
    await refreshDailyAchievements(uid);
    assert.equal(await read(`userAchievements/${uid}/${badge}`), null);
    assert.equal(await read(`notifications/${uid}`), null);
    assert.ok((await call(getUserDashboard, uid)).dashboard);
  });
} finally { await deleteApp(adminDb.app); }
