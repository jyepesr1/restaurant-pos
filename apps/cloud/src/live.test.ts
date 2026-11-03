import { newId, type OrderEvent } from '@pos/core'
import { kitchenTickets, type LocalEvent, openOrders } from '@pos/sync'
import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  cardPaymentData,
  event,
  itemCopy,
  WAITER,
} from '../../../packages/core/src/testing/factory'
import { actionArb } from '../../../packages/core/src/testing/simulator'
import { buildHistory, type HistoryPlan } from '../../../packages/sync/src/testing/histories'
import { type AuthenticatedHub, inRestaurant } from './cloud'
import {
  candidates,
  LIVE_MAX_ROUNDS,
  LIVE_WINDOW_DAYS,
  type LiveFloor,
  liveOrders,
  openSummary,
  ticketJson,
} from './live'
import { addDays } from './panel'
import { hubsOfLocation, type Scope } from './reports'
import {
  cookieFrom,
  panelRequest,
  putSnapshot,
  type RemoteUser,
  remoteUser,
  slugOf,
} from './testing/panel'
import { createWorld, type TestHub, type World } from './testing/world'

// The live floor of the owner's panel (task 1.11c-2, docs/PANEL.md#en-vivo-111c-2): the cloud
// computes the open orders and the kitchen with the devices' own projections, over what the hub
// uploaded, and gets exactly what a device that has every event gets.

let m: World
let hub: TestHub

beforeEach(async () => {
  m = await createWorld()
  hub = await m.newHub()
})

async function upload(h: AuthenticatedHub, events: readonly OrderEvent[]) {
  for (let i = 0; i < events.length; i += 500) {
    const r = await m.cloud.receiveEvents(h, events.slice(i, i + 500))
    expect(r.every((x) => x.status === 'saved' || x.status === 'already_stored')).toBe(true)
  }
}

const numbered = (events: readonly OrderEvent[]) =>
  events.map((e, i) => ({ ...e, sequence: i + 1 }))

/** What a device that has every event shows (all confirmed, in the hub's order). */
function onDevice(events: readonly OrderEvent[]) {
  const locals: LocalEvent[] = [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((event, position) => ({ event, status: 'confirmed', own: false, position }))
  const orders = openOrders(locals)
  return { orders, tickets: kitchenTickets(locals, orders) }
}

const scopeOf = async (h: TestHub): Promise<Scope> => ({
  restaurantId: h.restaurantId,
  hubIds: await inRestaurant(m.sql, h.restaurantId, (tx) =>
    hubsOfLocation(tx, h.restaurantId, h.hub.locationId),
  ),
})

const fromCloud = async (h: TestHub, today = '2026-10-26') => {
  const scope = await scopeOf(h)
  return inRestaurant(m.sql, h.restaurantId, (tx) =>
    liveOrders(tx, scope, addDays(today, -LIVE_WINDOW_DAYS)),
  )
}

const plan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' }),
  days: fc.array(fc.nat(2), { minLength: 1, maxLength: 150 }),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})

/** An order with one item sent to the kitchen, on a table. */
function sentOrder(fields: Partial<OrderEvent> = {}, table = newId()) {
  const order = newId()
  const copy = itemCopy({ name: 'Pizza margarita' })
  const station = newId()
  const ticket = newId()
  const events = [
    event(order, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 3 }, fields),
    event(order, 'ItemAdded', copy, fields),
    event(
      order,
      'ItemsSent',
      { tickets: [{ ticket_id: ticket, station_id: station, item_ids: [copy.item_id] }] },
      { ...fields, assignments: { ticket_numbers: { [ticket]: 7 } } },
    ),
  ]
  return { order, copy, station, ticket, table, events }
}

