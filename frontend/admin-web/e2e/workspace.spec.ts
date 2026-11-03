import { expect, test, type Page } from '@playwright/test'
import { mockFirebase } from './auth-fixture'

async function enter(page: Page, credentials?: { email: string; password: string }) {
  const auth = credentials || (await mockFirebase(page))
  await page.goto('/')
  await page.getByLabel('Email address').fill(auth.email)
  await page.getByLabel('Password').fill(auth.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Total Users', { exact: true })).toBeVisible()
}
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open navigation' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation').getByRole('link', { name, exact: true }).click()
}

test('all five design pages render without browser errors or page overflow', async ({
  page,
}, info) => {
  const errors: string[] = [],
    external: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('request', (r) => {
    if (
      /^https?:/.test(r.url()) &&
      !['127.0.0.1', 'identitytoolkit.googleapis.com'].includes(new URL(r.url()).hostname) &&
      r.url() !==
        'https://asia-southeast1-englishbattleapp-8d764.cloudfunctions.net/ensureUserProfile'
    )
      external.push(r.url())
  })
  const credentials = await mockFirebase(page)
  await page.goto('/')
  await page.screenshot({ path: info.outputPath('login.png'), fullPage: true })
  await enter(page, credentials)
  for (const [nav, title, ready] of [
    ['Dashboard', 'Dashboard', 'Recent Activities'],
    ['Users', 'User Management', 'All users'],
    ['Content', 'Question & Content', 'All questions'],
    ['Battles', 'Battle & Moderation', 'Recent matches'],
    ['Analytics', 'Analytics', 'Most Popular Categories'],
  ]) {
    await navigate(page, nav)
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(page.getByText(ready, { exact: true })).toBeVisible()
    await page.waitForTimeout(100)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    await page.screenshot({
      path: info.outputPath(`${nav.toLowerCase()}.png`),
      fullPage: true,
    })
  }
  expect(errors).toEqual([])
  expect(external).toEqual([])
})

test('user edits survive a browser reload and deletion requires explicit confirmation', async ({
  page,
}) => {
  await enter(page)
  await navigate(page, 'Users')
  await page.getByRole('button', { name: 'Add User', exact: true }).click()
  await page.getByLabel('Full name').fill('Browser QA Learner')
  await page.getByLabel('Email address').fill('browser-qa@example.test')
  await page.getByRole('dialog').getByRole('button', { name: 'Add user', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.reload()
  await page
    .getByRole('searchbox', { name: 'Search by name, email or ID…' })
    .fill('browser-qa@example.test')
  await expect(page.getByRole('button', { name: 'Edit Browser QA Learner' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit Browser QA Learner' }).click()
  await page.getByLabel('Full name').fill('Browser QA Edited')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('button', { name: 'Delete Browser QA Edited' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Delete user', exact: true })).toBeDisabled()
  await dialog.getByLabel('Reason').fill('Browser QA cleanup request')
  await dialog.getByLabel(/Type #\d+ to confirm/).fill('#24893')
  await dialog.getByRole('button', { name: 'Delete user', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No users found' })).toBeVisible()
})

test('question editor fits the viewport and publishes a validated question', async ({
  page,
}, info) => {
  await enter(page)
  await navigate(page, 'Content')
  await page.getByRole('button', { name: 'Add Question', exact: true }).click()
  await page.getByLabel('Question text', { exact: true }).fill('What is the opposite of cold?')
  for (const [i, text] of ['Hot', 'Blue', 'Small', 'Slow'].entries())
    await page.getByLabel(`Option ${String.fromCharCode(65 + i)} text`, { exact: true }).fill(text)
  await page.getByRole('radio', { name: 'Option A is correct', exact: true }).check()
  await page.getByLabel('Answer explanation').fill('Hot is the opposite of cold.')
  await page.getByLabel('Publication status').selectOption('published')
  await page.screenshot({
    path: info.outputPath('question-editor.png'),
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Learner preview' }).click()
  await expect(page.getByText('Hot is the opposite of cold.')).not.toBeVisible()
  await expect(page.getByRole('heading', { name: 'What is the opposite of cold?' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to details' }).click()
  await page.getByRole('button', { name: 'Save question', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page
    .getByRole('searchbox', { name: 'Search by question text or ID…' })
    .fill('What is the opposite of cold?')
  await expect(page.getByRole('button', { name: 'What is the opposite of cold?' })).toBeVisible()
})

test('battle log, date filters, notifications and report download work', async ({ page }, info) => {
  await enter(page)
  await navigate(page, 'Battles')
  await page.getByLabel('Battle mode').selectOption('private')
  await page.getByRole('button', { name: 'View logs #B18640' }).click()
  await expect(page.getByText('Room created with a fixed set of 10 questions.')).toBeVisible()
  await page.screenshot({ path: info.outputPath('battle-log.png'), fullPage: true })
  await page.getByRole('button', { name: 'Close log' }).click()
  await navigate(page, 'Analytics')
  await page.getByLabel('Quick date range').selectOption('180')
  await expect(page.getByText('Most Popular Categories')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export report' }).click()
  expect((await download).suggestedFilename()).toMatch(/english-battle-demo-analytics.*\.csv$/)
  await page.getByRole('button', { name: 'Notifications, 2 unread' }).click()
  await page.getByRole('button', { name: 'Mark all read' }).click()
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
})

test('recoverable error, modal keyboard focus and audio validation work', async ({ page }) => {
  await enter(page)
  await page.getByRole('button', { name: 'Preview details' }).click()
  await page.getByRole('button', { name: 'Preview loading error' }).click()
  await expect(page.getByRole('heading', { name: 'We couldn’t load this data' })).toBeVisible()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('Total Users', { exact: true })).toBeVisible()
  await navigate(page, 'Content')
  await page.getByRole('button', { name: 'Add Question', exact: true }).click()
  await page.getByLabel('Skill', { exact: true }).selectOption('listening')
  await page.getByLabel('Upload audio', { exact: true }).setInputFiles({
    name: 'not-audio.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not audio'),
  })
  await expect(page.getByRole('alert')).toHaveText('Choose an audio file.')
  await page.getByLabel('Upload audio', { exact: true }).setInputFiles({
    name: 'large.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
  })
  await expect(page.getByRole('alert')).toHaveText(
    'Choose an audio file smaller than 2 MB for this local preview.',
  )
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Save question', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused()
  page.once('dialog', async (d) => d.accept())
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await page.getByRole('button', { name: 'Add Question', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})
