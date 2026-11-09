import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test as nodeTest} from 'node:test';
import {mobileContract} from '../../../../frontend/contracts/mobile.v1.mjs';
import {startBackend} from './helpers/backendClient.mjs';

assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9199');
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:9100');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-finalization');
const require = createRequire(new URL('../../../functions/package.json', import.meta.url));
const {adminAuth, adminDb} = require('./lib/config/firebaseAdmin.js');
const {deleteApp} = require('firebase-admin/app');
const Ajv = require('ajv');
const ajv = new Ajv({strict: false});
const test = (title, run) => nodeTest(title, {timeout: 30000}, run);
const {findBattle, getBattleTicket, cancelBattleSearch} = require('./lib/be1/battle/battleCallables.js');
const {battleNow, syncBattleClock} = require('./lib/be1/battle/battleClock.js');
const {settleBattle} = require('./lib/be1/battle/battleSettlement.js');
const {runBattleMaintenance, drainBattleWork} = require('./lib/be1/battle/battleMaintenance.js');
const {flushBattleCoordinator} = require('./lib/be1/battle/matchmaking.js');
const {ensureUserProfile} = require('./lib/be1/auth/ensureUserProfile.js');
const {getUserDashboard} = require('./lib/be1/user/getUserDashboard.js');
const {resumeAttempt} = require('./lib/be1/practice/resumeAttempt.js');
const {submitAttemptAnswer} = require('./lib/be1/practice/submitAttemptAnswer.js');
const {saveAttemptSelection} = require('./lib/be1/practice/saveAttemptSelection.js');
const {advanceAttempt} = require('./lib/be1/practice/advanceAttempt.js');
const {leaveAttempt} = require('./lib/be1/practice/leaveAttempt.js');
const {getAttemptResult} = require('./lib/be1/practice/getAttemptResult.js');
const {startAttempt} = require('./lib/be1/practice/startAttempt.js');
const {finalizeAttemptLogic} = require('./lib/be1/practice/finalizeAttempt.js');
assert.match(adminDb.ref().toString(), /^http:\/\/127\.0\.0\.1:9100\//);
const seed = JSON.parse(readFileSync(new URL('../../../database/english-battle.seed.json', import.meta.url), 'utf8'));
const read = async path => (await adminDb.ref(path).get()).val();
const call = (fn, user, data = {}) => fn.run({auth: user ? {uid: user.uid} : undefined,
  data: {...data, ...(user ? {clientSessionId: user.sid} : {})}});
const find = (user, requestId = randomUUID()) => call(findBattle, user, {kind: 'quick', requestId});
const resume = (user, id) => call(resumeAttempt, user, {attemptId: id});
const correct = q => seed.questionAnswers[q.id][q.version].correctOptionId;
const option = (q, right) => right ? correct(q) : q.options.find(o => o.id !== correct(q)).id;
const submit = (user, id, q, right = true, requestId = randomUUID()) =>
  call(submitAttemptAnswer, user, {attemptId: id, questionId: q.id, optionId: option(q, right), requestId});
const leave = (user, id) => call(leaveAttempt, user, {attemptId: id, requestId: randomUUID()});
const clockAt = async (time, run) => {
  await syncBattleClock();
  const clock = Date.now; Date.now = () => time;
  const offset = battleNow() - time;
  Date.now = () => time - offset;
  try { return await run(); } finally { Date.now = clock; }
};

async function fresh(count = 2) {
  await adminDb.ref().set(seed);
  const users = [];
  for (let i = 0; i < count; i++) {
    const user = await adminAuth.createUser({email: `battle-${randomUUID()}@example.test`, displayName: `Player ${i + 1}`});
    const u = {uid: user.uid, sid: randomUUID()};
    await call(ensureUserProfile, u);
    users.push(u);
  }
  return users;
}
async function pair(users, join = true) {
  const [a, b] = users;
  const first = (await find(a)).ticket;
  assert.equal(first.status, 'searching');
  const second = (await find(b)).ticket;
  assert.equal(second.status, 'matched');
  const id = second.attemptId;
  assert.ok(id.startsWith('battle_'));
  const found = (await call(getBattleTicket, a, {ticketId: first.id})).ticket;
  assert.equal(found.attemptId, id);
  if (join) { await resume(a, id); await resume(b, id); }
  return {id, tickets: [found, second], attempt: (await resumeIfJoined(a, id, join))};
}
async function resumeIfJoined(user, id, join) {
  return join ? (await resume(user, id)).attempt : null;
}
async function assertFinal(users, id, expected) {
  const final = await read(`battleRooms/${id}`);
  assert.equal(final.status, 'completed');
  assert.equal(final.settlementVersion, 1);
  for (let i = 0; i < 2; i++) {
    const user = users[i];
    const response = await call(getAttemptResult, user, {attemptId: id});
    const validate = ajv.compile(mobileContract.methods.getAttemptResult.response);
    assert.ok(validate(response), JSON.stringify(validate.errors));
    assert.equal(response.result.outcome, expected[i]);
    assert.equal(response.result.reviews.length, 10);
    const cached = await read(`battleReviews/${id}/${user.uid}`);
    assert.deepEqual(response.result, {...cached, reviews: cached.reviews.map(r => ({...r, pickedId: r.pickedId ?? null}))});
    const grant = await read(`userSettlements/${user.uid}/grants/grant_${id}`);
    assert.equal(grant.outcome, expected[i]);
    assert.equal(grant.coinDelta, expected[i] === 'win' ? 5 : 0);
    assert.equal(await read(`userStats/${user.uid}/matchesPlayed`), 1);
    assert.equal(await read(`battleCoordinator/users/${user.uid}`), null);
  }
}

// Settlement fixtures bypass only the game engine, which full-round tests cover.
// They are written exclusively to the isolated database asserted above.
async function freezeFixture(users, id, outcomes = ['win', 'loss']) {
  const match = await read(`battleRooms/${id}`);
  for (let p = 0; p < 2; p++) match.players[users[p].uid].answers = Object.fromEntries(
    match.questions.map((q, index) => [index, {questionId: q.id,
      selectedOptionId: option(q, index < (p === 0 ? 7 : 5)),
      isCorrect: index < (p === 0 ? 7 : 5), timedOut: false,
      requestId: randomUUID(), receivedAt: Date.now()}]));
  match.status = 'completed'; match.currentIndex = 9;
  match.finish = {reason: 'answers', at: Date.now(),
    outcomes: {[users[0].uid]: outcomes[0], [users[1].uid]: outcomes[1]},
    correct: {[users[0].uid]: 7, [users[1].uid]: 5},
    answered: {[users[0].uid]: 10, [users[1].uid]: 10}};
  await adminDb.ref(`battleRooms/${id}`).set(match);
  return match;
}

try {
  const ns = new URL(adminDb.app.options.databaseURL).hostname.split('.')[0];
  const rules = await fetch(`http://127.0.0.1:9100/.settings/rules.json?ns=${ns}`, {
    method: 'PUT', headers: {Authorization: 'Bearer owner', 'Content-Type': 'application/json'},
    body: readFileSync(new URL('../../../../database.rules.json', import.meta.url), 'utf8'),
  });
  assert.equal(rules.status, 200);

  await test('Quick battle: two different UIDs share ten questions and start only after both enter', async () => {
    const users = await fresh();
    const {id} = await pair(users, false);
    const first = (await resume(users[0], id)).attempt;
    assert.equal(first.status, 'waiting');
    await resume(users[1], id);
    const a = (await resume(users[0], id)).attempt;
    const b = (await resume(users[1], id)).attempt;
    assert.equal(a.status, 'active');
    assert.equal(a.questions.length, 10);
    assert.equal(new Set(a.questions.map(q => q.id)).size, 10);
    assert.deepEqual(a.questions, b.questions);
    assert.equal(a.deadlineAt, b.deadlineAt);
    assert.equal(a.result, null);
    assert.equal('keys' in a, false);
    for (const q of a.questions) {
      assert.equal('correctOptionId' in q, false);
      assert.equal('explanation' in q, false);
    }
    assert.ok(ajv.compile(mobileContract.methods.resumeAttempt.response)({serverNow: Date.now(), attempt: a}));
  });

  await test('Quick battle: concurrent requests from one UID cannot create two tickets or match itself', async () => {
    const users = await fresh();
    const replies = await Promise.all([find(users[0]), find(users[0]), find(users[0])]);
    assert.equal(new Set(replies.map(r => r.ticket.id)).size, 1);
    assert.ok(replies.every(r => r.ticket.status === 'searching'));
    const opponent = (await find(users[1])).ticket;
    const match = await read(`battleRooms/${opponent.attemptId}`);
    assert.deepEqual(Object.keys(match.players).sort(), users.map(u => u.uid).sort());
    const retry = (await find(users[0])).ticket;
    assert.equal(retry.attemptId, opponent.attemptId);
    assert.equal(Object.keys(await read('battleRooms')).length, 1);
  });

  await test('Local hosts with clocks 40 seconds apart can enter and play past round one', async () => {
    const [a, b] = await fresh();
    const fast = await startBackend({clockSkewMs: 20000});
    const slow = await startBackend({clockSkewMs: -20000});
    try {
      const search = (host, user) => host.call('findBattle', user, {kind: 'quick', requestId: randomUUID()});
      const first = (await search(fast, a)).ticket;
      const second = (await search(slow, b)).ticket;
      assert.equal(first.status, 'searching');
      assert.equal(second.status, 'matched');
      const id = second.attemptId;
      const roomPath = `battleRooms/${id}`;

      await fast.call('maintenance');
      const notification = await fast.call('getBattleTicket', a, {ticketId: first.id});
      assert.equal(notification.ticket.attemptId, id);
      assert.equal((await read(roomPath)).status, 'ready');
      const enter = (host, user) => host.call('resumeAttempt', user, {attemptId: id});
      assert.equal((await enter(slow, b)).attempt.status, 'waiting');
      const start = await enter(fast, a);
      assert.equal(start.attempt.status, 'active');
      assert.ok(start.attempt.deadlineAt - start.serverNow > 25000);
      const room = await read(roomPath);
      assert.ok(room.players[b.uid].joinedAt >= room.createdAt);
      assert.ok(Math.abs(room.players[a.uid].lastSeenAt - room.players[b.uid].lastSeenAt) < 5000);

      const answer = (host, user, question) => host.call('submitAttemptAnswer', user, {
        attemptId: id, questionId: question.id, optionId: option(question, true), requestId: randomUUID(),
      });
      for (let i = 0; i < 2; i++) {
        const question = start.attempt.questions[i];
        assert.equal((await answer(slow, b, question)).attempt.status, 'waiting');
        const {attempt} = await answer(fast, a, question);
        assert.equal(attempt.index, i + 1);
        assert.equal(attempt.result, null);
        await fast.call('maintenance');
        assert.equal((await enter(slow, b)).attempt.index, i + 1);
      }
      assert.equal((await read(roomPath)).status, 'active');
    } finally {
      await Promise.all([fast.close(), slow.close()]);
    }
  });

  await test('Searching ticket cancellation and expiry remain stable on old request retries', async () => {
    const [a] = await fresh();
    const requestId = randomUUID();
    const ticket = (await find(a, requestId)).ticket;
    await call(cancelBattleSearch, a, {ticketId: ticket.id});
    assert.equal((await find(a, requestId)).ticket.status, 'cancelled');
    const nextRequest = randomUUID();
    const next = (await find(a, nextRequest)).ticket;
    const stored = await read(`battleCoordinator/tickets/${next.id}`);
    await clockAt(stored.expiresAt, async () => {
      const expired = (await call(getBattleTicket, a, {ticketId: next.id})).ticket;
      assert.equal(expired.status, 'expired');
      assert.equal((await find(a, nextRequest)).ticket.status, 'expired');
    });
    assert.equal(await read(`battleCoordinator/users/${a.uid}`), null);
  });

  await test('Only quick is implemented and inactive/foreign sessions cannot control tickets', async () => {
    const users = await fresh();
    for (const kind of ['daily', 'create', 'join']) await assert.rejects(
      call(findBattle, users[0], {kind, requestId: randomUUID(), roomCode: 'ABC123'}), {code: 'unimplemented'});
    assert.equal(await read('battleCoordinator'), null);
    await assert.rejects(call(findBattle, null, {kind: 'quick', requestId: randomUUID()}), {code: 'unauthenticated'});
    const ticket = (await find(users[0])).ticket;
    await assert.rejects(call(getBattleTicket, users[1], {ticketId: ticket.id}), {code: 'not-found'});
    await assert.rejects(call(getBattleTicket, {...users[0], sid: randomUUID()}, {ticketId: ticket.id}), {code: 'failed-precondition'});
    await adminAuth.updateUser(users[1].uid, {disabled: true});
    await assert.rejects(find(users[1]), {code: 'permission-denied'});
  });

  await test('Synchronized rounds: one answer cannot advance or reveal correctness', async () => {
    const users = await fresh();
    const {id, attempt} = await pair(users);
    const q = attempt.questions[0];
    const requestId = randomUUID();
    const answer = (await submit(users[0], id, q, true, requestId)).attempt;
    assert.equal(answer.index, 0);
    assert.equal(answer.status, 'waiting');
    assert.equal(answer.receipts[0].correct, null);
    const advanced = (await call(advanceAttempt, users[0], {attemptId: id, expectedIndex: 0, requestId: randomUUID()})).attempt;
    assert.equal(advanced.index, 0);
    assert.equal(advanced.deadlineAt, attempt.deadlineAt);
    await assert.rejects(submit(users[0], id, q, false, requestId), {code: 'invalid-argument'});
    const next = (await submit(users[1], id, q, false)).attempt;
    assert.equal(next.index, 1);
    assert.equal(next.status, 'active');
  });

  await test('Ten resolved rounds save immutable win/loss, reviews and actual rating delta at floor', async () => {
    const users = await fresh();
    await adminDb.ref(`userStats/${users[1].uid}/rating`).set(1);
    const {id, attempt} = await pair(users);
    for (const q of attempt.questions) {
      await submit(users[0], id, q, true);
      await submit(users[1], id, q, false);
    }
    await assertFinal(users, id, ['win', 'loss']);
    assert.equal(await read(`wallets/${users[0].uid}/coinBalance`), 5);
    assert.equal(await read(`userStats/${users[0].uid}/rating`), 5);
    assert.equal(await read(`userStats/${users[1].uid}/rating`), 0);
    assert.equal(await read(`ratingLedger/${users[1].uid}/${id}/ratingDelta`), -1);
    const frozen = (await read(`battleRooms/${id}`)).finish;
    await Promise.all(users.map(u => leave(u, id)));
    await resume(users[0], id);
    assert.deepEqual((await read(`battleRooms/${id}`)).finish, frozen);
    assert.equal(await read(`wallets/${users[0].uid}/coinBalance`), 5);
    const {dashboard} = await call(getUserDashboard, users[0]);
    assert.equal(dashboard.wins, 1);
    assert.equal(dashboard.history.find(h => h.attemptId === id).outcome, 'win');
    assert.ok(ajv.compile(mobileContract.methods.getUserDashboard.response)({serverNow: Date.now(), dashboard}));
  });

  await test('Two explicit leaves within three seconds draw without coins or rating changes', async () => {
    const users = await fresh();
    const {id} = await pair(users);
    const first = await leave(users[0], id);
    assert.equal(first.attempt.status, 'waiting');
    assert.equal(await read(`wallets/${users[1].uid}/coinBalance`), 0);
    const deadline = (await read(`battleRooms/${id}`)).leaveDeadlineAt;
    await clockAt(deadline - 1, () => leave(users[1], id));
    await assertFinal(users, id, ['draw', 'draw']);
  });

  await test('A single explicit leave loses after its fixed window and late leave cannot change it', async () => {
    const users = await fresh();
    const {id} = await pair(users);
    await leave(users[0], id);
    const deadline = (await read(`battleRooms/${id}`)).leaveDeadlineAt;
    await clockAt(deadline - 1, () => leave(users[0], id));
    assert.equal((await read(`battleRooms/${id}`)).leaveDeadlineAt, deadline);
    await clockAt(deadline, () => runBattleMaintenance());
    await assertFinal(users, id, ['left', 'win']);
    await leave(users[1], id);
    assert.equal((await read(`battleReviews/${id}/${users[0].uid}`)).outcome, 'left');
  });

  await test('Reconnect before grace keeps deadlines; late reconnect loses before heartbeat renewal', async () => {
    const users = await fresh();
    const {id, attempt} = await pair(users);
    const before = await read(`battleRooms/${id}`);
    const base = Math.max(...Object.values(before.players).map(p => p.lastSeenAt));
    await clockAt(base + 20000, () => resume(users[1], id));
    await clockAt(base + 29000, async () => {
      const response = await resume(users[0], id);
      assert.equal(response.attempt.status, 'active');
      assert.equal(response.attempt.deadlineAt, attempt.deadlineAt);
    });
    await clockAt(base + 49000, () => resume(users[1], id));
    await clockAt(base + 59000, () => resume(users[0], id));
    await assertFinal(users, id, ['loss', 'win']);
  });

  await test('Both disconnected past grace draw and cannot reopen a settled match', async () => {
    const users = await fresh();
    const {id} = await pair(users);
    const match = await read(`battleRooms/${id}`);
    const end = Math.max(...Object.values(match.players).map(p => p.lastSeenAt)) + 30000;
    await clockAt(end, () => runBattleMaintenance());
    await assertFinal(users, id, ['draw', 'draw']);
    const finish = (await read(`battleRooms/${id}`)).finish;
    await resume(users[0], id);
    assert.deepEqual((await read(`battleRooms/${id}`)).finish, finish);
  });

  await test('Four simultaneous different users form two disjoint matches', async () => {
    const users = await fresh(4);
    const replies = await Promise.all(users.map(u => find(u)));
    const tickets = await Promise.all(users.map((u, i) => call(getBattleTicket, u, {ticketId: replies[i].ticket.id})));
    const ids = tickets.map(r => r.ticket.attemptId);
    assert.equal(new Set(ids).size, 2);
    for (const id of new Set(ids)) assert.equal(ids.filter(value => value === id).length, 2);
    const rooms = Object.values(await read('battleRooms'));
    assert.equal(rooms.length, 2);
    assert.equal(new Set(rooms.flatMap(r => Object.keys(r.players))).size, 4);
  });

  await test('Cancel racing with matching follows the committed queue status', async () => {
    const users = await fresh();
    const first = (await find(users[0])).ticket;
    const [cancelled, found] = await Promise.all([
      call(cancelBattleSearch, users[0], {ticketId: first.id}), find(users[1]),
    ]);
    const ticket = (await call(getBattleTicket, users[0], {ticketId: first.id})).ticket;
    if (ticket.status === 'cancelled') {
      assert.equal(cancelled.attempt, undefined);
      assert.equal(found.ticket.status, 'searching');
      assert.equal(await read('battleRooms'), null);
    } else {
      assert.equal(ticket.status, 'matched');
      assert.ok(cancelled.attempt);
      const room = await read(`battleRooms/${ticket.attemptId}`);
      await clockAt(room.leaveDeadlineAt, () => runBattleMaintenance());
      await assertFinal(users, ticket.attemptId, ['left', 'win']);
    }
  });

  for (const joined of [false, true]) await test(`Ready timeout: ${joined ? 'only joined player wins' : 'neither entered means draw'}`, async () => {
    const users = await fresh();
    const {id} = await pair(users, false);
    const match = await read(`battleRooms/${id}`);
    if (joined) await resume(users[0], id);
    await clockAt(match.readyDeadlineAt - 1000, async () => call(getBattleTicket, users[0], {
      ticketId: (await read(`battleCoordinator/users/${users[0].uid}`)).ticketId}));
    await clockAt(match.readyDeadlineAt, () => runBattleMaintenance());
    await assertFinal(users, id, joined ? ['win', 'loss'] : ['draw', 'draw']);
  });

  for (const choice of ['correct', 'wrong', 'none']) await test(`Round timeout grades an unconfirmed ${choice} selection and keeps original boundaries`, async () => {
    const users = await fresh();
    const {id, attempt} = await pair(users);
    const q = attempt.questions[0];
    if (choice !== 'none') {
      const response = await call(saveAttemptSelection, users[0], {attemptId: id, questionId: q.id,
        optionId: option(q, choice === 'correct'), requestId: randomUUID()});
      assert.equal(response.accepted, true);
    }
    await adminDb.ref().update(Object.fromEntries(users.map(u =>
      [`battleRooms/${id}/players/${u.uid}/lastSeenAt`, attempt.deadlineAt - 1])));
    await clockAt(attempt.deadlineAt, async () => {
      const response = (await call(advanceAttempt, users[0], {attemptId: id,
        expectedIndex: 0, requestId: randomUUID()})).attempt;
      assert.equal(response.index, 1);
      assert.equal(response.deadlineAt, attempt.deadlineAt + 30000);
      assert.equal(response.receipts[0].optionId, choice === 'none' ? null : option(q, choice === 'correct'));
      assert.equal(response.receipts[0].correct, null);
      assert.ok(ajv.compile(mobileContract.methods.advanceAttempt.response)({serverNow: Date.now(), attempt: response}));
      const saved = await read(`battleRooms/${id}/players/${users[0].uid}/answers/0`);
      assert.equal(saved.isCorrect, choice === 'correct');
      const late = await call(saveAttemptSelection, users[0], {attemptId: id, questionId: q.id,
        optionId: option(q, false), requestId: randomUUID()});
      assert.equal(late.accepted, false);
    });
  });

  await test('Ten tied rounds draw regardless of which player answered faster', async () => {
    const users = await fresh();
    const {id, attempt} = await pair(users);
    for (let i = 0; i < 10; i++) {
      await submit(users[0], id, attempt.questions[i], i < 5);
      await submit(users[1], id, attempt.questions[i], i >= 5);
    }
    await assertFinal(users, id, ['draw', 'draw']);
    for (const u of users) {
      assert.equal(await read(`wallets/${u.uid}/coinBalance`), 0);
      assert.equal(await read(`userStats/${u.uid}/rating`), 0);
    }
  });

  await test('Foreign UIDs, wrong sessions and forged correctness cannot control a battle', async () => {
    const users = await fresh(3);
    const {id, attempt} = await pair(users);
    await assert.rejects(resume(users[2], id), {code: 'not-found'});
    await assert.rejects(resume({...users[0], sid: randomUUID()}, id), {code: 'failed-precondition'});
    await assert.rejects(call(submitAttemptAnswer, users[0], {attemptId: id,
      questionId: 'not_in_match', optionId: 'a', requestId: randomUUID()}), {code: 'failed-precondition'});
    const q = attempt.questions[0];
    await call(submitAttemptAnswer, users[0], {attemptId: id, questionId: q.id, optionId: option(q, false),
      requestId: randomUUID(), isCorrect: true, correctCount: 10, uid: users[1].uid, receivedAt: 0});
    assert.equal((await read(`battleRooms/${id}/players/${users[0].uid}/answers/0`)).isCorrect, false);
    assert.equal(await read(`battleRooms/${id}/players/${users[1].uid}/answers`), null);
  });

  for (const rating of [0, 1, 9]) await test(`Rating floor: loss from ${rating} persists its actual delta exactly once`, async () => {
    const users = await fresh();
    await adminDb.ref(`userStats/${users[1].uid}/rating`).set(rating);
    const {id} = await pair(users);
    await freezeFixture(users, id);
    await Promise.all([settleBattle(id), settleBattle(id)]);
    await assertFinal(users, id, ['win', 'loss']);
    const expected = Math.max(0, rating - 2);
    assert.equal(await read(`userStats/${users[1].uid}/rating`), expected);
    assert.equal(await read(`ratingLedger/${users[1].uid}/${id}/ratingDelta`), expected - rating);
    assert.equal(await read(`userStats/${users[0].uid}/wins`), 1);
  });

  for (const stage of ['grant', 'wallet', 'stats', 'ledger', 'skills', 'views', 'release']) await test(`Settlement recovery after interrupted ${stage} preserves both outcomes and grants once`, async () => {
    const users = await fresh();
    const {id} = await pair(users);
    const match = await freezeFixture(users, id);
    const uid = users[0].uid;
    const original = adminDb.ref;
    let injected = false;
    const target = {grant: [`userSettlements/${uid}`, 'transaction'], wallet: [`wallets/${uid}`, 'transaction'],
      stats: [`userStats/${uid}`, 'transaction'], skills: [`userSkillStats/${uid}/${match.questions[0].categoryId}`, 'transaction'],
      ledger: [undefined, 'update'], views: [undefined, 'update'], release: ['battleCoordinator', 'transaction']}[stage];
    adminDb.ref = function(refPath) {
      const ref = original.call(this, refPath);
      if (refPath === target[0]) {
        const run = ref[target[1]].bind(ref);
        ref[target[1]] = async (...args) => {
          const keys = stage === 'ledger' || stage === 'views' ? Object.keys(args[0]) : [];
          const selected = stage === 'ledger' ? keys.some(key => key.startsWith('ratingLedger/')) :
            stage === 'views' ? keys.some(key => key.startsWith('battleReviews/')) : true;
          if (!injected && selected) { injected = true; throw new Error(`injected-${stage}`); }
          return run(...args);
        };
      }
      return ref;
    };
    try { await assert.rejects(settleBattle(id), new RegExp(`injected-${stage}`)); }
    finally { adminDb.ref = original; }
    assert.ok(injected);
    assert.deepEqual((await read(`battleRooms/${id}`)).finish, match.finish);
    if (stage !== 'release') assert.ok(await read(`battleWork/${id}`));
    await runBattleMaintenance();
    // An existing future deadline may delay the retry after a direct call.
    await settleBattle(id);
    await assertFinal(users, id, ['win', 'loss']);
    assert.equal(await read(`wallets/${uid}/coinBalance`), 5);
    assert.equal(Object.keys(await read(`coinLedger/${uid}`)).length, 1);
  });

  await test('Allocation outbox recovers a crash after matching but before the room is created', async () => {
    const users = await fresh();
    const first = (await find(users[0])).ticket;
    const original = adminDb.ref;
    let injected = false;
    adminDb.ref = function(refPath) {
      const ref = original.call(this, refPath);
      if (refPath?.startsWith('battleRooms/')) {
        const transaction = ref.transaction.bind(ref);
        ref.transaction = async (...args) => {
          if (!injected) { injected = true; throw new Error('injected-allocation'); }
          return transaction(...args);
        };
      }
      return ref;
    };
    let second;
    try { second = (await find(users[1])).ticket; } finally { adminDb.ref = original; }
    assert.ok(injected);
    assert.equal(second.status, 'matched');
    assert.equal(await read(`battleRooms/${second.attemptId}`), null);
    assert.ok(await read(`battleCoordinator/allocations/${second.attemptId}`));
    await runBattleMaintenance();
    const restored = (await call(getBattleTicket, users[0], {ticketId: first.id})).ticket;
    assert.equal(restored.attemptId, second.attemptId);
    assert.ok(await read(`battleRooms/${second.attemptId}`));
    assert.equal(await read(`battleCoordinator/allocations/${second.attemptId}`), null);
  });

  await test('Account disabled during play forfeits once and terminal reviews work on a new device', async () => {
    const users = await fresh();
    const {id} = await pair(users);
    await adminAuth.updateUser(users[1].uid, {disabled: true});
    await resume(users[0], id);
    const winner = (await call(getAttemptResult, {...users[0], sid: randomUUID()}, {attemptId: id})).result;
    assert.equal(winner.outcome, 'win');
    assert.equal(await read(`wallets/${users[0].uid}/coinBalance`), 5);
    await assert.rejects(resume(users[1], id), {code: 'permission-denied'});
  });

  await test('Battle grants share the authoritative wallet with concurrent practice completion', async () => {
    const users = await fresh();
    const {id} = await pair(users);
    await freezeFixture(users, id);
    const {attempt} = await call(startAttempt, users[0], {mode: 'PRACTICE', topicId: 'vocabulary_daily_life', requestId: randomUUID()});
    const answers = Object.fromEntries(attempt.questions.map((q, ordinal) => [ordinal, {
      questionId: q.id, selectedOptionId: correct(q), isCorrect: true, timedOut: false,
      ordinal, requestId: randomUUID(), receivedAt: Date.now()}]));
    await adminDb.ref(`practiceAttempts/${users[0].uid}/${attempt.id}`).update({status: 'waiting',
      currentIndex: 9, answers, answerStateVersion: 1, correctCount: 10, answeredCount: 10, finishedAt: Date.now()});
    await adminDb.ref(`wallets/${users[0].uid}`).remove();
    await Promise.all([settleBattle(id), finalizeAttemptLogic(users[0].uid, attempt.id)]);
    await settleBattle(id);
    await finalizeAttemptLogic(users[0].uid, attempt.id);
    assert.equal(await read(`wallets/${users[0].uid}/coinBalance`), 6);
    assert.equal(await read(`userSettlements/${users[0].uid}/coinBalance`), 6);
    assert.equal(await read(`learningProgress/${users[0].uid}/vocabulary_daily_life/completedAttempts`), 1);
    assert.equal(await read(`userStats/${users[0].uid}/wins`), 1);
  });

  await test('A crashed worker lease is reclaimed without duplicating terminal results', async () => {
    const users = await fresh();
    const {id} = await pair(users);
    await freezeFixture(users, id);
    await adminDb.ref(`battleWork/${id}`).update({dueAt: 0,
      leaseOwner: 'crashed-worker', leaseUntil: battleNow() - 1});
    await runBattleMaintenance();
    await assertFinal(users, id, ['win', 'loss']);
    assert.equal(await read(`battleWork/${id}`), null);
  });

  await test('Final submits racing with leave produce one consistent immutable outcome', async () => {
    const users = await fresh();
    const {id, attempt} = await pair(users);
    const match = await read(`battleRooms/${id}`);
    match.currentIndex = 9;
    for (let p = 0; p < 2; p++) match.players[users[p].uid].answers = Object.fromEntries(
      match.questions.slice(0, 9).map((q, i) => [i, {questionId: q.id,
        selectedOptionId: option(q, p === 0), isCorrect: p === 0,
        timedOut: false, requestId: randomUUID(), receivedAt: Date.now()}]));
    await adminDb.ref(`battleRooms/${id}`).set(match);
    await Promise.all([
      submit(users[0], id, attempt.questions[9], true),
      submit(users[1], id, attempt.questions[9], false), leave(users[0], id),
    ]);
    const after = await read(`battleRooms/${id}`);
    if (after.status !== 'completed') await clockAt(after.leaveDeadlineAt, () => runBattleMaintenance());
    const finish = (await read(`battleRooms/${id}`)).finish;
    const outcomes = users.map(u => finish.outcomes[u.uid]);
    assert.ok([['win', 'loss'], ['left', 'win']].some(pair => JSON.stringify(pair) === JSON.stringify(outcomes)));
    await assertFinal(users, id, outcomes);
    await Promise.all(users.map(u => leave(u, id)));
    assert.deepEqual((await read(`battleRooms/${id}`)).finish, finish);
    assert.equal((await read(`wallets/${users[0].uid}/coinBalance`)) + (await read(`wallets/${users[1].uid}/coinBalance`)), 5);
  });

  await test('Local combined worker settles a battle with no app process connected', async () => {
    const users = await fresh();
    const {id} = await pair(users);
    await freezeFixture(users, id);
    await adminDb.ref(`battleWork/${id}/dueAt`).set(0);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../../../functions/tools/learning-worker.mjs', import.meta.url)), '--once'],
        {env: {...process.env}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
      let output = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Worker timed out: ' + output)); }, 20000);
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(output)); });
    });
    await assertFinal(users, id, ['win', 'loss']);
  });

  await test('Replaying an old result cannot release reservations of a newer battle', async () => {
    const users = await fresh();
    const {id: oldId} = await pair(users);
    await freezeFixture(users, oldId);
    await settleBattle(oldId);
    const {id: newId} = await pair(users);
    assert.notEqual(newId, oldId);
    await call(getAttemptResult, users[0], {attemptId: oldId});
    for (const u of users) {
      assert.equal((await read(`battleCoordinator/users/${u.uid}`)).matchId, newId);
      assert.equal((await read(`activeBattles/${u.uid}`)).roomId, newId);
    }
    assert.equal((await read(`battleRooms/${newId}`)).status, 'active');
  });
  await test('Independent backends match, play ten concurrent rounds and settle each UID only once', async () => {
    const users = await fresh();
    const actors = await Promise.all([startBackend(), startBackend()]);
    try {
      assert.notEqual(actors[0].pid, actors[1].pid);
      const tickets = await Promise.all(actors.map((actor, i) => actor.call('findBattle', users[i], {kind: 'quick', requestId: randomUUID()})));
      const matched = await Promise.all(actors.map((actor, i) => actor.call('getBattleTicket', users[i], {ticketId: tickets[i].ticket.id})));
      const id = matched[0].ticket.attemptId;
      assert.ok(id);
      assert.equal(matched[1].ticket.attemptId, id);
      await Promise.all(actors.map((actor, i) => actor.call('resumeAttempt', users[i], {attemptId: id})));
      const attempts = await Promise.all(actors.map((actor, i) => actor.call('resumeAttempt', users[i], {attemptId: id})));
      assert.deepEqual(attempts[0].attempt.questions, attempts[1].attempt.questions);
      assert.equal(attempts[0].attempt.deadlineAt, attempts[1].attempt.deadlineAt);
      for (const q of attempts[0].attempt.questions) {
        await Promise.all(actors.map((actor, i) => actor.call('submitAttemptAnswer', users[i], {
          attemptId: id, questionId: q.id, optionId: option(q, i === 0), requestId: randomUUID()})));
      }
      const frozen = (await read(`battleRooms/${id}`)).finish;
      await Promise.all(actors.map((actor, i) => actor.call('getAttemptResult', users[i], {attemptId: id})));
      await Promise.all(actors.map(actor => actor.call('maintenance')));
      await assertFinal(users, id, ['win', 'loss']);
      assert.deepEqual((await read(`battleRooms/${id}`)).finish, frozen);
      assert.equal(await read(`wallets/${users[0].uid}/coinBalance`), 5);
      assert.equal(await read(`userStats/${users[0].uid}/rating`), 5);
      assert.equal(await read(`battleWork/${id}`), null);
    } finally { await Promise.all(actors.map(actor => actor.close())); }
  });

  await test('Independent backends keep one reservation when duplicate find races with cancellation', async () => {
    const users = await fresh();
    const actors = await Promise.all([startBackend(), startBackend()]);
    try {
      const replies = await Promise.all(actors.map(actor => actor.call('findBattle', users[0], {kind: 'quick', requestId: randomUUID()})));
      assert.equal(replies[0].ticket.id, replies[1].ticket.id);
      const ticketId = replies[0].ticket.id;
      const [cancelled, found] = await Promise.all([
        actors[0].call('cancelBattleSearch', users[0], {ticketId}),
        actors[1].call('findBattle', users[1], {kind: 'quick', requestId: randomUUID()}),
      ]);
      const terminal = await read(`battleTickets/${users[0].uid}/${ticketId}`);
      if (terminal.status === 'cancelled') {
        assert.equal(cancelled.attempt, undefined);
        assert.equal(found.ticket.status, 'searching');
        assert.equal(await read(`battleCoordinator/users/${users[0].uid}`), null);
      } else {
        assert.equal(terminal.status, 'matched');
        const id = terminal.matchId;
        assert.equal(found.ticket.attemptId, id);
        assert.equal(cancelled.attempt.id, id);
        const match = await read(`battleRooms/${id}`);
        await actors[1].call('leaveAttempt', users[1], {attemptId: id, requestId: randomUUID()}, match.leaveDeadlineAt - 1);
        await assertFinal(users, id, ['draw', 'draw']);
      }
    } finally { await Promise.all(actors.map(actor => actor.close())); }
  });

  await test('Backend restart preserves drafts/deadlines and two workers resolve a late reconnect once', async () => {
    const users = await fresh();
    const {id, attempt} = await pair(users);
    const actors = await Promise.all([startBackend(), startBackend()]);
    try {
      const start = attempt.deadlineAt - 30000;
      const q = attempt.questions[0];
      await actors[0].call('saveAttemptSelection', users[0], {attemptId: id, questionId: q.id,
        optionId: correct(q), requestId: randomUUID()}, start + 25000);
      await actors[0].close();
      actors[0] = await startBackend();
      const restored = await actors[0].call('resumeAttempt', users[0], {attemptId: id}, start + 29000);
      assert.equal(restored.attempt.selectedOptionId, correct(q));
      assert.equal(restored.attempt.deadlineAt, attempt.deadlineAt);
      await actors[1].call('resumeAttempt', users[1], {attemptId: id}, start + 29000);
      await Promise.all(actors.map(actor => actor.call('maintenance', null, {}, start + 30000)));
      const round = await read(`battleRooms/${id}`);
      assert.equal(round.currentIndex, 1);
      assert.equal(round.players[users[0].uid].answers[0].isCorrect, true);
      assert.equal(round.players[users[1].uid].answers[0].isCorrect, false);
      await actors[1].call('resumeAttempt', users[1], {attemptId: id}, start + 58000);
      const late = await actors[0].call('resumeAttempt', users[0], {attemptId: id}, start + 59000);
      assert.equal(late.attempt.result.outcome, 'loss');
      const frozen = (await read(`battleRooms/${id}`)).finish;
      await Promise.all(actors.map(actor => actor.call('maintenance', null, {}, start + 59000)));
      await assertFinal(users, id, ['loss', 'win']);
      assert.deepEqual((await read(`battleRooms/${id}`)).finish, frozen);
      assert.equal(await read(`wallets/${users[1].uid}/coinBalance`), 5);
      assert.equal(await read(`battleWork/${id}`), null);
    } finally { await Promise.all(actors.map(actor => actor.close())); }
  });

  await test('Matchmaking rejects a trusted answer invalidated after question selection', async () => {
    const users = await fresh();
    const original = adminDb.ref;
    const reads = new Map();
    let invalidated = false;
    adminDb.ref = function(refPath) {
      const ref = original.call(this, refPath);
      if (refPath?.startsWith('questionAnswers/')) {
        const get = ref.get.bind(ref);
        ref.get = async () => {
          const count = (reads.get(refPath) || 0) + 1;
          reads.set(refPath, count);
          if (count === 2) {
            invalidated = true;
            await original.call(adminDb, `${refPath}/explanation`).remove();
          }
          return get();
        };
      }
      return ref;
    };
    try {
      await assert.rejects(find(users[0]), {code: 'failed-precondition'});
    } finally { adminDb.ref = original; }
    assert.ok(invalidated);
    assert.equal(await read(`battleCoordinator/users/${users[0].uid}`), null);
  });

  for (const kind of ['learning', 'battle']) {
    await test(`Local projection cancelling a ${kind} transaction is retried without duplicate grants`, async () => {
      const users = await fresh();
      const user = users[0];
      let id, path, finish;
      if (kind === 'battle') {
        ({id} = await pair(users));
        await freezeFixture(users, id);
        path = `battleRooms/${id}`;
        finish = () => resume(user, id);
      } else {
        const {attempt} = await call(startAttempt, user, {mode: 'PRACTICE', topicId: 'vocabulary_daily_life', requestId: randomUUID()});
        id = attempt.id;
        path = `practiceAttempts/${user.uid}/${id}`;
        const answers = Object.fromEntries(attempt.questions.map((q, ordinal) => [ordinal, {
          questionId: q.id, selectedOptionId: correct(q), isCorrect: true, timedOut: false,
          ordinal, requestId: randomUUID(), receivedAt: Date.now()}]));
        await adminDb.ref(path).update({status: 'waiting', currentIndex: 9,
          answers, answerStateVersion: 1, correctCount: 10, answeredCount: 10, finishedAt: Date.now()});
        finish = () => finalizeAttemptLogic(user.uid, id);
      }
      const original = adminDb.ref;
      let injected = false, cancelled = false, writing;
      adminDb.ref = function(refPath) {
        const ref = original.call(this, refPath);
        if (refPath === path) {
          const transaction = ref.transaction.bind(ref);
          ref.transaction = async (update, ...args) => {
            if (injected) return transaction(update, ...args);
            injected = true;
            // Keep one transaction in flight so the next is queued locally.
            // A projection update cancels that queued transaction with "set".
            const blocker = transaction(current => current, undefined, false).catch(() => {});
            const pending = transaction(update, ...args);
            writing = original.call(adminDb, `${path}/updatedAt`).set(Date.now());
            try {
              return await pending;
            } catch (error) {
              if (error.message === 'set') cancelled = true;
              throw error;
            } finally { await blocker; await writing; }
          };
        }
        return ref;
      };
      try { await finish(); await writing; } finally { adminDb.ref = original; }
      assert.ok(injected);
      assert.ok(cancelled, 'The test must actually cancel an in-flight SDK transaction');
      await finish();
      if (kind === 'battle') await assertFinal(users, id, ['win', 'loss']);
      else {
        assert.equal(await read(`wallets/${user.uid}/coinBalance`), 1);
        assert.equal(await read(`learningProgress/${user.uid}/vocabulary_daily_life/completedAttempts`), 1);
      }
    });
  }
} finally { await deleteApp(adminDb.app); }
