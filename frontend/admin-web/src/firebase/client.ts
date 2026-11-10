import { getApps, initializeApp } from 'firebase/app'
import {
  browserSessionPersistence,
  connectAuthEmulator,
  getAuth,
  getIdTokenResult,
  onIdTokenChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth'
import { connectDatabaseEmulator, getDatabase } from 'firebase/database'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { environment } from './environment'
import { sessionFromClaims, type AuthGateway, type FirebaseSession } from './auth'
import { verifyAdminAccess } from './backend'

const appName = environment.local ? 'english-battle-admin-local' : 'english-battle-admin-web'
export const firebaseApp =
  getApps().find((app) => app.name === appName) || initializeApp(environment.config, appName)
export const firebaseAuth = getAuth(firebaseApp)
// Creating the SDK instance does not grant access or read/write data.
export const firebaseDatabase = getDatabase(firebaseApp)
export const firebaseFunctions = getFunctions(firebaseApp, 'asia-southeast1')
const emulatorState = globalThis as typeof globalThis & { __adminEmulators?: Set<string> }
const connected = (emulatorState.__adminEmulators ||= new Set<string>())
if (environment.local && !connected.has(firebaseApp.name)) {
  connectAuthEmulator(firebaseAuth, 'http://127.0.0.1:9099')
  connectDatabaseEmulator(firebaseDatabase, '127.0.0.1', 9000)
  connectFunctionsEmulator(firebaseFunctions, '127.0.0.1', 5001)
  connected.add(firebaseApp.name)
}
async function session(user: User, refresh = false): Promise<FirebaseSession> {
  const token = await getIdTokenResult(user, refresh)
  if (token.claims.admin === true) {
    // Existing accounts are authorized read-only by the HTTP server.
    await verifyAdminAccess(token.token)
  }
  return sessionFromClaims(user, token.claims)
}

export const authGateway: AuthGateway = {
  subscribe(next, onError) {
    let generation = 0,
      closed = false
    const unsubscribe = onIdTokenChanged(
      firebaseAuth,
      (user) => {
        const current = ++generation
        if (!user) {
          if (!closed) next(null)
          return
        }
        void session(user)
          .then((value) => {
            if (!closed && generation === current && firebaseAuth.currentUser?.uid === value.uid)
              next(value)
          })
          .catch((error) => {
            if (!closed && generation === current) onError(error)
          })
      },
      onError,
    )
    return () => {
      closed = true
      generation++
      unsubscribe()
    }
  },
  async signIn(email, password) {
    await setPersistence(firebaseAuth, browserSessionPersistence)
    await signInWithEmailAndPassword(firebaseAuth, email.trim(), password)
  },
  signOut: () => signOut(firebaseAuth),
  async refresh() {
    const user = firebaseAuth.currentUser
    if (!user) return null
    const result = await session(user, true)
    return firebaseAuth.currentUser?.uid === user.uid ? result : null
  },
}
