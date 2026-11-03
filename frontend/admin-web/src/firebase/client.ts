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
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions'
import { adminQaProject, firebaseConfig } from './config'
import { sessionFromClaims, type AuthGateway, type FirebaseSession } from './auth'
import { verifyAdminAccess } from './backend'

const appName = 'english-battle-admin-web'
export const firebaseApp =
  getApps().find((app) => app.name === appName) || initializeApp(firebaseConfig, appName)
export const firebaseAuth = getAuth(firebaseApp)
// Creating the SDK instance does not grant access or read/write data.
export const firebaseDatabase = getDatabase(firebaseApp)
export const firebaseFunctions = getFunctions(firebaseApp, 'asia-southeast1')
if (adminQaProject) {
  connectAuthEmulator(firebaseAuth, 'http://127.0.0.1:19299', { disableWarnings: true })
  connectDatabaseEmulator(firebaseDatabase, '127.0.0.1', 19200)
  connectFunctionsEmulator(firebaseFunctions, '127.0.0.1', 15003)
} else if (import.meta.env.DEV && import.meta.env.VITE_USE_FUNCTIONS_EMULATOR === 'true') {
  connectFunctionsEmulator(firebaseFunctions, '127.0.0.1', 5001)
}
const ensureUserProfile = httpsCallable(firebaseFunctions, 'ensureUserProfile')

async function session(user: User, refresh = false): Promise<FirebaseSession> {
  const token = await getIdTokenResult(user, refresh)
  if (token.claims.admin === true) {
    // The BE1 Callable is the sole provisioning owner; HTTP only authorizes.
    await ensureUserProfile({})
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
