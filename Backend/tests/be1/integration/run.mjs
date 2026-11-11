import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';

assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-finalization');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9199');
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:9100');
assert.equal(process.env.FUNCTIONS_EMULATOR_HOST, '127.0.0.1:5002');
async function run(executable, args, capture = false) {
  let output = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {env: {...process.env}, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true});
    if (capture) for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output += chunk; process.stdout.write(chunk);
    });
    child.on('error', reject); child.on('exit', resolve);
  });
  assert.equal(code, 0, `Acceptance command failed (${code})`);
  return output;
}
if (process.env.ENGLISH_BATTLE_ACCEPTANCE_MOBILE_API !== 'true') await run(process.execPath, ['--test', '--test-concurrency=1', ...[
  'reporting.test.mjs', 'community.test.mjs', 'dailyAchievements.test.mjs', 'battle/battle.test.mjs', 'battle/battleEffects.test.mjs',
  'practice/learningMaintenance.test.mjs', 'practice/progressAchievements.test.mjs',
  'practice/attemptCompletion.test.mjs', 'profileContent.test.mjs',
].map(path => `Backend/tests/be1/${path}`)]);
await run(process.execPath, ['--test', 'Backend/tests/be1/integration/http.test.mjs']);
if (process.env.ENGLISH_BATTLE_ACCEPTANCE_ANDROID === 'true') {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  assert.ok(sdk, 'Set ANDROID_HOME or ANDROID_SDK_ROOT for --android.');
  const adb = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const serial = process.env.ANDROID_SERIAL;
  assert.ok(serial?.startsWith('emulator-'), 'Choose an Android Emulator with ANDROID_SERIAL (10.0.2.2 reaches the QA host).');
  for (const apk of ['debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk'])
    await run(adb, ['-s', serial, 'install', '-r', `frontend/app/build/outputs/apk/${apk}`]);
  const classes = readdirSync('frontend/app/src/androidTest/java/com/englishbattle/app')
    .filter(file => /^[A-Z][A-Za-z0-9]+Test\.kt$/.test(file) && file !== 'FirebaseIntegrationTest.kt')
    .map(file => `com.englishbattle.app.${file.slice(0, -3)}`);
  const regression = await run(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
    '-e', 'class', classes.join(','), 'com.englishbattle.app.test/androidx.test.runner.AndroidJUnitRunner'], true);
  assert.match(regression, /OK \(\d+ tests?\)/, 'Android UI/ViewModel regression did not pass.');
  assert.doesNotMatch(regression, /FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/);
  const {prepareAndroidAdminFixture} = await import('./admin-fixture.mjs');
  const fixture = await prepareAndroidAdminFixture();
  const output = await run(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'acceptanceEmulators', 'true',
    '-e', 'adminFixtureEmail', fixture.adminEmail, '-e', 'learnerFixtureEmail', fixture.learnerEmail,
    '-e', 'adminFixturePassword', fixture.password, '-e', 'class', 'com.englishbattle.app.FirebaseIntegrationTest', 'com.englishbattle.app.test/androidx.test.runner.AndroidJUnitRunner'], true);
  assert.match(output, /OK \(2 tests\)/, 'Android SDK integration test did not pass.');
  assert.doesNotMatch(output, /FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/);
}
