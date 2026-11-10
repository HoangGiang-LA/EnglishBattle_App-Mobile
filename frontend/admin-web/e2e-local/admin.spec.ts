import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import {
  assertEmulators,
  connectLocalFirebase,
  signIn,
  callable,
} from '../../../Backend/server/tools/local-config.mjs'
import { deleteApp } from '../../../Backend/server/node_modules/firebase-admin/lib/app/index.js'
const prefix = `e2e_admin_${randomUUID().replaceAll('-', '')}`
const questions = new Set<string>(),
  createdUsers = new Set<string>()
const writes = new Map<string, { actor: string; action: string; id: string; at: number }>()
let local: ReturnType<typeof connectLocalFirebase>
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const actions: Record<string, string> = {
  adminSaveQuestion: 'question_save',
  adminSaveUser: 'user_create',
  adminArchiveQuestion: 'question_archive',
}

test.beforeAll(async () => {
  await assertEmulators()
  local = connectLocalFirebase()
  const catalog = await callable('adminGetCatalog', await signIn('admin@example.test'))
  expect(catalog.status).toBe(200)
})
test.afterAll(async () => {
  try {
    const updates: Record<string, null> = {}
    for (const id of questions)
      for (const root of [
        'questions',
        'questionVersions',
        'questionAnswers',
        'adminViews/questions',
      ])
        updates[`${root}/${id}`] = null
    for (const uid of createdUsers)
      for (const root of [
        'users',
        'userPrivate',
        'accountAccess',
        'userStats',
        'wallets',
        'userSettings',
      ])
        updates[`${root}/${uid}`] = null
    for (const op of writes.values()) {
      const path = `adminOperations/${op.actor}/${op.action}/${op.id}`,
        logId = hash(path),
        day = new Date(op.at + 7 * 3600000).toISOString().slice(0, 10)
      updates[path] = null
      updates[`adminAuditRecent/${logId}`] = null
      updates[`adminAuditLogs/${day}/${logId}`] = null
    }
    await local.database.ref().update(updates)
    for (const uid of createdUsers)
      await local.auth.deleteUser(uid).catch((e: { code?: string }) => {
        if (e.code !== 'auth/user-not-found') throw e
      })
  } finally {
    await deleteApp(local.app)
  }
})
test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(20000)
  page.setDefaultNavigationTimeout(30000)
  await page.route('**/*', (route) =>
    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  )
  page.on('request', (req) => {
    const name = req.url().split('/').at(-1) || '',
      action = actions[name]
    if (req.method() === 'POST' && action) {
      const payload = req.postDataJSON()?.data
      if (payload?.requestId) {
        writes.set(payload.requestId, {
          actor: 'local-admin',
          action,
          id: payload.requestId,
          at: Date.now(),
        })
        if (
          name === 'adminSaveQuestion' &&
          !payload.id &&
          payload.input?.prompt?.startsWith(prefix)
        )
          questions.add('q_' + hash(['local-admin', payload.requestId]).slice(0, 24))
        if (
          name === 'adminSaveUser' &&
          !payload.id &&
          payload.input?.email === prefix + '@example.test'
        )
          createdUsers.add('adm_' + hash(['local-admin', payload.requestId]).slice(0, 28))
      }
    }
  })
})
async function login(page: import('@playwright/test').Page, email = 'admin@example.test') {
  await page.goto('/')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('LocalDemo123!')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
test('admin creates and edits a real question; reload persists; stale version is rejected', async ({
  page,
}) => {
  await login(page)
  await expect(page.getByText('Firebase workspace', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Content', exact: true }).click()
  await page.getByRole('button', { name: 'Add Question', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Topic', { exact: true }).selectOption('vocabulary_daily_life')
  await dialog.getByLabel('Question text').fill(prefix + ' Question one?')
  for (const [i, label] of ['A', 'B', 'C', 'D'].entries())
    await dialog.getByLabel(`Option ${label} text`, { exact: true }).fill('Choice ' + (i + 1))
  await dialog.getByLabel('Option A is correct', { exact: true }).check()
  await dialog.getByLabel('Answer explanation').fill('E2E fixture explanation')
  const createResponse = page.waitForResponse(
    (r) => r.url().endsWith('/adminSaveQuestion') && r.request().method() === 'POST',
    { timeout: 70000 },
  )
  await dialog.getByRole('button', { name: 'Save question', exact: true }).click()
  const createdResponse = await createResponse
  expect(createdResponse.status()).toBe(200)
  expect((await createdResponse.json()).result.question.version).toBe(1)
  await expect(dialog).not.toBeVisible()
  await page.getByRole('searchbox').fill(prefix)
  await expect(
    page.getByRole('button', { name: prefix + ' Question one?', exact: true }),
  ).toBeVisible()
  const stored = await page.evaluate(async (q) => {
    const { FirebaseAdminService } = await import('/src/data/firebase-service.ts')
    const api = new FirebaseAdminService()
    return (await api.questions({ q })).items[0]
  }, prefix)
  questions.add(stored.id)
  expect(stored.version).toBe(1)
  await page.getByRole('button', { name: prefix + ' Question one?', exact: true }).click()
  const editPrompt = page.getByRole('dialog').getByLabel('Question text', { exact: true })
  await editPrompt.fill(prefix + ' Question edited?')
  await expect(editPrompt).toHaveValue(prefix + ' Question edited?')
  await page.getByRole('button', { name: 'Learner preview', exact: true }).click()
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: prefix + ' Question edited?', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Question details', exact: true }).click()
  const updateResponse = page.waitForResponse(
    (r) => r.url().endsWith('/adminSaveQuestion') && r.request().method() === 'POST',
    { timeout: 70000 },
  )
  await page.getByRole('button', { name: 'Save question', exact: true }).click()
  const editedResponse = await updateResponse
  expect(editedResponse.request().postDataJSON().data.input.prompt).toBe(
    prefix + ' Question edited?',
  )
  expect(editedResponse.status()).toBe(200)
  expect((await editedResponse.json()).result.question.version).toBe(2)
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.reload()
  await expect(page.getByText('Firebase workspace', { exact: true })).toBeVisible()
  const persistedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith('/adminListQuestions') &&
      r.request().method() === 'POST' &&
      r.request().postDataJSON()?.data?.query?.q === prefix,
    { timeout: 70000 },
  )
  await page.getByRole('searchbox').fill(prefix)
  const persisted = await persistedResponse
  expect(persisted.status()).toBe(200)
  const persistedQuestion = (await persisted.json()).result.page.items.find(
    (q: { id: string }) => q.id === stored.id,
  )
  expect(persistedQuestion.prompt).toBe(prefix + ' Question edited?')
  expect(persistedQuestion.version).toBe(2)
  await expect(
    page.getByRole('button', { name: prefix + ' Question edited?', exact: true }),
  ).toBeVisible({ timeout: 20000 })
  const result = await page.evaluate(async (id) => {
    const { FirebaseAdminService } = await import('/src/data/firebase-service.ts')
    const api = new FirebaseAdminService(),
      record = await api.question(id)
    const {
      id: _id,
      code: _code,
      version: _version,
      createdAt: _created,
      updatedAt: _updated,
      ...input
    } = record
    try {
      await api.saveQuestion(input, id, 1)
      return { version: record.version, code: 'unexpected-success' }
    } catch (e) {
      return {
        version: record.version,
        code: typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : 'unknown',
      }
    }
  }, stored.id)
  expect(result).toEqual({ version: 2, code: 'functions/aborted' })
  await page.screenshot({ path: 'test-results/admin-api-question-persisted.png', fullPage: true })
})
test('Add User creates a real learner using its own initial password', async ({ page }) => {
  await login(page)
  await expect(page.getByText('Firebase workspace', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Users', exact: true }).click()
  await page.getByRole('button', { name: 'Add User', exact: true }).click()
  const dialog = page.getByRole('dialog'),
    email = prefix + '@example.test'
  await dialog.getByLabel('Full name').fill(prefix + ' Learner')
  await dialog.getByLabel('Email address').fill(email)
  await dialog.getByLabel('Initial password').fill('FixtureOnly123!')
  const createUserResponse = page.waitForResponse(
    (r) => r.url().endsWith('/adminSaveUser') && r.request().method() === 'POST',
    { timeout: 70000 },
  )
  await dialog.getByRole('button', { name: 'Add user', exact: true }).click()
  expect((await createUserResponse).status()).toBe(200)
  await expect(dialog).not.toBeVisible()
  const account = await local.auth.getUserByEmail(email)
  createdUsers.add(account.uid)
  expect(account.customClaims?.admin).not.toBe(true)
  expect((await local.database.ref(`wallets/${account.uid}/coinBalance`).get()).val()).toBe(0)
  await page.getByRole('searchbox').fill(email)
  await expect(page.getByText(email, { exact: true })).toBeVisible()
})
test('learner cannot access the workspace or admin callable even through the SDK', async ({
  page,
}) => {
  await login(page, 'learner@example.test')
  await expect(page.getByRole('heading', { name: 'Administrator access required' })).toBeVisible()
  const code = await page.evaluate(async () => {
    const { FirebaseAdminService } = await import('/src/data/firebase-service.ts')
    try {
      await new FirebaseAdminService().questions({})
      return 'unexpected-success'
    } catch (e) {
      return typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : 'unknown'
    }
  })
  expect(code).toBe('functions/permission-denied')
  await expect(page.getByRole('navigation')).not.toBeVisible()
})
