import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test, type WebSocketRoute } from '@playwright/test'
import { DATA_DIR_E2E } from './routes'

const FILE = join(DATA_DIR_E2E, 'diagnostics.jsonl')
const ERROR_MESSAGE = '✕ No llegó al hub. Revisa que el equipo esté en el Wi-Fi del local.'

/**
 * Deja pasar los WebSocket del diagnóstico hasta el hub real, pero guarda cada conexión
 * para poder cortarla desde la prueba (simula Wi-Fi caído o celular que se duerme).
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
 * Hace que Date.now() nunca repita un valor. El registro ordena los eventos por milisegundo;
 * sin esto, dos eventos del mismo milisegundo (p. ej. "oculta" y "ws-cerrado") pueden
 * quedar invertidos y la prueba dependería de la velocidad de la máquina.
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

/** Simula que el celular bloquea o desbloquea la pantalla (visibilitychange). */
async function changeVisibility(page: Page, isHidden: boolean) {
  // Se evalúa como texto porque este proyecto de pruebas no incluye los tipos del DOM.
  await page.evaluate(`(() => {
    const oculta = ${isHidden}
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => oculta })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (oculta ? 'hidden' : 'visible'),
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })()`)
}

/**
 * Hub que se puede "apagar": mientras `caido` sea true rechaza cada conexión nueva. Guarda en
 * `conexiones` solo las que llegaron al hub real, así su longitud cuenta las conexiones del hub.
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
 * Envuelve WebSocket en la página para contar sockets vivos (CONNECTING u OPEN) y el máximo
 * que hubo a la vez. Con `window.__colgar = true` los sockets nuevos quedan en CONNECTING
 * para siempre, como un intento hecho con la pantalla bloqueada. Debe registrarse después de
 * `controllableHub`, para envolver el WebSocket que ya intercepta Playwright.
 */
async function instrumentWs(page: Page) {
  await page.addInitScript(`(() => {
    const Real = window.WebSocket
    window.__ws = []
    window.__maxVivos = 0
    window.__colgar = false
    function colgado() {
      const falso = new EventTarget()
      falso.readyState = 0
      falso.send = () => {}
      falso.close = () => { falso.readyState = 3 }
      return falso
    }
    window.WebSocket = function (url, protocolos) {
      const ws = window.__colgar ? colgado() : new Real(url, protocolos)
      window.__ws.push(ws)
      const vivos = window.__ws.filter((w) => w.readyState <= 1).length
      window.__maxVivos = Math.max(window.__maxVivos, vivos)
      return ws
    }
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  })()`)
}

interface PageSockets {
  live: number
  maxConcurrent: number
  /** readyState de cada socket creado, en orden. */
  statuses: number[]
}

const readSockets = (page: Page) =>
  page.evaluate(`({
    vivos: window.__ws.filter((w) => w.readyState <= 1).length,
    maximoSimultaneos: window.__maxVivos,
    estados: window.__ws.map((w) => w.readyState),
  })`) as Promise<PageSockets>

const hangNewSockets = (page: Page, hang: boolean) =>
  page.evaluate(`window.__colgar = ${hang}`)

const row = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title })
const CHANNEL = 'Canal en tiempo real'
const LOCK = 'Última vez en segundo plano'
const wsConnected = (page: Page) => expect(row(page, CHANNEL)).toContainText('✓ Conectado')
const wsDisconnected = (page: Page) =>
  expect(row(page, CHANNEL)).toContainText('✕ Desconectado, reintentando')
/** Valor (columna derecha) de una fila del diagnóstico. */
const value = (page: Page, title: string) => row(page, title).locator(':scope > span').last()
const enterName = (page: Page, name = 'Equipo de pruebas') =>
  page.getByLabel('Nombre de este equipo').fill(name)

const submission = (page: Page) =>
  page.getByRole('button', { name: /Enviar resultados al hub|Enviando/ })

