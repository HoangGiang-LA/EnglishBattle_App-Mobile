import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: {currentUser: {uid: 'admin', email: 'admin@example.test', displayName: 'Admin'}},
  token: vi.fn(), provision: vi.fn(), verify: vi.fn(),
}))
vi.mock('firebase/app', () => ({getApps: () => [], initializeApp: () => ({})}))
vi.mock('firebase/database', () => ({getDatabase: () => ({})}))
vi.mock('firebase/auth', () => ({
  getAuth: () => mocks.auth, getIdTokenResult: mocks.token,
  browserSessionPersistence: {}, onIdTokenChanged: vi.fn(), setPersistence: vi.fn(),
  signInWithEmailAndPassword: vi.fn(), signOut: vi.fn(),
}))
vi.mock('firebase/functions', () => ({getFunctions: () => ({}), httpsCallable: () => mocks.provision}))
vi.mock('../firebase/backend', () => ({verifyAdminAccess: mocks.verify}))
import {authGateway} from '../firebase/client'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.token.mockResolvedValue({token: 'test-token', claims: {admin: true}})
  mocks.provision.mockResolvedValue({data: {serverNow: 1}})
  mocks.verify.mockResolvedValue(undefined)
})

describe('existing admin HTTP authorization', () => {
  it('checks the HTTP admin session without calling provisioning Functions', async () => {
    const session = await authGateway.refresh()
    expect(session?.isAdmin).toBe(true)
    expect(mocks.provision).not.toHaveBeenCalled()
    expect(mocks.verify).toHaveBeenCalledWith('test-token')
  })
  it('does not depend on the provisioning service being available', async () => {
    mocks.provision.mockRejectedValueOnce(new Error('profile denied'))
    expect((await authGateway.refresh())?.isAdmin).toBe(true)
    expect(mocks.verify).toHaveBeenCalledWith('test-token')
    expect(mocks.provision).not.toHaveBeenCalled()
  })
  it('keeps non-admin users outside admin APIs', async () => {
    mocks.token.mockResolvedValueOnce({token: 'user-token', claims: {admin: false}})
    expect((await authGateway.refresh())?.isAdmin).toBe(false)
    expect(mocks.provision).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it('rejects a revoked admin claim even after successful provisioning', async () => {
    mocks.verify.mockRejectedValueOnce({code: 'backend/access-denied'})
    await expect(authGateway.refresh()).rejects.toEqual({code: 'backend/access-denied'})
  })
})
