import { object, valid } from './admin-response'
import type { AdminService } from '../domain'
import contract from '../../../contracts/admin.v1.json'
export type CallableTransport = (
  name: string,
  request: Record<string, unknown>,
) => Promise<{ data: unknown }>
const sdk: CallableTransport = async (name, request) => {
  const [{ firebaseFunctions }, { httpsCallable }] = await Promise.all([
    import('../firebase/client'),
    import('firebase/functions'),
  ])
  return httpsCallable<Record<string, unknown>, unknown>(firebaseFunctions, name)(request)
}
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean)
  if (object(v))
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, clean(x)]),
    )
  return v
}
export class FirebaseAdminService implements AdminService {
  readonly mode = 'firebase' as const
  private pending = new Map<string, { id: string; promise?: Promise<unknown> }>()
  constructor(private transport: CallableTransport = sdk) {}
  private async call<M extends Exclude<keyof AdminService, 'mode' | 'reset'>>(
    method: M,
    args: unknown[],
  ): Promise<Awaited<ReturnType<AdminService[M]>>> {
    if (method === 'saveQuestion') {
      const [input, id, version] = args
      if (id !== undefined && (!Number.isInteger(version) || Number(version) < 1))
        throw new Error('Editing requires expectedVersion.')
      if (
        object(input) &&
        typeof input.audioUrl === 'string' &&
        input.audioUrl &&
        !input.audioUrl.startsWith('https://')
      )
        throw new Error('Audio must use an HTTPS URL. Production upload is not available.')
    }
    if (method === 'saveUser' && object(args[0]))
      args = [
        {
          name: args[0].name,
          email: args[0].email,
          ...(args[1] === undefined && args[0].password !== undefined
            ? { password: args[0].password }
            : {}),
        },
        args[1],
      ]
    const spec = contract.methods[method]
    const request: Record<string, unknown> = {}
    let position = 0
    for (const field of spec.request) {
      if (field !== 'requestId') request[field.replace(/\?$/, '')] = args[position++]
    }
    const payload = clean(request) as Record<string, unknown>
    const mutation = spec.request.some((field) => field === 'requestId'),
      key = JSON.stringify([method, payload])
    const operation = this.pending.get(key) || { id: crypto.randomUUID() }
    if (operation.promise) return operation.promise as Promise<Awaited<ReturnType<AdminService[M]>>>
    if (mutation) {
      payload.requestId = operation.id
      this.pending.set(key, operation)
    }
    const execute = async () => {
      try {
        const { data } = await this.transport(spec.callable, payload)
        if (
          !object(data) ||
          typeof data.serverNow !== 'number' ||
          !Number.isFinite(data.serverNow) ||
          (spec.payloadKey !== null && !valid(method, data[spec.payloadKey]))
        )
          throw new Error('Invalid callable response: ' + spec.callable)
        if (mutation) {
          this.pending.delete(key)
          window.dispatchEvent(new Event('admin:data'))
        }
        return (spec.payloadKey === null ? undefined : data[spec.payloadKey]) as Awaited<
          ReturnType<AdminService[M]>
        >
      } catch (error) {
        if (
          object(error) &&
          ['functions/permission-denied', 'functions/unauthenticated'].includes(String(error.code))
        ) {
          this.pending.clear()
          window.dispatchEvent(new CustomEvent('admin:access-lost', { detail: error }))
        }
        throw error
      }
    }
    const promise = execute().finally(() => {
      operation.promise = undefined
    })
    if (mutation) operation.promise = promise
    return (await promise) as Awaited<ReturnType<AdminService[M]>>
  }
  profile: AdminService['profile'] = (...args) => this.call('profile', args)
  saveProfile: AdminService['saveProfile'] = (...args) => this.call('saveProfile', args)
  overview: AdminService['overview'] = (...args) => this.call('overview', args)
  users: AdminService['users'] = (...args) => this.call('users', args)
  user: AdminService['user'] = (...args) => this.call('user', args)
  saveUser: AdminService['saveUser'] = (...args) => this.call('saveUser', args)
  setUserStatus: AdminService['setUserStatus'] = (...args) => this.call('setUserStatus', args)
  questions: AdminService['questions'] = (...args) => this.call('questions', args)
  question: AdminService['question'] = (...args) => this.call('question', args)
  saveQuestion: AdminService['saveQuestion'] = (...args) => this.call('saveQuestion', args)
  archiveQuestion: AdminService['archiveQuestion'] = (...args) => this.call('archiveQuestion', args)
  catalog: AdminService['catalog'] = (...args) => this.call('catalog', args)
  saveContent: AdminService['saveContent'] = (...args) => this.call('saveContent', args)
  battles: AdminService['battles'] = (...args) => this.call('battles', args)
  battle: AdminService['battle'] = (...args) => this.call('battle', args)
  activities: AdminService['activities'] = (...args) => this.call('activities', args)
  search: AdminService['search'] = (...args) => this.call('search', args)
  notifications: AdminService['notifications'] = (...args) => this.call('notifications', args)
  readNotifications: AdminService['readNotifications'] = (...args) =>
    this.call('readNotifications', args)
  audit: AdminService['audit'] = (...args) => this.call('audit', args)
  exportReport: AdminService['exportReport'] = (...args) => this.call('exportReport', args)
  async reset(): Promise<void> {
    throw new Error('Reset is available only in demo mode.')
  }
}
