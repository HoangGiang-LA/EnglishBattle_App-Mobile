import {defineConfig} from '@playwright/test'

// Real local services must be running; this suite never substitutes Firebase responses.
export default defineConfig({
  testDir: './e2e-local',
  testMatch: 'auth.spec.ts',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chromium',
    viewport: {width: 1280, height: 800},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
