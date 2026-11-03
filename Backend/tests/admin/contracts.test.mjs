import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {requests, responses, questionInput} from './fixtures.mjs'
const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const {adminActions, validateAdminRequest: input, validateAdminResponse: output, adminRange} = require('./lib/admin/contracts.js')
const {adminOperationId, canonicalJson} = require('./lib/admin/operations.js')
const contract = JSON.parse(readFileSync(new URL('../../../frontend/contracts/admin.v1.json', import.meta.url), 'utf8'))

test('exactly 21 mapped callable request/response schemas accept representative DTOs', () => {
  assert.equal(adminActions.length, 21)
  assert.deepEqual([...adminActions].sort(), Object.values(contract.methods).filter(m => m.callable).map(m => m.callable).sort())
  assert.deepEqual(Object.keys(requests).sort(), [...adminActions].sort())
  assert.deepEqual(Object.keys(responses).sort(), [...adminActions].sort())
  for (const action of adminActions) {
    assert.doesNotThrow(() => input(action, requests[action]), `${action} request`)
    assert.doesNotThrow(() => output(action, responses[action]), `${action} response`)
    assert.throws(() => input(action, {...requests[action], uid: 'forged'}), {code: 'invalid-argument'})
    assert.throws(() => output(action, {...responses[action], token: 'secret'}), {code: 'internal'})
  }
})
test('user writes reject privileges, custom claims and balances rather than stripping them', () => {
  for (const key of ['admin', 'role', 'customClaims', 'rating', 'coins', 'password', 'uid']) {
    assert.throws(() => input('adminSaveUser', {...requests.adminSaveUser,
      input: {...requests.adminSaveUser.input, [key]: 999}}), {code: 'invalid-argument'})
  }
  assert.throws(() => input('adminSaveUser', {...requests.adminSaveUser, id: 'existing'}))
  assert.throws(() => input('adminSaveQuestion', {...requests.adminSaveQuestion, id: 'existing'}))
  assert.throws(() => input('adminSaveQuestion', {...requests.adminSaveQuestion, expectedVersion: 1}))
  assert.throws(() => input('adminGetUser', {id: '../wallets'}))
})
test('inclusive local dates reject rollover, impossible dates, reversed and excessive ranges', () => {
  const value = adminRange({from: '2026-11-01', to: '2026-11-03'})
  assert.equal(value.from, Date.parse('2026-10-31T17:00:00Z'))
  assert.equal(value.until, Date.parse('2026-11-03T17:00:00Z'))
  assert.equal(value.days, 3)
  assert.equal(adminRange({from: '2024-02-29', to: '2024-02-29'}).days, 1)
  for (const range of [{from: '2026-02-29', to: '2026-03-01'},
    {from: '2026-11-03', to: '2026-11-01'}, {from: '2025-01-01', to: '2026-11-03'}]) {
    assert.throws(() => input('adminGetOverview', {range}), {code: 'invalid-argument'})
  }
})
test('query, pagination, payload and complete-result export bounds are enforced', () => {
  for (const pageSize of [10, 20, 50]) assert.doesNotThrow(() => input('adminListUsers', {query: {pageSize}}))
  for (const query of [{pageSize: 100}, {page: 0}, {page: 1001}, {q: 'x'.repeat(101)}, {mode: 'quick'}, {status: 'disabled'}, {cursor: 'unbound'}]) {
    assert.throws(() => input('adminListUsers', {query}), {code: 'invalid-argument'})
  }
  for (const kind of ['users', 'questions', 'battles', 'analytics']) {
    assert.doesNotThrow(() => input('adminExportReport', {...requests.adminExportReport, kind, query: {}}))
    assert.throws(() => input('adminExportReport', {...requests.adminExportReport, kind, query: {page: 1}}))
  }
  assert.throws(() => input('adminExportReport', {...requests.adminExportReport, query: {mode: 'quick'}}))
  assert.throws(() => input('adminMarkNotificationsRead', {requestId: 'read'}))
  assert.throws(() => input('adminMarkNotificationsRead', {requestId: 'read', id: 'n', throughAt: 1}))
  assert.throws(() => input('adminSaveQuestion', {...requests.adminSaveQuestion,
    input: {...questionInput, passage: 'x'.repeat(30000), explanation: 'x'.repeat(20000), audioText: 'x'.repeat(20000)}}))
})
test('published questions require four distinct stable options, valid answers, explanations and skill content', () => {
  for (const patch of [{options: questionInput.options.slice(1)}, {correctOptionId: 'missing'}, {explanation: ' '},
    {options: questionInput.options.map(() => ({id: 'a', text: 'Duplicate'}))},
    {categoryId: 'reading'}, {categoryId: 'listening'}, {audioUrl: 'https://example.test/file.mp3'}]) {
    assert.throws(() => input('adminSaveQuestion', {...requests.adminSaveQuestion, input: {...questionInput, ...patch}}))
  }
  assert.doesNotThrow(() => input('adminSaveQuestion', {...requests.adminSaveQuestion,
    input: {...questionInput, categoryId: 'listening', audioText: 'Listen to this.'}}))
  assert.doesNotThrow(() => input('adminSaveContent', requests.adminSaveContent)) // category inferred from topic later
})
test('nested response allowlists hide raw source records, credentials and unpublished battle selections', () => {
  for (const field of ['token', 'passwordHash', 'customClaims', 'deviceToken']) {
    assert.throws(() => output('adminGetUser', {...responses.adminGetUser, user: {...responses.adminGetUser.user, [field]: 'secret'}}))
  }
  const value = structuredClone(responses.adminGetBattle)
  value.detail.battle.selections = {opponent: 'a'}
  assert.throws(() => output('adminGetBattle', value))
  assert.throws(() => output('adminGetOverview', {...responses.adminGetOverview, overview: {...responses.adminGetOverview.overview, ready: false}}))
  for (const denominators of [{answered: 10, correct: 11, started: 1, completed: 1},
    {answered: null, correct: 0, started: 1, completed: 1}, {answered: 10, correct: 8, started: 1, completed: 2}]) {
    assert.throws(() => output('adminGetOverview', {...responses.adminGetOverview,
      overview: {...responses.adminGetOverview.overview, denominators}}))
  }
  assert.throws(() => output('adminGetOverview', {...responses.adminGetOverview,
    overview: {...responses.adminGetOverview.overview, accuracy: 101}}))
  const report = {...responses.adminExportReport.report, rows: Array.from({length: 5001}, () => ['id'])}
  assert.throws(() => output('adminExportReport', {...responses.adminExportReport, report}))
  assert.throws(() => output('adminExportReport', {...responses.adminExportReport,
    report: {...responses.adminExportReport.report, total: 2}}))
})
test('operation identity scopes actor/action/requestId and fingerprint retains payload types', () => {
  const one = adminOperationId('a', 'save', 'r')
  assert.equal(one, adminOperationId('a', 'save', 'r'))
  assert.notEqual(one, adminOperationId('b', 'save', 'r'))
  assert.notEqual(one, adminOperationId('a', 'archive', 'r'))
  assert.equal(canonicalJson({b: 2, a: 1}), canonicalJson({a: 1, b: 2}))
  assert.notEqual(canonicalJson({a: 1}), canonicalJson({a: '1'}))
})
