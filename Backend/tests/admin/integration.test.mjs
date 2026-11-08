import assert from 'node:assert/strict'
import {test, before, beforeEach, after} from 'node:test'
import {createRequire} from 'node:module'
import {randomUUID, createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {requests} from './fixtures.mjs'

// Check every destination before loading Admin SDK or writing any fixture.
assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-admin')
assert.equal(process.env.FIREBASE_PROJECT_ID, 'demo-englishbattle-admin')
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19299')
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:19200')
assert.equal(process.env.FUNCTIONS_EMULATOR_HOST, '127.0.0.1:15003')
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined)
const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const {adminAuth: auth, adminDb: db} = require('./lib/config/firebaseAdmin.js')
const {deleteApp} = require('firebase-admin/app')
const callables = require('./lib/admin/callables.js')
const {adminActions} = require('./lib/admin/contracts.js')
const {requireAdmin} = require('./lib/admin/guard.js')
const {AdminOperations, adminOperationId} = require('./lib/admin/operations.js')
const {createAdminRuntime, consumeAdminRate} = require('./lib/admin/runtime.js')
const {runAdminMaintenance} = require('./lib/admin/maintenance.js')
const {ADMIN_POLICY: policy} = require('./lib/admin/policy.js')
assert.match(db.ref().toString(), /^http:\/\/127\.0\.0\.1:19200\//)
assert.equal(new URL(db.app.options.databaseURL).hostname.split('.')[0], 'demo-englishbattle-admin-default-rtdb')
const namespace = 'demo-englishbattle-admin-default-rtdb'
const read = async path => (await db.ref(path).get()).val()
const authApi = async (method, data) => {
  const response = await fetch(`http://127.0.0.1:19299/identitytoolkit.googleapis.com/v1/accounts:${method}?key=emulator-only`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
  })
  assert.equal(response.status, 200)
  return response.json()
}
async function account(claim = true) {
  const email = `admin-qa-${randomUUID()}@example.test`
  const password = 'EmulatorOnly123!'
  const user = await auth.createUser({email, password, displayName: 'Original name'})
  if (claim !== undefined) await auth.setCustomUserClaims(user.uid, {admin: claim})
  await db.ref().update({[`accountAccess/${user.uid}`]: {status: 'active'},
    [`users/${user.uid}`]: {displayName: 'Original name', revision: 0}})
  const session = await authApi('signInWithPassword', {email, password, returnSecureToken: true})
  const decoded = await auth.verifyIdToken(session.idToken)
  return {...user, password, token: session.idToken, decoded,
    actor: {uid: user.uid, authTime: decoded.auth_time * 1000}}
}
const request = (user, data) => ({data, auth: user ? {uid: user.uid, token: user.decoded} : undefined,
  rawRequest: {headers: user ? {authorization: `Bearer ${user.token}`} : {}}})
const invoke = (name, user, data = requests[name]) => callables[name].run(request(user, data))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const auditCount = async id => (await read(`adminAudit/${id}`)) ? 1 : 0
const hash = value => createHash('sha256').update(value).digest('hex')
const profileFor = async uid => {
  const user = await auth.getUser(uid)
  const profile = await read(`users/${uid}`)
  return {id: uid, name: profile.displayName, email: user.email, role: 'administrator', revision: profile.revision}
}
const profileHandler = (run, target) => ({version: 1,
  target: (data, id, actor) => target || `user/${actor.uid}`, run})
