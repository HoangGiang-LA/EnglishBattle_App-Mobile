import {existsSync, readFileSync} from 'node:fs'
import {createServer} from 'node:net'
import {resolve} from 'node:path'
import {spawn, execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {parseEnv} from 'node:util'

const webDir = fileURLToPath(new URL('../', import.meta.url))
const repoDir = resolve(webDir, '../..')
const serverDir = resolve(repoDir, 'Backend/server')
const functionsDir = resolve(repoDir, 'Backend/functions')
const cli = resolve(repoDir, 'frontend/verification/node_modules/firebase-tools/lib/bin/firebase.js')
const tsc = resolve(functionsDir, 'node_modules/typescript/bin/tsc')
const vite = resolve(webDir, 'node_modules/vite/bin/vite.js')
const services = new Set()
let stopping = false

function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of services) {
    if (!child.pid || child.exitCode !== null) continue
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        })
      } catch {
        child.kill()
      }
    } else child.kill('SIGTERM')
  }
}

process.once('SIGINT', () => stop())
process.once('SIGTERM', () => stop())

function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd, env, stdio: 'inherit', windowsHide: true,
  })
  services.add(child)
  child.once('error', error => {
    console.error(`${name}: ${error.message}`)
    stop(1)
  })
  child.once('exit', code => {
    services.delete(child)
    if (!stopping) {
      console.error(`${name} da dung. Hay khoi dong lai npm run dev:local.`)
      stop(code || 1)
    }
  })
}

async function checkPort(port) {
  await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error(
      `Cong ${port} dang duoc su dung. Dung dich vu cu truoc khi chay dev:local.`,
    )))
    probe.listen(port, '127.0.0.1', () => probe.close(resolvePort))
  })
}

async function waitFor(url, expectedStatus, options, requestTimeout = 2000) {
  const deadline = Date.now() + 120_000
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(url, {...options, signal: AbortSignal.timeout(requestTimeout)})
      await response.arrayBuffer()
      if (response.status === expectedStatus) return
    } catch {
      // The service may still be loading its runtime.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  if (!stopping) throw new Error(`Dich vu chua san sang: ${url}. Kiem tra log phia tren.`)
}

async function main() {
  for (const [entry, directory] of [
    [cli, 'frontend/verification'], [tsc, 'Backend/functions'],
    [vite, 'frontend/admin-web'],
    [resolve(serverDir, 'node_modules/firebase-admin/package.json'), 'Backend/server'],
  ]) {
    if (!existsSync(entry)) throw new Error(`Thieu thu vien. Chay npm ci trong ${directory}.`)
  }
  const envFile = resolve(serverDir, '.env')
  if (!existsSync(envFile)) {
    throw new Error('Tao Backend/server/.env tu .env.example va dien duong dan khoa Admin SDK.')
  }
  const env = {...parseEnv(readFileSync(envFile, 'utf8')), ...process.env}
  env.FUNCTIONS_DISCOVERY_TIMEOUT ||= '60'
  if (env.FIREBASE_AUTH_EMULATOR_HOST || env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error('Che do nay dung Auth/Database that. Bo cac bien AUTH/DATABASE_EMULATOR_HOST.')
  }
  const project = JSON.parse(readFileSync(resolve(repoDir, '.firebaserc'), 'utf8')).projects.default
  if (env.FIREBASE_PROJECT_ID !== project || !env.FIREBASE_DATABASE_URL) {
    throw new Error('Kiem tra FIREBASE_PROJECT_ID va FIREBASE_DATABASE_URL trong Backend/server/.env.')
  }
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Dien GOOGLE_APPLICATION_CREDENTIALS trong Backend/server/.env.')
  }
  env.GOOGLE_APPLICATION_CREDENTIALS = resolve(serverDir, env.GOOGLE_APPLICATION_CREDENTIALS)
  if (!existsSync(env.GOOGLE_APPLICATION_CREDENTIALS)) {
    throw new Error('Khong tim thay file khoa Admin SDK: ' + env.GOOGLE_APPLICATION_CREDENTIALS +
      '. Kiem tra GOOGLE_APPLICATION_CREDENTIALS trong Backend/server/.env va bien moi truong cua terminal.')
  }
  env.HOST = '127.0.0.1'
  env.PORT = '8080'
  env.ADMIN_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173'
  await Promise.all([4400, 4500, 5001, 8080, 5173].map(checkPort))
  if (stopping) return

  console.log('Firebase Auth va Realtime Database: du lieu that cua project ' + project)
  console.log('Cloud Functions: chay tren may, khong deploy. Dang build Functions...')
  await new Promise((resolveBuild, reject) => {
    const build = spawn(process.execPath, [tsc], {
      cwd: functionsDir, stdio: 'inherit', windowsHide: true,
    })
    services.add(build)
    build.once('error', reject)
    build.once('exit', code => {
      services.delete(build)
      if (stopping || code === 0) resolveBuild()
      else reject(new Error('Build Functions that bai.'))
    })
  })
  if (stopping) return
  start('Functions Emulator', [
    cli, 'emulators:start', '--only', 'functions',
    '--config', 'firebase.admin-local.json', '--project', project, '--non-interactive',
  ], repoDir, env)
  await waitFor(`http://127.0.0.1:5001/${project}/asia-southeast1/ensureUserProfile`, 401, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({data: {}}),
  }, 120000)
  const adminContract = JSON.parse(readFileSync(resolve(repoDir, 'frontend/contracts/admin.v1.json'), 'utf8'))
  for (const action of adminContract.implementedCallables) {
    if (stopping) return
    await waitFor(`http://127.0.0.1:5001/${project}/asia-southeast1/${action}`, 401, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({data: {}}),
    }, 120000)
  }
  if (stopping) return
  start('Learning worker', ['--watch', resolve(functionsDir, 'tools/learning-worker.mjs')], functionsDir, {
    ...env, LEARNING_WORKER_LOCAL: 'true',
  })
  start('Admin server', ['src/index.mjs'], serverDir, env)
  await waitFor('http://127.0.0.1:8080/health', 200)
  if (stopping) return
  start('Web admin', [vite, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], webDir, {
    ...process.env,
    VITE_USE_FUNCTIONS_EMULATOR: 'true',
    VITE_BACKEND_BASE_URL: 'http://127.0.0.1:8080',
  })
  await waitFor('http://127.0.0.1:5173/', 200)
  if (!stopping) {
    console.log('\nMo web admin: http://127.0.0.1:5173/ (dung tai khoan Firebase admin hien co).')
    console.log('Giu terminal nay mo. Nhan Ctrl+C de dung cac dich vu va tac vu nen.\n')
  }
}

main().catch(error => {
  console.error(error.message)
  stop(1)
})
