import { expect, test } from '@playwright/test'

const SALUD = '**/api/salud'

test('al arrancar muestra "Buscando el hub" hasta que el hub responde', async ({ page }) => {
  let liberar: () => void = () => {}
  const retenida = new Promise<void>((resolver) => {
    liberar = resolver
  })
  await page.route(SALUD, async (ruta) => {
    await retenida
    await ruta.continue()
  })

  await page.goto('/')
  await expect(page.getByText('Buscando el hub')).toBeVisible()
  await expect(page.getByText('Conectado al hub')).toBeHidden()
  await expect(page.getByText('Sin conexión con el hub')).toBeHidden()

  liberar()
  await expect(page.getByText('Conectado al hub')).toBeVisible()
})

test('si el hub está colgado (no responde) pasa a "Sin conexión" al vencer el tiempo de espera', async ({
  page,
}) => {
  // La petición queda abierta para siempre: el hub aceptó la conexión pero no contesta.
  await page.route(SALUD, () => new Promise<void>(() => {}))

  await page.goto('/')
  await expect(page.getByText('Buscando el hub')).toBeVisible()
  await expect(page.getByText('Sin conexión con el hub')).toBeVisible()
})

test('si el hub se cuelga estando conectado, avisa y se recupera cuando vuelve a responder', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByText('Conectado al hub')).toBeVisible()

  await page.route(SALUD, () => new Promise<void>(() => {}))
  // Peor caso: el siguiente sondeo sale a los 3 s y vence a los 2 s (5 s en total).
  await expect(page.getByText('Sin conexión con el hub')).toBeVisible({ timeout: 10_000 })

  await page.unroute(SALUD)
  await expect(page.getByText('Conectado al hub')).toBeVisible()
})

test('si el hub responde con error del servidor, muestra "Sin conexión"', async ({ page }) => {
  await page.route(SALUD, (ruta) => ruta.fulfill({ status: 500, body: 'error' }))

  await page.goto('/')
  await expect(page.getByText('Sin conexión con el hub')).toBeVisible()
})

test('el hub sirve los assets de la app con su tipo de contenido', async ({ page, request }) => {
  await page.goto('/')
  const js = await page.locator('script[src]').first().getAttribute('src')
  const css = await page.locator('link[rel="stylesheet"]').first().getAttribute('href')
  const rutas = [js, css].map((ruta) => new URL(ruta ?? '', page.url()).pathname)

  expect(rutas.some((r) => r.endsWith('.js'))).toBe(true)
  expect(rutas.some((r) => r.endsWith('.css'))).toBe(true)
  for (const ruta of rutas) {
    const res = await request.get(ruta)
    expect(res.status()).toBe(200)
    const tipo = res.headers()['content-type'] ?? ''
    expect(tipo).toMatch(ruta.endsWith('.js') ? /javascript/ : /text\/css/)
  }
})

test('el hub no entrega archivos fuera de la carpeta de la app', async ({ request }) => {
  for (const ruta of [
    '/../package.json',
    '/%2e%2e/package.json',
    '/assets/..%2f..%2f..%2f..%2fpackage.json',
  ]) {
    const res = await request.get(ruta)
    expect(await res.text()).not.toContain('"restaurant-pos"')
    expect(await res.text()).not.toContain('"@pos/app"')
  }
})
