import assert from 'node:assert/strict'
import {test, beforeEach, after} from 'node:test'
import {createRequire} from 'node:module'
import {randomUUID} from 'node:crypto'
import {user, question, battle} from './fixtures.mjs'

assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-admin')
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19299')
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:19200')
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined)
const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const {adminAuth: auth, adminDb: db} = require('./lib/config/firebaseAdmin.js')
const {deleteApp} = require('firebase-admin/app')
const api = require('./lib/admin/callables.js')
const {provisionUserProfile} = require('./lib/be1/auth/userProvisioning.js')
const {runAdminNotificationMaintenance: maintain, publishAdminNotice} = require('./lib/admin/notificationWorker.js')
const {writeAdminAudit} = require('./lib/admin/audit.js')
const {runAdminMaintenance} = require('./lib/admin/maintenance.js')
const {adminCsvText} = require('./lib/admin/reports.js')
assert.match(db.ref().toString(), /^http:\/\/127\.0\.0\.1:19200\//)
const read = async path => (await db.ref(path).get()).val()
const day = at => new Date(at + 7 * 3600000).toISOString().slice(0, 10)
const range = () => ({from: day(Date.now() - 86400000), to: day(Date.now())})
const request = (actor, data) => ({data, auth: actor ? {uid: actor.uid, token: actor.decoded} : undefined,
  rawRequest: {headers: actor ? {authorization: `Bearer ${actor.token}`} : {}}})
const call = (action, actor, data = {}) => api[action].run(request(actor, data))
async function account(admin = true) {
  const email = `${randomUUID()}@example.test`, password = 'EmulatorOnly123!'
  const u = await auth.createUser({email, password, displayName: 'Workspace QA'})
  await auth.setCustomUserClaims(u.uid, {admin})
  await provisionUserProfile(u.uid)
  const response = await fetch('http://127.0.0.1:19299/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=qa', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password, returnSecureToken: true}),
  })
  assert.equal(response.status, 200)
  const {idToken: token} = await response.json()
  return {...u, token, decoded: await auth.verifyIdToken(token)}
}
async function indexes(count = 63) {
  const users = Object.fromEntries(Array.from({length: count}, (_, i) => [`user_${i}`, {
    ...user, id: `user_${i}`, code: `EB-user_${i}`, email: `learner-${i}@example.test`,
    name: `Learner ${i}`, createdAt: Date.now() - i * 1000, searchKey: `user_${i} learner ${i} learner-${i}@example.test`,
  }]))
  await db.ref().update({adminUserIndex: users, adminUserIndexMeta: {ready: true, version: 1, privacyRevision: 0},
    adminQuestionIndex: {question_1: {...question, prompt: 'Secret-free search example', searchKey: 'question_1 secret-free search example',
      privateField: 'TEST_ONLY_SECRET_ANSWER'}}, adminQuestionIndexMeta: {ready: true, version: 1},
    adminBattleIndex: {battle_1: {...battle, startedAt: Date.now(), searchKey: 'battle_1 b-1'}},
    'adminMonitoringControl/battles': {ready: true, sequence: 1, asOf: Date.now()},
    'adminMonitoringControl/activities': {ready: true, asOf: Date.now()}})
}
async function notices(count = 63) {
  await db.ref('adminMonitoringControl/activities').set({ready: true, asOf: Date.now()})
  await db.ref('adminActivityIndex').set(Object.fromEntries(Array.from({length: count}, (_, i) => [`act_${i}`, {
    id: `act_${i}`, type: 'user', sourceId: `user_${i}`, userId: `user_${i}`, at: Date.now() - 1000,
  }])))
  await drain()
}
async function drain() {
  for (let i = 0; i < 100; i++) {
    await db.ref('adminNotificationControl/nextRunAt').set(0)
    await maintain()
    const c = await read('adminNotificationControl')
    if (c.ready && !c.phase) return
  }
  assert.fail('Notification discovery did not finish')
}
const list = async (a, query = {}) => (await call('adminListNotifications', a, {query})).page
const exportReport = async (a, kind = 'users', query = {}, requestId = randomUUID()) =>
  (await call('adminExportReport', a, {kind, query, requestId, range: range()})).report
