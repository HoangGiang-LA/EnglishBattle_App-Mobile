import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {test as nodeTest} from 'node:test';
import {mobileContract} from '../../../../frontend/contracts/mobile.v1.mjs';
import {startBackend} from './helpers/backendClient.mjs';

assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9199');
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:9100');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-finalization');
const require = createRequire(new URL('../../../functions/package.json', import.meta.url));
const {adminAuth, adminDb} = require('./lib/config/firebaseAdmin.js');
const {deleteApp} = require('firebase-admin/app');
const {ensureUserProfile} = require('./lib/be1/auth/ensureUserProfile.js');
const {getUserDashboard} = require('./lib/be1/user/getUserDashboard.js');
const {markNotificationsRead} = require('./lib/be1/user/markNotificationsRead.js');
const {selectQuestions} = require('./lib/be1/practice/startAttempt.js');
const {settleBattle} = require('./lib/be1/battle/battleSettlement.js');
const {runBattleMaintenance} = require('./lib/be1/battle/battleMaintenance.js');
const {enqueueBattleWork} = require('./lib/be1/battle/battleWork.js');
const {projectBattleAchievements} = require('./lib/be1/battle/battleAchievements.js');
const Ajv = require('ajv');
const validateDashboard = new Ajv({strict: false}).compile(mobileContract.methods.getUserDashboard.response);
const seed = JSON.parse(readFileSync(new URL('../../../database/english-battle.seed.json', import.meta.url), 'utf8'));
assert.match(adminDb.ref().toString(), /^http:\/\/127\.0\.0\.1:9100\//);
const test = (title, run) => nodeTest(title, {timeout: 30000}, run);
const read = async path => (await adminDb.ref(path).get()).val();
const call = (fn, user, data = {}) => fn.run({auth: user ? {uid: user.uid} : undefined, data});
const correct = q => seed.questionAnswers[q.id][q.version].correctOptionId;
let questions;

async function fresh(baseline = {}) {
  await adminDb.ref().set(seed);
  const users = [];
  for (let i = 0; i < 2; i++) {
    const user = await adminAuth.createUser({email: `effects-${randomUUID()}@example.test`, displayName: `Player ${i}`});
    const u = {uid: user.uid, sid: randomUUID()};
    await call(ensureUserProfile, u);
    users.push(u);
  }
  await adminDb.ref(`userStats/${users[0].uid}`).update(baseline);
  questions = await selectQuestions('BATTLE', null);
  return users;
}

// Frozen engine output; engine timing, matching and authorization are tested
// separately in battle.test.mjs. Fixtures never reach the real database.
async function frozen(users, outcome = 'win') {
  const id = `battle_${randomUUID()}`;
  const at = Date.now();
  const outcomes = [outcome, outcome === 'draw' ? 'draw' : outcome === 'win' ? 'loss' : 'win'];
  const scores = outcomes.map(o => o === 'win' ? 7 : 5);
  const players = Object.fromEntries(users.map((u, i) => [u.uid, {
    name: `Player ${i}`, clientSessionId: u.sid, lastSeenAt: at,
    joinedAt: at - 1000,
    answers: Object.fromEntries(questions.map((q, ordinal) => [ordinal, {
      questionId: q.id,
      selectedOptionId: ordinal < scores[i] ? correct(q) : q.options.find(o => o.id !== correct(q)).id,
      isCorrect: ordinal < scores[i], timedOut: false, requestId: randomUUID(), receivedAt: at,
    }])),
  }]));
  const match = {id, kind: 'quick', status: 'completed', currentIndex: 9,
    createdAt: at - 1000, openedAt: at - 1000, deadlineAt: at,
    readyDeadlineAt: at - 1000, players, questions,
    keys: Object.fromEntries(questions.map(q => [q.id, seed.questionAnswers[q.id][q.version]])),
    finish: {reason: 'answers', at,
      outcomes: Object.fromEntries(users.map((u, i) => [u.uid, outcomes[i]])),
      correct: Object.fromEntries(users.map((u, i) => [u.uid, scores[i]])),
      answered: Object.fromEntries(users.map(u => [u.uid, 10]))}};
  await adminDb.ref(`battleRooms/${id}`).set(match);
  return id;
}

async function dashboard(user) {
  const response = await call(getUserDashboard, user);
  assert.ok(validateDashboard(response), JSON.stringify(validateDashboard.errors));
  return response.dashboard;
}

try {
  const ns = new URL(adminDb.app.options.databaseURL).hostname.split('.')[0];
  const rules = await fetch(`http://127.0.0.1:9100/.settings/rules.json?ns=${ns}`, {
    method: 'PUT', headers: {Authorization: 'Bearer owner', 'Content-Type': 'application/json'},
    body: readFileSync(new URL('../../../../database.rules.json', import.meta.url), 'utf8'),
  });
  assert.equal(rules.status, 200);

  const milestones = [
    ['first_win', {wins: 0, matchesPlayed: 0}, 'win', 1],
    ['three_win_streak', {wins: 2, matchesPlayed: 2, winStreak: 2, bestWinStreak: 2}, 'win', 3],
    ['ten_wins', {wins: 9, matchesPlayed: 9}, 'win', 10],
    ['twenty_battles', {wins: 4, losses: 15, matchesPlayed: 19}, 'draw', 20],
    ['fifty_wins', {wins: 49, matchesPlayed: 49}, 'win', 50],
  ];
  for (const [badge, baseline, outcome, target] of milestones) {
    await test(`Battle achievement ${badge} unlocks at ${target} with no extra reward`, async () => {
      const users = await fresh(baseline);
      const id = await frozen(users, outcome);
      await settleBattle(id);
      const uid = users[0].uid;
      const earned = await read(`userAchievements/${uid}/${badge}`);
      assert.ok(earned.unlockedAt > 0);
      assert.equal(earned.progress, target);
      const d = await dashboard(users[0]);
      const item = d.achievements.find(a => a.id === badge);
      assert.equal(item.unlocked, true);
      assert.equal(item.threshold, target);
      assert.equal(item.progress, target);
      assert.equal(d.coins, outcome === 'win' ? 5 : 0);
      assert.equal(d.wins, (baseline.wins || 0) + (outcome === 'win' ? 1 : 0));
      const notifications = (await read(`notifications/${uid}`)) || {};
      assert.equal(Object.values(notifications).filter(n => n.sourceId === badge).length, 1);
      assert.equal(await read(`battleRooms/${id}/battleEffectsVersion`), 1);
      await Promise.all(Array.from({length: 5}, () => settleBattle(id)));
      assert.deepEqual(await read(`userAchievements/${uid}/${badge}`), earned);
      assert.deepEqual(await read(`notifications/${uid}`), notifications);
    });
  }

  await test('Battle badges stay locked below threshold and expose their actual progress', async () => {
    const users = await fresh({wins: 8, matchesPlayed: 8, winStreak: 1, bestWinStreak: 1});
    await settleBattle(await frozen(users));
    const d = await dashboard(users[0]);
    const ten = d.achievements.find(a => a.id === 'ten_wins');
    assert.equal(ten.unlocked, false);
    assert.equal(ten.progress, 9);
    assert.equal(ten.threshold, 10);
    assert.equal(d.achievements.find(a => a.id === 'three_win_streak').unlocked, false);
    assert.equal(d.streak, 2);
    assert.equal(d.coins, 5);
  });

  await test('Wins build a streak; draw, loss and left reset it without revoking earned badges', async () => {
    const users = await fresh();
    for (const outcome of ['win', 'win', 'win', 'draw', 'win', 'loss', 'left']) {
      await settleBattle(await frozen(users, outcome));
    }
    const d = await dashboard(users[0]);
    assert.equal(d.wins, 4); assert.equal(d.losses, 2); assert.equal(d.draws, 1);
    assert.equal(d.streak, 0); assert.equal(d.coins, 20); assert.equal(d.rating, 16);
    assert.equal(d.achievements.find(a => a.id === 'three_win_streak').unlocked, true);
    assert.equal(await read(`userStats/${users[0].uid}/bestWinStreak`), 3);
    assert.equal(await read(`userStats/${users[0].uid}/matchesPlayed`), 7);
    assert.equal(d.notifications.filter(n => n.destination === 'Achievements').length, 2);
  });

  await test('Concurrent settlement retries publish one grant, one win and one first-win notification', async () => {
    const users = await fresh();
    const id = await frozen(users);
    await Promise.all(Array.from({length: 8}, () => settleBattle(id)));
    const d = await dashboard(users[0]);
    assert.equal(d.rating, 5); assert.equal(d.coins, 5); assert.equal(d.wins, 1);
    assert.equal(d.notifications.length, 1);
    assert.equal(Object.keys(await read(`userSettlements/${users[0].uid}/grants`)).length, 1);
  });

  await test('Independent backends project the same frozen achievements and grants exactly once', async () => {
    const users = await fresh();
    const id = await frozen(users);
    const actors = await Promise.all([startBackend(), startBackend()]);
    try {
      await Promise.all(actors.map(actor => actor.call('getAttemptResult', users[0], {attemptId: id})));
      const d = await dashboard(users[0]);
      assert.equal(d.wins, 1); assert.equal(d.rating, 5); assert.equal(d.coins, 5);
      assert.equal(d.notifications.length, 1);
      assert.equal(await read(`userStats/${users[1].uid}/losses`), 1);
    } finally { await Promise.all(actors.map(actor => actor.close())); }
  });

  for (const stage of ['userAchievements', 'notifications']) {
    await test(`Battle recovery after failed ${stage} uses the original durable unlock`, async () => {
      const users = await fresh();
      const id = await frozen(users);
      const original = adminDb.ref;
      let injected = false;
      adminDb.ref = function(path) {
        const ref = original.call(this, path);
        if (path?.startsWith(`${stage}/${users[0].uid}/`)) {
          const transaction = ref.transaction.bind(ref);
          ref.transaction = async (...args) => {
            if (!injected) { injected = true; throw new Error(`injected-${stage}`); }
            return transaction(...args);
          };
        }
        return ref;
      };
      try { await assert.rejects(settleBattle(id), new RegExp(`injected-${stage}`)); }
      finally { adminDb.ref = original; }
      assert.ok(injected);
      const earned = await read(`userSettlements/${users[0].uid}/battleAchievements/first_win`);
      assert.ok(earned.unlockedAt > 0);
      assert.ok(await read(`battleWork/${id}`));
      await runBattleMaintenance();
      assert.equal(await read(`battleRooms/${id}/battleEffectsVersion`), 1);
      assert.equal(await read(`battleWork/${id}`), null);
      assert.equal(await read(`userAchievements/${users[0].uid}/first_win/unlockedAt`), earned.unlockedAt);
      const d = await dashboard(users[0]);
      assert.equal(d.notifications.length, 1); assert.equal(d.coins, 5); assert.equal(d.wins, 1);
    });
  }

  await test('A delayed older stats projection cannot overwrite a later rating, counters or streak', async () => {
    const users = await fresh();
    const [oldId, newId] = [await frozen(users, 'win'), await frozen(users, 'loss')];
    const original = adminDb.ref;
    let release, arrived, intercepted = false;
    const pause = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { arrived = resolve; });
    adminDb.ref = function(path) {
      const ref = original.call(this, path);
      if (path === `userStats/${users[0].uid}`) {
        const transaction = ref.transaction.bind(ref);
        ref.transaction = async (...args) => {
          if (!intercepted) { intercepted = true; arrived(); await pause; }
          return transaction(...args);
        };
      }
      return ref;
    };
    const older = settleBattle(oldId);
    try { await reached; await settleBattle(newId); }
    finally { release(); try { await older; } finally { adminDb.ref = original; } }
    const d = await dashboard(users[0]);
    assert.equal(d.rating, 3); assert.equal(d.wins, 1); assert.equal(d.losses, 1);
    assert.equal(d.streak, 0); assert.equal(d.coins, 5);
    assert.equal(await read(`userStats/${users[0].uid}/matchesPlayed`), 2);
  });

  await test('Missing userStats are reconstructed from canonical totals on the next settlement', async () => {
    const users = await fresh();
    await settleBattle(await frozen(users));
    await adminDb.ref(`userStats/${users[0].uid}`).remove();
    await settleBattle(await frozen(users));
    const d = await dashboard(users[0]);
    assert.equal(d.wins, 2); assert.equal(d.rating, 10); assert.equal(d.coins, 10); assert.equal(d.streak, 2);
    assert.equal(d.notifications.length, 1);
  });

  await test('Step-four settled matches gain missing effects without re-awarding coins or ratings', async () => {
    const users = await fresh();
    const id = await frozen(users);
    await settleBattle(id);
    await adminDb.ref().update({
      [`battleRooms/${id}/battleEffectsVersion`]: null,
      [`userSettlements/${users[0].uid}/battleAchievements`]: null,
      [`userAchievements/${users[0].uid}`]: null, [`notifications/${users[0].uid}`]: null,
    });
    await settleBattle(id);
    const d = await dashboard(users[0]);
    assert.equal(d.coins, 5); assert.equal(d.rating, 5); assert.equal(d.wins, 1);
    assert.equal(d.notifications.length, 1);
    assert.equal(d.achievements.find(a => a.id === 'first_win').unlocked, true);
  });

  await test('Only valid published battle definitions unlock; achievement rewardCoins cannot grant extra coins', async () => {
    const users = await fresh();
    await adminDb.ref('achievements').update({
      first_win: {...seed.achievements.first_win, rewardCoins: 9999},
      hidden: {...seed.achievements.first_win, status: 'archived'},
      invalid: {...seed.achievements.first_win, threshold: -1},
      zero: {...seed.achievements.first_win, threshold: 0},
      string: {...seed.achievements.first_win, threshold: '1'},
      unknown: {...seed.achievements.first_win, conditionType: 'client_wins'},
    });
    await settleBattle(await frozen(users));
    for (const id of ['hidden', 'invalid', 'zero', 'string', 'unknown']) {
      assert.equal(await read(`userAchievements/${users[0].uid}/${id}`), null);
    }
    const d = await dashboard(users[0]);
    assert.equal(d.coins, 5); assert.equal(d.notifications.length, 1);
  });

  await test('Reading notifications is UID-scoped, idempotent and preserved by settlement recovery', async () => {
    const users = await fresh();
    const id = await frozen(users);
    await settleBattle(id);
    const notifications = await read(`notifications/${users[0].uid}`);
    const key = Object.keys(notifications)[0];
    await call(markNotificationsRead, users[1], {ids: [key]});
    assert.equal((await dashboard(users[0])).notifications[0].read, false);
    assert.equal(await read(`notifications/${users[1].uid}/${key}`), null);
    await call(markNotificationsRead, users[0], {ids: [key, key, 'missing']});
    const readAt = await read(`notifications/${users[0].uid}/${key}/readAt`);
    assert.ok(readAt > 0);
    await call(markNotificationsRead, users[0], {ids: [key]});
    await adminDb.ref(`battleRooms/${id}/battleEffectsVersion`).remove();
    await settleBattle(id);
    assert.equal(await read(`notifications/${users[0].uid}/${key}/readAt`), readAt);
    assert.equal((await dashboard(users[0])).notifications[0].read, true);
  });

  await test('Notification read validates the complete request and enforces live account access', async () => {
    const users = await fresh();
    await assert.rejects(call(markNotificationsRead, null, {ids: []}), {code: 'unauthenticated'});
    for (const data of [{}, {ids: 'x'}, {ids: [null]}, {ids: ['../other']},
      {ids: Array(51).fill('x')}, {ids: [], uid: users[1].uid}]) {
      await assert.rejects(call(markNotificationsRead, users[0], data), {code: 'invalid-argument'});
    }
    await call(markNotificationsRead, users[0], {ids: []});
    await adminDb.ref(`accountAccess/${users[0].uid}/status`).set('banned');
    await assert.rejects(call(markNotificationsRead, users[0], {ids: []}), {code: 'permission-denied'});
    await adminAuth.updateUser(users[1].uid, {disabled: true});
    await assert.rejects(call(markNotificationsRead, users[1], {ids: []}), {code: 'permission-denied'});
  });

  await test('Opening dashboard backfills achievements from step-four grants without a new match', async () => {
    const users = await fresh();
    const id = await frozen(users);
    await settleBattle(id);
    const uid = users[0].uid;
    await adminDb.ref().update({
      [`userSettlements/${uid}/battleAchievements`]: null,
      [`userSettlements/${uid}/battleAchievementRevision`]: null,
      [`userSettlements/${uid}/battleAchievementPublishedRevision`]: null,
      [`userAchievements/${uid}`]: null, [`notifications/${uid}`]: null,
    });
    const d = await dashboard(users[0]);
    assert.equal(d.achievements.find(a => a.id === 'first_win').unlocked, true);
    assert.equal(d.notifications.length, 1);
    assert.equal(d.coins, 5); assert.equal(d.rating, 5); assert.equal(d.wins, 1);
    assert.equal(await read(`battleWork/${id}/refreshEffects`), true);
    await runBattleMaintenance();
    assert.equal(await read(`battleWork/${id}`), null);
    assert.equal((await dashboard(users[0])).coins, 5);
  });

  await test('A newly published badge and failed dashboard notification are recovered by a forced battle job', async () => {
    const users = await fresh();
    await adminDb.ref('achievements/first_win/status').set('archived');
    const id = await frozen(users);
    await settleBattle(id);
    await adminDb.ref('achievements/first_win/status').set('published');
    const original = adminDb.ref;
    let injected = false;
    adminDb.ref = function(path) {
      const ref = original.call(this, path);
      if (path?.startsWith(`notifications/${users[0].uid}/`)) {
        const transaction = ref.transaction.bind(ref);
        ref.transaction = async (...args) => {
          if (!injected) { injected = true; throw new Error('injected-dashboard-notification'); }
          return transaction(...args);
        };
      }
      return ref;
    };
    try { await assert.rejects(call(getUserDashboard, users[0]), {code: 'internal'}); }
    finally { adminDb.ref = original; }
    assert.ok(injected);
    assert.equal(await read(`battleWork/${id}/refreshEffects`), true);
    await runBattleMaintenance();
    const d = await dashboard(users[0]);
    assert.equal(d.coins, 5); assert.equal(d.rating, 5); assert.equal(d.notifications.length, 1);
    assert.equal(d.achievements.find(a => a.id === 'first_win').unlocked, true);
    assert.equal(await read(`battleWork/${id}`), null);
  });

  for (const replacement of [false, true]) {
    await test(`Settlement preserves a concurrent refresh job across ${replacement ? 'a new generation' : 'a new revision'}`, async () => {
      const users = await fresh();
      const id = await frozen(users);
      const original = adminDb.ref;
      let release, arrived, intercepted = false;
      const pause = new Promise(resolve => { release = resolve; });
      const reached = new Promise(resolve => { arrived = resolve; });
      adminDb.ref = function(path) {
        const ref = original.call(this, path);
        if (path == null) {
          const update = ref.update.bind(ref);
          ref.update = async updates => {
            if (updates[`battleResults/${id}`] && !intercepted) {
              intercepted = true; arrived(); await pause;
            }
            return update(updates);
          };
        }
        return ref;
      };
      const settling = settleBattle(id);
      let wake;
      try {
        await reached;
        if (replacement) await adminDb.ref(`battleWork/${id}`).remove();
        wake = await enqueueBattleWork(id, undefined, false, true);
      } finally { release(); try { await settling; } finally { adminDb.ref = original; } }
      const pending = await read(`battleWork/${id}`);
      assert.equal(pending.generation, wake.generation);
      assert.equal(pending.revision, wake.revision);
      assert.equal(pending.refreshEffects, true);
      await runBattleMaintenance();
      assert.equal(await read(`battleWork/${id}`), null);
      assert.equal((await dashboard(users[0])).coins, 5);
    });
  }

  await test('An earned badge survives archive and rule changes while its interrupted notification is recovered', async () => {
    const users = await fresh();
    const id = await frozen(users);
    const original = adminDb.ref;
    let injected = false;
    adminDb.ref = function(path) {
      const ref = original.call(this, path);
      if (path?.startsWith(`notifications/${users[0].uid}/`)) {
        const transaction = ref.transaction.bind(ref);
        ref.transaction = async (...args) => {
          if (!injected) { injected = true; throw new Error('injected-before-archive'); }
          return transaction(...args);
        };
      }
      return ref;
    };
    try { await assert.rejects(settleBattle(id), /injected-before-archive/); }
    finally { adminDb.ref = original; }
    const earnedAt = await read(`userSettlements/${users[0].uid}/battleAchievements/first_win/unlockedAt`);
    await adminDb.ref('achievements/first_win/status').set('archived');
    await runBattleMaintenance();
    assert.equal((await dashboard(users[0])).achievements.some(a => a.id === 'first_win'), false);
    await adminDb.ref('achievements/first_win').update({status: 'published', ruleVersion: 'v2', threshold: 99, title: 'Changed title'});
    const d = await dashboard(users[0]);
    assert.equal(d.achievements.find(a => a.id === 'first_win').unlocked, true);
    const badge = await read(`userAchievements/${users[0].uid}/first_win`);
    assert.equal(badge.unlockedAt, earnedAt);
    assert.equal(badge.ruleVersion, 'v1');
    assert.equal(d.notifications.length, 1);
    assert.ok(d.notifications[0].body.includes(seed.achievements.first_win.title));
    assert.equal(d.coins, 5);
  });
  await test('Changing a locked achievement metric resets progress to its current authoritative counter', async () => {
    const users = await fresh({losses: 9, matchesPlayed: 9});
    await adminDb.ref('achievements/flexible').set({
      ...seed.achievements.twenty_battles, title: 'Flexible badge', threshold: 100,
    });
    await settleBattle(await frozen(users, 'loss'));
    assert.equal((await dashboard(users[0])).achievements.find(a => a.id === 'flexible').progress, 10);
    await adminDb.ref('achievements/flexible').update({
      conditionType: 'battle_wins', threshold: 3, ruleVersion: 'v2',
    });
    const item = (await dashboard(users[0])).achievements.find(a => a.id === 'flexible');
    assert.equal(item.progress, 0);
    assert.equal(item.threshold, 3);
    assert.equal(item.unlocked, false);
    assert.equal(await read(`userSettlements/${users[0].uid}/battleAchievements/flexible/progress`), 0);
  });

  await test('A delayed locked achievement projection cannot restore the progress or rule from an older metric', async () => {
    const users = await fresh({losses: 9, matchesPlayed: 9});
    await adminDb.ref('achievements/flexible').set({
      ...seed.achievements.twenty_battles, title: 'Flexible badge', threshold: 100,
    });
    await settleBattle(await frozen(users, 'loss'));
    const old = await read(`userSettlements/${users[0].uid}`);
    await adminDb.ref('achievements/flexible').update({
      conditionType: 'battle_wins', threshold: 3, ruleVersion: 'v2',
    });
    await dashboard(users[0]);
    await projectBattleAchievements(users[0].uid, old);
    const projected = await read(`userAchievements/${users[0].uid}/flexible`);
    assert.equal(projected.progress, 0);
    assert.equal(projected.ruleVersion, 'v2');
    const item = (await dashboard(users[0])).achievements.find(a => a.id === 'flexible');
    assert.equal(item.progress, 0);
    assert.equal(item.unlocked, false);
  });

  await test('Dashboard repairs previously inflated locked progress even when the stored metric already matches', async () => {
    const users = await fresh({losses: 9, matchesPlayed: 9});
    await adminDb.ref('achievements/flexible').set({
      ...seed.achievements.ten_wins, title: 'Flexible badge', threshold: 3,
    });
    await settleBattle(await frozen(users, 'loss'));
    const uid = users[0].uid;
    await adminDb.ref().update({
      [`userSettlements/${uid}/battleAchievements/flexible/progress`]: 10,
      [`userAchievements/${uid}/flexible/progress`]: 10,
    });
    const item = (await dashboard(users[0])).achievements.find(a => a.id === 'flexible');
    assert.equal(item.progress, 0);
    assert.equal(item.unlocked, false);
    assert.equal(await read(`userSettlements/${uid}/battleAchievements/flexible/progress`), 0);
    assert.equal(await read(`userAchievements/${uid}/flexible/progress`), 0);
    const d = await dashboard(users[0]);
    assert.equal(d.coins, 0); assert.equal(d.wins, 0); assert.equal(d.notifications.length, 0);
  });

  await test('Two independent backends marking notifications read concurrently with recovery preserve readAt and rewards', async () => {
    const users = await fresh({wins: 2, matchesPlayed: 2, winStreak: 2, bestWinStreak: 2});
    const id = await frozen(users);
    await settleBattle(id);
    const ids = Object.keys(await read(`notifications/${users[0].uid}`));
    assert.equal(ids.length, 2);
    const actors = await Promise.all([startBackend(), startBackend()]);
    try {
      await Promise.all([
        ...actors.map(actor => actor.call('markNotificationsRead', users[0], {ids})),
        settleBattle(id, true),
      ]);
      const timestamps = Object.fromEntries(Object.entries(await read(`notifications/${users[0].uid}`)).map(([key, n]) => [key, n.readAt]));
      assert.ok(Object.values(timestamps).every(at => at > 0));
      await Promise.all([
        ...actors.map(actor => actor.call('markNotificationsRead', users[0], {ids})),
        settleBattle(id, true),
      ]);
      const after = await read(`notifications/${users[0].uid}`);
      assert.deepEqual(Object.fromEntries(Object.entries(after).map(([key, n]) => [key, n.readAt])), timestamps);
      const d = await dashboard(users[0]);
      assert.equal(d.coins, 5); assert.equal(d.rating, 5); assert.equal(d.wins, 3);
      assert.ok(d.notifications.every(n => n.read));
      assert.equal(Object.keys(after).length, 2);
    } finally { await Promise.all(actors.map(actor => actor.close())); }
  });
} finally { await deleteApp(adminDb.app); }
