import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test, type WebSocketRoute } from '@playwright/test'

const ARCHIVO = fileURLToPath(new URL('../../apps/hub/datos/diagnosticos.jsonl', import.meta.url))
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

// Esta prueba usa el hub real y deja constancia en apps/hub/datos. Corre en un solo
// proyecto para que nadie más escriba en el archivo mientras se limpia su línea.
test('el hub guarda el informe enviado desde la pantalla en diagnosticos.jsonl', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'caja', 'Una sola ejecución para no competir por el archivo')

  const nombre = `e2e-diagnostico-${Date.now()}`
  let existia = true
  let original = ''
  try {
    original = await readFile(ARCHIVO, 'utf8')
  } catch {
    existia = false
  }

  try {
    await page.goto('/diagnostico')
    await expect(fila(page, 'Datos locales (IndexedDB)')).toContainText('✓ Funciona')
    await page.getByLabel('Nombre de este equipo').fill(nombre)
    await envio(page).click()
    await expect(page.getByRole('status')).toHaveText('✓ Resultados enviados')

    const lineas = (await readFile(ARCHIVO, 'utf8')).split('\n').filter(Boolean)
    const registros = lineas.map((linea) => JSON.parse(linea))
    const mio = registros.find((registro) => registro.datos?.nombre === nombre)
    expect(mio).toBeDefined()
    expect(mio.datos.indexedDb).toBe(true)
    expect(new Date(mio.recibidoEn).getTime()).not.toBeNaN()
    expect(mio.datos.eventos.length).toBeGreaterThan(0)
  } finally {
    // Devuelve el archivo a como estaba antes de la prueba.
    if (existia) {
      await mkdir(dirname(ARCHIVO), { recursive: true })
      await writeFile(ARCHIVO, original)
    } else {
      await rm(ARCHIVO, { force: true })
    }
  }
})
