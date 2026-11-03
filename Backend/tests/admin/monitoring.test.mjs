import assert from 'node:assert/strict'
import {test, beforeEach, after} from 'node:test'
import {createRequire} from 'node:module'
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'

assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-admin')
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19299')
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:19200')
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined)
const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const {adminAuth: auth, adminDb: db} = require('./lib/config/firebaseAdmin.js')
const {deleteApp} = require('firebase-admin/app')
const api = require('./lib/admin/callables.js')
const {runBattleIndexMaintenance, runActivityIndexMaintenance} = require('./lib/admin/monitoringIndex.js')
const {provisionUserProfile} = require('./lib/be1/auth/userProvisioning.js')
const {findBattle} = require('./lib/be1/battle/battleCallables.js')
const {transactBattle} = require('./lib/be1/battle/battleService.js')
const {settleBattle} = require('./lib/be1/battle/battleSettlement.js')
const {projectActivity} = require('./lib/be1/reporting/activity.js')
assert.match(db.ref().toString(), /^http:\/\/127\.0\.0\.1:19200\//)
const seed = JSON.parse(readFileSync(new URL('../../database/english-battle.seed.json', import.meta.url), 'utf8'))
const read = async path => (await db.ref(path).get()).val()
const req = (u, data = {}) => ({data, auth: u ? {uid: u.uid, token: u.decoded} : undefined,
  rawRequest: {headers: u ? {authorization: `Bearer ${u.token}`} : {}}})
const call = (action, u, data = {}) => api[action].run(req(u, data))
async function account(admin = true) {
  const email = `${randomUUID()}@example.test`, password = 'EmulatorOnly123!'
  const u = await auth.createUser({email, password, displayName: admin ? 'Monitor QA' : 'Player QA'})
  await auth.setCustomUserClaims(u.uid, {admin})
  await provisionUserProfile(u.uid)
  const response = await fetch('http://127.0.0.1:19299/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=qa', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password, returnSecureToken: true}),
  })
  assert.equal(response.status, 200)
  const {idToken: token} = await response.json()
  return {...u, token, decoded: await auth.verifyIdToken(token)}
}
function room(id = 'match_1', patch = {}) {
  const now = Date.now()
  return {id, kind: 'quick', status: 'ready', createdAt: now, openedAt: now, deadlineAt: now + 30000,
    readyDeadlineAt: now + 30000, currentIndex: 0,
    players: {p1: {name: 'Frozen name', clientSessionId: 'secret-session', lastSeenAt: now},
      p2: {name: 'Other name', clientSessionId: 'secret-session-2', lastSeenAt: now}},
    questions: Array.from({length: 10}, (_, i) => ({id: `q_${i}`, categoryId: i % 2 ? 'reading' : 'vocabulary'})),
    keys: {q_0: {correctOptionId: 'secret-answer', explanation: 'secret-explanation'}}, ...patch}
}
function study(id, extra = {}) {
  return {entry: {attemptId: id, mode: 'PRACTICE', outcome: 'completed', total: 10, correct: 7,
    completedAt: Date.now(), ...extra}, answered: 10, skills: {vocabulary: {answered: 10, correct: 7}}, version: 1}
}
async function ready(kind) {
  const run = kind === 'battles' ? runBattleIndexMaintenance : runActivityIndexMaintenance
  for (let i = 0; i < 100; i++) {
    await db.ref(`adminMonitoringControl/${kind}/nextRunAt`).set(0)
    await run()
    const state = await read(`adminMonitoringControl/${kind}`)
    if (state.ready && !state.scanStartedAt) return state
  }
  assert.fail('Monitoring backfill failed to finish')
}
beforeEach(async () => {
  assert.equal((await fetch('http://127.0.0.1:19299/emulator/v1/projects/demo-englishbattle-admin/accounts', {method: 'DELETE'})).status, 200)
  await db.ref().set(seed)
  await db.ref().update({battleRooms: null, battleResults: null, battleLogs: null, studyActivities: null,
    users: {p1: {displayName: 'First player', createdAt: 1}, p2: {displayName: 'Second player', createdAt: 2}},
    accountAccess: {p1: {status: 'active'}, p2: {status: 'active'}}})
})
after(async () => deleteApp(db.app))

