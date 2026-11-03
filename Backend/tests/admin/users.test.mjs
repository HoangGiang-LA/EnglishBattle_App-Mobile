import assert from 'node:assert/strict'
import {test, beforeEach, after} from 'node:test'
import {createRequire} from 'node:module'
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-admin')
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19299')
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:19200')
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined)
const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const {adminAuth: auth, adminDb: db} = require('./lib/config/firebaseAdmin.js')
const {deleteApp} = require('firebase-admin/app')
const api = require('./lib/admin/callables.js')
const {provisionUserProfile} = require('./lib/be1/auth/userProvisioning.js')
const {adminOperationId} = require('./lib/admin/operations.js')
const {adminRuntime} = require('./lib/admin/service.js')
const {runAdminMaintenance} = require('./lib/admin/maintenance.js')
const {changeAdminRole} = require('./lib/admin/roles.js')
const {runUserIndexMaintenance, syncAdminUserIndex} = require('./lib/admin/userIndex.js')
const {runInvitationMaintenance} = require('./lib/admin/invitations.js')
const {startAttempt} = require('./lib/be1/practice/startAttempt.js')
const {getUserDashboard} = require('./lib/be1/user/getUserDashboard.js')
const {ensureUserProfile} = require('./lib/be1/auth/ensureUserProfile.js')
const {findBattle} = require('./lib/be1/battle/battleCallables.js')
const {resumeAttempt} = require('./lib/be1/practice/resumeAttempt.js')
const {getHistory} = require('./lib/be1/reporting/getHistory.js')
assert.match(db.ref().toString(), /^http:\/\/127\.0\.0\.1:19200\//)
assert.match(db.app.options.databaseURL, /demo-englishbattle-admin-default-rtdb/)
const seed = JSON.parse(readFileSync(new URL('../../database/english-battle.seed.json', import.meta.url), 'utf8'))
const read = async path => (await db.ref(path).get()).val()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const authRest = async (method, data) => {
  const response = await fetch(`http://127.0.0.1:19299/identitytoolkit.googleapis.com/v1/accounts:${method}?key=emulator-only`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
  })
  assert.equal(response.status, 200)
  return response.json()
}
const request = (u, data = {}) => ({data, auth: {uid: u.uid, token: u.decoded}, rawRequest: {headers: {authorization: `Bearer ${u.token}`}}})
const call = (name, u, data = {}) => api[name].run(request(u, data))
async function account(admin = false, name = 'Learner') {
  const email = `${randomUUID()}@example.test`
  const password = 'EmulatorOnly123!'
  const user = await auth.createUser({email, password, displayName: name})
  await auth.setCustomUserClaims(user.uid, {admin, preserveClaim: 'kept'})
  await provisionUserProfile(user.uid)
  const session = await authRest('signInWithPassword', {email, password, returnSecureToken: true})
  return {...user, token: session.idToken, decoded: await auth.verifyIdToken(session.idToken), password, sid: randomUUID()}
}
async function freshSession(u) {
  const signed = await authRest('signInWithPassword', {email: (await auth.getUser(u.uid)).email, password: u.password, returnSecureToken: true})
  return {...u, token: signed.idToken, decoded: await auth.verifyIdToken(signed.idToken)}
}
const createInput = () => ({requestId: randomUUID(), input: {name: 'Invited learner', email: `invited-${randomUUID()}@example.test`}})
const getUser = async (actor, uid) => (await call('adminGetUser', actor, {id: uid})).user
const statusInput = async (actor, target, status) => ({id: target.uid || target.id, status, reason: 'QA account action',
  requestId: randomUUID(), expectedRevision: (await getUser(actor, target.uid || target.id)).revision})
const roleInput = (uid, action) => ({uid, action, requestId: randomUUID(), reason: 'QA protected role change'})
async function readyIndex() {
  for (let i = 0; i < 20; i++) {
    await db.ref('adminUserIndexControl/nextRunAt').set(0)
    await runUserIndexMaintenance()
    if (!(await read('adminUserIndexControl/pageToken'))) return
  }
  assert.fail('Index bootstrap did not finish within the test bound')
}
beforeEach(async () => {
  const cleared = await fetch('http://127.0.0.1:19299/emulator/v1/projects/demo-englishbattle-admin/accounts', {method: 'DELETE'})
  assert.equal(cleared.status, 200)
  await db.ref().set(seed)
})
after(async () => deleteApp(db.app))

