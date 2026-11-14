import assert from 'node:assert/strict'
import {test} from 'node:test'
import {permissionRules, withCampaignIndexes} from './campaign-indexes.mjs'

test('campaign index setup preserves the complete existing live access policy', () => {
  const before = {rules: {'.read': false, '.write': false, users: {'$uid': {'.read': 'auth.uid === $uid'}},
    adminCampaigns: {'.read': false, '.write': false, '.validate': 'newData.exists()', '.indexOn': ['otherField']}}}
  const copy = structuredClone(before), next = withCampaignIndexes(before)
  assert.deepEqual(before, copy)
  assert.deepEqual(next.rules.adminCampaigns['.indexOn'], ['otherField', 'createdAt', 'nextRunAt'])
  assert.deepEqual(permissionRules(next), permissionRules(before))
  assert.deepEqual(withCampaignIndexes(next), next)
})
test('adding an index-only campaign node does not add access rules or replace other indexes', () => {
  const before = {rules: {'.read': false, '.write': false, adminAudit: {'.indexOn': ['expiresAt']}}}
  const next = withCampaignIndexes(before)
  assert.deepEqual(permissionRules(next), permissionRules(before))
  assert.deepEqual(next.rules.adminAudit, before.rules.adminAudit)
  assert.deepEqual(next.rules.adminCampaigns, {'.indexOn': ['createdAt', 'nextRunAt']})
})
test('string indexes are retained and malformed rules are rejected before any write', () => {
  assert.deepEqual(withCampaignIndexes({rules: {adminCampaigns: {'.indexOn': 'createdAt'}}}).rules.adminCampaigns['.indexOn'], ['createdAt', 'nextRunAt'])
  for (const invalid of [null, {}, {rules: []}, {rules: {adminCampaigns: false}}, {rules: {adminCampaigns: {'.indexOn': 42}}}]) {
    assert.throws(() => withCampaignIndexes(invalid))
  }
})
