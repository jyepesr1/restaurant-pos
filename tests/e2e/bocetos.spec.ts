/// <reference lib="dom" />
import { expect, type Locator, type Page, test } from '@playwright/test'

// Criterios de la tarea 0.9 (design system y bocetos), en celular Android y en caja.
// El estado de los bocetos vive en memoria de la página: cada prueba empieza con los datos de
// ejemplo, y para conservarlo entre pantallas se navega con toques, nunca con `page.goto`.
// Los avisos y los tiempos dependen del reloj: las pruebas que los miran lo congelan.

const esCaja = (proyecto: string) => proyecto === 'caja'

// ---------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------

/**
 * Reloj controlado de la página: parte de una hora fija y se adelanta con `page.clock.runFor`
 * (los avisos y los minutos de las mesas dependen de él). Sigue corriendo en tiempo real, así que
 * las pruebas que lo usan no deben tardar más de 5 s entre pasos que miren un aviso.
 */
async function congelarReloj(page: Page) {
  await page.clock.install({ time: new Date('2026-10-24T12:00:00') })
}

/** Navega dentro de la app sin recargar (conserva el estado en memoria de los bocetos). */
const irA = (page: Page, ruta: string) =>
  page.evaluate((r) => {
    history.pushState(null, '', r)
    window.dispatchEvent(new Event('pos-navegar'))
  }, ruta)

/** Elementos tocables visibles que miden menos de 48×48 px (la casilla cuenta por su etiqueta). */
async function medidasPequenas(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const MINIMO = 48
    const descripcion = (el: Element) =>
      `${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}]`
    const fallas: string[] = []
    const candidatos = document.querySelectorAll(
      'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"]',
    )
    for (const el of candidatos) {
      let medido: Element = el
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
        medido = el.closest('label') ?? el
      const estilo = getComputedStyle(medido)
      if (estilo.display === 'none' || estilo.visibility === 'hidden') continue
      if (el.closest('[hidden], [aria-hidden="true"]')) continue
      const r = medido.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.width < MINIMO - 0.5 || r.height < MINIMO - 0.5)
        fallas.push(`${descripcion(el)} mide ${Math.round(r.width)}×${Math.round(r.height)}`)
    }
    return fallas
  })
}

/**
 * Texto visible con contraste menor que AA (4,5:1; 3:1 si es grande), con el fondo y la opacidad
 * reales que pinta el navegador. Ignora lo deshabilitado (WCAG lo exime).
 */
async function contrasteInsuficiente(page: Page): Promise<string[]> {
  // Las transiciones (p. ej. la opacidad de un botón que pasa de deshabilitado a habilitado) deben
  // terminar: a la mitad de una, los colores medidos no son los finales.
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a instanceof CSSTransition)
        .map((a) => a.finished),
    ),
  )
  return page.evaluate(() => {
    type Rgba = [number, number, number, number]
    const lienzo = document.createElement('canvas')
    lienzo.width = lienzo.height = 1
    const ctx = lienzo.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
    const aRgba = (css: string): Rgba => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255]
    }
    const sobre = (f: Rgba, fondo: Rgba): Rgba => {
      const a = f[3] + fondo[3] * (1 - f[3])
      if (a === 0) return [0, 0, 0, 0]
      const mezcla = (i: 0 | 1 | 2) => (f[i] * f[3] + fondo[i] * fondo[3] * (1 - f[3])) / a
      return [mezcla(0), mezcla(1), mezcla(2), a]
    }
    const lum = (c: Rgba) => {
      const k = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * k(c[0]) + 0.7152 * k(c[1]) + 0.0722 * k(c[2])
    }
    const fondoDe = (el: Element): Rgba => {
      const capas: Rgba[] = []
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = aRgba(getComputedStyle(e).backgroundColor)
        if (c[3] > 0) capas.push(c)
        if (c[3] === 1) break
      }
      let acumulado: Rgba = [255, 255, 255, 1]
      for (const capa of capas.reverse()) acumulado = sobre(capa, acumulado)
      return acumulado
    }
    const fallas: string[] = []
    const vistos = new Set<string>()
    for (const el of document.body.querySelectorAll('*')) {
      if (el instanceof SVGElement) continue
      const propio = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
      )
      if (!propio) continue
      const estilo = getComputedStyle(el)
      if (estilo.display === 'none' || estilo.visibility === 'hidden') continue
      const r = el.getBoundingClientRect()
      if (r.width <= 1 || r.height <= 1) continue // sr-only
      if (el.closest('button:disabled, fieldset:disabled, [aria-disabled="true"]')) continue
      let opacidad = 1
      for (let e: Element | null = el; e; e = e.parentElement)
        opacidad *= Number(getComputedStyle(e).opacity)
      const fondo = fondoDe(el)
      const texto = aRgba(estilo.color)
      texto[3] *= opacidad
      const visto = sobre(texto, fondo)
      const [a, b] = [lum(visto), lum(fondo)].sort((x, y) => y - x) as [number, number]
      const razon = (a + 0.05) / (b + 0.05)
      const px = Number.parseFloat(estilo.fontSize)
      const grande = px >= 24 || (px >= 18.66 && Number(estilo.fontWeight) >= 700)
      if (razon < (grande ? 3 : 4.5)) {
        const nombre = (el.textContent ?? '').trim().slice(0, 30)
        const clave = `${nombre}|${estilo.color}|${estilo.backgroundColor}`
        if (vistos.has(clave)) continue
        vistos.add(clave)
        fallas.push(`«${nombre}» contraste ${razon.toFixed(2)} (${grande ? 'grande' : 'normal'})`)
      }
    }
    return fallas
  })
}

const colorDeFondo = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor)
const colorDeTexto = (page: Page) => page.evaluate(() => getComputedStyle(document.body).color)
const esOscuro = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('oscuro'))

