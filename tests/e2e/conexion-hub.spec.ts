import { expect, test } from '@playwright/test'

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
