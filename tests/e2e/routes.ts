import { fileURLToPath } from 'node:url'

/** Test-only folders: never the app or the data of the development hub. */
export const APP_DIR_E2E = fileURLToPath(new URL('../../.e2e/app', import.meta.url))
export const DATA_DIR_E2E = fileURLToPath(new URL('../../.e2e/data', import.meta.url))
