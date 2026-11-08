import { describe, expect, it } from 'vitest'
import { MockAdminService } from '../data/mock-service'
import { createSeed } from '../data/seed'
import { calculateOverview } from '../data/metrics'
import { csvText, defaultRange } from '../lib'

describe('Demo admin workflows', () => {
  it('creates, edits and restores users from browser storage without permitting duplicate email', async () => {
    const api = new MockAdminService(localStorage, 0)
    const u = await api.saveUser({ name: 'New Learner', email: 'learner-new@example.test' })
    expect(u.rating).toBe(0)
    expect(u.coins).toBe(0)
    await expect(
      api.saveUser({ name: 'Another Learner', email: 'LEARNER-NEW@example.test' }),
    ).rejects.toThrow('already used')
    await api.saveUser({ name: 'Updated Learner', email: 'learner-new@example.test' }, u.id)
    const reloaded = new MockAdminService(localStorage, 0)
    expect((await reloaded.users({ q: 'Updated Learner' })).total).toBe(1)
    expect((await reloaded.audit()).items.map((a) => a.action)).toEqual([
      'user.update',
      'user.create',
    ])
  })
  it('requires a reason for account actions and preserves anonymized battle references on deletion', async () => {
    const api = new MockAdminService(undefined, 0),
      first = (await api.users({})).items[0]
    await expect(api.setUserStatus(first.id, 'banned', '')).rejects.toThrow('reason')
    await api.setUserStatus(first.id, 'banned', 'Policy violation')
    expect((await api.user(first.id)).status).toBe('banned')
    await api.setUserStatus(first.id, 'active', 'Appeal reviewed')
    await api.setUserStatus(first.id, 'deleted', 'Deletion requested')
    expect((await api.user(first.id)).email).toBe('')
    expect((await api.battles({})).items.find((b) => b.player1 === first.id)?.player1Name).toBe(
      'Deleted user',
    )
    await expect(
      api.saveUser({ name: 'Restore', email: 'a@example.test' }, first.id),
    ).rejects.toThrow('Deleted')
  })
  it('combines filters, clamps pagination and exports every filtered row instead of just the visible page', async () => {
    const api = new MockAdminService(undefined, 0),
      query = { categoryId: 'vocabulary', status: 'published', pageSize: 10, page: 999 }
    const page = await api.questions(query),
      report = await api.exportReport('questions', query, defaultRange())
    expect(page.page).toBe(Math.ceil(page.total / 10))
    expect(page.items.every((q) => q.categoryId === 'vocabulary' && q.status === 'published')).toBe(
      true,
    )
    expect(report.rows).toHaveLength(page.total)
    expect(report.rows.length).toBeGreaterThan(page.items.length)
  })
  it('checks question relationships, distinct options and correct answer; detects stale concurrent edits', async () => {
    const api = new MockAdminService(undefined, 0),
      q = (await api.questions({ categoryId: 'vocabulary', status: 'published' })).items[0]
    await expect(
      api.saveQuestion(
        { ...q, options: q.options.map((o) => ({ ...o, text: 'same' })) },
        q.id,
        q.version,
      ),
    ).rejects.toThrow('distinct')
    await expect(
      api.saveQuestion({ ...q, correctOptionId: 'missing' }, q.id, q.version),
    ).rejects.toThrow('correct answer')
    await expect(
      api.saveQuestion({ ...q, categoryId: 'grammar' }, q.id, q.version),
    ).rejects.toThrow('topic')
    const result = await Promise.allSettled([
      api.saveQuestion({ ...q, prompt: 'Updated question one?' }, q.id, q.version),
      api.saveQuestion({ ...q, prompt: 'Updated question two?' }, q.id, q.version),
    ])
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await api.question(q.id)).version).toBe(q.version + 1)
    await api.archiveQuestion(q.id, q.version + 1)
    expect((await api.question(q.id)).status).toBe('archived')
  })
  it('validates listening and reading content before publishing and accepts the starter listening text', async () => {
    const api = new MockAdminService(undefined, 0)
    const listening = (await api.questions({ categoryId: 'listening', status: 'published' }))
      .items[0]
    expect(listening.audioText.length).toBeGreaterThan(0)
    await expect(
      api.saveQuestion(
        { ...listening, audioText: '', audioUrl: '' },
        listening.id,
        listening.version,
      ),
    ).rejects.toThrow('listening')
    await api.saveQuestion(listening, listening.id, listening.version)
    const reading = (await api.questions({ categoryId: 'reading', status: 'published' })).items[0]
    await expect(
      api.saveQuestion({ ...reading, passage: '' }, reading.id, reading.version),
    ).rejects.toThrow('passage')
    await expect(
      api.saveQuestion(
        { ...listening, audioUrl: 'javascript:alert(1)' },
        listening.id,
        listening.version + 1,
      ),
    ).rejects.toThrow('HTTPS')
  })
  it('does not commit an edit when localStorage is full', async () => {
    const api = new MockAdminService(
      {
        getItem: () => null,
        removeItem: () => {},
        setItem: () => {
          throw new Error('Quota exceeded')
        },
      },
      0,
    )
    const q = (await api.questions({ status: 'published' })).items[0]
    await expect(api.archiveQuestion(q.id, q.version)).rejects.toThrow('Nothing was saved')
    expect((await api.question(q.id)).status).toBe('published')
    expect((await api.audit()).items).toEqual([])
  })
  it('keeps the four skills fixed and validates topic / lesson relationships', async () => {
    const api = new MockAdminService(undefined, 0),
      catalog = await api.catalog()
    await expect(
      api.saveContent({
        kind: 'category',
        title: 'Fifth skill',
        description: '',
        status: 'published',
      }),
    ).rejects.toThrow('fixed')
    const topic = catalog.topics[0]
    await expect(
      api.saveContent({
        kind: 'topic',
        id: topic.id,
        title: topic.title,
        description: '',
        categoryId: 'grammar',
        status: 'published',
      }),
    ).rejects.toThrow('cannot be moved')
    await api.saveContent({
      kind: 'topic',
      title: 'New topic',
      description: '',
      categoryId: 'vocabulary',
      status: 'draft',
    })
    const draft = (await api.catalog()).topics.find((t) => t.title === 'New topic')!
    await expect(
      api.saveContent({
        kind: 'lesson',
        title: 'New lesson',
        description: '',
        topicId: draft.id,
        status: 'published',
      }),
    ).rejects.toThrow('Publish the topic first')
    await api.saveContent({
      kind: 'lesson',
      title: 'New lesson',
      description: '',
      topicId: draft.id,
      status: 'draft',
    })
  })
  it('deduplicates active learners, uses weighted accuracy and handles empty analytics without division by zero', () => {
    const seed = createSeed(),
      range = defaultRange(),
      at = Date.now()
    seed.activities = [
      {
        id: 'a',
        userId: 'one',
        text: '',
        type: 'lesson',
        at,
        categoryId: 'vocabulary',
        answered: 10,
        correct: 8,
        completed: true,
      },
      {
        id: 'b',
        userId: 'one',
        text: '',
        type: 'lesson',
        at,
        categoryId: 'vocabulary',
        answered: 20,
        correct: 10,
        completed: false,
      },
    ]
    const o = calculateOverview(seed, range)
    expect(o.activeUsers).toBe(1)
    expect(o.accuracy).toBe(60)
    expect(o.completion).toBe(50)
    const empty = calculateOverview(seed, { from: '2000-01-01', to: '2000-01-02' })
    expect(empty.accuracy).toBeNull()
    expect(empty.completion).toBeNull()
    expect(empty.growth.active).toBeNull()
    expect(() => calculateOverview(seed, { from: '2026-10-24', to: '2026-10-01' })).toThrow(
      'valid date range',
    )
  })
  it('escapes CSV formula cells, quotes and newlines while preserving numeric values', () => {
    const csv = csvText(['Name'], [['=HYPERLINK("bad")'], ['normal, "quoted"\nvalue'], [-2]])
    expect(csv).toContain("'")
    expect(csv).toContain('""quoted""')
    expect(csv).toContain('"-2"')
    expect(csv.startsWith('\uFEFF')).toBe(true)
  })
  it('marks notifications read and resets local changes; a failed request can be retried', async () => {
    const api = new MockAdminService(localStorage, 0)
    await api.readNotifications()
    expect((await api.notifications()).unreadTotal).toBe(0)
    api.simulateNextFailure()
    await expect(api.users({})).rejects.toThrow('Simulated')
    expect((await api.users({})).total).toBe(54)
    await api.saveUser({ name: 'Reset me', email: 'reset@example.test' })
    await api.reset()
    expect((await api.users({ q: 'reset@example.test' })).total).toBe(0)
    expect((await api.notifications()).unreadTotal).toBeGreaterThan(0)
  })
})
