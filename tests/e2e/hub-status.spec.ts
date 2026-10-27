import { expect, test } from '@playwright/test'

// Pending (task 0.10): the home screen with "Conectado al hub" was replaced by the operations
// one (pairing, PIN, tables). These tests get rewritten against the new connection indicator
// along with scenario 14, in the final e2e run (docs/ROADMAP.md).
test.skip(true, 'Rewritten with scenario 14 in the final e2e run')

const HEALTH = '**/api/health'

test('on startup shows "Buscando el hub" until the hub responds', async ({ page }) => {
  let release: () => void = () => {}
  const heldPromise = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(HEALTH, async (route) => {
    await heldPromise
    await route.continue()
  })

  await page.goto('/')
  await expect(page.getByText('Buscando el hub')).toBeVisible()
  await expect(page.getByText('Conectado al hub')).toBeHidden()
  await expect(page.getByText('Sin conexión con el hub')).toBeHidden()

  release()
  await expect(page.getByText('Conectado al hub')).toBeVisible()
})

test('if the hub hangs (does not respond) it switches to "Sin conexión" when the timeout expires', async ({
  page,
}) => {
  // The request stays open forever: the hub accepted the connection but does not answer.
  await page.route(HEALTH, () => new Promise<void>(() => {}))

  await page.goto('/')
  await expect(page.getByText('Buscando el hub')).toBeVisible()
  await expect(page.getByText('Sin conexión con el hub')).toBeVisible()
})

test('if the hub hangs while connected, it warns and recovers when it responds again', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByText('Conectado al hub')).toBeVisible()

  await page.route(HEALTH, () => new Promise<void>(() => {}))
  // Worst case: the next poll goes out at 3 s and times out at 2 s (5 s in total).
  await expect(page.getByText('Sin conexión con el hub')).toBeVisible({ timeout: 10_000 })

  await page.unroute(HEALTH)
  await expect(page.getByText('Conectado al hub')).toBeVisible()
})

test('if the hub responds with a server error, shows "Sin conexión"', async ({ page }) => {
  await page.route(HEALTH, (route) => route.fulfill({ status: 500, body: 'error' }))

  await page.goto('/')
  await expect(page.getByText('Sin conexión con el hub')).toBeVisible()
})

test('the hub serves the app assets with their content type', async ({ page, request }) => {
  await page.goto('/')
  const js = await page.locator('script[src]').first().getAttribute('src')
  const css = await page.locator('link[rel="stylesheet"]').first().getAttribute('href')
  const routes = [js, css].map((route) => new URL(route ?? '', page.url()).pathname)

  expect(routes.some((r) => r.endsWith('.js'))).toBe(true)
  expect(routes.some((r) => r.endsWith('.css'))).toBe(true)
  for (const route of routes) {
    const res = await request.get(route)
    expect(res.status()).toBe(200)
    const type = res.headers()['content-type'] ?? ''
    expect(type).toMatch(route.endsWith('.js') ? /javascript/ : /text\/css/)
  }
})

test('the hub does not serve files outside the app folder', async ({ request }) => {
  for (const route of [
    '/../package.json',
    '/%2e%2e/package.json',
    '/assets/..%2f..%2f..%2f..%2fpackage.json',
  ]) {
    const res = await request.get(route)
    expect(await res.text()).not.toContain('"restaurant-pos"')
    expect(await res.text()).not.toContain('"@pos/app"')
  }
})
