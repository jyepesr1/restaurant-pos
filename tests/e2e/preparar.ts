import { rm } from 'node:fs/promises'
import { DIR_DATOS_E2E } from './rutas'

/** Cada corrida empieza con la carpeta de datos de pruebas vacía. */
export default async function preparar() {
  await rm(DIR_DATOS_E2E, { recursive: true, force: true })
}
