import assert from 'node:assert/strict'
import {test, beforeEach, after} from 'node:test'
import {createRequire} from 'node:module'
import {randomUUID} from 'node:crypto'

assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-admin')
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19299')
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:19200')
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined)
const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const {adminAuth: auth, adminDb: db} = require('./lib/config/firebaseAdmin.js')
const {deleteApp} = require('firebase-admin/app')
const api = require('./lib/admin/callables.js')
const {provisionUserProfile} = require('./lib/be1/auth/userProvisioning.js')
const {setNotificationPreference} = require('./lib/be1/user/setNotificationPreference.js')
const {runCampaignMaintenance: maintain, deliverCampaign} = require('./lib/admin/campaigns.js')
const notices = require('./lib/be1/community/notifications.js')
const {validateAdminRequest} = require('./lib/admin/contracts.js')
assert.match(db.ref().toString(), /^http:\/\/127\.0\.0\.1:19200\//)
const read = async path => (await db.ref(path).get()).val()
const request = (actor, data) => ({data, auth: actor ? {uid: actor.uid, token: actor.decoded} : undefined,
  rawRequest: {headers: actor ? {authorization: `Bearer ${actor.token}`} : {}}})
const call = (action, actor, data = {}) => api[action].run(request(actor, data))
async function account(admin = false) {
  const email = `${randomUUID()}@example.test`, password = 'EmulatorOnly123!'
  const u = await auth.createUser({email, password, displayName: 'Campaign QA'})
  await auth.setCustomUserClaims(u.uid, {admin})
  await provisionUserProfile(u.uid)
  const response = await fetch('http://127.0.0.1:19299/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=qa', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password, returnSecureToken: true}),
  })
  assert.equal(response.status, 200)
  const {idToken: token} = await response.json()
  return {...u, token, decoded: await auth.verifyIdToken(token)}
}
const input = (users, kind = 'notification') => ({kind, audience: 'selected', title: 'Keep learning',
  body: 'A message from the admin.', destination: kind === 'coins' ? 'Wallet' : 'Practice',
  coinAmount: kind === 'coins' ? 10 : 0, recipientIds: users.map(u => u.uid)})
const create = async (actor, payload, requestId = randomUUID()) =>
  (await call('adminCreateCampaign', actor, {input: payload, reason: 'QA campaign', requestId})).campaign
const preference = (user, enabled) => setNotificationPreference.run(request(user, {enabled, accountUid: user.uid}))
async function drain(id) {
  for (let n = 0; n < 20; n++) {
    await db.ref(`adminCampaigns/${id}/nextRunAt`).set(Date.now())
    await maintain()
    const campaign = await read(`adminCampaigns/${id}`)
    if (['completed', 'failed'].includes(campaign.status)) return campaign
  }
  assert.fail('Campaign did not finish')
}
beforeEach(async () => { await db.ref().set(null) })
after(async () => { await deleteApp(db.app) })

test('campaign APIs reject unauthenticated and non-admin callers; validate coin and recipient bounds', async () => {
  const user = await account()
  for (const actor of [null, user]) for (const name of ['adminListCampaigns', 'adminCreateCampaign']) {
    await assert.rejects(call(name, actor, {}), {code: actor ? 'permission-denied' : 'unauthenticated'})
  }
  for (const change of [{coinAmount: 1.5}, {coinAmount: 0}, {coinAmount: 1000001}, {recipientIds: []},
    {recipientIds: [user.uid, user.uid]}, {audience: 'all'}, {destination: 'Practice'}]) {
    assert.throws(() => validateAdminRequest('adminCreateCampaign', {requestId: 'qa', reason: 'QA',
      input: {...input([user], 'coins'), ...change}}), {code: 'invalid-argument'})
  }
  assert.equal(await read('adminCampaigns'), null)
})

test('notification enters the Android inbox only for accounts that opted in; counts and read state survive replay', async () => {
  const admin = await account(true), on = await account(), off = await account(), unset = await account()
  await preference(on, true); await preference(off, false)
  const campaign = await create(admin, input([on, off, unset]))
  const result = await drain(campaign.id)
  assert.equal(result.status, 'completed'); assert.equal(result.delivered, 1); assert.equal(result.skipped, 2)
  assert.equal(await read(`notifications/${off.uid}/admin_${campaign.id}`), null)
  assert.equal(await read(`notifications/${unset.uid}/admin_${campaign.id}`), null)
  const id = `admin_${campaign.id}`
  assert.equal((await read(`notifications/${on.uid}/${id}`)).targetType, 'Practice')
  assert.equal((await read(`notificationCounts/${on.uid}`)).unreadCount, 1)
  await notices.readNotification(on.uid, id); await notices.drainNotificationReads(on.uid)
  await deliverCampaign(await read(`adminCampaigns/${campaign.id}`), on.uid)
  assert.equal((await read(`notificationCounts/${on.uid}`)).unreadCount, 0)
})

