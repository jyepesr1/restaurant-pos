import {
  ALERT_EVENT_TYPES,
  alerts,
  newId,
  type OrderEvent,
  type RestaurantConfig,
  report,
} from '@pos/core'
import { type HubStore, MemoryStore, ordersOf, reportData } from '@pos/sync'
import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { actionArb } from '../../../packages/core/src/testing/simulator'
import { buildHistory, DAYS, type HistoryPlan } from '../../../packages/sync/src/testing/histories'
import { ALERT_DAYS, dayAlerts } from './alerts'
import { type AuthenticatedHub, inRestaurant } from './cloud'
import { type AlertsAnswer, addDays } from './panel'
import { configFrom, hubsOfLocation, type Scope } from './reports'
import { cookieFrom, panelRequest, putSnapshot, remoteUser, slugOf } from './testing/panel'
import { createWorld, type TestHub, type World } from './testing/world'

// «Alertas» in the owner's panel (task 1.11c-2, docs/PANEL.md#alertas): the cloud computes them
// with `alerts()` of @pos/core over what the hub uploaded, and gets what the hub's own store gives.

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

const scopeOf = async (h: TestHub): Promise<Scope> => ({
  restaurantId: h.restaurantId,
  hubIds: await inRestaurant(m.sql, h.restaurantId, (tx) =>
    hubsOfLocation(tx, h.restaurantId, h.hub.locationId),
  ),
})

const CONFIG: RestaurantConfig = configFrom({})

const fromCloud = async (h: TestHub, day: string, config = CONFIG) => {
  const scope = await scopeOf(h)
  return inRestaurant(m.sql, h.restaurantId, (tx) => dayAlerts(tx, scope, day, config))
}

/** The same alerts from the hub's store, with every event at hand. */
function inHub(events: readonly OrderEvent[], day: string, config = CONFIG) {
  const store: HubStore = new MemoryStore()
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
  const data = reportData(store, day, day)
  const r = report({
    ...data,
    config: { sales_by_waiter: config.sales_by_waiter, rounding_mode: config.rounding_mode },
  })
  const ids = new Set([
    ...store.periodEvents(ALERT_EVENT_TYPES, day, day).map((e) => e.aggregate_id),
    ...data.events
      .filter((e) =>
        ['ItemVoided', 'OrderCanceled', 'PaymentVoided', 'RefundRecorded'].includes(e.type),
      )
      .map((e) => e.aggregate_id),
  ])
  return alerts({
    day,
    voids: r.voids,
    cancellations: r.cancellations,
    orders: new Map([...ids].map((id) => [id, store.aggregateEvents(id)])),
    registerClosings: data.registerClosings,
    threshold: config.register_variance_threshold,
  })
}

const plan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' }),
  days: fc.array(fc.nat(2), { minLength: 1, maxLength: 150 }),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})

const TODAY = '2026-10-26'
const ANA = newId()
const CARLOS = newId()
const TABLE = newId()
const SHIFT = newId()
const REGISTER = newId()

/** Mesa 3 with a pinsa sent to the kitchen and voided by Ana, authorized by Carlos. */
function voidedPinsa(day = TODAY) {
  const order = newId()
  const copy = itemCopy({ name: 'Pinsa', unit_price: 20_900 })
  const at = { business_day: day, received_at: `${day}T20:00:00.000Z` }
  return {
    order,
    events: [
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: TABLE, guests: 2 }, at),
      event(order, 'ItemAdded', copy, at),
      event(
        order,
        'ItemsSent',
        { tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [copy.item_id] }] },
        at,
      ),
      event(
        order,
        'ItemVoided',
        { item_id: copy.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        { ...at, user_id: ANA, authorized_by_id: CARLOS, reason: 'El cliente cambió de idea' },
      ),
    ],
  }
}

/** A shift closed today with a shortage of $5.000 in cash. */
function shortRegister() {
  const order = newId()
  const count = newId()
  const reg = {
    aggregate_type: 'register_shift' as const,
    business_day: TODAY,
    user_id: CARLOS,
    device_id: REGISTER,
    received_at: `${TODAY}T23:00:00.000Z`,
  }
  return [
    event(SHIFT, 'ShiftOpened', { register_id: REGISTER, base: 100_000 }, reg),
    event(
      order,
      'OrderOpened',
      { channel: 'takeout', table_id: null, guests: 1 },
      { business_day: TODAY },
    ),
    event(order, 'ItemAdded', itemCopy({ unit_price: 50_000 })),
    event(order, 'PaymentRecorded', cashPaymentData(50_000, { register_shift_id: SHIFT }), {
      business_day: TODAY,
      device_id: REGISTER,
    }),
    event(
      SHIFT,
      'CashCountRecorded',
      { cash_count_id: count, tally: [{ value: 1_000, quantity: 145 }], counted_cash: 145_000 },
      reg,
    ),
    event(
      SHIFT,
      'ShiftClosed',
      {
        cash_count_id: count,
        expected_cash: 150_000,
        counted_cash: 145_000,
        variance: -5_000,
        justification: 'Se dio mal un cambio',
        other_methods: [],
      },
      reg,
    ),
  ]
}