test('a match created through real matchmaking appears in the admin list and current detail', async () => {
  const actor = await account(), a = await account(false), b = await account(false)
  await findBattle.run(req(a, {kind: 'quick', clientSessionId: 'monitor_a', requestId: randomUUID()}))
  const matched = await findBattle.run(req(b, {kind: 'quick', clientSessionId: 'monitor_b', requestId: randomUUID()}))
  const id = matched.ticket.attemptId
  await ready('battles')
  const page = (await call('adminListBattles', actor, {query: {q: id}})).page
  assert.equal(page.total, 1)
  assert.equal(page.items[0].id, id)
  const {detail} = await call('adminGetBattle', actor, {id})
  assert.equal(detail.battle.phase, 'ready')
  assert.equal(detail.battle.playStartedAt, null)
  assert.deepEqual([detail.player1.id, detail.player2.id].sort(), [a.uid, b.uid].sort())
  assert.equal(detail.battle.logs.length, 0) // matchmaking did not record synthetic joined/start logs
  await transactBattle(id, {uid: a.uid, sessionId: 'monitor_a', action: {type: 'resume'}})
  await transactBattle(id, {uid: b.uid, sessionId: 'monitor_b', action: {type: 'resume'}})
  const started = (await call('adminGetBattle', actor, {id})).detail.battle
  assert.equal(started.phase, 'playing')
  assert.ok(started.playStartedAt)
  assert.equal(started.logs.filter(e => e.type === 'joined').length, 2)
  assert.equal(started.logs.filter(e => e.type === 'started').length, 1)
})

test('monitoring never reveals unconfirmed choices, current-round correctness or source secrets', async () => {
  const actor = await account(), match = room('match_1', {status: 'active', currentIndex: 1,
    questionTimings: {0: {openedAt: Date.now() - 30000}}})
  match.players.p1.answers = {0: {isCorrect: true}, 1: {isCorrect: true, selectedOptionId: 'secret-choice'}}
  match.players.p2.answers = {0: {isCorrect: false}}
  match.players.p2.selections = {1: {optionId: 'secret-selection'}}
  match.events = {one: {type: 'answered', at: Date.now(), uid: 'p1', message: 'secret-device-token'},
    prototype: {type: 'constructor', at: Date.now()},
    hidden: {type: 'secret-answer', at: Date.now()}}
  await db.ref('battleRooms/match_1').set(match)
  const {detail} = await call('adminGetBattle', actor, {id: 'match_1'})
  assert.equal(detail.battle.score1, 1)
  assert.equal(detail.battle.score2, 0)
  assert.equal(detail.battle.logs.length, 1)
  assert.deepEqual(Object.keys(detail.player1).sort(), ['code', 'id', 'name', 'status'])
  assert.doesNotMatch(JSON.stringify(detail), /secret|selections|selectedOptionId|correctOptionId|clientSessionId|reviews|email/)
  await ready('battles')
  assert.doesNotMatch(JSON.stringify(await read('adminBattleIndex')), /secret|selections|selectedOptionId|correctOptionId|clientSessionId/)
})

test('overdue matches remain read only; inspection does not finalize, settle or alter financial data', async () => {
  const actor = await account(), match = room('old_match', {createdAt: 1, readyDeadlineAt: 2})
  await db.ref('battleRooms/old_match').set(match)
  const paths = ['battleRooms', 'battleResults', 'wallets', 'userStats', 'userSettlements', 'rewardGrants', 'ratingLedger', 'battleWork']
  const before = await Promise.all(paths.map(read))
  await call('adminGetBattle', actor, {id: 'old_match'})
  await ready('battles')
  await call('adminListBattles', actor, {query: {}})
  assert.deepEqual(await Promise.all(paths.map(read)), before)
})

test('terminal mapping uses frozen scores/reason/time and explicit settlement state', async () => {
  const actor = await account(), at = Date.now()
  for (const reason of ['answers', 'leave', 'disconnect', 'account_unavailable', 'both_left', 'both_disconnected', 'ready_timeout']) {
    const id = `match_${reason}`
    await db.ref(`battleRooms/${id}`).set(room(id, {status: 'completed',
      finish: {reason, at, correct: {p1: 7, p2: 5}, answered: {p1: 10, p2: 9}}}))
    const b = (await call('adminGetBattle', actor, {id})).detail.battle
    assert.equal(b.status, ['both_left', 'both_disconnected', 'ready_timeout'].includes(reason) ? 'abandoned' : 'completed')
    assert.equal(b.score1, 7); assert.equal(b.score2, 5)
    assert.equal(b.endedAt, at); assert.equal(b.endReason, reason)
    assert.equal(b.settlementStatus, 'pending')
  }
  await db.ref().update({'battleRooms/match_answers/settlementVersion': 1,
    'battleResults/match_answers': {status: 'settled', correctCounts: {p1: 1, p2: 2}, finishedAt: at, endReason: 'answers'}})
  const b = (await call('adminGetBattle', actor, {id: 'match_answers'})).detail.battle
  assert.equal(b.settlementStatus, 'settled')
  assert.equal(b.score1, 7) // canonical finish wins even if a stale projection disagrees
})

