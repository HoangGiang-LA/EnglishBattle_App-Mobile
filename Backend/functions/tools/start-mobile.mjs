import {spawn, execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import {resolve} from 'node:path'
import {functionsDir, loadMobileEnvironment} from './mobile-api/environment.mjs'

const services = new Set()
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of services) {
    if (!child.pid || child.exitCode !== null) continue
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true}) }
      catch { child.kill() }
    } else child.kill('SIGTERM')
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop())

function start(name, path, env) {
  const child = spawn(process.execPath, [path], {cwd: functionsDir, env, stdio: 'inherit', windowsHide: true})
  services.add(child)
  child.once('error', error => { console.error(`${name}: ${error.code || error.name}`); stop(1) })
  child.once('exit', code => {
    services.delete(child)
    if (!stopping) { console.error(`${name} stopped. Restart npm run start:mobile.`); stop(code || 1) }
  })
}

async function main() {
  const env = loadMobileEnvironment()
  await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error(`Port ${env.MOBILE_API_PORT} is already in use.`)))
    probe.listen(Number(env.MOBILE_API_PORT), '127.0.0.1', () => probe.close(resolvePort))
  })
  console.log('Building the mobile API. Firebase Auth and Database use the real project.')
  await new Promise((resolveBuild, reject) => {
    const child = spawn(process.execPath, [resolve(functionsDir, 'node_modules/typescript/bin/tsc')],
      {cwd: functionsDir, env, stdio: 'inherit', windowsHide: true})
    services.add(child)
    child.once('error', reject)
    child.once('exit', code => {
      services.delete(child)
      if (stopping || code === 0) resolveBuild()
      else reject(new Error('The Functions build failed.'))
    })
  })
  if (stopping) return
  start('Mobile API', resolve(functionsDir, 'tools/mobile-api/serve.mjs'), env)
  start('Learning worker', resolve(functionsDir, 'tools/learning-worker.mjs'), {...env, LEARNING_WORKER_LOCAL: 'true'})
  console.log(`Cloudflare Service URL: http://127.0.0.1:${env.MOBILE_API_PORT}`)
  console.log('Keep this terminal open. Ctrl+C stops the API and worker.')
}

main().catch(error => { console.error(error.message); stop(1) })