describe('the same floor and kitchen as a device', () => {
  it('with random histories (moves, merges, reopened, closed and canceled orders)', async () => {
    let withTickets = 0
    await fc.assert(
      fc.asyncProperty(plan, async (p) => {
        const h = buildHistory(p)
        const target = await m.newHub()
        await upload(target.hub, h.events)
        const expected = onDevice(h.events)
        const live = await fromCloud(target)
        expect(live.rounds).toBeLessThanOrEqual(LIVE_MAX_ROUNDS)
        expect(live.orders).toEqual(expected.orders)
        expect(live.tickets.map(ticketJson)).toEqual(expected.tickets.map(ticketJson))
        expect(openSummary(live.orders)).toEqual(openSummary(expected.orders))
        if (expected.tickets.length > 0) withTickets++
      }),
      { seed: 20_261_102, numRuns: 40 },
    )
    // The property says something about the kitchen, not only about empty lists.
    expect(withTickets).toBeGreaterThan(5)
  })

  it('a dish moved out of an order that was then canceled stays on its ticket, at its new table', async () => {
    const a = sentOrder()
    const b = sentOrder()
    const moved = {
      item: a.copy,
      status: 'sent' as const,
      voided_quantity: 0,
      added_by: WAITER,
    }
    const events = numbered([
      ...a.events,
      ...b.events,
      event(a.order, 'ItemsMoved', { target_order_id: b.order, items: [moved] }),
      event(a.order, 'OrderCanceled', {}, { reason: 'Se pasaron a otra mesa' }),
    ])
    await upload(hub.hub, events)
    const live = await fromCloud(hub)
    expect(live.orders.map((p) => p.status.id)).toEqual([b.order])
    // The canceled order's ticket was read too: the dish is in B's kitchen, under A's ticket.
    expect(live.rounds).toBe(2)
    const tickets = live.tickets.map(ticketJson)
    expect(tickets).toEqual(onDevice(events).tickets.map(ticketJson))
    expect(tickets).toContainEqual(
      expect.objectContaining({ ticket_id: a.ticket, order_id: b.order, number: 7 }),
    )
  })

  it(`only orders whose last open or reopen is at most ${LIVE_WINDOW_DAYS} days old`, async () => {
    const today = '2026-10-26'
    const old = sentOrder({ business_day: addDays(today, -LIVE_WINDOW_DAYS - 1) })
    const edge = sentOrder({ business_day: addDays(today, -LIVE_WINDOW_DAYS) })
    // Opened and closed long ago, reopened yesterday: it counts.
    const reopened = newId()
    const long = { business_day: '2026-08-01' }
    const events = numbered([
      ...old.events,
      ...edge.events,
      event(reopened, 'OrderOpened', { channel: 'takeout', table_id: null, guests: 1 }, long),
      event(reopened, 'OrderClosed', {}, long),
      event(
        reopened,
        'OrderReopened',
        {},
        { business_day: addDays(today, -1), reason: 'Faltó cobrar' },
      ),
    ])
    await upload(hub.hub, events)
    const live = await fromCloud(hub, today)
    expect(live.orders.map((p) => p.status.id).sort()).toEqual([edge.order, reopened].sort())
    expect(onDevice(events).orders.map((p) => p.status.id)).toContain(old.order)
  })

  it('a location without hubs or events: nothing open, without errors', async () => {
    expect(await fromCloud(hub)).toEqual({
      orders: [],
      tickets: [],
      closedNet: new Map(),
      asOf: null,
      rounds: 1,
    })
    const none = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      liveOrders(tx, { restaurantId: hub.restaurantId, hubIds: [] }, '2026-10-01'),
    )
    expect(none).toEqual({ orders: [], tickets: [], closedNet: new Map(), asOf: null, rounds: 0 })
  })
})

describe('which orders are candidates', () => {
  it('an order merged into another is not one (its kitchen still shows through the target)', async () => {
    const source = sentOrder()
    const target = sentOrder()
    const moved = {
      item: source.copy,
      status: 'sent' as const,
      voided_quantity: 0,
      added_by: WAITER,
    }
    const events = numbered([
      ...source.events,
      ...target.events,
      event(target.order, 'OrdersMerged', { source_order_id: source.order, items: [moved] }),
    ])
    await upload(hub.hub, events)
    const scope = await scopeOf(hub)
    const found = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      candidates(tx, scope, '2026-10-01'),
    )
    expect(found).toEqual([target.order])
    const live = await fromCloud(hub)
    expect(live.orders.map((p) => p.status.id)).toEqual([target.order])
    expect(live.tickets.map(ticketJson)).toEqual(onDevice(events).tickets.map(ticketJson))
  })
})

