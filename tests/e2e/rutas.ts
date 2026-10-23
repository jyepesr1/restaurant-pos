import { fileURLToPath } from 'node:url'

/** Carpetas exclusivas de las pruebas: nunca la app ni los datos del hub de desarrollo. */
export const DIR_APP_E2E = fileURLToPath(new URL('../../.e2e/app', import.meta.url))
export const DIR_DATOS_E2E = fileURLToPath(new URL('../../.e2e/datos', import.meta.url))
