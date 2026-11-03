import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

if (
  process.env.GCLOUD_PROJECT !== 'demo-englishbattle-admin' ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:19299' ||
  process.env.FIREBASE_DATABASE_EMULATOR_HOST !== '127.0.0.1:19200'
) {
  throw new Error('Content browser QA requires the isolated admin emulator launcher.')
}
const require = createRequire(new URL('../../../Backend/functions/package.json', import.meta.url))
const { adminAuth: auth, adminDb: db } = require('./lib/config/firebaseAdmin.js')
const read = async (path: string) => (await db.ref(path).get()).val()
const adminUid = process.env.ADMIN_QA_ADMIN_UID!
async function enter(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email address').fill(process.env.ADMIN_QA_EMAIL!)
  await page.getByLabel('Password', { exact: true }).fill(process.env.ADMIN_QA_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
  await page.getByRole('navigation').getByRole('link', { name: 'Content', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'All questions', exact: true })).toBeVisible()
}
test.beforeEach(async () => {
  await auth.setCustomUserClaims(adminUid, { admin: true })
  await auth.updateUser(adminUid, { disabled: false })
})

test('Content creates, reloads, edits and archives a real question while retaining old versions', async ({
  page,
}, info) => {
  const prompt = `Browser content ${randomUUID().slice(0, 8)}`
  await enter(page)
  await page.getByRole('button', { name: 'Add Question', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('Topic', { exact: true }).selectOption('vocabulary_daily_life')
  await dialog.getByLabel('Lesson', { exact: true }).selectOption('lesson_vocabulary_daily_life')
  await dialog.getByLabel('Question text', { exact: true }).fill(prompt)
  for (const [i, value] of ['One', 'Two', 'Three', 'Four'].entries())
    await dialog
      .getByLabel(`Option ${String.fromCharCode(65 + i)} text`, { exact: true })
      .fill(value)
  await dialog.getByRole('radio', { name: 'Option A is correct', exact: true }).check()
  await dialog.getByLabel('Answer explanation').fill('The first option is correct.')
  await dialog.getByLabel('Publication status').selectOption('published')
  await dialog.getByRole('button', { name: 'Save question', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.reload()
  await page.getByRole('searchbox', { name: 'Search by question text or ID…' }).fill(prompt)
  await page.getByRole('button', { name: prompt, exact: true }).click()
  dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Version 1/)).toBeVisible()
  const question = Object.entries(
    (await read('adminQuestionIndex')) as Record<string, { prompt: string }>,
  ).find(([, q]) => q.prompt === prompt)
  expect(question).toBeTruthy()
  const id = question![0],
    old = await read(`questionVersions/${id}/v1`)
  await dialog.getByLabel('Question text', { exact: true }).fill(`${prompt} edited`)
  await dialog.getByRole('button', { name: 'Save question', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: `${prompt} edited`, exact: true })).toBeVisible()
  expect(await read(`questions/${id}/currentVersion`)).toBe('v2')
  expect(await read(`questionVersions/${id}/v1`)).toEqual(old)
  await page.screenshot({ path: info.outputPath('firebase-content.png'), fullPage: true })
  await page.getByRole('button', { name: `Archive Q-${id}`, exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Archive question', exact: true })
    .click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByRole('button', { name: `Archive Q-${id}`, exact: true })).toBeDisabled()
  expect(await read(`questions/${id}/currentVersion`)).toBe('v3')
  expect(await read(`questions/${id}/status`)).toBe('archived')
})

test('Content saves real topic and lesson metadata and shows a concurrent revision conflict without closing the form', async ({
  page,
}) => {
  const title = `Browser topic ${randomUUID().slice(0, 8)}`
  await enter(page)
  await page.getByRole('tab', { name: /^Topics/ }).click()
  await page.getByRole('button', { name: 'Add Topic', exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByRole('dialog').getByRole('button', { name: 'Save content', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: /^Topics/ }).click()
  await page.getByRole('searchbox').fill(title)
  await page.getByRole('button', { name: title, exact: true }).click()
  const topics = await read('topics')
  const id = Object.keys(topics).find((id) => topics[id].title === title)!
  expect(topics[id].revision).toBe(1)
  await db.ref(`topics/${id}`).update({ revision: 2, title: `${title} remote` })
  await page.getByLabel('Title', { exact: true }).fill(`${title} local`)
  await page.getByRole('dialog').getByRole('button', { name: 'Save content', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('người khác')
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(`${title} local`)
  expect(await read(`topics/${id}/title`)).toBe(`${title} remote`)
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('tab', { name: /^Lessons/ }).click()
  await page.getByRole('button', { name: 'Add Lesson', exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill(`${title} lesson`)
  await page.getByLabel('Topic', { exact: true }).selectOption(id)
  await page.getByRole('dialog').getByRole('button', { name: 'Save content', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  const lessons = await read('lessons')
  const lessonId = Object.keys(lessons).find((key) => lessons[key].title === `${title} lesson`)!
  expect(lessons[lessonId].categoryId).toBe('vocabulary')
})

test('Listening exposes TTS only and rejects publication while its text is missing', async ({
  page,
}) => {
  await enter(page)
  await page.getByRole('button', { name: 'Add Question', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Skill', { exact: true }).selectOption('listening')
  await expect(dialog.getByLabel('Text to read aloud')).toBeVisible()
  await expect(dialog.getByLabel('HTTPS audio URL')).toHaveCount(0)
  await expect(dialog.getByLabel('Upload audio')).toHaveCount(0)
  await dialog.getByLabel('Publication status').selectOption('published')
  await expect(dialog.getByLabel('Text to read aloud')).toHaveAttribute('required', '')
})
