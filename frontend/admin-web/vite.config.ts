import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const dataMode =
    process.env.VITE_ADMIN_DATA_MODE ||
    loadEnv(mode, process.cwd(), 'VITE_').VITE_ADMIN_DATA_MODE ||
    'firebase'
  if (!['firebase', 'demo'].includes(dataMode))
    throw new Error('VITE_ADMIN_DATA_MODE must be firebase or demo.')
  return {
    plugins: [
      react(),
      {
        name: 'admin-firebase-bundle',
        generateBundle(_options, bundle) {
          if (dataMode === 'demo') return
          for (const chunk of Object.values(bundle)) {
            if (
              chunk.type === 'chunk' &&
              Object.keys(chunk.modules).some((id) =>
                /\/src\/data\/(?:mock-service\.ts|seed\.ts|content-seed\.json)$/.test(
                  id.replaceAll('\\', '/'),
                ),
              )
            ) {
              throw new Error(
                'The Firebase build must not include mock services or demo seed data.',
              )
            }
          }
        },
      },
    ],
    optimizeDeps: { include: ['firebase/app', 'firebase/auth', 'firebase/database'] },
    server: { port: 5173, strictPort: true },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      restoreMocks: true,
      testTimeout: 10_000,
      css: false,
      exclude: ['e2e/**', 'node_modules/**'],
    },
  }
})
