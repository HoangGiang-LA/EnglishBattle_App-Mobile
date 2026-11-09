import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

export async function startBackend({clockSkewMs = 0} = {}) {
  const child = fork(fileURLToPath(new URL('./backendActor.mjs', import.meta.url)), [],
    {env: {...process.env, BATTLE_TEST_CLOCK_SKEW_MS: String(clockSkewMs)},
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
  const pending = new Map();
  let ready;
  const initialized = new Promise((resolve, reject) => {
    ready = {resolve, reject};
  });
  child.on('message', message => {
    if (message.ready) { ready.resolve(); return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    message.error ? request.reject(Object.assign(new Error(message.error.message), message.error)) : request.resolve(message.value);
  });
  const fail = error => {
    ready.reject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Backend exited ${code}: ${output}`)));
  const bootTimeout = setTimeout(() => { child.kill(); fail(new Error(`Backend did not start: ${output}`)); }, 10000);
  try { await initialized; } finally { clearTimeout(bootTimeout); }
  let sequence = 0;
  return {
    pid: child.pid,
    call(method, user, data = {}, now) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Backend ${method} timed out: ${output}`)); }, 15000);
        pending.set(id, {resolve, reject, timer});
        child.send({id, method, user, data, now});
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    },
  };
}
