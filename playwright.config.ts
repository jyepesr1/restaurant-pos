import { defineConfig, devices } from '@playwright/test'

const PUERTO = 4100

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PUERTO}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'celular-android', use: { ...devices['Pixel 7'] } },
    { name: 'caja', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'pnpm --filter @pos/app build && pnpm --filter @pos/hub start',
    url: `http://localhost:${PUERTO}/api/salud`,
    env: { PUERTO: String(PUERTO) },
    reuseExistingServer: !process.env.CI,
  },
})
