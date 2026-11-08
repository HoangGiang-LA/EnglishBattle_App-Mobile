import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

if (
  process.env.GCLOUD_PROJECT !== 'demo-englishbattle-admin' ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:19299' ||
  process.env.FIREBASE_DATABASE_EMULATOR_HOST !== '127.0.0.1:19200'
) {
  throw new Error('Firebase browser QA requires the isolated admin emulator launcher.')
}
const require = createRequire(new URL('../../../Backend/functions/package.json', import.meta.url))
const { adminAuth: auth, adminDb: db } = require('./lib/config/firebaseAdmin.js')
const adminEmail = process.env.ADMIN_QA_EMAIL!
const password = process.env.ADMIN_QA_PASSWORD!
const adminUid = process.env.ADMIN_QA_ADMIN_UID!
const read = async (path: string) => (await db.ref(path).get()).val()

async function enter(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email address').fill(adminEmail)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
  await expect(page.getByText('Firebase workspace', { exact: true })).toBeVisible()
  await expect(page.locator('tbody tr').first()).toBeVisible()
}
async function search(page: Page, text: string) {
  await page.getByRole('searchbox', { name: 'Search by name, email or ID…' }).fill(text)
  await expect(page.getByText('Loading users…')).not.toBeVisible()
}
test.beforeEach(async () => {
  // Functional cases are isolated from the quota consumed by preceding browser cases and warmup.
  // This file has already asserted the dedicated demo project and emulator hosts.
  await db.ref('adminRateLimits').remove()
  await auth.setCustomUserClaims(adminUid, { admin: true })
  await auth.updateUser(adminUid, { disabled: false })
})

test('real UI creates, reloads, edits, bans, reopens and soft-deletes one Firebase user', async ({
  page,
  browser,
}) => {
  const name = `Browser learner ${randomUUID().slice(0, 8)}`
  const email = `browser-${randomUUID()}@example.test`
  await enter(page)
  await page.getByRole('button', { name: 'Add User', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('Full name').fill(name)
  await dialog.getByLabel('Email address').fill(email)
  await dialog.getByRole('button', { name: 'Add user', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const created = await auth.getUserByEmail(email)
  expect(await read(`wallets/${created.uid}/coinBalance`)).toBe(0)
  expect(await read(`userSettings/${created.uid}/language`)).toBe('vi')
  await search(page, email)
  await expect(page.getByRole('button', { name: `Edit ${name}`, exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
  await search(page, email)
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('Full name').fill(`${name} updated`)
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect((await auth.getUser(created.uid)).displayName).toBe(`${name} updated`)

  const second = await browser.newContext({ baseURL: 'http://127.0.0.1:15173' })
  const other = await second.newPage()
  await enter(other)
  await search(other, email)
  await expect(
    other.getByRole('button', { name: `Edit ${name} updated`, exact: true }),
  ).toBeVisible()
  await second.close()
  await page.getByRole('button', { name: `Edit ${name} updated`, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Ban user', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('Reason').fill('Browser QA account restriction')
  await dialog.getByRole('button', { name: 'Ban user', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect((await auth.getUser(created.uid)).disabled).toBe(true)
  await page.getByRole('button', { name: `Edit ${name} updated`, exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Restore access', exact: true })
    .click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('Reason').fill('Browser QA account reopening')
  await dialog.getByRole('button', { name: 'Restore access', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect((await auth.getUser(created.uid)).disabled).toBe(false)
  await page.getByRole('button', { name: `Delete ${name} updated`, exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('Reason').fill('Browser QA requested soft deletion')
  await dialog.getByLabel(`Type EB-${created.uid} to confirm`).fill(`EB-${created.uid}`)
  await dialog.getByRole('button', { name: 'Delete user', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(await read(`accountAccess/${created.uid}/status`)).toBe('deleted')
  expect(await read(`userPrivate/${created.uid}/email`)).toBe('')
  expect((await auth.getUser(created.uid)).disabled).toBe(true)
})

test('real profile saves survive reload; real mode has no demo reset and opens the real Dashboard', async ({
  page,
}) => {
  await enter(page)
  await page
    .getByRole('button', { name: /QA administrator|Browser administrator/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: 'Profile & workspace' })
  await expect(dialog.getByRole('button', { name: 'Reset demo data' })).toHaveCount(0)
  await dialog.getByLabel('Display name').fill('Browser administrator')
  await dialog.getByRole('button', { name: 'Save profile' }).click()
  await expect(dialog).not.toBeVisible()
  expect((await auth.getUser(adminUid)).displayName).toBe('Browser administrator')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
  await expect(page.getByText('Browser administrator', { exact: true }).first()).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Dashboard', exact: true })
    .click()
  await expect(page.getByText('Total Users', { exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Data through')
  await page.getByRole('button', { name: /^Notifications/ }).click()
  await expect(
    page.locator('.notifications-panel').getByText('New account registered').first(),
  ).toBeVisible()
  await expect(page.locator('.notifications-panel').getByRole('alert')).toHaveCount(0)
})

test('permission loss while the workspace is open signs out instead of retaining the admin screen', async ({
  page,
}) => {
  await enter(page)
  await auth.setCustomUserClaims(adminUid, {})
  await search(page, 'permission-check')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText(/thu hồi|quản trị|khóa/)
})
