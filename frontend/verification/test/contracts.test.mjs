import {test} from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {mobileContract, attempt, assertAttemptSemantics} from '../../contracts/mobile.v1.mjs';
import {checkPreparation, readJson} from '../check.mjs';
const ajv = new Ajv({allErrors: true, strict: false});
const q = {id: 'q1', version: 'v1', categoryId: 'vocabulary', topicId: 'vocabulary_daily_life', prompt: 'Choose the word.', options: [{id: 'a', text: 'A'}, {id: 'b', text: 'B'}]};
const a = {id: 'attempt-1', mode: 'PRACTICE', questions: Array.from({length: 10}, (_, i) => ({...q, id: `q${i + 1}`})), index: 0, deadlineAt: 1792850000000, receipts: [], status: 'active'};
const result = {attemptId: a.id, mode: 'PRACTICE', correct: 1, total: 10, coins: 1, outcome: 'completed', reviews: []};
test('project configuration, seed business rules and source adapters match the contracts', () => assert.equal(checkPreparation().status, 'PASS'));
test('all mobile callable request and response schemas compile', () => {
  assert.equal(Object.keys(mobileContract.methods).length, 19);
  for (const contract of Object.values(mobileContract.methods)) { ajv.compile(contract.request); ajv.compile(contract.response); }
});
test('live question envelopes reject correct answers, explanations and client-authoritative fields', () => {
  const validate = ajv.compile(mobileContract.methods.startAttempt.response);
  assert(validate({serverNow: 1792849990000, attempt: a}));
  const leaked = structuredClone(a); leaked.questions[0].correctId = 'a';
  assert(!validate({serverNow: 1792849990000, attempt: leaked}));
  const start = ajv.compile(mobileContract.methods.startAttempt.request);
  assert(start({mode: 'PRACTICE', topicId: 'vocabulary_daily_life', requestId: 'request-1'}));
  assert(!start({mode: 'PRACTICE', requestId: 'request-1'}));
  assert(!start({mode: 'PRACTICE', topicId: null, requestId: 'request-1'}));
  assert(start({mode: 'TEST', requestId: 'request-1'}));
  const find = ajv.compile(mobileContract.methods.findBattle.request);
  assert(find({kind: 'join', roomCode: 'AB1234', requestId: 'request-1'}));
  assert(!find({kind: 'join', requestId: 'request-1'}));
  assert(!find({kind: 'join', roomCode: 'bad-code', requestId: 'request-1'}));
  for (const field of ['uid', 'coins', 'rating']) assert(!start({mode: 'PRACTICE', topicId: 'vocabulary_daily_life', requestId: 'request-1', [field]: 999}));
  assert(!start({mode: 'PRACTICE'}));
});
test('terminal attempts require a result and null answers remain explicit timeouts', () => {
  const validate = ajv.compile(attempt);
  assert(!validate({...a, status: 'abandoned'}));
  assert(validate({...a, status: 'abandoned', result: {...result, outcome: 'abandoned', coins: 0}, receipts: [{questionId: 'q1', optionId: null, correct: null}]}));
  assert(ajv.compile(mobileContract.methods.submitAttemptAnswer.request)({attemptId: a.id, questionId: 'q1', optionId: null, requestId: 'timeout'}));
});
test('stable question IDs, option IDs, indexes and receipts are validated semantically', () => {
  assert.doesNotThrow(() => assertAttemptSemantics(a));
  assert.throws(() => assertAttemptSemantics({...a, index: 10}), /index/);
  assert.throws(() => assertAttemptSemantics({...a, questions: [q, q]}), /question id/);
  assert.throws(() => assertAttemptSemantics({...a, receipts: [{questionId: 'missing', optionId: null}]}), /reference/);
  const duplicate = structuredClone(a); duplicate.questions[0].options[1].id = 'a';
  assert.throws(() => assertAttemptSemantics(duplicate), /option id/);
});
test('confirmed rating, double-disconnect and midnight policies are explicit and preserve deferred modes', () => {
  const {confirmed, phaseOne} = readJson('frontend/contracts/business-rules.v1.json');
  assert.equal(confirmed.leaderboardMetric, 'current_cumulative_rating');
  assert.equal(confirmed.leaderboardParticipants, 'all_users');
  assert.equal(confirmed.bothDisconnectedAfterGraceOutcome, 'draw');
  assert.equal(confirmed.dailyChallengeExpiresAtNextMidnight, true);
  assert.deepEqual(phaseOne.liveBattleKinds, ['quick']);
  assert.equal(phaseOne.keepDeferredScreens, true);
  const page = ajv.compile(mobileContract.methods.getLeaderboard.response);
  assert(page({serverNow: 1, page: {title: 'Current rating', entries: [{uid: 'u', name: 'User', rank: 1, rating: 0}], self: null, nextCursor: null}}));
  assert(!page({serverNow: 1, page: {title: 'Current rating', entries: [{uid: 'u', name: 'User', rank: 1, rating: -1}], self: null, nextCursor: null}}));
});
