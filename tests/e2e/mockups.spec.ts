/// <reference lib="dom" />
import { expect, type Locator, type Page, test } from '@playwright/test'

// Criteria for task 0.9 (design system and mockups), on an Android phone and on the register.
// The mockups' state lives in page memory: each test starts with the sample data, and to keep
// it across screens navigation is done with taps, never with `page.goto`.
// Notices and times depend on the clock: the tests that look at them freeze it.

const isRegister = (projectName: string) => projectName === 'register'

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * Controlled page clock: starts at a fixed time and is moved forward with `page.clock.runFor`
 * (notices and table minutes depend on it). It keeps running in real time, so
 * the tests that use it must not take more than 5 s between steps that look at a notice.
 */
async function freezeClock(page: Page) {
  await page.clock.install({ time: new Date('2026-10-24T12:00:00') })
}

/** Navigates within the app without reloading (keeps the mockups' in-memory state). */
const goTo = (page: Page, route: string) =>
  page.evaluate((r) => {
    history.pushState(null, '', r)
    window.dispatchEvent(new Event('pos-navigate'))
  }, route)

/** Visible tappable elements smaller than 48×48 px (a checkbox counts by its label). */
async function smallSizes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const MINIMUM = 48
    const description = (el: Element) =>
      `${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}]`
    const issues: string[] = []
    const candidates = document.querySelectorAll(
      'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"]',
    )
    for (const el of candidates) {
      let measured: Element = el
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
        measured = el.closest('label') ?? el
      const style = getComputedStyle(measured)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      if (el.closest('[hidden], [aria-hidden="true"]')) continue
      const r = measured.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.width < MINIMUM - 0.5 || r.height < MINIMUM - 0.5)
        issues.push(`${description(el)} measures ${Math.round(r.width)}×${Math.round(r.height)}`)
    }
    return issues
  })
}

/**
 * Visible text with contrast below AA (4.5:1; 3:1 if large), with the actual background and opacity
 * the browser paints. Ignores disabled elements (WCAG exempts them).
 */
async function insufficientContrast(page: Page): Promise<string[]> {
  // Transitions (e.g. the opacity of a button going from disabled to enabled) must
  // finish: halfway through one, the measured colors are not the final ones.
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
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
    const toRgba = (css: string): Rgba => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255]
    }
    const envelope = (f: Rgba, background: Rgba): Rgba => {
      const a = f[3] + background[3] * (1 - f[3])
      if (a === 0) return [0, 0, 0, 0]
      const mix = (i: 0 | 1 | 2) => (f[i] * f[3] + background[i] * background[3] * (1 - f[3])) / a
      return [mix(0), mix(1), mix(2), a]
    }
    const lum = (c: Rgba) => {
      const k = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * k(c[0]) + 0.7152 * k(c[1]) + 0.0722 * k(c[2])
    }
    const backgroundOf = (el: Element): Rgba => {
      const layers: Rgba[] = []
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = toRgba(getComputedStyle(e).backgroundColor)
        if (c[3] > 0) layers.push(c)
        if (c[3] === 1) break
      }
      let accumulated: Rgba = [255, 255, 255, 1]
      for (const layer of layers.reverse()) accumulated = envelope(layer, accumulated)
      return accumulated
    }
    const issues: string[] = []
    const seenSet = new Set<string>()
    for (const el of document.body.querySelectorAll('*')) {
      if (el instanceof SVGElement) continue
      const own = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
      )
      if (!own) continue
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const r = el.getBoundingClientRect()
      if (r.width <= 1 || r.height <= 1) continue // sr-only
      if (el.closest('button:disabled, fieldset:disabled, [aria-disabled="true"]')) continue
      let opacity = 1
      for (let e: Element | null = el; e; e = e.parentElement)
        opacity *= Number(getComputedStyle(e).opacity)
      const background = backgroundOf(el)
      const text = toRgba(style.color)
      text[3] *= opacity
      const seen = envelope(text, background)
      const [a, b] = [lum(seen), lum(background)].sort((x, y) => y - x) as [number, number]
      const ratio = (a + 0.05) / (b + 0.05)
      const px = Number.parseFloat(style.fontSize)
      const large = px >= 24 || (px >= 18.66 && Number(style.fontWeight) >= 700)
      if (ratio < (large ? 3 : 4.5)) {
        const name = (el.textContent ?? '').trim().slice(0, 30)
        const key = `${name}|${style.color}|${style.backgroundColor}`
        if (seenSet.has(key)) continue
        seenSet.add(key)
        issues.push(`«${name}» contrast ${ratio.toFixed(2)} (${large ? 'large' : 'normal'})`)
      }
    }
    return issues
  })
}

const getBackgroundColor = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor)
const getTextColor = (page: Page) => page.evaluate(() => getComputedStyle(document.body).color)
const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'))