describe('the same alerts as the hub', () => {
  it('with random histories (voids, cancellations, discounts, payments voided and refunded, reopened orders)', async () => {
    let some = 0
    await fc.assert(
      fc.asyncProperty(plan, fc.nat(2), async (p, d) => {
        const h = buildHistory(p)
        const target = await m.newHub()
        await upload(target.hub, h.events)
        const day = DAYS[d] as string
        const expected = inHub(h.events, day)
        const cloud = await fromCloud(target, day)
        expect(cloud.alerts).toEqual(expected)
        if (expected.length > 0) some++
      }),
      { seed: 20_261_102, numRuns: 30 },
    )
    expect(some).toBeGreaterThan(5)
  })

  it('a location without hubs or events: none, without errors', async () => {
    expect(await fromCloud(hub, TODAY)).toEqual({ alerts: [], asOf: null })
    const none = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      dayAlerts(tx, { restaurantId: hub.restaurantId, hubIds: [] }, TODAY, CONFIG),
    )
    expect(none).toEqual({ alerts: [], asOf: null })
  })

  it('the register variance follows the location’s threshold', async () => {
    await upload(hub.hub, numbered(shortRegister()))
    expect((await fromCloud(hub, TODAY)).alerts.map((a) => a.type)).toEqual(['register_variance'])
    const lenient = { ...CONFIG, register_variance_threshold: 10_000 }
    expect((await fromCloud(hub, TODAY, lenient)).alerts).toEqual([])
  })
})

describe('isolation', () => {
  it('another restaurant, or another location of the same one, never shows up', async () => {
    const other = await m.newHub()
    const sibling = await m.newHub(hub.restaurantId)
    const mine = voidedPinsa()
    await upload(hub.hub, numbered(mine.events))
    await upload(other.hub, numbered(voidedPinsa().events))
    await upload(sibling.hub, numbered(voidedPinsa().events))
    const list = (await fromCloud(hub, TODAY)).alerts
    expect(list.map((a) => a.order?.id)).toEqual([mine.order])
    const leak = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      dayAlerts(tx, { restaurantId: hub.restaurantId, hubIds: [other.hub.id] }, TODAY, CONFIG),
    )
    expect(leak.alerts).toEqual([])
  })
})

// ── The route ────────────────────────────────────────────────────────────

