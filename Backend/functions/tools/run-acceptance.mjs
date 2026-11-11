import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = {...process.env};
// Never pass the live local launcher's credentials/config to the test stack.
for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'FIREBASE_DATABASE_URL',
  'FIREBASE_PROJECT_ID', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_EMULATOR_HUB', 'LEARNING_WORKER_LOCAL', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) delete env[key];
// Windows exposes Path case-insensitively through process.env, but a spread is
// a normal object. Normalize it before adding JAVA_HOME or child shims lose Node.
const searchPath = process.env.PATH || '';
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = env.JAVA_HOME ? `${join(env.JAVA_HOME, 'bin')}${process.platform === 'win32' ? ';' : ':'}${searchPath}` : searchPath;
env.FUNCTIONS_EMULATOR_HOST = '127.0.0.1:5002';
env.ENGLISH_BATTLE_ACCEPTANCE_ANDROID = process.argv.includes('--android') ? 'true' : 'false';
env.ENGLISH_BATTLE_ACCEPTANCE_MOBILE_API = process.argv.includes('--mobile') ? 'true' : 'false';

async function run(args, cwd = root) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd, env, stdio: 'inherit', windowsHide: true});
    child.on('error', reject); child.on('exit', resolve);
  });
  assert.equal(code, 0, `Acceptance command failed (${code})`);
}
for (const port of [9199, 9100, 5002, 4411, 4511, 9301, 9501]) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`QA port ${port} is occupied. Stop that QA run before retrying.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
const cli = 'frontend/verification/node_modules/firebase-tools/lib/bin/firebase.js';
assert.ok(existsSync(join(root, cli)), 'Install dependencies in frontend/verification first.');
await run(['node_modules/eslint/bin/eslint.js', '--ext', '.js,.ts', '.'], join(root, 'Backend/functions'));
await run(['Backend/functions/node_modules/typescript/bin/tsc', '--project', 'Backend/functions/tsconfig.json']);
await run([cli, 'emulators:exec', '--only', 'auth,database,functions', '--project', 'demo-englishbattle-finalization',
  '--config', 'firebase.acceptance-qa.json', '--non-interactive', 'node Backend/tests/be1/integration/run.mjs']);