const receive = async (a, id) => (await call('adminExportReport', a, {reportId: id})).report
beforeEach(async () => {
  assert.equal((await fetch('http://127.0.0.1:19299/emulator/v1/projects/demo-englishbattle-admin/accounts', {method: 'DELETE'})).status, 200)
  await db.ref().set({})
})
after(async () => deleteApp(db.app))

test('search finds indexed users, questions and matches with safe routes and no answer or credential fields', async () => {
  const admin = await account()
  await indexes()
  const target = await account(false)
  await db.ref(`adminUserIndex/${target.uid}`).set({...user, id: target.uid, name: 'Nguyễn Minh', email: target.email,
    searchKey: `${target.uid} nguyen minh ${target.email}`, privateKey: 'TEST_ONLY_SECRET_KEY'})
  const found = (await call('adminSearch', admin, {q: 'Nguyễn'})).items
  assert.equal(found.length, 1); assert.equal(found[0].query, target.uid); assert.equal(found[0].page, 'users')
  assert.equal((await call('adminSearch', admin, {q: target.email})).items[0].query, target.uid)
  const q = (await call('adminSearch', admin, {q: 'secret-free'})).items
  assert.equal(q[0].page, 'content'); assert.equal(q[0].query, 'question_1')
  assert.equal((await call('adminSearch', admin, {q: 'battle_1'})).items[0].page, 'battles')
  assert.doesNotMatch(JSON.stringify([found, q]), /TEST_ONLY_SECRET|correctOptionId|privateKey|password/)
})

test('search caps results at twenty, excludes deleted identities immediately and reports unready indexes', async () => {
  const admin = await account()
  await indexes(63)
  const target = await account(false)
  await db.ref(`adminUserIndex/${target.uid}`).set({...user, id: target.uid, searchKey: 'deleted-name'})
  await db.ref(`accountAccess/${target.uid}`).set({status: 'deleted'})
  assert.deepEqual((await call('adminSearch', admin, {q: 'deleted-name'})).items, [])
  // Synthetic users in this cap fixture have real Auth identities for live result privacy checks.
  for (let i = 0; i < 23; i++) await auth.createUser({uid: `user_${i}`, displayName: `Learner ${i}`})
  assert.equal((await call('adminSearch', admin, {q: 'learner'})).items.length, 20)
  await db.ref('adminQuestionIndexMeta/ready').set(false)
  await assert.rejects(call('adminSearch', admin, {q: 'question'}), e => e.details.reason === 'search-not-ready')
  for (const q of ['', ' ', 'x', 'x'.repeat(101)]) await assert.rejects(call('adminSearch', admin, {q}), {code: 'invalid-argument'})
})

test('two admins have independent read states, exact pagination beyond fifty and owner-bound snapshots', async () => {
  const a = await account(), b = await account()
  await notices(63)
  const first = await list(a)
  assert.equal(first.total, 63); assert.equal(first.unreadTotal, 63); assert.equal(first.items.length, 10)
  const second = await list(a, {page: 2, pageSize: 10, snapshotId: first.snapshotId, cursor: first.nextCursor})
  assert.equal(new Set([...first.items, ...second.items].map(n => n.id)).size, 20)
  await assert.rejects(list(b, {snapshotId: first.snapshotId}), e => e.details.reason === 'snapshot-expired')
  const id = first.items[0].id
  await call('adminMarkNotificationsRead', a, {id, requestId: randomUUID()})
  assert.equal((await list(a)).unreadTotal, 62); assert.equal((await list(b)).unreadTotal, 63)
  await assert.rejects(list(a, {page: 2, snapshotId: first.snapshotId}), e => e.details.reason === 'snapshot-expired')
  await assert.rejects(call('adminMarkNotificationsRead', a, {id, uid: b.uid, requestId: randomUUID()}), {code: 'invalid-argument'})
})

