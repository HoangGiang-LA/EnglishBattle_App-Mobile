import type { FirebaseOptions } from 'firebase/app'

/** Public Firebase Web App configuration; permissions are enforced by Auth, Rules and backend. */
const liveFirebaseConfig: FirebaseOptions = {
  apiKey: 'AIzaSyDIihn3E5yD4aq9PJbo8vltY0AFKonJlPQ',
  authDomain: 'englishbattleapp-8d764.firebaseapp.com',
  databaseURL: 'https://englishbattleapp-8d764-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'englishbattleapp-8d764',
  storageBucket: 'englishbattleapp-8d764.firebasestorage.app',
  messagingSenderId: '1052524880202',
  appId: '1:1052524880202:web:705ddeba488ad278fb21b3',
  measurementId: 'G-163K5P0CPQ',
}

/** QA opt-in is accepted only in the dev server and only for a demo project. */
export const adminQaProject = import.meta.env.DEV
  ? String(import.meta.env.VITE_ADMIN_QA_PROJECT || '')
  : ''
if (adminQaProject && !/^demo-[a-z0-9-]+$/.test(adminQaProject))
  throw new Error('Admin QA requires a demo project.')
export const firebaseConfig: FirebaseOptions = adminQaProject
  ? {
      apiKey: 'emulator-only',
      projectId: adminQaProject,
      authDomain: 'localhost',
      databaseURL: `https://${adminQaProject}-default-rtdb.asia-southeast1.firebasedatabase.app`,
      appId: '1:0000000000:web:admin-qa',
    }
  : liveFirebaseConfig
