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
const {runAdminAnalyticsMaintenance: run} = require('./lib/admin/analyticsWorker.js')
const {analyticsDay: day, analyticsKey} = require('./lib/admin/analyticsModel.js')
const {provisionUserProfile} = require('./lib/be1/auth/userProvisioning.js')
assert.match(db.ref().toString(), /^http:\/\/127\.0\.0\.1:19200\//)
const read = async path => (await db.ref(path).get()).val()
const base = Date.parse(`${day(Date.now())}T00:00:00+07:00`)
const at = (offset, hour = 12) => base + offset * 86400000 + hour * 3600000
const range = {from: day(at(-2)), to: day(at(-1))}
const request = (u, data) => ({data, auth: u ? {uid: u.uid, token: u.decoded} : undefined,
  rawRequest: {headers: u ? {authorization: `Bearer ${u.token}`} : {}}})
const overview = async (actor, extra = {}) => (await api.adminGetOverview.run(request(actor, {range, ...extra}))).overview
async function actor() {
  const email = `${randomUUID()}@example.test`, password = 'EmulatorOnly123!'
  const u = await auth.createUser({email, password, displayName: 'Analytics QA'})
  await auth.setCustomUserClaims(u.uid, {admin: true})
  await provisionUserProfile(u.uid)
  const response = await fetch('http://127.0.0.1:19299/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=qa', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password, returnSecureToken: true}),
  })
  assert.equal(response.status, 200)
  const {idToken: token} = await response.json()
  return {...u, token, decoded: await auth.verifyIdToken(token)}
}
async function learner(uid = randomUUID(), createdAt = at(-10)) {
  const result = await auth.importUsers([{uid, email: `${uid}@example.test`, displayName: 'Learner',
    metadata: {creationTime: new Date(createdAt).toUTCString()}}])
  assert.equal(result.failureCount, 0)
  await provisionUserProfile(uid)
  assert.equal(Date.parse((await auth.getUser(uid)).metadata.creationTime), createdAt)
  return uid
}
async function learning(uid, id, options = {}) {
  const {start = at(-2), end = at(-1), status = 'completed', correct = 8, answered = 10,
    skills = ['vocabulary'], mode = 'practice', answerAt = end - 1000} = options
  const total = mode === 'test' ? 20 : mode === 'dailyChallenge' ? 5 : 10
  const questions = Object.fromEntries(Array.from({length: total}, (_, i) => [i,
    {questionId: `q_${i}`, version: 'v1', categoryId: skills[i % skills.length], correctOptionId: 'secret-key'}]))
  const answers = Object.fromEntries(Array.from({length: answered}, (_, i) => [i,
    {questionId: `q_${i}`, isCorrect: i < correct, receivedAt: answerAt, selectedOptionId: 'secret-choice'}]))
  await db.ref().update({[`practiceAttempts/${uid}/${id}`]: {mode, status, startedAt: start, createdAt: start,
    finishedAt: end, questionCount: total, answeredCount: answered, correctCount: correct, answers,
    token: 'secret-token'}, [`attemptQuestions/${uid}/${id}`]: questions})
}
async function battle(id, a, b, options = {}) {
  const {start = at(-2), end = at(-1), status = 'completed', reason = 'answers', skills = ['vocabulary', 'reading'],
    correctA = 2, correctB = 1, answered = 4} = options
  const questions = Array.from({length: 10}, (_, i) => ({id: `battle_q_${i}`, categoryId: skills[i % skills.length]}))
  const answers = correct => Object.fromEntries(Array.from({length: answered}, (_, i) => [i,
    {isCorrect: i < correct, receivedAt: end - 1000, selectedOptionId: 'secret-selection'}]))
  await db.ref(`battleRooms/${id}`).set({id, kind: 'quick', status, createdAt: start || at(-2),
    questionTimings: start ? {0: {openedAt: start}} : {}, questions, keys: {a: 'secret-key'},
    players: {[a]: {joinedAt: start, answers: answers(correctA), clientSessionId: 'secret-session'},
      [b]: {joinedAt: start, answers: answers(correctB), clientSessionId: 'secret-session-2'}},
    ...(status === 'completed' ? {finish: {reason, at: end, correct: {[a]: correctA, [b]: correctB},
      answered: {[a]: answered, [b]: answered}}} : {})})
}
async function drain() {
  const old = (await read('adminAnalyticsControl'))?.activeGeneration
  for (let i = 0; i < 200; i++) {
    await db.ref('adminAnalyticsControl/nextRunAt').set(0)
    await run(4)
    const c = await read('adminAnalyticsControl')
    if (c.activeGeneration && c.activeGeneration !== old && !c.pending) return c
  }
  assert.fail('Analytics did not publish a generation')
}
beforeEach(async () => {
  assert.equal((await fetch('http://127.0.0.1:19299/emulator/v1/projects/demo-englishbattle-admin/accounts', {method: 'DELETE'})).status, 200)
  await db.ref().set({})
})
after(async () => deleteApp(db.app))

