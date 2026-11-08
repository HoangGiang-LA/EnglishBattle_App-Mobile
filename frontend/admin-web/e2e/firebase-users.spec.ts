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

async function readyUsers(page: Page) {
  // A transient emulator read error must be recovered through the actual UI Retry control.
  await expect(async () => {
    const panel = page.locator('.data-panel')
    const retry = panel.getByRole('button', { name: 'Try again', exact: true })
    if (await retry.isVisible()) await retry.click()
    await expect(panel.locator('tbody tr').first()).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 65000, intervals: [250, 1000] })
}
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
  await readyUsers(page)
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
  await readyUsers(page)
  await page.getByRole('button', { name: `Edit ${name} updated`, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Ban user', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('Reason').fill('Browser QA account restriction')
  await dialog.getByRole('button', { name: 'Ban user', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect((await auth.getUser(created.uid)).disabled).toBe(true)
  await readyUsers(page)
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

test('a response lost after commit keeps the user form and retries the same operation exactly once', async ({
  page,
}) => {
  const email = 'qa-learner-8@example.test'
  const existing = await auth.getUserByEmail(email)
  const original = existing.displayName!
  const changed = original + ' retry verified'
  const requests: string[] = [],
    revisions: number[] = []
  let operationId = '',
    loseResponse = true
  await enter(page)
  await search(page, email)
  await readyUsers(page)
  await page.getByRole('button', { name: 'Edit ' + original, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Full name').fill(changed)
  await page.route('**/asia-southeast1/adminSaveUser', async (route) => {
    const payload = route.request().postDataJSON().data
    requests.push(payload.requestId)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const result = (await response.json()).result
    operationId = result.operationId
    revisions.push(result.user.revision)
    if (loseResponse) {
      loseResponse = false
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { status: 'UNAVAILABLE', message: 'QA lost response after commit' },
        }),
      })
    } else await route.fulfill({ response })
  })
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByLabel('Full name')).toHaveValue(changed)
  await expect(page.getByText('User updated in Firebase.', { exact: true })).toHaveCount(0)
  expect((await auth.getUser(existing.uid)).displayName).toBe(changed)
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(requests).toHaveLength(2)
  expect(requests[0]).toBe(requests[1])
  expect(revisions[0]).toBe(revisions[1])
  expect((await read('adminOperations/' + operationId)).phase).toBe('succeeded')
  expect((await read('adminAudit/' + operationId)).operationId).toBe(operationId)
  await readyUsers(page)
  await page.getByRole('button', { name: 'Edit ' + changed, exact: true }).click()
  await page.getByRole('dialog').getByLabel('Full name').fill(original)
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
})

test('two browser editors show a version conflict and keep the second form without overwriting Firebase', async ({
  page,
  browser,
}) => {
  const email = 'qa-learner-7@example.test'
  const original = (await auth.getUserByEmail(email)).displayName!
  const second = await browser.newContext({ baseURL: 'http://127.0.0.1:15173' })
  const other = await second.newPage()
  try {
    await enter(page)
    await enter(other)
    for (const view of [page, other]) {
      await search(view, email)
      await readyUsers(view)
      await view.getByRole('button', { name: 'Edit ' + original, exact: true }).click()
    }
    await page
      .getByRole('dialog')
      .getByLabel('Full name')
      .fill(original + ' first')
    await other
      .getByRole('dialog')
      .getByLabel('Full name')
      .fill(original + ' second')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save changes', exact: true })
      .click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await other
      .getByRole('dialog')
      .getByRole('button', { name: 'Save changes', exact: true })
      .click()
    await expect(other.getByRole('dialog').getByRole('alert')).toContainText('người khác')
    await expect(other.getByRole('dialog').getByLabel('Full name')).toHaveValue(
      original + ' second',
    )
    expect((await auth.getUserByEmail(email)).displayName).toBe(original + ' first')
    other.once('dialog', (dialog) => dialog.accept())
    await other.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    // The list snapshot is older; opening Edit must read the latest record and revision.
    await readyUsers(other)
    await other.getByRole('button', { name: 'Edit ' + original, exact: true }).click()
    await expect(other.getByRole('dialog').getByLabel('Full name')).toHaveValue(original + ' first')
    await other.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await readyUsers(page)
    await page.getByRole('button', { name: 'Edit ' + original + ' first', exact: true }).click()
    await page.getByRole('dialog').getByLabel('Full name').fill(original)
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save changes', exact: true })
      .click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
  } finally {
    await second.close()
  }
})
