import { expect, it, vi } from 'vitest'
const sdk = vi.hoisted(() => ({ functions: {}, call: vi.fn(), result: vi.fn() }))
vi.mock('../firebase/client', () => ({ firebaseFunctions: sdk.functions }))
vi.mock('firebase/functions', () => ({ httpsCallable: sdk.call }))
import { FirebaseAdminService } from '../data/firebase-service'
it('lazily uses the shared connected Functions instance and unwraps result.data', async () => {
  const api = new FirebaseAdminService()
  expect(sdk.call).not.toHaveBeenCalled()
  sdk.result.mockResolvedValue({
    data: { serverNow: 1, page: { items: [], total: 0, page: 1, pageSize: 10 } },
  })
  sdk.call.mockReturnValue(sdk.result)
  await expect(api.users({ q: 'learner' })).resolves.toEqual({
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
  })
  expect(sdk.call).toHaveBeenCalledWith(sdk.functions, 'adminListUsers')
  expect(sdk.result).toHaveBeenCalledWith({ query: { q: 'learner' } })
})