test('overview refuses an unfinished generation and guards anonymous, regular and revoked administrators', async () => {
  const admin = await actor()
  await assert.rejects(overview(admin), e => e.details.reason === 'overview-not-ready')
  await assert.rejects(overview(null), {code: 'unauthenticated'})
  await auth.setCustomUserClaims(admin.uid, {admin: false})
  await assert.rejects(overview(admin), {code: 'permission-denied'})
})

test('account counts use paged Auth, include banned accounts, exclude deleted totals and preserve registration history', async () => {
  const admin = await actor()
  const a = await learner('registered', at(-2)), b = await learner('banned', at(-1)), c = await learner('deleted', at(-3))
  await auth.updateUser(b, {disabled: true})
  await db.ref(`accountAccess/${b}/status`).set('banned')
  await db.ref(`accountAccess/${c}`).update({status: 'deleted', updatedAt: at(-1)})
  await drain()
  const o = await overview(admin)
  assert.equal(o.totalUsers, 3)
  assert.equal(o.newUsers, 2)
  assert.equal(o.growth.users, 100) // previous two days contain the retained deleted registration
  assert.equal(o.series.at(-1).users, 3) // admin registered today, outside selected period
  assert.equal(o.recent.find(e => e.userId === a).text, 'Account registered')
  assert.equal(o.coverage.accountScope, 'retained-auth')
})

test('active users are UID unions over the whole range and a battle counts once while both players are active', async () => {
  const admin = await actor(), a = await learner('a'), b = await learner('b')
  await learning(a, 'one', {start: at(-2), end: at(-2, 15)})
  await learning(a, 'two', {start: at(-1), end: at(-1, 15)})
  await battle('match', a, b)
  const sourcePaths = ['practiceAttempts', 'battleRooms', 'battleResults', 'wallets', 'userSettlements', 'studyActivities']
  const before = await Promise.all(sourcePaths.map(read))
  await drain()
  const o = await overview(admin)
  assert.equal(o.activeUsers, 2)
  assert.equal(o.completedBattles, 1)
  assert.equal(o.completedLessons, 2)
  assert.ok(o.series.reduce((n, d) => n + d.active, 0) > o.activeUsers)
  assert.doesNotMatch(JSON.stringify(o), /secret-|answers|clientSessionId|selectedOptionId|correctOptionId/)
  const raw = JSON.stringify(await read(`adminAnalyticsGenerations/${o.generation}/facts`))
  assert.doesNotMatch(raw, /secret-|clientSessionId|selectedOptionId|correctOptionId/)
  assert.deepEqual(await Promise.all(sourcePaths.map(read)), before)
})

test('Auth backfill crosses 25/50-account pages and includes accounts not yet provisioned in RTDB', async () => {
  const admin = await actor()
  const imported = await auth.importUsers(Array.from({length: 56}, (_, i) => ({uid: `bulk_${String(i).padStart(3, '0')}`,
    email: `bulk-${i}@example.test`, metadata: {creationTime: new Date(at(-2)).toUTCString()}})))
  assert.equal(imported.failureCount, 0)
  await drain()
  const o = await overview(admin)
  assert.equal(o.totalUsers, 57); assert.equal(o.newUsers, 56)
  assert.equal(o.series.at(-1).users, 56)
})

test('accuracy is weighted correct/answered over finalized sessions including abandoned partial answers', async () => {
  const admin = await actor(), uid = await learner('a')
  await learning(uid, 'full', {correct: 8, answered: 10})
  await learning(uid, 'partial', {correct: 1, answered: 2, status: 'abandoned'})
  await learning(uid, 'live', {correct: 1, answered: 1, status: 'active', end: 0, answerAt: at(-1)})
  await drain()
  const o = await overview(admin)
  assert.equal(o.accuracy, 75)
  assert.deepEqual(o.denominators, {answered: 12, correct: 9, started: 3, completed: 1})
  assert.equal(o.completedLessons, 1)
  assert.ok(Math.abs(o.completion - 100 / 3) < 1e-9)
})

