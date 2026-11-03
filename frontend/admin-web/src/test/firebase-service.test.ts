import { describe, expect, it, vi } from 'vitest'
import { FirebaseAdminService, type AdminTransport } from '../data/firebase-service'
import type { UserRecord } from '../domain'

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
      /chưa được triển khai/,
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
})