const execute = (runtime, user, data) => runtime.invoke('adminUpdateProfile', request(user, data))
const change = (extra = {}) => ({requestId: randomUUID(), name: 'Updated name', expectedRevision: 0, ...extra})
async function forceDue(id) {
  await db.ref(`adminOperations/${id}`).update({dueAt: Date.now() - 1, leaseUntil: null, owner: null})
  await db.ref('adminMaintenance/cleanup').remove()
}
before(async () => {
  await db.ref().set({}) // dedicated demo namespace only
  const rules = readFileSync(new URL('../../../database.rules.json', import.meta.url), 'utf8')
  const response = await fetch(`http://127.0.0.1:19200/.settings/rules.json?ns=${namespace}`, {
    method: 'PUT', headers: {Authorization: 'Bearer owner', 'Content-Type': 'application/json'}, body: rules,
  })
  assert.equal(response.status, 200)
})
after(async () => { await deleteApp(db.app) })
beforeEach(async () => {
  await db.ref().update(Object.fromEntries(['adminOperations', 'adminAudit', 'adminResourceLocks',
    'adminRateLimits', 'adminMaintenance', 'adminSnapshots', 'adminReports', 'adminUserState',
    'adminUserIndex', 'adminUserIndexMeta', 'adminUserIndexControl', 'adminInvitations',
    'adminRoleOperations', 'adminMembership'].map(path => [path, null])))
})

