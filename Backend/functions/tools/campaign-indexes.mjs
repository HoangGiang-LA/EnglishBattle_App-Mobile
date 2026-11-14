import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdirSync, writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {functionsDir, loadMobileEnvironment} from './mobile-api/environment.mjs'

export const requiredCampaignIndexes = ['createdAt', 'nextRunAt']
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

export function withCampaignIndexes(document) {
  assert.ok(document?.rules && typeof document.rules === 'object' && !Array.isArray(document.rules), 'Invalid database rules.')
  const next = structuredClone(document)
  if (next.rules.adminCampaigns === undefined) next.rules.adminCampaigns = {}
  const node = next.rules.adminCampaigns
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), 'Invalid campaign rules.')
  const previous = node['.indexOn']
  const indexes = previous === undefined ? [] : typeof previous === 'string' ? [previous] : previous
  assert.ok(Array.isArray(indexes) && indexes.every(index => typeof index === 'string'), 'Invalid campaign indexes.')
  node['.indexOn'] = [...new Set([...indexes, ...requiredCampaignIndexes])]
  return next
}

// Empty nodes containing only indexes do not grant access. Compare every actual rule independently of indexes.
export function permissionRules(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '.indexOn').flatMap(([key, child]) => {
    const next = permissionRules(child)
    return next && typeof next === 'object' && !Array.isArray(next) && !Object.keys(next).length ? [] : [[key, next]]
  }))
}

async function main() {
  if (process.argv.slice(2).some(flag => !['--check', '--apply'].includes(flag))) throw new Error('Use --check or --apply.')
  Object.assign(process.env, loadMobileEnvironment())
  const require = createRequire(import.meta.url)
  const {adminDb} = require('../lib/config/firebaseAdmin.js')
  try {
    const before = await adminDb.getRulesJSON()
    const next = withCampaignIndexes(before)
    assert.deepEqual(permissionRules(next), permissionRules(before), 'An access rule would change.')
    if (digest(next) === digest(before)) {
      console.log('Campaign indexes are ready. No changes needed.')
      return
    }
    if (!process.argv.includes('--apply')) {
      console.log('Missing campaign indexes: createdAt, nextRunAt. Run with --apply to add indexes without changing access rules.')
      process.exitCode = 1
      return
    }
    // Preserve the actual live policy, including rules unrelated to this checkout.
    const backup = resolve(functionsDir, 'lib/diagnostics', `database-rules-before-campaign-indexes-${Date.now()}.json`)
    mkdirSync(dirname(backup), {recursive: true})
    writeFileSync(backup, JSON.stringify(before, null, 2) + '\n', {flag: 'wx'})
    assert.equal(digest(await adminDb.getRulesJSON()), digest(before), 'Database rules changed. Retry after reviewing the current rules.')
    await adminDb.setRules(JSON.stringify(next))
    const after = await adminDb.getRulesJSON()
    assert.equal(digest(after), digest(next), 'Verify the saved database rules before retrying.')
    assert.deepEqual(permissionRules(after), permissionRules(before), 'Access rules changed unexpectedly.')
    console.log('Added campaign indexes: createdAt, nextRunAt. Verified all access rules are unchanged.')
    console.log(`Previous rules saved to ${backup}`)
  } finally {
    await require('firebase-admin/app').deleteApp(adminDb.app)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.code || error.message); process.exitCode = 1 })
}
