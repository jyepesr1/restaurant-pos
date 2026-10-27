import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test, type WebSocketRoute } from '@playwright/test'
import { DATA_DIR_E2E } from './routes'

const FILE = join(DATA_DIR_E2E, 'diagnostics.jsonl')
const ERROR_MESSAGE = '✕ No llegó al hub. Revisa que el equipo esté en el Wi-Fi del local.'

/**
 * Lets the diagnostics WebSockets through to the real hub, but keeps each connection
 * so the test can cut it (simulates Wi-Fi down or a phone going to sleep).
 */
async function interceptWs(page: Page) {
  const connections: WebSocketRoute[] = []
  await page.routeWebSocket('**/api/diagnostics/ws', (ws) => {
    ws.connectToServer()
    connections.push(ws)
  })
  return connections
}

/**
 * Makes Date.now() never repeat a value. The log orders events by millisecond;
 * without this, two events in the same millisecond (e.g. "hidden" and "ws-closed") can
 * end up swapped and the test would depend on the machine's speed.
 */
async function clockWithoutTies(page: Page) {
  await page.addInitScript(() => {
    const real = Date.now.bind(Date)
    let latest = 0
    Date.now = () => {
      latest = Math.max(real(), latest + 1)
      return latest
    }
  })
}

/** Simulates the phone locking or unlocking the screen (visibilitychange). */
async function changeVisibility(page: Page, isHidden: boolean) {
  // Evaluated as text because this test project does not include the DOM types.
  await page.evaluate(`(() => {
    const hidden = ${isHidden}
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })()`)
}

/**
 * Hub that can be "turned off": while `down` is true it rejects every new connection. Keeps in
 * `connections` only those that reached the real hub, so its length counts the hub's connections.
 */
async function controllableHub(page: Page) {
  const hub = { down: false, connections: [] as WebSocketRoute[] }
  await page.routeWebSocket('**/api/diagnostics/ws', (ws) => {
    if (hub.down) {
      ws.close({ code: 1011 })
      return
    }
    ws.connectToServer()
    hub.connections.push(ws)
  })
  return hub
}

/**
 * Wraps WebSocket in the page to count live sockets (CONNECTING or OPEN) and the maximum
 * open at once. With `window.__hang = true` new sockets stay in CONNECTING
 * forever, like an attempt made with the screen locked. Must be registered after
 * `controllableHub`, to wrap the WebSocket that Playwright already intercepts.
 */
async function instrumentWs(page: Page) {
  await page.addInitScript(`(() => {
    const Real = window.WebSocket
    window.__ws = []
    window.__maxLive = 0
    window.__hang = false
    function hung() {
      const fake = new EventTarget()
      fake.readyState = 0
      fake.send = () => {}
      fake.close = () => { fake.readyState = 3 }
      return fake
    }
    window.WebSocket = function (url, protocols) {
      const ws = window.__hang ? hung() : new Real(url, protocols)
      window.__ws.push(ws)
      const live = window.__ws.filter((w) => w.readyState <= 1).length
      window.__maxLive = Math.max(window.__maxLive, live)
      return ws
    }
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  })()`)
}

interface PageSockets {
  live: number
  maxConcurrent: number
  /** readyState of each socket created, in order. */
  statuses: number[]
}

const readSockets = (page: Page) =>
  page.evaluate(`({
    live: window.__ws.filter((w) => w.readyState <= 1).length,
    maxConcurrent: window.__maxLive,
    statuses: window.__ws.map((w) => w.readyState),
  })`) as Promise<PageSockets>

const hangNewSockets = (page: Page, hang: boolean) => page.evaluate(`window.__hang = ${hang}`)

const row = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title })
const CHANNEL = 'Canal en tiempo real'
const LOCK = 'Última vez en segundo plano'
const wsConnected = (page: Page) => expect(row(page, CHANNEL)).toContainText('✓ Conectado')
const wsDisconnected = (page: Page) =>
  expect(row(page, CHANNEL)).toContainText('✕ Desconectado, reintentando')
/** Value (right column) of a diagnostics row. */
const value = (page: Page, title: string) => row(page, title).locator(':scope > span').last()
const enterName = (page: Page, name = 'Equipo de pruebas') =>
  page.getByLabel('Nombre de este equipo').fill(name)

const submission = (page: Page) =>
  page.getByRole('button', { name: /Enviar resultados al hub|Enviando/ })

