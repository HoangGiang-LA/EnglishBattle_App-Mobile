import { describe, expect, it, vi } from 'vitest'
import { FirebaseAdminService, type AdminTransport } from '../data/firebase-service'
import type { QuestionInput, UserRecord } from '../domain'

const user: UserRecord = {
  id: 'uid_1',
  code: 'EB-uid_1',
  name: 'Learner',
  email: 'learner@example.test',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  coins: 7,
  rating: 19,
  revision: 2,
  invitationStatus: 'not_requested',
}
const profile = {
  id: 'admin_1',
  name: 'Admin',
  email: 'admin@example.test',
  role: 'administrator',
  revision: 3,
}
const failed = (code: string, reason?: string) => ({
  code: `functions/${code}`,
  details: { reason },
})
const page = (items: UserRecord[], snapshotId = 'snapshot_1') => ({
  items,
  total: 40,
  page: 1,
  pageSize: 10,
  snapshotId,
  expiresAt: Date.now() + 600000,
  nextCursor: `${snapshotId}:2`,
})

describe('Firebase admin adapter', () => {
  it('shares identical pending reads but makes a fresh authorized request after settlement', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport = vi.fn<AdminTransport>().mockImplementation(async () => {
      await gate
      return { profile }
    })
    const service = new FirebaseAdminService('admin_1', transport)
    const first = service.profile(),
      second = service.profile()
    expect(transport).toHaveBeenCalledTimes(1)
    release()
    expect(await Promise.all([first, second])).toEqual([profile, profile])
    await service.profile()
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('never shares a pending read across accounts or across a committed mutation', async () => {
    let release!: () => void,
      reads = 0
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport = vi.fn<AdminTransport>().mockImplementation(async (action) => {
      if (action === 'adminGetProfile' && ++reads === 1) await gate
      return { profile }
    })
    const first = new FirebaseAdminService('admin_1', transport)
    const second = new FirebaseAdminService('admin_2', transport)
    const old = first.profile()
    await second.profile()
    expect(reads).toBe(2)
    await first.saveProfile('Updated', 3)
    await first.profile()
    expect(reads).toBe(3)
    release()
    await old
  })
  it('searches only nonempty bounded queries through the authorized callable', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockResolvedValue({ items: [{ id: 'search_1', page: 'users', query: 'uid_1' }] })
    const service = new FirebaseAdminService('admin_1', transport)
    expect(await service.search(' ')).toEqual([])
    expect(await service.search('x')).toEqual([])
    expect(transport).not.toHaveBeenCalled()
    expect((await service.search('  Nguyen  '))[0].query).toBe('uid_1')
    expect(transport.mock.calls[0]).toEqual(['adminSearch', { q: 'Nguyen' }])
    await expect(service.search('x'.repeat(101))).rejects.toThrow(/100/)
  })
  it('paginates notifications with a bound snapshot and uses the whole-inbox cutoff for mark-all', async () => {
    const transport = vi.fn<AdminTransport>().mockImplementation(async (action) =>
      action === 'adminListNotifications'
        ? {
            page: { ...page([]), asOf: 100, unreadTotal: 30 },
          }
        : {},
    )
    const service = new FirebaseAdminService('admin_1', transport)
    expect((await service.notifications()).unreadTotal).toBe(30)
    await service.notifications({ page: 2 })
    expect(transport.mock.calls[1]).toEqual([
      'adminListNotifications',
      {
        query: {
          page: 2,
          pageSize: 10,
          snapshotId: 'snapshot_1',
        },
      },
    ])
    await service.readNotifications()
    expect(transport.mock.calls[2][0]).toBe('adminMarkNotificationsRead')
    expect(transport.mock.calls[2][1]).toMatchObject({
      throughAt: 100,
      requestId: expect.any(String),
    })
    await service.notifications({ unreadOnly: true, pageSize: 20 })
    expect(transport.mock.calls[3]).toEqual([
      'adminListNotifications',
      {
        query: {
          unreadOnly: true,
          pageSize: 20,
          page: 1,
        },
      },
    ])
  })
  it('retains the same read-all cutoff and request ID when notifications refresh after a timeout', async () => {
    let asOf = 100,
      failedOnce = false
    const transport = vi.fn<AdminTransport>().mockImplementation(async (action) => {
      if (action === 'adminListNotifications')
        return { page: { ...page([]), asOf, unreadTotal: 1 } }
      if (!failedOnce) {
        failedOnce = true
        throw failed('deadline-exceeded')
      }
      return {}
    })
    const service = new FirebaseAdminService('admin_1', transport)
    await service.notifications()
    await expect(service.readNotifications()).rejects.toThrow(/thời gian chờ/)
    asOf = 200
    await service.notifications()
    await service.readNotifications()
    expect(transport.mock.calls[3]).toEqual(transport.mock.calls[1])
  })
  it('paginates audit with exact filters and never sends offsets or downloads all rows', async () => {
    const transport = vi.fn<AdminTransport>().mockResolvedValue({ page: page([]) })
    const service = new FirebaseAdminService('admin_1', transport)
    await service.audit({ q: '  case  ', result: 'failed', actor: 'uid_1', pageSize: 20 })
    await service.audit({ q: 'case', result: 'failed', actor: 'uid_1', pageSize: 20, page: 3 })
    expect(transport.mock.calls[1]).toEqual([
      'adminListAudit',
      {
        query: {
          q: 'case',
          result: 'failed',
          actor: 'uid_1',
          pageSize: 20,
          page: 3,
          snapshotId: 'snapshot_1',
        },
      },
    ])
  })
  it('exports all matching rows by creating then receiving a report, with pagination removed', async () => {
    const report = {
      id: 'report_1',
      filename: 'users.csv',
      columns: ['Name'],
      rows: [['Learner']],
      total: 1,
    }
    const transport = vi.fn<AdminTransport>().mockImplementation(async (_action, data) => ({
      report: data.reportId ? report : { id: report.id, total: report.total },
    }))
    const service = new FirebaseAdminService('admin_1', transport)
    const range = { from: '2026-11-01', to: '2026-11-03' }
    expect(
      await service.exportReport(
        'users',
        { q: 'Learner', status: 'active', page: 4, pageSize: 10 },
        range,
      ),
    ).toEqual(report)
    expect(transport.mock.calls[0]).toEqual([
      'adminExportReport',
      {
        requestId: expect.any(String),
        kind: 'users',
        query: { q: 'Learner', status: 'active' },
        range,
      },
    ])
    expect(transport.mock.calls[1]).toEqual(['adminExportReport', { reportId: 'report_1' }])
  })
  it('replays the same report creation after a receive timeout and reload without creating a second operation', async () => {
    sessionStorage.clear()
    let downloadFailed = false
    const report = { id: 'report_1', filename: 'users.csv', columns: [], rows: [] }
    const transport = vi.fn<AdminTransport>().mockImplementation(async (_action, data) => {
      if (data.reportId) {
        if (!downloadFailed) {
          downloadFailed = true
          throw failed('deadline-exceeded')
        }
        return { report }
      }
      return { report: { id: 'report_1' } }
    })
    const range = { from: '2026-11-01', to: '2026-11-03' }
    const first = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await expect(first.exportReport('users', {}, range)).rejects.toThrow(/thời gian chờ/)
    const second = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await second.restorePending()
    expect(await second.exportReport('users', {}, range)).toEqual(report)
    expect(transport.mock.calls[0][1].requestId).toBe(transport.mock.calls[2][1].requestId)
    expect(transport.mock.calls[0][1].requestId).toBe(transport.mock.calls[3][1].requestId)
    expect(sessionStorage.getItem('english-battle.admin.pending.admin_1')).toBe('[]')
  })
  it('reads published overview with the exact range, skill and granularity and reports incomplete history', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockResolvedValue({ overview: { totalUsers: 25, generation: 'generation_1', ready: true } })
    const service = new FirebaseAdminService('admin_1', transport)
    const range = { from: '2026-11-01', to: '2026-11-03' }
    expect((await service.overview(range)).totalUsers).toBe(25)
    expect(transport.mock.calls[0]).toEqual(['adminGetOverview', { range, granularity: 'day' }])
    await service.overview(range, 'reading', 'month')
    expect(transport.mock.calls[1]).toEqual([
      'adminGetOverview',
      { range, categoryId: 'reading', granularity: 'month' },
    ])
    transport.mockRejectedValueOnce(failed('failed-precondition', 'overview-not-ready'))
    await expect(service.overview(range)).rejects.toThrow(/tổng hợp đầy đủ/)
    transport.mockRejectedValueOnce(
      failed('failed-precondition', 'overview-skill-history-incomplete'),
    )
    await expect(service.overview(range, 'reading')).rejects.toThrow(/All skills/)
  })
  it('persists a stable requestId and complete payload over timeout and adapter reload', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockRejectedValueOnce(failed('deadline-exceeded'))
      .mockResolvedValue({ user })
    const first = new FirebaseAdminService('admin_1', transport, sessionStorage)
    const input = { name: user.name, email: user.email }
    await expect(first.saveUser(input)).rejects.toThrow(/thời gian chờ/)
    const second = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await expect(second.saveUser({ ...input, name: 'changed' })).rejects.toThrow(/Yêu cầu trước/)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(await second.saveUser(input)).toEqual(user)
    expect(transport.mock.calls[0]).toEqual(transport.mock.calls[1])
    expect(transport.mock.calls[0][1].requestId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(sessionStorage.getItem('english-battle.admin.pending.admin_1')!)).toEqual([])
  })
  it('sends the original visible revision and only editable user fields', async () => {
    const transport = vi.fn<AdminTransport>().mockResolvedValue({ user })
    const service = new FirebaseAdminService('admin_1', transport)
    await service.saveUser({ ...user, name: 'Renamed' }, user.id, user.revision)
    expect(transport).toHaveBeenCalledWith(
      'adminSaveUser',
      expect.objectContaining({
        id: user.id,
        expectedRevision: 2,
        input: { name: 'Renamed', email: user.email },
      }),
    )
    await expect(service.saveUser({ name: 'X', email: user.email }, user.id)).rejects.toThrow(
      /revision/,
    )
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('passes profile/status revisions and explicit invitation resend through the six supported APIs', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockImplementation(async (action) => (action.includes('Profile') ? { profile } : { user }))
    const service = new FirebaseAdminService('admin_1', transport)
    expect(await service.profile()).toEqual(profile)
    await service.saveProfile('Admin changed', 3)
    await service.user(user.id)
    await service.setUserStatus(user.id, 'banned', 'Support reason', 2)
    await service.saveUser({ name: user.name, email: user.email }, user.id, 2, true)
    expect(transport).toHaveBeenCalledWith(
      'adminUpdateProfile',
      expect.objectContaining({ name: 'Admin changed', expectedRevision: 3 }),
    )
    expect(transport).toHaveBeenCalledWith(
      'adminSetUserStatus',
      expect.objectContaining({ id: user.id, reason: 'Support reason', expectedRevision: 2 }),
    )
    expect(transport).toHaveBeenCalledWith(
      'adminSaveUser',
      expect.objectContaining({ resendInvitation: true }),
    )
  })
  it('uses server snapshots for numbered pages and never fetches all users into the browser', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockImplementation(async (action, data) =>
        action === 'adminListUsers'
          ? { page: { ...page([user]), page: (data.query as { page: number }).page } }
          : { user },
      )
    const service = new FirebaseAdminService('admin_1', transport)
    await service.users({ q: '', status: '', pageSize: 10, page: 3 })
    expect(transport.mock.calls).toEqual([
      ['adminListUsers', { query: { pageSize: 10, page: 1 } }],
      ['adminListUsers', { query: { pageSize: 10, page: 3, snapshotId: 'snapshot_1' } }],
    ])
    await service.users({ pageSize: 10, page: 2 })
    expect(transport.mock.calls[2][1]).toEqual({
      query: { pageSize: 10, page: 2, snapshotId: 'snapshot_1' },
    })
    await service.saveUser({ name: user.name, email: user.email })
    await service.users({ pageSize: 10, page: 1 })
    expect(transport.mock.calls.at(-1)![1]).toEqual({ query: { pageSize: 10, page: 1 } })
  })
  it('clears expired snapshots and reports optimistic conflicts without losing retry safety', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockResolvedValueOnce({ page: page([user]) })
      .mockRejectedValueOnce(failed('failed-precondition', 'snapshot-expired'))
      .mockResolvedValueOnce({ page: page([user], 'snapshot_2') })
      .mockRejectedValueOnce(failed('failed-precondition', 'version-conflict'))
    const service = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await service.users({})
    await expect(service.users({})).rejects.toThrow(/hết hạn/)
    await service.users({})
    expect(transport.mock.calls[2][1]).toEqual({ query: { pageSize: 10, page: 1 } })
    await expect(
      service.saveUser({ name: user.name, email: user.email }, user.id, 2),
    ).rejects.toThrow(/người khác/)
    expect(JSON.parse(sessionStorage.getItem('english-battle.admin.pending.admin_1')!)).toEqual([])
  })
  it('drops an old list response after a successful mutation invalidates the snapshot generation', async () => {
    let resolveList!: (value: Record<string, unknown>) => void
    const transport: AdminTransport = async (action) =>
      action === 'adminListUsers'
        ? new Promise((resolve) => {
            resolveList = resolve
          })
        : { user }
    const service = new FirebaseAdminService('admin_1', transport)
    const pending = service.users({})
    await service.saveUser({ name: user.name, email: user.email })
    resolveList({ page: page([user]) })
    await expect(pending).rejects.toThrow(/làm mới/)
  })
  it('emits UID-bound access loss and never resets or falls back to sample data', async () => {
    const listener = vi.fn()
    window.addEventListener('admin:access-denied', listener)
    const service = new FirebaseAdminService('admin_1', async () => {
      throw failed('permission-denied')
    })
    await expect(service.profile()).rejects.toThrow(/thu hồi/)
    expect((listener.mock.calls[0][0] as CustomEvent).detail.uid).toBe('admin_1')
    await expect(service.overview({ from: '2026-11-01', to: '2026-11-03' })).rejects.toThrow(
      /thu hồi/,
    )
    await expect(service.reset()).rejects.toThrow(/Không có chức năng reset/)
    window.removeEventListener('admin:access-denied', listener)
  })
  it('does not send mutations when session storage cannot persist a requestId', async () => {
    const transport = vi.fn<AdminTransport>()
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('Quota exceeded')
      },
    } as unknown as Storage
    const service = new FirebaseAdminService('admin_1', transport, storage)
    for (let i = 0; i < 2; i++)
      await expect(service.saveUser({ name: user.name, email: user.email })).rejects.toThrow(
        /Chưa gửi thay đổi/,
      )
    expect(transport).not.toHaveBeenCalled()
  })
  it('keeps a blocked operation pending even if its underlying cause was a version conflict', async () => {
    const transport = vi.fn<AdminTransport>().mockRejectedValue({
      code: 'functions/failed-precondition',
      details: {
        reason: 'version-conflict',
        operationPhase: 'blocked',
        operationId: 'a'.repeat(64),
      },
    })
    const service = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await expect(service.saveProfile('Name', 3)).rejects.toThrow(/Mã thao tác/)
    await expect(service.saveProfile('Different', 3)).rejects.toThrow(/Yêu cầu trước/)
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('reconciles the exact saved intent on startup before a reloaded form can create a new operation', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockRejectedValueOnce(failed('deadline-exceeded'))
      .mockResolvedValue({ user })
    const original = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await expect(original.saveUser({ name: user.name, email: user.email })).rejects.toThrow()
    const restored = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await restored.restorePending()
    expect(transport.mock.calls[0]).toEqual(transport.mock.calls[1])
    expect(JSON.parse(sessionStorage.getItem('english-battle.admin.pending.admin_1')!)).toEqual([])
  })
  it('a terminal rejection of an old actor session clears that intent without signing out the current valid session', async () => {
    const first = new FirebaseAdminService(
      'admin_1',
      async () => {
        throw failed('deadline-exceeded')
      },
      sessionStorage,
    )
    await expect(first.saveProfile('Old request', 2)).rejects.toThrow()
    const listener = vi.fn()
    window.addEventListener('admin:access-denied', listener)
    const transport = vi
      .fn<AdminTransport>()
      .mockRejectedValueOnce({
        code: 'functions/unauthenticated',
        details: { operationPhase: 'failed', reason: 'session-revoked' },
      })
      .mockResolvedValue({ profile })
    const restored = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await restored.restorePending()
    expect(await restored.profile()).toEqual(profile)
    expect(listener).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem('english-battle.admin.pending.admin_1')!)).toEqual([])
    window.removeEventListener('admin:access-denied', listener)
  })
  it('sends content revision outside an allowlisted DTO and derives lesson category on the server', async () => {
    const transport = vi.fn<AdminTransport>().mockResolvedValue({})
    const service = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await service.saveContent({
      kind: 'lesson',
      id: 'lesson_1',
      topicId: 'topic_1',
      title: 'Lesson',
      description: '',
      difficulty: 'easy',
      status: 'draft',
      revision: 4,
    })
    expect(transport.mock.calls[0][1]).toMatchObject({
      expectedRevision: 4,
      input: { kind: 'lesson', id: 'lesson_1', topicId: 'topic_1', title: 'Lesson' },
    })
    expect((transport.mock.calls[0][1].input as Record<string, unknown>).revision).toBeUndefined()
    expect((transport.mock.calls[0][1].input as Record<string, unknown>).categoryId).toBeUndefined()
  })
  it('keeps question requestId/version/payload across timeout and reload without reading a newer version', async () => {
    const input: QuestionInput = {
      categoryId: 'vocabulary',
      topicId: 'topic_1',
      lessonId: 'lesson_1',
      prompt: 'Question',
      options: ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id })),
      correctOptionId: 'a',
      explanation: 'A is correct',
      passage: '',
      audioUrl: '',
      audioText: '',
      difficulty: 'easy',
      status: 'published',
    }
    const transport = vi
      .fn<AdminTransport>()
      .mockRejectedValueOnce(failed('deadline-exceeded'))
      .mockResolvedValue({ question: { version: 3 } })
    const first = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await expect(first.saveQuestion(input, 'question_1', 2)).rejects.toThrow()
    const restored = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await restored.restorePending()
    expect(transport.mock.calls[0]).toEqual(transport.mock.calls[1])
    expect(transport.mock.calls[0][1].expectedVersion).toBe(2)
    expect(transport.mock.calls.every(([action]) => action === 'adminSaveQuestion')).toBe(true)
    await expect(
      restored.saveQuestion({ ...input, audioUrl: 'https://example.test/a.mp3' }),
    ).rejects.toThrow(/TTS/)
  })
  it('paginates questions via a separately bound server snapshot and never loads all source rows', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockResolvedValue({ page: { ...page([]), snapshotId: 'question_snapshot' } })
    const service = new FirebaseAdminService('admin_1', transport)
    await service.users({ q: 'sample' })
    await service.questions({
      q: 'sample',
      categoryId: 'reading',
      difficulty: 'hard',
      page: 3,
      pageSize: 20,
    })
    expect(transport.mock.calls[1]).toEqual([
      'adminListQuestions',
      {
        query: {
          q: 'sample',
          categoryId: 'reading',
          difficulty: 'hard',
          pageSize: 20,
          page: 1,
        },
      },
    ])
    expect(transport.mock.calls[2]).toEqual([
      'adminListQuestions',
      {
        query: {
          q: 'sample',
          categoryId: 'reading',
          difficulty: 'hard',
          pageSize: 20,
          page: 3,
          snapshotId: 'question_snapshot',
        },
      },
    ])
    expect(transport).toHaveBeenCalledTimes(3)
  })
  it('reports content parent publication errors and keeps the original form revision', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockRejectedValue(failed('failed-precondition', 'parent-not-published'))
    const service = new FirebaseAdminService('admin_1', transport, sessionStorage)
    await expect(
      service.saveContent({
        kind: 'topic',
        id: 'topic_1',
        categoryId: 'reading',
        title: 'Topic',
        description: '',
        status: 'published',
        revision: 7,
      }),
    ).rejects.toThrow(/Xuất bản/)
    expect(transport.mock.calls[0][1].expectedRevision).toBe(7)
    expect(JSON.parse(sessionStorage.getItem('english-battle.admin.pending.admin_1')!)).toEqual([])
  })
  it('binds monitoring snapshots to each filter and refreshes page one without requesting all rows', async () => {
    let sequence = 0
    const transport = vi.fn<AdminTransport>().mockImplementation(async () => ({
      page: { ...page([]), snapshotId: `monitor_${++sequence}`, asOf: 100, lagMs: 2, ready: true },
    }))
    const service = new FirebaseAdminService('admin_1', transport)
    await service.battles({ status: 'completed', mode: 'quick', pageSize: 20 })
    await service.battles({ status: 'completed', mode: 'quick', pageSize: 20, page: 3 })
    expect(transport.mock.calls[1]).toEqual([
      'adminListBattles',
      {
        query: {
          page: 3,
          pageSize: 20,
          status: 'completed',
          mode: 'quick',
          snapshotId: 'monitor_1',
        },
      },
    ])
    await service.battles({ status: 'completed', mode: 'quick', pageSize: 20 })
    expect(transport.mock.calls[2][1]).toEqual({
      query: { page: 1, pageSize: 20, status: 'completed', mode: 'quick' },
    })
    await service.activities({ type: 'battle', categoryId: 'mixed', pageSize: 50, page: 2 })
    expect(transport.mock.calls[3]).toEqual([
      'adminListActivities',
      {
        query: { page: 1, pageSize: 50, type: 'battle', categoryId: 'mixed' },
      },
    ])
    expect(transport.mock.calls[4][1]).toEqual({
      query: {
        page: 2,
        pageSize: 50,
        type: 'battle',
        categoryId: 'mixed',
        snapshotId: 'monitor_4',
      },
    })
  })
  it('reads battle detail without source mutations and surfaces unavailable monitoring instead of sample data', async () => {
    const transport = vi
      .fn<AdminTransport>()
      .mockResolvedValue({ detail: { battle: { id: 'b1' } } })
    const service = new FirebaseAdminService('admin_1', transport)
    expect(await service.battle('b1')).toEqual({ battle: { id: 'b1' } })
    expect(transport.mock.calls[0]).toEqual(['adminGetBattle', { id: 'b1' }])
    transport.mockRejectedValueOnce(failed('failed-precondition', 'monitoring-index-not-ready'))
    await expect(service.battles({})).rejects.toThrow(/giám sát đang được tổng hợp/)
    transport.mockRejectedValueOnce(failed('unimplemented'))
    await expect(service.battles({ mode: 'daily' })).rejects.toThrow(/chưa được triển khai/)
  })
})