/** Dinero como lo escribe la interfaz: 257500 → $257.500. Independiente del código de producción. */
const enPesos = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`

const numeroDe = (texto: string) => Number(texto.replace(/\D/g, ''))

/** Redondeo a la mitad hacia arriba con enteros exactos (DINERO.md, principio 3). */
function propinaEsperada(saldo: number, tarifaBp = 800, tasaBp = 1000): number {
  const a = BigInt(saldo) * 10000n * BigInt(tasaBp)
  const b = BigInt(10000 + tarifaBp) * 10000n
  return Number((2n * a + b) / (2n * b))
}

/** Reparto por mayor residuo (DINERO.md, principio 4), con el desempate por orden. */
function repartoPorResiduo(total: number, pesos: number[]): number[] {
  const suma = pesos.reduce((a, b) => a + b, 0)
  const base = pesos.map((p) => Math.floor((total * p) / suma))
  const resto = pesos
    .map((p, i) => ({ i, r: (total * p) % suma }))
    .sort((x, y) => y.r - x.r || x.i - y.i)
  let faltan = total - base.reduce((a, b) => a + b, 0)
  for (const { i } of resto) {
    if (faltan <= 0) break
    base[i] = (base[i] as number) + 1
    faltan--
  }
  return base
}

/** Desde el plano: la mesa por su número (el nombre accesible empieza con «Mesa N:»). */
const mesaEnPlano = (page: Page, numero: number) =>
  page.getByRole('button', { name: new RegExp(`^Mesa ${numero}: `) })

const mesaEnLista = (page: Page, numero: number) =>
  page
    .locator('section[aria-label="Mesas"] ul > li')
    .filter({ hasText: new RegExp(`^${numero}(?!\\d)`) })
    .getByRole('button')

const buscarEnCarta = (page: Page) => page.getByRole('searchbox', { name: 'Buscar en la carta' })
/** Una tarjeta de producto de la carta (su nombre accesible también lleva el precio y la cantidad). */
const producto = (page: Page, nombre: string) =>
  page.getByRole('region', { name: 'Carta' }).getByRole('button', { name: nombre }).first()

const enviar = (page: Page, cantidad?: number) =>
  page.getByRole('button', { name: cantidad ? `Enviar ${cantidad}` : 'Enviar', exact: true })

/** El aviso (toast) que contiene el texto, y su botón Deshacer. */
const aviso = (page: Page, texto: string | RegExp) =>
  page.locator('[aria-live="polite"] > div').filter({ hasText: texto })
const deshacer = (page: Page, texto: string | RegExp) =>
  aviso(page, texto).getByRole('button', { name: 'Deshacer' })

/** El ticket del pedido: en la caja es la columna fija; en el celular, el panel «Pedido». */
async function abrirTicket(page: Page, caja: boolean): Promise<Locator> {
  if (caja) return page.locator('aside')
  const panel = page.getByRole('dialog', { name: /^Pedido · Mesa/ })
  if (!(await panel.isVisible())) await page.getByRole('button', { name: /^Pedido \(/ }).click()
  await expect(panel).toBeVisible()
  return panel
}
async function cerrarTicket(page: Page, caja: boolean) {
  if (caja) return
  const panel = page.getByRole('dialog', { name: /^Pedido · Mesa/ })
  if (await panel.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
  }
}
const nombresDelTicket = (ticket: Locator) =>
  ticket
    .locator('ul > li button span.flex-1 > span.font-semibold')
    .evaluateAll((els) => els.map((e) => e.textContent ?? ''))

/** La tarjeta de una comanda del KDS (mesa y estación). */
const comanda = (page: Page, mesa: number, estacion: 'cocina' | 'barra') =>
  page.getByRole('listitem').filter({ hasText: new RegExp(`^Mesa ${mesa}(?!\\d).* · ${estacion}`) })

// ---------------------------------------------------------------------------------------------
// Tamaño táctil de 48×48 px
// ---------------------------------------------------------------------------------------------

const PANTALLAS = [
  { nombre: 'índice', ruta: '/bocetos' },
  { nombre: 'plano', ruta: '/bocetos/plano' },
  { nombre: 'pedido', ruta: '/bocetos/pedido?mesa=2' },
  { nombre: 'KDS', ruta: '/bocetos/kds' },
  { nombre: 'precuenta', ruta: '/bocetos/precuenta?mesa=12' },
  { nombre: 'cobro', ruta: '/bocetos/cobro?mesa=12' },
  { nombre: 'componentes', ruta: '/bocetos/componentes' },
]

test.describe('tamaño táctil de 48×48 px', () => {
  for (const { nombre, ruta } of PANTALLAS) {
    test(`${nombre}: todo botón, enlace y campo mide al menos 48×48`, async ({ page }) => {
      await page.goto(ruta)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await medidasPequenas(page)).toEqual([])
    })
  }

  test('inicio de la app: los enlaces a los bocetos miden al menos 48×48', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Bocetos de las pantallas' })).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
  })

  test('índice con las simulaciones elegidas', async ({ page }) => {
    await page.goto('/bocetos')
    await page.getByRole('button', { name: 'Sin conexión' }).click()
    await page.getByRole('button', { name: 'Impresora de barra caída' }).click()
    expect(await medidasPequenas(page)).toEqual([])
  })

  test('plano en vista de lista y con el aviso Deshacer visible', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await page.getByRole('button', { name: 'Lista' }).click()
    await mesaEnLista(page, 18).click()
    await expect(deshacer(page, 'Mesa 18 lista para usar')).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
  })

  test('pedido con el panel de opciones, el de un ítem y el de anulación abiertos', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=2')
    await buscarEnCarta(page).fill('tagliata')
    await producto(page, 'Tagliata di Manzo').click()
    await expect(page.getByRole('dialog', { name: 'Tagliata di Manzo' })).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
    await page.keyboard.press('Escape')
    const ticket = await abrirTicket(page, caja)
    await ticket.getByRole('button', { name: /Aperol Spritz/ }).click()
    await expect(page.getByRole('dialog', { name: 'Aperol Spritz' })).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
    await page.keyboard.press('Escape')
    await cerrarTicket(page, caja)

    await page.goto('/bocetos/pedido?mesa=7')
    const ticket7 = await abrirTicket(page, caja)
    await ticket7.getByRole('button', { name: /Spritz Burguer/ }).click()
    await expect(page.getByRole('dialog', { name: 'Anular Spritz Burguer' })).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
  })

  test('precuenta dividida en partes iguales y por ítems', async ({ page }) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    await page.getByRole('button', { name: 'Partes iguales' }).click()
    expect(await medidasPequenas(page)).toEqual([])
    await page.getByRole('button', { name: 'Por ítems' }).click()
    await expect(page.getByRole('group', { name: 'Quién paga Quattro Formaggi' })).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
  })

  test('cobro en tarjeta, con la confirmación y con la mesa pagada', async ({ page }) => {
    await page.goto('/bocetos/cobro?mesa=12')
    await page.getByRole('button', { name: /^Tarjeta/ }).click()
    await page.getByLabel('Número de aprobación').fill('123456')
    expect(await medidasPequenas(page)).toEqual([])
    await page.getByRole('button', { name: /^Cobrar/ }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
    await page.getByRole('button', { name: 'Confirmar' }).click()
    await expect(page.getByRole('button', { name: 'Volver al salón' })).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
  })

  test('KDS con una comanda marcada y el aviso de despacho', async ({ page }) => {
    await page.goto('/bocetos/kds')
    const tarjeta = comanda(page, 21, 'cocina')
    await tarjeta.getByRole('button', { name: /Pinsa/ }).click()
    await tarjeta.getByRole('button', { name: 'Todo listo' }).click()
    await expect(deshacer(page, 'Mesa 21 despachada')).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
  })

  test('componentes con el panel lateral abierto', async ({ page }) => {
    await page.goto('/bocetos/componentes')
    await page.getByRole('button', { name: 'Abrir panel lateral' }).click()
    await expect(page.getByRole('dialog', { name: 'Panel lateral' })).toBeVisible()
    expect(await medidasPequenas(page)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Contraste
// ---------------------------------------------------------------------------------------------

test.describe('contraste AA en claro y oscuro', () => {
  for (const esquema of ['light', 'dark'] as const) {
    for (const { nombre, ruta } of PANTALLAS) {
      test(`${nombre} con el sistema en ${esquema === 'dark' ? 'oscuro' : 'claro'}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: esquema })
        await page.goto(ruta)
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        expect(await esOscuro(page)).toBe(esquema === 'dark')
        expect(await contrasteInsuficiente(page)).toEqual([])
      })
    }
  }

  for (const esquema of ['light', 'dark'] as const) {
    test(`estados de color del cobro, la precuenta y el KDS con el sistema en ${esquema}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: esquema })
      await page.goto('/bocetos/cobro?mesa=12')
      await page.getByRole('button', { name: '100 mil' }).click()
      await expect(page.getByText('Faltan $181.300')).toBeVisible()
      expect(await contrasteInsuficiente(page)).toEqual([])
      await page.getByLabel('El cliente entrega').fill('300000')
      await expect(page.getByText('Cambio $18.700')).toBeVisible()
      expect(await contrasteInsuficiente(page)).toEqual([])
      await page.keyboard.press('Enter')
      await expect(page.getByRole('alertdialog')).toBeVisible()
      expect(await contrasteInsuficiente(page)).toEqual([])

      await irA(page, '/bocetos/precuenta?mesa=12')
      await page.getByRole('button', { name: 'Por ítems' }).click()
      expect(await contrasteInsuficiente(page)).toEqual([])
      await page.getByRole('button', { name: 'Partes iguales' }).click()
      expect(await contrasteInsuficiente(page)).toEqual([])

      await irA(page, '/bocetos/kds')
      await comanda(page, 21, 'cocina').getByRole('button', { name: /Pinsa/ }).click()
      expect(await contrasteInsuficiente(page)).toEqual([])
    })
  }

  test('índice con la conexión caída y la impresora con falla, en oscuro', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/bocetos')
    await page.getByRole('button', { name: 'Sin conexión' }).click()
    await page.getByRole('button', { name: 'Impresora de barra caída' }).click()
    await expect(page.getByText('3 por enviar')).toBeVisible()
    expect(await contrasteInsuficiente(page)).toEqual([])
  })

  test('pedido con producto en el pedido, panel y aviso, en claro y oscuro', async ({ page }) => {
    for (const esquema of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: esquema })
      await page.goto('/bocetos/pedido?mesa=2')
      await producto(page, 'Pinsa').click()
      await expect(aviso(page, 'Agregaste Pinsa')).toBeVisible()
      expect(await contrasteInsuficiente(page)).toEqual([])
      await buscarEnCarta(page).fill('tagliata')
      await producto(page, 'Tagliata di Manzo').click()
      await expect(page.getByRole('dialog', { name: 'Tagliata di Manzo' })).toBeVisible()
      expect(await contrasteInsuficiente(page)).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Modo oscuro
// ---------------------------------------------------------------------------------------------

test.describe('modo oscuro', () => {
  test.use({ colorScheme: 'light' })
  const boton = (page: Page) => page.getByRole('button', { name: 'Modo oscuro' })

  test('cambia los colores y se mantiene al recargar', async ({ page }) => {
    await page.goto('/bocetos/componentes')
    expect(await esOscuro(page)).toBe(false)
    await expect(boton(page)).toHaveAttribute('aria-pressed', 'false')
    const fondoClaro = await colorDeFondo(page)
    const textoClaro = await colorDeTexto(page)

    await boton(page).click()
    expect(await esOscuro(page)).toBe(true)
    await expect(boton(page)).toHaveAttribute('aria-pressed', 'true')
    expect(await colorDeFondo(page)).not.toBe(fondoClaro)
    expect(await colorDeTexto(page)).not.toBe(textoClaro)
    const fondoOscuro = await colorDeFondo(page)

    await page.reload()
    expect(await esOscuro(page)).toBe(true)
    expect(await colorDeFondo(page)).toBe(fondoOscuro)
    await expect(boton(page)).toHaveAttribute('aria-pressed', 'true')
  })

  test('el modo oscuro está puesto antes de que la app arranque (sin destello blanco)', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('pos-tema', 'oscuro'))
    // Con la app sin ejecutarse (JavaScript de React bloqueado), el HTML ya trae la clase.
    await page.route('**/*.js', (ruta) => ruta.abort())
    await page.goto('/bocetos', { waitUntil: 'domcontentloaded' })
    expect(await esOscuro(page)).toBe(true)
  })

  test('se mantiene al ir a otra pantalla y al volver a abrir la app', async ({ page }) => {
    await page.goto('/bocetos')
    await boton(page).click()
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(page).toHaveURL(/\/bocetos\/plano$/)
    expect(await esOscuro(page)).toBe(true)
    await page.goto('/')
    expect(await esOscuro(page)).toBe(true)
  })

  test('volver al modo claro también se recuerda', async ({ page }) => {
    await page.goto('/bocetos')
    await boton(page).click()
    await boton(page).click()
    expect(await esOscuro(page)).toBe(false)
    await page.reload()
    expect(await esOscuro(page)).toBe(false)
  })

  test('lo elegido gana sobre el sistema, y sin elegir se sigue al sistema', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/bocetos')
    expect(await esOscuro(page)).toBe(true)
    await expect(boton(page)).toHaveAttribute('aria-pressed', 'true')
    await boton(page).click() // elige claro
    expect(await esOscuro(page)).toBe(false)
    await page.reload()
    expect(await esOscuro(page)).toBe(false)
  })

  test('sin elegir, un cambio del sistema se aplica sin recargar', async ({ page }) => {
    await page.goto('/bocetos')
    expect(await esOscuro(page)).toBe(false)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => esOscuro(page)).toBe(true)
    await expect(boton(page)).toHaveAttribute('aria-pressed', 'true')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => esOscuro(page)).toBe(false)
  })

  test('sin almacenamiento disponible no se rompe y vale en la página abierta', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('bloqueado', 'SecurityError')
        },
      })
    })
    await page.goto('/bocetos')
    await boton(page).click()
    expect(await esOscuro(page)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Marco: título y foco al cambiar de pantalla; conexión simulada
// ---------------------------------------------------------------------------------------------

test.describe('marco de las pantallas', () => {
  test('cada pantalla pone su título en la pestaña y el foco en su encabezado', async ({
    page,
  }) => {
    await page.goto('/bocetos/plano')
    await expect(page).toHaveTitle('Salón · POS')
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
    await mesaEnPlano(page, 3).click()
    await expect(page).toHaveTitle('Mesa 3 · POS')
    await expect(page.getByRole('heading', { level: 1, name: 'Mesa 3' })).toBeFocused()
  })

  test('«Solo red local» es el estado normal: se ve en gris, con texto e ícono', async ({
    page,
  }) => {
    await page.goto('/bocetos/plano')
    const estado = page.getByRole('status')
    await expect(estado).toContainText('Solo red local')
    await expect(estado.locator('span.rounded-full').first()).toHaveClass(/neutro/)
    await expect(estado.locator('svg')).toHaveCount(1)
  })

  test('el índice simula la conexión y la impresora y las demás pantallas lo muestran', async ({
    page,
  }) => {
    await page.goto('/bocetos')
    await page.getByRole('button', { name: 'En línea' }).click()
    await expect(page.getByRole('status')).toContainText('En línea')
    await page.getByRole('button', { name: 'Sin conexión' }).click()
    await expect(page.getByRole('status')).toContainText('Sin conexión')
    await expect(page.getByRole('status')).toContainText('3 por enviar')
    await page.getByRole('button', { name: 'Impresora de barra caída' }).click()
    await expect(page.getByRole('status')).toContainText('Una impresora no responde')

    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(page.getByRole('status')).toContainText('Sin conexión')
    await expect(page.getByRole('status')).toContainText('3 por enviar')
    await expect(page.getByRole('status')).toContainText('Una impresora no responde')

    // Volver a «Solo red local» quita los pendientes; la impresora sigue marcada hasta apagarla.
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('button', { name: 'Solo red local' }).click()
    await expect(page.getByRole('status')).not.toContainText('por enviar')
    await page.getByRole('button', { name: 'Impresora de barra caída' }).click()
    await expect(page.getByRole('status')).not.toContainText('impresora')
  })

  test('«Volver a los datos de ejemplo» reinicia las mesas', async ({ page }) => {
    await page.goto('/bocetos')
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await mesaEnPlano(page, 18).click() // la deja libre
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('button', { name: 'Volver a los datos de ejemplo' }).click()
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(mesaEnPlano(page, 18)).toHaveAccessibleName(/^Mesa 18: Por limpiar/)
  })
})

// ---------------------------------------------------------------------------------------------
// Plano
// ---------------------------------------------------------------------------------------------

test.describe('plano de mesas', () => {
  test('muestra el estado de cada mesa con texto, no solo con color', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await expect(mesaEnPlano(page, 1)).toHaveAccessibleName(/^Mesa 1: Libre$/)
    await expect(mesaEnPlano(page, 2)).toHaveAccessibleName(
      /^Mesa 2: Tomando pedido, 3 min, \$61\.800$/,
    )
    await expect(mesaEnPlano(page, 4)).toHaveAccessibleName(/^Mesa 4: En preparación, 18 min, /)
    await expect(mesaEnPlano(page, 9)).toHaveAccessibleName(/^Mesa 9: Listo para servir, /)
    await expect(mesaEnPlano(page, 12)).toHaveAccessibleName(
      /^Mesa 12: Por cobrar, 1 h 0[45], \$257\.500$/,
    )
    await expect(mesaEnPlano(page, 15)).toHaveAccessibleName(/^Mesa 15: Reservada$/)
    await expect(mesaEnPlano(page, 18)).toHaveAccessibleName(/^Mesa 18: Por limpiar$/)
  })

  test('la demora se cuenta desde la comanda más vieja: 27 min es demora; 6 y 12, no', async ({
    page,
  }) => {
    await page.goto('/bocetos/plano')
    await expect(mesaEnPlano(page, 7)).toHaveAccessibleName(/^Mesa 7: Demora, 3[5-6] min, /)
    await expect(mesaEnPlano(page, 21)).toHaveAccessibleName(/^Mesa 21: En preparación, /)
    await expect(mesaEnPlano(page, 4)).toHaveAccessibleName(/^Mesa 4: En preparación, /)
  })

  test('la libre lleva ícono de círculo y texto, y va en blanco', async ({ page }) => {
    await page.goto('/bocetos/plano')
    const libre = mesaEnPlano(page, 1)
    await expect(libre).toContainText('Libre')
    await expect(libre.locator('svg')).toHaveCount(1)
    await expect(libre).toHaveClass(/bg-superficie/)
  })

  test('el resumen cuenta las mesas por estado', async ({ page }) => {
    await page.goto('/bocetos/plano')
    // 25 mesas: 8 con estado (2, 4, 7, 9, 12, 15, 18, 21) → 17 libres
    await expect(page.getByText('17 libres')).toBeVisible()
    await expect(page.getByText('4 atendiendo')).toBeVisible()
    await expect(page.getByText('1 para servir')).toBeVisible()
    await expect(page.getByText('1 por cobrar')).toBeVisible()
  })

  test('tocar una mesa libre abre el pedido SIN ocuparla: al volver sigue libre', async ({
    page,
  }) => {
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 3).click()
    await expect(page.getByRole('heading', { name: 'Mesa 3', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(mesaEnPlano(page, 3)).toHaveAccessibleName(/^Mesa 3: Libre$/)
    await expect(page.getByText('17 libres')).toBeVisible()
  })

  test('la mesa queda ocupada al agregar el primer producto', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 3).click()
    await producto(page, 'Pinsa').click()
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(mesaEnPlano(page, 3)).toHaveAccessibleName(
      /^Mesa 3: Tomando pedido, 0 min, \$20\.900$/,
    )
  })

  test('tocar una mesa por limpiar la deja como nueva y se puede deshacer', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 18).click()
    await expect(mesaEnPlano(page, 18)).toHaveAccessibleName(/^Mesa 18: Libre$/)
    await expect(aviso(page, 'Mesa 18 lista para usar')).toBeVisible()
    await deshacer(page, 'Mesa 18 lista para usar').click()
    await expect(mesaEnPlano(page, 18)).toHaveAccessibleName(/^Mesa 18: Por limpiar$/)
  })

  test('tocar una mesa por cobrar abre su precuenta', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 12).click()
    await expect(page).toHaveURL(/\/bocetos\/precuenta\?mesa=12$/)
    await expect(page.getByRole('heading', { name: 'Precuenta · Mesa 12' })).toBeVisible()
  })

  test('tocar una mesa reservada abre el pedido y sigue reservada hasta agregar algo', async ({
    page,
  }) => {
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 15).click()
    await expect(page).toHaveURL(/\/bocetos\/pedido\?mesa=15$/)
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(mesaEnPlano(page, 15)).toHaveAccessibleName(/^Mesa 15: Reservada$/)
  })

  test('«Cuentas abiertas» aparece desde 768 px (caja) con el saldo de cada mesa', async ({
    page,
  }, info) => {
    await page.goto('/bocetos/plano')
    const cuentas = page.getByRole('complementary', { name: 'Cuentas abiertas' })
    if (esCaja(info.project.name)) {
      await expect(cuentas).toBeVisible()
      for (const n of [2, 4, 7, 9, 12, 21])
        await expect(
          cuentas.getByRole('button', { name: new RegExp(`^Mesa ${n}\\b`) }),
        ).toBeVisible()
      await expect(cuentas.getByRole('button', { name: /^Mesa 12\b/ })).toContainText('$257.500')
      await expect(cuentas.getByRole('button', { name: /^Mesa 7\b/ })).toContainText('Demora')
    } else {
      await expect(cuentas).toBeHidden()
    }
  })

  test('«Cuentas abiertas» aparece también en una tablet de 768 px', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/bocetos/plano')
    await expect(page.getByRole('complementary', { name: 'Cuentas abiertas' })).toBeVisible()
    await page.setViewportSize({ width: 767, height: 1024 })
    await expect(page.getByRole('complementary', { name: 'Cuentas abiertas' })).toBeHidden()
  })

  test('la vista de lista y la de plano se alternan', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await page.getByRole('button', { name: 'Lista' }).click()
    await expect(page.getByRole('button', { name: 'Plano' })).toBeVisible()
    await expect(page.getByText('Tomando pedido').first()).toBeVisible()
    await page.getByRole('button', { name: 'Plano' }).click()
    await expect(mesaEnPlano(page, 1)).toBeVisible()
  })
})

// ---------------------------------------------------------------------------------------------
// Pedido en 3 toques
// ---------------------------------------------------------------------------------------------

test.describe('pedido en 3 toques', () => {
  test('mesa libre → producto sin opciones → Enviar, y la mesa queda en preparación y en el KDS', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __toques: number }
      w.__toques = 0
      document.addEventListener(
        'click',
        () => {
          w.__toques += 1
        },
        true,
      )
    })
    await page.goto('/bocetos/plano')
    await expect(mesaEnPlano(page, 1)).toBeVisible()
    await page.evaluate(() => {
      ;(window as unknown as { __toques: number }).__toques = 0
    })

    await mesaEnPlano(page, 1).click() // toque 1
    await expect(page.getByRole('heading', { name: 'Mesa 1', exact: true })).toBeVisible()
    await producto(page, 'Pinsa').click() // toque 2
    await expect(aviso(page, 'Agregaste Pinsa')).toBeVisible()
    await enviar(page, 1).click() // toque 3

    await expect(page).toHaveURL(/\/bocetos\/plano$/)
    expect(await page.evaluate(() => (window as unknown as { __toques: number }).__toques)).toBe(3)
    await expect(page.getByRole('dialog')).toHaveCount(0) // sin opciones: ningún panel

    await expect(mesaEnPlano(page, 1)).toHaveAccessibleName(
      /^Mesa 1: En preparación, 0 min, \$20\.900$/,
    )

    // Y aparece en cocina, sin recargar.
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Cocina y barra/ }).click()
    const tarjeta = comanda(page, 1, 'cocina')
    await expect(tarjeta).toBeVisible()
    await expect(tarjeta.getByRole('button', { name: /Pinsa/ })).toBeVisible()
    await expect(tarjeta).toContainText('0 min')
    await expect(tarjeta).toContainText('a tiempo')
    await expect(comanda(page, 1, 'barra')).toHaveCount(0)
  })

  test('Enviar está deshabilitado mientras no hay nada por enviar', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 1).click()
    await expect(enviar(page)).toBeDisabled()
  })

  test('comida y bebida: una comanda en cocina y otra en la barra', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 1).click()
    await producto(page, 'Pinsa').click()
    await buscarEnCarta(page).fill('limonada de coco')
    await producto(page, 'Limonada de Coco').click()
    await enviar(page, 2).click()
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Cocina y barra/ }).click()
    await expect(comanda(page, 1, 'cocina').getByRole('button', { name: /Pinsa/ })).toBeVisible()
    await expect(
      comanda(page, 1, 'barra').getByRole('button', { name: /Limonada de Coco/ }),
    ).toBeVisible()
  })

  test('una segunda ronda envía solo lo nuevo', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 1).click()
    await producto(page, 'Pinsa').click()
    await enviar(page, 1).click()
    await mesaEnPlano(page, 1).click()
    await expect(page.getByRole('heading', { name: 'Mesa 1', exact: true })).toBeVisible()
    await expect(enviar(page)).toBeDisabled()
    await producto(page, 'Tentazione di Formaggio').click()
    await expect(enviar(page, 1)).toBeEnabled()
  })

  test('el mismo producto suma a su línea, la tarjeta muestra la cantidad y Deshacer resta', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await congelarReloj(page)
    await page.goto('/bocetos/pedido?mesa=2')
    await producto(page, 'Pinsa').click()
    await expect(producto(page, 'Pinsa')).toContainText('1 en el pedido')
    await producto(page, 'Pinsa').click()
    await expect(producto(page, 'Pinsa')).toContainText('2 en el pedido')
    await expect(aviso(page, 'Pinsa: 2')).toBeVisible()

    let ticket = await abrirTicket(page, caja)
    const pinsa = ticket.getByRole('listitem').filter({ hasText: 'Pinsa' })
    await expect(pinsa).toHaveCount(1) // una sola línea
    await expect(pinsa).toContainText('$41.800')
    await cerrarTicket(page, caja)

    await deshacer(page, 'Pinsa: 2').click()
    await expect(producto(page, 'Pinsa')).toContainText('1 en el pedido')
    ticket = await abrirTicket(page, caja)
    await expect(ticket.getByRole('listitem').filter({ hasText: 'Pinsa' })).toContainText('$20.900')
  })

  test('el mismo producto para otra persona o con otra nota es otra línea', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=2')
    await producto(page, 'Pinsa').click() // para la mesa
    let ticket = await abrirTicket(page, caja)
    await ticket.getByRole('button', { name: 'Para la persona 2' }).click()
    await cerrarTicket(page, caja)
    await producto(page, 'Pinsa').click() // para P2
    ticket = await abrirTicket(page, caja)
    await expect(ticket.getByRole('listitem').filter({ hasText: 'Pinsa' })).toHaveCount(2)
    await expect(ticket).toContainText('P2 · sin enviar')
  })

  test('un ítem ya enviado no se suma: el mismo producto abre una línea nueva', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=21')
    await producto(page, 'Pinsa').click()
    const ticket = await abrirTicket(page, caja)
    const filas = ticket.getByRole('listitem').filter({ hasText: 'Pinsa' })
    await expect(filas).toHaveCount(2)
    await expect(filas.first()).toContainText('enviado')
    await expect(filas.last()).toContainText('sin enviar')
  })

  test('deshacer el primer producto deja la mesa libre otra vez', async ({ page }) => {
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 3).click()
    await producto(page, 'Pinsa').click()
    await deshacer(page, 'Agregaste Pinsa').click()
    await expect(enviar(page)).toBeDisabled()
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(mesaEnPlano(page, 3)).toHaveAccessibleName(/^Mesa 3: Libre$/)
  })

  test('«Cuenta» lleva a la precuenta de la mesa y está deshabilitado sin ítems', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=1')
    const ticket = await abrirTicket(page, caja)
    await expect(ticket.getByRole('button', { name: 'Cuenta' })).toBeDisabled()
    await cerrarTicket(page, caja)
    await producto(page, 'Pinsa').click()
    const ticket2 = await abrirTicket(page, caja)
    await ticket2.getByRole('button', { name: 'Cuenta' }).click()
    await expect(page).toHaveURL(/\/bocetos\/precuenta\?mesa=1$/)
    await expect(page.getByRole('button', { name: 'Cobrar $20.900' })).toBeVisible()
  })

  test('personas de la mesa: al bajar las personas, «para quién» vuelve a Mesa', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=2')
    const ticket = await abrirTicket(page, caja)
    await expect(ticket).toContainText('2 personas')
    await ticket.getByRole('button', { name: 'Una persona más' }).click()
    await expect(ticket).toContainText('3 personas')
    await ticket.getByRole('button', { name: 'Para la persona 3' }).click()
    await expect(ticket.getByRole('button', { name: 'Para la persona 3' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await ticket.getByRole('button', { name: 'Una persona menos' }).click()
    await expect(ticket).toContainText('2 personas')
    await expect(ticket.getByRole('button', { name: 'Para la mesa' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(ticket.getByRole('button', { name: 'Para la persona 3' })).toHaveCount(0)
  })

  test('«/» lleva a la búsqueda, y escribir «/» dentro del campo no lo roba', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=2')
    await expect(page.getByRole('heading', { name: 'Mesa 2', exact: true })).toBeVisible()
    await page.keyboard.press('/')
    await expect(buscarEnCarta(page)).toBeFocused()
    await expect(buscarEnCarta(page)).toHaveValue('')
    await page.keyboard.type('a/b')
    await expect(buscarEnCarta(page)).toHaveValue('a/b')
  })
})

// ---------------------------------------------------------------------------------------------
// Opciones en panel lateral
// ---------------------------------------------------------------------------------------------

test.describe('productos con opciones', () => {
  test('Ramón Bilbao Crianza: Copa o Botella en un panel; tocar la variante ya lo agrega con su precio', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=1')
    await buscarEnCarta(page).fill('ramon bilbao crianza')
    const tarjeta = producto(page, 'Ramón Bilbao Crianza')
    await expect(tarjeta).toContainText('desde $30.900')
    await tarjeta.click()

    const panel = page.getByRole('dialog', { name: 'Ramón Bilbao Crianza' })
    await expect(panel).toBeVisible()
    // Panel lateral: en la caja pegado a la derecha; en el celular subiendo desde abajo.
    const medida = await panel.boundingBox()
    const ventana = page.viewportSize() as { width: number; height: number }
    expect(medida).not.toBeNull()
    if (caja) {
      expect((medida?.x ?? 0) + (medida?.width ?? 0)).toBeCloseTo(ventana.width, 0)
      expect(medida?.width).toBeLessThan(ventana.width / 2)
    } else {
      expect((medida?.y ?? 0) + (medida?.height ?? 0)).toBeCloseTo(ventana.height, 0)
      expect(medida?.width).toBeCloseTo(ventana.width, 0)
    }

    const copa = panel.getByRole('button', { name: /^Copa/ })
    const botella = panel.getByRole('button', { name: /^Botella/ })
    await expect(copa).toContainText('$30.900')
    await expect(botella).toContainText('$129.900')
    // Sin tocar una variante no hay nada que agregar (un vino sin variante saldría a mal precio).
    await expect(panel.getByRole('button', { name: 'Elige tamaño' })).toBeDisabled()
    await expect(panel.locator('button[aria-pressed="true"]')).toHaveCount(0)

    await botella.click()
    await expect(panel).toBeHidden()
    await expect(aviso(page, 'Agregaste Ramón Bilbao Crianza (botella)')).toBeVisible()

    await producto(page, 'Ramón Bilbao Crianza').click()
    await page
      .getByRole('dialog', { name: 'Ramón Bilbao Crianza' })
      .getByRole('button', { name: /^Copa/ })
      .click()
    await expect(aviso(page, 'Agregaste Ramón Bilbao Crianza (copa)')).toBeVisible()

    const ticket = await abrirTicket(page, caja)
    await expect(
      ticket.getByRole('button', { name: /Ramón Bilbao Crianza \(botella\)/ }),
    ).toContainText('$129.900')
    await expect(
      ticket.getByRole('button', { name: /Ramón Bilbao Crianza \(copa\)/ }),
    ).toContainText('$30.900')
    await expect(ticket.getByText('Total').locator('xpath=following-sibling::span[1]')).toHaveText(
      '$160.800',
    )
  })

  test('la cantidad elegida antes de tocar la variante multiplica su precio', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=1')
    await buscarEnCarta(page).fill('ramon bilbao crianza')
    await producto(page, 'Ramón Bilbao Crianza').click()
    const panel = page.getByRole('dialog', { name: 'Ramón Bilbao Crianza' })
    await panel.getByRole('button', { name: 'Uno más' }).click()
    await panel.getByRole('button', { name: /^Botella/ }).click()
    const ticket = await abrirTicket(page, caja)
    await expect(
      ticket.getByRole('button', { name: /Ramón Bilbao Crianza \(botella\)/ }),
    ).toContainText('$259.800')
  })

  test('Tagliata: el término es obligatorio; tocarlo agrega el plato y no se puede agregar sin él', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=1')
    await buscarEnCarta(page).fill('tagliata')
    await producto(page, 'Tagliata di Manzo').click()

    const panel = page.getByRole('dialog', { name: 'Tagliata di Manzo' })
    await expect(panel.getByText('Término de la carne (obligatorio)')).toBeVisible()
    const agregar = panel.getByRole('button', { name: 'Elige término de la carne' })
    await expect(agregar).toBeDisabled()
    await agregar.click({ force: true, noWaitAfter: true }) // forzarlo tampoco agrega
    await expect(panel).toBeVisible()
    await expect(aviso(page, 'Agregaste Tagliata')).toHaveCount(0)
    for (const termino of ['Rojo', 'Medio', 'Tres cuartos', 'Bien asado'])
      await expect(panel.getByRole('button', { name: termino })).toBeVisible()

    await panel.getByRole('button', { name: 'Tres cuartos' }).click()
    await expect(panel).toBeHidden()
    await expect(aviso(page, 'Agregaste Tagliata di Manzo')).toBeVisible()
    const ticket = await abrirTicket(page, caja)
    const fila = ticket.getByRole('button', { name: /Tagliata di Manzo/ })
    await expect(fila).toContainText('Tres cuartos')
    await expect(fila).toContainText('$40.900')
  })

  test('el término y la nota llegan a la cocina, resaltados', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=1')
    await buscarEnCarta(page).fill('tagliata')
    await producto(page, 'Tagliata di Manzo').click()
    const panel = page.getByRole('dialog', { name: 'Tagliata di Manzo' })
    await panel.getByLabel('Notas para cocina').fill('sin sal')
    await panel.getByRole('button', { name: 'Medio', exact: true }).click()
    await enviar(page, 1).click()
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Cocina y barra/ }).click()
    const tarjeta = comanda(page, 1, 'cocina')
    await expect(tarjeta.getByText('Medio')).toBeVisible()
    await expect(tarjeta.getByText('¡sin sal!')).toBeVisible()
  })

  test('cerrar el panel (Escape, la X o tocar fuera) no agrega nada', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=1')
    await buscarEnCarta(page).fill('tagliata')
    const panel = page.getByRole('dialog', { name: 'Tagliata di Manzo' })

    await producto(page, 'Tagliata di Manzo').click()
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()

    await producto(page, 'Tagliata di Manzo').click()
    await panel.getByRole('button', { name: 'Cerrar' }).click()
    await expect(panel).toBeHidden()

    await producto(page, 'Tagliata di Manzo').click()
    await page.mouse.click(5, 5) // fuera del panel, sobre el fondo oscuro
    await expect(panel).toBeHidden()

    await expect(enviar(page)).toBeDisabled()
  })

  test('Té Hatsu pide el sabor (obligatorio, sin costo) y tocarlo lo agrega', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=1')
    await buscarEnCarta(page).fill('te hatsu')
    await producto(page, 'Té Hatsu').click()
    const panel = page.getByRole('dialog', { name: 'Té Hatsu' })
    await expect(panel.getByRole('button', { name: /^Elige / })).toBeDisabled()
    await panel.getByRole('button', { name: 'Amarillo' }).click()
    await expect(panel).toBeHidden()
    const ticket = await abrirTicket(page, caja)
    const fila = ticket.getByRole('button', { name: /Té Hatsu/ })
    await expect(fila).toContainText('Amarillo')
    await expect(fila).toContainText('$13.900')
  })

  test('la hamburguesa también pide el término al tocarla', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=1')
    await buscarEnCarta(page).fill('spritz burguer')
    await producto(page, 'Spritz Burguer').click()
    await expect(
      page
        .getByRole('dialog', { name: 'Spritz Burguer' })
        .getByText('Término de la carne (obligatorio)'),
    ).toBeVisible()
  })

  test('un producto sin opciones no abre panel y entra con un toque', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=1')
    await producto(page, 'Pinsa').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(enviar(page, 1)).toBeVisible()
  })

  test('escribir la nota tecla por tecla en el panel de un producto no pierde el foco ni letras', async ({
    page,
  }) => {
    await page.goto('/bocetos/pedido?mesa=1')
    await buscarEnCarta(page).fill('ramon bilbao crianza')
    await producto(page, 'Ramón Bilbao Crianza').click()
    const notas = page
      .getByRole('dialog', { name: 'Ramón Bilbao Crianza' })
      .getByLabel('Notas para cocina')
    await notas.click()
    await notas.pressSequentially('bien fría')
    await expect(notas).toHaveValue('bien fría')
    await expect(notas).toBeFocused()
  })

  test('escribir la nota tecla por tecla al editar un ítem no pierde el foco ni letras', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=1')
    await producto(page, 'Pinsa').click()
    const ticket = await abrirTicket(page, caja)
    await ticket.getByRole('button', { name: /Pinsa/ }).click()
    const notas = page.getByRole('dialog', { name: 'Pinsa' }).getByLabel('Notas para cocina')
    await notas.click()
    await notas.pressSequentially('sin rúgula')
    await expect(notas).toHaveValue('sin rúgula')
    await expect(notas).toBeFocused()
  })
})

// ---------------------------------------------------------------------------------------------
// Panel lateral: modal de verdad
// ---------------------------------------------------------------------------------------------

test.describe('panel lateral modal', () => {
  test('al abrirse deja inerte el fondo y sin desplazamiento; al cerrarse todo vuelve', async ({
    page,
  }) => {
    await page.goto('/bocetos/componentes')
    const inerte = () => page.locator('#raiz').evaluate((el) => el.hasAttribute('inert'))
    const bloqueado = () => page.evaluate(() => document.body.style.overflow)
    expect(await inerte()).toBe(false)

    await page.getByRole('button', { name: 'Abrir panel lateral' }).click()
    const panel = page.getByRole('dialog', { name: 'Panel lateral' })
    await expect(panel).toBeFocused()
    expect(await inerte()).toBe(true)
    expect(await bloqueado()).toBe('hidden')
    // El panel vive fuera de la raíz: se puede usar aunque el fondo esté inerte.
    expect(
      await page.evaluate(() =>
        document.body.lastElementChild?.contains(document.querySelector('[role="dialog"]')),
      ),
    ).toBe(true)

    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    expect(await inerte()).toBe(false)
    expect(await bloqueado()).toBe('')
    // El foco vuelve a quien abrió el panel.
    await expect(page.getByRole('button', { name: 'Abrir panel lateral' })).toBeFocused()
  })

  test('el Tab no sale del panel hacia el fondo', async ({ page }) => {
    await page.goto('/bocetos/componentes')
    await page.getByRole('button', { name: 'Abrir panel lateral' }).click()
    const panel = page.getByRole('dialog', { name: 'Panel lateral' })
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      // El foco pasa por el panel o sale de la página (barra del navegador), nunca al fondo.
      const enFondo = await page.evaluate(() => !!document.activeElement?.closest('#raiz'))
      expect(enFondo).toBe(false)
    }
    await expect(panel).toBeVisible()
  })

  test('con dos paneles abiertos (pedido y un ítem), cerrar el de arriba NO libera el fondo', async ({
    page,
  }, info) => {
    test.skip(esCaja(info.project.name), 'El panel «Pedido» solo existe en el celular')
    await page.goto('/bocetos/pedido?mesa=2')
    await page.getByRole('button', { name: /^Pedido \(/ }).click()
    const pedido = page.getByRole('dialog', { name: /^Pedido · Mesa/ })
    await pedido.getByRole('button', { name: /Aperol Spritz/ }).click()
    const item = page.getByRole('dialog', { name: 'Aperol Spritz' })
    await expect(item).toBeVisible()
    await item.getByRole('button', { name: 'Listo' }).click()
    await expect(item).toBeHidden()
    // El panel del pedido sigue abierto: el fondo debe seguir inerte y sin desplazarse.
    await expect(pedido).toBeVisible()
    expect(await page.locator('#raiz').evaluate((el) => el.hasAttribute('inert'))).toBe(true)
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  })
})

// ---------------------------------------------------------------------------------------------
// Deshacer y avisos
// ---------------------------------------------------------------------------------------------

test.describe('deshacer y avisos', () => {
  test('deshacer un ítem agregado lo quita del pedido', async ({ page }, info) => {
    const caja = esCaja(info.project.name)
    await congelarReloj(page)
    await page.goto('/bocetos/pedido?mesa=1')
    await producto(page, 'Tentazione di Formaggio').click()
    await expect(enviar(page, 1)).toBeVisible()
    await deshacer(page, 'Agregaste Tentazione di Formaggio').click()
    await expect(enviar(page)).toBeDisabled()
    const ticket = await abrirTicket(page, caja)
    await expect(ticket.getByRole('button', { name: /Tentazione/ })).toHaveCount(0)
  })

  test('quitar un ítem y deshacer lo devuelve en su posición original', async ({ page }, info) => {
    const caja = esCaja(info.project.name)
    await congelarReloj(page)
    await page.goto('/bocetos/pedido?mesa=1')
    for (const nombre of ['Pinsa', 'Tentazione di Formaggio', 'Polpette'])
      await producto(page, nombre).click()

    let ticket = await abrirTicket(page, caja)
    expect(await nombresDelTicket(ticket)).toEqual([
      'Pinsa',
      'Tentazione di Formaggio',
      'Polpette d’Amore',
    ])
    await ticket.getByRole('button', { name: /Tentazione/ }).click()
    await page
      .getByRole('dialog', { name: 'Tentazione di Formaggio' })
      .getByRole('button', { name: 'Quitar' })
      .click()
    await cerrarTicket(page, caja)
    await expect(aviso(page, 'Quitaste Tentazione di Formaggio')).toBeVisible()
    ticket = await abrirTicket(page, caja)
    expect(await nombresDelTicket(ticket)).toEqual(['Pinsa', 'Polpette d’Amore'])
    await cerrarTicket(page, caja)

    await deshacer(page, 'Quitaste Tentazione di Formaggio').click()
    ticket = await abrirTicket(page, caja)
    expect(await nombresDelTicket(ticket)).toEqual([
      'Pinsa',
      'Tentazione di Formaggio',
      'Polpette d’Amore',
    ])
  })

  test('hasta 3 avisos a la vez, cada uno con su Deshacer: quitar dos ítems seguidos no pierde el primero', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await congelarReloj(page)
    await page.goto('/bocetos/pedido?mesa=1')
    for (const nombre of ['Pinsa', 'Tentazione di Formaggio', 'Polpette'])
      await producto(page, nombre).click()
    const avisos = page.locator('[aria-live="polite"] > div')
    await expect(avisos).toHaveCount(3)

    for (const nombre of ['Pinsa', 'Tentazione']) {
      const ticket = await abrirTicket(page, caja)
      await ticket.getByRole('button', { name: new RegExp(nombre) }).click()
      await page
        .getByRole('dialog', { name: new RegExp(nombre) })
        .getByRole('button', { name: 'Quitar' })
        .click()
      await cerrarTicket(page, caja)
    }
    // Nunca más de 3: los más viejos salen.
    await expect(avisos).toHaveCount(3)
    await expect(aviso(page, 'Quitaste Pinsa')).toBeVisible()
    await expect(aviso(page, 'Quitaste Tentazione')).toBeVisible()
    await expect(aviso(page, 'Agregaste Pinsa')).toHaveCount(0)

    await deshacer(page, 'Quitaste Pinsa').click()
    await deshacer(page, 'Quitaste Tentazione').click()
    const ticket = await abrirTicket(page, caja)
    expect((await nombresDelTicket(ticket)).sort()).toEqual(
      ['Pinsa', 'Polpette d’Amore', 'Tentazione di Formaggio'].sort(),
    )
  })

  test('un aviso desaparece solo a los 5 segundos', async ({ page }) => {
    await congelarReloj(page)
    await page.goto('/bocetos/pedido?mesa=1')
    await producto(page, 'Pinsa').click()
    await expect(deshacer(page, 'Agregaste Pinsa')).toBeVisible()
    await page.clock.runFor(4_900)
    await expect(deshacer(page, 'Agregaste Pinsa')).toBeVisible()
    await page.clock.runFor(200)
    await expect(aviso(page, 'Agregaste Pinsa')).toHaveCount(0)
    await expect(enviar(page, 1)).toBeVisible() // no se deshizo nada
  })

  test('mientras el puntero está encima de un aviso, su tiempo no corre', async ({ page }) => {
    await congelarReloj(page)
    await page.goto('/bocetos/pedido?mesa=1')
    await producto(page, 'Pinsa').click()
    const tarjeta = aviso(page, 'Agregaste Pinsa')
    await tarjeta.hover()
    await page.clock.runFor(20_000)
    await expect(tarjeta).toBeVisible()
    await page.mouse.move(5, 5)
    await page.clock.runFor(5_100)
    await expect(tarjeta).toHaveCount(0)
  })

  test('el aviso conserva el tiempo que le quedaba al salir el puntero', async ({ page }) => {
    await congelarReloj(page)
    await page.goto('/bocetos/pedido?mesa=1')
    await producto(page, 'Pinsa').click()
    const tarjeta = aviso(page, 'Agregaste Pinsa')
    await page.clock.runFor(3_000)
    await tarjeta.hover()
    await page.clock.runFor(30_000)
    await page.mouse.move(5, 5)
    await page.clock.runFor(1_900)
    await expect(tarjeta).toBeVisible() // le quedaban 2 s
    await page.clock.runFor(200)
    await expect(tarjeta).toHaveCount(0)
  })

  test('quitar el ítem y dejar vencer el aviso lo deja quitado', async ({ page }, info) => {
    const caja = esCaja(info.project.name)
    await congelarReloj(page)
    await page.goto('/bocetos/pedido?mesa=1')
    await producto(page, 'Pinsa').click()
    const ticket = await abrirTicket(page, caja)
    await ticket.getByRole('button', { name: /Pinsa/ }).click()
    await page
      .getByRole('dialog', { name: 'Pinsa' })
      .getByRole('button', { name: 'Quitar' })
      .click()
    await cerrarTicket(page, caja)
    await page.clock.runFor(5_500)
    await expect(aviso(page, 'Quitaste Pinsa')).toHaveCount(0)
    const ticket2 = await abrirTicket(page, caja)
    await expect(ticket2.getByRole('button', { name: /Pinsa/ })).toHaveCount(0)
  })

  test('cambiar la cantidad y las notas de un ítem sin enviar', async ({ page }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=1')
    await producto(page, 'Pinsa').click()
    const ticket = await abrirTicket(page, caja)
    await ticket.getByRole('button', { name: /Pinsa/ }).click()
    const item = page.getByRole('dialog', { name: 'Pinsa' })
    await item.getByRole('button', { name: 'Uno más' }).click()
    await item.getByRole('button', { name: 'Uno más' }).click()
    await item.getByLabel('Notas para cocina').fill('bien caliente')
    await item.getByRole('button', { name: 'Listo' }).click()
    const fila = ticket.getByRole('button', { name: /Pinsa/ })
    await expect(fila).toContainText('3')
    await expect(fila).toContainText('«bien caliente»')
    await expect(fila).toContainText('$62.700')
  })
})

// ---------------------------------------------------------------------------------------------
// Anular un ítem enviado
// ---------------------------------------------------------------------------------------------

test.describe('anular un ítem enviado', () => {
  test('pide motivo y confirmación; queda a la vista, tachado, y deja de cobrarse', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=7')
    let ticket = await abrirTicket(page, caja)
    await expect(ticket.getByText('Total').locator('xpath=following-sibling::span[1]')).toHaveText(
      '$53.800',
    )
    await ticket.getByRole('button', { name: /Spritz Burguer/ }).click()

    const panel = page.getByRole('dialog', { name: 'Anular Spritz Burguer' })
    await expect(panel).toContainText('no se puede quitar, solo anular')
    // Sin motivo no se puede anular.
    await expect(panel.getByRole('button', { name: 'Elige el motivo' })).toBeDisabled()
    for (const motivo of ['Error del mesero', 'El cliente cambió', 'Demora', 'Producto dañado'])
      await expect(panel.getByRole('button', { name: motivo })).toBeVisible()

    await panel.getByRole('button', { name: 'Demora' }).click()
    await panel.getByRole('button', { name: 'Anular', exact: true }).click()
    // Pide confirmar y no ha anulado nada todavía.
    await expect(panel).toContainText('¿Anular Spritz Burguer? Queda registrado con el motivo.')
    await panel.getByRole('button', { name: 'Volver' }).click()
    await expect(panel.getByRole('button', { name: 'Anular', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Anular', exact: true }).click()
    await panel.getByRole('button', { name: 'Sí, anular' }).click()
    await expect(panel).toBeHidden()

    await cerrarTicket(page, caja)
    await expect(aviso(page, 'Anulaste Spritz Burguer (demora)')).toBeVisible()
    ticket = await abrirTicket(page, caja)
    const fila = ticket.getByRole('listitem').filter({ hasText: 'Spritz Burguer' })
    await expect(fila).toContainText('anulado: demora')
    await expect(fila.locator('.line-through').first()).toBeVisible()
    await expect(ticket.getByText('Total').locator('xpath=following-sibling::span[1]')).toHaveText(
      '$13.900',
    )
    // Un ítem anulado ya no se puede tocar.
    await fila.getByRole('button').click()
    await expect(page.getByRole('dialog', { name: /Spritz Burguer/ })).toHaveCount(0)
  })

  test('lo anulado sale del KDS, del saldo del plano y de la precuenta', async ({ page }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/pedido?mesa=7')
    const ticket = await abrirTicket(page, caja)
    await ticket.getByRole('button', { name: /Spritz Burguer/ }).click()
    const panel = page.getByRole('dialog', { name: 'Anular Spritz Burguer' })
    await panel.getByRole('button', { name: 'Error del mesero' }).click()
    await panel.getByRole('checkbox', { name: /Ya se había preparado/ }).check()
    await panel.getByRole('button', { name: 'Anular', exact: true }).click()
    await panel.getByRole('button', { name: 'Sí, anular' }).click()
    await cerrarTicket(page, caja)

    await irA(page, '/bocetos/kds')
    await expect(comanda(page, 7, 'cocina')).toHaveCount(0) // solo tenía la hamburguesa
    await expect(comanda(page, 7, 'barra')).toBeVisible() // el té sigue

    await irA(page, '/bocetos/plano')
    await expect(mesaEnPlano(page, 7)).toHaveAccessibleName(/\$13\.900$/)

    await irA(page, '/bocetos/precuenta?mesa=7')
    await expect(page.getByRole('region', { name: 'Ítems' })).not.toContainText('Spritz Burguer')
  })
})

// ---------------------------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------------------------

test.describe('búsqueda en la carta', () => {
  const resultados = (page: Page) => page.locator('section[aria-label="Carta"] > ul > li')

  test('«hamburgesa» encuentra Spritz Burguer', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=2')
    await buscarEnCarta(page).fill('hamburgesa')
    await expect(resultados(page).first()).toContainText('Spritz Burguer')
  })

  test('«quatro formagi» encuentra Quattro Formaggi', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=2')
    await buscarEnCarta(page).fill('quatro formagi')
    await expect(resultados(page).first()).toContainText('Quattro Formaggi')
  })

  test('sin tildes, en mayúsculas y con las palabras al revés', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=2')
    await buscarEnCarta(page).fill('TE hatsu')
    await expect(producto(page, 'Té Hatsu')).toBeVisible()
    await buscarEnCarta(page).fill('formaggi QUATTRO')
    await expect(resultados(page).first()).toContainText('Quattro Formaggi')
  })

  test('lo que no existe avisa y borrar la búsqueda vuelve a las categorías', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=2')
    const categorias = page.getByRole('group', { name: 'Categorías' })
    await expect(categorias).toBeVisible()
    await buscarEnCarta(page).fill('zzzzzz')
    await expect(page.getByText('No hay nada con «zzzzzz».')).toBeVisible()
    await expect(categorias).toBeHidden()
    await buscarEnCarta(page).fill('')
    await expect(categorias).toBeVisible()
    await expect(producto(page, 'Pinsa')).toBeVisible()
  })

  test('con más de 30 resultados muestra 30 y avisa cuántos faltan', async ({ page }) => {
    await page.goto('/bocetos/pedido?mesa=2')
    await buscarEnCarta(page).fill('s')
    await expect(resultados(page).filter({ hasText: /^Hay \d+ más/ })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Carta' }).locator('ul > li button')).toHaveCount(
      30,
    )
    const texto = await resultados(page)
      .filter({ hasText: /^Hay \d+ más/ })
      .textContent()
    expect(numeroDe(texto ?? '')).toBeGreaterThan(0)
  })

  test('un producto encontrado por búsqueda se agrega igual que desde la categoría', async ({
    page,
  }) => {
    await page.goto('/bocetos/pedido?mesa=2')
    await buscarEnCarta(page).fill('pinza')
    await producto(page, 'Pinsa').click()
    await expect(aviso(page, 'Agregaste Pinsa')).toBeVisible()
  })

  test('las categorías cambian los productos y marcan la elegida con ✓, no solo con color', async ({
    page,
  }) => {
    await page.goto('/bocetos/pedido?mesa=2')
    const categorias = page.getByRole('group', { name: 'Categorías' })
    const primera = categorias.getByRole('button').first()
    await expect(primera).toHaveAttribute('aria-pressed', 'true')
    await expect(primera.locator('svg')).toHaveCount(1)
    const otra = categorias.getByRole('button').nth(1)
    await expect(otra.locator('svg')).toHaveCount(0)
    await otra.click()
    await expect(otra).toHaveAttribute('aria-pressed', 'true')
    await expect(otra.locator('svg')).toHaveCount(1)
    await expect(primera).toHaveAttribute('aria-pressed', 'false')
    await expect(producto(page, 'Pinsa')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Precuenta
// ---------------------------------------------------------------------------------------------

test.describe('precuenta (docs/DINERO.md)', () => {
  const fila = (page: Page, rotulo: RegExp) =>
    page.locator('dt', { hasText: rotulo }).locator('xpath=following-sibling::dd[1]')
  const cuentas = (page: Page) =>
    page.getByRole('region', { name: 'Dividir' }).getByRole('listitem')
  /** Monto y propina de cada cuenta tal como se leen en pantalla. */
  const leerCuentas = async (page: Page) => {
    const textos = await cuentas(page).evaluateAll((lis) => lis.map((li) => li.textContent ?? ''))
    return textos.flatMap((t) => {
      const m = /\$([\d.]+) \+ propina \$([\d.]+)/.exec(t)
      return m ? [{ monto: numeroDe(m[1] as string), propina: numeroDe(m[2] as string) }] : []
    })
  }

  test('mesa 12: total, propina sugerida sobre la base sin INC y total con propina', async ({
    page,
  }) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    // 44.900 + 40.900 + 27.900 + 129.900 + 13.900
    await expect(fila(page, /^Total$/)).toHaveText('$257.500')
    // 257.500 / 1,08 = 238.425,93 → 10 % = 23.842,59 → 23.843 (no 25.750, que sería sobre el bruto)
    await expect(fila(page, /Propina sugerida/)).toHaveText('$23.843')
    await expect(fila(page, /^Con propina$/)).toHaveText('$281.343')
    await expect(page.getByText('Precios con INC incluido.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cobrar $257.500' })).toBeVisible()
    // Sin pagos todavía: no hay renglones de «Ya pagado».
    await expect(page.getByText('Ya pagado')).toHaveCount(0)
  })

  for (const mesa of [2, 4, 7, 12, 21]) {
    test(`mesa ${mesa}: la propina sale de la base sin INC con un solo redondeo`, async ({
      page,
    }) => {
      await page.goto(`/bocetos/precuenta?mesa=${mesa}`)
      const total = numeroDe((await fila(page, /^Total$/).textContent()) ?? '')
      expect(total).toBeGreaterThan(0)
      const propina = propinaEsperada(total)
      await expect(fila(page, /Propina sugerida/)).toHaveText(enPesos(propina))
      await expect(fila(page, /^Con propina$/)).toHaveText(enPesos(total + propina))
    })
  }

  test('mesa 21: cada línea es cantidad × precio', async ({ page }) => {
    await page.goto('/bocetos/precuenta?mesa=21')
    const items = page.getByRole('region', { name: 'Ítems' })
    await expect(items.getByRole('listitem').filter({ hasText: 'Pinsa' })).toContainText('$41.800')
    await expect(items.getByRole('listitem').filter({ hasText: 'Limonada de Coco' })).toContainText(
      '$74.500',
    )
    await expect(fila(page, /^Total$/)).toHaveText('$116.300')
  })

  test('partes iguales del saldo: 257.500 entre 2, 3 y 4 por mayor residuo, con la propina de cada una', async ({
    page,
  }) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    await page.getByRole('button', { name: 'Partes iguales' }).click()
    await expect(page.getByRole('button', { name: /^Quitar personas/ })).toBeDisabled()
    expect(await leerCuentas(page)).toEqual([
      { monto: 128_750, propina: 11_922 },
      { monto: 128_750, propina: 11_921 },
    ])

    await page.getByRole('button', { name: /^Agregar personas/ }).click()
    // 257.500 / 3 = 85.833,33: el peso sobrante va a la primera cuenta
    const tres = await leerCuentas(page)
    expect(tres.map((c) => c.monto)).toEqual([85_834, 85_833, 85_833])
    expect(tres.map((c) => c.propina)).toEqual(repartoPorResiduo(23_843, [85_834, 85_833, 85_833]))

    await page.getByRole('button', { name: /^Agregar personas/ }).click()
    expect((await leerCuentas(page)).map((c) => c.monto)).toEqual([64_375, 64_375, 64_375, 64_375])
  })

  test('de 2 a 20 personas: los montos suman el saldo, difieren en 1 peso y las propinas suman la total', async ({
    page,
  }) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    await page.getByRole('button', { name: 'Partes iguales' }).click()
    const mas = page.getByRole('button', { name: /^Agregar personas/ })
    for (let personas = 2; personas <= 20; personas++) {
      const cuentasLeidas = await leerCuentas(page)
      expect(cuentasLeidas).toHaveLength(personas)
      const montos = cuentasLeidas.map((c) => c.monto)
      expect(montos.reduce((a, b) => a + b, 0)).toBe(257_500)
      expect(Math.max(...montos) - Math.min(...montos)).toBeLessThanOrEqual(1)
      const propinas = cuentasLeidas.map((c) => c.propina)
      expect(propinas.reduce((a, b) => a + b, 0)).toBe(23_843)
      expect(propinas).toEqual(repartoPorResiduo(23_843, montos))
      if (personas < 20) await mas.click()
    }
    await expect(mas).toBeDisabled()
  })

  test('por ítems con el vino compartido entre dos cuentas', async ({ page }) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    await page.getByRole('button', { name: 'Por ítems' }).click()
    const quien = (item: string) => page.getByRole('group', { name: `Quién paga ${item}` })

    // Sin asignar nada, todo queda sin asignar y las cuentas valen $0.
    await expect(cuentas(page)).toContainText(['Cuenta 1', 'Cuenta 2', 'Sin asignar$257.500'])
    expect((await leerCuentas(page)).map((c) => c.monto)).toEqual([0, 0])

    await quien('Quattro Formaggi').getByRole('button', { name: 'Cuenta 1' }).click()
    await quien('Patatine al Tartufo').getByRole('button', { name: 'Cuenta 1' }).click()
    await quien('Tagliata di Manzo').getByRole('button', { name: 'Cuenta 2' }).click()
    await quien('Té Hatsu').getByRole('button', { name: 'Cuenta 2' }).click()
    const vino = quien('Ramón Bilbao Crianza (botella)')
    await vino.getByRole('button', { name: 'Cuenta 1' }).click()
    await vino.getByRole('button', { name: 'Cuenta 2' }).click()

    // Cuenta 1: 44.900 + 27.900 + 64.950 = 137.750 · Cuenta 2: 40.900 + 13.900 + 64.950 = 119.750
    const leidas = await leerCuentas(page)
    expect(leidas.map((c) => c.monto)).toEqual([137_750, 119_750])
    expect(leidas.map((c) => c.propina)).toEqual(repartoPorResiduo(23_843, [137_750, 119_750]))
    await expect(page.getByText('Sin asignar')).toHaveCount(0)
  })

  test('por ítems: un ítem entre 3 se reparte por mayor residuo y lo demás queda sin asignar', async ({
    page,
  }) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    await page.getByRole('button', { name: 'Por ítems' }).click()
    await page.getByRole('button', { name: /^Agregar cuentas/ }).click()
    const pizza = page.getByRole('group', { name: 'Quién paga Quattro Formaggi' })
    for (const c of [1, 2, 3]) await pizza.getByRole('button', { name: `Cuenta ${c}` }).click()
    // 44.900 / 3 = 14.966,67
    expect((await leerCuentas(page)).map((c) => c.monto)).toEqual([14_967, 14_967, 14_966])
    await expect(cuentas(page).filter({ hasText: 'Sin asignar' })).toContainText('$212.600')
  })

  test('tocar de nuevo una cuenta quita al ítem de esa cuenta', async ({ page }) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    await page.getByRole('button', { name: 'Por ítems' }).click()
    const boton = page
      .getByRole('group', { name: 'Quién paga Quattro Formaggi' })
      .getByRole('button', { name: 'Cuenta 1' })
    await boton.click()
    await expect(boton).toHaveAttribute('aria-pressed', 'true')
    expect((await leerCuentas(page))[0]?.monto).toBe(44_900)
    await boton.click()
    await expect(boton).toHaveAttribute('aria-pressed', 'false')
    expect((await leerCuentas(page))[0]?.monto).toBe(0)
  })

  test('quitar una cuenta no rompe la pantalla: lo suyo vuelve a «sin asignar»', async ({
    page,
  }) => {
    const errores: string[] = []
    page.on('pageerror', (e) => errores.push(e.message))
    await page.goto('/bocetos/precuenta?mesa=12')
    await page.getByRole('button', { name: 'Por ítems' }).click()
    await page.getByRole('button', { name: /^Agregar cuentas/ }).click()
    const pizza = page.getByRole('group', { name: 'Quién paga Quattro Formaggi' })
    await pizza.getByRole('button', { name: 'Cuenta 2' }).click()
    await pizza.getByRole('button', { name: 'Cuenta 3' }).click()
    await page.getByRole('button', { name: /^Quitar cuentas/ }).click()
    await expect(page.getByRole('heading', { name: 'Precuenta · Mesa 12' })).toBeVisible()
    expect(errores).toEqual([])
    // La pizza queda solo en la cuenta 2; la cuenta 3 desapareció.
    expect((await leerCuentas(page)).map((c) => c.monto)).toEqual([0, 44_900])
    await expect(cuentas(page).filter({ hasText: 'Sin asignar' })).toContainText('$212.600')
    await expect(pizza.getByRole('button', { name: 'Cuenta 3' })).toHaveCount(0)
  })

  test('imprimir la precuenta avisa y deja la mesa «Por cobrar» en el plano', async ({ page }) => {
    await page.goto('/bocetos/precuenta?mesa=4')
    await page.getByRole('button', { name: 'Imprimir' }).click()
    await expect(aviso(page, 'Precuenta enviada a la impresora')).toBeVisible()
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(mesaEnPlano(page, 4)).toHaveAccessibleName(/^Mesa 4: Por cobrar/)
  })

  test('«Cobrar» de una sola cuenta lleva al cobro de la misma mesa con todo el saldo', async ({
    page,
  }) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    await page.getByRole('button', { name: /^Cobrar/ }).click()
    await expect(page).toHaveURL(/\/bocetos\/cobro\?mesa=12&monto=257500&propina=23843$/)
    await expect(page.getByRole('heading', { name: 'Cobro · Mesa 12' })).toBeVisible()
  })

  test('las acciones quedan en una barra fija abajo en el celular y en el panel en la caja', async ({
    page,
  }, info) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    const imprimir = page.getByRole('button', { name: 'Imprimir' })
    const caja = await imprimir.boundingBox()
    const ventana = page.viewportSize() as { width: number; height: number }
    if (esCaja(info.project.name)) {
      expect((caja?.y ?? 0) + (caja?.height ?? 0)).toBeLessThan(ventana.height - 20)
    } else {
      expect((caja?.y ?? 0) + (caja?.height ?? 0)).toBeGreaterThan(ventana.height - 90)
      // Y no tapa el contenido final: se puede llegar a «Precios con INC incluido».
      await page.getByText('Precios con INC incluido.').scrollIntoViewIfNeeded()
      const texto = await page.getByText('Precios con INC incluido.').boundingBox()
      expect((texto?.y ?? 0) + (texto?.height ?? 0)).toBeLessThanOrEqual(caja?.y ?? 0)
    }
  })

  test('una mesa fuera de rango o inexistente usa la de ejemplo, sin romper la pantalla', async ({
    page,
  }) => {
    await page.goto('/bocetos/precuenta?mesa=999')
    await expect(page.getByRole('heading', { name: 'Precuenta · Mesa 12' })).toBeVisible()
    await page.goto('/bocetos/precuenta?mesa=abc')
    await expect(page.getByRole('heading', { name: 'Precuenta · Mesa 12' })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------------------------
// Cobro
// ---------------------------------------------------------------------------------------------

test.describe('cobro (docs/DINERO.md#pagos)', () => {
  const cobrar = (page: Page, monto: number) =>
    page.getByRole('button', { name: `Cobrar ${enPesos(monto)}` })
  const saldo = (page: Page) => page.getByRole('region', { name: 'Saldo' }).locator('p').nth(1)
  const entrega = (page: Page) => page.getByLabel('El cliente entrega')
  const propina = (page: Page) => page.getByLabel('Propina', { exact: true })
  const confirmacion = (page: Page) => page.getByRole('alertdialog')
  /** Abre el cobro y espera a que la pantalla (que se carga aparte) esté lista para el teclado. */
  const irACobro = async (page: Page, ruta = '/bocetos/cobro?mesa=12') => {
    await page.goto(ruta)
    await expect(page.getByText('Saldo pendiente')).toBeVisible()
  }

  test('arranca con el saldo, la propina sugerida redondeada a $100 y el exacto ya puesto', async ({
    page,
  }) => {
    await page.goto('/bocetos/cobro?mesa=12')
    await expect(saldo(page)).toHaveText('$257.500')
    await expect(page.getByText('sugerida $23.843')).toBeVisible()
    await expect(propina(page)).toHaveValue('23.800') // en efectivo, múltiplo de $100
    await expect(page.getByText('A cobrar (venta redondeada a $100 + propina)')).toBeVisible()
    await expect(entrega(page)).toHaveValue('281.300') // exacto por defecto
    await expect(page.getByText('Cambio $0')).toBeVisible()
    await expect(cobrar(page, 281_300)).toBeEnabled()
  })

  test('efectivo: «Faltan» cuando no alcanza y cambio cuando sobra', async ({ page }) => {
    await page.goto('/bocetos/cobro?mesa=12')
    await page.getByRole('button', { name: '20 mil' }).click()
    await expect(entrega(page)).toHaveValue('20.000')
    await expect(page.getByText('Faltan $261.300')).toBeVisible()
    await expect(cobrar(page, 281_300)).toBeDisabled()

    await page.getByRole('button', { name: '100 mil' }).click()
    await expect(page.getByText('Faltan $181.300')).toBeVisible()

    await entrega(page).fill('281299')
    await expect(page.getByText('Faltan $1', { exact: true })).toBeVisible()
    await expect(cobrar(page, 281_300)).toBeDisabled()

    await entrega(page).fill('300000')
    await expect(entrega(page)).toHaveValue('300.000') // se escribe con puntos de miles
    await expect(page.getByText('Cambio $18.700')).toBeVisible()
    await expect(cobrar(page, 281_300)).toBeEnabled()

    await page.getByRole('button', { name: 'Exacto' }).click()
    await expect(entrega(page)).toHaveValue('281.300')
    await expect(page.getByText('Cambio $0')).toBeVisible()
  })

  test('«Deja el cambio de propina» pasa el cambio a la propina y cuadra sin cambio', async ({
    page,
  }) => {
    await page.goto('/bocetos/cobro?mesa=12')
    await expect(page.getByRole('button', { name: 'Deja el cambio de propina' })).toHaveCount(0)
    await entrega(page).fill('300000')
    await page.getByRole('button', { name: 'Deja el cambio de propina' }).click()
    await expect(propina(page)).toHaveValue('42.500') // 23.800 + 18.700
    await expect(page.getByText('Cambio $0')).toBeVisible()
    await expect(cobrar(page, 300_000)).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Deja el cambio de propina' })).toHaveCount(0)
  })

  test('la propina se puede cambiar, quitar y volver a la sugerida', async ({ page }) => {
    await page.goto('/bocetos/cobro?mesa=12')
    await page.getByRole('button', { name: 'Sin propina' }).click()
    await expect(propina(page)).toHaveValue('')
    await expect(cobrar(page, 257_500)).toBeVisible()
    await propina(page).fill('5000')
    await expect(propina(page)).toHaveValue('5.000')
    await expect(cobrar(page, 262_500)).toBeVisible()
    await page.getByRole('button', { name: 'Sugerida' }).click()
    await expect(propina(page)).toHaveValue('23.800')
  })

  test('los campos de dinero solo aceptan números', async ({ page }) => {
    await irACobro(page)
    await entrega(page).fill('3a0b0$000')
    await expect(entrega(page)).toHaveValue('300.000')
    await propina(page).fill('1x0')
    await expect(propina(page)).toHaveValue('10')
  })

  test('pide confirmar antes de registrar: nada cambia hasta confirmar, y Cancelar vuelve', async ({
    page,
  }) => {
    await irACobro(page)
    await entrega(page).fill('300000')
    await cobrar(page, 281_300).click()

    await expect(confirmacion(page)).toContainText('¿Registrar $281.300 en efectivo?')
    await expect(saldo(page)).toHaveText('$257.500') // todavía no se registró nada
    // El foco pasa a «Confirmar».
    await expect(page.getByRole('button', { name: 'Confirmar' })).toBeFocused()

    await page.getByRole('button', { name: 'Cancelar' }).click()
    await expect(confirmacion(page)).toBeHidden()
    await expect(saldo(page)).toHaveText('$257.500')
  })

  test('Enter pide confirmar y el foco queda en «Confirmar»: otro Enter registra', async ({
    page,
  }) => {
    await irACobro(page)
    await entrega(page).fill('300000')

    await page.keyboard.press('Enter')
    await expect(confirmacion(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Confirmar' })).toBeFocused()
    await expect(saldo(page)).toHaveText('$257.500') // un solo Enter nunca registra

    await page.keyboard.press('Escape')
    await expect(confirmacion(page)).toBeHidden()
    await expect(saldo(page)).toHaveText('$257.500')

    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect(saldo(page)).toHaveText('$0')
    await expect(aviso(page, 'Mesa 12 pagada y cerrada')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Saldo' })).toContainText('Cambio a entregar')
    await expect(page.getByRole('region', { name: 'Saldo' })).toContainText('$18.700')
    await expect(page.getByRole('region', { name: 'Saldo' })).toContainText(
      /efectivo\$257\.500 \+ propina \$23\.800/i,
    )
  })

  test('Enter con el foco en «Cancelar» cancela, no registra', async ({ page }) => {
    await irACobro(page)
    await page.keyboard.press('Enter')
    await expect(confirmacion(page)).toBeVisible()
    await page.keyboard.press('Shift+Tab') // de «Confirmar» a «Cancelar»
    await expect(page.getByRole('button', { name: 'Cancelar' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(confirmacion(page)).toBeHidden()
    await expect(saldo(page)).toHaveText('$257.500')
  })

  test('Enter no hace nada si el pago todavía no es válido', async ({ page }) => {
    await irACobro(page)
    await entrega(page).fill('100000')
    await page.keyboard.press('Enter')
    await expect(confirmacion(page)).toHaveCount(0)
    await expect(saldo(page)).toHaveText('$257.500')
  })

  test('F2 y F3 cambian el medio de pago, con ✓ en el elegido', async ({ page }) => {
    await page.goto('/bocetos/cobro?mesa=12')
    const efectivo = page.getByRole('button', { name: /^Efectivo/ })
    const tarjeta = page.getByRole('button', { name: /^Tarjeta/ })
    await expect(efectivo).toHaveAttribute('aria-pressed', 'true')
    await expect(efectivo.locator('svg')).toHaveCount(1)

    await page.keyboard.press('F3')
    await expect(tarjeta).toHaveAttribute('aria-pressed', 'true')
    await expect(efectivo).toHaveAttribute('aria-pressed', 'false')
    await expect(tarjeta.locator('svg')).toHaveCount(1)
    await expect(page.getByLabel('Número de aprobación')).toBeVisible()
    // Con tarjeta la propina queda exacta, no redondeada.
    await expect(propina(page)).toHaveValue('23.843')

    await page.keyboard.press('F2')
    await expect(efectivo).toHaveAttribute('aria-pressed', 'true')
    await expect(entrega(page)).toBeVisible()
    await expect(propina(page)).toHaveValue('23.800')
  })

  test('tarjeta: exige un número de aprobación de 4 a 8 dígitos y se cobra con Enter', async ({
    page,
  }) => {
    await irACobro(page)
    await page.keyboard.press('F3')
    const aprobacion = page.getByLabel('Número de aprobación')
    await expect(page.getByText('Total en el datáfono (venta + propina)')).toBeVisible()
    await expect(cobrar(page, 281_343)).toBeDisabled()

    await aprobacion.fill('123')
    await expect(cobrar(page, 281_343)).toBeDisabled()
    await aprobacion.fill('12ab34')
    await expect(aprobacion).toHaveValue('1234')
    await expect(cobrar(page, 281_343)).toBeEnabled()
    await aprobacion.fill('123456789')
    await expect(aprobacion).toHaveValue('12345678')

    await page.keyboard.press('Enter')
    await expect(confirmacion(page)).toContainText('¿Registrar $281.343 en tarjeta?')
    await page.keyboard.press('Enter')
    await expect(saldo(page)).toHaveText('$0')
    await expect(aviso(page, 'Mesa 12 pagada y cerrada')).toBeVisible()
  })

  test('cambiar de medio mientras se confirma cierra la confirmación', async ({ page }) => {
    await irACobro(page)
    await page.keyboard.press('Enter')
    await expect(confirmacion(page)).toBeVisible()
    await page.getByRole('button', { name: /^Tarjeta/ }).click()
    await expect(confirmacion(page)).toHaveCount(0)
  })

  test('al pagar todo la mesa se cierra sola y queda «Por limpiar» en el plano', async ({
    page,
  }) => {
    await irACobro(page)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect(saldo(page)).toHaveText('$0')
    await expect(page.getByRole('region', { name: 'Pago' })).toHaveCount(0) // nada más que cobrar
    await expect(page.getByRole('button', { name: 'Cerrar mesa' })).toHaveCount(0) // ya no hace falta

    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await expect(page).toHaveURL(/\/bocetos\/plano$/)
    await expect(mesaEnPlano(page, 12)).toHaveAccessibleName(/^Mesa 12: Por limpiar$/)
    await expect(page.getByText('0 por cobrar')).toBeVisible()
  })

  test('Deshacer el cierre deja la mesa «Por cobrar»', async ({ page }) => {
    await congelarReloj(page)
    await irACobro(page)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await deshacer(page, 'Mesa 12 pagada y cerrada').click()
    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await expect(mesaEnPlano(page, 12)).toHaveAccessibleName(/^Mesa 12: Por cobrar/)
  })

  test('la mesa por limpiar se deja libre y vacía para el siguiente cliente', async ({ page }) => {
    await irACobro(page)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await mesaEnPlano(page, 12).click()
    await expect(mesaEnPlano(page, 12)).toHaveAccessibleName(/^Mesa 12: Libre$/)
  })

  test('el monto de la ruta es la parte de una cuenta; si no cabe en el saldo, se cobra el saldo', async ({
    page,
  }) => {
    await page.goto('/bocetos/cobro?mesa=12&monto=128750&propina=11922')
    await expect(page.getByText('Esta cuenta: $128.750')).toBeVisible()
    await expect(saldo(page)).toHaveText('$257.500')
    await expect(page.getByText('sugerida $11.922')).toBeVisible()
    await expect(propina(page)).toHaveValue('11.900')
    // Un abono no se redondea: 128.750 + 11.900
    await expect(page.getByText('A cobrar (venta + propina)')).toBeVisible()
    await expect(cobrar(page, 140_650)).toBeVisible()

    await page.goto('/bocetos/cobro?mesa=12&monto=999999999')
    await expect(cobrar(page, 281_300)).toBeVisible()
    await page.goto('/bocetos/cobro?mesa=12&monto=abc')
    await expect(cobrar(page, 281_300)).toBeVisible()
    await page.goto('/bocetos/cobro?mesa=12&monto=0')
    await expect(cobrar(page, 281_300)).toBeVisible()
  })

  test('pago parcial por cuenta: la mesa sigue abierta con el saldo correcto; la segunda cuenta la cierra', async ({
    page,
  }) => {
    await page.goto('/bocetos/precuenta?mesa=12')
    await page.getByRole('button', { name: 'Partes iguales' }).click()
    await page.getByRole('button', { name: 'Cobrar $128.750' }).first().click()
    await expect(page).toHaveURL(/\/bocetos\/cobro\?mesa=12&monto=128750&propina=11922$/)
    await expect(page.getByText('Esta cuenta: $128.750')).toBeVisible()

    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    // Un pago parcial vuelve a la precuenta, con lo pagado y el saldo.
    await expect(page).toHaveURL(/\/bocetos\/precuenta\?mesa=12$/)
    await expect(aviso(page, 'Pago registrado. Queda $128.750')).toBeVisible()
    const fila = (r: RegExp) =>
      page.locator('dt', { hasText: r }).locator('xpath=following-sibling::dd[1]')
    await expect(fila(/^Total$/)).toHaveText('$257.500')
    await expect(fila(/^Ya pagado$/)).toHaveText('-$128.750')
    await expect(fila(/^Saldo$/)).toHaveText('$128.750')
    // La propina sugerida se vuelve a calcular sobre el saldo: 128.750 / 1,08 × 10 %.
    await expect(fila(/Propina sugerida/)).toHaveText(enPesos(propinaEsperada(128_750)))
    await expect(fila(/^Con propina$/)).toHaveText(enPesos(128_750 + propinaEsperada(128_750)))

    // El plano sigue mostrando la mesa abierta, con el saldo pendiente.
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(mesaEnPlano(page, 12)).toHaveAccessibleName(/\$128\.750$/)
    await mesaEnPlano(page, 12).click()

    // Con pagos previos ya no se divide por ítems.
    await page.getByRole('button', { name: 'Por ítems' }).click()
    await expect(page.getByText('Ya hay pagos: divide el saldo en partes iguales.')).toBeVisible()
    await expect(page.getByRole('group', { name: /^Quién paga/ })).toHaveCount(0)

    // La segunda cuenta es el saldo completo: se redondea a $100 (128.750 → 128.700) y cierra.
    await page.getByRole('button', { name: 'Una cuenta' }).click()
    await page.getByRole('button', { name: 'Cobrar $128.750' }).click()
    await expect(page.getByText('A cobrar (venta redondeada a $100 + propina)')).toBeVisible()
    await expect(cobrar(page, 140_600)).toBeVisible() // 128.700 + 11.900
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await expect(saldo(page)).toHaveText('$0')
    await expect(aviso(page, 'Mesa 12 pagada y cerrada')).toBeVisible()
    const pagos = page.getByRole('region', { name: 'Saldo' }).getByRole('listitem')
    await expect(pagos).toHaveCount(2)
    await expect(pagos.nth(0)).toContainText('$128.750 + propina $11.900')
    await expect(pagos.nth(1)).toContainText('$128.750 + propina $11.900 (redondeo -$50)')
    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await expect(mesaEnPlano(page, 12)).toHaveAccessibleName(/^Mesa 12: Por limpiar$/)
  })

  test('de punta a punta: pedido nuevo, precuenta y cobro dejan la mesa por limpiar y fuera del KDS', async ({
    page,
  }, info) => {
    const caja = esCaja(info.project.name)
    await page.goto('/bocetos/plano')
    await mesaEnPlano(page, 1).click()
    await producto(page, 'Pinsa').click()
    await enviar(page, 1).click()
    await mesaEnPlano(page, 1).click() // en preparación: vuelve al pedido
    const ticket = await abrirTicket(page, caja)
    await ticket.getByRole('button', { name: 'Cuenta' }).click()
    await expect(page.getByRole('button', { name: 'Cobrar $20.900' })).toBeVisible()
    await page.getByRole('button', { name: 'Cobrar $20.900' }).click()
    // 20.900 / 1,08 × 10 % = 1.935,19 → 1.935; en efectivo 1.900
    await expect(propina(page)).toHaveValue('1.900')
    await entrega(page).fill('25000')
    await expect(page.getByText('Cambio $2.200')).toBeVisible() // 25.000 − 20.900 − 1.900
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await expect(mesaEnPlano(page, 1)).toHaveAccessibleName(/^Mesa 1: Por limpiar$/)
  })
})

// ---------------------------------------------------------------------------------------------
// KDS
// ---------------------------------------------------------------------------------------------

test.describe('KDS (cocina y barra)', () => {
  test('una tarjeta por mesa y estación, la más antigua primero', async ({ page }) => {
    await page.goto('/bocetos/kds')
    for (const [mesa, estacion] of [
      [7, 'cocina'],
      [7, 'barra'],
      [4, 'cocina'],
      [4, 'barra'],
      [21, 'cocina'],
      [21, 'barra'],
    ] as const)
      await expect(comanda(page, mesa, estacion)).toBeVisible()
    // Lo ya despachado o sin enviar no aparece.
    await expect(comanda(page, 9, 'cocina')).toHaveCount(0)
    await expect(comanda(page, 12, 'cocina')).toHaveCount(0)
    await expect(comanda(page, 2, 'barra')).toHaveCount(0)

    const numeros = (await page.locator('main ul > li p.text-2xl').allInnerTexts()).map(numeroDe)
    expect(numeros.filter((n, i) => n !== numeros[i - 1])).toEqual([7, 4, 21])
  })

  test('el tiempo se lee con texto: a tiempo, atención o demora', async ({ page }) => {
    await page.goto('/bocetos/kds')
    const t21 = comanda(page, 21, 'cocina')
    const t4 = comanda(page, 4, 'cocina')
    const t7 = comanda(page, 7, 'cocina')
    await expect(t21).toContainText(/\d min/)
    await expect(t21).toContainText('a tiempo')
    await expect(t4).toContainText('atención')
    await expect(t7).toContainText('demora')
    // «A tiempo» es gris (el verde queda para «listo»): ni verde ni ámbar ni rojo.
    await expect(t21.locator('span.rounded-full').first()).toHaveClass(/neutro/)
    await expect(t4.locator('span.rounded-full').first()).toHaveClass(/proceso/)
    await expect(t7.locator('span.rounded-full').first()).toHaveClass(/alerta/)
  })

  test('el tiempo sube con el reloj, sin esperas reales, y cambia de tono a los 10 y 20 minutos', async ({
    page,
  }) => {
    await congelarReloj(page)
    await page.goto('/bocetos/kds')
    const t21 = comanda(page, 21, 'cocina')
    await expect(t21).toContainText('6 min')
    await expect(t21).toContainText('a tiempo')
    await page.clock.runFor(4 * 60_000)
    await expect(t21).toContainText('10 min')
    await expect(t21).toContainText('atención')
    await page.clock.runFor(10 * 60_000)
    await expect(t21).toContainText('20 min')
    await expect(t21).toContainText('demora')
  })

  test('el plano y el KDS cuentan el tiempo igual: la demora del plano sale de la misma comanda', async ({
    page,
  }) => {
    await congelarReloj(page)
    await page.goto('/bocetos/plano')
    await expect(mesaEnPlano(page, 21)).toHaveAccessibleName(/^Mesa 21: En preparación/)
    await page.clock.runFor(14 * 60_000) // 6 + 14 = 20 min de comanda
    await expect(mesaEnPlano(page, 21)).toHaveAccessibleName(/^Mesa 21: Demora/)
  })

  test('el filtro de estación muestra solo cocina o solo barra', async ({ page }) => {
    await page.goto('/bocetos/kds')
    const estacion = page.getByRole('group', { name: 'Estación' })
    await estacion.getByRole('button', { name: 'barra' }).click()
    await expect(comanda(page, 4, 'barra')).toBeVisible()
    await expect(comanda(page, 4, 'cocina')).toHaveCount(0)
    await expect(estacion.getByRole('button', { name: 'barra' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await estacion.getByRole('button', { name: 'cocina' }).click()
    await expect(comanda(page, 4, 'cocina')).toBeVisible()
    await expect(comanda(page, 4, 'barra')).toHaveCount(0)
    await estacion.getByRole('button', { name: 'todas' }).click()
    await expect(comanda(page, 4, 'barra')).toBeVisible()
  })

  test('tocar un ítem lo marca listo y tocarlo de nuevo lo desmarca', async ({ page }) => {
    await page.goto('/bocetos/kds')
    const item = comanda(page, 21, 'cocina').getByRole('button', { name: /Pinsa/ })
    await expect(item).toHaveAttribute('aria-pressed', 'false')
    await expect(item).toContainText('pendiente')
    await item.click()
    await expect(item).toHaveAttribute('aria-pressed', 'true')
    await expect(item).toContainText('listo')
    await item.click()
    await expect(item).toHaveAttribute('aria-pressed', 'false')
  })

  test('«Todo listo» despacha la comanda; Deshacer la devuelve con los ítems marcados', async ({
    page,
  }) => {
    await congelarReloj(page)
    await page.goto('/bocetos/kds')
    const tarjeta = comanda(page, 21, 'cocina')
    await tarjeta.getByRole('button', { name: /Pinsa/ }).click()
    await tarjeta.getByRole('button', { name: 'Todo listo' }).click()

    await expect(aviso(page, 'Mesa 21 despachada (cocina)')).toBeVisible()
    await expect(comanda(page, 21, 'cocina')).toHaveCount(0)
    await expect(comanda(page, 21, 'barra')).toBeVisible() // la otra estación sigue pendiente

    await deshacer(page, 'Mesa 21 despachada (cocina)').click()
    await expect(comanda(page, 21, 'cocina')).toBeVisible()
    await expect(
      comanda(page, 21, 'cocina').getByRole('button', { name: /Pinsa/ }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  test('despachar todo lo de una mesa la deja «Listo para servir» en el plano', async ({
    page,
  }) => {
    await page.goto('/bocetos/kds')
    await comanda(page, 21, 'cocina').getByRole('button', { name: 'Todo listo' }).click()
    // Con una estación pendiente, la mesa sigue en preparación.
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(mesaEnPlano(page, 21)).toHaveAccessibleName(/^Mesa 21: En preparación/)

    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Cocina y barra/ }).click()
    await comanda(page, 21, 'barra').getByRole('button', { name: 'Todo listo' }).click()
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(mesaEnPlano(page, 21)).toHaveAccessibleName(/^Mesa 21: Listo para servir, /)
    await expect(page.getByText('2 para servir')).toBeVisible()
  })

  test('deshacer el último despacho vuelve la mesa a «En preparación»', async ({ page }) => {
    await congelarReloj(page)
    await page.goto('/bocetos/kds')
    await comanda(page, 21, 'cocina').getByRole('button', { name: 'Todo listo' }).click()
    await comanda(page, 21, 'barra').getByRole('button', { name: 'Todo listo' }).click()
    await deshacer(page, 'Mesa 21 despachada (barra)').click()
    await irA(page, '/bocetos/plano')
    await expect(mesaEnPlano(page, 21)).toHaveAccessibleName(/^Mesa 21: En preparación/)
    await irA(page, '/bocetos/kds')
    await expect(comanda(page, 21, 'barra')).toBeVisible()
    await expect(comanda(page, 21, 'cocina')).toHaveCount(0)
  })

  test('despachar todas las comandas deja el mensaje de que no hay pendientes', async ({
    page,
  }) => {
    await page.goto('/bocetos/kds')
    for (const [mesa, estacion] of [
      [7, 'cocina'],
      [7, 'barra'],
      [4, 'cocina'],
      [4, 'barra'],
      [21, 'cocina'],
      [21, 'barra'],
    ] as const)
      await comanda(page, mesa, estacion).getByRole('button', { name: 'Todo listo' }).click()
    await expect(page.getByText('No hay comandas pendientes.')).toBeVisible()
  })

  test('despachar la estación filtrada no afecta a la otra', async ({ page }) => {
    await page.goto('/bocetos/kds')
    const estacion = page.getByRole('group', { name: 'Estación' })
    await estacion.getByRole('button', { name: 'barra' }).click()
    await comanda(page, 4, 'barra').getByRole('button', { name: 'Todo listo' }).click()
    await estacion.getByRole('button', { name: 'todas' }).click()
    await expect(comanda(page, 4, 'barra')).toHaveCount(0)
    await expect(comanda(page, 4, 'cocina')).toBeVisible()
  })

  test('las opciones y las notas de la mesa de ejemplo llegan a la cocina', async ({ page }) => {
    await page.goto('/bocetos/kds')
    await expect(comanda(page, 7, 'cocina').getByText('Medio')).toBeVisible()
    await expect(comanda(page, 7, 'cocina').getByText('¡Sin cebolla!')).toBeVisible()
  })

  test('«Todo listo» cambia a éxito solo cuando todos los ítems están marcados', async ({
    page,
  }) => {
    await page.goto('/bocetos/kds')
    const tarjeta = comanda(page, 21, 'barra')
    const todo = tarjeta.getByRole('button', { name: 'Todo listo' })
    const antes = await todo.getAttribute('class')
    await tarjeta.getByRole('button', { name: /Limonada/ }).click()
    expect(await todo.getAttribute('class')).not.toBe(antes)
  })
})

// ---------------------------------------------------------------------------------------------
// Teclado del PIN
// ---------------------------------------------------------------------------------------------

test.describe('teclado del PIN (PIN de prueba 2468)', () => {
  const tecla = (page: Page, d: string) => page.getByRole('button', { name: d, exact: true })
  const escribir = async (page: Page, pin: string) => {
    for (const d of pin) await tecla(page, d).click()
  }
  const digitos = (page: Page) => page.getByText(/^\d de 4 dígitos$/)
  const borrar = (page: Page) => page.getByRole('button', { name: 'Borrar el último dígito' })
  const alerta = (page: Page) => page.getByRole('alert')

  test.beforeEach(async ({ page }) => {
    await congelarReloj(page)
  })

  test('el PIN correcto entra al cuarto dígito, sin tocar «aceptar», y se envía una sola vez', async ({
    page,
  }) => {
    await page.goto('/bocetos/componentes')
    await escribir(page, '2468')
    await expect(aviso(page, 'Hola, Mesero 1')).toHaveCount(1)
    await expect(alerta(page)).toHaveText('')
    await expect(digitos(page)).toHaveText('0 de 4 dígitos') // queda listo para el siguiente
  })

  test('muestra cuántos dígitos van y borra de a uno', async ({ page }) => {
    await page.goto('/bocetos/componentes')
    await expect(digitos(page)).toHaveText('0 de 4 dígitos')
    await expect(borrar(page)).toBeDisabled()
    await escribir(page, '24')
    await expect(digitos(page)).toHaveText('2 de 4 dígitos')
    await borrar(page).click()
    await expect(digitos(page)).toHaveText('1 de 4 dígitos')
    await escribir(page, '468')
    await expect(aviso(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('también acepta el teclado físico de la caja, con Backspace; ignora lo que no es dígito', async ({
    page,
  }) => {
    await page.goto('/bocetos/componentes')
    await expect(digitos(page)).toBeVisible() // la pantalla se carga aparte
    await page.keyboard.press('2')
    await page.keyboard.press('9')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('4')
    await page.keyboard.press('6')
    await page.keyboard.press('a')
    await page.keyboard.press('Control+7')
    await expect(digitos(page)).toHaveText('3 de 4 dígitos')
    await page.keyboard.press('8')
    await expect(aviso(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('un PIN errado avisa y deja el teclado vacío y listo para otro intento', async ({
    page,
  }) => {
    await page.goto('/bocetos/componentes')
    await escribir(page, '1111')
    await expect(alerta(page)).toHaveText('PIN incorrecto')
    await expect(digitos(page)).toHaveText('0 de 4 dígitos')
    await escribir(page, '2468')
    await expect(aviso(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('dos PIN errados iguales seguidos: el teclado queda vacío y listo cada vez', async ({
    page,
  }) => {
    await page.goto('/bocetos/componentes')
    await escribir(page, '1111')
    await expect(digitos(page)).toHaveText('0 de 4 dígitos')
    await escribir(page, '1111')
    await expect(alerta(page)).toHaveText('PIN incorrecto')
    await expect(digitos(page)).toHaveText('0 de 4 dígitos')
    await escribir(page, '2468')
    await expect(aviso(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('tres errores seguidos hacen esperar 2 s; el teclado se bloquea y se libera con el tiempo', async ({
    page,
  }) => {
    await page.goto('/bocetos/componentes')
    for (let i = 0; i < 3; i++) await escribir(page, '1111')
    await expect(alerta(page)).toHaveText('Demasiados intentos.')
    await expect(page.getByText('Espera 2 s')).toBeVisible()
    await expect(tecla(page, '5')).toBeDisabled()
    await expect(borrar(page)).toBeDisabled()

    // Ni los toques ni el teclado físico entran durante la espera.
    await page.keyboard.press('2')
    await expect(digitos(page)).toHaveText('0 de 4 dígitos')

    await page.clock.runFor(1_000)
    await expect(page.getByText('Espera 1 s')).toBeVisible()
    await page.clock.runFor(1_500)
    await expect(tecla(page, '5')).toBeEnabled()
    await expect(alerta(page)).not.toContainText('Demasiados intentos')

    await escribir(page, '2468')
    await expect(aviso(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('el cuarto error espera el doble (4 s)', async ({ page }) => {
    await page.goto('/bocetos/componentes')
    for (let i = 0; i < 3; i++) await escribir(page, '1111')
    await page.clock.runFor(2_500)
    await escribir(page, '1111')
    await expect(page.getByText('Espera 4 s')).toBeVisible()
  })

  test('el PIN correcto en plena espera no entra', async ({ page }) => {
    await page.goto('/bocetos/componentes')
    for (let i = 0; i < 3; i++) await escribir(page, '1111')
    await expect(tecla(page, '2')).toBeDisabled()
    await page.keyboard.type('2468')
    await expect(aviso(page, 'Hola, Mesero 1')).toHaveCount(0)
  })

  test('después de entrar bien, el contador de errores empieza de cero', async ({ page }) => {
    await page.goto('/bocetos/componentes')
    for (let i = 0; i < 3; i++) await escribir(page, '1111')
    await page.clock.runFor(2_500)
    await escribir(page, '2468')
    await expect(aviso(page, 'Hola, Mesero 1')).toHaveCount(1)

    // Un solo error nuevo es el primero de una racha nueva: no debe hacer esperar.
    await escribir(page, '3333')
    await expect(alerta(page)).toHaveText('PIN incorrecto')
    await expect(tecla(page, '5')).toBeEnabled()
  })

  test('el PIN no queda escrito en pantalla: solo puntos', async ({ page }) => {
    await page.goto('/bocetos/componentes')
    await escribir(page, '13')
    await expect(page.getByText('13', { exact: true })).toHaveCount(0)
    await expect(digitos(page)).toHaveText('2 de 4 dígitos')
  })
})