test('legacy settled scores and real battleLogs are supported without filling missing timeline', async () => {
  const actor = await account(), at = Date.now()
  await db.ref('battleRooms/legacy').set(room('legacy', {status: 'completed', settlementVersion: 1}))
  await db.ref('battleResults/legacy').set({status: 'settled', correctCounts: {p1: 2, p2: 4}, finishedAt: at, endReason: 'answers'})
  await db.ref('battleLogs/legacy').set({only: {type: 'started', at: at - 1000}, unknown: {type: 'not-real', at}})
  const b = (await call('adminGetBattle', actor, {id: 'legacy'})).detail.battle
  assert.equal(b.score2, 4)
  assert.equal(b.logs.length, 1)
  assert.equal(b.playStartedAt, at - 1000)
})

test('battle discovery passes more than 50 rooms; filters and frozen pages have exact stable totals', async () => {
  const actor = await account(), other = await account()
  const updates = {}
  for (let i = 0; i < 63; i++) {
    const id = `match_${String(i).padStart(3, '0')}`
    updates[`battleRooms/${id}`] = room(id, {createdAt: 1000})
  }
  await db.ref().update(updates)
  await assert.rejects(call('adminListBattles', actor, {query: {}}), e => e.details.reason === 'monitoring-index-not-ready')
  const state = await ready('battles')
  const query = {pageSize: 20, status: 'ongoing', mode: 'quick', categoryId: 'mixed'}
  const first = (await call('adminListBattles', actor, {query})).page
  assert.equal(first.total, 63); assert.equal(first.items.length, 20)
  assert.equal(first.asOf, state.asOf); assert.equal(first.ready, true)
  assert.ok(first.lagMs >= 0)
  const second = (await call('adminListBattles', actor, {query: {...query, page: 2, snapshotId: first.snapshotId, cursor: first.nextCursor}})).page
  assert.equal(new Set([...first.items, ...second.items].map(b => b.id)).size, 40)
  assert.equal(first.items[0].id, 'match_000')
  await db.ref('battleRooms/new_match').set(room('new_match'))
  await ready('battles')
  assert.equal((await call('adminListBattles', actor, {query: {...query, snapshotId: first.snapshotId}})).page.total, 63)
  assert.equal((await call('adminListBattles', actor, {query})).page.total, 64)
  await assert.rejects(call('adminListBattles', other, {query: {...query, snapshotId: first.snapshotId}}))
  await assert.rejects(call('adminListBattles', actor, {query: {...query, status: 'completed', snapshotId: first.snapshotId}}))
  await assert.rejects(call('adminListActivities', actor, {query: {pageSize: 20, snapshotId: first.snapshotId}}))
  await db.ref(`adminSnapshots/${first.snapshotId}/expiresAt`).set(1)
  await assert.rejects(call('adminListBattles', actor, {query: {...query, snapshotId: first.snapshotId}}))
})

test('local-day filtering includes the final day and unsupported daily/private monitoring reports unimplemented', async () => {
  const actor = await account(), from = Date.parse('2026-11-03T00:00:00+07:00'), until = from + 86400000
  await db.ref('battleRooms').set({early: room('early', {createdAt: from - 1}),
    included: room('included', {createdAt: until - 1}), late: room('late', {createdAt: until})})
  await ready('battles')
  const page = (await call('adminListBattles', actor, {query: {range: {from: '2026-11-03', to: '2026-11-03'}}})).page
  assert.deepEqual(page.items.map(b => b.id), ['included'])
  for (const mode of ['daily', 'private']) await assert.rejects(call('adminListBattles', actor, {query: {mode}}), {code: 'unimplemented'})
  await assert.rejects(call('adminGetBattle', actor, {id: 'missing'}), {code: 'not-found'})
})

