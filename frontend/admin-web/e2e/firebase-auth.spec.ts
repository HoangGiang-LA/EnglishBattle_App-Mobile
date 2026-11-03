import { expect, test } from '@playwright/test'
import { mockFirebase } from './auth-fixture'

test('recovers from an outdated sign-in module after reloading the page', async ({ page }) => {
  let failImport = true
  await page.route('https://**/*', (route) => route.abort())
  await page.route('**/src/firebase/client.ts*', async (route) => {
    if (failImport) {
      failImport = false
      await route.fulfill({
        status: 504,
        contentType: 'text/javascript',
        body: '// Outdated Optimize Dep',
      })
    } else await route.continue()
  })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Reload this page')
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Reload page', exact: true }).click(),
  ])
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()
  await expect(page.getByRole('alert')).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Open demo workspace' })).not.toBeVisible()
})

test('Firebase SDK sends sign-in and displays provider setup errors', async ({ page }) => {
  let requestEmail = ''
  await page.route('https://**/*', (route) => route.abort())
  await page.route('https://identitytoolkit.googleapis.com/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/accounts:signInWithPassword')) {
      requestEmail = route.request().postDataJSON().email
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 400, message: 'OPERATION_NOT_ALLOWED' } }),
      })
    } else await route.abort()
  })
  await page.goto('/')
  await page.getByLabel('Email address').fill('sdk-test@example.test')
  await page.getByLabel('Password').fill('not-a-real-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Enable it in Firebase Authentication')
  expect(requestEmail).toBe('sdk-test@example.test')
  await expect(page.getByLabel('Password')).toHaveValue('')
  await expect(page.getByRole('navigation')).not.toBeVisible()
})

test('non-admin sessions stay outside the workspace, including after reload', async ({ page }) => {
  const auth = await mockFirebase(page, { admin: false })
  await page.goto('/')
  await page.getByLabel('Email address').fill(auth.email)
  await page.getByLabel('Password').fill(auth.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Administrator access required' })).toBeVisible()
  await expect(page.getByRole('navigation')).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Open demo workspace' })).not.toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Administrator access required' })).toBeVisible()
  expect(auth.backendChecks()).toBe(0)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
})

test('verified admin sign-in opens Dashboard, restores the page and signs out of Firebase', async ({
  page,
}, info) => {
  const auth = await mockFirebase(page)
  await page.goto('/#/content')
  await page.getByLabel('Email address').fill(auth.email)
  await page.getByLabel('Password').fill(auth.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  await expect(page.getByText('Total Users', { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('verified-admin-dashboard.png'), fullPage: true })
  await expect(page.getByRole('button', { name: 'Open demo workspace' })).not.toBeVisible()
  await expect(page.getByText('SDK Test User', { exact: true })).toBeVisible()
  expect(auth.backendChecks()).toBeGreaterThan(0)
  expect(auth.callOrder[0]).toBe('ensureUserProfile')
  const menu = page.getByRole('button', { name: 'Open navigation' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation').getByRole('link', { name: 'Users', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'User Management', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'User Management', exact: true })).toBeVisible()
  expect(auth.backendChecks()).toBeGreaterThan(1)
  await page.getByRole('button', { name: 'English Battle', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.getByRole('navigation')).not.toBeVisible()
})

test('a cached admin claim does not open Dashboard when the backend denies access', async ({
  page,
}) => {
  const auth = await mockFirebase(page, { admin: true, allowAdmin: false })
  await page.goto('/')
  await page.getByLabel('Email address').fill(auth.email)
  await page.getByLabel('Password').fill(auth.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Administrator access was denied')
  await expect(page.getByRole('navigation')).not.toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).not.toBeVisible()
})
