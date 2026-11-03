import { newId, type OrderState, type Payment } from '@pos/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TIME } from '../floor/testing'
import type { FloorAnswer } from './live-floor'
import { EMPTY } from './poller'
import { NO_NEWS_MS, type Polled } from './summary'
import { BAR, floorAnswerOf, me, summaryOf } from './testing'

// «Salón», «Cocina», «Mesas abiertas» and the sections of the owner's panel (task 1.11c-2),
// rendered on the server (no browser).

vi.mock('../ui/theme', () => ({
  useTheme: () => ({ theme: 'system', dark: false, select: () => {} }),
}))

const { FloorView, OrderDetail } = await import('./PanelFloor')
const { KitchenView } = await import('./PanelKitchen')
const { PanelFrame, sectionsFor } = await import('./PanelFrame')
const { sectionOf } = await import('./PanelApp')
const { DashboardView } = await import('./Dashboard')
const { placeOf, visibleOrders } = await import('./live-floor')

/** Without tags and with plain spaces, to read it as text. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const ZONE = 'America/Bogota'

const answered = (data = floorAnswerOf()): Polled<FloorAnswer> => ({
  data,
  receivedAt: data.server_now,
  failed: false,
  error: null,
  errorKind: null,
})
/** The phone's clock just as the answer arrived. */
const atAnswer = (data: FloorAnswer) => Date.parse(data.server_now)

const floor = (
  polled: Polled<FloorAnswer>,
  deviceNow: number,
  view: 'list' | 'floorPlan' = 'list',
) =>
  text(
    renderToStaticMarkup(
      <FloorView polled={polled} deviceNow={deviceNow} timeZone={ZONE} initialView={view} />,
    ),
  )

describe('«Salón»', () => {
  it('while the first answer has not arrived it says it is reading', () => {
    expect(floor(EMPTY, Date.parse(TIME))).toContain('Leyendo el salón…')
  })

  it('a failed first answer says so and that it will try again', () => {
    const t = floor({ ...EMPTY, failed: true, error: 'Sin conexión a internet.' }, 0)
    expect(t).toContain('Sin conexión a internet. Lo intentamos de nuevo solos cada 15 s.')
    expect(t.match(/Sin conexión a internet/g)).toHaveLength(1)
    const retry = floor({ ...EMPTY, failed: true, error: 'x', retry: () => {} }, 0)
    expect(retry).toContain('Intentar ahora')
  })

  it('the tables of every zone as a list, with their state, time, total and waiter', () => {
    const data = floorAnswerOf()
    const t = floor(answered(data), atAnswer(data))
    expect(t).toContain('Actualizado 10:20 a. m.')
    expect(t).toContain('Salón')
    expect(t).toContain('Terraza')
    // Mesa 1: a lemonade ready in the kitchen; opened 20 minutes ago; the courtesy is discounted.
    expect(t).toMatch(/1 Listo para llevar Ana Gómez · 20 min \$40\.000/)
    expect(t).toContain('Libre')
    // How many tables are in each state.
    expect(t).toMatch(/Libre 2 /)
    expect(t).toMatch(/Listo para llevar 1 /)
  })

  it('the orders without a table go apart, with their channel', () => {
    const data = floorAnswerOf()
    const t = floor(answered(data), atAnswer(data))
    expect(t).toContain('Pedidos sin mesa 1')
    expect(t).toMatch(/Para llevar[^$]*\$5\.000 1 producto · Ana Gómez · 20 min Tomando pedido/)
  })

  it('the legend says whether it counts the zone shown or every zone', () => {
    const data = floorAnswerOf()
    expect(floor(answered(data), atAnswer(data), 'list')).toContain('En todas las zonas: Libre 2')
    expect(floor(answered(data), atAnswer(data), 'floorPlan')).toContain('En Salón: Libre 1')
  })

  it('the orders without a table go after the tables, with a pill up top that says how many', () => {
    const data = floorAnswerOf()
    const t = floor(answered(data), atAnswer(data))
    expect(t).toContain('Pedidos sin mesa: 1')
    // The pill before the tables; the section after them.
    expect(t.indexOf('Pedidos sin mesa: 1')).toBeLessThan(t.indexOf('Terraza'))
    expect(t.indexOf('Pedidos sin mesa 1')).toBeGreaterThan(t.indexOf('Terraza'))
  })

  it('an order on a table removed from the plan: «Mesas quitadas del plano con cuenta abierta»', () => {
    const data = floorAnswerOf()
    const plan = { ...data.plan, tables: data.plan.tables.filter((m) => m.name !== '1') }
    const t = floor(answered({ ...data, plan }), atAnswer(data))
    expect(t).toContain('Mesas quitadas del plano: 1')
    expect(t).toContain('Mesas quitadas del plano con cuenta abierta 1')
  })

  it('on the plan, the chosen zone with its tables', () => {
    const data = floorAnswerOf()
    const page = renderToStaticMarkup(
      <FloorView
        polled={answered(data)}
        deviceNow={atAnswer(data)}
        timeZone={ZONE}
        initialView="floorPlan"
      />,
    )
    expect(page).toContain('aria-label="Plano de Salón"')
    expect(page).not.toContain('aria-label="Plano de Terraza"')
    expect(text(page)).toContain('Zona')
  })

  it('without tables yet, it says the plan comes from the register PC', () => {
    const data = floorAnswerOf({
      plan: { zones: [], tables: [], elements: [], stations: [] },
      orders: [],
      tickets: [],
    })
    expect(floor(answered(data), atAnswer(data))).toContain('Todavía no hay mesas')
  })

  it('without news from the restaurant the times stop, and it says at what time', () => {
    const data = floorAnswerOf()
    const t = floor(answered(data), atAnswer(data) + NO_NEWS_MS + 10 * 60_000)
    expect(t).toContain('Sin noticias del restaurante desde las 10:20 a. m.')
    expect(t).toContain('Los tiempos se quedaron en las 10:20 a. m.')
    // Still 20 minutes, frozen, not 32.
    expect(t).toContain('20 min a las 10:20 a. m.')
    expect(t).not.toContain('32 min')
  })
})

