import { defineConfig, devices } from '@playwright/test'
import { APP_DIR_E2E, DATA_DIR_E2E } from './tests/e2e/routes'

const PORT = 4100

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'android-phone', use: { ...devices['Pixel 7'] } },
    { name: 'register', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // The data folder is cleared in the same command, before starting the hub: Playwright
    // starts the server before any globalSetup.
    command: `node -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })" "${DATA_DIR_E2E}" && pnpm --filter @pos/app exec vite build --outDir "${APP_DIR_E2E}" --emptyOutDir && pnpm --filter @pos/hub start`,
    url: `http://localhost:${PORT}/api/health`,
    env: { PORT: String(PORT), APP_DIR: APP_DIR_E2E, DATA_DIR: DATA_DIR_E2E },
    // Always a fresh hub: an old one on the port could have a different folder setup.
    reuseExistingServer: false,
  },
})
