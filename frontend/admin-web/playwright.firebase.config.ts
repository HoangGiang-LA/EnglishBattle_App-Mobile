import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'firebase-users.spec.ts',
    'firebase-content.spec.ts',
    'firebase-monitoring.spec.ts',
    'firebase-analytics.spec.ts',
  ],
  outputDir: 'test-results/firebase',
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 30000 },
  use: {
    baseURL: 'http://127.0.0.1:15173',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'firebase-desktop', use: { viewport: { width: 1280, height: 800 } } }],
})