describe('an order, to read', () => {
  const detail = () => {
    const data = floorAnswerOf()
    const place = placeOf(data)
    const order = visibleOrders(data.orders).find((p) => p.status.tableId !== null)
    if (!order) throw new Error('no order')
    return text(
      renderToStaticMarkup(
        <OrderDetail
          order={order}
          place={place}
          users={data.users}
          time={{ now: atAnswer(data), frozenAt: null }}
          timeZone={ZONE}
        />,
      ),
    )
  }

  it('who serves it, how many they are and since when', () => {
    const t = detail()
    expect(t).toContain('Mesero Ana Gómez')
    expect(t).toContain('Comensales 3')
    expect(t).toContain('Abierto 10:00 a. m. · 20 min')
  })

  it('every product with its state, guest and notes, and the order’s note', () => {
    const t = detail()
    expect(t).toMatch(/1 × Pizza margarita · persona 1 En cocina \$40\.000/)
    // At its price before the courtesy: the courtesy is subtracted once, below.
    expect(t).toMatch(/1 × Limonada sin hielo Listo para llevar \$10\.000/)
    expect(t).toContain('Pedido n.º 1')
    expect(t).toContain('Nota del pedido alérgico al maní')
  })

  it('the courtesy with its reason, and the total, paid and still to pay', () => {
    const t = detail()
    expect(t).toContain('Cortesía en Limonada Cliente frecuente -$10.000')
    expect(t).toContain('Total $40.000')
    expect(t).toContain('Pagado $0')
    expect(t).toContain('Falta por pagar $40.000')
  })

  /** The order of Mesa 1 (pizza $40.000, lemonade $10.000 as a courtesy), changed by `change`. */
  const detailWith = (change: (s: OrderState) => void) => {
    const data = floorAnswerOf()
    const state = data.orders.find((o) => o.tableId !== null)
    if (!state) throw new Error('no order')
    change(state)
    const order = visibleOrders([state])[0]
    if (!order) throw new Error('no order')
    return text(
      renderToStaticMarkup(
        <OrderDetail
          order={order}
          place={placeOf(data)}
          users={data.users}
          time={{ now: atAnswer(data), frozenAt: null }}
          timeZone={ZONE}
        />,
      ),
    )
  }
  const payment = (over: Partial<Payment>): Payment => ({
    id: newId(),
    checkId: null,
    registerShiftId: 's1',
    method: 'card',
    customMethodId: null,
    amount: 0,
    tip: 0,
    roundingAdjustment: 0,
    voided: false,
    refundedSale: 0,
    refundedTip: 0,
    refundIds: [],
    ...over,
  })
  const pay =
    (...payments: Payment[]) =>
    (s: OrderState) => {
      s.payments = Object.fromEntries(payments.map((m) => [m.id, m]))
    }

  it('a discount is subtracted once: the lines before discounts, minus the discounts, are the total', () => {
    const t = detailWith((s) => {
      const pizza = Object.values(s.items).find((i) => i.name === 'Pizza margarita')
      if (!pizza) throw new Error('no pizza')
      // 10 % on the whole order, on top of the courtesy: it falls on the pizza.
      s.discounts.d2 = {
        id: 'd2',
        scope: 'order',
        rule: 'percent',
        value: 1000,
        amounts: { [pizza.id]: 4_000 },
        reason: null,
      }
    })
    expect(t).toMatch(/Pizza margarita · persona 1 En cocina \$40\.000/)
    expect(t).toMatch(/Limonada sin hielo Listo para llevar \$10\.000/)
    expect(t).toContain('Cortesía en Limonada Cliente frecuente -$10.000')
    expect(t).toContain('Descuento en todo el pedido -$4.000')
    // $50.000 − $14.000: never the lines already discounted and the discounts subtracted again.
    expect(t).toContain('Subtotal $50.000 Descuentos -$14.000 Total $36.000')
    expect(t).toContain('Falta por pagar $36.000')
  })

  it('a partial payment with a tip: paid without the tip, the tip apart, what is left to pay', () => {
    const t = detailWith(pay(payment({ amount: 25_000, tip: 3_000 })))
    expect(t).toContain('Total $40.000 Pagado $25.000 Propinas $3.000 Falta por pagar $15.000')
    expect(t).not.toContain('Devuelto')
  })

  it('a partial refund: paid is what was charged minus what was returned', () => {
    const t = detailWith(
      pay(payment({ amount: 40_000, tip: 4_000, refundedSale: 10_000, refundedTip: 1_000 })),
    )
    expect(t).toContain(
      'Total $40.000 Cobrado $40.000 Devuelto -$10.000 Pagado $30.000 Propinas $3.000 Falta por pagar $10.000',
    )
  })

  it('the cash rounding adjustment goes apart and does not leave anything to pay', () => {
    const t = detailWith(
      pay(
        payment({ amount: 12_345 }),
        payment({ method: 'cash', amount: 27_655, roundingAdjustment: -5 }),
      ),
    )
    expect(t).toContain('Pagado $40.000 Redondeo del efectivo -$5 Falta por pagar $0')
    const up = detailWith(
      pay(
        payment({ amount: 12_330 }),
        payment({ method: 'cash', amount: 27_670, roundingAdjustment: 30 }),
      ),
    )
    expect(up).toContain('Redondeo del efectivo +$30 Falta por pagar $0')
  })

  it('a voided payment does not count as paid', () => {
    const t = detailWith(pay(payment({ amount: 40_000, voided: true })))
    expect(t).toContain('Pagado $0 Falta por pagar $40.000')
  })

  it('has no buttons to change anything', () => {
    const data = floorAnswerOf()
    const order = visibleOrders(data.orders)[0]
    if (!order) throw new Error('no order')
    const page = renderToStaticMarkup(
      <OrderDetail
        order={order}
        place={placeOf(data)}
        users={data.users}
        time={{ now: atAnswer(data), frozenAt: null }}
        timeZone={ZONE}
      />,
    )
    expect(page).not.toContain('<button')
  })
})

