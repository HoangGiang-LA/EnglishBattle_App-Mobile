import {deleteApp} from 'firebase-admin/app'
import {createRequire} from 'node:module'
import {randomUUID} from 'node:crypto'
import {connectFirebase} from '../src/firebase.mjs'

const [action, uid, ...options] = process.argv.slice(2)
if (!['grant', 'revoke'].includes(action) || !uid || options.length % 2) {
  throw new Error('Usage: npm run admin -- grant|revoke FIREBASE_UID [--request-id ID] [--reason REASON]')
}
const values = Object.fromEntries(Array.from({length: options.length / 2}, (_, i) => [options[i * 2], options[i * 2 + 1]]))
if (Object.keys(values).some(key => !['--request-id', '--reason'].includes(key))) throw new Error('Unknown option')
const requestId = values['--request-id'] || randomUUID()
const reason = values['--reason'] || 'Server operator ' + action + ' admin'
const require = createRequire(new URL('../../functions/package.json', import.meta.url))
let changeAdminRole
try { ({changeAdminRole} = require('./lib/admin/roles.js')) }
catch { throw new Error('Build Backend/functions before running the protected role tool.') }
console.log('Role requestId: ' + requestId + ' (reuse this ID and reason when retrying).')
const {app, auth, database} = connectFirebase()
try {
  await changeAdminRole(auth, database, {action, uid, requestId, reason})
  console.log('Admin access ' + (action === 'grant' ? 'granted' : 'revoked') + '. Refresh the sign-in token.')
} catch (error) {
  console.error('Role operation did not complete:', error.details?.reason || error.code || 'unavailable')
  process.exitCode = 1
} finally {
  await deleteApp(app)
}
