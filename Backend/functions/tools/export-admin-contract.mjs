import assert from 'node:assert/strict'
import {readFileSync, writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require = createRequire(import.meta.url)
const {adminContracts, adminDefinitions} = require('../lib/admin/contracts.js')
const document = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:english-battle:admin:v1',
  $defs: {...adminDefinitions},
}
for (const [action, contract] of Object.entries(adminContracts)) {
  document.$defs[`${action}Request`] = contract.request
  document.$defs[`${action}Response`] = contract.response
}
const output = new URL('../../../frontend/contracts/admin.schemas.v1.json', import.meta.url)
if (process.argv.includes('--check')) {
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), document,
    'Admin schemas drifted. Run npm run build then npm run contract:admin in Backend/functions.')
} else {
  writeFileSync(output, JSON.stringify(document, null, 2) + '\n')
}