test('mark-all uses a stable publication cutoff; late business events stay unread and rebuild never resets reads', async () => {
  const a = await account(), b = await account()
  await notices(4)
  const first = await list(a), requestId = randomUUID(), payload = {throughAt: first.asOf, requestId}
  await call('adminMarkNotificationsRead', a, payload)
  await call('adminMarkNotificationsRead', a, payload)
  assert.equal((await list(a)).unreadTotal, 0); assert.equal((await list(b)).unreadTotal, 4)
  await new Promise(resolve => setTimeout(resolve, 5))
  await publishAdminNotice({id: 'notice_late', title: 'Late learning result', body: 'A recovered outcome.',
    at: Date.now() - 10000, page: 'analytics'})
  await drain()
  const next = await list(a)
  assert.equal(next.unreadTotal, 1); assert.equal(next.items.find(n => n.id === 'notice_late').read, false)
  assert.equal(Object.values(await read('adminAudit')).filter(e => e.action === 'adminMarkNotificationsRead').length, 1)
})

test('notification projections deduplicate one battle across two participants and recover an expired lease', async () => {
  const a = await account()
  await db.ref('adminMonitoringControl/activities').set({ready: true})
  await db.ref('adminActivityIndex').set({a: {type: 'battle', sourceId: 'room_one', userId: 'a', at: Date.now() - 1000},
    b: {type: 'battle', sourceId: 'room_one', userId: 'b', at: Date.now() - 1000}})
  await db.ref('adminNotificationControl').set({owner: 'crashed', phase: 'audit', leaseUntil: 1, nextRunAt: 0})
  await drain()
  assert.equal((await list(a)).total, 1)
  await drain()
  assert.equal((await list(a)).total, 1)
})

test('a lost read-state acknowledgement retries once without extra audit, read revisions or source effects', async () => {
  const a = await account()
  await notices(1)
  const id = (await list(a)).items[0].id, requestId = randomUUID(), original = db.ref.bind(db)
  let injected = false
  db.ref = path => {
    const ref = original(path)
    if (path === `adminNotificationInboxes/${a.uid}`) {
      const transact = ref.transaction.bind(ref)
      ref.transaction = async (...args) => {
        const result = await transact(...args)
        if (!injected) { injected = true; throw new Error('lost acknowledgement') }
        return result
      }
    }
    return ref
  }
  try { await assert.rejects(call('adminMarkNotificationsRead', a, {id, requestId}), {code: 'aborted'}) }
  finally { db.ref = original }
  const before = await read(`adminNotificationInboxes/${a.uid}`)
  await call('adminMarkNotificationsRead', a, {id, requestId})
  assert.equal((await read(`adminNotificationInboxes/${a.uid}`)).revision, before.revision)
  assert.equal((await list(a)).unreadTotal, 0)
  assert.equal(Object.keys(await read('adminAudit')).length, 1)
})