test('completion uses the started-in-period cohort, including its later completions, rather than completions in period', async () => {
  const admin = await actor(), uid = await learner('a')
  await learning(uid, 'old_start', {start: at(-3), end: at(-1)})
  await learning(uid, 'later_end', {start: at(-2), end: at(0, 1)})
  await learning(uid, 'finished', {start: at(-1), end: at(-1, 15)})
  await learning(uid, 'running', {start: at(-1), end: 0, status: 'active', answered: 0, correct: 0})
  await drain()
  const o = await overview(admin)
  assert.equal(o.completedLessons, 2)
  assert.equal(o.denominators.started, 3)
  assert.equal(o.denominators.completed, 2)
  assert.ok(Math.abs(o.completion - 200 / 3) < 1e-9)
})

test('mixed skills allocate actual per-question counts while filtered battle totals remain one per match', async () => {
  const admin = await actor(), a = await learner('a'), b = await learner('b')
  await battle('mixed', a, b)
  await drain()
  const all = await overview(admin), vocab = await overview(admin, {categoryId: 'vocabulary'}), reading = await overview(admin, {categoryId: 'reading'})
  assert.equal(all.completedBattles, 1)
  assert.equal(vocab.completedBattles, 1); assert.equal(reading.completedBattles, 1)
  assert.deepEqual(vocab.denominators, {answered: 4, correct: 2, started: 1, completed: 1})
  assert.deepEqual(reading.denominators, {answered: 4, correct: 1, started: 1, completed: 1})
  assert.equal(all.accuracy, 37.5)
  assert.equal(vocab.activeUsers, 2)
  assert.equal(all.categories.filter(c => c.battles === 1).length, 2)
})

test('inclusive Vietnamese days and previous periods have equal lengths and exact growth denominators', async () => {
  const admin = await actor(), a = await learner('a'), b = await learner('b'), c = await learner('c')
  await battle('prior', a, b, {start: at(-4), end: at(-3)})
  await battle('current1', a, b)
  await battle('current2', a, c)
  await learning(a, 'included', {start: at(-1, 23), end: base - 1, answerAt: base - 2})
  await learning(a, 'excluded', {start: at(0, 0), end: at(0, 1)})
  await drain()
  const o = await overview(admin)
  assert.equal(o.growth.battles, 100)
  assert.equal(o.growth.active, 50)
  assert.equal(o.completedLessons, 1)
  assert.equal(o.series.length, 2)
  assert.deepEqual(o.series.map(s => s.date), [range.from, range.to])
})

test('empty denominators are null and ready-only timeouts do not become completed or started battles', async () => {
  const admin = await actor(), a = await learner('a'), b = await learner('b')
  await battle('not_started', a, b, {start: 0, reason: 'ready_timeout', answered: 0, correctA: 0, correctB: 0})
  await drain()
  const o = await overview(admin)
  assert.equal(o.completedBattles, 0); assert.equal(o.denominators.started, 0)
  assert.equal(o.accuracy, null); assert.equal(o.completion, null)
  assert.deepEqual(o.growth, {users: null, active: null, battles: null})
})

test('completed/abandoned battle KPIs agree with the status classification used on the monitoring page', async () => {
  const admin = await actor(), a = await learner('a'), b = await learner('b')
  let expected = 0
  for (const reason of ['answers', 'leave', 'disconnect', 'account_unavailable', 'both_left', 'both_disconnected', 'ready_timeout']) {
    await battle(reason, a, b, reason === 'ready_timeout' ? {reason, start: 0, answered: 0, correctA: 0, correctB: 0} : {reason})
    const dto = await api.adminGetBattle.run(request(admin, {id: reason}))
    if (dto.detail.battle.status === 'completed') expected++
  }
  await drain()
  const o = await overview(admin)
  assert.equal(expected, 4); assert.equal(o.completedBattles, expected)
  assert.equal(o.denominators.started, 6); assert.equal(o.denominators.completed, 4)
})

test('calendar week/month buckets aggregate counts and distinct UID sets instead of sampling every seventh day', async () => {
  const admin = await actor(), uid = await learner('a')
  const selected = {from: '2026-10-28', to: '2026-11-02'}
  for (const [i, date] of ['2026-10-28', '2026-10-31', '2026-11-01', '2026-11-02'].entries()) {
    const start = Date.parse(`${date}T01:00:00+07:00`)
    await learning(uid, `calendar_${i}`, {start, end: start + 1000, answerAt: start + 500})
  }
  await drain()
  const weekly = await overview(admin, {range: selected, granularity: 'week'})
  assert.deepEqual(weekly.series.map(s => [s.date, s.lessons, s.active]), [['2026-10-26', 3, 1], ['2026-11-02', 1, 1]])
  const monthly = await overview(admin, {range: selected, granularity: 'month'})
  assert.deepEqual(monthly.series.map(s => [s.date, s.lessons, s.active]), [['2026-10-01', 2, 1], ['2026-11-01', 2, 1]])
})