describe('«Mesas abiertas»', () => {
  it('counts the orders that hold a table, their tables (merged ones too), guests and net', async () => {
    const a = sentOrder()
    const b = sentOrder()
    const extra = newId()
    const takeout = newId()
    const events = numbered([
      ...a.events,
      ...b.events,
      event(a.order, 'TablesMerged', { table_ids: [extra] }),
      event(takeout, 'OrderOpened', { channel: 'takeout', table_id: null, guests: 1 }),
      event(takeout, 'ItemAdded', itemCopy({ unit_price: 10_000 })),
    ])
    await upload(hub.hub, events)
    expect(openSummary((await fromCloud(hub)).orders)).toEqual({
      orders: 3,
      tables: 3,
      guests: 7,
      total: 40_900 * 2 + 10_000,
    })
  })

  // D2 (docs/KPIS.md#mesas-abiertas): what a closed check had is already in the sales; reopened, it
  // adds only what changed since its last close.
  it('a reopened check adds only its net now minus its net at the last close', async () => {
    const a = sentOrder()
    const paid = (amount: number) => cardPaymentData(amount)
    const extra = itemCopy({ unit_price: 10_000 })
    const later = itemCopy({ unit_price: 5_000 })
    const events = numbered([
      ...a.events,
      event(a.order, 'PaymentRecorded', paid(40_900)),
      event(a.order, 'OrderClosed', {}),
      event(a.order, 'OrderReopened', {}, { reason: 'Faltó un postre' }),
      event(a.order, 'ItemAdded', extra),
      event(a.order, 'PaymentRecorded', paid(10_000)),
      event(a.order, 'OrderClosed', {}),
      event(a.order, 'OrderReopened', {}, { reason: 'Otro postre' }),
      event(a.order, 'ItemAdded', later),
    ])
    await upload(hub.hub, events)
    const live = await fromCloud(hub)
    // Net now 55.900; at the last close 50.900 (already in sales): 5.000 still to come.
    expect(live.closedNet).toEqual(new Map([[a.order, 50_900]]))
    expect(openSummary(live.orders, live.closedNet)).toEqual({
      orders: 1,
      tables: 1,
      guests: 3,
      total: 5_000,
    })
  })

  it('a reopened check where something was voided subtracts (negative)', async () => {
    const a = sentOrder()
    const card = cardPaymentData(50_900)
    const events = numbered([
      ...a.events,
      event(a.order, 'ItemAdded', itemCopy({ unit_price: 10_000 })),
      event(a.order, 'PaymentRecorded', card),
      event(a.order, 'OrderClosed', {}),
      event(a.order, 'OrderReopened', {}, { reason: 'Cobró de más' }),
      // The payment is voided first: otherwise the void would leave a negative balance.
      event(
        a.order,
        'PaymentVoided',
        { payment_id: card.payment_id, register_shift_id: card.register_shift_id },
        { reason: 'Se cobra de nuevo' },
      ),
      event(
        a.order,
        'ItemVoided',
        { item_id: a.copy.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        { reason: 'No salió' },
      ),
    ])
    await upload(hub.hub, events)
    const live = await fromCloud(hub)
    expect(openSummary(live.orders, live.closedNet).total).toBe(-40_900)
  })
})

// ── The route ────────────────────────────────────────────────────────────

describe('GET /v1/panel/floor', () => {
  let slug: string
  let ana: RemoteUser
  const PASSWORD = 'clave-de-ana-2026'
  const TABLE = newId()
  const catalog = {
    version: 3,
    restaurant: { name: 'R', sessionIdleMin: 5, kitchenYellowMin: 6, kitchenRedMin: 12 },
    zones: [{ id: 'z1', name: 'Salón', level: 1 }],
    tables: [
      {
        id: TABLE,
        zoneId: 'z1',
        name: '1',
        x: 0,
        y: 0,
        width: 80,
        height: 80,
        rotation: 0,
        shape: 'round',
        capacity: 4,
        secret: 'no viaja',
      },
    ],
    elements: [],
    stations: [{ id: 's1', name: 'Cocina', prints: true }],
    categories: [{ id: 'c1', name: 'Pizzas', stationId: 's1', products: [] }],
  }

  beforeEach(async () => {
    slug = await slugOf(m, hub.restaurantId)
    ana = remoteUser('ana', PASSWORD, ['remote_access'], 'Ana Pérez')
    expect(await putSnapshot(m, hub, 'remote_users', [ana])).toBe(204)
    expect(
      await putSnapshot(m, hub, 'people', [
        { id: WAITER, name: 'Mesero Juan', role_id: null, active: true },
      ]),
    ).toBe(204)
  })

  async function signedIn(user = 'ana', password = PASSWORD) {
    const r = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
      body: { restaurant: slug, username: user, password },
    })
    expect(r.status).toBe(200)
    return cookieFrom(r) as string
  }
  const get = async (route: string, cookie: string | null) =>
    panelRequest(m, 'GET', route, { cookie })
  const floor = async (cookie: string, query = '') => {
    const r = await get(`/v1/panel/floor${query}`, cookie)
    expect(r.status).toBe(200)
    return (await r.json()) as LiveFloor
  }

  it('with only remote_access: the floor yes, the dashboard and the reports no', async () => {
    const cookie = await signedIn()
    expect((await get('/v1/panel/floor', cookie)).status).toBe(200)
    for (const route of ['/v1/panel/summary', '/v1/panel/reports']) {
      const r = await get(route, cookie)
      expect(r.status, route).toBe(403)
      expect(((await r.json()) as { message: string }).message).toBe(
        'No tienes permiso para ver los reportes',
      )
    }
    expect((await get('/v1/panel/floor', null)).status).toBe(401)
    expect((await panelRequest(m, 'POST', '/v1/panel/floor', { cookie })).status).toBe(404)
  })

  it('the open orders, the kitchen cards, the plan, the timers and the names', async () => {
    expect(await putSnapshot(m, hub, 'catalog', catalog)).toBe(204)
    const a = sentOrder({ received_at: '2026-10-26T14:50:00.000Z' }, TABLE)
    await upload(hub.hub, numbered(a.events))
    const body = await floor(await signedIn())
    expect(Object.keys(body).sort()).toEqual(
      [
        'as_of',
        'local',
        'orders',
        'plan',
        'plan_version',
        'server_now',
        'tickets',
        'timers',
        'today',
        'users',
      ].sort(),
    )
    expect(body.server_now).toBe('2026-10-26T15:00:00.000Z')
    expect(body.today).toBe('2026-10-26')
    expect(body.as_of).toBe('2026-10-26T14:50:00.000Z')
    expect(body.timers).toEqual({ yellow: 6, red: 12 })
    expect(body.orders.map((o) => o.id)).toEqual([a.order])
    expect(body.orders[0]?.items[a.copy.item_id]?.name).toBe('Pizza margarita')
    expect(body.tickets).toEqual([
      {
        key: `${a.ticket}:${a.order}`,
        ticket_id: a.ticket,
        order_id: a.order,
        station_id: a.station,
        number: 7,
        sent_at: '2026-10-26T14:50:00.000Z',
        item_ids: [a.copy.item_id],
        ready: false,
      },
    ])
    expect(body.users).toEqual({ [WAITER]: 'Mesero Juan' })
    // Only what the plan draws: neither the products nor fields the panel does not use.
    const { secret: _secret, ...table } = catalog.tables[0] as (typeof catalog.tables)[number]
    expect(body.plan).toEqual({
      zones: catalog.zones,
      tables: [table],
      elements: [],
      stations: catalog.stations,
    })
    expect(JSON.stringify(body)).not.toContain('Pizzas')
    expect(body.local).toMatchObject({ last_event_at: '2026-10-26T14:50:00.000Z' })
  })

  it('the plan travels only when the panel does not have that version', async () => {
    expect(await putSnapshot(m, hub, 'catalog', catalog)).toBe(204)
    const cookie = await signedIn()
    const first = await floor(cookie)
    expect(first.plan_version).toEqual(expect.any(String))
    expect(first.plan?.tables).toHaveLength(1)
    const again = await floor(cookie, `?plan=${encodeURIComponent(first.plan_version ?? '')}`)
    expect(again.plan).toBeNull()
    expect(again.plan_version).toBe(first.plan_version)
    expect(again.timers).toEqual({ yellow: 6, red: 12 })
    // The hub uploads another catalog: another version, and the plan comes again.
    expect(
      await putSnapshot(m, hub, 'catalog', {
        ...catalog,
        zones: [{ id: 'z1', name: 'Terraza', level: 1 }],
      }),
    ).toBe(204)
    const changed = await floor(cookie, `?plan=${encodeURIComponent(first.plan_version ?? '')}`)
    expect(changed.plan_version).not.toBe(first.plan_version)
    expect(changed.plan?.zones[0]?.name).toBe('Terraza')
    // Any other value is just an unknown version.
    expect((await floor(cookie, `?plan=${'x'.repeat(500)}`)).plan?.zones).toHaveLength(1)
  })

  it('without a catalog: no plan and the default timers; a malformed piece is left out alone', async () => {
    const cookie = await signedIn()
    const none = await floor(cookie)
    expect(none.plan_version).toBeNull()
    expect(none.plan).toBeNull()
    expect(none.timers).toEqual({ yellow: 10, red: 20 })
    expect(none.orders).toEqual([])
    expect(none.as_of).toBeNull()
    expect(
      await putSnapshot(m, hub, 'catalog', {
        ...catalog,
        restaurant: { ...catalog.restaurant, kitchenYellowMin: 'diez', kitchenRedMin: -3 },
        // One table without its geometry among good ones; the stations are not a list.
        tables: [{ id: 'broken' }, ...catalog.tables],
        stations: { s1: 'Cocina' },
      }),
    ).toBe(204)
    const bad = await floor(cookie)
    expect(bad.plan?.tables.map((t) => t.id)).toEqual([TABLE])
    expect(bad.plan?.tables[0]).not.toHaveProperty('secret')
    expect(bad.plan?.zones).toEqual(catalog.zones)
    expect(bad.plan?.stations).toEqual([])
    expect(bad.timers).toEqual({ yellow: 10, red: 20 })
  })

  it('the dashboard brings «Mesas abiertas»', async () => {
    const boss = remoteUser('jefe', 'clave-del-jefe-1', ['remote_access', 'view_reports'])
    expect(await putSnapshot(m, hub, 'remote_users', [ana, boss])).toBe(204)
    await upload(hub.hub, numbered(sentOrder().events))
    const r = await get('/v1/panel/summary', await signedIn('jefe', 'clave-del-jefe-1'))
    expect(r.status).toBe(200)
    expect(((await r.json()) as { open: unknown }).open).toEqual({
      orders: 1,
      tables: 1,
      guests: 3,
      total: 40_900,
    })
  })
})

