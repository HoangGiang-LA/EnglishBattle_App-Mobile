import { service as demo } from './mock-service'
import { FirebaseAdminService } from './firebase-service'
export function dataSource(value: string | undefined): 'mock' | 'firebase' {
  if (!value) return 'mock'
  if (value === 'mock' || value === 'firebase') return value
  throw new Error('VITE_ADMIN_DATA_SOURCE must be mock or firebase')
}
export const service =
  dataSource(import.meta.env.VITE_ADMIN_DATA_SOURCE) === 'firebase'
    ? new FirebaseAdminService()
    : demo