test('audit pages, filters and inclusive local days remain exact with equal timestamps and sensitive raw extras', async () => {
  const a = await account(), b = await account(), now = Date.now() - 1000
  const entries = Object.fromEntries(Array.from({length: 63}, (_, i) => [`audit_${i}`, {
    id: `audit_${i}`, operationId: `audit_${i}`, actor: i % 2 ? b.uid : a.uid, action: 'adminSaveUser',
    target: `user/user_${i}`, reason: i ? 'Support case' : 'password=TEST_ONLY_SECRET', at: now,
    result: i % 2 ? 'failed' : 'succeeded', expiresAt: Date.now() + 100000, token: 'TEST_ONLY_SECRET_TOKEN',
  }]))
  await db.ref('adminAudit').set(entries)
  const first = (await call('adminListAudit', a, {query: {range: range()}})).page
  assert.equal(first.total, 63); assert.equal(first.items.length, 10)
  const second = (await call('adminListAudit', a, {query: {range: range(), snapshotId: first.snapshotId, page: 2}})).page
  assert.equal(new Set([...first.items, ...second.items].map(e => e.id)).size, 20)
  const filtered = (await call('adminListAudit', a, {query: {actor: a.uid, result: 'succeeded', action: 'adminSaveUser'}})).page
  assert.equal(filtered.total, 32)
  assert.doesNotMatch(JSON.stringify(first), /TEST_ONLY_SECRET|"token"/)
  await assert.rejects(call('adminListAudit', b, {query: {range: range(), snapshotId: first.snapshotId}}),
    e => e.details.reason === 'snapshot-expired')
  const today = day(Date.now()), end = Date.parse(`${today}T23:59:59.999+07:00`)
  await db.ref('adminAudit/audit_boundary').set({...entries.audit_1, id: 'audit_boundary', at: end})
  // Queries do not include future records; use the complete preceding Vietnamese day.
  const previous = day(Date.now() - 86400000), finish = Date.parse(`${previous}T23:59:59.999+07:00`)
  await db.ref('adminAudit/audit_last').set({...entries.audit_1, id: 'audit_last', at: finish})
  assert.equal((await call('adminListAudit', a, {query: {range: {from: previous, to: previous}}})).page.total, 1)
})

test('real admin operation audit creates a genuine notice, while read operations never create new unread notifications', async () => {
  const a = await account()
  await db.ref('adminMonitoringControl/activities').set({ready: true})
  await call('adminUpdateProfile', a, {requestId: randomUUID(), name: 'Updated workspace QA', expectedRevision: 0})
  await drain()
  const first = await list(a)
  assert.equal(first.total, 1); assert.match(first.items[0].body, /adminUpdateProfile/)
  await call('adminMarkNotificationsRead', a, {requestId: randomUUID(), throughAt: first.asOf})
  await drain()
  assert.equal((await list(a)).total, 1); assert.equal((await list(a)).unreadTotal, 0)
})

