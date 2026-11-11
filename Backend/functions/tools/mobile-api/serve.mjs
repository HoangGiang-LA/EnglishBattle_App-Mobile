import {createRequire} from 'node:module'
import {loadMobileEnvironment} from './environment.mjs'
import {createMobileApi, mobileHandlers} from './http.mjs'

const env = loadMobileEnvironment()
Object.assign(process.env, env)
const require = createRequire(import.meta.url)
const {initializeApp, applicationDefault, deleteApp} = require('firebase-admin/app')
const {getAuth} = require('firebase-admin/auth')
const {getAppCheck} = require('firebase-admin/app-check')
const app = initializeApp({projectId: env.FIREBASE_PROJECT_ID,
  databaseURL: env.FIREBASE_DATABASE_URL, credential: applicationDefault()})
const auth = getAuth(app)
const appCheck = getAppCheck(app)
const server = createMobileApi({
  handlers: mobileHandlers(require('../../lib/index.js')),
  verifyToken: (token, checkRevoked) => auth.verifyIdToken(token, checkRevoked),
  verifyAppCheck: token => appCheck.verifyToken(token),
})
server.on('error', error => {
  console.error('Mobile API could not start:', error.code || error.name)
  process.exit(1)
})
server.listen(Number(env.MOBILE_API_PORT), '127.0.0.1', () => {
  console.log(`Mobile API ready: http://127.0.0.1:${env.MOBILE_API_PORT}`)
  console.log('Firebase ID tokens are verified. Functions Emulator is not used.')
})
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (stopping) return
  stopping = true
  server.close(async () => { await deleteApp(app); process.exit(0) })
  setTimeout(() => process.exit(1), 10_000).unref()
})