test.describe('diagnostics screen', () => {
  test('shows the channel connected, the response time and local data working', async ({
    page,
  }) => {
    await page.goto('/diagnostics')

    await expect(page.getByRole('heading', { name: 'Diagnóstico del dispositivo' })).toBeVisible()
    await wsConnected(page)
    await expect(row(page, 'Datos locales (IndexedDB)')).toContainText('✓ Funciona')
    await expect(row(page, 'Tiempo de respuesta')).toContainText('Midiendo')
    // The first ping goes out 5 s after the socket opens.
    await expect(row(page, 'Tiempo de respuesta')).toContainText(/\d+ ms/, { timeout: 15_000 })
    await expect(row(page, 'Tiempo de respuesta')).not.toContainText('Midiendo')
  })

  test('the home screen links to /diagnostics', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Diagnóstico del equipo' }).click()
    await expect(page).toHaveURL(/\/diagnostics$/)
    await expect(page.getByRole('heading', { name: 'Diagnóstico del dispositivo' })).toBeVisible()
  })

  test('if the channel drops it shows "Desconectado" and reconnects on its own', async ({
    page,
  }) => {
    const connections = await interceptWs(page)
    await page.goto('/diagnostics')
    await wsConnected(page)
    expect(connections).toHaveLength(1)

    await connections[0]?.close({ code: 1006 })
    await wsDisconnected(page)

    // The first retry goes out after one second.
    await wsConnected(page)
    expect(connections).toHaveLength(2)
    // The reconnection shows up in the summary counter (refreshed every 3 s).
    await expect(value(page, 'Veces que se reconectó')).toHaveText('1', { timeout: 10_000 })
  })

  test('keeps retrying while the hub rejects the connection and recovers when it is back', async ({
    page,
  }) => {
    let hubDown = false
    const connections: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostics/ws', (ws) => {
      if (hubDown) {
        ws.close({ code: 1011 })
        return
      }
      ws.connectToServer()
      connections.push(ws)
    })

    await page.goto('/diagnostics')
    await wsConnected(page)

    hubDown = true
    await connections[0]?.close()
    await wsDisconnected(page)
    // Survives several failed attempts in a row without losing the notice.
    await wsDisconnected(page)

    hubDown = false
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 10_000 })
  })

  test('hiding and showing the page updates the last lock summary', async ({ page }) => {
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)
    const lock = row(page, LOCK)
    await expect(lock).toContainText('Aún no ha pasado')

    await changeVisibility(page, true)
    await changeVisibility(page, false)

    // On return it waits up to 3 s for a hub response before treating the connection as alive.
    await expect(lock).toContainText('sin cortes', { timeout: 10_000 })
    await expect(lock).not.toContainText('Aún no ha pasado')
    // With everything measured and no drops, the verdict turns green.
    await expect(page.getByText('Listo para operar')).toBeVisible({ timeout: 15_000 })
  })

  test('if the connection is lost while the screen is locked it says so', async ({ page }) => {
    const connections = await interceptWs(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    await changeVisibility(page, true)
    await connections[0]?.close({ code: 1006 })
    await wsDisconnected(page)
    await changeVisibility(page, false)

    const lock = row(page, LOCK)
    await expect(lock).toContainText('se perdió la conexión', { timeout: 10_000 })
    await expect(page.getByText('En segundo plano se pierde la conexión')).toBeVisible()
  })

  test('if a connection attempt hangs, it abandons it and tries again', async ({ page }) => {
    // The first WebSocket never opens or fails, as happened on Android with the screen locked.
    await page.addInitScript(`(() => {
      const Real = window.WebSocket
      let created = 0
      function Hung() {
        const fake = new EventTarget()
        fake.readyState = 0
        fake.send = () => {}
        fake.close = () => { fake.readyState = 3 }
        return fake
      }
      window.WebSocket = function (url, protocols) {
        created += 1
        return created === 1 ? Hung() : new Real(url, protocols)
      }
      Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
    })()`)

    await page.goto('/diagnostics')
    await expect(row(page, CHANNEL)).toContainText('Conectando')
    // It is abandoned at 4 s and the next attempt goes out after one second.
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 10_000 })
  })

  test('on return without connection it reconnects immediately, without waiting for the retry', async ({
    page,
  }) => {
    let hubDown = false
    const connections: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostics/ws', (ws) => {
      if (hubDown) {
        ws.close({ code: 1011 })
        return
      }
      ws.connectToServer()
      connections.push(ws)
    })
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    // With the screen locked it drops and retries fail: the wait between them grows.
    await changeVisibility(page, true)
    hubDown = true
    await connections[0]?.close({ code: 1006 })
    await page.waitForTimeout(7000)

    // The hub comes back right when the user unlocks: it must reconnect in under 1.5 s,
    // even if the scheduled retry was several seconds away.
    hubDown = false
    await changeVisibility(page, false)
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 1500 })
    await expect(row(page, LOCK)).toContainText('volvió en', { timeout: 10_000 })
  })

  test('on return without connection there are never two sockets open at once', async ({
    page,
  }) => {
    const hub = await controllableHub(page)
    await instrumentWs(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    // It drops with the screen locked and retries fail: a retry stays scheduled.
    await changeVisibility(page, true)
    hub.down = true
    await hub.connections[0]?.close({ code: 1006 })
    await wsDisconnected(page)

    hub.down = false
    await changeVisibility(page, false)
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 3000 })

    // The old retry would have fired at most at 5 s (maximum wait between attempts): if
    // it was not canceled on return, it would open a second socket. A real-time window on purpose.
    await page.waitForTimeout(6000)
    await wsConnected(page)
    const sockets = await readSockets(page)
    expect(sockets.live).toBe(1)
    expect(sockets.maxConcurrent).toBe(1)
  })

  test('if on return an attempt is still CONNECTING, it discards it and reconnects without waiting', async ({
    page,
  }) => {
    const hub = await controllableHub(page)
    await instrumentWs(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    // Screen locked: it drops and the retry (after one second) hangs in CONNECTING.
    await changeVisibility(page, true)
    await hangNewSockets(page, true)
    await hub.connections[0]?.close({ code: 1006 })
    await expect.poll(async () => (await readSockets(page)).statuses).toEqual([3, 0])

    // The hub is fine: the user returns when the attempt has been hanging only briefly.
    await hangNewSockets(page, false)
    await changeVisibility(page, false)

    // It must reconnect before the 4 s limit abandons the attempt on its own.
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 3000 })
    const sockets = await readSockets(page)
    expect(sockets.statuses).toEqual([3, 3, 1])
    expect(sockets.live).toBe(1)
    expect(hub.connections).toHaveLength(2)
    await expect(row(page, LOCK)).toContainText('volvió en', { timeout: 10_000 })
  })

  test('a healthy connection reopened on return is not discarded for not having received messages yet', async ({
    page,
  }) => {
    const hub = await controllableHub(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    await changeVisibility(page, true)
    hub.down = true
    await hub.connections[0]?.close({ code: 1006 })
    await wsDisconnected(page)
    hub.down = false
    await changeVisibility(page, false)
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 3000 })

    // The row only changes after the 3 s check on return, which is when it could discard it.
    await expect(row(page, LOCK)).toContainText('volvió en', { timeout: 10_000 })
    await wsConnected(page)
    // The hub sends nothing right after opening (first heartbeat at 5 s): that is not "silent".
    expect(hub.connections).toHaveLength(2)
    await expect(value(page, 'Veces que se reconectó')).toHaveText('1', { timeout: 10_000 })
  })

  test('hiding and returning several times in a row without connection does not duplicate sockets and ends connected', async ({
    page,
  }) => {
    const hub = await controllableHub(page)
    await instrumentWs(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    await changeVisibility(page, true)
    hub.down = true
    await hub.connections[0]?.close({ code: 1006 })
    // Three quick returns with the hub still down, and the last one with the hub available again.
    await changeVisibility(page, false)
    await changeVisibility(page, true)
    await changeVisibility(page, false)
    await changeVisibility(page, true)
    hub.down = false
    await changeVisibility(page, false)

    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 5000 })
    // At most one attempt per return, and scheduled retries must not add another socket.
    await page.waitForTimeout(6000)
    await wsConnected(page)
    const sockets = await readSockets(page)
    expect(sockets.live).toBe(1)
    expect(sockets.maxConcurrent).toBe(1)

    const lock = row(page, LOCK)
    await expect(lock).toContainText('se perdió la conexión', { timeout: 10_000 })
    await expect(lock).toContainText('volvió en')
    await expect(lock).not.toContainText('aún reconectando')
    // It recovered instantly: the more-than-3-s notice must not appear.
    await expect(page.getByText('En segundo plano se pierde la conexión')).toBeVisible()
    await expect(page.getByText('tardó más de 3 s en reconectar')).toBeHidden()
  })

  test('"aún reconectando" shows while the hub is still down and switches to "volvió en" when it is back', async ({
    page,
  }) => {
    const hub = await controllableHub(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    await changeVisibility(page, true)
    hub.down = true
    await hub.connections[0]?.close({ code: 1006 })
    await changeVisibility(page, false)

    // The check on return lasts 3 s and the summary refreshes every 3 s.
    const lock = row(page, LOCK)
    await expect(lock).toContainText('se perdió la conexión', { timeout: 10_000 })
    await expect(lock).toContainText('(aún reconectando)')
    await expect(lock).not.toContainText('volvió en')
    await expect(row(page, CHANNEL)).toContainText('✕ Desconectado, reintentando')

    hub.down = false
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 10_000 })
    await expect(lock).toContainText(/\(volvió en \d+ s\)/, { timeout: 10_000 })
    await expect(lock).not.toContainText('aún reconectando')
  })

  test('if on return it takes more than 3 s to reconnect, the verdict warns about it', async ({
    page,
  }) => {
    const hub = await controllableHub(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    await changeVisibility(page, true)
    hub.down = true
    await hub.connections[0]?.close({ code: 1006 })
    await changeVisibility(page, false)

    // "aún reconectando" only appears after the 3 s check: the hub comes back afterward.
    const lock = row(page, LOCK)
    await expect(lock).toContainText('(aún reconectando)', { timeout: 10_000 })
    hub.down = false
    await wsConnected(page)

    // 3 s or more (the text rounds to the second): never "menos de 1 s".
    await expect(lock).toContainText(/\(volvió en (?:[3-9]|\d{2,}) s\)/, { timeout: 10_000 })
    await expect(page.getByText('Al volver tardó más de 3 s en reconectar.')).toBeVisible()
  })

  test('if on return the channel is open but silent, it replaces it without waiting for the watchdog', async ({
    page,
  }) => {
    let silence = false
    const connections: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostics/ws', (ws) => {
      const server = ws.connectToServer()
      connections.push(ws)
      // With `silence` the first connection stops receiving from the hub, but stays open.
      const isFirst = connections.length === 1
      server.onMessage((message) => {
        if (!(isFirst && silence)) ws.send(message)
      })
    })
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    await changeVisibility(page, true)
    silence = true
    await changeVisibility(page, false)
    // The check waits 3 s; the watchdog would have taken 15 s. The reconnection is immediate,
    // so "Sin respuesta" lasts milliseconds: it is checked via the second connection on the hub.
    await expect.poll(() => connections.length, { timeout: 6000 }).toBe(2)
    await wsConnected(page)
    await expect(row(page, LOCK)).toContainText('volvió en', { timeout: 10_000 })
  })

  test('if the hub stops responding without closing the channel, it detects it and reconnects', async ({
    page,
  }) => {
    let silence = true
    const connections: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostics/ws', (ws) => {
      const server = ws.connectToServer()
      connections.push(ws)
      // The first connection is "dead": the hub delivers nothing but the channel stays open.
      if (silence) {
        silence = false
        server.onMessage(() => {})
      }
    })

    await page.goto('/diagnostics')
    await wsConnected(page)
    await expect(row(page, CHANNEL)).toContainText('Sin respuesta, reconectando', {
      timeout: 25_000,
    })
    await wsConnected(page)
    expect(connections).toHaveLength(2)
  })

  test('the device name is kept after reloading', async ({ page }) => {
    await page.goto('/diagnostics')
    const field = page.getByLabel('Nombre de este equipo')
    await expect(field).toHaveValue('')

    await field.fill('Android mesero 1')
    await page.reload()

    await expect(page.getByLabel('Nombre de este equipo')).toHaveValue('Android mesero 1')
  })

  test('"Enviar resultados al hub" sends the report and shows the confirmation', async ({
    page,
  }) => {
    // The submission is handled in the test so nothing is written to the hub's data folder.
    let body: Record<string, unknown> | undefined
    await page.route('**/api/diagnostics', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      body = route.request().postDataJSON()
      return route.fulfill({ json: { saved: true } })
    })

    await page.goto('/diagnostics')
    await expect(row(page, 'Datos locales (IndexedDB)')).toContainText('✓ Funciona')
    await page.getByLabel('Nombre de este equipo').fill('Caja principal')
    await submission(page).click()

    await expect(page.getByRole('status')).toHaveText('✓ Resultados enviados')
    expect(body).toMatchObject({
      name: 'Caja principal',
      indexedDb: true,
      capabilities: expect.objectContaining({ secureContext: true }),
      summary: expect.objectContaining({ loads: 1 }),
    })
    const types = ((body?.events ?? []) as { type: string }[]).map((event) => event.type)
    expect(types).toContain('load')
  })

  test('if the hub rejects the submission (500) it shows the error message', async ({ page }) => {
    await page.route('**/api/diagnostics', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 500, json: { error: 'falló' } })
        : route.fallback(),
    )
    await page.goto('/diagnostics')
    await enterName(page)
    await submission(page).click()

    await expect(page.getByRole('status')).toHaveText(ERROR_MESSAGE)
    await expect(page.getByText('✓ Resultados enviados')).toBeHidden()
  })

  test('if the submission fails on the network it shows the error and allows a successful retry', async ({
    page,
  }) => {
    await page.route('**/api/diagnostics', (route) =>
      route.request().method() === 'POST' ? route.abort('connectionrefused') : route.fallback(),
    )
    await page.goto('/diagnostics')
    await enterName(page)
    await submission(page).click()
    await expect(page.getByRole('status')).toHaveText(ERROR_MESSAGE)
    // The button becomes available again.
    await expect(submission(page)).toBeEnabled()

    await page.unroute('**/api/diagnostics')
    await page.route('**/api/diagnostics', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { saved: true } })
        : route.fallback(),
    )
    await submission(page).click()
    await expect(page.getByRole('status')).toHaveText('✓ Resultados enviados')
  })

  test('without a name it does not send and asks for one', async ({ page }) => {
    let sentList = 0
    await page.route('**/api/diagnostics', (route) => {
      if (route.request().method() === 'POST') sentList += 1
      return route.fallback()
    })
    await page.goto('/diagnostics')
    await submission(page).click()

    await expect(page.getByRole('status')).toHaveText(
      'Escribe un nombre para identificar este equipo.',
    )
    await expect(page.getByLabel('Nombre de este equipo')).toBeFocused()
    expect(sentList).toBe(0)
  })

  test('"Borrar registro" asks for confirmation and then clears the summary', async ({ page }) => {
    await page.route('**/api/diagnostics', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { saved: true } })
        : route.fallback(),
    )
    await page.goto('/diagnostics')
    await enterName(page)
    await submission(page).click()
    await expect(page.getByRole('status')).toHaveText('✓ Resultados enviados')
    const reloads = value(page, 'El navegador recargó la página solo')
    await expect(reloads).toContainText('0 veces en 1 carga')

    // Canceling deletes nothing.
    await page.getByRole('button', { name: 'Borrar registro y empezar de nuevo' }).click()
    await page.getByRole('button', { name: 'Cancelar' }).click()
    await expect(page.getByText('✓ Resultados enviados')).toBeVisible()

    await page.getByRole('button', { name: 'Borrar registro y empezar de nuevo' }).click()
    await page.getByRole('button', { name: 'Borrar', exact: true }).click()
    await expect(page.getByText('✓ Resultados enviados')).toBeHidden()
    await expect(reloads).toContainText('0 veces en 0 cargas')
  })
})

// Uses the real hub, which in tests saves to its own folder (.e2e/data). Runs in a
// single project so it does not depend on the order in which both write.
test('the hub saves the report sent from the screen in diagnostics.jsonl', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'register', 'A single run is enough')

  const name = `e2e-diagnostics-${Date.now()}`
  await page.goto('/diagnostics')
  await expect(row(page, 'Datos locales (IndexedDB)')).toContainText('✓ Funciona')
  await page.getByLabel('Nombre de este equipo').fill(name)
  await submission(page).click()
  await expect(page.getByRole('status')).toHaveText('✓ Resultados enviados')

  const lines = (await readFile(FILE, 'utf8')).split('\n').filter(Boolean)
  const own = lines.map((line) => JSON.parse(line)).find((r) => r.data?.name === name)
  expect(own).toBeDefined()
  expect(own.data.indexedDb).toBe(true)
  expect(new Date(own.receivedAt).getTime()).not.toBeNaN()
  expect(own.data.events.length).toBeGreaterThan(0)
})
