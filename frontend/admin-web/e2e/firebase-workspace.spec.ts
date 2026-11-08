import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

if (
  process.env.GCLOUD_PROJECT !== 'demo-englishbattle-admin' ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:19299' ||
  process.env.FIREBASE_DATABASE_EMULATOR_HOST !== '127.0.0.1:19200'
) {
  throw new Error('Workspace browser QA requires the isolated admin emulator launcher.')
}
const require = createRequire(new URL('../../../Backend/functions/package.json', import.meta.url))
const { adminAuth: auth, adminDb: db } = require('./lib/config/firebaseAdmin.js')
const { runAdminNotificationMaintenance } = require('./lib/admin/notificationWorker.js')
const { syncAdminUserIndex } = require('./lib/admin/userIndex.js')
const adminUid = process.env.ADMIN_QA_ADMIN_UID!
const api = require('./lib/admin/callables.js')
async function enter(page: Page, email = process.env.ADMIN_QA_EMAIL!) {
  await page.goto('/')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(process.env.ADMIN_QA_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
  await expect(page.locator('tbody tr').first()).toBeVisible()
}
test.beforeEach(async () => {
  // Functional cases are isolated from the quota consumed by preceding browser cases and warmup.
  // This file has already asserted the dedicated demo project and emulator hosts.
  await db.ref('adminRateLimits').remove()
  await auth.setCustomUserClaims(adminUid, { admin: true })
  await auth.updateUser(adminUid, { disabled: false })
  for (let i = 0; i < 100; i++) {
    await db.ref('adminNotificationControl/nextRunAt').set(0)
    await runAdminNotificationMaintenance()
    const c = (await db.ref('adminNotificationControl').get()).val()
    if (c.ready && !c.phase) break
  }
})

test('global search routes actual user, question and battle IDs to the existing pages', async ({
  page,
}) => {
  await enter(page)
  const search = page.getByRole('textbox', { name: 'Search anything' })
  await search.fill('qa-learner-0@example.test')
  await page
    .locator('.search-results')
    .getByRole('button', { name: /QA learner 0/ })
    .click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.getByRole('searchbox')).not.toHaveValue('')
  await search.fill(process.env.ADMIN_QA_QUESTION_ID!)
  await page
    .locator('.search-results')
    .getByRole('button', { name: /Question/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'All questions', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Edit Q/ })).toHaveCount(1)
  await search.fill(process.env.ADMIN_QA_BATTLE_ID!)
  await page
    .locator('.search-results')
    .getByRole('button', { name: /Quick battle/ })
    .click()
  await expect(page.getByRole('heading', { name: 'Recent matches' })).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: `View logs B-${process.env.ADMIN_QA_BATTLE_ID}`,
      exact: true,
    }),
  ).toBeVisible()
})

test('notification pagination and read state survive reload and stay independent across two administrators', async ({
  page,
  browser,
}, info) => {
  const secondContext = await browser.newContext()
  const second = await secondContext.newPage()
  try {
    await enter(page)
    await enter(second, process.env.ADMIN_QA_SECOND_EMAIL!)
    await page.getByRole('button', { name: /^Notifications/ }).click()
    const panel = page.locator('.notifications-panel')
    await expect(panel.locator('.notification')).toHaveCount(10)
    await panel.getByRole('button', { name: 'Next notification page' }).click()
    await expect(panel.locator('.notification').first()).toBeVisible()
    await panel.getByRole('button', { name: 'Mark all read', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
    await expect(panel.locator('.notification.unread')).toHaveCount(0)
    await second.getByRole('button', { name: /^Notifications/ }).click()
    await expect(second.locator('.notification.unread').first()).toBeVisible()
    await second.locator('.notification.unread').first().click()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Notifications', exact: true }).click()
    await expect(page.locator('.notification.unread')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('firebase-notifications.png'), fullPage: true })
  } finally {
    await secondContext.close()
  }
})

test('audit modal paginates real operations and filters actor/action text and result without raw payloads', async ({
  page,
}, info) => {
  // Seed this case through real authorized profile operations, without depending on earlier CRUD tests.
  const signedIn = await fetch(
    'http://127.0.0.1:19299/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=qa',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.ADMIN_QA_EMAIL,
        password: process.env.ADMIN_QA_PASSWORD,
        returnSecureToken: true,
      }),
    },
  )
  expect(signedIn.status).toBe(200)
  const { idToken } = await signedIn.json(),
    decoded = await auth.verifyIdToken(idToken)
  const request = (data: Record<string, unknown>) => ({
    data,
    auth: { uid: adminUid, token: decoded },
    rawRequest: { headers: { authorization: 'Bearer ' + idToken } },
  })
  let revision = (await api.adminGetProfile.run(request({}))).profile.revision
  for (let i = 0; i < 12; i++)
    await api.adminUpdateProfile.run(
      request({
        requestId: randomUUID(),
        name: 'Browser administrator',
        expectedRevision: revision++,
      }),
    )
  await enter(page)
  await page.getByRole('button', { name: 'English Battle', exact: true }).click()
  await page.getByRole('button', { name: 'Admin activity log', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Admin activity log' })
  await expect(dialog.locator('.timeline li')).toHaveCount(10)
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(dialog.locator('.timeline li').first()).toBeVisible()
  await dialog.getByRole('searchbox').fill('adminUpdateProfile')
  await expect(dialog.locator('.timeline strong').first()).toHaveText('adminUpdateProfile')
  await expect(dialog.locator('.timeline code').first()).toContainText(/^[a-f0-9]{64}$/)
  await dialog.getByRole('searchbox').fill('')
  await dialog.getByLabel('Audit result').selectOption('succeeded')
  await expect(dialog.locator('.timeline li').first()).toContainText('succeeded')
  await expect(dialog).not.toContainText('EmulatorOnly123!')
  await page.screenshot({ path: info.outputPath('firebase-audit.png'), fullPage: true })
})

test('Users exports all filtered rows with a UTF-8 BOM and formula-safe cells rather than only the current page', async ({
  page,
}, info) => {
  await auth.updateUser(process.env.ADMIN_QA_FORMULA_UID!, { displayName: '=CSV_QA("x")' })
  await syncAdminUserIndex(process.env.ADMIN_QA_FORMULA_UID!)
  await enter(page)
  await page.getByRole('searchbox', { name: 'Search by name, email or ID…' }).fill('qa-learner-')
  await expect(page.locator('tbody tr')).toHaveCount(10)
  await expect(page.getByText('Showing 1–10 of 11 users')).toBeVisible()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export report', exact: true }).click()
  const download = await downloaded,
    path = info.outputPath('firebase-users.csv')
  await download.saveAs(path)
  const bytes = readFileSync(path),
    text = bytes.toString('utf8')
  expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)
  expect(text.split('\r\n')).toHaveLength(12)
  expect(text).toContain(`'=CSV_QA(""x"")`)
  expect(text).not.toContain('EmulatorOnly123!')
  expect(text).not.toContain('correctOptionId')
  const reports = (await db.ref('adminReports').get()).val()
  expect(
    (Object.values(reports) as Array<{ uid: string; report: { total: number } }>).some(
      (r) => r.uid === adminUid && r.report.total === 11,
    ),
  ).toBe(true)
})
