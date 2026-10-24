import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'
import { DIR_DATOS_E2E } from './rutas'

// El hub de las pruebas abre y migra su base en DIR_DATOS al arrancar, y la toma en exclusiva.
// Corre en un solo proyecto porque ambos comparten el mismo hub y la misma carpeta.
test('el hub de pruebas deja su base migrada y la toma en exclusiva', async ({
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'caja', 'Una sola ejecución basta')

  const salud = await request.get('/api/salud')
  expect(salud.ok()).toBe(true)
  expect(await salud.json()).toMatchObject({ version_base: 1 })

  const ruta = join(DIR_DATOS_E2E, 'pos.sqlite')
  expect(existsSync(ruta), `falta ${ruta}`).toBe(true)

  // Otro proceso no puede leerla mientras el hub la tenga abierta.
  const db = new DatabaseSync(ruta, { readOnly: true })
  try {
    expect(() => db.prepare('SELECT max(version) AS version FROM migracion').get()).toThrow(
      /locked/,
    )
  } finally {
    db.close()
  }
})