test('coin gifts credit opted-out wallets as well, and same-request retry cannot duplicate coins, ledger or audit', async () => {
  const admin = await account(true), on = await account(), off = await account()
  await preference(on, true); await preference(off, false)
  await db.ref(`wallets/${off.uid}/coinBalance`).set(7)
  const payload = input([on, off], 'coins'), requestId = randomUUID()
  const campaign = await create(admin, payload, requestId)
  assert.deepEqual(await create(admin, payload, requestId), campaign)
  const result = await drain(campaign.id)
  assert.equal(result.delivered, 2); assert.equal(result.notified, 1)
  for (const [user, expected] of [[on, 10], [off, 17]]) {
    assert.equal(await read(`wallets/${user.uid}/coinBalance`), expected)
    assert.equal(await read(`userSettlements/${user.uid}/coinBalance`), expected)
    assert.equal(Object.keys(await read(`coinLedger/${user.uid}`)).length, 1)
  }
  assert.equal(await read(`notifications/${off.uid}/admin_${campaign.id}`), null)
  assert.equal(Object.keys(await read('adminAudit')).length, 1)
  await assert.rejects(create(admin, {...payload, coinAmount: 20}, requestId), {code: 'already-exists'})
})

test('all-account delivery crosses worker batches, excludes blocked/new accounts, and respects opt-out', async () => {
  const admin = await account(true), users = []
  for (let n = 0; n < 12; n++) { const user = await account(); await preference(user, true); users.push(user) }
  await db.ref(`accountAccess/${users[0].uid}/status`).set('banned')
  await preference(users[1], false)
  const campaign = await create(admin, {...input([]), audience: 'all'})
  await new Promise(resolve => setTimeout(resolve, 20))
  const late = await account(); await preference(late, true)
  const result = await drain(campaign.id)
  assert.equal(result.status, 'completed'); assert.equal(result.notified, 10)
  assert.equal(await read(`notifications/${late.uid}/admin_${campaign.id}`), null)
  assert.equal(await read(`notifications/${users[0].uid}/admin_${campaign.id}`), null)
  assert.equal((await call('adminListCampaigns', admin)).items[0].id, campaign.id)
})

test('worker recovery after a partial gift preserves one grant and one notification', async () => {
  const admin = await account(true), user = await account(); await preference(user, true)
  const campaign = await create(admin, input([user], 'coins'))
  const original = notices.publishSubscribedNotification
  notices.publishSubscribedNotification = async () => { throw new Error('Injected interruption') }
  try { await maintain() } finally { notices.publishSubscribedNotification = original }
  assert.equal((await read(`adminCampaigns/${campaign.id}`)).status, 'retrying')
  assert.equal(await read(`wallets/${user.uid}/coinBalance`), 10)
  const result = await drain(campaign.id)
  assert.equal(result.delivered, 1); assert.equal(result.notified, 1)
  assert.equal(await read(`wallets/${user.uid}/coinBalance`), 10)
  assert.equal(Object.keys(await read(`coinLedger/${user.uid}`)).length, 1)
  assert.equal((await read(`notificationCounts/${user.uid}`)).unreadCount, 1)
})

test('concurrent coin campaigns share the canonical wallet without lost or duplicate credit', async () => {
  const admin = await account(true), user = await account()
  const first = await create(admin, input([user], 'coins'))
  const second = await create(admin, {...input([user], 'coins'), coinAmount: 25})
  const campaigns = await Promise.all([read(`adminCampaigns/${first.id}`), read(`adminCampaigns/${second.id}`)])
  await Promise.all([...campaigns, ...campaigns].map(c => deliverCampaign(c, user.uid)))
  assert.equal(await read(`wallets/${user.uid}/coinBalance`), 35)
  assert.equal(await read(`userSettlements/${user.uid}/coinBalance`), 35)
  assert.equal(Object.keys(await read(`coinLedger/${user.uid}`)).length, 2)
})

test('revoking the sender admin role stops queued campaigns before further deliveries', async () => {
  const admin = await account(true), user = await account()
  const campaign = await create(admin, input([user], 'coins'))
  await auth.setCustomUserClaims(admin.uid, {admin: false})
  const result = await drain(campaign.id)
  assert.equal(result.status, 'failed'); assert.equal(result.delivered, 0)
  assert.equal(await read(`coinLedger/${user.uid}`), null)
})

test('server opt-out suppresses subsequent inbox insertion and clients cannot choose another account', async () => {
  const user = await account(), other = await account()
  await preference(user, true); await preference(user, false)
  assert.equal(await notices.publishSubscribedNotification(user.uid, 'late', {title: 'Late', body: 'Body',
    targetType: 'Practice', createdAt: Date.now(), readAt: 0}), false)
  assert.equal(await read(`notifications/${user.uid}/late`), null)
  await assert.rejects(setNotificationPreference.run(request(user, {enabled: true, uid: other.uid})), {code: 'invalid-argument'})
  await assert.rejects(setNotificationPreference.run(request(user, {enabled: true, accountUid: other.uid})), {code: 'invalid-argument'})
  await assert.rejects(setNotificationPreference.run(request(null, {enabled: true})), {code: 'unauthenticated'})
})
