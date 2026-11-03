import type { Page } from '@playwright/test'

// Intercept both Firebase and the local authorization endpoint; no real account is used.
export async function mockFirebase(page: Page, { admin = true, allowAdmin = true } = {}) {
  const uid = 'local-auth-test',
    email = 'sdk-test@example.test',
    password = 'not-a-real-password'
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: 'https://securetoken.google.com/englishbattleapp-8d764',
    aud: 'englishbattleapp-8d764',
    sub: uid,
    user_id: uid,
    email,
    admin,
    iat: now,
    exp: now + 3600,
    auth_time: now,
    firebase: { sign_in_provider: 'password', identities: { email: [email] } },
  })}.local-test-signature`
  let backendChecks = 0
  const callOrder: string[] = []
  await page.route('https://**/*', (route) => route.abort())
  await page.route('https://identitytoolkit.googleapis.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/accounts:signInWithPassword'))
      await route.fulfill({
        json: {
          localId: uid,
          email,
          displayName: 'SDK Test User',
          idToken: token,
          refreshToken: 'local-test-refresh',
          expiresIn: '3600',
          registered: true,
        },
      })
    else if (path.endsWith('/accounts:lookup'))
      await route.fulfill({
        json: {
          users: [
            {
              localId: uid,
              email,
              displayName: 'SDK Test User',
              emailVerified: false,
              providerUserInfo: [{ providerId: 'password', email, rawId: email }],
            },
          ],
        },
      })
    else await route.abort()
  })
  await page.route('http://127.0.0.1:8080/api/getAdminSession', async (route) => {
    const headers = {
      'Access-Control-Allow-Origin': route.request().headers().origin || new URL(page.url()).origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    }
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers })
      return
    }
    backendChecks++
    callOrder.push('getAdminSession')
    await route.fulfill(
      allowAdmin
        ? { headers, json: { result: { uid, role: 'admin', serverNow: Date.now() } } }
        : { headers, status: 403, json: { error: { status: 'PERMISSION_DENIED' } } },
    )
  })
  const profileEndpoints = new Set([
    'https://asia-southeast1-englishbattleapp-8d764.cloudfunctions.net/ensureUserProfile',
    'http://127.0.0.1:5001/englishbattleapp-8d764/asia-southeast1/ensureUserProfile',
  ])
  await page.route(
    (url) => profileEndpoints.has(`${url.origin}${url.pathname}`),
    async (route) => {
      const headers = {
        'Access-Control-Allow-Origin':
          route.request().headers().origin || new URL(page.url()).origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Firebase-GMPID',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers })
        return
      }
      callOrder.push('ensureUserProfile')
      await route.fulfill({ headers, json: { result: { serverNow: Date.now() } } })
    },
  )
  return { email, password, backendChecks: () => backendChecks, callOrder }
}
