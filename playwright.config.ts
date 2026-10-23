import { defineConfig, devices } from '@playwright/test'
import { DIR_APP_E2E, DIR_DATOS_E2E } from './tests/e2e/rutas'

const PUERTO = 4100

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/preparar.ts',
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
    command: `pnpm --filter @pos/app exec vite build --outDir "${DIR_APP_E2E}" --emptyOutDir && pnpm --filter @pos/hub start`,
    url: `http://localhost:${PUERTO}/api/salud`,
    env: { PUERTO: String(PUERTO), DIR_APP: DIR_APP_E2E, DIR_DATOS: DIR_DATOS_E2E },
    // Siempre un hub nuevo: uno viejo en el puerto podría tener otra configuración de carpetas.
    reuseExistingServer: false,
  },
})
