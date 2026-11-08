import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import { FirebaseAdminService, type AdminTransport } from '../data/firebase-service'
import { useAdminAuth } from '../firebase/useAdminAuth'
import type { UserRecord } from '../domain'
import { adminSession, createAuthStub } from './auth-stub'

const learner: UserRecord = {
  id: 'learner_1',
  code: 'EB-1',
  name: 'Learner One',
  email: 'one@example.test',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  rating: 9,
  coins: 7,
  revision: 2,
}
const profile = {
  id: adminSession.uid,
  name: 'Real Admin',
  email: adminSession.email,
  role: 'administrator',
  revision: 1,
}
const fail = (code: string, reason?: string) => ({ code: 'functions/' + code, details: { reason } })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const baseTransport: AdminTransport = async (action, data) => {
  if (action === 'adminGetProfile') return { profile }
  if (action === 'adminUpdateProfile')
    return { profile: { ...profile, name: data.name, revision: 10 } }
  if (action === 'adminListUsers')
    return { page: { items: [learner], total: 1, page: 1, pageSize: 10, snapshotId: 'snapshot_1' } }
  if (action === 'adminListNotifications')
    return {
      page: {
        items: [],
        total: 0,
        page: 1,
        pageSize: 10,
        snapshotId: 'notice_1',
        asOf: 1,
        unreadTotal: 0,
      },
    }
  if (action === 'adminSearch') return { items: [] }
  if (action === 'adminGetUser') return { user: { ...learner, id: data.id } }
  if (action === 'adminSaveUser')
    return { user: { ...learner, ...(data.input as object), revision: 3 } }
  throw fail('unimplemented')
}
async function workspace(transport: AdminTransport = baseTransport) {
  window.location.hash = '/users'
  const service = new FirebaseAdminService(adminSession.uid, transport, sessionStorage)
  const auth = createAuthStub(adminSession)
  render(<App api={service} authLoader={auth.load} />)
  await screen.findByRole('button', { name: 'Edit Learner One' })
  return { service, auth }
}