test('user exports contain all filtered rows beyond the current page and escape formulas without credentials', async () => {
  const a = await account(), b = await account()
  await indexes(63)
  await db.ref('adminUserIndex/user_0').update({name: '\t =HYPERLINK("test")', searchKey: 'user_0 learner formula'})
  const meta = await exportReport(a)
  assert.equal(meta.total, 63); assert.equal(meta.rows, undefined)
  const report = await receive(a, meta.id)
  assert.equal(report.rows.length, 63); assert.match(report.rows[0][2], /^'/)
  const csv = adminCsvText(report.columns, report.rows)
  assert.ok(Buffer.from(csv).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
  assert.match(csv, /HYPERLINK\(""test""\)/)
  assert.doesNotMatch(JSON.stringify(report), /correctOptionId|password|TEST_ONLY_SECRET/)
  await assert.rejects(receive(b, meta.id), e => e.details.reason === 'report-expired')
  const op = await read(`adminOperations/${meta.id}`)
  assert.doesNotMatch(op.responseJson, /learner-0@example|HYPERLINK/)
  assert.doesNotMatch(JSON.stringify(op.steps), /learner-0@example|HYPERLINK/)
  const filtered = await exportReport(a, 'users', {q: 'learner 1', status: 'active'})
  const shown = (await call('adminListUsers', a, {query: {q: 'learner 1', status: 'active', pageSize: 10}})).page
  assert.equal(shown.items.length, 10); assert.equal(shown.total, 11)
  assert.equal((await receive(a, filtered.id)).total, shown.total)
})

test('question and battle exports apply the page filters and never include secret answers or live selections', async () => {
  const a = await account()
  await indexes(1)
  const q = await receive(a, (await exportReport(a, 'questions', {q: 'secret-free', status: 'published', categoryId: 'vocabulary'})).id)
  assert.equal(q.total, 1); assert.equal(q.rows[0][1], 'Secret-free search example')
  assert.doesNotMatch(JSON.stringify(q), /TEST_ONLY_SECRET|correctOptionId|selectedOption|explanation/)
  const b = await receive(a, (await exportReport(a, 'battles', {mode: 'quick', status: 'completed'})).id)
  assert.equal(b.total, 1); assert.equal(b.rows[0][0], 'B-1')
  await assert.rejects(exportReport(a, 'battles', {mode: 'daily'}), {code: 'unimplemented'})
})

test('analytics export pins the displayed generation, granularity and skill and preserves unknown rates', async () => {
  const a = await account(), date = day(Date.now()), metric = {lessons: 1, battles: 1, answered: 20, correct: 13,
    started: 2, completed: 2, active: {[a.uid]: true}}
  const meta = {ready: true, asOf: Date.now() - 1000, expiresAt: Date.now() + 100000, totalUsers: 2,
    unknownStartSessions: 0, latestUnknownStartEnd: 0}
  await db.ref().update({'adminAnalyticsControl/activeGeneration': 'new',
    'adminAnalyticsGenerationMeta/old': meta, 'adminAnalyticsGenerationMeta/new': {...meta, totalUsers: 999},
    [`adminAnalyticsGenerations/old/daily/${date}`]: {metric, skills: {vocabulary: metric}, registrations: 2, registeredTotal: 2}})
  const report = await receive(a, (await exportReport(a, 'analytics', {generation: 'old', granularity: 'month', categoryId: 'vocabulary'})).id)
  assert.equal(report.rows.find(r => r[3] === 'totalUsers')[4], 2)
  assert.equal(report.rows.find(r => r[0] === 'KPI' && r[3] === 'accuracy')[4], 65)
  assert.equal(report.rows.find(r => r[0] === 'Series')[1], `${date.slice(0, 7)}-01`)
  assert.equal(report.asOf, meta.asOf)
})

test('report creation lost acknowledgements recover the original artifact once', async () => {
  const a = await account()
  await indexes(2)
  const original = db.ref.bind(db), requestId = randomUUID()
  let artifactId, fail = true
  db.ref = path => {
    const ref = original(path)
    if (path?.startsWith('adminReports/') && fail) {
      const transact = ref.transaction.bind(ref)
      ref.transaction = async (...args) => {
        const result = await transact(...args); artifactId = path.split('/')[1]
        throw new Error('lost acknowledgement')
      }
    }
    return ref
  }
  try { await assert.rejects(exportReport(a, 'users', {}, requestId), {code: 'aborted'}) }
  finally { db.ref = original; fail = false }
  const before = await read(`adminReports/${artifactId}`)
  await db.ref('adminUserIndex/user_0/name').set('Changed after capture')
  const retried = await exportReport(a, 'users', {}, requestId)
  assert.equal(retried.id, artifactId); assert.deepEqual(await read(`adminReports/${artifactId}`), before)
  assert.equal((await receive(a, artifactId)).rows[0][2], 'Learner 0')
  assert.equal(Object.keys(await read('adminAudit')).length, 1)
})

test('concurrent duplicate report and read requests create one artifact, read revision and audit per operation', async () => {
  const a = await account()
  await indexes(2); await notices(2)
  const requestId = randomUUID()
  const responses = await Promise.allSettled(Array.from({length: 3}, () => exportReport(a, 'users', {}, requestId)))
  assert.ok(responses.some(r => r.status === 'fulfilled'))
  const report = await exportReport(a, 'users', {}, requestId)
  assert.equal(Object.keys(await read('adminReports')).length, 1)
  const id = (await list(a)).items[0].id, readId = randomUUID()
  await Promise.allSettled(Array.from({length: 3}, () => call('adminMarkNotificationsRead', a, {id, requestId: readId})))
  await call('adminMarkNotificationsRead', a, {id, requestId: readId})
  assert.equal((await read(`adminNotificationInboxes/${a.uid}`)).revision, 1)
  assert.equal(Object.keys(await read('adminAudit')).length, 2)
  assert.ok(await receive(a, report.id))
})

test('export audit failure after capture is repaired without another artifact or secret-bearing operation input', async () => {
  const a = await account()
  await indexes(2)
  const original = db.ref.bind(db), requestId = randomUUID()
  db.ref = path => {
    const ref = original(path)
    if (path?.startsWith('adminAudit/')) ref.transaction = async () => { throw new Error('TEST_ONLY_SECRET_AUDIT_FAILURE') }
    return ref
  }
  try { await assert.rejects(exportReport(a, 'users', {}, requestId), {code: 'unavailable'}) }
  finally { db.ref = original }
  assert.equal(Object.keys(await read('adminReports')).length, 1)
  assert.equal(await read('adminAudit'), null)
  await exportReport(a, 'users', {}, requestId)
  assert.equal(Object.keys(await read('adminReports')).length, 1)
  assert.equal(Object.keys(await read('adminAudit')).length, 1)
  const pastedToken = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.'
  await call('adminUpdateProfile', a, {name: 'Safe QA', expectedRevision: 0, requestId: randomUUID(), reason: pastedToken})
  assert.ok(!JSON.stringify(await read('adminAudit')).includes(pastedToken))
  assert.ok(!JSON.stringify(await read('adminOperations')).includes(pastedToken))
})

test('report delivery rechecks live access and privacy; expired artifacts cannot be replayed from operation JSON', async () => {
  const a = await account(), requestId = randomUUID()
  await indexes(2)
  const meta = await exportReport(a, 'users', {}, requestId)
  await auth.setCustomUserClaims(a.uid, {})
  await assert.rejects(receive(a, meta.id), {code: 'permission-denied'})
  await auth.setCustomUserClaims(a.uid, {admin: true})
  await db.ref('adminUserIndexMeta/privacyRevision').set(1)
  await assert.rejects(receive(a, meta.id), e => e.details.reason === 'report-privacy-changed')
  await db.ref(`adminReports/${meta.id}`).update({expiresAt: 1, 'report/expiresAt': 1})
  await assert.rejects(exportReport(a, 'users', {}, requestId), e => e.details.reason === 'report-expired')
  await runAdminMaintenance()
  assert.equal(await read(`adminReports/${meta.id}`), null)
})

test('oversized reports fail explicitly before artifact publication instead of silently truncating rows or bytes', async () => {
  const a = await account()
  await indexes(5001)
  await assert.rejects(exportReport(a), e => e.code === 'resource-exhausted' && e.details.reason === 'report-too-large')
  assert.equal(await read('adminReports'), null)
  await db.ref('adminQuestionIndex').set(Object.fromEntries(Array.from({length: 120}, (_, i) => [`question_${i}`, {
    ...question, id: `question_${i}`, prompt: 'x'.repeat(10000), searchKey: `question_${i}`,
  }])))
  await assert.rejects(exportReport(a, 'questions'), e => e.code === 'resource-exhausted' && e.details.reason === 'report-too-large')
  assert.equal(await read('adminReports'), null)
})

test('default-deny Rules protect search email indexes, per-admin read state, event projections and report artifacts', async () => {
  const a = await account()
  for (const path of ['adminNotificationEvents', `adminNotificationInboxes/${a.uid}`, 'adminAuditMeta', 'adminReports', 'adminUserIndex']) {
    const url = `http://127.0.0.1:19200/${path}.json?ns=demo-englishbattle-admin-default-rtdb&auth=${a.token}`
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, {method: 'PUT', body: JSON.stringify({forged: true})})).status, 401)
  }
})

test('a stalled source hits the report deadline and a late response cannot publish an artifact after failure', async () => {
  const a = await account(), original = db.ref.bind(db)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  db.ref = path => {
    const ref = original(path)
    if (path === 'adminAnalyticsControl') {
      const get = ref.get.bind(ref)
      ref.get = async () => {await blocked; return get()}
    }
    return ref
  }
  try {
    await assert.rejects(exportReport(a, 'analytics'), e => e.code === 'resource-exhausted' && e.details.reason === 'report-timeout')
    assert.equal(await read('adminReports'), null)
  } finally {db.ref = original; release()}
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await read('adminReports'), null)
})
