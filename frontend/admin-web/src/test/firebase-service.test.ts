import { describe, expect, it, vi } from 'vitest'
import contract from '../../../contracts/admin.v1.json'
import { FirebaseAdminService, type CallableTransport } from '../data/firebase-service'
import { createSeed } from '../data/seed'
import { calculateOverview } from '../data/metrics'
import { defaultRange } from '../lib'
import type { AdminService, QuestionInput } from '../domain'
import { dataSource } from '../data/service'

const seed = createSeed(),
  range = defaultRange()
const input: QuestionInput = seed.questions[0]
const page = <T>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 10 })
const payloads: Record<string, unknown> = {
  profile: seed.profile,
  saveProfile: seed.profile,
  overview: calculateOverview(seed, range),
  users: page(seed.users),
  user: seed.users[0],
  saveUser: seed.users[0],
  questions: page(seed.questions),
  question: seed.questions[0],
  saveQuestion: seed.questions[0],
  catalog: { categories: seed.categories, topics: seed.topics, lessons: seed.lessons },
  battles: page(seed.battles),
  battle: { battle: seed.battles[0], player1: seed.users[0], player2: seed.users[1] },
  activities: page(seed.activities.map((a) => ({ ...a, userName: 'Learner' }))),
  search: [{ id: 'x', label: 'Found', detail: 'Detail', page: 'users', query: 'x' }],
  notifications: seed.notifications,
  audit: seed.audit,
  exportReport: { filename: 'a.csv', columns: ['id'], rows: [['one']] },
}
const calls: Record<
  Exclude<keyof AdminService, 'mode' | 'reset'>,
  (api: AdminService) => Promise<unknown>
