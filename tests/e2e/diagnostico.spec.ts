import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test, type WebSocketRoute } from '@playwright/test'
import { DIR_DATOS_E2E } from './rutas'

const ARCHIVO = join(DIR_DATOS_E2E, 'diagnosticos.jsonl')
const MENSAJE_ERROR = '✕ No llegó al hub. Revisa que el equipo esté en el Wi-Fi del local.'

/**
 * Deja pasar los WebSocket del diagnóstico hasta el hub real, pero guarda cada conexión
 * para poder cortarla desde la prueba (simula Wi-Fi caído o celular que se duerme).
 */
async function interceptarWs(page: Page) {
  const conexiones: WebSocketRoute[] = []
  await page.routeWebSocket('**/api/diagnostico/ws', (ws) => {
    ws.connectToServer()
    conexiones.push(ws)
  })
  return conexiones
}

/**
 * Hace que Date.now() nunca repita un valor. El registro ordena los eventos por milisegundo;
 * sin esto, dos eventos del mismo milisegundo (p. ej. "oculta" y "ws-cerrado") pueden
 * quedar invertidos y la prueba dependería de la velocidad de la máquina.
 */
async function relojSinEmpates(page: Page) {
  await page.addInitScript(() => {
    const real = Date.now.bind(Date)
    let ultimo = 0
    Date.now = () => {
      ultimo = Math.max(real(), ultimo + 1)
      return ultimo
    }
  })
}

