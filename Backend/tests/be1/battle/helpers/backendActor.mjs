import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

// Each child has its own Admin SDK connection/cache, as on a second computer.
assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-finalization');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9199');
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:9100');
assert.ok(process.send, 'This helper requires a private IPC channel');
const skew = Number(process.env.BATTLE_TEST_CLOCK_SKEW_MS || 0);
if (skew) {
  const WallClock = Date;
  // The Firebase SDK measures its offset with new Date(), not Date.now().
  globalThis.Date = class extends WallClock {
    constructor(...args) { super(...(args.length ? args : [WallClock.now() + skew])); }
    static now() { return WallClock.now() + skew; }
  };
}
const require = createRequire(new URL('../../../../functions/package.json', import.meta.url));
const {adminDb} = require('./lib/config/firebaseAdmin.js');
assert.match(adminDb.ref().toString(), /^http:\/\/127\.0\.0\.1:9100\//);
const callables = require('./lib/be1/battle/battleCallables.js');
callables.markNotificationsRead = require('./lib/be1/user/markNotificationsRead.js').markNotificationsRead;
callables.getLeaderboard = require('./lib/be1/community/getLeaderboard.js').getLeaderboard;
callables.getNotifications = require('./lib/be1/community/getNotifications.js').getNotifications;
callables.getHistory = require('./lib/be1/reporting/getHistory.js').getHistory;
callables.getStudyStatistics = require('./lib/be1/reporting/getStudyStatistics.js').getStudyStatistics;
callables.getCoinLedger = require('./lib/be1/reporting/getCoinLedger.js').getCoinLedger;
for (const method of ['resumeAttempt', 'submitAttemptAnswer', 'saveAttemptSelection', 'leaveAttempt', 'getAttemptResult']) {
  callables[method] = require(`./lib/be1/practice/${method}.js`)[method];
}
const {runBattleMaintenance} = require('./lib/be1/battle/battleMaintenance.js');
const {battleNow, syncBattleClock} = require('./lib/be1/battle/battleClock.js');
let queue = Promise.resolve();
process.on('message', command => {
  queue = queue.then(async () => {
    const clock = Date.now;
    try {
      if (command.now != null) {
        await syncBattleClock();
        Date.now = () => command.now;
        const offset = battleNow() - command.now;
        Date.now = () => command.now - offset;
      }
      let value;
      if (command.method === 'maintenance') await runBattleMaintenance();
      else {
        const fn = callables[command.method];
        assert.equal(typeof fn?.run, 'function');
        value = await fn.run({auth: {uid: command.user.uid},
          data: {...command.data, ...(['markNotificationsRead', 'getLeaderboard', 'getNotifications', 'getHistory', 'getStudyStatistics', 'getCoinLedger'].includes(command.method) ? {} :
            {clientSessionId: command.user.sid})}});
      }
      process.send({id: command.id, value});
    } catch (error) {
      process.send({id: command.id, error: {message: error.message, code: error.code}});
    } finally { Date.now = clock; }
  });
});
process.send({ready: true, pid: process.pid});