test('backfill covers more than 50 sessions and rebuilding never increases metrics or exposes unfinished totals', async () => {
  const admin = await actor(), uid = await learner('a')
  for (let i = 0; i < 63; i++) await learning(uid, `lesson_${String(i).padStart(3, '0')}`)
  await drain()
  const first = await overview(admin)
  assert.equal(first.completedLessons, 63); assert.equal(first.denominators.answered, 630)
  assert.equal(first.recent.length, 5)
  await learning(uid, 'late', {correct: 5})
  await db.ref('adminAnalyticsControl/nextRunAt').set(0)
  await run(1)
  assert.equal((await overview(admin)).generation, first.generation)
  assert.equal((await overview(admin)).completedLessons, 63)
  await drain()
  const next = await overview(admin)
  assert.notEqual(next.generation, first.generation); assert.equal(next.completedLessons, 64)
  await drain()
  const again = await overview(admin)
  assert.equal(again.completedLessons, 64); assert.deepEqual(again.denominators, next.denominators)
})

test('late completion changes the correct cohort once and later reporting retries cannot duplicate a canonical attempt', async () => {
  const admin = await actor(), uid = await learner('a')
  await learning(uid, 'late', {end: 0, status: 'active', answered: 0, correct: 0})
  await drain()
  assert.equal((await overview(admin)).completion, 0)
  await learning(uid, 'late')
  await db.ref(`studyActivities/${uid}/learning_late`).set({entry: {mode: 'PRACTICE', attemptId: 'late',
    outcome: 'completed', completedAt: at(-1), total: 10, correct: 8}, answered: 10, version: 99})
  await drain()
  const o = await overview(admin)
  assert.equal(o.completedLessons, 1); assert.equal(o.denominators.started, 1); assert.equal(o.completion, 100)
})

test('legacy summaries keep their terminal count, mark unknown start/skill history and never fabricate completion', async () => {
  const admin = await actor(), uid = await learner('a')
  await db.ref(`studyActivities/${uid}/learning_legacy`).set({entry: {mode: 'PRACTICE', attemptId: 'legacy',
    outcome: 'completed', completedAt: at(-1), total: 10, correct: 7}, answered: 10,
    skills: {vocabulary: {answered: 10, correct: 7}}})
  await drain()
  const o = await overview(admin)
  assert.equal(o.completedLessons, 1); assert.equal(o.accuracy, 70); assert.equal(o.completion, null)
  assert.equal(o.coverage.unknownStartSessions, 1); assert.equal(o.coverage.skillBreakdownComplete, false)
  assert.deepEqual(o.categories, [])
  await assert.rejects(overview(admin, {categoryId: 'vocabulary'}), e => e.details.reason === 'overview-skill-history-incomplete')
})

test('result-only historical battles count once with unknown accuracy, while incomplete participant history is rejected', async () => {
  const admin = await actor(), a = await learner('a'), b = await learner('b')
  await db.ref('battleResults/old').set({status: 'settled', endReason: 'answers', finishedAt: at(-1),
    players: {[a]: {outcome: 'win', correct: 8}, [b]: {outcome: 'loss', correct: 4}}})
  await drain()
  const o = await overview(admin)
  assert.equal(o.completedBattles, 1); assert.equal(o.accuracy, null); assert.equal(o.completion, null)
  assert.equal(o.denominators.answered, null); assert.equal(o.activeUsers, 2)
  await db.ref(`studyActivities/${a}/battle_orphan`).set({entry: {mode: 'BATTLE', attemptId: 'orphan',
    completedAt: at(-1), outcome: 'win', correct: 1}, answered: 2, secret: 'secret-token'})
  await drain()
  await assert.rejects(overview(admin), e => e.details.reason === 'overview-history-incomplete')
  assert.doesNotMatch(JSON.stringify(await read('adminAnalyticsGenerations')), /secret-token/)
})

