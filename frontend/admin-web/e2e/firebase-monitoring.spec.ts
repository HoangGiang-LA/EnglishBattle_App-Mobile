import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

if (
  process.env.GCLOUD_PROJECT !== 'demo-englishbattle-admin' ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:19299' ||
  process.env.FIREBASE_DATABASE_EMULATOR_HOST !== '127.0.0.1:19200'
) {
  throw new Error('Monitoring browser QA requires isolated emulators.')
}
const require = createRequire(new URL('../../../Backend/functions/package.json', import.meta.url))
const { adminAuth: auth, adminDb: db } = require('./lib/config/firebaseAdmin.js')
const { runBattleIndexMaintenance } = require('./lib/admin/monitoringIndex.js')
const id = process.env.ADMIN_QA_BATTLE_ID!
async function enter(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email address').fill(process.env.ADMIN_QA_EMAIL!)
  await page.getByLabel('Password', { exact: true }).fill(process.env.ADMIN_QA_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
  await page.getByRole('navigation').getByRole('link', { name: 'Battles', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recent matches', exact: true })).toBeVisible()
}
test.beforeEach(async () => {
  // Functional cases are isolated from the quota consumed by preceding browser cases and warmup.
  // This file has already asserted the dedicated demo project and emulator hosts.
  await db.ref('adminRateLimits').remove()
  await auth.setCustomUserClaims(process.env.ADMIN_QA_ADMIN_UID!, { admin: true })
  await auth.updateUser(process.env.ADMIN_QA_ADMIN_UID!, { disabled: false })
})

test('Battles displays a server-created match, reloads it and shows actual logs without source mutations', async ({
  page,
}, info) => {
  const before = (await db.ref(`battleRooms/${id}`).get()).val()
  await enter(page)
  await page.getByRole('button', { name: `View logs B-${id}`, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('QA learner 0', { exact: true })).toBeVisible()
  await expect(dialog.getByText('QA learner 1', { exact: true })).toBeVisible()
  await expect(dialog.getByText('The match started.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Server phase', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/Only recorded server events/)).toBeVisible()
  await expect(dialog.getByText(/simulated/i)).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('firebase-monitoring.png'), fullPage: true })
  await dialog.getByRole('button', { name: 'Close log', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: `View logs B-${id}`, exact: true })).toBeVisible()
  expect((await db.ref(`battleRooms/${id}`).get()).val()).toEqual(before)
})

test('monitoring refresh reflects completed status and exposes recorded activities with independent pagination', async ({
  page,
}) => {
  const room = (await db.ref(`battleRooms/${id}`).get()).val()
  const uids = Object.keys(room.players).sort(),
    at = Date.now()
  await db.ref(`battleRooms/${id}`).update({
    status: 'completed',
    finish: {
      reason: 'answers',
      at,
      correct: { [uids[0]]: 8, [uids[1]]: 6 },
      answered: { [uids[0]]: 10, [uids[1]]: 10 },
      outcomes: { [uids[0]]: 'win', [uids[1]]: 'loss' },
    },
  })
  await db.ref('adminMonitoringControl/battles/nextRunAt').set(0)
  await runBattleIndexMaintenance()
  await enter(page)
  await page.getByLabel('Battle status').selectOption('completed')
  await expect(page.getByRole('button', { name: `View logs B-${id}`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View activities', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled()
  await dialog.getByRole('combobox', { name: /Activity type/ }).selectOption('user')
  await expect(dialog.getByText('Account registered', { exact: true })).toHaveCount(10)
  await expect(dialog.getByText(/Simulated/)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(dialog.getByText('Account registered', { exact: true })).toHaveCount(2)
  await dialog.getByRole('combobox', { name: /Activity type/ }).selectOption('lesson')
  await expect(dialog.getByText('Account registered', { exact: true })).toHaveCount(0)
})

test('daily and private monitoring show unimplemented errors and never show sample matches', async ({
  page,
}) => {
  await enter(page)
  await page.getByLabel('Battle mode').selectOption('daily')
  await expect(page.getByRole('alert')).toContainText('chưa được triển khai')
  await expect(page.getByRole('button', { name: /^View logs B-/ })).toHaveCount(0)
  await page.getByLabel('Battle mode').selectOption('private')
  await expect(page.getByRole('alert')).toContainText('chưa được triển khai')
})