> = {
  profile: (a) => a.profile(),
  saveProfile: (a) => a.saveProfile('Admin'),
  overview: (a) => a.overview(range),
  users: (a) => a.users({ q: undefined }),
  user: (a) => a.user('u'),
  saveUser: (a) => a.saveUser({ name: 'Learner', email: 'x@example.test' }),
  setUserStatus: (a) => a.setUserStatus('u', 'banned', 'Policy violation'),
  questions: (a) => a.questions({}),
  question: (a) => a.question('q'),
  saveQuestion: (a) => a.saveQuestion(input, 'q', 1),
  archiveQuestion: (a) => a.archiveQuestion('q', 1),
  catalog: (a) => a.catalog(),
  saveContent: (a) =>
    a.saveContent({
      kind: 'topic',
      title: 'Topic',
      description: 'Description',
      status: 'draft',
      categoryId: 'grammar',
    }),
  battles: (a) => a.battles({}),
  battle: (a) => a.battle('b'),
  activities: (a) => a.activities({}),
  search: (a) => a.search('abc'),
  notifications: (a) => a.notifications(),
  readNotifications: (a) => a.readNotifications(),
  audit: (a) => a.audit(),
  exportReport: (a) => a.exportReport('users', {}, range),
}
describe('Firebase adapter (injected transport, not emulator E2E)', () => {
  for (const method of Object.keys(calls) as (keyof typeof calls)[]) {
    it(`maps ${method} from the contract and validates SDK data`, async () => {
      const spec = contract.methods[method]
      const transport = vi.fn<CallableTransport>().mockResolvedValue({
        data: {
          serverNow: 123,
          ...(spec.payloadKey ? { [spec.payloadKey]: payloads[method] } : {}),
        },
      })
      const api = new FirebaseAdminService(transport)
      expect(api.mode).toBe('firebase')
      expect(await calls[method](api)).toEqual(payloads[method])
      const [name, request] = transport.mock.calls[0]
      expect(name).toBe(spec.callable)
      const required = spec.request.filter((f) => !f.endsWith('?'))
      expect(Object.keys(request)).toEqual(expect.arrayContaining(required))
      expect(
        Object.keys(request).every((key) =>
          spec.request.some((field) => field.replace(/\?$/, '') === key),
        ),
      ).toBe(true)
      expect(JSON.stringify(request)).not.toContain('undefined')
      if ('requestId' in request) expect(request.requestId).toEqual(expect.any(String))
    })
  }
  it.each([
    null,
    {},
    { result: { serverNow: 1, page: page([]) } },
    { serverNow: 1 },
    { serverNow: 1, page: {} },
    { serverNow: 1, page: { ...page([]), items: [{ id: 'incomplete' }] } },
  ])('rejects malformed envelopes without empty fallback: %j', async (data) => {
    const api = new FirebaseAdminService(async () => ({ data }))
    await expect(api.users({})).rejects.toThrow('Invalid callable response')
  })
  it.each([
    'functions/permission-denied',
    'functions/unauthenticated',
    'functions/unavailable',
    'functions/not-found',
  ])('preserves %s without fallback or auto retry', async (code) => {
    const error = { code },
      lost = vi.fn(),
      transport = vi.fn<CallableTransport>().mockRejectedValue(error)
    window.addEventListener('admin:access-lost', lost)
    try {
      const api = new FirebaseAdminService(transport)
      await expect(api.users({})).rejects.toBe(error)
      expect(transport).toHaveBeenCalledTimes(1)
      expect(lost).toHaveBeenCalledTimes(
        ['functions/permission-denied', 'functions/unauthenticated'].includes(code) ? 1 : 0,
      )
    } finally {
      window.removeEventListener('admin:access-lost', lost)
    }
  })
  it('omits nested undefined and retains requestId for explicit retry, changing it after success or changed payload', async () => {
    const transport = vi
      .fn<CallableTransport>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ data: { serverNow: 1, profile: seed.profile } })
    const api = new FirebaseAdminService(transport)
    await expect(api.saveProfile('Name')).rejects.toThrow('network')
    expect(transport).toHaveBeenCalledTimes(1)
    await api.saveProfile('Name')
    expect(transport.mock.calls[1][1]).toEqual(transport.mock.calls[0][1])
    await api.saveProfile('Name')
    expect(transport.mock.calls[2][1].requestId).not.toBe(transport.mock.calls[1][1].requestId)
    await api.saveProfile('Other')
    expect(transport.mock.calls[3][1].requestId).not.toBe(transport.mock.calls[2][1].requestId)
    transport.mockResolvedValue({ data: { serverNow: 1, page: page([]) } })
    await api.users({ q: undefined, status: 'active' })
    expect(transport.mock.lastCall?.[1]).toEqual({ query: { status: 'active' } })
  })
  it('coalesces duplicate in-flight writes and emits refresh only after success', async () => {
    let finish!: (value: { data: unknown }) => void
    const transport = vi.fn<CallableTransport>(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
      changed = vi.fn()
    window.addEventListener('admin:data', changed)
    try {
      const api = new FirebaseAdminService(transport),
        first = api.readNotifications(),
        second = api.readNotifications()
      expect(transport).toHaveBeenCalledTimes(1)
      finish({ data: { serverNow: 1 } })
      await Promise.all([first, second])
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('admin:data', changed)
    }
  })
  it('sends an initial password only for creation and never forwards role/rating fields', async () => {
    const transport = vi
      .fn<CallableTransport>()
      .mockResolvedValue({ data: { serverNow: 1, user: seed.users[0] } })
    const api = new FirebaseAdminService(transport)
    await api.saveUser({
      name: 'Created',
      email: 'created@example.test',
      password: 'FixtureOnly123!',
    })
    expect(transport.mock.lastCall?.[1]).toMatchObject({
      input: { name: 'Created', email: 'created@example.test', password: 'FixtureOnly123!' },
    })
    await api.saveUser(
      { name: 'Edited', email: 'edited@example.test', password: 'not-for-edit' },
      'u',
    )
    expect(transport.mock.lastCall?.[1]).toMatchObject({
      id: 'u',
      input: { name: 'Edited', email: 'edited@example.test' },
    })
    expect((transport.mock.lastCall?.[1].input as Record<string, unknown>).password).toBeUndefined()
  })
  it('passes expectedVersion and rejects editing without one or base64 audio', async () => {
    const transport = vi
        .fn<CallableTransport>()
        .mockResolvedValue({ data: { serverNow: 1, question: seed.questions[0] } }),
      api = new FirebaseAdminService(transport)
    await api.saveQuestion(input, 'q', 4)
    expect(transport.mock.lastCall?.[1]).toMatchObject({ id: 'q', expectedVersion: 4 })
    await expect(api.saveQuestion(input, 'q')).rejects.toThrow('expectedVersion')
    await expect(
      api.saveQuestion({ ...input, audioUrl: 'data:audio/mp3;base64,abc' }),
    ).rejects.toThrow('HTTPS')
    await expect(api.reset()).rejects.toThrow('demo')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('keeps source choice independent of emulator mode and rejects typos', () => {
    expect(dataSource('firebase')).toBe('firebase')
    expect(dataSource('mock')).toBe('mock')
    expect(dataSource(undefined)).toBe('mock')
    expect(() => dataSource('emulator')).toThrow('VITE_ADMIN_DATA_SOURCE')
  })
})