test.describe('pantalla de diagnóstico', () => {
  test('muestra el canal conectado, el tiempo de respuesta y datos locales funcionando', async ({
    page,
  }) => {
    await page.goto('/diagnostics')

    await expect(page.getByRole('heading', { name: 'Diagnóstico del dispositivo' })).toBeVisible()
    await wsConnected(page)
    await expect(row(page, 'Datos locales (IndexedDB)')).toContainText('✓ Funciona')
    await expect(row(page, 'Tiempo de respuesta')).toContainText('Midiendo')
    // El primer ping sale a los 5 s de abrir el socket.
    await expect(row(page, 'Tiempo de respuesta')).toContainText(/\d+ ms/, { timeout: 15_000 })
    await expect(row(page, 'Tiempo de respuesta')).not.toContainText('Midiendo')
  })

  test('el inicio enlaza a /diagnostico', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Diagnóstico del equipo' }).click()
    await expect(page).toHaveURL(/\/diagnostico$/)
    await expect(page.getByRole('heading', { name: 'Diagnóstico del dispositivo' })).toBeVisible()
  })

  test('si el canal se corta muestra "Desconectado" y se reconecta solo', async ({ page }) => {
    const connections = await interceptWs(page)
    await page.goto('/diagnostics')
    await wsConnected(page)
    expect(connections).toHaveLength(1)

    await connections[0]?.close({ code: 1006 })
    await wsDisconnected(page)

    // El primer reintento sale al segundo.
    await wsConnected(page)
    expect(connections).toHaveLength(2)
    // La reconexión se refleja en el contador del resumen (se refresca cada 3 s).
    await expect(value(page, 'Veces que se reconectó')).toHaveText('1', { timeout: 10_000 })
  })

  test('sigue reintentando mientras el hub rechaza la conexión y se recupera al volver', async ({
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
    // Aguanta varios intentos fallidos seguidos sin perder el aviso.
    await wsDisconnected(page)

    hubDown = false
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 10_000 })
  })

  test('al ocultar y mostrar la página actualiza el resumen del último bloqueo', async ({
    page,
  }) => {
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)
    const lock = row(page, LOCK)
    await expect(lock).toContainText('Aún no ha pasado')

    await changeVisibility(page, true)
    await changeVisibility(page, false)

    // Al volver espera hasta 3 s una respuesta del hub antes de dar la conexión por viva.
    await expect(lock).toContainText('sin cortes', { timeout: 10_000 })
    await expect(lock).not.toContainText('Aún no ha pasado')
    // Con todo medido y sin cortes, el veredicto queda en verde.
    await expect(page.getByText('Listo para operar')).toBeVisible({ timeout: 15_000 })
  })

  test('si la conexión se pierde mientras la pantalla está bloqueada lo indica', async ({
    page,
  }) => {
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

  test('si un intento de conexión queda colgado, lo abandona y vuelve a intentar', async ({
    page,
  }) => {
    // El primer WebSocket nunca abre ni falla, como pasó en Android con la pantalla bloqueada.
    await page.addInitScript(`(() => {
      const Real = window.WebSocket
      let creados = 0
      function Colgado() {
        const falso = new EventTarget()
        falso.readyState = 0
        falso.send = () => {}
        falso.close = () => { falso.readyState = 3 }
        return falso
      }
      window.WebSocket = function (url, protocolos) {
        creados += 1
        return creados === 1 ? Colgado() : new Real(url, protocolos)
      }
      Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
    })()`)

    await page.goto('/diagnostics')
    await expect(row(page, CHANNEL)).toContainText('Conectando')
    // Se abandona a los 4 s y el siguiente intento sale al segundo.
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 10_000 })
  })

  test('al volver sin conexión reconecta de inmediato, sin esperar el reintento', async ({
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

    // Con la pantalla bloqueada se corta y los reintentos fallan: la espera entre ellos crece.
    await changeVisibility(page, true)
    hubDown = true
    await connections[0]?.close({ code: 1006 })
    await page.waitForTimeout(7000)

    // El hub vuelve justo cuando el usuario desbloquea: debe reconectar en menos de 1,5 s,
    // aunque el reintento programado estuviera a varios segundos.
    hubDown = false
    await changeVisibility(page, false)
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 1500 })
    await expect(row(page, LOCK)).toContainText('volvió en', { timeout: 10_000 })
  })

  test('al volver sin conexión no quedan dos sockets abiertos a la vez', async ({ page }) => {
    const hub = await controllableHub(page)
    await instrumentWs(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    // Se corta con la pantalla bloqueada y los reintentos fallan: queda un reintento programado.
    await changeVisibility(page, true)
    hub.down = true
    await hub.connections[0]?.close({ code: 1006 })
    await wsDisconnected(page)

    hub.down = false
    await changeVisibility(page, false)
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 3000 })

    // El reintento viejo habría saltado como mucho a los 5 s (espera máxima entre intentos): si
    // no se canceló al volver, abriría un segundo socket. Es una ventana de tiempo real a propósito.
    await page.waitForTimeout(6000)
    await wsConnected(page)
    const sockets = await readSockets(page)
    expect(sockets.live).toBe(1)
    expect(sockets.maxConcurrent).toBe(1)
  })

  test('si al volver un intento sigue en CONNECTING, lo descarta y reconecta sin esperar', async ({
    page,
  }) => {
    const hub = await controllableHub(page)
    await instrumentWs(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    // Pantalla bloqueada: se corta y el reintento (al segundo) queda colgado en CONNECTING.
    await changeVisibility(page, true)
    await hangNewSockets(page, true)
    await hub.connections[0]?.close({ code: 1006 })
    await expect.poll(async () => (await readSockets(page)).statuses).toEqual([3, 0])

    // El hub está bien: el usuario vuelve cuando el intento lleva poco tiempo colgado.
    await hangNewSockets(page, false)
    await changeVisibility(page, false)

    // Debe reconectar antes de que el límite de 4 s abandone el intento por su cuenta.
    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 3000 })
    const sockets = await readSockets(page)
    expect(sockets.statuses).toEqual([3, 3, 1])
    expect(sockets.live).toBe(1)
    expect(hub.connections).toHaveLength(2)
    await expect(row(page, LOCK)).toContainText('volvió en', { timeout: 10_000 })
  })

  test('una conexión sana reabierta al volver no se descarta por no haber recibido mensajes aún', async ({
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

    // La fila solo cambia tras la comprobación de 3 s al volver, que es cuando podría descartarla.
    await expect(row(page, LOCK)).toContainText('volvió en', { timeout: 10_000 })
    await wsConnected(page)
    // El hub no manda nada nada más abrir (el primer latido sale a los 5 s): eso no es "mudo".
    expect(hub.connections).toHaveLength(2)
    await expect(value(page, 'Veces que se reconectó')).toHaveText('1', { timeout: 10_000 })
  })

  test('ocultar y volver varias veces seguidas sin conexión no duplica sockets y termina conectado', async ({
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
    // Tres vueltas rápidas con el hub todavía caído, y la última con el hub ya disponible.
    await changeVisibility(page, false)
    await changeVisibility(page, true)
    await changeVisibility(page, false)
    await changeVisibility(page, true)
    hub.down = false
    await changeVisibility(page, false)

    await expect(row(page, CHANNEL)).toContainText('✓ Conectado', { timeout: 5000 })
    // Un intento por vuelta como mucho, y los reintentos programados no deben sumar otro socket.
    await page.waitForTimeout(6000)
    await wsConnected(page)
    const sockets = await readSockets(page)
    expect(sockets.live).toBe(1)
    expect(sockets.maxConcurrent).toBe(1)

    const lock = row(page, LOCK)
    await expect(lock).toContainText('se perdió la conexión', { timeout: 10_000 })
    await expect(lock).toContainText('volvió en')
    await expect(lock).not.toContainText('aún reconectando')
    // Recuperó al instante: no debe salir el aviso de más de 3 s.
    await expect(page.getByText('En segundo plano se pierde la conexión')).toBeVisible()
    await expect(page.getByText('tardó más de 3 s en reconectar')).toBeHidden()
  })

  test('"aún reconectando" se muestra mientras el hub sigue caído y pasa a "volvió en" al volver', async ({
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

    // La comprobación al volver dura 3 s y el resumen se refresca cada 3 s.
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

  test('si al volver tarda más de 3 s en reconectar, el veredicto lo avisa', async ({ page }) => {
    const hub = await controllableHub(page)
    await clockWithoutTies(page)
    await page.goto('/diagnostics')
    await wsConnected(page)

    await changeVisibility(page, true)
    hub.down = true
    await hub.connections[0]?.close({ code: 1006 })
    await changeVisibility(page, false)

    // "aún reconectando" solo aparece pasados los 3 s de la comprobación: el hub vuelve después.
    const lock = row(page, LOCK)
    await expect(lock).toContainText('(aún reconectando)', { timeout: 10_000 })
    hub.down = false
    await wsConnected(page)

    // 3 s o más (el texto redondea al segundo): nunca "menos de 1 s".
    await expect(lock).toContainText(/\(volvió en (?:[3-9]|\d{2,}) s\)/, { timeout: 10_000 })
    await expect(page.getByText('Al volver tardó más de 3 s en reconectar.')).toBeVisible()
  })

  test('si al volver el canal está abierto pero mudo, lo reemplaza sin esperar al vigilante', async ({
    page,
  }) => {
    let silence = false
    const connections: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostics/ws', (ws) => {
      const server = ws.connectToServer()
      connections.push(ws)
      // Con `silenciar` la primera conexión deja de recibir del hub, pero sigue abierta.
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
    // La comprobación espera 3 s; el vigilante habría tardado 15 s. La reconexión es inmediata,
    // así que "Sin respuesta" dura milisegundos: se comprueba por la segunda conexión en el hub.
    await expect.poll(() => connections.length, { timeout: 6000 }).toBe(2)
    await wsConnected(page)
    await expect(row(page, LOCK)).toContainText('volvió en', { timeout: 10_000 })
  })

  test('si el hub deja de responder sin cerrar el canal, lo detecta y reconecta', async ({
    page,
  }) => {
    let silence = true
    const connections: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostics/ws', (ws) => {
      const server = ws.connectToServer()
      connections.push(ws)
      // La primera conexión queda "muerta": el hub no entrega nada pero el canal sigue abierto.
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

  test('el nombre del equipo se conserva al recargar', async ({ page }) => {
    await page.goto('/diagnostics')
    const field = page.getByLabel('Nombre de este equipo')
    await expect(field).toHaveValue('')

    await field.fill('Android mesero 1')
    await page.reload()

    await expect(page.getByLabel('Nombre de este equipo')).toHaveValue('Android mesero 1')
  })

  test('"Enviar resultados al hub" manda el informe y muestra la confirmación', async ({
    page,
  }) => {
    // El envío se atiende en la prueba para no escribir en la carpeta de datos del hub.
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

  test('si el hub rechaza el envío (500) muestra el mensaje de error', async ({ page }) => {
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

  test('si el envío falla por red muestra el error y permite reintentar con éxito', async ({
    page,
  }) => {
    await page.route('**/api/diagnostics', (route) =>
      route.request().method() === 'POST' ? route.abort('connectionrefused') : route.fallback(),
    )
    await page.goto('/diagnostics')
    await enterName(page)
    await submission(page).click()
    await expect(page.getByRole('status')).toHaveText(ERROR_MESSAGE)
    // El botón vuelve a quedar disponible.
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

  test('sin nombre no envía y pide escribirlo', async ({ page }) => {
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

  test('"Borrar registro" pide confirmación y luego limpia el resumen', async ({ page }) => {
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

    // Cancelar no borra nada.
    await page.getByRole('button', { name: 'Borrar registro y empezar de nuevo' }).click()
    await page.getByRole('button', { name: 'Cancelar' }).click()
    await expect(page.getByText('✓ Resultados enviados')).toBeVisible()

    await page.getByRole('button', { name: 'Borrar registro y empezar de nuevo' }).click()
    await page.getByRole('button', { name: 'Borrar', exact: true }).click()
    await expect(page.getByText('✓ Resultados enviados')).toBeHidden()
    await expect(reloads).toContainText('0 veces en 0 cargas')
  })
})

// Usa el hub real, que en las pruebas guarda en su propia carpeta (.e2e/datos). Corre en un
// solo proyecto para no depender del orden con que escriben los dos.
test('el hub guarda el informe enviado desde la pantalla en diagnosticos.jsonl', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'register', 'Una sola ejecución basta')

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