describe('Real admin connection safety', () => {
  it('coalesces simultaneous identical saves, rejects different content, and publishes one success', async () => {
    const gate = deferred<Record<string, unknown>>()
    const transport = vi.fn<AdminTransport>().mockImplementation(() => gate.promise)
    const service = new FirebaseAdminService(adminSession.uid, transport, sessionStorage)
    const events = vi.spyOn(window, 'dispatchEvent')
    const first = service.saveUser({ name: learner.name, email: learner.email }, learner.id, 2)
    const duplicate = service.saveUser({ name: learner.name, email: learner.email }, learner.id, 2)
    await expect(
      service.saveUser({ name: 'Different', email: learner.email }, learner.id, 2),
    ).rejects.toThrow(/đang xử lý/)
    expect(transport).toHaveBeenCalledTimes(1)
    gate.resolve({ user: learner })
    await Promise.all([first, duplicate])
    expect(events.mock.calls.filter(([event]) => event.type === 'admin:data')).toHaveLength(1)
    expect(sessionStorage.getItem('english-battle.admin.pending.' + adminSession.uid)).toBe('[]')
  })
  it('keeps the committed intent when its workspace closes before acknowledgement, then verifies the same ID', async () => {
    const gate = deferred<Record<string, unknown>>()
    const firstTransport = vi.fn<AdminTransport>().mockImplementation(() => gate.promise)
    const first = new FirebaseAdminService(adminSession.uid, firstTransport, sessionStorage)
    const request = first.saveUser({ name: learner.name, email: learner.email }, learner.id, 2)
    const rejected = expect(request).rejects.toThrow(/Phiên làm việc/)
    first.dispose()
    gate.resolve({ user: learner })
    await rejected
    const nextTransport = vi.fn<AdminTransport>().mockResolvedValue({ user: learner })
    const next = new FirebaseAdminService(adminSession.uid, nextTransport, sessionStorage)
    await next.restorePending()
    expect(nextTransport.mock.calls).toEqual(firstTransport.mock.calls)
    expect(sessionStorage.getItem('english-battle.admin.pending.' + adminSession.uid)).toBe('[]')
  })
  it('discards an access error from a disposed workspace without signing out a newer session', async () => {
    const gate = deferred<Record<string, unknown>>(),
      events = vi.spyOn(window, 'dispatchEvent')
    const transport = vi.fn<AdminTransport>().mockImplementation(() => gate.promise)
    const old = new FirebaseAdminService(adminSession.uid, transport)
    const read = old.profile()
    const rejected = expect(read).rejects.toMatchObject({ code: 'functions/permission-denied' })
    old.dispose()
    gate.reject(fail('permission-denied'))
    await rejected
    await expect(old.profile()).rejects.toThrow(/Phiên làm việc/)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(
      events.mock.calls.filter(([event]) => event.type === 'admin:access-denied'),
    ).toHaveLength(0)
  })
  it('stops pending recovery on live access loss and preserves its original payload', async () => {
    const failedTransport: AdminTransport = async () => {
      throw fail('deadline-exceeded')
    }
    const first = new FirebaseAdminService(adminSession.uid, failedTransport, sessionStorage)
    await expect(first.saveUser({ name: learner.name, email: learner.email })).rejects.toThrow()
    const saved = sessionStorage.getItem('english-battle.admin.pending.' + adminSession.uid)
    const second = new FirebaseAdminService(
      adminSession.uid,
      async () => {
        throw fail('permission-denied')
      },
      sessionStorage,
    )
    await expect(second.restorePending()).rejects.toThrow(/thu hồi/)
    expect(sessionStorage.getItem('english-battle.admin.pending.' + adminSession.uid)).toBe(saved)
  })
  it('does not send or lock a new payload when session storage fails before dispatch', async () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn().mockImplementationOnce(() => {
        throw new Error('quota')
      }),
    } as unknown as Storage
    const transport = vi.fn<AdminTransport>().mockResolvedValue({ user: learner })
    const service = new FirebaseAdminService(adminSession.uid, transport, storage)
    await expect(service.saveUser({ name: 'First', email: learner.email })).rejects.toThrow(
      /Chưa gửi/,
    )
    expect(transport).not.toHaveBeenCalled()
    await service.saveUser({ name: 'Second', email: learner.email })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0][1]).toMatchObject({ input: { name: 'Second' } })
  })
  it('captures nested report filters before dispatch so edits cannot alter the retained retry intent', async () => {
    const gate = deferred<Record<string, unknown>>()
    const transport = vi.fn<AdminTransport>().mockImplementation(() => gate.promise)
    const service = new FirebaseAdminService(adminSession.uid, transport, sessionStorage)
    const range = { from: '2026-11-01', to: '2026-11-08' }
    const report = service.exportReport('users', {}, range)
    const rejected = expect(report).rejects.toThrow()
    range.from = '2026-10-01'
    expect(transport.mock.calls[0][1]).toMatchObject({ range: { from: '2026-11-01' } })
    gate.reject(fail('deadline-exceeded'))
    await rejected
    expect(
      JSON.parse(sessionStorage.getItem('english-battle.admin.pending.' + adminSession.uid)!)[0]
        .payload.range.from,
    ).toBe('2026-11-01')
  })
  it.each([10, 20, 50])(
    'refreshes Users and Questions page one while preserving the %i-row snapshot on later pages',
    async (pageSize) => {
      for (const action of ['users', 'questions'] as const) {
        let snapshot = 0
        const transport = vi.fn<AdminTransport>().mockImplementation(async (_action, data) => {
          const query = data.query as { snapshotId?: string; page: number }
          if (!query.snapshotId) snapshot++
          return {
            page: {
              items: [],
              total: snapshot * 20,
              page: query.page,
              pageSize,
              snapshotId: 'snapshot_' + snapshot,
            },
          }
        })
        const service = new FirebaseAdminService(adminSession.uid, transport)
        await service[action]({ page: 1, pageSize })
        expect((await service[action]({ page: 1, pageSize })).total).toBe(40)
        await service[action]({ page: 2, pageSize })
        expect(transport.mock.calls[2][1]).toEqual({
          query: { page: 2, pageSize, snapshotId: 'snapshot_2' },
        })
        expect(transport).toHaveBeenCalledTimes(3)
      }
    },
  )
  it.each(['deadline-exceeded', 'conflict'])(
    'keeps form values on %s and does not show success before confirmation',
    async (failure) => {
      let attempted = false
      const transport = vi.fn<AdminTransport>().mockImplementation(async (action, data) => {
        if (action === 'adminSaveUser' && !attempted) {
          attempted = true
          throw failure === 'conflict'
            ? fail('failed-precondition', 'version-conflict')
            : fail('deadline-exceeded')
        }
        return baseTransport(action, data)
      })
      await workspace(transport)
      fireEvent.click(screen.getByRole('button', { name: 'Edit Learner One' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.change(within(dialog).getByLabelText('Full name'), {
        target: { value: 'Preserved Name' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        failure === 'conflict' ? 'người khác' : 'thời gian chờ',
      )
      expect(within(dialog).getByLabelText('Full name')).toHaveValue('Preserved Name')
      expect(screen.queryByText('User updated in Firebase.')).not.toBeInTheDocument()
      if (failure !== 'conflict') {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        const saves = transport.mock.calls.filter(([action]) => action === 'adminSaveUser')
        expect(saves).toHaveLength(2)
        expect(saves[0][1]).toEqual(saves[1][1])
      }
    },
  )
  it('ignores user details arriving after the list filter changes', async () => {
    const gate = deferred<Record<string, unknown>>()
    await workspace((action, data) =>
      action === 'adminGetUser' ? gate.promise : baseTransport(action, data),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Learner One' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by name, email or ID…' }), {
      target: { value: 'another' },
    })
    await act(async () => gate.resolve({ user: learner }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('closes a revoked workspace immediately even while Firebase sign-out is still pending', async () => {
    let allowed = true
    const { service, auth } = await workspace((action, data) =>
      allowed ? baseTransport(action, data) : Promise.reject(fail('permission-denied')),
    )
    const signOut = deferred<void>()
    vi.mocked(auth.gateway.signOut).mockImplementation(() => signOut.promise)
    allowed = false
    await act(async () => {
      await service.profile().catch(() => {})
    })
    await screen.findByRole('heading', { name: 'Welcome back' })
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/thu hồi/)
    await act(async () => signOut.resolve())
  })
  it('does not overwrite a new account with a late refresh from the preceding account', async () => {
    const auth = createAuthStub(adminSession),
      gate = deferred<typeof adminSession | null>()
    vi.mocked(auth.gateway.refresh).mockImplementation(() => gate.promise)
    const { result } = renderHook(() => useAdminAuth(auth.load))
    await waitFor(() => expect(result.current.session?.uid).toBe(adminSession.uid))
    let refresh!: Promise<void>
    act(() => {
      refresh = result.current.refresh()
    })
    act(() => auth.emit({ ...adminSession, uid: 'second_admin', email: 'second@example.test' }))
    await act(async () => {
      gate.resolve(adminSession)
      await refresh
    })
    expect(result.current.session?.uid).toBe('second_admin')
    expect(result.current.busy).toBe(false)
  })
  it('disables submitted fields until the pending save settles, then preserves them on failure', async () => {
    const gate = deferred<Record<string, unknown>>()
    await workspace((action, data) =>
      action === 'adminSaveUser' ? gate.promise : baseTransport(action, data),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit Learner One' }))
    const dialog = await screen.findByRole('dialog'),
      name = within(dialog).getByLabelText('Full name')
    fireEvent.change(name, { target: { value: 'Submitted Value' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(name).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => gate.reject(fail('unavailable')))
    expect(await within(dialog).findByRole('alert')).toBeVisible()
    expect(name).toBeEnabled()
    expect(name).toHaveValue('Submitted Value')
  })
  it('shows unavailable APIs and retries the real source without falling back to demo rows', async () => {
    let available = false
    window.location.hash = '/users'
    const transport: AdminTransport = (action, data) =>
      action === 'adminListUsers' && !available
        ? Promise.reject(fail('unimplemented'))
        : baseTransport(action, data)
    const service = new FirebaseAdminService(adminSession.uid, transport)
    const auth = createAuthStub(adminSession)
    render(<App api={service} authLoader={auth.load} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('chưa được triển khai')
    expect(screen.queryByRole('button', { name: 'Edit Learner One' })).not.toBeInTheDocument()
    expect(screen.queryByText('Demo workspace')).not.toBeInTheDocument()
    available = true
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Edit Learner One' })).toBeVisible()
  })
  it('loads the latest user revision before opening an editor from an older list snapshot', async () => {
    const transport = vi.fn<AdminTransport>().mockImplementation((action, data) =>
      action === 'adminGetUser'
        ? Promise.resolve({
            user: { ...learner, name: 'Latest Name', email: 'latest@example.test', revision: 5 },
          })
        : baseTransport(action, data),
    )
    await workspace(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Learner One' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Full name')).toHaveValue('Latest Name')
    expect(within(dialog).getByLabelText('Email address')).toHaveValue('latest@example.test')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(transport.mock.calls.find(([action]) => action === 'adminSaveUser')?.[1]).toMatchObject({
      expectedRevision: 5,
      input: { name: 'Latest Name', email: 'latest@example.test' },
    })
  })
  it('opens profile from a fresh server read rather than the header cache', async () => {
    let reads = 0
    const transport = vi.fn<AdminTransport>().mockImplementation((action, data) =>
      action === 'adminGetProfile'
        ? Promise.resolve({
            profile: {
              ...profile,
              name: ++reads > 1 ? 'Current Admin' : 'Real Admin',
              revision: 9,
            },
          })
        : baseTransport(action, data),
    )
    await workspace(transport)
    fireEvent.click(screen.getByRole('button', { name: 'English Battle' }))
    fireEvent.click(screen.getByRole('button', { name: 'Profile & workspace' }))
    expect(await screen.findByLabelText('Display name')).toHaveValue('Current Admin')
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      transport.mock.calls.find(([action]) => action === 'adminUpdateProfile')?.[1],
    ).toMatchObject({ expectedRevision: 9 })
  })
  it('fetches the current catalog revision before editing a skill from an older table', async () => {
    let reads = 0
    const transport = vi.fn<AdminTransport>().mockImplementation((action, data) => {
      if (action === 'adminGetCatalog')
        return Promise.resolve({
          catalog: {
            categories: [
              {
                id: 'vocabulary',
                name: ++reads > 1 ? 'Current Vocabulary' : 'Vocabulary',
                description: 'Vocabulary content',
                status: 'published',
                revision: 6,
              },
            ],
            topics: [],
            lessons: [],
          },
        })
      if (action === 'adminListQuestions')
        return Promise.resolve({
          page: { items: [], total: 0, page: 1, pageSize: 10, snapshotId: 'questions_1' },
        })
      if (action === 'adminSaveContent') return Promise.resolve({})
      return baseTransport(action, data)
    })
    window.location.hash = '/content'
    const service = new FirebaseAdminService(adminSession.uid, transport),
      auth = createAuthStub(adminSession)
    render(<App api={service} authLoader={auth.load} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Skills/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Vocabulary' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByDisplayValue('Current Vocabulary')).toBeVisible()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /Save/ })).toBeEnabled())
    fireEvent.click(within(dialog).getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      transport.mock.calls.find(([action]) => action === 'adminSaveContent')?.[1],
    ).toMatchObject({ expectedRevision: 6, input: { title: 'Current Vocabulary' } })
  })
})