test('deleted/missing identities are redacted on existing snapshots and current detail', async () => {
  const actor = await account()
  await db.ref('battleRooms/match_1').set(room())
  await db.ref('studyActivities/p1/learning_one').set(study('one'))
  await ready('battles'); await ready('activities')
  const b = (await call('adminListBattles', actor, {query: {}})).page
  const a = (await call('adminListActivities', actor, {query: {type: 'lesson'}})).page
  await db.ref('accountAccess/p1/status').set('deleted')
  const frozen = (await call('adminListBattles', actor, {query: {snapshotId: b.snapshotId}})).page.items[0]
  assert.equal(frozen.player1Name, 'Tài khoản đã xóa')
  const detail = (await call('adminGetBattle', actor, {id: 'match_1'})).detail
  assert.equal(detail.player1.status, 'deleted')
  assert.equal(detail.player1.name, 'Tài khoản đã xóa')
  assert.equal((await call('adminListActivities', actor, {query: {type: 'lesson', snapshotId: a.snapshotId}})).page.items[0].userName, 'Tài khoản đã xóa')
  assert.doesNotMatch(JSON.stringify(await read('adminSnapshots')), /First player|Second player|Frozen name/)
  await db.ref('accountAccess/p2').remove()
  assert.equal((await call('adminGetBattle', actor, {id: 'match_1'})).detail.player2.name, 'Tài khoản đã xóa')
})

test('activity discovery pages beyond 50, deduplicates reporting retries and preserves mixed-skill counts', async () => {
  const actor = await account(), updates = {}
  for (let i = 0; i < 223; i++) updates[`studyActivities/p1/learning_${String(i).padStart(3, '0')}`] = study(`attempt_${i}`)
  updates['studyActivities/p2/battle_one'] = {...study('battle_one', {mode: 'BATTLE', outcome: 'loss', correct: 3}), answered: 6,
    skills: {vocabulary: {answered: 2, correct: 1}, reading: {answered: 4, correct: 2}}}
  await db.ref().update(updates)
  await ready('activities')
  const first = (await call('adminListActivities', actor, {query: {type: 'lesson', pageSize: 50}})).page
  assert.equal(first.total, 223)
  const second = (await call('adminListActivities', actor, {query: {type: 'lesson', pageSize: 50, page: 2, snapshotId: first.snapshotId}})).page
  assert.equal(second.items.length, 50)
  assert.equal(new Set([...first.items, ...second.items].map(a => a.id)).size, 100)
  const before = Object.keys(await read('adminActivityIndex')).length
  await ready('activities')
  assert.equal(Object.keys(await read('adminActivityIndex')).length, before)
  const mixed = (await call('adminListActivities', actor, {query: {type: 'battle', categoryId: 'mixed'}})).page
  assert.equal(mixed.total, 1); assert.equal(mixed.items[0].answered, 6); assert.equal(mixed.items[0].correct, 3)
  const registered = (await call('adminListActivities', actor, {query: {type: 'user'}})).page
  assert.equal(registered.total, 3)
  assert.ok(registered.items.every(e => e.sourceId === e.userId))
})

test('reporting projection and battle settlement retries produce one activity per participant', async () => {
  const actor = await account(), a = await account(false), b = await account(false)
  await findBattle.run(req(a, {kind: 'quick', clientSessionId: 'settle_a', requestId: randomUUID()}))
  const matched = await findBattle.run(req(b, {kind: 'quick', clientSessionId: 'settle_b', requestId: randomUUID()}))
  const id = matched.ticket.attemptId, match = await read(`battleRooms/${id}`), at = Date.now()
  match.status = 'completed'
  match.finish = {reason: 'both_left', outcomes: {[a.uid]: 'draw', [b.uid]: 'draw'},
    correct: {[a.uid]: 0, [b.uid]: 0}, answered: {[a.uid]: 0, [b.uid]: 0}, at}
  await db.ref(`battleRooms/${id}`).set(match)
  await settleBattle(id); await settleBattle(id, true)
  const entry = {attemptId: 'lesson_retry', mode: 'PRACTICE', outcome: 'completed', correct: 3, total: 10, completedAt: at, durationMs: null}
  await projectActivity(a.uid, entry, 3, {reading: {answered: 3, correct: 3}})
  await projectActivity(a.uid, entry, 3, {reading: {answered: 3, correct: 3}})
  await ready('activities'); await ready('battles')
  const battles = (await call('adminListActivities', actor, {query: {type: 'battle'}})).page
  assert.equal(battles.total, 2)
  assert.equal(new Set(battles.items.map(e => e.userId)).size, 2)
  assert.equal((await call('adminListActivities', actor, {query: {type: 'lesson'}})).page.total, 1)
  const detail = (await call('adminGetBattle', actor, {id})).detail.battle
  assert.equal(detail.endedAt, at); assert.equal(detail.settlementStatus, 'settled')
})

