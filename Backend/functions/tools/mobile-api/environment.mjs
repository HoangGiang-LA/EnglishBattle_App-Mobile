import {existsSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseEnv} from 'node:util'

export const functionsDir = fileURLToPath(new URL('../../', import.meta.url))
export const serverDir = resolve(functionsDir, '../server')

export function validateMobileEnvironment(env) {
  if (env.FIREBASE_PROJECT_ID !== 'englishbattleapp-8d764' ||
      env.FIREBASE_DATABASE_URL !== 'https://englishbattleapp-8d764-default-rtdb.asia-southeast1.firebasedatabase.app') {
    throw new Error('Check FIREBASE_PROJECT_ID and FIREBASE_DATABASE_URL in Backend/server/.env.')
  }
  for (const name of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST',
    'FIRESTORE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'FUNCTIONS_EMULATOR']) {
    if (env[name]) throw new Error(`The production mobile API cannot run with ${name}.`)
  }
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS in Backend/server/.env.')
  const credentials = resolve(serverDir, env.GOOGLE_APPLICATION_CREDENTIALS)
  if (!existsSync(credentials)) throw new Error('The private Admin SDK key file was not found.')
  const account = JSON.parse(readFileSync(credentials, 'utf8'))
  if (account.type !== 'service_account' || account.project_id !== env.FIREBASE_PROJECT_ID) {
    throw new Error('The Admin SDK key must belong to the configured Firebase project.')
  }
  const port = Number(env.MOBILE_API_PORT || 8081)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MOBILE_API_PORT.')
  return {...env, GOOGLE_APPLICATION_CREDENTIALS: credentials,
    GCLOUD_PROJECT: env.FIREBASE_PROJECT_ID, GOOGLE_CLOUD_PROJECT: env.FIREBASE_PROJECT_ID,
    MOBILE_API_PORT: String(port)}
}

export function loadMobileEnvironment() {
  const path = resolve(serverDir, '.env')
  if (!existsSync(path)) throw new Error('Create Backend/server/.env from .env.example first.')
  return validateMobileEnvironment({...parseEnv(readFileSync(path, 'utf8')), ...process.env})
}