test('all 21 implemented callables reject anonymous/ordinary users before business effects', async () => {
  const regular = await account(false)
  const admin = await account()
  assert.deepEqual(Object.keys(callables).sort(), [...adminActions].sort())
  for (const name of adminActions) {
    await assert.rejects(invoke(name, undefined), {code: 'unauthenticated'}, name)
    await assert.rejects(invoke(name, regular), {code: 'permission-denied'}, name)
  }
  assert.ok((await invoke('adminGetProfile', admin)).profile.id)
  assert.equal(await read('adminOperations'), null)
  assert.equal(await read('adminAudit'), null)
})
test('guards reject stale/string claims, disabled, banned, deleted, missing access and deleted Auth users', async () => {
  for (const claim of [false, 'true', 1]) {
    const user = await account(claim)
    for (const name of adminActions) await assert.rejects(invoke(name, user), {code: 'permission-denied'}, `${claim} ${name}`)
  }
  const stale = await account()
  await auth.setCustomUserClaims(stale.uid, {})
  for (const name of adminActions) await assert.rejects(invoke(name, stale), {code: 'permission-denied'}, name)
  for (const status of ['banned', 'deleted', 'missing', 'disabled']) {
    const user = await account()
    if (status === 'disabled') await auth.updateUser(user.uid, {disabled: true})
    else await db.ref(`accountAccess/${user.uid}`).set(status === 'missing' ? null : {status})
    for (const name of adminActions) {
      await assert.rejects(invoke(name, user), {code: 'permission-denied'}, `${status} ${name}`)
    }
  }
  const removed = await account()
  await auth.deleteUser(removed.uid)
  for (const name of adminActions) await assert.rejects(invoke(name, removed), {code: 'unauthenticated'}, name)
})
test('revocation is checked against live Auth; forged callable identity or absent bearer token cannot pass', async () => {
  const user = await account()
  await wait(1100) // Auth revocation timestamps have second precision.
  await auth.revokeRefreshTokens(user.uid)
  for (const name of adminActions) await assert.rejects(invoke(name, user), {code: 'unauthenticated'}, name)
  const valid = await account()
  const forged = request(valid, {})
  forged.auth.uid = 'another-user'
  await assert.rejects(requireAdmin(forged, auth, db), {code: 'permission-denied'})
  await assert.rejects(requireAdmin({...request(valid, {}), rawRequest: {headers: {}}}, auth, db), {code: 'unauthenticated'})
})
test('real callable HTTP transport checks read/write/export requests without leaking stack or secrets', async () => {
  const user = await account()
  await require('./lib/admin/userIndex.js').runUserIndexMaintenance()
  for (const name of ['adminGetProfile', 'adminSaveUser', 'adminExportReport']) {
    const url = `http://127.0.0.1:15003/demo-englishbattle-admin/asia-southeast1/${name}`
    for (const signedIn of [false, true]) {
      const response = await fetch(url, {method: 'POST', signal: AbortSignal.timeout(45000),
        headers: {'Content-Type': 'application/json', ...(signedIn ? {Authorization: `Bearer ${user.token}`} : {})},
        body: JSON.stringify({data: requests[name]}),
      })
      assert.equal(response.status, signedIn ? 200 : 401)
      const body = await response.json()
      if (!response.ok) assert.equal(body.error.status, signedIn ? 'UNIMPLEMENTED' : 'UNAUTHENTICATED')
      assert.ok(!JSON.stringify(body).includes(user.token))
      assert.ok(!body.error || !('stack' in body.error))
    }
  }
})
test('self ban/delete and invalid requests are rejected before a business handler can execute', async () => {
  const user = await account()
  for (const status of ['banned', 'deleted']) {
    await assert.rejects(invoke('adminSetUserStatus', user, {requestId: randomUUID(), id: user.uid,
      status, reason: 'Test protection', expectedRevision: 0}), {code: 'failed-precondition'})
  }
  await assert.rejects(invoke('adminGetProfile', user, {admin: true}), {code: 'invalid-argument'})
})
test('concurrent duplicate calls perform one record change, preserve stable response and create one audit entry', async () => {
  const user = await account()
  let calls = 0
  const runtime = createAdminRuntime(auth, db, {}, {adminUpdateProfile: profileHandler(async (ctx, data) => {
    calls++
    await ctx.mutateRecord('profile', `users/${ctx.actor.uid}`, data.expectedRevision,
      current => ({...current, displayName: data.name, changes: (current.changes || 0) + 1}))
    return {profile: await profileFor(ctx.actor.uid)}
  })})
  const data = change()
  const results = await Promise.allSettled(Array.from({length: 6}, () => execute(runtime, user, data)))
  assert.ok(results.some(r => r.status === 'fulfilled'))
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'aborted')
  const retry = await execute(runtime, user, data)
  assert.equal(calls, 1)
  assert.deepEqual(await execute(runtime, user, data), retry)
  const profile = await read(`users/${user.uid}`)
  assert.equal(profile.revision, 1)
  assert.equal(profile.changes, 1)
  assert.equal(Object.keys(profile._adminApplied).length, 1)
  const id = adminOperationId(user.uid, 'adminUpdateProfile', data.requestId)
  assert.equal(await auditCount(id), 1)
  assert.equal((await read(`adminAudit/${id}`)).actor, user.uid)
  assert.equal((await read(`adminAudit/${id}`)).result, 'succeeded')
  await assert.rejects(execute(runtime, user, {...data, name: 'Different payload'}), error =>
    error.code === 'already-exists' && error.details.reason === 'request-id-conflict')
})
test('a saved Auth checkpoint survives RTDB failure; worker completes the same operation without repeating Auth', async () => {
  const user = await account()
  let authCalls = 0
  let failOnce = true
  const runtime = createAdminRuntime(auth, db, {}, {adminUpdateProfile: profileHandler(async (ctx, data) => {
    await ctx.externalStep('auth', async () => { authCalls++; await auth.updateUser(ctx.actor.uid, {displayName: data.name}) })
    if (failOnce) { failOnce = false; throw new Error('Injected password=secret token=secret interruption') }
    await ctx.mutateRecord('profile', `users/${ctx.actor.uid}`, data.expectedRevision,
      current => ({...current, displayName: data.name}))
    return {profile: await profileFor(ctx.actor.uid)}
  })})
  const data = change({reason: 'password=never-log-this'})
  await assert.rejects(execute(runtime, user, data), {code: 'aborted'})
  const id = adminOperationId(user.uid, 'adminUpdateProfile', data.requestId)
  assert.equal((await auth.getUser(user.uid)).displayName, data.name)
  assert.equal((await read(`users/${user.uid}`)).displayName, 'Original name')
  assert.equal((await read(`adminOperations/${id}`)).phase, 'pending')
  await forceDue(id)
  await runAdminMaintenance(db, runtime.operations)
  assert.equal((await read(`users/${user.uid}`)).displayName, data.name)
  assert.equal(authCalls, 1)
  assert.equal((await execute(runtime, user, data)).profile.revision, 1)
  const entry = await read(`adminAudit/${id}`)
  assert.equal(entry.reason, '[redacted sensitive reason]')
  assert.ok(!JSON.stringify(entry).includes('never-log-this'))
  assert.ok(!JSON.stringify(entry).includes('secret'))
  assert.ok(!JSON.stringify(await read('adminAudit')).includes(user.token))
})
test('a lost RTDB acknowledgement replays its durable receipt without applying a change twice', async () => {
  const user = await account()
  const runtime = createAdminRuntime(auth, db, {}, {adminUpdateProfile: profileHandler(async (ctx, data) => {
    await ctx.mutateRecord('profile', `users/${user.uid}`, data.expectedRevision,
      current => ({...current, displayName: data.name, changes: (current.changes || 0) + 1}))
    return {profile: await profileFor(user.uid)}
  })})
  const data = change()
  const original = db.ref
  let injected = false
  db.ref = function(path) {
    const ref = original.call(this, path)
    if (path === `users/${user.uid}`) {
      const transaction = ref.transaction
      ref.transaction = async function(...args) {
        const result = await transaction.apply(this, args)
        if (!injected) { injected = true; throw new Error('Lost acknowledgement after commit') }
        return result
      }
    }
    return ref
  }
  try { await assert.rejects(execute(runtime, user, data), {code: 'aborted'}) }
  finally { db.ref = original }
  assert.ok(injected)
  assert.equal((await execute(runtime, user, data)).profile.revision, 1)
  assert.equal((await read(`users/${user.uid}`)).changes, 1)
})
test('audit failure after commit is repaired from the terminal operation, with no repeated business write', async () => {
  const user = await account()
  let calls = 0
  const runtime = createAdminRuntime(auth, db, {}, {adminUpdateProfile: profileHandler(async (ctx, data) => {
    calls++
    await ctx.mutateRecord('profile', `users/${user.uid}`, 0, current => ({...current, displayName: data.name}))
    return {profile: await profileFor(user.uid)}
  })})
  const data = change()
  const id = adminOperationId(user.uid, 'adminUpdateProfile', data.requestId)
  const original = db.ref
  db.ref = function(path) {
    const ref = original.call(this, path)
    if (path === `adminAudit/${id}`) ref.transaction = async () => { throw new Error('private-key-secret') }
    return ref
  }
  try { await assert.rejects(execute(runtime, user, data), {code: 'unavailable'}) }
  finally { db.ref = original }
  assert.equal((await read(`adminOperations/${id}`)).phase, 'succeeded')
  assert.equal(await read(`adminAudit/${id}`), null)
  await forceDue(id)
  await runAdminMaintenance(db, runtime.operations)
  assert.equal(await auditCount(id), 1)
  assert.equal(calls, 1)
  assert.equal((await execute(runtime, user, data)).profile.revision, 1)
})
test('expired leases recover replay-safe work; unknown external outcomes stay blocked with their target lock', async () => {
  const user = await account()
  const data = change()
  let failOnce = true
  const handler = profileHandler(async (ctx, value) => {
    if (failOnce) { failOnce = false; throw new Error('Crash before first effect') }
    await ctx.mutateRecord('profile', `users/${user.uid}`, 0, c => ({...c, displayName: value.name}))
    return {profile: await profileFor(user.uid)}
  })
  const ops = new AdminOperations(auth, db, {adminUpdateProfile: handler})
  await assert.rejects(ops.execute('adminUpdateProfile', user.actor, data), {code: 'aborted'})
  const id = adminOperationId(user.uid, 'adminUpdateProfile', data.requestId)
  await db.ref(`adminOperations/${id}`).update({phase: 'running', owner: 'live-process', leaseUntil: Date.now() + 60000})
  await assert.rejects(ops.process(id), {code: 'aborted'})
  await db.ref(`adminOperations/${id}`).update({phase: 'running', owner: 'dead-process', leaseUntil: Date.now() - 1})
  assert.equal((await ops.process(id)).profile.revision, 1)

  const other = await account()
  let calls = 0
  const ambiguous = new AdminOperations(auth, db, {adminUpdateProfile: profileHandler(async (ctx, value) => {
    await ctx.externalStep('auth', async () => {
      calls++
      await auth.updateUser(other.uid, {displayName: value.name})
      throw new Error('Unknown external response')
    })
    return {profile: await profileFor(other.uid)}
  })})
  const uncertain = change()
  await assert.rejects(ambiguous.execute('adminUpdateProfile', other.actor, uncertain), {code: 'failed-precondition'})
  const uncertainId = adminOperationId(other.uid, 'adminUpdateProfile', uncertain.requestId)
  assert.equal((await read(`adminOperations/${uncertainId}`)).phase, 'blocked')
  assert.equal((await read(`adminResourceLocks/${hash(`user/${other.uid}`)}`)).operationId, uncertainId)
  await assert.rejects(ambiguous.process(uncertainId), {code: 'failed-precondition'})
  assert.equal(calls, 1)
  await assert.rejects(ambiguous.execute('adminUpdateProfile', other.actor, change()), {code: 'aborted'})
})
test('external steps reject returned Auth records or secret links without persisting their value', async () => {
  const user = await account()
  const sensitive = 'https://example.test/reset?token=must-not-be-stored'
  let calls = 0
  const ops = new AdminOperations(auth, db, {adminUpdateProfile: profileHandler(async ctx => {
    await ctx.externalStep('email', async () => { calls++; return sensitive })
    return {profile: await profileFor(user.uid)}
  })})
  const data = change()
  await assert.rejects(ops.execute('adminUpdateProfile', user.actor, data), {code: 'failed-precondition'})
  const id = adminOperationId(user.uid, 'adminUpdateProfile', data.requestId)
  const op = await read(`adminOperations/${id}`)
  assert.equal(op.phase, 'blocked')
  assert.ok(!JSON.stringify(op).includes(sensitive))
  assert.ok(!JSON.stringify(await read(`adminAudit/${id}`)).includes(sensitive))
  await assert.rejects(ops.execute('adminUpdateProfile', user.actor, data), {code: 'failed-precondition'})
  assert.equal(calls, 1)
})
test('two admins editing the same revision cannot silently overwrite each other', async () => {
  const first = await account()
  const second = await account()
  const target = `admin-test-records/${randomUUID()}`
  const handler = profileHandler(async (ctx, data) => {
    await ctx.mutateRecord('record', target, 0, c => ({...c, winner: ctx.actor.uid, changes: (c.changes || 0) + 1}))
    return {profile: {...await profileFor(ctx.actor.uid), name: data.name}}
  }, target)
  const ops = new AdminOperations(auth, db, {adminUpdateProfile: handler})
  const a = change()
  const b = change()
  const results = await Promise.allSettled([ops.execute('adminUpdateProfile', first.actor, a), ops.execute('adminUpdateProfile', second.actor, b)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const loser = results[0].status === 'rejected' ? [first, a] : [second, b]
  await assert.rejects(ops.execute('adminUpdateProfile', loser[0].actor, loser[1]), error =>
    error.code === 'failed-precondition' && error.details.reason === 'version-conflict')
  assert.equal((await read(target)).changes, 1)
  assert.equal((await read(target)).revision, 1)
})
test('recovery rechecks live actor access instead of continuing a revoked administrator operation', async () => {
  const user = await account()
  let called = 0
  const ops = new AdminOperations(auth, db, {adminUpdateProfile: profileHandler(async () => {
    called++
    throw new Error('Initial transient interruption')
  })})
  const data = change()
  await assert.rejects(ops.execute('adminUpdateProfile', user.actor, data), {code: 'aborted'})
  await auth.setCustomUserClaims(user.uid, {})
  const id = adminOperationId(user.uid, 'adminUpdateProfile', data.requestId)
  await forceDue(id)
  await runAdminMaintenance(db, ops)
  assert.equal(called, 1)
  assert.equal((await read(`adminOperations/${id}`)).phase, 'failed')
  assert.equal((await read(`users/${user.uid}`)).revision, 0)
})
test('distributed export rate budget permits exactly five calls including concurrent callers', async () => {
  const uid = `rate_${randomUUID()}`
  const results = await Promise.allSettled(Array.from({length: 8}, () => consumeAdminRate(db, uid, 'adminExportReport')))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, policy.exportsPerMinute)
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'resource-exhausted')
})
test('cleanup is bounded, expires server artifacts and preserves permanent requestId tombstones', async () => {
  const user = await account()
  const handler = profileHandler(async () => ({profile: await profileFor(user.uid)}))
  const ops = new AdminOperations(auth, db, {adminUpdateProfile: handler})
  const data = change()
  await ops.execute('adminUpdateProfile', user.actor, data)
  const id = adminOperationId(user.uid, 'adminUpdateProfile', data.requestId)
  await db.ref(`adminOperations/${id}/cleanupAt`).set(Date.now() - 1)
  await db.ref('adminMaintenance/cleanup').remove()
  await db.ref().update({
    'adminSnapshots/expired': {expiresAt: 1}, 'adminSnapshots/future': {expiresAt: Date.now() + 60000},
    'adminReports/expired': {expiresAt: 1}, 'adminRateLimits/expired': {expiresAt: 1},
    'adminAudit/expired': {expiresAt: 1},
  })
  await runAdminMaintenance(db, ops)
  assert.equal(await read('adminSnapshots/expired'), null)
  assert.ok(await read('adminSnapshots/future'))
  for (const path of ['adminReports/expired', 'adminRateLimits/expired', 'adminAudit/expired']) assert.equal(await read(path), null)
  await db.ref('adminSnapshots').update(Object.fromEntries(Array.from({length: 30}, (_, i) => [`batch_${i}`, {expiresAt: 1}])))
  await db.ref('adminMaintenance/cleanup').remove()
  await runAdminMaintenance(db, ops)
  assert.equal(Object.keys(await read('adminSnapshots')).length, 6) // five expired plus the valid snapshot
  const tombstone = await read(`adminOperations/${id}`)
  assert.equal(tombstone.compacted, true)
  assert.equal(tombstone.inputJson, undefined)
  assert.equal(tombstone.responseJson, undefined)
  assert.equal(tombstone.fingerprint.length, 64)
  await assert.rejects(ops.execute('adminUpdateProfile', user.actor, data), error =>
    error.code === 'failed-precondition' && error.details.reason === 'operation-result-expired')
  await assert.rejects(ops.execute('adminUpdateProfile', user.actor, {...data, name: 'different'}), {code: 'already-exists'})
})
test('deployed-source Rules keep client admin away from operation data, email indexes, answers, rating and coins', async () => {
  const admin = await account()
  const user = await account(false)
  const paths = ['adminOperations', 'adminAudit', 'adminResourceLocks', 'adminRateLimits',
    'adminSnapshots', 'adminReports', 'adminUserIndex', 'adminQuestionIndex', 'adminBattleIndex',
    'adminActivityIndex', 'adminNotifications', 'questionAnswers', 'questionVersions',
    'wallets', 'userStats', 'appConfig/server']
  for (const actor of [admin, user]) {
    for (const path of paths) {
      const url = `http://127.0.0.1:19200/${path}.json?ns=${namespace}&auth=${encodeURIComponent(actor.token)}`
      assert.equal((await fetch(url)).status, 401, path)
      assert.equal((await fetch(url, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: '{}'})).status, 401, path)
    }
  }
})