test('abandoned study is identified honestly and legacy missing registration dates do not get fabricated', async () => {
  const actor = await account()
  await db.ref('users/p1/createdAt').remove()
  await db.ref('studyActivities/p1/learning_left').set(study('left', {outcome: 'abandoned'}))
  await ready('activities')
  const events = (await call('adminListActivities', actor, {query: {type: 'lesson', q: 'left'}})).page
  assert.equal(events.items[0].completed, false)
  assert.equal(events.items[0].outcome, 'abandoned')
  assert.match(events.items[0].text, /abandoned/)
  assert.equal((await call('adminListActivities', actor, {query: {type: 'user'}})).page.total, 2)
})

test('interrupted index writes recover from checkpoints without duplicate activities', async () => {
  const actor = await account()
  await db.ref('studyActivities/p1/learning_one').set(study('one'))
  const original = db.ref.bind(db)
  let injected = false
  db.ref = path => {
    const ref = original(path)
    if (path?.startsWith('adminActivityIndex/')) {
      const transaction = ref.transaction.bind(ref)
      ref.transaction = async (...args) => {
        const result = await transaction(...args)
        if (!injected) { injected = true; throw new Error('Lost write acknowledgement') }
        return result
      }
    }
    return ref
  }
  try { await assert.rejects(runActivityIndexMaintenance()) } finally { db.ref = original }
  assert.equal(await read('adminMonitoringControl/activities/ready'), false)
  await ready('activities')
  assert.equal((await call('adminListActivities', actor, {query: {type: 'lesson'}})).page.total, 1)
  assert.equal((await call('adminListActivities', actor, {query: {type: 'user'}})).page.total, 3)
})

test('active leases block concurrent writers; expired leases restart safely and malformed sources prevent readiness', async () => {
  const actor = await account()
  await db.ref('battleRooms/match_1').set(room())
  await db.ref('adminMonitoringControl/battles').set({owner: 'other_worker', leaseUntil: Date.now() + 90000, sequence: 20})
  await runBattleIndexMaintenance()
  assert.equal(await read('adminBattleIndex'), null)
  await db.ref('adminMonitoringControl/battles').update({leaseUntil: 1, after: 'zzzz', ready: true})
  await ready('battles')
  assert.equal((await call('adminListBattles', actor, {query: {}})).page.total, 1)
  await db.ref('battleRooms/broken').set({kind: 'quick', status: 'completed'})
  await db.ref('adminMonitoringControl/battles/nextRunAt').set(0)
  await assert.rejects(runBattleIndexMaintenance(), e => e.details.reason === 'invalid-stored-battle')
  await assert.rejects(call('adminListBattles', actor, {query: {}}), e => e.details.reason === 'monitoring-index-not-ready')
  await db.ref('studyActivities/p1/bad').set({...study('bad'), answered: -1})
  await assert.rejects(runActivityIndexMaintenance(), e => e.details.reason === 'invalid-stored-activity')
  assert.equal(await read('adminMonitoringControl/activities/ready'), false)
  await db.ref('studyActivities/p1/bad').set(study('bad', {mode: 'BATTLE', outcome: 'completed'}))
  await db.ref('adminMonitoringControl/activities/nextRunAt').set(0)
  await assert.rejects(runActivityIndexMaintenance(), e => e.details.reason === 'invalid-stored-activity')
  await db.ref('studyActivities/p1/bad').set(study('bad'))
  await ready('activities')
  assert.equal((await call('adminListActivities', actor, {query: {type: 'lesson'}})).page.total, 1)
})

test('monitoring denies unsafe query shapes, foreign cursors and direct client reads of private indexes', async () => {
  const actor = await account()
  for (const query of [{pageSize: 100}, {status: 'ready'}, {q: 'x'.repeat(101)}, {uid: 'p1'},
    {range: {from: '2026-02-30', to: '2026-03-01'}}]) {
    await assert.rejects(call('adminListBattles', actor, {query}), {code: 'invalid-argument'})
  }
  await db.ref('battleRooms/match_1').set(room())
  await ready('battles')
  const {page} = await call('adminListBattles', actor, {query: {}})
  await assert.rejects(call('adminListBattles', actor, {query: {snapshotId: page.snapshotId, cursor: 'foreign'}}), {code: 'invalid-argument'})
  for (const path of ['adminBattleIndex', 'adminActivityIndex', 'battleRooms', 'battleResults']) {
    const result = await fetch(`http://127.0.0.1:19200/${path}.json?ns=demo-englishbattle-admin-default-rtdb&auth=${actor.token}`)
    assert.equal(result.status, 401)
  }
})
