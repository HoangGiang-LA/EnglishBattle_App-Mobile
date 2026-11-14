import { expect, test } from '@playwright/test'
import { mockFirebase } from './auth-fixture'

test('Notifications supports a reviewed coin gift on desktop and mobile', async ({
  page,
}, info) => {
  const auth = await mockFirebase(page)
  await page.goto('/')
  await page.getByLabel('Email address').fill(auth.email)
  await page.getByLabel('Password').fill(auth.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Total Users', { exact: true })).toBeVisible()
  const menu = page.getByRole('button', { name: 'Open navigation' })
  if (await menu.isVisible()) await menu.click()
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Notifications', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Coin gift/ }).click()
  await page.getByRole('checkbox').first().check()
  await page.getByLabel('Coins per account').fill('25')
  await page.getByLabel('Title', { exact: true }).fill('A little encouragement')
  await page
    .getByLabel('Message', { exact: true })
    .fill('Thanks for learning with English Battle. Here are 25 coins for your next milestone.')
  await page.getByLabel('Admin reason').fill('November learning gift')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)
  await page.screenshot({ path: info.outputPath('notifications.png'), fullPage: true })
  await page.getByRole('button', { name: 'Review send', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Review your send' })
  await expect(review.getByText('25 coins per account', { exact: true })).toBeVisible()
  const heading = await review.getByRole('heading', { name: 'Review your send' }).boundingBox()
  const titleLabel = await review
    .locator('dt')
    .filter({ hasText: /^Title$/ })
    .boundingBox()
  expect(Math.abs(heading!.x - titleLabel!.x)).toBeLessThanOrEqual(1)
  const backButton = await review.getByRole('button', { name: 'Back to edit' }).boundingBox()
  const sendButton = await review
    .getByRole('button', { name: 'Confirm send', exact: true })
    .boundingBox()
  expect(Math.abs(backButton!.y - sendButton!.y)).toBeLessThanOrEqual(1)
  expect(sendButton!.x).toBeGreaterThan(backButton!.x + backButton!.width)
  await page.screenshot({ path: info.outputPath('notifications-review.png') })
  await review.getByRole('button', { name: 'Confirm send', exact: true }).click()
  await expect(review).toBeHidden()
  await expect(
    page.getByRole('cell', { name: 'A little encouragement 25 coins / account' }),
  ).toBeVisible()
})
