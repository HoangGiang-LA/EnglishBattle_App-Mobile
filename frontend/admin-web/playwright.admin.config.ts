import { defineConfig } from '@playwright/test'
import local from './playwright.local.config'
export default defineConfig({ ...local, testMatch: 'admin.spec.ts', timeout: 90000 })
