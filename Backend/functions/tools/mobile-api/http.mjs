import {createServer} from 'node:http'
import {createRequire} from 'node:module'

// Business handlers compile to CommonJS. Use the same SDK entry point so
// HttpsError identity is preserved across the HTTP/business boundary.
const require = createRequire(import.meta.url)
export const {HttpsError} = require('firebase-functions/v2/https')

// Only the authenticated Android surface is published. In particular, never
// dispatch arbitrary exports, administrator endpoints or maintenance jobs.
export const mobileMethods = Object.freeze([
  'ensureUserProfile', 'getUserDashboard', 'markNotificationsRead', 'setNotificationPreference',
  'getLeaderboard', 'getNotifications', 'getStudyStatistics', 'getHistory',
  'getCoinLedger', 'learningAttempt', 'startAttempt', 'resumeAttempt',
  'submitAttemptAnswer', 'advanceAttempt', 'saveAttemptSelection',
  'getAttemptResult', 'leaveAttempt', 'findBattle', 'getBattleTicket',
  'cancelBattleSearch',
])

export function mobileHandlers(exports) {
  return Object.fromEntries(mobileMethods.map(name => {
    if (typeof exports[name]?.run !== 'function') throw new Error(`Missing mobile handler: ${name}`)
    return [name, request => exports[name].run(request)]
  }))
}

export function createMobileApi({handlers, verifyToken, verifyAppCheck,
  logError = console.error, maxConcurrent = 64, timeoutMs = 120_000}) {
  let active = 0
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    let timer
    let admitted = false
    function fail(error) {
      if (response.writableEnded || response.destroyed) return
      const known = error instanceof HttpsError
      if (!known) logError('Mobile API failed:', error?.code || error?.name || 'Error')
      const safe = known ? error : new HttpsError('internal', 'The request could not be completed.')
      response.writeHead(safe.httpErrorCode.status).end(JSON.stringify({error: safe.toJSON()}))
    }
    try {
      if (request.headers.origin) throw new HttpsError('permission-denied', 'Browser origins are not enabled on this API.')
      if (request.method === 'GET' && request.url === '/health') {
        response.end(JSON.stringify({status: 'ok', service: 'englishbattle-api'}))
        return
      }
      const match = /^\/api\/([A-Za-z][A-Za-z0-9]*)$/.exec(request.url || '')
      if (request.method !== 'POST' || !match || !Object.hasOwn(handlers, match[1])) {
        throw new HttpsError('not-found', 'Endpoint not found.')
      }
      if (active >= maxConcurrent) throw new HttpsError('resource-exhausted', 'The server is busy. Try again shortly.')
      active++
      admitted = true
      timer = setTimeout(() => fail(new HttpsError('deadline-exceeded', 'The server did not respond in time.')), timeoutMs)
      timer.unref()
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        throw new HttpsError('invalid-argument', 'Expected application/json.')
      }
      const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization || '')
      if (!bearer) throw new HttpsError('unauthenticated', 'Sign in first.')
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 65_536) throw new HttpsError('invalid-argument', 'Request is too large.')
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        throw new HttpsError('invalid-argument', 'Invalid JSON.')
      }
      if (!body || Array.isArray(body) || typeof body !== 'object' ||
          Object.keys(body).length !== 1 || !Object.hasOwn(body, 'data')) {
        throw new HttpsError('invalid-argument', 'Expected only a data field.')
      }
      let decoded
      try {
        // checkRevoked=true also checks disabled users. Never derive identity
        // from JSON, forwarded headers or an unverified JWT payload.
        decoded = await verifyToken(bearer[1], true)
      } catch (error) {
        if (error?.code === 'auth/user-disabled') throw new HttpsError('permission-denied', 'Account is disabled.')
        if (['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-expired',
          'auth/id-token-revoked', 'auth/user-not-found'].includes(error?.code)) {
          throw new HttpsError('unauthenticated', 'Sign in again.')
        }
        if (typeof error?.code === 'string' && error.code.startsWith('auth/')) {
          throw new HttpsError('unavailable', 'Authentication is temporarily unavailable.')
        }
        throw error
      }
      if (!decoded?.uid) throw new HttpsError('unauthenticated', 'Sign in again.')
      let app
      if (request.headers['x-firebase-appcheck']) {
        try {
          if (!verifyAppCheck) throw new Error('App Check is unavailable.')
          const token = await verifyAppCheck(request.headers['x-firebase-appcheck'])
          app = {appId: token.app_id, token}
        } catch { throw new HttpsError('unauthenticated', 'Invalid App Check token.') }
      }
      if (response.writableEnded || response.destroyed) return
      const result = await handlers[match[1]]({
        data: body.data, auth: {uid: decoded.uid, token: decoded},
        app, rawRequest: request, acceptsStreaming: false,
      })
      // A timed-out mutation may still finish. Existing requestId/idempotency
      // logic owns its outcome; never cancel or repeat a database write here.
      if (!response.writableEnded && !response.destroyed) response.end(JSON.stringify({result}))
    } catch (error) { fail(error) } finally {
      clearTimeout(timer)
      if (admitted) active--
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxRequestsPerSocket = 1000
  return server
}
