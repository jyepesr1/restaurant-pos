import { expect, test } from '@playwright/test'

// Pendiente (tarea 0.10): la pantalla de inicio con "Conectado al hub" se reemplazó por la de
// operación (emparejar, PIN, mesas). Estas pruebas se reescriben sobre el indicador de conexión
// nuevo junto con el escenario 14, en la corrida e2e del final (docs/ROADMAP.md).
test.skip(true, 'Se reescribe con el escenario 14 en la corrida e2e del final')

test('la app servida por el hub muestra que está conectada', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Conectado al hub')).toBeVisible()
})

test('la app avisa cuando el hub deja de responder y se recupera cuando vuelve', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByText('Conectado al hub')).toBeVisible()

  await page.route('**/api/salud', (ruta) => ruta.abort('connectionrefused'))
  await expect(page.getByText('Sin conexión con el hub')).toBeVisible()

  await page.unroute('**/api/salud')
  await expect(page.getByText('Conectado al hub')).toBeVisible()
})