test('missing historical learning or battle counts produce unknown accuracy rather than fabricated zeroes', async () => {
  const admin = await actor(), a = await learner('a'), b = await learner('b')
  await db.ref(`studyActivities/${a}/learning_no_correct`).set({entry: {mode: 'PRACTICE',
    attemptId: 'no_correct', outcome: 'completed', completedAt: at(-1), total: 10}, answered: 10})
  await db.ref(`studyActivities/${a}/learning_no_answered`).set({entry: {mode: 'PRACTICE',
    attemptId: 'no_answered', outcome: 'abandoned', completedAt: at(-1), total: 10, correct: 2}})
  await battle('no_correct', a, b)
  await db.ref('battleRooms/no_correct').update({
    'finish/correct': null, [`players/${a}/answers`]: null, [`players/${b}/answers`]: null,
  })
  await db.ref('battleResults/partial_grant').set({status: 'settled', endReason: 'answers', finishedAt: at(-1),
    players: {[a]: {outcome: 'win'}, [b]: {outcome: 'loss'}}})
  for (const uid of [a, b]) await db.ref(`userSettlements/${uid}/grants/grant_partial_grant`).set({answeredCount: 10})
  await drain()
  const o = await overview(admin)
  assert.equal(o.completedLessons, 1); assert.equal(o.completedBattles, 2)
  assert.equal(o.accuracy, null); assert.equal(o.denominators.correct, null)
  assert.equal(o.denominators.answered, null); assert.equal(o.coverage.unknownAnswers, true)
  assert.deepEqual(o.categories, [])
})

test('lost day-write acknowledgements replay deterministic receipts without duplicate registrations or session metrics', async () => {
  const admin = await actor(), uid = await learner('a')
  await learning(uid, 'one')
  const original = db.ref.bind(db)
  let injected = false
  db.ref = path => {
    const ref = original(path)
    if (path?.includes('/daily/')) {
      const transaction = ref.transaction.bind(ref)
      ref.transaction = async (...args) => {
        const result = await transaction(...args)
        if (!injected) { injected = true; throw new Error('Lost acknowledgement') }
        return result
      }
    }
    return ref
  }
  try {
    for (let i = 0; i < 40 && !injected; i++) {
      await original('adminAnalyticsControl/nextRunAt').set(0)
      try { await run(4) } catch (error) { assert.ok(injected) }
    }
  } finally { db.ref = original }
  assert.ok(injected)
  await drain()
  const o = await overview(admin)
  assert.equal(o.completedLessons, 1); assert.equal(o.denominators.answered, 10)
  assert.equal(o.totalUsers, 2)
})

test('leases fence concurrent jobs, expired owners get a fresh isolated generation and cleanup preserves the active pointer', async () => {
  const admin = await actor(), uid = await learner('a')
  await learning(uid, 'one')
  await run(1)
  const oldPending = (await read('adminAnalyticsControl')).pending.generation
  await db.ref('adminAnalyticsControl').update({owner: 'crashed', leaseUntil: Date.now() + 90000, nextRunAt: 0})
  await run(1)
  assert.equal((await read('adminAnalyticsControl')).pending.generation, oldPending)
  await db.ref('adminAnalyticsControl/leaseUntil').set(1)
  await drain()
  const c = await read('adminAnalyticsControl')
  assert.notEqual(c.activeGeneration, oldPending)
  await db.ref(`adminAnalyticsGenerationMeta/${oldPending}/expiresAt`).set(1)
  await db.ref(`adminAnalyticsGenerationMeta/${c.activeGeneration}/expiresAt`).set(1)
  await db.ref('adminAnalyticsControl/nextRunAt').set(0)
  await run(1)
  assert.equal(await read(`adminAnalyticsGenerations/${oldPending}`), null)
  assert.ok(await read(`adminAnalyticsGenerationMeta/${c.activeGeneration}`))
  assert.equal((await overview(admin)).completedLessons, 1)
})

test('invalid sources retain the last complete generation; stale data and invalid range/granularity fail explicitly', async () => {
  const admin = await actor(), uid = await learner('a')
  await learning(uid, 'one')
  await drain()
  const first = await overview(admin)
  await db.ref(`practiceAttempts/${uid}/broken`).set({mode: 'practice', status: 'completed'})
  let failed = false
  for (let i = 0; i < 30 && !failed; i++) {
    await db.ref('adminAnalyticsControl/nextRunAt').set(0)
    try { await run(4) } catch (error) { assert.equal(error.details.reason, 'invalid-analytics-source'); failed = true }
  }
  assert.ok(failed); assert.equal((await overview(admin)).generation, first.generation)
  await assert.rejects(overview(admin, {granularity: 'hour'}), {code: 'invalid-argument'})
  await assert.rejects(overview(admin, {range: {from: '2020-01-01', to: day(Date.now())}}), {code: 'invalid-argument'})
  await db.ref(`adminAnalyticsGenerationMeta/${first.generation}/asOf`).set(Date.now() - 86400001)
  await assert.rejects(overview(admin), e => e.details.reason === 'overview-stale')
  const direct = await fetch(`http://127.0.0.1:19200/adminAnalyticsGenerations.json?ns=demo-englishbattle-admin-default-rtdb&auth=${admin.token}`)
  assert.equal(direct.status, 401)
})

