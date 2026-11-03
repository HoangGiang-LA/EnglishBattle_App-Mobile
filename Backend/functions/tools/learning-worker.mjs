import {createRequire} from 'node:module'

// This process has Admin privileges. Start it only through the local launcher
// or against the explicitly isolated emulator suite; expose no HTTP endpoint.
const isolated = process.env.GCLOUD_PROJECT === 'demo-englishbattle-finalization' &&
  process.env.FIREBASE_AUTH_EMULATOR_HOST === '127.0.0.1:9199' &&
  process.env.FIREBASE_DATABASE_EMULATOR_HOST === '127.0.0.1:9100'
const local = process.env.LEARNING_WORKER_LOCAL === 'true' &&
  process.env.FIREBASE_PROJECT_ID === 'englishbattleapp-8d764' &&
  process.env.FIREBASE_DATABASE_URL ===
    'https://englishbattleapp-8d764-default-rtdb.asia-southeast1.firebasedatabase.app' &&
  process.env.GOOGLE_APPLICATION_CREDENTIALS &&
  !process.env.FIREBASE_AUTH_EMULATOR_HOST && !process.env.FIREBASE_DATABASE_EMULATOR_HOST
if (!isolated && !local) throw new Error('Start the learning worker using npm run dev:local.')

const require = createRequire(import.meta.url)
const {runLearningMaintenance} = require('../lib/be1/practice/learningMaintenance.js')
const {runBattleMaintenance} = require('../lib/be1/battle/battleMaintenance.js')
const {runCommunityMaintenance} = require('../lib/be1/community/communityMaintenance.js')
const {runReportingMaintenance} = require('../lib/be1/reporting/maintenance.js')
const {runAdminMaintenance} = require('../lib/admin/maintenance.js')
const {adminDb} = require('../lib/config/firebaseAdmin.js')
const {deleteApp} = require('firebase-admin/app')
let stopping = false
process.once('SIGINT', () => { stopping = true })
process.once('SIGTERM', () => { stopping = true })
const once = process.argv.includes('--once')
console.log('Learning, battle and admin worker: deadlines, settlement and operation recovery ready.')
try {
  do {
    const passes = await Promise.allSettled([runLearningMaintenance(), runBattleMaintenance(), runCommunityMaintenance(), runReportingMaintenance(), runAdminMaintenance()])
    for (const [index, pass] of passes.entries()) {
      if (pass.status !== 'rejected') continue
      console.error(`${['Learning', 'Battle', 'Community', 'Reporting', 'Admin'][index]} worker pass failed:`,
        pass.reason.code || pass.reason.message)
      if (once) process.exitCode = 1
    }
    if (!once && !stopping) await new Promise(resolve => setTimeout(resolve, 1000))
  } while (!once && !stopping)
} finally {
  await deleteApp(adminDb.app)
}