describe('«Cocina»', () => {
  const kitchen = (polled: Polled<FloorAnswer>, deviceNow: number, station?: string) =>
    text(
      renderToStaticMarkup(
        <KitchenView
          polled={polled}
          deviceNow={deviceNow}
          timeZone={ZONE}
          initialStation={station}
        />,
      ),
    )

  it('the card with its table, number, time and items, without actions', () => {
    const data = floorAnswerOf()
    const page = renderToStaticMarkup(
      <KitchenView polled={answered(data)} deviceNow={atAnswer(data)} timeZone={ZONE} />,
    )
    const t = text(page)
    expect(t).toContain('Mesa 1')
    expect(t).toContain('#12')
    expect(t).toContain('20 min')
    expect(t).toContain('Pizza margarita')
    expect(t).toContain('Limonada · listo')
    expect(t).toContain('Para todo el pedido alérgico al maní')
    expect(t).not.toContain('Listo ') // no «Listo» button
    expect(t).not.toContain('Reimprimir')
  })

  it('counts on time, late and very late with the location’s minutes', () => {
    const data = floorAnswerOf()
    // 20 min with amber from 15 and red from 30: late.
    const t = kitchen(answered(data), atAnswer(data))
    expect(t).toContain('A tiempo 0')
    expect(t).toContain('Demorada 1')
    expect(t).toContain('Muy demorada 0')
    expect(t).toContain('Demorada desde 15 min, muy demorada desde 30 min')
    // A later answer, with the hub still in touch: 30 min is very late.
    const at30 = new Date(Date.parse(TIME) + 30 * 60_000).toISOString()
    const fresh = { ...data, server_now: at30, local: { ...data.local, last_seen_at: at30 } }
    const later = kitchen(answered(fresh), atAnswer(fresh))
    expect(later).toContain('Muy demorada 1')
    expect(later).toContain('30 min')
  })

  it('by station: with several, a filter; the bar has nothing', () => {
    const data = floorAnswerOf()
    const all = kitchen(answered(data), atAnswer(data))
    expect(all).toContain('Todas')
    expect(all).toContain('Barra')
    expect(kitchen(answered(data), atAnswer(data), BAR)).toContain('Nada en cocina por ahora.')
  })

  it('«Listos para llevar» when the whole card is ready', () => {
    const data = floorAnswerOf()
    const tickets = data.tickets.map((t) => ({ ...t, ready: true }))
    const t = kitchen(answered({ ...data, tickets }), atAnswer(data))
    expect(t).toContain('Listos para llevar (1)')
    expect(t).toContain('Mesa 1 2 productos')
    const one = {
      ...data,
      tickets: tickets.map((c) => ({ ...c, item_ids: c.item_ids.slice(0, 1) })),
    }
    expect(kitchen(answered(one), atAnswer(data))).toContain('Mesa 1 1 producto ')
  })

  it('without news, the times stop', () => {
    const data = floorAnswerOf()
    const t = kitchen(answered(data), atAnswer(data) + NO_NEWS_MS + 30 * 60_000)
    expect(t).toContain('Sin noticias del restaurante desde las 10:20 a. m.')
    expect(t).toContain('Los tiempos se quedaron en las 10:20 a. m.')
    expect(t).toContain('Demorada 1')
  })

  it('while reading', () => {
    expect(kitchen(EMPTY, 0)).toContain('Leyendo lo de cocina…')
  })
})