test('real practice and battle engines reconcile to overview, including repeated settlement without changing wallet or rating', async () => {
  const admin = await actor(), opponent = await learner('opponent')
  const seed = JSON.parse(readFileSync(new URL('../../database/english-battle.seed.json', import.meta.url), 'utf8'))
  await db.ref().update(Object.fromEntries(['categories', 'topics', 'lessons', 'questions', 'questionVersions', 'questionAnswers',
    'quizTemplates', 'contentAssets', 'lessonQuestions', 'appConfig', 'achievements'].map(key => [key, seed[key]])))
  const {startAttempt} = require('./lib/be1/practice/startAttempt.js')
  const {submitAttemptAnswer} = require('./lib/be1/practice/submitAttemptAnswer.js')
  const {advanceAttempt} = require('./lib/be1/practice/advanceAttempt.js')
  const {getAttemptResult} = require('./lib/be1/practice/getAttemptResult.js')
  const {findQuickBattle} = require('./lib/be1/battle/matchmaking.js')
  const {transactBattle} = require('./lib/be1/battle/battleService.js')
  const {settleBattle} = require('./lib/be1/battle/battleSettlement.js')
  let result = await startAttempt.run(request(admin, {mode: 'PRACTICE', topicId: 'vocabulary_daily_life', requestId: randomUUID()}))
  const attemptId = result.attempt.id
  for (let i = 0; i < 10; i++) {
    const q = result.attempt.questions[i], answer = (await read(`questionAnswers/${q.id}/${q.version}`)).correctOptionId
    result = await submitAttemptAnswer.run(request(admin, {attemptId, questionId: q.id,
      optionId: i < 7 ? answer : q.options.find(o => o.id !== answer).id, requestId: randomUUID()}))
    if (i < 9) result = await advanceAttempt.run(request(admin, {attemptId, requestId: randomUUID(), expectedIndex: i}))
  }
  await getAttemptResult.run(request(admin, {attemptId}))
  assert.equal((await read(`practiceAttempts/${admin.uid}/${attemptId}`)).status, 'completed')
  await findQuickBattle(admin.uid, 'Admin QA', 'analytics_a', randomUUID())
  const ticket = await findQuickBattle(opponent, 'Opponent QA', 'analytics_b', randomUUID())
  const id = ticket.attemptId
  await transactBattle(id, {uid: admin.uid, sessionId: 'analytics_a', action: {type: 'resume'}})
  let current = (await transactBattle(id, {uid: opponent, sessionId: 'analytics_b', action: {type: 'resume'}})).match
  for (let i = 0; i < 10; i++) {
    const q = current.questions[i], correct = current.keys[q.id].correctOptionId
    await transactBattle(id, {uid: admin.uid, sessionId: 'analytics_a', action: {type: 'submit', questionId: q.id, optionId: correct, requestId: randomUUID()}})
    current = (await transactBattle(id, {uid: opponent, sessionId: 'analytics_b', action: {type: 'submit', questionId: q.id,
      optionId: q.options.find(o => o.id !== correct).id, requestId: randomUUID()}})).match
  }
  await settleBattle(id, true); await settleBattle(id, true)
  const paths = ['wallets', 'userStats', 'userSettlements', 'coinLedger', 'ratingLedger']
  const balances = await Promise.all(paths.map(read))
  await drain()
  const o = await overview(admin, {range: {from: day(base), to: day(base)}})
  assert.equal(o.completedLessons, 1); assert.equal(o.completedBattles, 1); assert.equal(o.activeUsers, 2)
  assert.deepEqual(o.denominators, {answered: 30, correct: 17, started: 2, completed: 2})
  assert.equal(o.completion, 100)
  assert.equal(o.categories.reduce((n, c) => n + c.answered, 0), 30)
  assert.deepEqual(await Promise.all(paths.map(read)), balances)
})