describe('GET /v1/panel/alerts', () => {
  const PASSWORD = 'clave-de-prueba-1'
  async function signedIn(h: TestHub, permissions = ['remote_access', 'view_reports']) {
    const user = remoteUser(`u${newId().slice(-6).toLowerCase()}`, PASSWORD, permissions)
    expect(await putSnapshot(m, h, 'remote_users', [user])).toBe(204)
    expect(
      await putSnapshot(m, h, 'people', [
        { id: ANA, name: 'Ana', role_id: null, active: true },
        { id: CARLOS, name: 'Carlos', role_id: null, active: true },
      ]),
    ).toBe(204)
    const r = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
      body: {
        restaurant: await slugOf(m, h.restaurantId),
        username: user.username,
        password: PASSWORD,
      },
    })
    expect(r.status).toBe(200)
    return cookieFrom(r) as string
  }
  const get = (cookie: string | null, query = '') =>
    panelRequest(m, 'GET', `/v1/panel/alerts${query}`, { cookie })

  it('asks for a session and for «Ver todos los reportes»', async () => {
    expect((await get(null)).status).toBe(401)
    const r = await get(await signedIn(hub, ['remote_access']))
    expect(r.status).toBe(403)
    expect(((await r.json()) as { message: string }).message).toBe(
      'No tienes permiso para ver los reportes',
    )
  })

  it('a day that is not valid, still to come or over 14 days ago is a 400', async () => {
    const cookie = await signedIn(hub)
    for (const [day, message] of [
      ['2026-13-01', 'Fecha inválida'],
      ['ayer', 'Fecha inválida'],
      ['2026-10-27', 'Ese día todavía no ha llegado'],
      [addDays(TODAY, -ALERT_DAYS - 1), `Las alertas se ven hasta ${ALERT_DAYS} días atrás`],
    ]) {
      const r = await get(cookie, `?day=${day}`)
      expect(r.status, day).toBe(400)
      expect(((await r.json()) as { message: string }).message).toBe(message)
    }
    expect((await get(cookie, `?day=${addDays(TODAY, -ALERT_DAYS)}`)).status).toBe(200)
  })

  it('today’s alerts with their table, the names and the threshold; another day with ?day=', async () => {
    expect(
      await putSnapshot(m, hub, 'catalog', {
        version: 1,
        restaurant: { name: 'R' },
        tables: [{ id: TABLE, zoneId: 'z1', name: '3' }, { id: 'malformed' }],
      }),
    ).toBe(204)
    const today = voidedPinsa()
    const yesterday = voidedPinsa('2026-10-25')
    await upload(hub.hub, numbered([...yesterday.events, ...today.events, ...shortRegister()]))
    const cookie = await signedIn(hub)
    const r = await get(cookie)
    expect(r.status).toBe(200)
    const body = (await r.json()) as AlertsAnswer
    expect(Object.keys(body).sort()).toEqual(
      [
        'alerts',
        'as_of',
        'day',
        'local',
        'server_now',
        'tables',
        'threshold',
        'today',
        'users',
      ].sort(),
    )
    expect(body.day).toBe(TODAY)
    expect(body.today).toBe(TODAY)
    expect(body.threshold).toBe(1_000)
    expect(body.alerts.map((a) => a.type)).toEqual(['register_variance', 'item_voided'])
    expect(body.alerts[1]).toMatchObject({
      type: 'item_voided',
      name: 'Pinsa',
      units: 1,
      value: 20_900,
      userId: ANA,
      authorizedById: CARLOS,
      reason: 'El cliente cambió de idea',
      order: { id: today.order, tableId: TABLE },
    })
    expect(body.alerts[0]).toMatchObject({ value: -5_000, reason: 'Se dio mal un cambio' })
    expect(body.tables).toEqual({ [TABLE]: '3' })
    expect(body.users).toEqual({ [ANA]: 'Ana', [CARLOS]: 'Carlos' })
    const before = (await (await get(cookie, '?day=2026-10-25')).json()) as AlertsAnswer
    expect(before.day).toBe('2026-10-25')
    expect(before.alerts.map((a) => a.order?.id)).toEqual([yesterday.order])
  })

  it('D3: a close is judged with the threshold the location has now, not the one it had then', async () => {
    // Closed with a shortage of 5.000 (shortRegister). With the threshold at 10.000 it is not an
    // alert; the owner lowers it to 2.000 and the same close becomes one, without anything new.
    await upload(hub.hub, numbered(shortRegister()))
    const cookie = await signedIn(hub)
    const variances = async () =>
      ((await (await get(cookie)).json()) as AlertsAnswer).alerts.filter(
        (a) => a.type === 'register_variance',
      )
    const config = (threshold: number) =>
      putSnapshot(m, hub, 'config', {
        config: { register_variance_threshold: threshold },
        time_zone: 'America/Bogota',
      })
    expect(await config(10_000)).toBe(204)
    expect(await variances()).toEqual([])
    expect(await config(2_000)).toBe(204)
    expect((await variances()).map((a) => a.value)).toEqual([-5_000])
  })

  it('the dashboard says how many alerts today has', async () => {
    await upload(hub.hub, numbered([...voidedPinsa().events, ...shortRegister()]))
    const r = await panelRequest(m, 'GET', '/v1/panel/summary', { cookie: await signedIn(hub) })
    expect(((await r.json()) as { alerts: number }).alerts).toBe(2)
  })

  it('each session sees only its own restaurant', async () => {
    const other = await m.newHub()
    const mine = voidedPinsa()
    const theirs = voidedPinsa()
    await upload(hub.hub, numbered(mine.events))
    await upload(other.hub, numbered(theirs.events))
    for (const [h, expected] of [
      [hub, mine.order],
      [other, theirs.order],
    ] as const) {
      const body = (await (await get(await signedIn(h))).json()) as AlertsAnswer
      expect(body.alerts.map((a) => a.order?.id)).toEqual([expected])
    }
  })
})