describe('«Mesas abiertas» on the dashboard', () => {
  const place = { timeZone: ZONE, rules: null }
  const dashboard = (summary = summaryOf()) =>
    text(
      renderToStaticMarkup(
        <DashboardView
          polled={{ data: summary, receivedAt: summary.server_now, failed: false, error: null }}
          place={place}
        />,
      ),
    )

  it('tables, orders when they differ, guests and the net of what is open', () => {
    const t = dashboard()
    expect(t).toContain('Mesas abiertas ahora 6 mesas · 5 pedidos · 14 comensales')
    expect(t).toContain('$486.000 en cuentas abiertas')
    expect(t).toContain('Ver el salón')
  })

  it('a reopened account that went down (total below zero): $0 and why, never a minus', () => {
    const t = dashboard(summaryOf({ open: { orders: 1, tables: 1, guests: 2, total: -8_000 } }))
    expect(t).toContain('$0 en cuentas abiertas')
    expect(t).toContain(
      'Las cuentas reabiertas bajaron $8.000 de lo que ya está en ventas: se descuenta al cerrarlas.',
    )
    expect(t).not.toContain('-$8.000')
    // A total that is not negative has no note.
    expect(dashboard()).not.toContain('Las cuentas reabiertas')
    // Zero is just zero.
    expect(dashboard(summaryOf({ open: { orders: 1, tables: 1, guests: 2, total: 0 } }))).toContain(
      '$0 en cuentas abiertas',
    )
  })

  it('on the phone the total goes under the text; at the right from 640 px', () => {
    const html = renderToStaticMarkup(
      <DashboardView
        polled={{ data: summaryOf(), receivedAt: null, failed: false, error: null }}
        place={place}
      />,
    )
    expect(html).toMatch(/flex-col[^"]*sm:flex-row[^>]*>(?:(?!<\/button>).)*\$486\.000/)
  })

  it('with nothing open, it says so; from an older cloud, no card', () => {
    expect(dashboard(summaryOf({ open: { orders: 0, tables: 0, guests: 0, total: 0 } }))).toContain(
      'Ninguna mesa abierta',
    )
    expect(dashboard(summaryOf({ open: undefined }))).not.toContain('Mesas abiertas')
  })
})

describe('the sections', () => {
  const frame = (permissions: string[], route = '/floor') =>
    renderToStaticMarkup(
      <PanelFrame me={me(permissions)} route={route} title="Salón" onSignOut={() => {}}>
        <p>contenido</p>
      </PanelFrame>,
    )
  /** The names in the phone's bar (the last nav). */
  const phoneBar = (html: string) => text(html.slice(html.lastIndexOf('<nav')))

  it('with the reports: Hoy · Salón · Cocina · Alertas · Más on the phone, all on wide screens', () => {
    const html = frame(['remote_access', 'view_reports'])
    expect(phoneBar(html)).toMatch(/Hoy Salón Cocina Alertas Más/)
    expect(phoneBar(html)).not.toContain('Reportes')
    const wide = text(html.slice(html.indexOf('<nav'), html.indexOf('</nav>')))
    expect(wide).toMatch(/Hoy Salón Cocina Alertas Caja Reportes/)
  })

  it('on a narrow phone a long name is cut, never pushes the other tabs out', () => {
    const bar = (html: string) => html.slice(html.lastIndexOf('<nav'))
    const html = bar(frame(['remote_access', 'view_reports']))
    expect(html.match(/<button[^>]*min-w-0/g)?.length).toBe(5)
    expect(html.match(/class="max-w-full truncate"/g)?.length).toBe(4)
  })

  it('with only remote_access: the floor and the kitchen, and no «Más»', () => {
    const html = frame(['remote_access'])
    expect(phoneBar(html).trim()).toBe('Salón Cocina')
    expect(text(html)).not.toContain('Hoy')
    expect(sectionsFor(me(['remote_access'])).map((s) => s.route)).toEqual(['/floor', '/kitchen'])
  })

  it('«Más» is marked when one of its sections is open', () => {
    const html = frame(['remote_access', 'view_reports'], '/reports')
    expect(html.slice(html.lastIndexOf('<nav'))).toMatch(/aria-current="page"[^>]*>.*Más/)
  })

  it('`/` is «Hoy», or «Salón» for whoever cannot see the reports; an unknown route is `/`', () => {
    const boss = me(['remote_access', 'view_reports'])
    const host = me(['remote_access'])
    expect(sectionOf('/', boss)).toBe('/')
    expect(sectionOf('/', host)).toBe('/floor')
    expect(sectionOf('/nada', host)).toBe('/floor')
    expect(sectionOf('/kitchen', host)).toBe('/kitchen')
    expect(sectionOf('/reports', host)).toBe('/reports')
  })
})
