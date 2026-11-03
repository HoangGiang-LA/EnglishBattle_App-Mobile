import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

if (
  process.env.GCLOUD_PROJECT !== 'demo-englishbattle-admin' ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:19299' ||
  process.env.FIREBASE_DATABASE_EMULATOR_HOST !== '127.0.0.1:19200'
) {
  throw new Error('Analytics browser QA requires isolated emulators.')
}
const require = createRequire(new URL('../../../Backend/functions/package.json', import.meta.url))
const { adminAuth: auth, adminDb: db } = require('./lib/config/firebaseAdmin.js')
const read = async (path: string) => (await db.ref(path).get()).val()
async function enter(page: Page, destination = 'Dashboard') {
  await page.goto('/')
  await page.getByLabel('Email address').fill(process.env.ADMIN_QA_EMAIL!)
  await page.getByLabel('Password', { exact: true }).fill(process.env.ADMIN_QA_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
  await page.getByRole('navigation').getByRole('link', { name: destination, exact: true }).click()
  await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible()
}
test.beforeEach(async () => {
  await auth.setCustomUserClaims(process.env.ADMIN_QA_ADMIN_UID!, { admin: true })
  await auth.updateUser(process.env.ADMIN_QA_ADMIN_UID!, { disabled: false })
})

test('Dashboard shows published server KPIs, switches calendar buckets and preserves real data through reload', async ({
  page,
}, info) => {
  await enter(page)
  await expect(
    page.locator('.stat-card').filter({ hasText: 'Total Users' }).locator('.stat-number'),
  ).toHaveText('12')
  await expect(
    page.locator('.stat-card').filter({ hasText: 'Active Users' }).locator('.stat-number'),
  ).toHaveText('3')
  await expect(page.getByRole('status')).toContainText('Data through')
  await expect(page.getByText('Learning session completed', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Weekly', exact: true }).click()
  await expect(page.getByRole('img', { name: /User growth, weekly/ })).toBeVisible()
  await page.getByRole('button', { name: 'Monthly', exact: true }).click()
  await expect(page.getByRole('img', { name: /User growth, monthly/ })).toBeVisible()
  await page.reload()
  await expect(
    page.locator('.stat-card').filter({ hasText: 'Total Users' }).locator('.stat-number'),
  ).toHaveText('12')
  await page.screenshot({ path: info.outputPath('firebase-dashboard.png'), fullPage: true })
  const source = await read(
    `practiceAttempts/${process.env.ADMIN_QA_STUDY_UID}/${process.env.ADMIN_QA_ATTEMPT_ID}`,
  )
  expect(source.status).toBe('completed')
  expect(source.correctCount).toBe(10)
})

test('Analytics filters mixed-skill membership while its chart uses actual answered questions', async ({
  page,
}, info) => {
  await enter(page, 'Analytics')
  await expect(page.getByRole('heading', { name: 'Answers by Skill' })).toBeVisible()
  await page.getByLabel('Analytics skill').selectOption('vocabulary')
  await expect(
    page.getByRole('img', { name: 'Skill distribution: 10 answered questions' }),
  ).toBeVisible()
  await expect(page.locator('.chart-caption').filter({ hasText: 'Accuracy:' })).toContainText(
    '100.0%',
  )
  await expect(page.getByText('Sample data · updated locally', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('firebase-analytics.png'), fullPage: true })
  await page.getByLabel('Analytics skill').selectOption('reading')
  await expect(
    page.getByRole('img', { name: 'Skill distribution: 0 answered questions' }),
  ).toBeVisible()
  await expect(page.locator('.chart-caption').filter({ hasText: 'Accuracy:' })).toContainText('N/A')
})

test('unpublished data reports an error and historical missing starts show N/A without a sample fallback', async ({
  page,
}) => {
  const control = await read('adminAnalyticsControl')
  const metaPath = `adminAnalyticsGenerationMeta/${control.activeGeneration}`
  const meta = await read(metaPath)
  try {
    await enter(page, 'Analytics')
    await expect(page.getByRole('status')).toContainText('Data through')
    await db.ref('adminAnalyticsControl/activeGeneration').remove()
    await page.getByRole('button', { name: 'Refresh statistics', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('tổng hợp đầy đủ')
    await expect(page.getByRole('img', { name: /Skill distribution/ })).toHaveCount(0)
    await db.ref('adminAnalyticsControl/activeGeneration').set(control.activeGeneration)
    await db.ref(metaPath).update({ unknownStartSessions: 1, latestUnknownStartEnd: Date.now() })
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('lack a start time')
    const caption = page.locator('.chart-caption').filter({ hasText: 'Accuracy:' })
    await expect(caption).toContainText('Completion: N/A')
  } finally {
    await db.ref('adminAnalyticsControl/activeGeneration').set(control.activeGeneration)
    await db.ref(metaPath).update({
      unknownStartSessions: meta.unknownStartSessions,
      latestUnknownStartEnd: meta.latestUnknownStartEnd,
    })
  }
})