test('profile reads real Auth identity and saves name without changing role, balance or progress', async () => {
  const admin = await account(true, 'Admin original')
  await db.ref().update({[`wallets/${admin.uid}/coinBalance`]: 19, [`userStats/${admin.uid}/rating`]: 37,
    [`learningProgress/${admin.uid}/keep`]: {completed: 12}})
  const profile = (await call('adminGetProfile', admin)).profile
  assert.equal(profile.name, 'Admin original')
  assert.equal(profile.email, admin.email)
  const result = await call('adminUpdateProfile', admin, {name: 'Admin renamed', expectedRevision: profile.revision, requestId: randomUUID()})
  assert.equal(result.profile.name, 'Admin renamed')
  assert.equal(result.profile.revision, profile.revision + 1)
  assert.equal((await auth.getUser(admin.uid)).displayName, 'Admin renamed')
  assert.deepEqual((await auth.getUser(admin.uid)).customClaims, {admin: true, preserveClaim: 'kept'})
  assert.equal(await read(`wallets/${admin.uid}/coinBalance`), 19)
  assert.equal(await read(`userStats/${admin.uid}/rating`), 37)
  assert.equal(await read(`learningProgress/${admin.uid}/keep/completed`), 12)
  assert.equal((await call('adminGetProfile', admin)).profile.name, 'Admin renamed')
})
test('create uses a stable Auth UID, provisions complete defaults and duplicate concurrent calls create one account/audit/invitation', async () => {
  const admin = await account(true)
  const data = createInput()
  const results = await Promise.allSettled(Array.from({length: 5}, () => call('adminSaveUser', admin, data)))
  assert.ok(results.some(r => r.status === 'fulfilled'))
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'aborted')
  const first = await call('adminSaveUser', admin, data)
  assert.deepEqual(await call('adminSaveUser', admin, data), first)
  assert.equal(first.user.id, `admin_${first.operationId.slice(0, 40)}`)
  assert.equal(first.user.invitationStatus, 'pending')
  assert.equal((await auth.listUsers()).users.filter(u => u.email === data.input.email).length, 1)
  for (const root of ['users', 'userPrivate', 'userStats', 'wallets', 'userSettings', 'accountAccess']) assert.ok(await read(`${root}/${first.user.id}`), root)
  assert.equal(await read(`wallets/${first.user.id}/coinBalance`), 0)
  assert.equal((await auth.getUser(first.user.id)).customClaims?.admin, undefined)
  assert.equal(Object.keys(await read('adminAudit')).length, 1)
  await assert.rejects(call('adminSaveUser', admin, {...data, input: {...data.input, name: 'different'}}), error =>
    error.code === 'already-exists' && error.details.reason === 'request-id-conflict')
})
test('create recovers after Auth succeeded and default provisioning was interrupted without resetting wallet or stats', async () => {
  const admin = await account(true)
  const data = createInput()
  const op = adminOperationId(admin.uid, 'adminSaveUser', data.requestId)
  const uid = `admin_${op.slice(0, 40)}`
  const original = db.ref
  db.ref = function(path) {
    const ref = original.call(this, path)
    if (path === `wallets/${uid}`) ref.transaction = async () => { throw new Error('Injected default failure') }
    return ref
  }
  try { await assert.rejects(call('adminSaveUser', admin, data), {code: 'aborted'}) }
  finally { db.ref = original }
  assert.equal((await auth.getUser(uid)).email, data.input.email)
  assert.equal(await read(`accountAccess/${uid}/status`), 'provisioning')
  await db.ref().update({[`wallets/${uid}`]: {coinBalance: 9, updatedAt: 1}, [`userStats/${uid}/rating`]: 27})
  const user = (await call('adminSaveUser', admin, data)).user
  assert.equal(user.id, uid)
  assert.equal(user.coins, 9)
  assert.equal(user.rating, 27)
  assert.equal(await read(`accountAccess/${uid}/status`), 'active')
})
test('duplicate emails and forbidden privilege/balance fields fail without creating users', async () => {
  const admin = await account(true)
  const existing = await account()
  const data = createInput()
  await assert.rejects(call('adminSaveUser', admin, {...data, input: {...data.input, email: existing.email}}), error =>
    error.code === 'already-exists' && error.details.reason === 'email-already-exists')
  for (const field of ['admin', 'customClaims', 'coins', 'rating', 'password', 'status']) {
    await assert.rejects(call('adminSaveUser', admin, {...createInput(), input: {...data.input, [field]: 999}}), {code: 'invalid-argument'})
  }
  assert.equal((await auth.listUsers()).users.length, 2)
})
test('two admins editing a shared user revision accept one result and reject the stale edit', async () => {
  const a = await account(true)
  const b = await account(true)
  const target = await account()
  const revision = (await getUser(a, target.uid)).revision
  const first = {id: target.uid, expectedRevision: revision, requestId: randomUUID(), input: {name: 'First', email: target.email}}
  const second = {...first, requestId: randomUUID(), input: {...first.input, name: 'Second'}}
  const results = await Promise.allSettled([call('adminSaveUser', a, first), call('adminSaveUser', b, second)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const [actor, data] = results[0].status === 'rejected' ? [a, first] : [b, second]
  await assert.rejects(call('adminSaveUser', actor, data), error => error.code === 'failed-precondition' && error.details.reason === 'version-conflict')
  assert.equal((await getUser(a, target.uid)).revision, revision + 1)
})
test('email/name edit synchronizes Auth/private/public state, preserves claims and blocks stale sessions', async () => {
  const admin = await account(true)
  const user = await account()
  await wait(1100)
  const newEmail = `changed-${randomUUID()}@example.test`
  const data = {id: user.uid, expectedRevision: (await getUser(admin, user.uid)).revision, requestId: randomUUID(),
    input: {name: 'Changed', email: newEmail}}
  const result = await call('adminSaveUser', admin, data)
  assert.equal(result.user.email, newEmail)
  assert.equal((await auth.getUser(user.uid)).displayName, 'Changed')
  assert.equal(await read(`userPrivate/${user.uid}/email`), newEmail)
  assert.equal(await read(`users/${user.uid}/displayName`), 'Changed')
  assert.deepEqual((await auth.getUser(user.uid)).customClaims, {admin: false, preserveClaim: 'kept'})
  await assert.rejects(getUserDashboard.run(request(user)), {code: 'unauthenticated'})
})
test('index failure after identity commit retries the same operation without a second revision or audit', async () => {
  const admin = await account(true)
  const user = await account()
  const data = {id: user.uid, expectedRevision: 0, requestId: randomUUID(), input: {name: 'Committed before failure', email: user.email}}
  const original = db.ref
  db.ref = function(path) {
    const ref = original.call(this, path)
    if (path === `adminUserIndex/${user.uid}`) ref.transaction = async () => { throw new Error('Index unavailable') }
    return ref
  }
  try { await assert.rejects(call('adminSaveUser', admin, data), {code: 'aborted'}) }
  finally { db.ref = original }
  assert.equal((await auth.getUser(user.uid)).displayName, data.input.name)
  assert.equal((await call('adminSaveUser', admin, data)).user.revision, 1)
  assert.equal(Object.keys(await read('adminAudit')).length, 1)
  assert.equal(Object.keys((await read('adminUserIndexMeta')).writers || {}).length, 0)
})
test('a definitive Auth email race is compensated and reported as email conflict rather than a blocked partial write', async () => {
  const admin = await account(true)
  const user = await account()
  const original = auth.updateUser
  auth.updateUser = async () => { throw Object.assign(new Error('Duplicate email'), {code: 'auth/email-already-exists'}) }
  try {
    await assert.rejects(call('adminSaveUser', admin, {id: user.uid, expectedRevision: 0, requestId: randomUUID(),
      input: {name: 'Must not apply', email: `race-${randomUUID()}@example.test`}}), error =>
      error.code === 'already-exists' && error.details.reason === 'email-already-exists')
  } finally { auth.updateUser = original }
  assert.equal((await auth.getUser(user.uid)).displayName, 'Learner')
  assert.equal((await getUser(admin, user.uid)).email, user.email)
  assert.equal(await read(`adminUserState/${user.uid}/pendingOperation`), null)
  assert.equal((await getUser(admin, user.uid)).revision, 0)
  assert.equal((await call('adminSaveUser', admin, {id: user.uid, expectedRevision: 0, requestId: randomUUID(),
    input: {name: 'Corrected form', email: `corrected-${randomUUID()}@example.test`}})).user.name, 'Corrected form')
})
test('ban/unban synchronizes Auth and access; old tokens stay revoked after reopening', async () => {
  const admin = await account(true)
  const user = await account()
  await wait(1100)
  await call('adminSetUserStatus', admin, await statusInput(admin, user, 'banned'))
  assert.equal((await auth.getUser(user.uid)).disabled, true)
  assert.equal(await read(`accountAccess/${user.uid}/status`), 'banned')
  await assert.rejects(getUserDashboard.run(request(user)), {code: 'permission-denied'})
  await call('adminSetUserStatus', admin, await statusInput(admin, user, 'active'))
  assert.equal((await auth.getUser(user.uid)).disabled, false)
  await assert.rejects(getUserDashboard.run(request(user)), {code: 'unauthenticated'})
  const fresh = await freshSession(user)
  assert.ok((await getUserDashboard.run(request(fresh))).dashboard)
})
test('soft deletion anonymizes identity, preserves financial/result records and cannot be provisioned or reopened', async () => {
  const admin = await account(true)
  const user = await account()
  await db.ref().update({[`wallets/${user.uid}/coinBalance`]: 14, [`userStats/${user.uid}/rating`]: 33,
    [`rewardGrants/${user.uid}/old`]: {coinDelta: 14}, [`coinLedger/${user.uid}/old`]: {delta: 14},
    [`practiceAttempts/${user.uid}/old`]: {status: 'completed', mode: 'PRACTICE', questionCount: 10, correctCount: 8, finishedAt: 1}})
  const protectedPaths = ['wallets', 'userStats', 'rewardGrants', 'coinLedger', 'practiceAttempts']
  const before = await Promise.all(protectedPaths.map(p => read(`${p}/${user.uid}`)))
  await call('adminSetUserStatus', admin, await statusInput(admin, user, 'deleted'))
  const deleted = await getUser(admin, user.uid)
  assert.equal(deleted.email, '')
  assert.equal(deleted.name, 'Tài khoản đã xóa')
  assert.equal(deleted.status, 'deleted')
  assert.equal(await read(`userPrivate/${user.uid}/email`), '')
  assert.equal(await read(`leaderboardPlayers/${user.uid}`), null)
  assert.deepEqual(await Promise.all(protectedPaths.map(p => read(`${p}/${user.uid}`))), before)
  await assert.rejects(provisionUserProfile(user.uid), {code: 'permission-denied'})
  await assert.rejects(call('adminSetUserStatus', admin, await statusInput(admin, user, 'active')), error =>
    error.code === 'failed-precondition' && error.details.reason === 'account-deleted')
})
test('banning during study abandons the active attempt using existing settlement rules', async () => {
  const admin = await account(true)
  const user = await account()
  const {attempt} = await startAttempt.run(request(user, {mode: 'PRACTICE', topicId: 'vocabulary_daily_life', requestId: randomUUID()}))
  await call('adminSetUserStatus', admin, await statusInput(admin, user, 'banned'))
  assert.equal(await read(`practiceAttempts/${user.uid}/${attempt.id}/status`), 'abandoned')
  assert.equal(await read(`wallets/${user.uid}/coinBalance`), 0)
})
test('banning during a live battle forfeits once; deleting redacts opponent presentation without rewriting the frozen result', async () => {
  const admin = await account(true)
  const a = await account(false, 'Player A')
  const b = await account(false, 'Player B private name')
  await findBattle.run(request(a, {kind: 'quick', requestId: randomUUID(), clientSessionId: a.sid}))
  const match = await findBattle.run(request(b, {kind: 'quick', requestId: randomUUID(), clientSessionId: b.sid}))
  const id = match.ticket.attemptId
  assert.ok(id)
  await resumeAttempt.run(request(a, {attemptId: id, clientSessionId: a.sid}))
  await resumeAttempt.run(request(b, {attemptId: id, clientSessionId: b.sid}))
  await call('adminSetUserStatus', admin, await statusInput(admin, b, 'banned'))
  assert.equal(await read(`battleRooms/${id}/status`), 'completed')
  assert.equal(await read(`battleRooms/${id}/finish/reason`), 'account_unavailable')
  const result = await read(`battleResults/${id}`)
  await call('adminSetUserStatus', admin, await statusInput(admin, b, 'deleted'))
  assert.deepEqual(await read(`battleResults/${id}`), result)
  const history = await getHistory.run(request(a, {kind: 'battle'}))
  assert.equal(history.page.entries[0].opponentName, 'Tài khoản đã xóa')
})
test('the server role tool cannot revoke the last active admin; disabled/banned/string claims do not count', async () => {
  const a = await account(true)
  const b = await account(true)
  await auth.updateUser(b.uid, {disabled: true})
  await assert.rejects(changeAdminRole(auth, db, roleInput(a.uid, 'revoke')), error =>
    error.code === 'failed-precondition' && error.details.reason === 'last-active-admin')
  await auth.updateUser(b.uid, {disabled: false})
  await db.ref(`accountAccess/${b.uid}/status`).set('banned')
  await assert.rejects(changeAdminRole(auth, db, roleInput(a.uid, 'revoke')), {code: 'failed-precondition'})
  await db.ref(`accountAccess/${b.uid}/status`).set('active')
  await auth.setCustomUserClaims(b.uid, {admin: 'true'})
  await assert.rejects(changeAdminRole(auth, db, roleInput(a.uid, 'revoke')), {code: 'failed-precondition'})
  assert.equal((await auth.getUser(a.uid)).customClaims.admin, true)
  assert.equal(await read('adminMembership/lock'), null)
})
test('two concurrent server revocations share membership protection and retain one active admin', async () => {
  const a = await account(true)
  const b = await account(true)
  const first = roleInput(a.uid, 'revoke')
  const second = roleInput(b.uid, 'revoke')
  const results = await Promise.allSettled([changeAdminRole(auth, db, first), changeAdminRole(auth, db, second)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const loser = results[0].status === 'rejected' ? first : second
  await assert.rejects(changeAdminRole(auth, db, loser), error =>
    error.code === 'failed-precondition' && error.details.reason === 'last-active-admin')
  assert.equal((await auth.listUsers()).users.filter(u => !u.disabled && u.customClaims?.admin === true).length, 1)
})
test('status API racing with the server role tool cannot remove both administrators', async () => {
  const a = await account(true)
  const b = await account(true)
  const ban = await statusInput(a, b, 'banned')
  const revoke = roleInput(a.uid, 'revoke')
  const results = await Promise.allSettled([call('adminSetUserStatus', a, ban), changeAdminRole(auth, db, revoke)])
  assert.ok(results.some(r => r.status === 'fulfilled'))
  let active = 0
  for (const u of (await auth.listUsers()).users) if (!u.disabled && u.customClaims?.admin === true && await read(`accountAccess/${u.uid}/status`) === 'active') active++
  assert.ok(active >= 1)
})
test('actual server CLI uses the protected role path and preserves unrelated claims', async () => {
  const a = await account(true)
  const b = await account()
  const run = async args => {
    let output = ''
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['Backend/server/tools/admin-role.mjs', ...args], {
        env: {...process.env}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      for (const stream of [child.stdout, child.stderr]) stream.on('data', c => { output += c })
      child.once('error', reject); child.once('exit', resolve)
    })
    return {code, output}
  }
  const rejected = await run(['revoke', a.uid, '--request-id', randomUUID()])
  assert.equal(rejected.code, 1)
  assert.match(rejected.output, /last-active-admin/)
  const granted = await run(['grant', b.uid, '--request-id', randomUUID()])
  assert.equal(granted.code, 0)
  assert.deepEqual((await auth.getUser(b.uid)).customClaims, {admin: true, preserveClaim: 'kept'})
})
test('user index bootstraps more than 50 Auth users and freezes accurate filtered pages with owner/query/expiry binding', async () => {
  const admin = await account(true)
  const created = []
  for (let offset = 0; offset < 65; offset += 5) {
    created.push(...await Promise.all(Array.from({length: Math.min(5, 65 - offset)}, (_, i) => account(false, `Batch student ${offset + i}`))))
  }
  await assert.rejects(call('adminListUsers', admin, {query: {q: 'batch'}}), error => error.details.reason === 'user-index-not-ready')
  await readyIndex()
  const query = {q: 'batch', pageSize: 20, status: 'active'}
  const first = (await call('adminListUsers', admin, {query})).page
  assert.equal(first.total, 65)
  assert.equal(first.items.length, 20)
  const second = (await call('adminListUsers', admin, {query: {...query, page: 2, snapshotId: first.snapshotId, cursor: first.nextCursor}})).page
  assert.equal(second.total, 65)
  assert.equal(new Set([...first.items, ...second.items].map(u => u.id)).size, 40)
  const other = await account(true)
  await assert.rejects(call('adminListUsers', other, {query: {...query, page: 2, snapshotId: first.snapshotId}}), {code: 'failed-precondition'})
  await assert.rejects(call('adminListUsers', admin, {query: {...query, q: 'another', snapshotId: first.snapshotId}}), {code: 'failed-precondition'})
  await db.ref(`adminSnapshots/${first.snapshotId}/expiresAt`).set(1)
  await assert.rejects(call('adminListUsers', admin, {query: {...query, snapshotId: first.snapshotId}}), {code: 'failed-precondition'})
  assert.equal(created.length, 65)
})
test('search matches Vietnamese names/email/UID and deletion invalidates old snapshots', async () => {
  const admin = await account(true)
  const user = await account(false, 'Nguyễn Đặng')
  await readyIndex()
  const page = (await call('adminListUsers', admin, {query: {q: 'nguyen dang'}})).page
  assert.equal(page.total, 1)
  assert.equal(page.items[0].id, user.uid)
  for (const q of [user.email, user.uid]) assert.equal((await call('adminListUsers', admin, {query: {q}})).page.total, 1)
  await call('adminSetUserStatus', admin, await statusInput(admin, user, 'deleted'))
  await assert.rejects(call('adminListUsers', admin, {query: {q: 'nguyen dang', snapshotId: page.snapshotId}}), {code: 'failed-precondition'})
  assert.equal((await call('adminListUsers', admin, {query: {q: 'nguyen dang'}})).page.total, 0)
})
test('Firebase invitation creates a reset email action once and never stores its secret link/code in audit', async () => {
  const admin = await account(true)
  const created = (await call('adminSaveUser', admin, createInput())).user
  await runInvitationMaintenance()
  assert.equal((await getUser(admin, created.id)).invitationStatus, 'sent')
  await runInvitationMaintenance()
  const codes = await (await fetch('http://127.0.0.1:19299/emulator/v1/projects/demo-englishbattle-admin/oobCodes')).json()
  const matching = codes.oobCodes.filter(c => c.email === created.email)
  assert.equal(matching.length, 1)
  assert.equal(matching[0].requestType, 'PASSWORD_RESET')
  const privateRecords = JSON.stringify({audit: await read('adminAudit'), jobs: await read('adminInvitations'), ops: await read('adminOperations')})
  assert.ok(!privateRecords.includes(matching[0].oobCode))
})
test('failed/unknown invitation outcomes are visible, never recreate users and permit an explicit audited resend', async () => {
  const admin = await account(true)
  const created = (await call('adminSaveUser', admin, createInput())).user
  await runInvitationMaintenance(async () => 'failed')
  assert.equal((await getUser(admin, created.id)).invitationStatus, 'failed')
  const revision = (await getUser(admin, created.id)).revision
  await call('adminSaveUser', admin, {id: created.id, expectedRevision: revision, requestId: randomUUID(), resendInvitation: true,
    input: {name: created.name, email: created.email}})
  let calls = 0
  await runInvitationMaintenance(async () => { calls++; throw new Error('Timeout after possible send') })
  await runInvitationMaintenance(async () => { calls++; return 'sent' })
  assert.equal(calls, 1)
  assert.equal((await getUser(admin, created.id)).invitationStatus, 'unknown')
  assert.equal((await auth.listUsers()).users.length, 2)
  assert.equal(await read(`wallets/${created.id}/coinBalance`), 0)
})
test('a crashed invitation send becomes unknown and pending emails are not sent to old/deleted identities', async () => {
  const admin = await account(true)
  const created = (await call('adminSaveUser', admin, createInput())).user
  await db.ref(`adminInvitations/${created.id}`).update({status: 'sending', owner: 'dead-process', leaseUntil: 1, dueAt: 1})
  let calls = 0
  await runInvitationMaintenance(async () => { calls++; return 'sent' })
  assert.equal((await getUser(admin, created.id)).invitationStatus, 'unknown')
  const other = (await call('adminSaveUser', admin, createInput())).user
  await call('adminSaveUser', admin, {id: other.id, expectedRevision: other.revision, requestId: randomUUID(),
    input: {name: other.name, email: `different-${randomUUID()}@example.test`}})
  await runInvitationMaintenance(async () => { calls++; return 'sent' })
  assert.equal((await getUser(admin, other.id)).invitationStatus, 'failed')
  assert.equal(calls, 0)
})
test('provisioning cannot overwrite a pending admin identity or reset earned wallet/progress', async () => {
  const user = await account()
  await db.ref().update({[`adminUserState/${user.uid}/pendingOperation`]: 'in-flight-admin',
    [`wallets/${user.uid}/coinBalance`]: 21, [`learningProgress/${user.uid}/keep`]: {completed: 8}})
  await auth.updateUser(user.uid, {displayName: 'Pending Auth change'})
  await ensureUserProfile.run(request(user))
  assert.equal(await read(`users/${user.uid}/displayName`), 'Learner')
  assert.equal(await read(`wallets/${user.uid}/coinBalance`), 21)
  assert.equal(await read(`learningProgress/${user.uid}/keep/completed`), 8)
})
test('a pending account does not stall index bootstrap and is exposed as read-only with its operation reference', async () => {
  const admin = await account(true)
  const user = await account()
  await db.ref(`adminUserState/${user.uid}/pendingOperation`).set('pending-admin-operation')
  await auth.updateUser(user.uid, {displayName: 'Not committed yet'})
  await readyIndex()
  const record = await getUser(admin, user.uid)
  assert.equal(record.name, 'Learner')
  assert.equal(record.pendingOperation, 'pending-admin-operation')
  const page = (await call('adminListUsers', admin, {query: {q: user.email}})).page
  assert.equal(page.total, 1)
  assert.equal(page.items[0].pendingOperation, 'pending-admin-operation')
})
test('a crashed index writer is recovered with a full rebuild instead of blocking all future snapshots', async () => {
  const admin = await account(true)
  await account()
  await readyIndex()
  await db.ref('adminUserIndexMeta/writers/dead-worker').set({uid: admin.uid, startedAt: 1})
  await db.ref('adminUserIndexControl/nextRunAt').set(0)
  await runUserIndexMaintenance()
  assert.equal(await read('adminUserIndexMeta/writers/dead-worker'), null)
  assert.equal((await call('adminListUsers', admin, {query: {}})).page.total, 2)
})
test('soft-delete retry after an index interruption remains idempotent and does not reopen the account', async () => {
  const admin = await account(true)
  const user = await account()
  const data = await statusInput(admin, user, 'deleted')
  const original = db.ref
  db.ref = function(path) {
    const ref = original.call(this, path)
    if (path === `adminUserIndex/${user.uid}`) ref.transaction = async () => {throw new Error('Index interrupted')}
    return ref
  }
  try {await assert.rejects(call('adminSetUserStatus', admin, data), {code: 'aborted'})}
  finally {db.ref = original}
  await call('adminSetUserStatus', admin, data)
  assert.equal((await getUser(admin, user.uid)).status, 'deleted')
  assert.equal((await auth.getUser(user.uid)).disabled, true)
  assert.equal(Object.keys(await read('adminAudit')).length, 1)
})
test('delete restriction immediately hides snapshot identity even when the later Auth change is ambiguous', async () => {
  const admin = await account(true)
  const user = await account()
  await readyIndex()
  const query = {q: user.email}
  const first = (await call('adminListUsers', admin, {query})).page
  const data = await statusInput(admin, user, 'deleted')
  const original = auth.updateUser
  auth.updateUser = async () => {throw new Error('Unknown Auth outcome')}
  try {await assert.rejects(call('adminSetUserStatus', admin, data), error =>
    error.code === 'failed-precondition' && error.details.operationPhase === 'blocked')}
  finally {auth.updateUser = original}
  const record = await getUser(admin, user.uid)
  assert.equal(record.email, '')
  assert.equal(record.name, 'Tài khoản đã xóa')
  await assert.rejects(call('adminListUsers', admin, {query: {...query, snapshotId: first.snapshotId}}), {code: 'failed-precondition'})
  await assert.rejects(call('adminListUsers', admin, {query}), {code: 'failed-precondition'})
  await syncAdminUserIndex(user.uid)
  assert.equal((await call('adminListUsers', admin, {query})).page.total, 0)
})
test('a provisioning sync paused on its old identity cannot overwrite a newer committed admin edit', async () => {
  const admin = await account(true)
  const user = await account()
  const original = db.ref
  let release
  let entered
  const gate = new Promise(resolve => {release = resolve})
  const paused = new Promise(resolve => {entered = resolve})
  let writes = 0
  db.ref = function(path) {
    const ref = original.call(this, path)
    if (path === `users/${user.uid}`) {
      const transaction = ref.transaction
      ref.transaction = async function(...args) {
        writes++
        if (writes === 2) {entered(); await gate}
        return transaction.apply(this, args)
      }
    }
    return ref
  }
  const provisioning = provisionUserProfile(user.uid)
  try {
    await paused
    await call('adminSaveUser', admin, {id: user.uid, expectedRevision: 0, requestId: randomUUID(),
      input: {name: 'Admin won the race', email: user.email}})
    release()
    await provisioning
  } finally {release(); db.ref = original}
  assert.equal(await read(`users/${user.uid}/displayName`), 'Admin won the race')
  assert.equal((await getUser(admin, user.uid)).revision, 1)
})
test('completed role/invitation data is compacted while deduplication and explicit resend remain safe', async () => {
  const admin = await account(true)
  const other = await account()
  const input = roleInput(other.uid, 'grant')
  await changeAdminRole(auth, db, input)
  const roleId = Object.keys(await read('adminRoleOperations'))[0]
  const created = (await call('adminSaveUser', admin, createInput())).user
  await runInvitationMaintenance(async () => 'failed')
  await db.ref().update({[`adminRoleOperations/${roleId}/cleanupAt`]: 1, [`adminInvitations/${created.id}/cleanupAt`]: 1})
  await db.ref('adminMaintenance/cleanup').remove()
  await runAdminMaintenance(db, adminRuntime.operations)
  assert.equal((await read(`adminRoleOperations/${roleId}`)).compacted, true)
  assert.equal((await read(`adminRoleOperations/${roleId}`)).reason, undefined)
  assert.equal((await read(`adminInvitations/${created.id}`)).email, undefined)
  assert.equal((await read(`adminInvitations/${created.id}`)).status, 'failed')
  await changeAdminRole(auth, db, input)
  assert.equal((await auth.getUser(other.uid)).customClaims.admin, true)
  await assert.rejects(changeAdminRole(auth, db, {...input, reason: 'different'}), {code: 'already-exists'})
  await call('adminSaveUser', admin, {id: created.id, expectedRevision: created.revision, requestId: randomUUID(),
    resendInvitation: true, input: {name: created.name, email: created.email}})
  assert.equal((await read(`adminInvitations/${created.id}`)).status, 'pending')
})
test('the background worker never grants roles from a pending database intent', async () => {
  await account(true)
  const user = await account()
  await db.ref('adminRoleOperations/untrusted-role-intent').set({
    ...roleInput(user.uid, 'grant'), id: 'untrusted-role-intent', phase: 'pending', dueAt: 1, createdAt: 1,
  })
  await runAdminMaintenance(db, adminRuntime.operations)
  assert.equal((await auth.getUser(user.uid)).customClaims.admin, false)
  assert.equal((await read('adminRoleOperations/untrusted-role-intent')).phase, 'pending')
})
