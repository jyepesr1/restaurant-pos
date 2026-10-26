import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'
import { DATA_DIR_E2E } from './rutas'

// El hub de las pruebas abre y migra su base en DATA_DIR al arrancar, y la toma en exclusiva.
// Corre en un solo proyecto porque ambos comparten el mismo hub y la misma carpeta.
test('el hub de pruebas deja su base migrada y la toma en exclusiva', async ({
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'register', 'Una sola ejecución basta')

  const salud = await request.get('/api/health')
  expect(salud.ok()).toBe(true)
  // Última migración: 0002 (comprobante de supervisor atado al evento, tarea 0.7).
  expect(await salud.json()).toMatchObject({ version_base: 2 })

  const ruta = join(DATA_DIR_E2E, 'pos.sqlite')
  expect(existsSync(ruta), `falta ${ruta}`).toBe(true)

  // Otro proceso no puede leerla mientras el hub la tenga abierta.
  const db = new DatabaseSync(ruta, { readOnly: true })
  try {
    expect(() => db.prepare('SELECT max(version) AS version FROM migrations').get()).toThrow(
      /locked/,
    )
  } finally {
    db.close()
  }
})
