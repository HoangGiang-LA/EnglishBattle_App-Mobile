import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import {createServer} from 'node:net'
import {join, delimiter} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const env = {...process.env}
// A dedicated demo project, ports AND namespace; never inherit live credentials.
for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG',
  'FIREBASE_DATABASE_URL', 'FIREBASE_PROJECT_ID', 'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'LEARNING_WORKER_LOCAL',
  'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FUNCTIONS_EMULATOR']) delete env[key]
const project = 'demo-englishbattle-admin'
Object.assign(env, {
  GCLOUD_PROJECT: project, GOOGLE_CLOUD_PROJECT: project, FIREBASE_PROJECT_ID: project,
  FIREBASE_DATABASE_URL: `https://${project}-default-rtdb.asia-southeast1.firebasedatabase.app`,
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19299',
  FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:19200',
  FUNCTIONS_EMULATOR_HOST: '127.0.0.1:15003',
})
const searchPath = process.env.PATH || ''
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
const bundledJava = 'C:/Program Files/Android/Android Studio/jbr'
if (!env.JAVA_HOME && process.platform === 'win32' && existsSync(join(bundledJava, 'bin/java.exe'))) {
  env.JAVA_HOME = bundledJava
}
env.PATH = env.JAVA_HOME ? `${join(env.JAVA_HOME, 'bin')}${delimiter}${searchPath}` : searchPath
const children = new Set()
let stopping = false
const stop = () => {
  stopping = true
  for (const child of children) child.kill('SIGTERM')
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
async function run(args, cwd = root) {
  assert.ok(!stopping, 'QA interrupted')
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd, env, stdio: 'inherit', windowsHide: true})
    children.add(child)
    child.once('error', reject)
    child.once('exit', code => { children.delete(child); resolve(code) })
  })
  assert.equal(code, 0, `Admin QA command failed (${code})`)
}
for (const port of [19299, 19200, 15003, 14421, 14521, 19311, 19511]) {
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', error => reject(new Error(`Cannot bind admin QA port ${port}: ${error.code}.`)))
    probe.listen(port, '127.0.0.1', () => probe.close(resolve))
  })
}
const cli = 'frontend/verification/node_modules/firebase-tools/lib/bin/firebase.js'
assert.ok(existsSync(join(root, cli)), 'Run npm ci in frontend/verification first.')
await run(['node_modules/eslint/bin/eslint.js', '--ext', '.js,.ts', '.'], join(root, 'Backend/functions'))
await run(['Backend/functions/node_modules/typescript/bin/tsc', '--project', 'Backend/functions/tsconfig.json'])
await run(['Backend/functions/tools/export-admin-contract.mjs', '--check'])
await run(['--test', 'Backend/tests/admin/contracts.test.mjs'])
await run([cli, 'emulators:exec', '--only', 'auth,database,functions', '--project', project,
  '--config', 'firebase.admin-qa.json', '--non-interactive',
  process.argv.includes('--web') ? 'node Backend/tests/admin/web/run.mjs' : process.argv.includes('--content') ?
    'node --test --test-concurrency=1 --test-timeout=180000 Backend/tests/admin/content.test.mjs' :
    'node --test --test-concurrency=1 --test-timeout=180000 Backend/tests/admin/integration.test.mjs Backend/tests/admin/users.test.mjs Backend/tests/admin/content.test.mjs'])