/** Simula que el celular bloquea o desbloquea la pantalla (visibilitychange). */
async function cambiarVisibilidad(page: Page, oculta: boolean) {
  // Se evalúa como texto porque este proyecto de pruebas no incluye los tipos del DOM.
  await page.evaluate(`(() => {
    const oculta = ${oculta}
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
async function hubControlable(page: Page) {
  const hub = { caido: false, conexiones: [] as WebSocketRoute[] }
  await page.routeWebSocket('**/api/diagnostico/ws', (ws) => {
    if (hub.caido) {
      ws.close({ code: 1011 })
      return
    }
    ws.connectToServer()
    hub.conexiones.push(ws)
  })
  return hub
}

/**
 * Envuelve WebSocket en la página para contar sockets vivos (CONNECTING u OPEN) y el máximo
 * que hubo a la vez. Con `window.__colgar = true` los sockets nuevos quedan en CONNECTING
 * para siempre, como un intento hecho con la pantalla bloqueada. Debe registrarse después de
 * `hubControlable`, para envolver el WebSocket que ya intercepta Playwright.
 */
async function instrumentarWs(page: Page) {
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

interface SocketsEnPagina {
  vivos: number
  maximoSimultaneos: number
  /** readyState de cada socket creado, en orden. */
  estados: number[]
}

const leerSockets = (page: Page) =>
  page.evaluate(`({
    vivos: window.__ws.filter((w) => w.readyState <= 1).length,
    maximoSimultaneos: window.__maxVivos,
    estados: window.__ws.map((w) => w.readyState),
  })`) as Promise<SocketsEnPagina>

const colgarSocketsNuevos = (page: Page, colgar: boolean) =>
  page.evaluate(`window.__colgar = ${colgar}`)

const fila = (page: Page, titulo: string) => page.getByRole('listitem').filter({ hasText: titulo })
const CANAL = 'Canal en tiempo real'
const BLOQUEO = 'Última vez en segundo plano'
const wsConectado = (page: Page) => expect(fila(page, CANAL)).toContainText('✓ Conectado')
const wsDesconectado = (page: Page) =>
  expect(fila(page, CANAL)).toContainText('✕ Desconectado, reintentando')
/** Valor (columna derecha) de una fila del diagnóstico. */
const valor = (page: Page, titulo: string) => fila(page, titulo).locator(':scope > span').last()
const ponerNombre = (page: Page, nombre = 'Equipo de pruebas') =>
  page.getByLabel('Nombre de este equipo').fill(nombre)

const envio = (page: Page) =>
  page.getByRole('button', { name: /Enviar resultados al hub|Enviando/ })

test.describe('pantalla de diagnóstico', () => {
  test('muestra el canal conectado, el tiempo de respuesta y datos locales funcionando', async ({
    page,
  }) => {
    await page.goto('/diagnostico')

    await expect(page.getByRole('heading', { name: 'Diagnóstico del dispositivo' })).toBeVisible()
    await wsConectado(page)
    await expect(fila(page, 'Datos locales (IndexedDB)')).toContainText('✓ Funciona')
    await expect(fila(page, 'Tiempo de respuesta')).toContainText('Midiendo')
    // El primer ping sale a los 5 s de abrir el socket.
    await expect(fila(page, 'Tiempo de respuesta')).toContainText(/\d+ ms/, { timeout: 15_000 })
    await expect(fila(page, 'Tiempo de respuesta')).not.toContainText('Midiendo')
  })

  test('el inicio enlaza a /diagnostico', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Diagnóstico del dispositivo' }).click()
    await expect(page).toHaveURL(/\/diagnostico$/)
    await expect(page.getByRole('heading', { name: 'Diagnóstico del dispositivo' })).toBeVisible()
  })

  test('si el canal se corta muestra "Desconectado" y se reconecta solo', async ({ page }) => {
    const conexiones = await interceptarWs(page)
    await page.goto('/diagnostico')
    await wsConectado(page)
    expect(conexiones).toHaveLength(1)

    await conexiones[0]?.close({ code: 1006 })
    await wsDesconectado(page)

    // El primer reintento sale al segundo.
    await wsConectado(page)
    expect(conexiones).toHaveLength(2)
    // La reconexión se refleja en el contador del resumen (se refresca cada 3 s).
    await expect(valor(page, 'Veces que se reconectó')).toHaveText('1', { timeout: 10_000 })
  })

  test('sigue reintentando mientras el hub rechaza la conexión y se recupera al volver', async ({
    page,
  }) => {
    let hubCaido = false
    const conexiones: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostico/ws', (ws) => {
      if (hubCaido) {
        ws.close({ code: 1011 })
        return
      }
      ws.connectToServer()
      conexiones.push(ws)
    })

    await page.goto('/diagnostico')
    await wsConectado(page)

    hubCaido = true
    await conexiones[0]?.close()
    await wsDesconectado(page)
    // Aguanta varios intentos fallidos seguidos sin perder el aviso.
    await wsDesconectado(page)

    hubCaido = false
    await expect(fila(page, CANAL)).toContainText('✓ Conectado', { timeout: 10_000 })
  })

  test('al ocultar y mostrar la página actualiza el resumen del último bloqueo', async ({
    page,
  }) => {
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)
    const bloqueo = fila(page, BLOQUEO)
    await expect(bloqueo).toContainText('Aún no ha pasado')

    await cambiarVisibilidad(page, true)
    await cambiarVisibilidad(page, false)

    // Al volver espera hasta 3 s una respuesta del hub antes de dar la conexión por viva.
    await expect(bloqueo).toContainText('sin cortes', { timeout: 10_000 })
    await expect(bloqueo).not.toContainText('Aún no ha pasado')
    // Con todo medido y sin cortes, el veredicto queda en verde.
    await expect(page.getByText('Listo para operar')).toBeVisible({ timeout: 15_000 })
  })

  test('si la conexión se pierde mientras la pantalla está bloqueada lo indica', async ({
    page,
  }) => {
    const conexiones = await interceptarWs(page)
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)

    await cambiarVisibilidad(page, true)
    await conexiones[0]?.close({ code: 1006 })
    await wsDesconectado(page)
    await cambiarVisibilidad(page, false)

    const bloqueo = fila(page, BLOQUEO)
    await expect(bloqueo).toContainText('se perdió la conexión', { timeout: 10_000 })
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

    await page.goto('/diagnostico')
    await expect(fila(page, CANAL)).toContainText('Conectando')
    // Se abandona a los 4 s y el siguiente intento sale al segundo.
    await expect(fila(page, CANAL)).toContainText('✓ Conectado', { timeout: 10_000 })
  })

  test('al volver sin conexión reconecta de inmediato, sin esperar el reintento', async ({
    page,
  }) => {
    let hubCaido = false
    const conexiones: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostico/ws', (ws) => {
      if (hubCaido) {
        ws.close({ code: 1011 })
        return
      }
      ws.connectToServer()
      conexiones.push(ws)
    })
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)

    // Con la pantalla bloqueada se corta y los reintentos fallan: la espera entre ellos crece.
    await cambiarVisibilidad(page, true)
    hubCaido = true
    await conexiones[0]?.close({ code: 1006 })
    await page.waitForTimeout(7000)

    // El hub vuelve justo cuando el usuario desbloquea: debe reconectar en menos de 1,5 s,
    // aunque el reintento programado estuviera a varios segundos.
    hubCaido = false
    await cambiarVisibilidad(page, false)
    await expect(fila(page, CANAL)).toContainText('✓ Conectado', { timeout: 1500 })
    await expect(fila(page, BLOQUEO)).toContainText('volvió en', { timeout: 10_000 })
  })

  test('al volver sin conexión no quedan dos sockets abiertos a la vez', async ({ page }) => {
    const hub = await hubControlable(page)
    await instrumentarWs(page)
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)

    // Se corta con la pantalla bloqueada y los reintentos fallan: queda un reintento programado.
    await cambiarVisibilidad(page, true)
    hub.caido = true
    await hub.conexiones[0]?.close({ code: 1006 })
    await wsDesconectado(page)

    hub.caido = false
    await cambiarVisibilidad(page, false)
    await expect(fila(page, CANAL)).toContainText('✓ Conectado', { timeout: 3000 })

    // El reintento viejo habría saltado como mucho a los 5 s (espera máxima entre intentos): si
    // no se canceló al volver, abriría un segundo socket. Es una ventana de tiempo real a propósito.
    await page.waitForTimeout(6000)
    await wsConectado(page)
    const sockets = await leerSockets(page)
    expect(sockets.vivos).toBe(1)
    expect(sockets.maximoSimultaneos).toBe(1)
  })

  test('si al volver un intento sigue en CONNECTING, lo descarta y reconecta sin esperar', async ({
    page,
  }) => {
    const hub = await hubControlable(page)
    await instrumentarWs(page)
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)

    // Pantalla bloqueada: se corta y el reintento (al segundo) queda colgado en CONNECTING.
    await cambiarVisibilidad(page, true)
    await colgarSocketsNuevos(page, true)
    await hub.conexiones[0]?.close({ code: 1006 })
    await expect.poll(async () => (await leerSockets(page)).estados).toEqual([3, 0])

    // El hub está bien: el usuario vuelve cuando el intento lleva poco tiempo colgado.
    await colgarSocketsNuevos(page, false)
    await cambiarVisibilidad(page, false)

    // Debe reconectar antes de que el límite de 4 s abandone el intento por su cuenta.
    await expect(fila(page, CANAL)).toContainText('✓ Conectado', { timeout: 3000 })
    const sockets = await leerSockets(page)
    expect(sockets.estados).toEqual([3, 3, 1])
    expect(sockets.vivos).toBe(1)
    expect(hub.conexiones).toHaveLength(2)
    await expect(fila(page, BLOQUEO)).toContainText('volvió en', { timeout: 10_000 })
  })

  test('una conexión sana reabierta al volver no se descarta por no haber recibido mensajes aún', async ({
    page,
  }) => {
    const hub = await hubControlable(page)
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)

    await cambiarVisibilidad(page, true)
    hub.caido = true
    await hub.conexiones[0]?.close({ code: 1006 })
    await wsDesconectado(page)
    hub.caido = false
    await cambiarVisibilidad(page, false)
    await expect(fila(page, CANAL)).toContainText('✓ Conectado', { timeout: 3000 })

    // La fila solo cambia tras la comprobación de 3 s al volver, que es cuando podría descartarla.
    await expect(fila(page, BLOQUEO)).toContainText('volvió en', { timeout: 10_000 })
    await wsConectado(page)
    // El hub no manda nada nada más abrir (el primer latido sale a los 5 s): eso no es "mudo".
    expect(hub.conexiones).toHaveLength(2)
    await expect(valor(page, 'Veces que se reconectó')).toHaveText('1', { timeout: 10_000 })
  })

  test('ocultar y volver varias veces seguidas sin conexión no duplica sockets y termina conectado', async ({
    page,
  }) => {
    const hub = await hubControlable(page)
    await instrumentarWs(page)
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)

    await cambiarVisibilidad(page, true)
    hub.caido = true
    await hub.conexiones[0]?.close({ code: 1006 })
    // Tres vueltas rápidas con el hub todavía caído, y la última con el hub ya disponible.
    await cambiarVisibilidad(page, false)
    await cambiarVisibilidad(page, true)
    await cambiarVisibilidad(page, false)
    await cambiarVisibilidad(page, true)
    hub.caido = false
    await cambiarVisibilidad(page, false)

    await expect(fila(page, CANAL)).toContainText('✓ Conectado', { timeout: 5000 })
    // Un intento por vuelta como mucho, y los reintentos programados no deben sumar otro socket.
    await page.waitForTimeout(6000)
    await wsConectado(page)
    const sockets = await leerSockets(page)
    expect(sockets.vivos).toBe(1)
    expect(sockets.maximoSimultaneos).toBe(1)

    const bloqueo = fila(page, BLOQUEO)
    await expect(bloqueo).toContainText('se perdió la conexión', { timeout: 10_000 })
    await expect(bloqueo).toContainText('volvió en')
    await expect(bloqueo).not.toContainText('aún reconectando')
    // Recuperó al instante: no debe salir el aviso de más de 3 s.
    await expect(page.getByText('En segundo plano se pierde la conexión')).toBeVisible()
    await expect(page.getByText('tardó más de 3 s en reconectar')).toBeHidden()
  })

  test('"aún reconectando" se muestra mientras el hub sigue caído y pasa a "volvió en" al volver', async ({
    page,
  }) => {
    const hub = await hubControlable(page)
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)

    await cambiarVisibilidad(page, true)
    hub.caido = true
    await hub.conexiones[0]?.close({ code: 1006 })
    await cambiarVisibilidad(page, false)

    // La comprobación al volver dura 3 s y el resumen se refresca cada 3 s.
    const bloqueo = fila(page, BLOQUEO)
    await expect(bloqueo).toContainText('se perdió la conexión', { timeout: 10_000 })
    await expect(bloqueo).toContainText('(aún reconectando)')
    await expect(bloqueo).not.toContainText('volvió en')
    await expect(fila(page, CANAL)).toContainText('✕ Desconectado, reintentando')

    hub.caido = false
    await expect(fila(page, CANAL)).toContainText('✓ Conectado', { timeout: 10_000 })
    await expect(bloqueo).toContainText(/\(volvió en \d+ s\)/, { timeout: 10_000 })
    await expect(bloqueo).not.toContainText('aún reconectando')
  })

  test('si al volver tarda más de 3 s en reconectar, el veredicto lo avisa', async ({ page }) => {
    const hub = await hubControlable(page)
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)

    await cambiarVisibilidad(page, true)
    hub.caido = true
    await hub.conexiones[0]?.close({ code: 1006 })
    await cambiarVisibilidad(page, false)

    // "aún reconectando" solo aparece pasados los 3 s de la comprobación: el hub vuelve después.
    const bloqueo = fila(page, BLOQUEO)
    await expect(bloqueo).toContainText('(aún reconectando)', { timeout: 10_000 })
    hub.caido = false
    await wsConectado(page)

    // 3 s o más (el texto redondea al segundo): nunca "menos de 1 s".
    await expect(bloqueo).toContainText(/\(volvió en (?:[3-9]|\d{2,}) s\)/, { timeout: 10_000 })
    await expect(page.getByText('Al volver tardó más de 3 s en reconectar.')).toBeVisible()
  })

  test('si al volver el canal está abierto pero mudo, lo reemplaza sin esperar al vigilante', async ({
    page,
  }) => {
    let silenciar = false
    const conexiones: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostico/ws', (ws) => {
      const servidor = ws.connectToServer()
      conexiones.push(ws)
      // Con `silenciar` la primera conexión deja de recibir del hub, pero sigue abierta.
      const esLaPrimera = conexiones.length === 1
      servidor.onMessage((mensaje) => {
        if (!(esLaPrimera && silenciar)) ws.send(mensaje)
      })
    })
    await relojSinEmpates(page)
    await page.goto('/diagnostico')
    await wsConectado(page)

    await cambiarVisibilidad(page, true)
    silenciar = true
    await cambiarVisibilidad(page, false)
    // La comprobación espera 3 s; el vigilante habría tardado 15 s. La reconexión es inmediata,
    // así que "Sin respuesta" dura milisegundos: se comprueba por la segunda conexión en el hub.
    await expect.poll(() => conexiones.length, { timeout: 6000 }).toBe(2)
    await wsConectado(page)
    await expect(fila(page, BLOQUEO)).toContainText('volvió en', { timeout: 10_000 })
  })

  test('si el hub deja de responder sin cerrar el canal, lo detecta y reconecta', async ({
    page,
  }) => {
    let silenciar = true
    const conexiones: WebSocketRoute[] = []
    await page.routeWebSocket('**/api/diagnostico/ws', (ws) => {
      const servidor = ws.connectToServer()
      conexiones.push(ws)
      // La primera conexión queda "muerta": el hub no entrega nada pero el canal sigue abierto.
      if (silenciar) {
        silenciar = false
        servidor.onMessage(() => {})
      }
    })

    await page.goto('/diagnostico')
    await wsConectado(page)
    await expect(fila(page, CANAL)).toContainText('Sin respuesta, reconectando', {
      timeout: 25_000,
    })
    await wsConectado(page)
    expect(conexiones).toHaveLength(2)
  })

  test('el nombre del equipo se conserva al recargar', async ({ page }) => {
    await page.goto('/diagnostico')
    const campo = page.getByLabel('Nombre de este equipo')
    await expect(campo).toHaveValue('')

    await campo.fill('Android mesero 1')
    await page.reload()

    await expect(page.getByLabel('Nombre de este equipo')).toHaveValue('Android mesero 1')
  })

  test('"Enviar resultados al hub" manda el informe y muestra la confirmación', async ({
    page,
  }) => {
    // El envío se atiende en la prueba para no escribir en la carpeta de datos del hub.
    let cuerpo: Record<string, unknown> | undefined
    await page.route('**/api/diagnostico', async (ruta) => {
      if (ruta.request().method() !== 'POST') return ruta.fallback()
      cuerpo = ruta.request().postDataJSON()
      return ruta.fulfill({ json: { guardado: true } })
    })

    await page.goto('/diagnostico')
    await expect(fila(page, 'Datos locales (IndexedDB)')).toContainText('✓ Funciona')
    await page.getByLabel('Nombre de este equipo').fill('Caja principal')
    await envio(page).click()

    await expect(page.getByRole('status')).toHaveText('✓ Resultados enviados')
    expect(cuerpo).toMatchObject({
      nombre: 'Caja principal',
      indexedDb: true,
      capacidades: expect.objectContaining({ contextoSeguro: true }),
      resumen: expect.objectContaining({ cargas: 1 }),
    })
    const tipos = ((cuerpo?.eventos ?? []) as { tipo: string }[]).map((evento) => evento.tipo)
    expect(tipos).toContain('carga')
  })

  test('si el hub rechaza el envío (500) muestra el mensaje de error', async ({ page }) => {
    await page.route('**/api/diagnostico', (ruta) =>
      ruta.request().method() === 'POST'
        ? ruta.fulfill({ status: 500, json: { error: 'falló' } })
        : ruta.fallback(),
    )
    await page.goto('/diagnostico')
    await ponerNombre(page)
    await envio(page).click()

    await expect(page.getByRole('status')).toHaveText(MENSAJE_ERROR)
    await expect(page.getByText('✓ Resultados enviados')).toBeHidden()
  })

  test('si el envío falla por red muestra el error y permite reintentar con éxito', async ({
    page,
  }) => {
    await page.route('**/api/diagnostico', (ruta) =>
      ruta.request().method() === 'POST' ? ruta.abort('connectionrefused') : ruta.fallback(),
    )
    await page.goto('/diagnostico')
    await ponerNombre(page)
    await envio(page).click()
    await expect(page.getByRole('status')).toHaveText(MENSAJE_ERROR)
    // El botón vuelve a quedar disponible.
    await expect(envio(page)).toBeEnabled()

    await page.unroute('**/api/diagnostico')
    await page.route('**/api/diagnostico', (ruta) =>
      ruta.request().method() === 'POST'
        ? ruta.fulfill({ json: { guardado: true } })
        : ruta.fallback(),
    )
    await envio(page).click()
    await expect(page.getByRole('status')).toHaveText('✓ Resultados enviados')
  })

  test('sin nombre no envía y pide escribirlo', async ({ page }) => {
    let enviados = 0
    await page.route('**/api/diagnostico', (ruta) => {
      if (ruta.request().method() === 'POST') enviados += 1
      return ruta.fallback()
    })
    await page.goto('/diagnostico')
    await envio(page).click()

    await expect(page.getByRole('status')).toHaveText(
      'Escribe un nombre para identificar este equipo.',
    )
    await expect(page.getByLabel('Nombre de este equipo')).toBeFocused()
    expect(enviados).toBe(0)
  })

  test('"Borrar registro" pide confirmación y luego limpia el resumen', async ({ page }) => {
    await page.route('**/api/diagnostico', (ruta) =>
      ruta.request().method() === 'POST'
        ? ruta.fulfill({ json: { guardado: true } })
        : ruta.fallback(),
    )
    await page.goto('/diagnostico')
    await ponerNombre(page)
    await envio(page).click()
    await expect(page.getByRole('status')).toHaveText('✓ Resultados enviados')
    const recargas = valor(page, 'El navegador recargó la página solo')
    await expect(recargas).toContainText('0 veces en 1 carga')

    // Cancelar no borra nada.
    await page.getByRole('button', { name: 'Borrar registro y empezar de nuevo' }).click()
    await page.getByRole('button', { name: 'Cancelar' }).click()
    await expect(page.getByText('✓ Resultados enviados')).toBeVisible()

    await page.getByRole('button', { name: 'Borrar registro y empezar de nuevo' }).click()
    await page.getByRole('button', { name: 'Borrar', exact: true }).click()
    await expect(page.getByText('✓ Resultados enviados')).toBeHidden()
    await expect(recargas).toContainText('0 veces en 0 cargas')
  })
})

// Usa el hub real, que en las pruebas guarda en su propia carpeta (.e2e/datos). Corre en un
// solo proyecto para no depender del orden con que escriben los dos.
test('el hub guarda el informe enviado desde la pantalla en diagnosticos.jsonl', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'caja', 'Una sola ejecución basta')

  const nombre = `e2e-diagnostico-${Date.now()}`
  await page.goto('/diagnostico')
  await expect(fila(page, 'Datos locales (IndexedDB)')).toContainText('✓ Funciona')
  await page.getByLabel('Nombre de este equipo').fill(nombre)
  await envio(page).click()
  await expect(page.getByRole('status')).toHaveText('✓ Resultados enviados')

  const lineas = (await readFile(ARCHIVO, 'utf8')).split('\n').filter(Boolean)
  const mio = lineas.map((linea) => JSON.parse(linea)).find((r) => r.datos?.nombre === nombre)
  expect(mio).toBeDefined()
  expect(mio.datos.indexedDb).toBe(true)
  expect(new Date(mio.recibidoEn).getTime()).not.toBeNaN()
  expect(mio.datos.eventos.length).toBeGreaterThan(0)
})