describe('isolation', () => {
  it('another restaurant, or another location of the same one, never shows up', async () => {
    const other = await m.newHub()
    const sibling = await m.newHub(hub.restaurantId)
    const mine = sentOrder()
    await upload(hub.hub, numbered(mine.events))
    await upload(other.hub, numbered(sentOrder().events))
    await upload(sibling.hub, numbered(sentOrder().events))
    const live = await fromCloud(hub)
    expect(live.orders.map((p) => p.status.id)).toEqual([mine.order])
    expect(live.tickets.map((t) => t.order.status.id)).toEqual([mine.order])
    // The other restaurant's hub ids, asked for from this restaurant, give nothing.
    const leak = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      liveOrders(tx, { restaurantId: hub.restaurantId, hubIds: [other.hub.id] }, '2026-10-01'),
    )
    expect(leak.orders).toEqual([])
  })

  it('through the API, each session sees only its own restaurant’s floor', async () => {
    const other = await m.newHub()
    const tenants = [hub, other]
    const opened: string[] = []
    const cookies: string[] = []
    for (const [i, t] of tenants.entries()) {
      const user = remoteUser(`user${i}`, `clave-numero-${i}-x`, ['remote_access'])
      expect(await putSnapshot(m, t, 'remote_users', [user])).toBe(204)
      const o = sentOrder()
      opened.push(o.order)
      await upload(t.hub, numbered(o.events))
      const r = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
        body: {
          restaurant: await slugOf(m, t.restaurantId),
          username: user.username,
          password: `clave-numero-${i}-x`,
        },
      })
      cookies.push(cookieFrom(r) as string)
    }
    for (const [i, cookie] of cookies.entries()) {
      const body = (await (
        await panelRequest(m, 'GET', '/v1/panel/floor', { cookie })
      ).json()) as LiveFloor
      expect(body.orders.map((o) => o.id)).toEqual([opened[i]])
    }
  })
})
