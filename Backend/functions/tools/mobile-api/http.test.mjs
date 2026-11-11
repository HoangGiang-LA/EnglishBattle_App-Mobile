import {test} from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {createMobileApi, mobileHandlers, mobileMethods, HttpsError} from './http.mjs'
import {validateMobileEnvironment} from './environment.mjs'

async function fixture(t, options = {}) {
  const seen = []
  const server = createMobileApi({
    handlers: {learningAttempt: async request => {
      seen.push(request)
      return {serverNow: 123, uid: request.auth.uid, payload: request.data}
    }},
    verifyToken: async (token, revoked) => {
      assert.equal(token, 'valid-token')
      assert.equal(revoked, true)
      return {uid: 'verified-user', auth_time: 1}
    },
    logError: () => {}, ...options,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body = {data: {}}, {path = '/api/learningAttempt', headers = {}, ...rest} = {}) => fetch(base + path, {
    method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer valid-token', ...headers},
    body: JSON.stringify(body), ...rest,
  })
  return {base, post, seen}
}

test('health is readable without authentication and business calls require a token', async t => {
  const {base, post, seen} = await fixture(t)
  assert.deepEqual(await (await fetch(base + '/health')).json(), {status: 'ok', service: 'englishbattle-api'})
  const result = await post({data: {}}, {headers: {Authorization: ''}})
  assert.equal(result.status, 401)
  assert.equal((await result.json()).error.status, 'UNAUTHENTICATED')
  assert.equal(seen.length, 0)
})

test('verified identity is passed to business logic; body fields cannot choose a user', async t => {
  const {post, seen} = await fixture(t)
  const response = await post({data: {uid: 'attacker-chosen', action: 'resumeAttempt'}})
  assert.equal(response.status, 200)
  assert.equal((await response.json()).result.uid, 'verified-user')
  assert.equal(seen[0].auth.token.uid, 'verified-user')
  assert.equal(seen[0].data.uid, 'attacker-chosen')
  assert.equal(seen[0].acceptsStreaming, false)
})

test('invalid, revoked and disabled tokens never reach a handler', async t => {
  for (const code of ['auth/argument-error', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled']) {
    const {post, seen} = await fixture(t, {verifyToken: async () => { throw Object.assign(new Error(), {code}) }})
    const response = await post()
    assert.equal(response.status, code === 'auth/user-disabled' ? 403 : 401)
    assert.equal(seen.length, 0)
  }
})

test('only declared mobile methods can be dispatched', async t => {
  const {post, seen} = await fixture(t)
  for (const path of ['/api/adminGetProfile', '/api/maintainBattles', '/api/toString', '/api/__proto__',
    '/api/learningAttempt/extra', '/api/learningAttempt?uid=other']) {
    assert.equal((await post({data: {}}, {path})).status, 404)
  }
  assert.equal(seen.length, 0)
  const exports = Object.fromEntries(mobileMethods.map(name => [name, {run: request => request.data}]))
  exports.adminGetProfile = {run: () => { throw new Error('must not run') }}
  const handlers = mobileHandlers(exports)
  assert.equal(Object.hasOwn(handlers, 'adminGetProfile'), false)
  assert.deepEqual(handlers.learningAttempt({data: {hello: 'world'}}), {hello: 'world'})
  assert.throws(() => mobileHandlers({}), /Missing mobile handler/)
})

test('temporary Firebase verification failures do not expire the client session', async t => {
  const {post, seen} = await fixture(t, {verifyToken: async () => {
    throw Object.assign(new Error(), {code: 'auth/internal-error'})
  }})
  const response = await post()
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.status, 'UNAVAILABLE')
  assert.equal(seen.length, 0)
})

test('rejects malformed envelopes, content types and browser-origin requests', async t => {
  const {post, seen} = await fixture(t)
  for (const body of [null, [], {}, {data: {}, auth: {uid: 'injected'}}, {data: {}, extra: 1}]) {
    assert.equal((await post(body)).status, 400)
  }
  assert.equal((await post({data: {}}, {body: '{'})).status, 400)
  assert.equal((await post({data: {}}, {headers: {'Content-Type': 'text/plain'}})).status, 400)
  assert.equal((await post({data: {}}, {headers: {Origin: 'https://unknown.example'}})).status, 403)
  assert.equal(seen.length, 0)
})

test('large request bodies are rejected before authentication or business writes', async t => {
  const {post, seen} = await fixture(t)
  assert.equal((await post({data: 'x'.repeat(70_000)})).status, 400)
  assert.equal(seen.length, 0)
})

test('known errors preserve SDK error status and details; internal failures stay private', async t => {
  const {post} = await fixture(t, {handlers: {learningAttempt: async request => {
    if (request.data.known) throw new HttpsError('failed-precondition', 'Not ready.', {reason: 'no-content'})
    throw new Error('private server path and secret')
  }}})
  const known = await post({data: {known: true}})
  assert.equal(known.status, 400)
  assert.deepEqual((await known.json()).error, {status: 'FAILED_PRECONDITION', message: 'Not ready.', details: {reason: 'no-content'}})
  const unknown = await post()
  assert.equal(unknown.status, 500)
  assert.equal((await unknown.text()).includes('private server'), false)
})

test('App Check is verified when supplied', async t => {
  const {post, seen} = await fixture(t, {verifyAppCheck: async token => {
    if (token !== 'valid-app') throw new Error('invalid')
    return {app_id: 'android-app'}
  }})
  assert.equal((await post({data: {}}, {headers: {'X-Firebase-AppCheck': 'invalid-app'}})).status, 401)
  assert.equal(seen.length, 0)
  assert.equal((await post({data: {}}, {headers: {'X-Firebase-AppCheck': 'valid-app'}})).status, 200)
  assert.equal(seen[0].app.appId, 'android-app')
})

test('concurrent requests are bounded without releasing unfinished mutations on timeout', async t => {
  let entered
  let finish
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { finish = resolve })
  const {post} = await fixture(t, {maxConcurrent: 1, timeoutMs: 40,
    handlers: {learningAttempt: async () => { entered(); await pending; return {ok: true} }}})
  t.after(() => finish())
  const first = post()
  await started
  assert.equal((await post()).status, 429)
  assert.equal((await first).status, 504)
  assert.equal((await post()).status, 429)
  finish()
})

test('production startup refuses emulator settings and incorrect project configuration', () => {
  const env = {FIREBASE_PROJECT_ID: 'englishbattleapp-8d764',
    FIREBASE_DATABASE_URL: 'https://englishbattleapp-8d764-default-rtdb.asia-southeast1.firebasedatabase.app'}
  for (const name of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST',
    'FIRESTORE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'FUNCTIONS_EMULATOR']) {
    assert.throws(() => validateMobileEnvironment({...env, [name]: 'true'}), /cannot run/)
  }
  assert.throws(() => validateMobileEnvironment({...env, FIREBASE_PROJECT_ID: 'other-project'}), /Check FIREBASE_PROJECT_ID/)
  assert.throws(() => validateMobileEnvironment(env), /GOOGLE_APPLICATION_CREDENTIALS/)
})