/** Money as the UI writes it: 257500 → $257.500. Independent of the production code. */
const inPesos = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`

const numberOf = (text: string) => Number(text.replace(/\D/g, ''))

/** Round half up with exact integers (DINERO.md, principle 3). */
function expectedTip(balance: number, rateBp = 800, tipRateBp = 1000): number {
  const a = BigInt(balance) * 10000n * BigInt(tipRateBp)
  const b = BigInt(10000 + rateBp) * 10000n
  return Number((2n * a + b) / (2n * b))
}

/** Largest remainder allocation (DINERO.md, principle 4), with ties broken by order. */
function largestRemainderAllocation(total: number, pesos: number[]): number[] {
  const sum = pesos.reduce((a, b) => a + b, 0)
  const base = pesos.map((p) => Math.floor((total * p) / sum))
  const rest = pesos
    .map((p, i) => ({ i, r: (total * p) % sum }))
    .sort((x, y) => y.r - x.r || x.i - y.i)
  let missingOnes = total - base.reduce((a, b) => a + b, 0)
  for (const { i } of rest) {
    if (missingOnes <= 0) break
    base[i] = (base[i] as number) + 1
    missingOnes--
  }
  return base
}

/** From the floor plan: the table by its number (the accessible name starts with «Mesa N:»). */
const tableOnFloorPlan = (page: Page, number: number) =>
  page.getByRole('button', { name: new RegExp(`^Mesa ${number}: `) })

const tableInList = (page: Page, number: number) =>
  page
    .locator('section[aria-label="Mesas"] ul > li')
    .filter({ hasText: new RegExp(`^${number}(?!\\d)`) })
    .getByRole('button')

const searchMenu = (page: Page) => page.getByRole('searchbox', { name: 'Buscar en la carta' })
/** A product card on the menu (its accessible name also includes the price and quantity). */
const product = (page: Page, name: string) =>
  page.getByRole('region', { name: 'Carta' }).getByRole('button', { name: name }).first()

const send = (page: Page, quantity?: number) =>
  page.getByRole('button', { name: quantity ? `Enviar ${quantity}` : 'Enviar', exact: true })

/** The notice (toast) containing the text, and its Deshacer button. */
const alert = (page: Page, text: string | RegExp) =>
  page.locator('[aria-live="polite"] > div').filter({ hasText: text })
const undo = (page: Page, text: string | RegExp) =>
  alert(page, text).getByRole('button', { name: 'Deshacer' })

/** The order ticket: on the register it is the fixed column; on the phone, the «Pedido» panel. */
async function openTicket(page: Page, register: boolean): Promise<Locator> {
  if (register) return page.locator('aside')
  const panel = page.getByRole('dialog', { name: /^Pedido · Mesa/ })
  if (!(await panel.isVisible())) await page.getByRole('button', { name: /^Pedido \(/ }).click()
  await expect(panel).toBeVisible()
  return panel
}
async function closeTicket(page: Page, register: boolean) {
  if (register) return
  const panel = page.getByRole('dialog', { name: /^Pedido · Mesa/ })
  if (await panel.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
  }
}
const ticketNames = (ticket: Locator) =>
  ticket
    .locator('ul > li button span.flex-1 > span.font-semibold')
    .evaluateAll((els) => els.map((e) => e.textContent ?? ''))

/** The card of a KDS ticket (table and station). */
const ticketEl = (page: Page, table: number, station: 'cocina' | 'barra') =>
  page.getByRole('listitem').filter({ hasText: new RegExp(`^Mesa ${table}(?!\\d).* · ${station}`) })

// ---------------------------------------------------------------------------------------------
// 48×48 px touch size
// ---------------------------------------------------------------------------------------------

const SCREENS = [
  { name: 'index', route: '/mockups' },
  { name: 'floor plan', route: '/mockups/floor-plan' },
  { name: 'order', route: '/mockups/order?table=2' },
  { name: 'KDS', route: '/mockups/kds' },
  { name: 'pre-bill', route: '/mockups/pre-bill?table=12' },
  { name: 'checkout', route: '/mockups/checkout?table=12' },
  { name: 'components', route: '/mockups/components' },
]

test.describe('48×48 px touch size', () => {
  for (const { name, route } of SCREENS) {
    test(`${name}: every button, link and field is at least 48×48`, async ({ page }) => {
      await page.goto(route)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await smallSizes(page)).toEqual([])
    })
  }

  test('app start (sign in): everything is at least 48×48', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Escribe tu PIN' })).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
  })

  test('index with the chosen simulations', async ({ page }) => {
    await page.goto('/mockups')
    await page.getByRole('button', { name: 'Sin conexión' }).click()
    await page.getByRole('button', { name: 'Impresora de barra caída' }).click()
    expect(await smallSizes(page)).toEqual([])
  })

  test('floor plan in list view and with the Deshacer notice visible', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await page.getByRole('button', { name: 'Lista' }).click()
    await tableInList(page, 18).click()
    await expect(undo(page, 'Mesa 18 lista para usar')).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
  })

  test('order with the options panel, the item panel and the void panel open', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=2')
    await searchMenu(page).fill('tagliata')
    await product(page, 'Tagliata di Manzo').click()
    await expect(page.getByRole('dialog', { name: 'Tagliata di Manzo' })).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
    await page.keyboard.press('Escape')
    const ticket = await openTicket(page, register)
    await ticket.getByRole('button', { name: /Aperol Spritz/ }).click()
    await expect(page.getByRole('dialog', { name: 'Aperol Spritz' })).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
    await page.keyboard.press('Escape')
    await closeTicket(page, register)

    await page.goto('/mockups/order?table=7')
    const ticket7 = await openTicket(page, register)
    await ticket7.getByRole('button', { name: /Spritz Burguer/ }).click()
    await expect(page.getByRole('dialog', { name: 'Anular Spritz Burguer' })).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
  })

  test('pre-bill split into equal parts and by items', async ({ page }) => {
    await page.goto('/mockups/pre-bill?table=12')
    await page.getByRole('button', { name: 'Partes iguales' }).click()
    expect(await smallSizes(page)).toEqual([])
    await page.getByRole('button', { name: 'Por ítems' }).click()
    await expect(page.getByRole('group', { name: 'Quién paga Quattro Formaggi' })).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
  })

  test('card checkout, with the confirmation and with the table paid', async ({ page }) => {
    await page.goto('/mockups/checkout?table=12')
    await page.getByRole('button', { name: /^Tarjeta/ }).click()
    await page.getByLabel('Número de aprobación').fill('123456')
    expect(await smallSizes(page)).toEqual([])
    await page.getByRole('button', { name: /^Cobrar/ }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
    await page.getByRole('button', { name: 'Confirmar' }).click()
    await expect(page.getByRole('button', { name: 'Volver al salón' })).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
  })

  test('KDS with a ticket marked and the dispatch notice', async ({ page }) => {
    await page.goto('/mockups/kds')
    const card = ticketEl(page, 21, 'cocina')
    await card.getByRole('button', { name: /Pinsa/ }).click()
    await card.getByRole('button', { name: 'Todo listo' }).click()
    await expect(undo(page, 'Mesa 21 despachada')).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
  })

  test('components with the side panel open', async ({ page }) => {
    await page.goto('/mockups/components')
    await page.getByRole('button', { name: 'Abrir panel lateral' }).click()
    await expect(page.getByRole('dialog', { name: 'Panel lateral' })).toBeVisible()
    expect(await smallSizes(page)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------------------------

test.describe('AA contrast in light and dark', () => {
  for (const schema of ['light', 'dark'] as const) {
    for (const { name, route } of SCREENS) {
      test(`${name} with the system in ${schema === 'dark' ? 'dark' : 'light'}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: schema })
        await page.goto(route)
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        expect(await isDark(page)).toBe(schema === 'dark')
        expect(await insufficientContrast(page)).toEqual([])
      })
    }
  }

  for (const schema of ['light', 'dark'] as const) {
    test(`color states of checkout, pre-bill and KDS with the system in ${schema}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: schema })
      await page.goto('/mockups/checkout?table=12')
      await page.getByRole('button', { name: '100 mil' }).click()
      await expect(page.getByText('Faltan $181.300')).toBeVisible()
      expect(await insufficientContrast(page)).toEqual([])
      await page.getByLabel('El cliente entrega').fill('300000')
      await expect(page.getByText('Cambio $18.700')).toBeVisible()
      expect(await insufficientContrast(page)).toEqual([])
      await page.keyboard.press('Enter')
      await expect(page.getByRole('alertdialog')).toBeVisible()
      expect(await insufficientContrast(page)).toEqual([])

      await goTo(page, '/mockups/pre-bill?table=12')
      await page.getByRole('button', { name: 'Por ítems' }).click()
      expect(await insufficientContrast(page)).toEqual([])
      await page.getByRole('button', { name: 'Partes iguales' }).click()
      expect(await insufficientContrast(page)).toEqual([])

      await goTo(page, '/mockups/kds')
      await ticketEl(page, 21, 'cocina').getByRole('button', { name: /Pinsa/ }).click()
      expect(await insufficientContrast(page)).toEqual([])
    })
  }

  test('index with the connection down and the printer failing, in dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/mockups')
    await page.getByRole('button', { name: 'Sin conexión' }).click()
    await page.getByRole('button', { name: 'Impresora de barra caída' }).click()
    await expect(page.getByText('3 sin confirmar')).toBeVisible()
    expect(await insufficientContrast(page)).toEqual([])
  })

  test('order with a product in the order, panel and notice, in light and dark', async ({
    page,
  }) => {
    for (const schema of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: schema })
      await page.goto('/mockups/order?table=2')
      await product(page, 'Pinsa').click()
      await expect(alert(page, 'Agregaste Pinsa')).toBeVisible()
      expect(await insufficientContrast(page)).toEqual([])
      await searchMenu(page).fill('tagliata')
      await product(page, 'Tagliata di Manzo').click()
      await expect(page.getByRole('dialog', { name: 'Tagliata di Manzo' })).toBeVisible()
      expect(await insufficientContrast(page)).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Dark mode
// ---------------------------------------------------------------------------------------------

test.describe('dark mode', () => {
  test.use({ colorScheme: 'light' })
  // Exact: the Bagno brand card also mentions dark mode in its description.
  const button = (page: Page) => page.getByRole('button', { name: 'Modo oscuro', exact: true })

  test('changes the colors and persists after reloading', async ({ page }) => {
    await page.goto('/mockups/components')
    expect(await isDark(page)).toBe(false)
    await expect(button(page)).toHaveAttribute('aria-pressed', 'false')
    const lightBackground = await getBackgroundColor(page)
    const lightText = await getTextColor(page)

    await button(page).click()
    expect(await isDark(page)).toBe(true)
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
    expect(await getBackgroundColor(page)).not.toBe(lightBackground)
    expect(await getTextColor(page)).not.toBe(lightText)
    const darkBackground = await getBackgroundColor(page)

    await page.reload()
    expect(await isDark(page)).toBe(true)
    expect(await getBackgroundColor(page)).toBe(darkBackground)
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
  })

  test('dark mode is set before the app starts (no white flash)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pos-theme', 'dark'))
    // With the app not running (React JavaScript blocked), the HTML already has the class.
    await page.route('**/*.js', (route) => route.abort())
    await page.goto('/mockups', { waitUntil: 'domcontentloaded' })
    expect(await isDark(page)).toBe(true)
  })

  test('persists when going to another screen and when reopening the app', async ({ page }) => {
    await page.goto('/mockups')
    await button(page).click()
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(page).toHaveURL(/\/mockups\/floor-plan$/)
    expect(await isDark(page)).toBe(true)
    await page.goto('/')
    expect(await isDark(page)).toBe(true)
  })

  test('switching back to light mode is remembered too', async ({ page }) => {
    await page.goto('/mockups')
    await button(page).click()
    await button(page).click()
    expect(await isDark(page)).toBe(false)
    await page.reload()
    expect(await isDark(page)).toBe(false)
  })

  test('the choice wins over the system, and without a choice the system is followed', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/mockups')
    expect(await isDark(page)).toBe(true)
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
    await button(page).click() // chooses light
    expect(await isDark(page)).toBe(false)
    await page.reload()
    expect(await isDark(page)).toBe(false)
  })

  test('without a choice, a system change applies without reloading', async ({ page }) => {
    await page.goto('/mockups')
    expect(await isDark(page)).toBe(false)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => isDark(page)).toBe(true)
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => isDark(page)).toBe(false)
  })

  test('without storage available it does not break and works in the open page', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError')
        },
      })
    })
    await page.goto('/mockups')
    await button(page).click()
    expect(await isDark(page)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Frame: title and focus when changing screens; simulated connection
// ---------------------------------------------------------------------------------------------

test.describe('screen frame', () => {
  test('each screen sets its title on the tab and the focus on its heading', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await expect(page).toHaveTitle('Salón · POS')
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
    await tableOnFloorPlan(page, 3).click()
    await expect(page).toHaveTitle('Mesa 3 · POS')
    await expect(page.getByRole('heading', { level: 1, name: 'Mesa 3' })).toBeFocused()
  })

  test('«Solo red local» is the normal state: shown in gray, with text and icon', async ({
    page,
  }) => {
    await page.goto('/mockups/floor-plan')
    const status = page.getByRole('status')
    await expect(status).toContainText('Solo red local')
    await expect(status.locator('span.rounded-full').first()).toHaveClass(/neutro/)
    await expect(status.locator('svg')).toHaveCount(1)
  })

  test('the index simulates the connection and the printer and the other screens show it', async ({
    page,
  }) => {
    await page.goto('/mockups')
    await page.getByRole('button', { name: 'En línea' }).click()
    await expect(page.getByRole('status')).toContainText('En línea')
    await page.getByRole('button', { name: 'Sin conexión' }).click()
    await expect(page.getByRole('status')).toContainText('Sin conexión')
    await expect(page.getByRole('status')).toContainText('3 sin confirmar')
    await page.getByRole('button', { name: 'Impresora de barra caída' }).click()
    await expect(page.getByRole('status')).toContainText('Una impresora no responde')

    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(page.getByRole('status')).toContainText('Sin conexión')
    await expect(page.getByRole('status')).toContainText('3 sin confirmar')
    await expect(page.getByRole('status')).toContainText('Una impresora no responde')

    // Back to «Solo red local» clears the pending ones; the printer stays flagged until turned off.
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('button', { name: 'Solo red local' }).click()
    await expect(page.getByRole('status')).not.toContainText('sin confirmar')
    await page.getByRole('button', { name: 'Impresora de barra caída' }).click()
    await expect(page.getByRole('status')).not.toContainText('impresora')
  })

  test('«Volver a los datos de ejemplo» resets the tables', async ({ page }) => {
    await page.goto('/mockups')
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await tableOnFloorPlan(page, 18).click() // makes it free
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('button', { name: 'Volver a los datos de ejemplo' }).click()
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(tableOnFloorPlan(page, 18)).toHaveAccessibleName(/^Mesa 18: Por limpiar/)
  })
})

// ---------------------------------------------------------------------------------------------
// Floor plan
// ---------------------------------------------------------------------------------------------

test.describe('table floor plan', () => {
  test('shows each table status with text, not only with color', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await expect(tableOnFloorPlan(page, 1)).toHaveAccessibleName(/^Mesa 1: Libre$/)
    await expect(tableOnFloorPlan(page, 2)).toHaveAccessibleName(
      /^Mesa 2: Tomando pedido, 3 min, \$61\.800$/,
    )
    await expect(tableOnFloorPlan(page, 4)).toHaveAccessibleName(
      /^Mesa 4: En preparación, 18 min, /,
    )
    await expect(tableOnFloorPlan(page, 9)).toHaveAccessibleName(/^Mesa 9: Listo para servir, /)
    await expect(tableOnFloorPlan(page, 12)).toHaveAccessibleName(
      /^Mesa 12: Por cobrar, 1 h 0[45], \$257\.500$/,
    )
    await expect(tableOnFloorPlan(page, 15)).toHaveAccessibleName(/^Mesa 15: Reservada$/)
    await expect(tableOnFloorPlan(page, 18)).toHaveAccessibleName(/^Mesa 18: Por limpiar$/)
  })

  test('the delay is counted from the oldest ticket: 27 min is a delay; 6 and 12 are not', async ({
    page,
  }) => {
    await page.goto('/mockups/floor-plan')
    await expect(tableOnFloorPlan(page, 7)).toHaveAccessibleName(/^Mesa 7: Demora, 3[5-6] min, /)
    await expect(tableOnFloorPlan(page, 21)).toHaveAccessibleName(/^Mesa 21: En preparación, /)
    await expect(tableOnFloorPlan(page, 4)).toHaveAccessibleName(/^Mesa 4: En preparación, /)
  })

  test('the free one has a circle icon and text, and is white', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    const free = tableOnFloorPlan(page, 1)
    await expect(free).toContainText('Libre')
    await expect(free.locator('svg')).toHaveCount(1)
    await expect(free).toHaveClass(/bg-surface/)
  })

  test('the summary counts tables by status', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    // 25 tables: 8 with a status (2, 4, 7, 9, 12, 15, 18, 21) → 17 free
    await expect(page.getByText('17 libres')).toBeVisible()
    await expect(page.getByText('4 atendiendo')).toBeVisible()
    await expect(page.getByText('1 para servir')).toBeVisible()
    await expect(page.getByText('1 por cobrar')).toBeVisible()
  })

  test('tapping a free table opens the order WITHOUT occupying it: on return it is still free', async ({
    page,
  }) => {
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 3).click()
    await expect(page.getByRole('heading', { name: 'Mesa 3', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(tableOnFloorPlan(page, 3)).toHaveAccessibleName(/^Mesa 3: Libre$/)
    await expect(page.getByText('17 libres')).toBeVisible()
  })

  test('the table becomes occupied when the first product is added', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 3).click()
    await product(page, 'Pinsa').click()
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(tableOnFloorPlan(page, 3)).toHaveAccessibleName(
      /^Mesa 3: Tomando pedido, 0 min, \$20\.900$/,
    )
  })

  test('tapping a table to clean resets it and can be undone', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 18).click()
    await expect(tableOnFloorPlan(page, 18)).toHaveAccessibleName(/^Mesa 18: Libre$/)
    await expect(alert(page, 'Mesa 18 lista para usar')).toBeVisible()
    await undo(page, 'Mesa 18 lista para usar').click()
    await expect(tableOnFloorPlan(page, 18)).toHaveAccessibleName(/^Mesa 18: Por limpiar$/)
  })

  test('tapping a table to charge opens its pre-bill', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 12).click()
    await expect(page).toHaveURL(/\/mockups\/pre-bill\?table=12$/)
    await expect(page.getByRole('heading', { name: 'Precuenta · Mesa 12' })).toBeVisible()
  })

  test('tapping a reserved table opens the order and it stays reserved until something is added', async ({
    page,
  }) => {
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 15).click()
    await expect(page).toHaveURL(/\/mockups\/order\?table=15$/)
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(tableOnFloorPlan(page, 15)).toHaveAccessibleName(/^Mesa 15: Reservada$/)
  })

  test('«Cuentas abiertas» appears from 768 px (register) with each table balance', async ({
    page,
  }, info) => {
    await page.goto('/mockups/floor-plan')
    const checks = page.getByRole('complementary', { name: 'Cuentas abiertas' })
    if (isRegister(info.project.name)) {
      await expect(checks).toBeVisible()
      for (const n of [2, 4, 7, 9, 12, 21])
        await expect(
          checks.getByRole('button', { name: new RegExp(`^Mesa ${n}\\b`) }),
        ).toBeVisible()
      await expect(checks.getByRole('button', { name: /^Mesa 12\b/ })).toContainText('$257.500')
      await expect(checks.getByRole('button', { name: /^Mesa 7\b/ })).toContainText('Demora')
    } else {
      await expect(checks).toBeHidden()
    }
  })

  test('«Cuentas abiertas» also appears on a 768 px tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/mockups/floor-plan')
    await expect(page.getByRole('complementary', { name: 'Cuentas abiertas' })).toBeVisible()
    await page.setViewportSize({ width: 767, height: 1024 })
    await expect(page.getByRole('complementary', { name: 'Cuentas abiertas' })).toBeHidden()
  })

  test('list view and floor plan view toggle', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await page.getByRole('button', { name: 'Lista' }).click()
    await expect(page.getByRole('button', { name: 'Plano' })).toBeVisible()
    await expect(page.getByText('Tomando pedido').first()).toBeVisible()
    await page.getByRole('button', { name: 'Plano' }).click()
    await expect(tableOnFloorPlan(page, 1)).toBeVisible()
  })
})

// ---------------------------------------------------------------------------------------------
// Order in 3 taps
// ---------------------------------------------------------------------------------------------

test.describe('order in 3 taps', () => {
  test('free table → product without options → Enviar, and the table is in preparation and on the KDS', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __taps: number }
      w.__taps = 0
      document.addEventListener(
        'click',
        () => {
          w.__taps += 1
        },
        true,
      )
    })
    await page.goto('/mockups/floor-plan')
    await expect(tableOnFloorPlan(page, 1)).toBeVisible()
    await page.evaluate(() => {
      ;(window as unknown as { __taps: number }).__taps = 0
    })

    await tableOnFloorPlan(page, 1).click() // tap 1
    await expect(page.getByRole('heading', { name: 'Mesa 1', exact: true })).toBeVisible()
    await product(page, 'Pinsa').click() // tap 2
    await expect(alert(page, 'Agregaste Pinsa')).toBeVisible()
    await send(page, 1).click() // tap 3

    await expect(page).toHaveURL(/\/mockups\/floor-plan$/)
    expect(await page.evaluate(() => (window as unknown as { __taps: number }).__taps)).toBe(3)
    await expect(page.getByRole('dialog')).toHaveCount(0) // no options: no panel

    await expect(tableOnFloorPlan(page, 1)).toHaveAccessibleName(
      /^Mesa 1: En preparación, 0 min, \$20\.900$/,
    )

    // And it shows up in the kitchen, without reloading.
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Cocina y barra/ }).click()
    const card = ticketEl(page, 1, 'cocina')
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: /Pinsa/ })).toBeVisible()
    await expect(card).toContainText('0 min')
    await expect(card).toContainText('a tiempo')
    await expect(ticketEl(page, 1, 'barra')).toHaveCount(0)
  })

  test('Enviar is disabled while there is nothing to send', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 1).click()
    await expect(send(page)).toBeDisabled()
  })

  test('food and drink: one ticket in the kitchen and another at the bar', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 1).click()
    await product(page, 'Pinsa').click()
    await searchMenu(page).fill('limonada de coco')
    await product(page, 'Limonada de Coco').click()
    await send(page, 2).click()
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Cocina y barra/ }).click()
    await expect(ticketEl(page, 1, 'cocina').getByRole('button', { name: /Pinsa/ })).toBeVisible()
    await expect(
      ticketEl(page, 1, 'barra').getByRole('button', { name: /Limonada de Coco/ }),
    ).toBeVisible()
  })

  test('a second round sends only what is new', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 1).click()
    await product(page, 'Pinsa').click()
    await send(page, 1).click()
    await tableOnFloorPlan(page, 1).click()
    await expect(page.getByRole('heading', { name: 'Mesa 1', exact: true })).toBeVisible()
    await expect(send(page)).toBeDisabled()
    await product(page, 'Tentazione di Formaggio').click()
    await expect(send(page, 1)).toBeEnabled()
  })

  test('the same product adds to its line, the card shows the quantity and Deshacer subtracts', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await freezeClock(page)
    await page.goto('/mockups/order?table=2')
    await product(page, 'Pinsa').click()
    await expect(product(page, 'Pinsa')).toContainText('1 en el pedido')
    await product(page, 'Pinsa').click()
    await expect(product(page, 'Pinsa')).toContainText('2 en el pedido')
    await expect(alert(page, 'Pinsa: 2')).toBeVisible()

    let ticket = await openTicket(page, register)
    const pinsa = ticket.getByRole('listitem').filter({ hasText: 'Pinsa' })
    await expect(pinsa).toHaveCount(1) // a single line
    await expect(pinsa).toContainText('$41.800')
    await closeTicket(page, register)

    await undo(page, 'Pinsa: 2').click()
    await expect(product(page, 'Pinsa')).toContainText('1 en el pedido')
    ticket = await openTicket(page, register)
    await expect(ticket.getByRole('listitem').filter({ hasText: 'Pinsa' })).toContainText('$20.900')
  })

  test('the same product for another person or with another note is another line', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=2')
    await product(page, 'Pinsa').click() // for the table
    let ticket = await openTicket(page, register)
    await ticket.getByRole('button', { name: 'Para la persona 2' }).click()
    await closeTicket(page, register)
    await product(page, 'Pinsa').click() // for P2
    ticket = await openTicket(page, register)
    await expect(ticket.getByRole('listitem').filter({ hasText: 'Pinsa' })).toHaveCount(2)
    await expect(ticket).toContainText('P2 · sin enviar')
  })

  test('an item already sent is not added to: the same product opens a new line', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=21')
    await product(page, 'Pinsa').click()
    const ticket = await openTicket(page, register)
    const rows = ticket.getByRole('listitem').filter({ hasText: 'Pinsa' })
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('enviado')
    await expect(rows.last()).toContainText('sin enviar')
  })

  test('undoing the first product makes the table free again', async ({ page }) => {
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 3).click()
    await product(page, 'Pinsa').click()
    await undo(page, 'Agregaste Pinsa').click()
    await expect(send(page)).toBeDisabled()
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(tableOnFloorPlan(page, 3)).toHaveAccessibleName(/^Mesa 3: Libre$/)
  })

  test('«Cuenta» goes to the table pre-bill and is disabled without items', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=1')
    const ticket = await openTicket(page, register)
    await expect(ticket.getByRole('button', { name: 'Cuenta' })).toBeDisabled()
    await closeTicket(page, register)
    await product(page, 'Pinsa').click()
    const ticket2 = await openTicket(page, register)
    await ticket2.getByRole('button', { name: 'Cuenta' }).click()
    await expect(page).toHaveURL(/\/mockups\/pre-bill\?table=1$/)
    await expect(page.getByRole('button', { name: 'Cobrar $20.900' })).toBeVisible()
  })

  test('table people: when lowering the people count, «para quién» goes back to Mesa', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=2')
    const ticket = await openTicket(page, register)
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

  test('«/» goes to search, and typing «/» inside the field does not steal it', async ({
    page,
  }) => {
    await page.goto('/mockups/order?table=2')
    await expect(page.getByRole('heading', { name: 'Mesa 2', exact: true })).toBeVisible()
    await page.keyboard.press('/')
    await expect(searchMenu(page)).toBeFocused()
    await expect(searchMenu(page)).toHaveValue('')
    await page.keyboard.type('a/b')
    await expect(searchMenu(page)).toHaveValue('a/b')
  })
})

// ---------------------------------------------------------------------------------------------
// Options in a side panel
// ---------------------------------------------------------------------------------------------

test.describe('products with options', () => {
  test('Ramón Bilbao Crianza: Copa or Botella in a panel; tapping the variant adds it with its price', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=1')
    await searchMenu(page).fill('ramon bilbao crianza')
    const card = product(page, 'Ramón Bilbao Crianza')
    await expect(card).toContainText('desde $30.900')
    await card.click()

    const panel = page.getByRole('dialog', { name: 'Ramón Bilbao Crianza' })
    await expect(panel).toBeVisible()
    // Side panel: on the register docked to the right; on the phone sliding up from the bottom.
    const size = await panel.boundingBox()
    const consoleLines = page.viewportSize() as { width: number; height: number }
    expect(size).not.toBeNull()
    if (register) {
      expect((size?.x ?? 0) + (size?.width ?? 0)).toBeCloseTo(consoleLines.width, 0)
      expect(size?.width).toBeLessThan(consoleLines.width / 2)
    } else {
      expect((size?.y ?? 0) + (size?.height ?? 0)).toBeCloseTo(consoleLines.height, 0)
      expect(size?.width).toBeCloseTo(consoleLines.width, 0)
    }

    const glass = panel.getByRole('button', { name: /^Copa/ })
    const bottle = panel.getByRole('button', { name: /^Botella/ })
    await expect(glass).toContainText('$30.900')
    await expect(bottle).toContainText('$129.900')
    // No variant tapped means nothing to add (a wine with no variant would get a wrong price).
    await expect(panel.getByRole('button', { name: 'Elige tamaño' })).toBeDisabled()
    await expect(panel.locator('button[aria-pressed="true"]')).toHaveCount(0)

    await bottle.click()
    await expect(panel).toBeHidden()
    await expect(alert(page, 'Agregaste Ramón Bilbao Crianza (botella)')).toBeVisible()

    await product(page, 'Ramón Bilbao Crianza').click()
    await page
      .getByRole('dialog', { name: 'Ramón Bilbao Crianza' })
      .getByRole('button', { name: /^Copa/ })
      .click()
    await expect(alert(page, 'Agregaste Ramón Bilbao Crianza (copa)')).toBeVisible()

    const ticket = await openTicket(page, register)
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

  test('the quantity chosen before tapping the variant multiplies its price', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=1')
    await searchMenu(page).fill('ramon bilbao crianza')
    await product(page, 'Ramón Bilbao Crianza').click()
    const panel = page.getByRole('dialog', { name: 'Ramón Bilbao Crianza' })
    await panel.getByRole('button', { name: 'Uno más' }).click()
    await panel.getByRole('button', { name: /^Botella/ }).click()
    const ticket = await openTicket(page, register)
    await expect(
      ticket.getByRole('button', { name: /Ramón Bilbao Crianza \(botella\)/ }),
    ).toContainText('$259.800')
  })

  test('Tagliata: doneness is required; tapping it adds the dish and it cannot be added without it', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=1')
    await searchMenu(page).fill('tagliata')
    await product(page, 'Tagliata di Manzo').click()

    const panel = page.getByRole('dialog', { name: 'Tagliata di Manzo' })
    await expect(panel.getByText('Término de la carne (obligatorio)')).toBeVisible()
    const add = panel.getByRole('button', { name: 'Elige término de la carne' })
    await expect(add).toBeDisabled()
    await add.click({ force: true, noWaitAfter: true }) // forcing it does not add either
    await expect(panel).toBeVisible()
    await expect(alert(page, 'Agregaste Tagliata')).toHaveCount(0)
    for (const doneness of ['Rojo', 'Medio', 'Tres cuartos', 'Bien asado'])
      await expect(panel.getByRole('button', { name: doneness })).toBeVisible()

    await panel.getByRole('button', { name: 'Tres cuartos' }).click()
    await expect(panel).toBeHidden()
    await expect(alert(page, 'Agregaste Tagliata di Manzo')).toBeVisible()
    const ticket = await openTicket(page, register)
    const row = ticket.getByRole('button', { name: /Tagliata di Manzo/ })
    await expect(row).toContainText('Tres cuartos')
    await expect(row).toContainText('$40.900')
  })

  test('doneness and the note reach the kitchen, highlighted', async ({ page }) => {
    await page.goto('/mockups/order?table=1')
    await searchMenu(page).fill('tagliata')
    await product(page, 'Tagliata di Manzo').click()
    const panel = page.getByRole('dialog', { name: 'Tagliata di Manzo' })
    await panel.getByLabel('Notas para cocina').fill('sin sal')
    await panel.getByRole('button', { name: 'Medio', exact: true }).click()
    await send(page, 1).click()
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Cocina y barra/ }).click()
    const card = ticketEl(page, 1, 'cocina')
    await expect(card.getByText('Medio')).toBeVisible()
    await expect(card.getByText('¡sin sal!')).toBeVisible()
  })

  test('closing the panel (Escape, the X or tapping outside) adds nothing', async ({ page }) => {
    await page.goto('/mockups/order?table=1')
    await searchMenu(page).fill('tagliata')
    const panel = page.getByRole('dialog', { name: 'Tagliata di Manzo' })

    await product(page, 'Tagliata di Manzo').click()
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()

    await product(page, 'Tagliata di Manzo').click()
    await panel.getByRole('button', { name: 'Cerrar' }).click()
    await expect(panel).toBeHidden()

    await product(page, 'Tagliata di Manzo').click()
    await page.mouse.click(5, 5) // outside the panel, on the dark backdrop
    await expect(panel).toBeHidden()

    await expect(send(page)).toBeDisabled()
  })

  test('Té Hatsu asks for the flavor (required, no cost) and tapping it adds it', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=1')
    await searchMenu(page).fill('te hatsu')
    await product(page, 'Té Hatsu').click()
    const panel = page.getByRole('dialog', { name: 'Té Hatsu' })
    await expect(panel.getByRole('button', { name: /^Elige / })).toBeDisabled()
    await panel.getByRole('button', { name: 'Amarillo' }).click()
    await expect(panel).toBeHidden()
    const ticket = await openTicket(page, register)
    const row = ticket.getByRole('button', { name: /Té Hatsu/ })
    await expect(row).toContainText('Amarillo')
    await expect(row).toContainText('$13.900')
  })

  test('the burger also asks for doneness when tapped', async ({ page }) => {
    await page.goto('/mockups/order?table=1')
    await searchMenu(page).fill('spritz burguer')
    await product(page, 'Spritz Burguer').click()
    await expect(
      page
        .getByRole('dialog', { name: 'Spritz Burguer' })
        .getByText('Término de la carne (obligatorio)'),
    ).toBeVisible()
  })

  test('a product without options opens no panel and is added with one tap', async ({ page }) => {
    await page.goto('/mockups/order?table=1')
    await product(page, 'Pinsa').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(send(page, 1)).toBeVisible()
  })

  test('typing the note key by key in a product panel loses neither focus nor letters', async ({
    page,
  }) => {
    await page.goto('/mockups/order?table=1')
    await searchMenu(page).fill('ramon bilbao crianza')
    await product(page, 'Ramón Bilbao Crianza').click()
    const notes = page
      .getByRole('dialog', { name: 'Ramón Bilbao Crianza' })
      .getByLabel('Notas para cocina')
    await notes.click()
    await notes.pressSequentially('bien fría')
    await expect(notes).toHaveValue('bien fría')
    await expect(notes).toBeFocused()
  })

  test('typing the note key by key when editing an item loses neither focus nor letters', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=1')
    await product(page, 'Pinsa').click()
    const ticket = await openTicket(page, register)
    await ticket.getByRole('button', { name: /Pinsa/ }).click()
    const notes = page.getByRole('dialog', { name: 'Pinsa' }).getByLabel('Notas para cocina')
    await notes.click()
    await notes.pressSequentially('sin rúgula')
    await expect(notes).toHaveValue('sin rúgula')
    await expect(notes).toBeFocused()
  })
})

// ---------------------------------------------------------------------------------------------
// Side panel: a real modal
// ---------------------------------------------------------------------------------------------

test.describe('modal side panel', () => {
  test('when open it makes the background inert and unscrollable; when closed everything comes back', async ({
    page,
  }) => {
    await page.goto('/mockups/components')
    const inert = () => page.locator('#root').evaluate((el) => el.hasAttribute('inert'))
    const blocked = () => page.evaluate(() => document.body.style.overflow)
    expect(await inert()).toBe(false)

    await page.getByRole('button', { name: 'Abrir panel lateral' }).click()
    const panel = page.getByRole('dialog', { name: 'Panel lateral' })
    await expect(panel).toBeFocused()
    expect(await inert()).toBe(true)
    expect(await blocked()).toBe('hidden')
    // The panel lives outside the root: it can be used even though the background is inert.
    expect(
      await page.evaluate(() =>
        document.body.lastElementChild?.contains(document.querySelector('[role="dialog"]')),
      ),
    ).toBe(true)

    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    expect(await inert()).toBe(false)
    expect(await blocked()).toBe('')
    // Focus returns to whoever opened the panel.
    await expect(page.getByRole('button', { name: 'Abrir panel lateral' })).toBeFocused()
  })

  test('Tab does not leave the panel toward the background', async ({ page }) => {
    await page.goto('/mockups/components')
    await page.getByRole('button', { name: 'Abrir panel lateral' }).click()
    const panel = page.getByRole('dialog', { name: 'Panel lateral' })
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      // Focus moves through the panel or leaves the page (browser bar), never to the background.
      const inBackground = await page.evaluate(() => !!document.activeElement?.closest('#root'))
      expect(inBackground).toBe(false)
    }
    await expect(panel).toBeVisible()
  })

  test('with two panels open (order and an item), closing the top one does NOT release the background', async ({
    page,
  }, info) => {
    test.skip(isRegister(info.project.name), 'The «Pedido» panel only exists on the phone')
    await page.goto('/mockups/order?table=2')
    await page.getByRole('button', { name: /^Pedido \(/ }).click()
    const order = page.getByRole('dialog', { name: /^Pedido · Mesa/ })
    await order.getByRole('button', { name: /Aperol Spritz/ }).click()
    const item = page.getByRole('dialog', { name: 'Aperol Spritz' })
    await expect(item).toBeVisible()
    await item.getByRole('button', { name: 'Listo' }).click()
    await expect(item).toBeHidden()
    // The order panel is still open: the background must stay inert and unscrollable.
    await expect(order).toBeVisible()
    expect(await page.locator('#root').evaluate((el) => el.hasAttribute('inert'))).toBe(true)
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  })
})

// ---------------------------------------------------------------------------------------------
// Undo and notices
// ---------------------------------------------------------------------------------------------

test.describe('undo and notices', () => {
  test('undoing an added item removes it from the order', async ({ page }, info) => {
    const register = isRegister(info.project.name)
    await freezeClock(page)
    await page.goto('/mockups/order?table=1')
    await product(page, 'Tentazione di Formaggio').click()
    await expect(send(page, 1)).toBeVisible()
    await undo(page, 'Agregaste Tentazione di Formaggio').click()
    await expect(send(page)).toBeDisabled()
    const ticket = await openTicket(page, register)
    await expect(ticket.getByRole('button', { name: /Tentazione/ })).toHaveCount(0)
  })

  test('removing an item and undoing puts it back in its original position', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await freezeClock(page)
    await page.goto('/mockups/order?table=1')
    for (const name of ['Pinsa', 'Tentazione di Formaggio', 'Polpette'])
      await product(page, name).click()

    let ticket = await openTicket(page, register)
    expect(await ticketNames(ticket)).toEqual([
      'Pinsa',
      'Tentazione di Formaggio',
      'Polpette d’Amore',
    ])
    await ticket.getByRole('button', { name: /Tentazione/ }).click()
    await page
      .getByRole('dialog', { name: 'Tentazione di Formaggio' })
      .getByRole('button', { name: 'Quitar' })
      .click()
    await closeTicket(page, register)
    await expect(alert(page, 'Quitaste Tentazione di Formaggio')).toBeVisible()
    ticket = await openTicket(page, register)
    expect(await ticketNames(ticket)).toEqual(['Pinsa', 'Polpette d’Amore'])
    await closeTicket(page, register)

    await undo(page, 'Quitaste Tentazione di Formaggio').click()
    ticket = await openTicket(page, register)
    expect(await ticketNames(ticket)).toEqual([
      'Pinsa',
      'Tentazione di Formaggio',
      'Polpette d’Amore',
    ])
  })

  test('up to 3 notices at once, each with its Deshacer: removing two items in a row does not lose the first', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await freezeClock(page)
    await page.goto('/mockups/order?table=1')
    for (const name of ['Pinsa', 'Tentazione di Formaggio', 'Polpette'])
      await product(page, name).click()
    const alerts = page.locator('[aria-live="polite"] > div')
    await expect(alerts).toHaveCount(3)

    for (const name of ['Pinsa', 'Tentazione']) {
      const ticket = await openTicket(page, register)
      await ticket.getByRole('button', { name: new RegExp(name) }).click()
      await page
        .getByRole('dialog', { name: new RegExp(name) })
        .getByRole('button', { name: 'Quitar' })
        .click()
      await closeTicket(page, register)
    }
    // Never more than 3: the oldest ones leave.
    await expect(alerts).toHaveCount(3)
    await expect(alert(page, 'Quitaste Pinsa')).toBeVisible()
    await expect(alert(page, 'Quitaste Tentazione')).toBeVisible()
    await expect(alert(page, 'Agregaste Pinsa')).toHaveCount(0)

    await undo(page, 'Quitaste Pinsa').click()
    await undo(page, 'Quitaste Tentazione').click()
    const ticket = await openTicket(page, register)
    expect((await ticketNames(ticket)).sort()).toEqual(
      ['Pinsa', 'Polpette d’Amore', 'Tentazione di Formaggio'].sort(),
    )
  })

  test('a notice disappears on its own after 5 seconds', async ({ page }) => {
    await freezeClock(page)
    await page.goto('/mockups/order?table=1')
    await product(page, 'Pinsa').click()
    await expect(undo(page, 'Agregaste Pinsa')).toBeVisible()
    await page.clock.runFor(4_900)
    await expect(undo(page, 'Agregaste Pinsa')).toBeVisible()
    await page.clock.runFor(200)
    await expect(alert(page, 'Agregaste Pinsa')).toHaveCount(0)
    await expect(send(page, 1)).toBeVisible() // nothing was undone
  })

  test('while the pointer is over a notice, its time does not run', async ({ page }) => {
    await freezeClock(page)
    await page.goto('/mockups/order?table=1')
    await product(page, 'Pinsa').click()
    const card = alert(page, 'Agregaste Pinsa')
    await card.hover()
    await page.clock.runFor(20_000)
    await expect(card).toBeVisible()
    await page.mouse.move(5, 5)
    await page.clock.runFor(5_100)
    await expect(card).toHaveCount(0)
  })

  test('the notice keeps the time it had left when the pointer leaves', async ({ page }) => {
    await freezeClock(page)
    await page.goto('/mockups/order?table=1')
    await product(page, 'Pinsa').click()
    const card = alert(page, 'Agregaste Pinsa')
    await page.clock.runFor(3_000)
    await card.hover()
    await page.clock.runFor(30_000)
    await page.mouse.move(5, 5)
    await page.clock.runFor(1_900)
    await expect(card).toBeVisible() // it had 2 s left
    await page.clock.runFor(200)
    await expect(card).toHaveCount(0)
  })

  test('removing the item and letting the notice expire leaves it removed', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await freezeClock(page)
    await page.goto('/mockups/order?table=1')
    await product(page, 'Pinsa').click()
    const ticket = await openTicket(page, register)
    await ticket.getByRole('button', { name: /Pinsa/ }).click()
    await page
      .getByRole('dialog', { name: 'Pinsa' })
      .getByRole('button', { name: 'Quitar' })
      .click()
    await closeTicket(page, register)
    await page.clock.runFor(5_500)
    await expect(alert(page, 'Quitaste Pinsa')).toHaveCount(0)
    const ticket2 = await openTicket(page, register)
    await expect(ticket2.getByRole('button', { name: /Pinsa/ })).toHaveCount(0)
  })

  test('changing the quantity and notes of an unsent item', async ({ page }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=1')
    await product(page, 'Pinsa').click()
    const ticket = await openTicket(page, register)
    await ticket.getByRole('button', { name: /Pinsa/ }).click()
    const item = page.getByRole('dialog', { name: 'Pinsa' })
    await item.getByRole('button', { name: 'Uno más' }).click()
    await item.getByRole('button', { name: 'Uno más' }).click()
    await item.getByLabel('Notas para cocina').fill('bien caliente')
    await item.getByRole('button', { name: 'Listo' }).click()
    const row = ticket.getByRole('button', { name: /Pinsa/ })
    await expect(row).toContainText('3')
    await expect(row).toContainText('«bien caliente»')
    await expect(row).toContainText('$62.700')
  })
})

// ---------------------------------------------------------------------------------------------
// Voiding a sent item
// ---------------------------------------------------------------------------------------------

test.describe('voiding a sent item', () => {
  test('asks for a reason and confirmation; stays visible, struck through, and is no longer charged', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=7')
    let ticket = await openTicket(page, register)
    await expect(ticket.getByText('Total').locator('xpath=following-sibling::span[1]')).toHaveText(
      '$53.800',
    )
    await ticket.getByRole('button', { name: /Spritz Burguer/ }).click()

    const panel = page.getByRole('dialog', { name: 'Anular Spritz Burguer' })
    await expect(panel).toContainText('no se puede quitar, solo anular')
    // Without a reason it cannot be voided.
    await expect(panel.getByRole('button', { name: 'Elige el motivo' })).toBeDisabled()
    for (const reason of ['Error del mesero', 'El cliente cambió', 'Demora', 'Producto dañado'])
      await expect(panel.getByRole('button', { name: reason })).toBeVisible()

    await panel.getByRole('button', { name: 'Demora' }).click()
    await panel.getByRole('button', { name: 'Anular', exact: true }).click()
    // It asks for confirmation and has not voided anything yet.
    await expect(panel).toContainText('¿Anular Spritz Burguer? Queda registrado con el motivo.')
    await panel.getByRole('button', { name: 'Volver' }).click()
    await expect(panel.getByRole('button', { name: 'Anular', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Anular', exact: true }).click()
    await panel.getByRole('button', { name: 'Sí, anular' }).click()
    await expect(panel).toBeHidden()

    await closeTicket(page, register)
    await expect(alert(page, 'Anulaste Spritz Burguer (demora)')).toBeVisible()
    ticket = await openTicket(page, register)
    const row = ticket.getByRole('listitem').filter({ hasText: 'Spritz Burguer' })
    await expect(row).toContainText('anulado: demora')
    await expect(row.locator('.line-through').first()).toBeVisible()
    await expect(ticket.getByText('Total').locator('xpath=following-sibling::span[1]')).toHaveText(
      '$13.900',
    )
    // A voided item can no longer be tapped.
    await row.getByRole('button').click()
    await expect(page.getByRole('dialog', { name: /Spritz Burguer/ })).toHaveCount(0)
  })

  test('what is voided leaves the KDS, the floor plan balance and the pre-bill', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/order?table=7')
    const ticket = await openTicket(page, register)
    await ticket.getByRole('button', { name: /Spritz Burguer/ }).click()
    const panel = page.getByRole('dialog', { name: 'Anular Spritz Burguer' })
    await panel.getByRole('button', { name: 'Error del mesero' }).click()
    await panel.getByRole('checkbox', { name: /Ya se había preparado/ }).check()
    await panel.getByRole('button', { name: 'Anular', exact: true }).click()
    await panel.getByRole('button', { name: 'Sí, anular' }).click()
    await closeTicket(page, register)

    await goTo(page, '/mockups/kds')
    await expect(ticketEl(page, 7, 'cocina')).toHaveCount(0) // it only had the burger
    await expect(ticketEl(page, 7, 'barra')).toBeVisible() // the tea remains

    await goTo(page, '/mockups/floor-plan')
    await expect(tableOnFloorPlan(page, 7)).toHaveAccessibleName(/\$13\.900$/)

    await goTo(page, '/mockups/pre-bill?table=7')
    await expect(page.getByRole('region', { name: 'Ítems' })).not.toContainText('Spritz Burguer')
  })
})

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

test.describe('menu search', () => {
  const results = (page: Page) => page.locator('section[aria-label="Carta"] > ul > li')

  test('«hamburgesa» finds Spritz Burguer', async ({ page }) => {
    await page.goto('/mockups/order?table=2')
    await searchMenu(page).fill('hamburgesa')
    await expect(results(page).first()).toContainText('Spritz Burguer')
  })

  test('«quatro formagi» finds Quattro Formaggi', async ({ page }) => {
    await page.goto('/mockups/order?table=2')
    await searchMenu(page).fill('quatro formagi')
    await expect(results(page).first()).toContainText('Quattro Formaggi')
  })

  test('without accents, in uppercase and with the words reversed', async ({ page }) => {
    await page.goto('/mockups/order?table=2')
    await searchMenu(page).fill('TE hatsu')
    await expect(product(page, 'Té Hatsu')).toBeVisible()
    await searchMenu(page).fill('formaggi QUATTRO')
    await expect(results(page).first()).toContainText('Quattro Formaggi')
  })

  test('what does not exist warns and clearing the search goes back to the categories', async ({
    page,
  }) => {
    await page.goto('/mockups/order?table=2')
    const categories = page.getByRole('group', { name: 'Categorías' })
    await expect(categories).toBeVisible()
    await searchMenu(page).fill('zzzzzz')
    await expect(page.getByText('No hay nada con «zzzzzz».')).toBeVisible()
    await expect(categories).toBeHidden()
    await searchMenu(page).fill('')
    await expect(categories).toBeVisible()
    await expect(product(page, 'Pinsa')).toBeVisible()
  })

  test('with more than 30 results it shows 30 and says how many are left', async ({ page }) => {
    await page.goto('/mockups/order?table=2')
    await searchMenu(page).fill('s')
    await expect(results(page).filter({ hasText: /^Hay \d+ más/ })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Carta' }).locator('ul > li button')).toHaveCount(
      30,
    )
    const text = await results(page)
      .filter({ hasText: /^Hay \d+ más/ })
      .textContent()
    expect(numberOf(text ?? '')).toBeGreaterThan(0)
  })

  test('a product found by search is added the same as from the category', async ({ page }) => {
    await page.goto('/mockups/order?table=2')
    await searchMenu(page).fill('pinza')
    await product(page, 'Pinsa').click()
    await expect(alert(page, 'Agregaste Pinsa')).toBeVisible()
  })

  test('categories change the products and mark the chosen one with ✓, not only with color', async ({
    page,
  }) => {
    await page.goto('/mockups/order?table=2')
    const categories = page.getByRole('group', { name: 'Categorías' })
    const first = categories.getByRole('button').first()
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expect(first.locator('svg')).toHaveCount(1)
    const another = categories.getByRole('button').nth(1)
    await expect(another.locator('svg')).toHaveCount(0)
    await another.click()
    await expect(another).toHaveAttribute('aria-pressed', 'true')
    await expect(another.locator('svg')).toHaveCount(1)
    await expect(first).toHaveAttribute('aria-pressed', 'false')
    await expect(product(page, 'Pinsa')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Pre-bill
// ---------------------------------------------------------------------------------------------

test.describe('pre-bill (docs/DINERO.md)', () => {
  const row = (page: Page, caption: RegExp) =>
    page.locator('dt', { hasText: caption }).locator('xpath=following-sibling::dd[1]')
  const checks = (page: Page) => page.getByRole('region', { name: 'Dividir' }).getByRole('listitem')
  /** Amount and tip of each check as read on screen. */
  const readChecks = async (page: Page) => {
    const texts = await checks(page).evaluateAll((lis) => lis.map((li) => li.textContent ?? ''))
    return texts.flatMap((t) => {
      const m = /\$([\d.]+) \+ propina \$([\d.]+)/.exec(t)
      return m ? [{ amount: numberOf(m[1] as string), tip: numberOf(m[2] as string) }] : []
    })
  }

  test('table 12: total, suggested tip on the base without INC and total with tip', async ({
    page,
  }) => {
    await page.goto('/mockups/pre-bill?table=12')
    // 44.900 + 40.900 + 27.900 + 129.900 + 13.900
    await expect(row(page, /^Total$/)).toHaveText('$257.500')
    // 257.500 / 1,08 = 238.425,93 → 10 % = 23.842,59 → 23.843 (not 25.750, which is on the gross)
    await expect(row(page, /Propina sugerida/)).toHaveText('$23.843')
    await expect(row(page, /^Con propina$/)).toHaveText('$281.343')
    await expect(page.getByText('Precios con INC incluido.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cobrar $257.500' })).toBeVisible()
    // No payments yet: there are no «Ya pagado» rows.
    await expect(page.getByText('Ya pagado')).toHaveCount(0)
  })

  for (const table of [2, 4, 7, 12, 21]) {
    test(`table ${table}: the tip comes from the base without INC with a single rounding`, async ({
      page,
    }) => {
      await page.goto(`/mockups/pre-bill?table=${table}`)
      const total = numberOf((await row(page, /^Total$/).textContent()) ?? '')
      expect(total).toBeGreaterThan(0)
      const tip = expectedTip(total)
      await expect(row(page, /Propina sugerida/)).toHaveText(inPesos(tip))
      await expect(row(page, /^Con propina$/)).toHaveText(inPesos(total + tip))
    })
  }

  test('table 21: each line is quantity × price', async ({ page }) => {
    await page.goto('/mockups/pre-bill?table=21')
    const items = page.getByRole('region', { name: 'Ítems' })
    await expect(items.getByRole('listitem').filter({ hasText: 'Pinsa' })).toContainText('$41.800')
    await expect(items.getByRole('listitem').filter({ hasText: 'Limonada de Coco' })).toContainText(
      '$74.500',
    )
    await expect(row(page, /^Total$/)).toHaveText('$116.300')
  })

  test('equal parts of the balance: 257.500 among 2, 3 and 4 by largest remainder, with the tip of each', async ({
    page,
  }) => {
    await page.goto('/mockups/pre-bill?table=12')
    await page.getByRole('button', { name: 'Partes iguales' }).click()
    await expect(page.getByRole('button', { name: /^Quitar personas/ })).toBeDisabled()
    expect(await readChecks(page)).toEqual([
      { amount: 128_750, tip: 11_922 },
      { amount: 128_750, tip: 11_921 },
    ])

    await page.getByRole('button', { name: /^Agregar personas/ }).click()
    // 257.500 / 3 = 85.833,33: the leftover peso goes to the first check
    const three = await readChecks(page)
    expect(three.map((c) => c.amount)).toEqual([85_834, 85_833, 85_833])
    expect(three.map((c) => c.tip)).toEqual(
      largestRemainderAllocation(23_843, [85_834, 85_833, 85_833]),
    )

    await page.getByRole('button', { name: /^Agregar personas/ }).click()
    expect((await readChecks(page)).map((c) => c.amount)).toEqual([64_375, 64_375, 64_375, 64_375])
  })

  test('from 2 to 20 people: amounts add up to the balance, differ by 1 peso and tips add up to the total', async ({
    page,
  }) => {
    await page.goto('/mockups/pre-bill?table=12')
    await page.getByRole('button', { name: 'Partes iguales' }).click()
    const more = page.getByRole('button', { name: /^Agregar personas/ })
    for (let people = 2; people <= 20; people++) {
      const checksRead = await readChecks(page)
      expect(checksRead).toHaveLength(people)
      const amounts = checksRead.map((c) => c.amount)
      expect(amounts.reduce((a, b) => a + b, 0)).toBe(257_500)
      expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1)
      const tips = checksRead.map((c) => c.tip)
      expect(tips.reduce((a, b) => a + b, 0)).toBe(23_843)
      expect(tips).toEqual(largestRemainderAllocation(23_843, amounts))
      if (people < 20) await more.click()
    }
    await expect(more).toBeDisabled()
  })

  test('by items with the wine shared between two checks', async ({ page }) => {
    await page.goto('/mockups/pre-bill?table=12')
    await page.getByRole('button', { name: 'Por ítems' }).click()
    const who = (item: string) => page.getByRole('group', { name: `Quién paga ${item}` })

    // With nothing assigned, everything stays unassigned and the checks are $0.
    await expect(checks(page)).toContainText(['Cuenta 1', 'Cuenta 2', 'Sin asignar$257.500'])
    expect((await readChecks(page)).map((c) => c.amount)).toEqual([0, 0])

    await who('Quattro Formaggi').getByRole('button', { name: 'Cuenta 1' }).click()
    await who('Patatine al Tartufo').getByRole('button', { name: 'Cuenta 1' }).click()
    await who('Tagliata di Manzo').getByRole('button', { name: 'Cuenta 2' }).click()
    await who('Té Hatsu').getByRole('button', { name: 'Cuenta 2' }).click()
    const wine = who('Ramón Bilbao Crianza (botella)')
    await wine.getByRole('button', { name: 'Cuenta 1' }).click()
    await wine.getByRole('button', { name: 'Cuenta 2' }).click()

    // Check 1: 44.900 + 27.900 + 64.950 = 137.750 · Check 2: 40.900 + 13.900 + 64.950 = 119.750
    const checksRead = await readChecks(page)
    expect(checksRead.map((c) => c.amount)).toEqual([137_750, 119_750])
    expect(checksRead.map((c) => c.tip)).toEqual(
      largestRemainderAllocation(23_843, [137_750, 119_750]),
    )
    await expect(page.getByText('Sin asignar')).toHaveCount(0)
  })

  test('by items: an item among 3 is allocated by largest remainder and the rest stays unassigned', async ({
    page,
  }) => {
    await page.goto('/mockups/pre-bill?table=12')
    await page.getByRole('button', { name: 'Por ítems' }).click()
    await page.getByRole('button', { name: /^Agregar cuentas/ }).click()
    const pizza = page.getByRole('group', { name: 'Quién paga Quattro Formaggi' })
    for (const c of [1, 2, 3]) await pizza.getByRole('button', { name: `Cuenta ${c}` }).click()
    // 44.900 / 3 = 14.966,67
    expect((await readChecks(page)).map((c) => c.amount)).toEqual([14_967, 14_967, 14_966])
    await expect(checks(page).filter({ hasText: 'Sin asignar' })).toContainText('$212.600')
  })

  test('tapping a check again removes the item from that check', async ({ page }) => {
    await page.goto('/mockups/pre-bill?table=12')
    await page.getByRole('button', { name: 'Por ítems' }).click()
    const button = page
      .getByRole('group', { name: 'Quién paga Quattro Formaggi' })
      .getByRole('button', { name: 'Cuenta 1' })
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    expect((await readChecks(page))[0]?.amount).toBe(44_900)
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    expect((await readChecks(page))[0]?.amount).toBe(0)
  })

  test('removing a check does not break the screen: its items go back to «sin asignar»', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/mockups/pre-bill?table=12')
    await page.getByRole('button', { name: 'Por ítems' }).click()
    await page.getByRole('button', { name: /^Agregar cuentas/ }).click()
    const pizza = page.getByRole('group', { name: 'Quién paga Quattro Formaggi' })
    await pizza.getByRole('button', { name: 'Cuenta 2' }).click()
    await pizza.getByRole('button', { name: 'Cuenta 3' }).click()
    await page.getByRole('button', { name: /^Quitar cuentas/ }).click()
    await expect(page.getByRole('heading', { name: 'Precuenta · Mesa 12' })).toBeVisible()
    expect(errors).toEqual([])
    // The pizza stays only in check 2; check 3 is gone.
    expect((await readChecks(page)).map((c) => c.amount)).toEqual([0, 44_900])
    await expect(checks(page).filter({ hasText: 'Sin asignar' })).toContainText('$212.600')
    await expect(pizza.getByRole('button', { name: 'Cuenta 3' })).toHaveCount(0)
  })

  test('printing the pre-bill shows a notice and leaves the table «Por cobrar» on the floor plan', async ({
    page,
  }) => {
    await page.goto('/mockups/pre-bill?table=4')
    await page.getByRole('button', { name: 'Imprimir' }).click()
    await expect(alert(page, 'Precuenta enviada a la impresora')).toBeVisible()
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(tableOnFloorPlan(page, 4)).toHaveAccessibleName(/^Mesa 4: Por cobrar/)
  })

  test('«Cobrar» on a single check goes to checkout for the same table with the full balance', async ({
    page,
  }) => {
    await page.goto('/mockups/pre-bill?table=12')
    await page.getByRole('button', { name: /^Cobrar/ }).click()
    await expect(page).toHaveURL(/\/mockups\/checkout\?table=12&amount=257500&tip=23843$/)
    await expect(page.getByRole('heading', { name: 'Cobro · Mesa 12' })).toBeVisible()
  })

  test('actions are in a fixed bottom bar on the phone and in the panel on the register', async ({
    page,
  }, info) => {
    await page.goto('/mockups/pre-bill?table=12')
    const print = page.getByRole('button', { name: 'Imprimir' })
    const register = await print.boundingBox()
    const consoleLines = page.viewportSize() as { width: number; height: number }
    if (isRegister(info.project.name)) {
      expect((register?.y ?? 0) + (register?.height ?? 0)).toBeLessThan(consoleLines.height - 20)
    } else {
      expect((register?.y ?? 0) + (register?.height ?? 0)).toBeGreaterThan(consoleLines.height - 90)
      // And it does not cover the final content: «Precios con INC incluido» can be reached.
      await page.getByText('Precios con INC incluido.').scrollIntoViewIfNeeded()
      const text = await page.getByText('Precios con INC incluido.').boundingBox()
      expect((text?.y ?? 0) + (text?.height ?? 0)).toBeLessThanOrEqual(register?.y ?? 0)
    }
  })

  test('an out-of-range or nonexistent table uses the sample one, without breaking the screen', async ({
    page,
  }) => {
    await page.goto('/mockups/pre-bill?table=999')
    await expect(page.getByRole('heading', { name: 'Precuenta · Mesa 12' })).toBeVisible()
    await page.goto('/mockups/pre-bill?table=abc')
    await expect(page.getByRole('heading', { name: 'Precuenta · Mesa 12' })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------------------------

test.describe('checkout (docs/DINERO.md#pagos)', () => {
  const charge = (page: Page, amount: number) =>
    page.getByRole('button', { name: `Cobrar ${inPesos(amount)}` })
  const balance = (page: Page) => page.getByRole('region', { name: 'Saldo' }).locator('p').nth(1)
  const tendered = (page: Page) => page.getByLabel('El cliente entrega')
  const tip = (page: Page) => page.getByLabel('Propina', { exact: true })
  const confirmation = (page: Page) => page.getByRole('alertdialog')
  /** Opens checkout and waits for the screen (loaded separately) to be ready for the keyboard. */
  const goToCheckout = async (page: Page, route = '/mockups/checkout?table=12') => {
    await page.goto(route)
    await expect(page.getByText('Saldo pendiente')).toBeVisible()
  }

  test('starts with the balance, the suggested tip rounded to $100 and the exact amount already set', async ({
    page,
  }) => {
    await page.goto('/mockups/checkout?table=12')
    await expect(balance(page)).toHaveText('$257.500')
    await expect(page.getByText('sugerida $23.843')).toBeVisible()
    await expect(tip(page)).toHaveValue('23.800') // in cash, multiple of $100
    await expect(page.getByText('A cobrar (venta redondeada a $100 + propina)')).toBeVisible()
    await expect(tendered(page)).toHaveValue('281.300') // exact by default
    await expect(page.getByText('Cambio $0')).toBeVisible()
    await expect(charge(page, 281_300)).toBeEnabled()
  })

  test('cash: «Faltan» when it is short and change when there is extra', async ({ page }) => {
    await page.goto('/mockups/checkout?table=12')
    await page.getByRole('button', { name: '20 mil' }).click()
    await expect(tendered(page)).toHaveValue('20.000')
    await expect(page.getByText('Faltan $261.300')).toBeVisible()
    await expect(charge(page, 281_300)).toBeDisabled()

    await page.getByRole('button', { name: '100 mil' }).click()
    await expect(page.getByText('Faltan $181.300')).toBeVisible()

    await tendered(page).fill('281299')
    await expect(page.getByText('Faltan $1', { exact: true })).toBeVisible()
    await expect(charge(page, 281_300)).toBeDisabled()

    await tendered(page).fill('300000')
    await expect(tendered(page)).toHaveValue('300.000') // written with thousands separators
    await expect(page.getByText('Cambio $18.700')).toBeVisible()
    await expect(charge(page, 281_300)).toBeEnabled()

    await page.getByRole('button', { name: 'Exacto' }).click()
    await expect(tendered(page)).toHaveValue('281.300')
    await expect(page.getByText('Cambio $0')).toBeVisible()
  })

  test('«Deja el cambio de propina» moves the change to the tip and balances with no change', async ({
    page,
  }) => {
    await page.goto('/mockups/checkout?table=12')
    await expect(page.getByRole('button', { name: 'Deja el cambio de propina' })).toHaveCount(0)
    await tendered(page).fill('300000')
    await page.getByRole('button', { name: 'Deja el cambio de propina' }).click()
    await expect(tip(page)).toHaveValue('42.500') // 23.800 + 18.700
    await expect(page.getByText('Cambio $0')).toBeVisible()
    await expect(charge(page, 300_000)).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Deja el cambio de propina' })).toHaveCount(0)
  })

  test('the tip can be changed, removed and reset to the suggested one', async ({ page }) => {
    await page.goto('/mockups/checkout?table=12')
    await page.getByRole('button', { name: 'Sin propina' }).click()
    await expect(tip(page)).toHaveValue('')
    await expect(charge(page, 257_500)).toBeVisible()
    await tip(page).fill('5000')
    await expect(tip(page)).toHaveValue('5.000')
    await expect(charge(page, 262_500)).toBeVisible()
    await page.getByRole('button', { name: 'Sugerida' }).click()
    await expect(tip(page)).toHaveValue('23.800')
  })

  test('money fields only accept numbers', async ({ page }) => {
    await goToCheckout(page)
    await tendered(page).fill('3a0b0$000')
    await expect(tendered(page)).toHaveValue('300.000')
    await tip(page).fill('1x0')
    await expect(tip(page)).toHaveValue('10')
  })

  test('asks for confirmation before recording: nothing changes until confirmed, and Cancelar goes back', async ({
    page,
  }) => {
    await goToCheckout(page)
    await tendered(page).fill('300000')
    await charge(page, 281_300).click()

    await expect(confirmation(page)).toContainText('¿Registrar $281.300 en efectivo?')
    await expect(balance(page)).toHaveText('$257.500') // nothing recorded yet
    // Focus moves to «Confirmar».
    await expect(page.getByRole('button', { name: 'Confirmar' })).toBeFocused()

    await page.getByRole('button', { name: 'Cancelar' }).click()
    await expect(confirmation(page)).toBeHidden()
    await expect(balance(page)).toHaveText('$257.500')
  })

  test('Enter asks for confirmation and focus stays on «Confirmar»: another Enter records', async ({
    page,
  }) => {
    await goToCheckout(page)
    await tendered(page).fill('300000')

    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Confirmar' })).toBeFocused()
    await expect(balance(page)).toHaveText('$257.500') // a single Enter never records

    await page.keyboard.press('Escape')
    await expect(confirmation(page)).toBeHidden()
    await expect(balance(page)).toHaveText('$257.500')

    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect(balance(page)).toHaveText('$0')
    await expect(alert(page, 'Mesa 12 pagada y cerrada')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Saldo' })).toContainText('Cambio a entregar')
    await expect(page.getByRole('region', { name: 'Saldo' })).toContainText('$18.700')
    await expect(page.getByRole('region', { name: 'Saldo' })).toContainText(
      /efectivo\$257\.500 \+ propina \$23\.800/i,
    )
  })

  test('Enter with focus on «Cancelar» cancels, does not record', async ({ page }) => {
    await goToCheckout(page)
    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toBeVisible()
    await page.keyboard.press('Shift+Tab') // from «Confirmar» to «Cancelar»
    await expect(page.getByRole('button', { name: 'Cancelar' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toBeHidden()
    await expect(balance(page)).toHaveText('$257.500')
  })

  test('Enter does nothing if the payment is not valid yet', async ({ page }) => {
    await goToCheckout(page)
    await tendered(page).fill('100000')
    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toHaveCount(0)
    await expect(balance(page)).toHaveText('$257.500')
  })

  test('F2 and F3 change the payment method, with ✓ on the chosen one', async ({ page }) => {
    await page.goto('/mockups/checkout?table=12')
    const cash = page.getByRole('button', { name: /^Efectivo/ })
    const card = page.getByRole('button', { name: /^Tarjeta/ })
    await expect(cash).toHaveAttribute('aria-pressed', 'true')
    await expect(cash.locator('svg')).toHaveCount(1)

    await page.keyboard.press('F3')
    await expect(card).toHaveAttribute('aria-pressed', 'true')
    await expect(cash).toHaveAttribute('aria-pressed', 'false')
    await expect(card.locator('svg')).toHaveCount(1)
    await expect(page.getByLabel('Número de aprobación')).toBeVisible()
    // With card the tip stays exact, not rounded.
    await expect(tip(page)).toHaveValue('23.843')

    await page.keyboard.press('F2')
    await expect(cash).toHaveAttribute('aria-pressed', 'true')
    await expect(tendered(page)).toBeVisible()
    await expect(tip(page)).toHaveValue('23.800')
  })

  test('card: requires an approval number of 4 to 8 digits and is charged with Enter', async ({
    page,
  }) => {
    await goToCheckout(page)
    await page.keyboard.press('F3')
    const approval_code = page.getByLabel('Número de aprobación')
    await expect(page.getByText('Total en el datáfono (venta + propina)')).toBeVisible()
    await expect(charge(page, 281_343)).toBeDisabled()

    await approval_code.fill('123')
    await expect(charge(page, 281_343)).toBeDisabled()
    await approval_code.fill('12ab34')
    await expect(approval_code).toHaveValue('1234')
    await expect(charge(page, 281_343)).toBeEnabled()
    await approval_code.fill('123456789')
    await expect(approval_code).toHaveValue('12345678')

    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toContainText('¿Registrar $281.343 en tarjeta?')
    await page.keyboard.press('Enter')
    await expect(balance(page)).toHaveText('$0')
    await expect(alert(page, 'Mesa 12 pagada y cerrada')).toBeVisible()
  })

  test('changing the method while confirming closes the confirmation', async ({ page }) => {
    await goToCheckout(page)
    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toBeVisible()
    await page.getByRole('button', { name: /^Tarjeta/ }).click()
    await expect(confirmation(page)).toHaveCount(0)
  })

  test('when everything is paid the table closes on its own and shows «Por limpiar» on the floor plan', async ({
    page,
  }) => {
    await goToCheckout(page)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect(balance(page)).toHaveText('$0')
    await expect(page.getByRole('region', { name: 'Pago' })).toHaveCount(0) // nothing to charge
    await expect(page.getByRole('button', { name: 'Cerrar mesa' })).toHaveCount(0) // no longer needed

    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await expect(page).toHaveURL(/\/mockups\/floor-plan$/)
    await expect(tableOnFloorPlan(page, 12)).toHaveAccessibleName(/^Mesa 12: Por limpiar$/)
    await expect(page.getByText('0 por cobrar')).toBeVisible()
  })

  test('Deshacer on the close leaves the table «Por cobrar»', async ({ page }) => {
    await freezeClock(page)
    await goToCheckout(page)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await undo(page, 'Mesa 12 pagada y cerrada').click()
    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await expect(tableOnFloorPlan(page, 12)).toHaveAccessibleName(/^Mesa 12: Por cobrar/)
  })

  test('the table to clean is left free and empty for the next customer', async ({ page }) => {
    await goToCheckout(page)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await tableOnFloorPlan(page, 12).click()
    await expect(tableOnFloorPlan(page, 12)).toHaveAccessibleName(/^Mesa 12: Libre$/)
  })

  test('the amount in the route is one check part; if it does not fit the balance, the balance is charged', async ({
    page,
  }) => {
    await page.goto('/mockups/checkout?table=12&amount=128750&tip=11922')
    await expect(page.getByText('Esta cuenta: $128.750')).toBeVisible()
    await expect(balance(page)).toHaveText('$257.500')
    await expect(page.getByText('sugerida $11.922')).toBeVisible()
    await expect(tip(page)).toHaveValue('11.900')
    // A partial payment is not rounded: 128.750 + 11.900
    await expect(page.getByText('A cobrar (venta + propina)')).toBeVisible()
    await expect(charge(page, 140_650)).toBeVisible()

    await page.goto('/mockups/checkout?table=12&amount=999999999')
    await expect(charge(page, 281_300)).toBeVisible()
    await page.goto('/mockups/checkout?table=12&amount=abc')
    await expect(charge(page, 281_300)).toBeVisible()
    await page.goto('/mockups/checkout?table=12&amount=0')
    await expect(charge(page, 281_300)).toBeVisible()
  })

  test('partial payment per check: the table stays open with the correct balance; the second check closes it', async ({
    page,
  }) => {
    await page.goto('/mockups/pre-bill?table=12')
    await page.getByRole('button', { name: 'Partes iguales' }).click()
    await page.getByRole('button', { name: 'Cobrar $128.750' }).first().click()
    await expect(page).toHaveURL(/\/mockups\/checkout\?table=12&amount=128750&tip=11922$/)
    await expect(page.getByText('Esta cuenta: $128.750')).toBeVisible()

    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    // A partial payment goes back to the pre-bill, with what was paid and the balance.
    await expect(page).toHaveURL(/\/mockups\/pre-bill\?table=12$/)
    await expect(alert(page, 'Pago registrado. Queda $128.750')).toBeVisible()
    const row = (r: RegExp) =>
      page.locator('dt', { hasText: r }).locator('xpath=following-sibling::dd[1]')
    await expect(row(/^Total$/)).toHaveText('$257.500')
    await expect(row(/^Ya pagado$/)).toHaveText('-$128.750')
    await expect(row(/^Saldo$/)).toHaveText('$128.750')
    // The suggested tip is recalculated on the balance: 128.750 / 1,08 × 10 %.
    await expect(row(/Propina sugerida/)).toHaveText(inPesos(expectedTip(128_750)))
    await expect(row(/^Con propina$/)).toHaveText(inPesos(128_750 + expectedTip(128_750)))

    // The floor plan still shows the table open, with the pending balance.
    await page.getByRole('button', { name: 'Volver' }).click()
    await expect(tableOnFloorPlan(page, 12)).toHaveAccessibleName(/\$128\.750$/)
    await tableOnFloorPlan(page, 12).click()

    // With previous payments it can no longer be split by items.
    await page.getByRole('button', { name: 'Por ítems' }).click()
    await expect(page.getByText('Ya hay pagos: divide el saldo en partes iguales.')).toBeVisible()
    await expect(page.getByRole('group', { name: /^Quién paga/ })).toHaveCount(0)

    // The second check is the full balance: it is rounded to $100 (128.750 → 128.700) and closes.
    await page.getByRole('button', { name: 'Una cuenta' }).click()
    await page.getByRole('button', { name: 'Cobrar $128.750' }).click()
    await expect(page.getByText('A cobrar (venta redondeada a $100 + propina)')).toBeVisible()
    await expect(charge(page, 140_600)).toBeVisible() // 128.700 + 11.900
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await expect(balance(page)).toHaveText('$0')
    await expect(alert(page, 'Mesa 12 pagada y cerrada')).toBeVisible()
    const payments = page.getByRole('region', { name: 'Saldo' }).getByRole('listitem')
    await expect(payments).toHaveCount(2)
    await expect(payments.nth(0)).toContainText('$128.750 + propina $11.900')
    await expect(payments.nth(1)).toContainText('$128.750 + propina $11.900 (redondeo -$50)')
    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await expect(tableOnFloorPlan(page, 12)).toHaveAccessibleName(/^Mesa 12: Por limpiar$/)
  })

  test('end to end: new order, pre-bill and checkout leave the table to clean and off the KDS', async ({
    page,
  }, info) => {
    const register = isRegister(info.project.name)
    await page.goto('/mockups/floor-plan')
    await tableOnFloorPlan(page, 1).click()
    await product(page, 'Pinsa').click()
    await send(page, 1).click()
    await tableOnFloorPlan(page, 1).click() // in preparation: goes back to the order
    const ticket = await openTicket(page, register)
    await ticket.getByRole('button', { name: 'Cuenta' }).click()
    await expect(page.getByRole('button', { name: 'Cobrar $20.900' })).toBeVisible()
    await page.getByRole('button', { name: 'Cobrar $20.900' }).click()
    // 20.900 / 1,08 × 10 % = 1.935,19 → 1.935; in cash 1.900
    await expect(tip(page)).toHaveValue('1.900')
    await tendered(page).fill('25000')
    await expect(page.getByText('Cambio $2.200')).toBeVisible() // 25.000 − 20.900 − 1.900
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Volver al salón' }).click()
    await expect(tableOnFloorPlan(page, 1)).toHaveAccessibleName(/^Mesa 1: Por limpiar$/)
  })
})

// ---------------------------------------------------------------------------------------------
// KDS
// ---------------------------------------------------------------------------------------------

test.describe('KDS (kitchen and bar)', () => {
  test('one card per table and station, the oldest first', async ({ page }) => {
    await page.goto('/mockups/kds')
    for (const [table, station] of [
      [7, 'cocina'],
      [7, 'barra'],
      [4, 'cocina'],
      [4, 'barra'],
      [21, 'cocina'],
      [21, 'barra'],
    ] as const)
      await expect(ticketEl(page, table, station)).toBeVisible()
    // What is already dispatched or unsent does not appear.
    await expect(ticketEl(page, 9, 'cocina')).toHaveCount(0)
    await expect(ticketEl(page, 12, 'cocina')).toHaveCount(0)
    await expect(ticketEl(page, 2, 'barra')).toHaveCount(0)

    const numbers = (await page.locator('main ul > li p.font-heading').allInnerTexts()).map(
      numberOf,
    )
    expect(numbers.filter((n, i) => n !== numbers[i - 1])).toEqual([7, 4, 21])
  })

  test('time is read as text: on time, attention or delay', async ({ page }) => {
    await page.goto('/mockups/kds')
    const t21 = ticketEl(page, 21, 'cocina')
    const t4 = ticketEl(page, 4, 'cocina')
    const t7 = ticketEl(page, 7, 'cocina')
    await expect(t21).toContainText(/\d min/)
    await expect(t21).toContainText('a tiempo')
    await expect(t4).toContainText('atención')
    await expect(t7).toContainText('demora')
    // «A tiempo» is gray (green is reserved for «listo»): neither green nor amber nor red.
    await expect(t21.locator('span.rounded-full').first()).toHaveClass(/neutro/)
    await expect(t4.locator('span.rounded-full').first()).toHaveClass(/proceso/)
    await expect(t7.locator('span.rounded-full').first()).toHaveClass(/alerta/)
  })

  test('time goes up with the clock, without real waits, and changes tone at 10 and 20 minutes', async ({
    page,
  }) => {
    await freezeClock(page)
    await page.goto('/mockups/kds')
    const t21 = ticketEl(page, 21, 'cocina')
    await expect(t21).toContainText('6 min')
    await expect(t21).toContainText('a tiempo')
    await page.clock.runFor(4 * 60_000)
    await expect(t21).toContainText('10 min')
    await expect(t21).toContainText('atención')
    await page.clock.runFor(10 * 60_000)
    await expect(t21).toContainText('20 min')
    await expect(t21).toContainText('demora')
  })

  test('the floor plan and the KDS count time the same: the floor plan delay comes from the same ticket', async ({
    page,
  }) => {
    await freezeClock(page)
    await page.goto('/mockups/floor-plan')
    await expect(tableOnFloorPlan(page, 21)).toHaveAccessibleName(/^Mesa 21: En preparación/)
    await page.clock.runFor(14 * 60_000) // 6 + 14 = 20 min of ticket
    await expect(tableOnFloorPlan(page, 21)).toHaveAccessibleName(/^Mesa 21: Demora/)
  })

  test('the station filter shows only kitchen or only bar', async ({ page }) => {
    await page.goto('/mockups/kds')
    const station = page.getByRole('group', { name: 'Estación' })
    await station.getByRole('button', { name: 'barra' }).click()
    await expect(ticketEl(page, 4, 'barra')).toBeVisible()
    await expect(ticketEl(page, 4, 'cocina')).toHaveCount(0)
    await expect(station.getByRole('button', { name: 'barra' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await station.getByRole('button', { name: 'cocina' }).click()
    await expect(ticketEl(page, 4, 'cocina')).toBeVisible()
    await expect(ticketEl(page, 4, 'barra')).toHaveCount(0)
    await station.getByRole('button', { name: 'todas' }).click()
    await expect(ticketEl(page, 4, 'barra')).toBeVisible()
  })

  test('tapping an item marks it ready and tapping it again unmarks it', async ({ page }) => {
    await page.goto('/mockups/kds')
    const item = ticketEl(page, 21, 'cocina').getByRole('button', { name: /Pinsa/ })
    await expect(item).toHaveAttribute('aria-pressed', 'false')
    await expect(item).toContainText('pendiente')
    await item.click()
    await expect(item).toHaveAttribute('aria-pressed', 'true')
    await expect(item).toContainText('listo')
    await item.click()
    await expect(item).toHaveAttribute('aria-pressed', 'false')
  })

  test('«Todo listo» dispatches the ticket; Deshacer brings it back with the items marked', async ({
    page,
  }) => {
    await freezeClock(page)
    await page.goto('/mockups/kds')
    const card = ticketEl(page, 21, 'cocina')
    await card.getByRole('button', { name: /Pinsa/ }).click()
    await card.getByRole('button', { name: 'Todo listo' }).click()

    await expect(alert(page, 'Mesa 21 despachada (cocina)')).toBeVisible()
    await expect(ticketEl(page, 21, 'cocina')).toHaveCount(0)
    await expect(ticketEl(page, 21, 'barra')).toBeVisible() // the other station is still pending

    await undo(page, 'Mesa 21 despachada (cocina)').click()
    await expect(ticketEl(page, 21, 'cocina')).toBeVisible()
    await expect(
      ticketEl(page, 21, 'cocina').getByRole('button', { name: /Pinsa/ }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  test('dispatching everything for a table leaves it «Listo para servir» on the floor plan', async ({
    page,
  }) => {
    await page.goto('/mockups/kds')
    await ticketEl(page, 21, 'cocina').getByRole('button', { name: 'Todo listo' }).click()
    // With one station pending, the table is still in preparation.
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(tableOnFloorPlan(page, 21)).toHaveAccessibleName(/^Mesa 21: En preparación/)

    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Cocina y barra/ }).click()
    await ticketEl(page, 21, 'barra').getByRole('button', { name: 'Todo listo' }).click()
    await page.getByRole('button', { name: 'Volver' }).click()
    await page.getByRole('link', { name: /Plano de mesas/ }).click()
    await expect(tableOnFloorPlan(page, 21)).toHaveAccessibleName(/^Mesa 21: Listo para servir, /)
    await expect(page.getByText('2 para servir')).toBeVisible()
  })

  test('undoing the last dispatch returns the table to «En preparación»', async ({ page }) => {
    await freezeClock(page)
    await page.goto('/mockups/kds')
    await ticketEl(page, 21, 'cocina').getByRole('button', { name: 'Todo listo' }).click()
    await ticketEl(page, 21, 'barra').getByRole('button', { name: 'Todo listo' }).click()
    await undo(page, 'Mesa 21 despachada (barra)').click()
    await goTo(page, '/mockups/floor-plan')
    await expect(tableOnFloorPlan(page, 21)).toHaveAccessibleName(/^Mesa 21: En preparación/)
    await goTo(page, '/mockups/kds')
    await expect(ticketEl(page, 21, 'barra')).toBeVisible()
    await expect(ticketEl(page, 21, 'cocina')).toHaveCount(0)
  })

  test('dispatching all tickets leaves the message that nothing is pending', async ({ page }) => {
    await page.goto('/mockups/kds')
    for (const [table, station] of [
      [7, 'cocina'],
      [7, 'barra'],
      [4, 'cocina'],
      [4, 'barra'],
      [21, 'cocina'],
      [21, 'barra'],
    ] as const)
      await ticketEl(page, table, station).getByRole('button', { name: 'Todo listo' }).click()
    await expect(page.getByText('No hay comandas pendientes.')).toBeVisible()
  })

  test('dispatching the filtered station does not affect the other', async ({ page }) => {
    await page.goto('/mockups/kds')
    const station = page.getByRole('group', { name: 'Estación' })
    await station.getByRole('button', { name: 'barra' }).click()
    await ticketEl(page, 4, 'barra').getByRole('button', { name: 'Todo listo' }).click()
    await station.getByRole('button', { name: 'todas' }).click()
    await expect(ticketEl(page, 4, 'barra')).toHaveCount(0)
    await expect(ticketEl(page, 4, 'cocina')).toBeVisible()
  })

  test('the options and notes of the sample table reach the kitchen', async ({ page }) => {
    await page.goto('/mockups/kds')
    await expect(ticketEl(page, 7, 'cocina').getByText('Medio')).toBeVisible()
    await expect(ticketEl(page, 7, 'cocina').getByText('¡Sin cebolla!')).toBeVisible()
  })

  test('«Todo listo» turns to success only when all items are marked', async ({ page }) => {
    await page.goto('/mockups/kds')
    const card = ticketEl(page, 21, 'barra')
    const everything = card.getByRole('button', { name: 'Todo listo' })
    const before = await everything.getAttribute('class')
    await card.getByRole('button', { name: /Limonada/ }).click()
    expect(await everything.getAttribute('class')).not.toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
// PIN keypad
// ---------------------------------------------------------------------------------------------

test.describe('PIN keypad (test PIN 2468)', () => {
  const hotkey = (page: Page, d: string) => page.getByRole('button', { name: d, exact: true })
  const write = async (page: Page, pin: string) => {
    for (const d of pin) await hotkey(page, d).click()
  }
  const digits = (page: Page) => page.getByText(/^\d de 4 dígitos$/)
  const erase = (page: Page) => page.getByRole('button', { name: 'Borrar el último dígito' })
  const warning = (page: Page) => page.getByRole('alert')

  test.beforeEach(async ({ page }) => {
    await freezeClock(page)
  })

  test('the correct PIN signs in on the fourth digit, without tapping «aceptar», and is sent only once', async ({
    page,
  }) => {
    await page.goto('/mockups/components')
    await write(page, '2468')
    await expect(alert(page, 'Hola, Mesero 1')).toHaveCount(1)
    await expect(warning(page)).toHaveText('')
    await expect(digits(page)).toHaveText('0 de 4 dígitos') // ready for the next one
  })

  test('shows how many digits are entered and deletes one at a time', async ({ page }) => {
    await page.goto('/mockups/components')
    await expect(digits(page)).toHaveText('0 de 4 dígitos')
    await expect(erase(page)).toBeDisabled()
    await write(page, '24')
    await expect(digits(page)).toHaveText('2 de 4 dígitos')
    await erase(page).click()
    await expect(digits(page)).toHaveText('1 de 4 dígitos')
    await write(page, '468')
    await expect(alert(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('also accepts the register physical keyboard, with Backspace; ignores non-digits', async ({
    page,
  }) => {
    await page.goto('/mockups/components')
    await expect(digits(page)).toBeVisible() // the screen is loaded separately
    await page.keyboard.press('2')
    await page.keyboard.press('9')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('4')
    await page.keyboard.press('6')
    await page.keyboard.press('a')
    await page.keyboard.press('Control+7')
    await expect(digits(page)).toHaveText('3 de 4 dígitos')
    await page.keyboard.press('8')
    await expect(alert(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('a wrong PIN warns and leaves the keypad empty and ready for another attempt', async ({
    page,
  }) => {
    await page.goto('/mockups/components')
    await write(page, '1111')
    await expect(warning(page)).toHaveText('PIN incorrecto')
    await expect(digits(page)).toHaveText('0 de 4 dígitos')
    await write(page, '2468')
    await expect(alert(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('two identical wrong PINs in a row: the keypad is empty and ready each time', async ({
    page,
  }) => {
    await page.goto('/mockups/components')
    await write(page, '1111')
    await expect(digits(page)).toHaveText('0 de 4 dígitos')
    await write(page, '1111')
    await expect(warning(page)).toHaveText('PIN incorrecto')
    await expect(digits(page)).toHaveText('0 de 4 dígitos')
    await write(page, '2468')
    await expect(alert(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('three errors in a row cause a 2 s wait; the keypad locks and unlocks over time', async ({
    page,
  }) => {
    await page.goto('/mockups/components')
    for (let i = 0; i < 3; i++) await write(page, '1111')
    await expect(warning(page)).toHaveText('Demasiados intentos.')
    await expect(page.getByText('Espera 2 s')).toBeVisible()
    await expect(hotkey(page, '5')).toBeDisabled()
    await expect(erase(page)).toBeDisabled()

    // Neither taps nor the physical keyboard get through during the wait.
    await page.keyboard.press('2')
    await expect(digits(page)).toHaveText('0 de 4 dígitos')

    await page.clock.runFor(1_000)
    await expect(page.getByText('Espera 1 s')).toBeVisible()
    await page.clock.runFor(1_500)
    await expect(hotkey(page, '5')).toBeEnabled()
    await expect(warning(page)).not.toContainText('Demasiados intentos')

    await write(page, '2468')
    await expect(alert(page, 'Hola, Mesero 1')).toHaveCount(1)
  })

  test('the fourth error waits twice as long (4 s)', async ({ page }) => {
    await page.goto('/mockups/components')
    for (let i = 0; i < 3; i++) await write(page, '1111')
    await page.clock.runFor(2_500)
    await write(page, '1111')
    await expect(page.getByText('Espera 4 s')).toBeVisible()
  })

  test('the correct PIN during the wait does not sign in', async ({ page }) => {
    await page.goto('/mockups/components')
    for (let i = 0; i < 3; i++) await write(page, '1111')
    await expect(hotkey(page, '2')).toBeDisabled()
    await page.keyboard.type('2468')
    await expect(alert(page, 'Hola, Mesero 1')).toHaveCount(0)
  })

  test('after signing in correctly, the error counter starts from zero', async ({ page }) => {
    await page.goto('/mockups/components')
    for (let i = 0; i < 3; i++) await write(page, '1111')
    await page.clock.runFor(2_500)
    await write(page, '2468')
    await expect(alert(page, 'Hola, Mesero 1')).toHaveCount(1)

    // A single new error is the first of a new streak: it must not cause a wait.
    await write(page, '3333')
    await expect(warning(page)).toHaveText('PIN incorrecto')
    await expect(hotkey(page, '5')).toBeEnabled()
  })

  test('the PIN is not shown on screen: only dots', async ({ page }) => {
    await page.goto('/mockups/components')
    await write(page, '13')
    await expect(page.getByText('13', { exact: true })).toHaveCount(0)
    await expect(digits(page)).toHaveText('2 de 4 dígitos')
  })
})
