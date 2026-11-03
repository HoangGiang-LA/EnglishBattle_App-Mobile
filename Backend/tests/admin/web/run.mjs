import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {readFileSync} from 'node:fs'
assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-admin')
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19299')
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:19200')
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined)
const require = createRequire(new URL('../../../functions/package.json', import.meta.url))
const {adminAuth: auth, adminDb: db} = require('./lib/config/firebaseAdmin.js')
const {deleteApp} = require('firebase-admin/app')
const {provisionUserProfile} = require('./lib/be1/auth/userProvisioning.js')
const {runUserIndexMaintenance} = require('./lib/admin/userIndex.js')
const {runInvitationMaintenance} = require('./lib/admin/invitations.js')
const {runQuestionIndexMaintenance} = require('./lib/admin/questionIndex.js')
const {createAccounts} = await import('../../../server/src/accounts.mjs')
const {createApiServer} = await import('../../../server/src/http.mjs')
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const web = fileURLToPath(new URL('../../../../frontend/admin-web/', import.meta.url))
const env = {...process.env, VITE_ADMIN_QA_PROJECT: 'demo-englishbattle-admin', VITE_ADMIN_DATA_MODE: 'firebase',
  VITE_BACKEND_BASE_URL: 'http://127.0.0.1:18180',
  ADMIN_QA_EMAIL: 'qa-admin@example.test', ADMIN_QA_PASSWORD: 'EmulatorOnly123!'}
let vite
let mailBusy = false
let mailTimer
const server = createApiServer(createAccounts(auth, db), {origins: ['http://127.0.0.1:15173']})
try {
  await fetch('http://127.0.0.1:19299/emulator/v1/projects/demo-englishbattle-admin/accounts', {method: 'DELETE'})
  await db.ref().set({})
  const contentSeed = JSON.parse(readFileSync(new URL('../../../database/english-battle.seed.json', import.meta.url), 'utf8'))
  await db.ref().update(Object.fromEntries(['categories', 'topics', 'lessons', 'questions', 'questionVersions',
    'questionAnswers', 'contentAssets', 'lessonQuestions', 'quizTemplates'].map(path => [path, contentSeed[path]])))
  const user = await auth.createUser({email: env.ADMIN_QA_EMAIL, password: env.ADMIN_QA_PASSWORD, displayName: 'QA administrator'})
  env.ADMIN_QA_ADMIN_UID = user.uid
  await auth.setCustomUserClaims(user.uid, {admin: true})
  await provisionUserProfile(user.uid)
  for (let i = 0; i < 11; i++) {
    const learner = await auth.createUser({email: `qa-learner-${i}@example.test`, password: env.ADMIN_QA_PASSWORD,
      displayName: `QA learner ${i}`})
    await provisionUserProfile(learner.uid)
  }
  await runUserIndexMaintenance()
  for (let i = 0; i < 100; i++) {
    await db.ref('adminQuestionIndexControl/nextRunAt').set(0)
    await runQuestionIndexMaintenance()
    if ((await db.ref('adminQuestionIndexMeta/ready').get()).val()) break
  }
  assert.equal((await db.ref('adminQuestionIndexMeta/ready').get()).val(), true, 'Question QA index must be ready')
  // Each callable can have a separate cold Node worker in Functions Emulator.
  // Warm entrypoints before the browser's 30-second transport timeout starts.
  const adminContract = JSON.parse(readFileSync(new URL('../../../../frontend/contracts/admin.v1.json', import.meta.url), 'utf8'))
  for (const action of adminContract.implementedCallables) {
    const response = await fetch(`http://127.0.0.1:15003/demo-englishbattle-admin/asia-southeast1/${action}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({data: {}}),
      signal: AbortSignal.timeout(120000),
    })
    await response.arrayBuffer()
    assert.equal(response.status, 401, `QA warmup must be rejected before effects: ${action}`)
  }
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(18180, '127.0.0.1', resolve)})
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '15173', '--strictPort'], {
    cwd: web, env, stdio: 'inherit', windowsHide: true,
  })
  const deadline = Date.now() + 30000
  let ready = false
  while (Date.now() < deadline) {
    try { ready = (await fetch('http://127.0.0.1:15173/')).ok } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(ready, 'Admin web QA dev server did not start')
  mailTimer = setInterval(() => {
    if (mailBusy) return
    mailBusy = true
    void runInvitationMaintenance().catch(() => {}).finally(() => {mailBusy = false})
  }, 2000)
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.firebase.config.ts'], {
      cwd: web, env, stdio: 'inherit', windowsHide: true,
    })
    child.once('error', reject); child.once('exit', resolve)
  })
  assert.equal(code, 0, 'Firebase admin browser acceptance failed')
} finally {
  clearInterval(mailTimer)
  if (vite?.pid) vite.kill('SIGTERM')
  await new Promise(resolve => server.close(resolve))
  await deleteApp(db.app)
}
void root
