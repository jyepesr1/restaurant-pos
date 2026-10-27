import { defineConfig, devices } from '@playwright/test'
import { DATA_DIR_E2E, APP_DIR_E2E } from './tests/e2e/routes'

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
    // La carpeta de datos se limpia en el mismo comando, antes de arrancar el hub: Playwright
    // arranca el servidor antes que cualquier globalSetup.
    command: `node -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })" "${DATA_DIR_E2E}" && pnpm --filter @pos/app exec vite build --outDir "${APP_DIR_E2E}" --emptyOutDir && pnpm --filter @pos/hub start`,
    url: `http://localhost:${PORT}/api/health`,
    env: { PORT: String(PORT), APP_DIR: APP_DIR_E2E, DATA_DIR: DATA_DIR_E2E },
    // Siempre un hub nuevo: uno viejo en el puerto podría tener otra configuración de carpetas.
    reuseExistingServer: false,
  },
})
