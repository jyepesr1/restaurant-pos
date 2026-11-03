import { newId, type OrderEvent } from '@pos/core'
import { HubSync, MemoryStore, ordersOf, reportData } from '@pos/sync'
import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { actionArb } from '../../../packages/core/src/testing/simulator'
import { openAccess } from '../../../packages/sync/src/testing/access'
import { buildHistory, DAYS, type HistoryPlan } from '../../../packages/sync/src/testing/histories'
import { type AuthenticatedHub, inRestaurant } from './cloud'
import { LIVE_MAX_ROUNDS, LIVE_WINDOW_DAYS } from './live'
import { addDays, type RegisterAnswer } from './panel'
import { registersNow } from './register'
import { closingJson, hubsOfLocation, type Scope } from './reports'
import { cookieFrom, panelRequest, putSnapshot, remoteUser, slugOf } from './testing/panel'
import { createWorld, type TestHub, type World } from './testing/world'

// «Caja» in the owner's panel (task 1.11c-2, docs/PANEL.md#caja): the open registers with what
// they should have, computed in the cloud with the hub's own code, and the day's closes.

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

/** The hub over a store with those events: it rebuilds its open shifts from them. */
function hubWith(events: readonly OrderEvent[]) {
  const store = new MemoryStore()
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
  const sync = new HubSync(store, {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: () => '2026-10-26T15:00:00.000Z',
    access: openAccess,
  })
  return { store, sync }
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
    registersNow(tx, scope, addDays(today, -LIVE_WINDOW_DAYS), today),
  )
}

const plan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' }),
  days: fc.array(fc.nat(2), { minLength: 1, maxLength: 150 }),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})

const CASHIER = newId()
const REGISTER = newId()

/** A shift opened by the cashier, with a cash sale of an order. */
function shift(day: string, fields: { base?: number; sale?: number; time?: string } = {}) {
  const id = newId()
  const order = newId()
  const sale = fields.sale ?? 40_900
  const extras = {
    aggregate_type: 'register_shift' as const,
    business_day: day,
    user_id: CASHIER,
    device_id: REGISTER,
    received_at: fields.time ?? `${day}T14:00:00.000Z`,
  }
  const events = [
    event(id, 'ShiftOpened', { register_id: REGISTER, base: fields.base ?? 100_000 }, extras),
    event(
      order,
      'OrderOpened',
      { channel: 'takeout', table_id: null, guests: 1 },
      {
        business_day: day,
      },
    ),
    event(order, 'ItemAdded', itemCopy({ unit_price: sale }), { business_day: day }),
    event(order, 'PaymentRecorded', cashPaymentData(sale, { register_shift_id: id }), {
      business_day: day,
      device_id: REGISTER,
    }),
  ]
  const close = (counted: number, closeDay = day, justification: string | null = null) => {
    const count = newId()
    const expected = (fields.base ?? 100_000) + sale
    const at = { ...extras, business_day: closeDay, received_at: `${closeDay}T23:00:00.000Z` }
    return [
      event(
        id,
        'CashCountRecorded',
        {
          cash_count_id: count,
          tally: [{ value: 50, quantity: counted / 50 }],
          counted_cash: counted,
        },
        at,
      ),
      event(
        id,
        'ShiftClosed',
        {
          cash_count_id: count,
          expected_cash: expected,
          counted_cash: counted,
          variance: counted - expected,
          justification,
          other_methods: [],
        },
        at,
      ),
    ]
  }
  return { id, order, events, close }
}

describe('the same register as the hub', () => {
  it('with random histories, each open shift gives exactly the hub’s reconciliation', async () => {
    let open = 0
    await fc.assert(
      fc.asyncProperty(plan, async (p) => {
        const h = buildHistory(p)
        const target = await m.newHub()
        await upload(target.hub, h.events)
        const { store, sync } = hubWith(h.events)
        const closed = new Set(
          h.events.filter((e) => e.type === 'ShiftClosed').map((e) => e.aggregate_id),
        )
        const live = await fromCloud(target, DAYS[2])
        expect(live.rounds).toBeLessThanOrEqual(LIVE_MAX_ROUNDS)
        const stillOpen = h.shifts.filter((id) => !closed.has(id))
        expect(live.open.map((o) => o.shift_id).sort()).toEqual([...stillOpen].sort())
        for (const o of live.open) {
          expect(o.reconciliation).toEqual(sync.reconciliation(o.shift_id))
          expect(o.reconciliation.closed).toBeNull()
          open++
        }
        // The closes of the day are the reports' ones.
        expect(live.closed).toEqual(
          reportData(store, DAYS[2], DAYS[2]).registerClosings.map(closingJson),
        )
      }),
      { seed: 20_261_102, numRuns: 30 },
    )
    expect(open).toBeGreaterThan(5)
  })

  it('a shift opened yesterday is still open; one closed today goes with the closes', async () => {
    const yesterday = shift('2026-10-25', { base: 50_000, time: '2026-10-25T22:00:00.000Z' })
    const today = shift('2026-10-26', { sale: 10_000 })
    const events = numbered([
      ...yesterday.events,
      ...today.events,
      ...today.close(110_000 - 2_000, '2026-10-26', 'Faltó cambio'),
    ])
    await upload(hub.hub, events)
    const live = await fromCloud(hub)
    expect(live.open).toEqual([
      {
        shift_id: yesterday.id,
        register_id: REGISTER,
        opened_at: '2026-10-25T22:00:00.000Z',
        opened_by: CASHIER,
        reconciliation: hubWith(events).sync.reconciliation(yesterday.id),
      },
    ])
    expect(live.open[0]?.reconciliation.cash.expected).toBe(50_000 + 40_900)
    expect(live.closed).toHaveLength(1)
    expect(live.closed[0]).toMatchObject({
      shiftId: today.id,
      businessDay: '2026-10-26',
      openedBy: CASHIER,
      closedBy: CASHIER,
      base: 100_000,
      closed: {
        expected: 110_000,
        counted: 108_000,
        variance: -2_000,
        justification: 'Faltó cambio',
      },
    })
    expect(live.asOf).toBe('2026-10-26T23:00:00.000Z')
  })

  it(`closes of another day are not listed; a shift opened over ${LIVE_WINDOW_DAYS} days ago is not open`, async () => {
    const old = shift(addDays('2026-10-26', -LIVE_WINDOW_DAYS - 1))
    const edge = shift(addDays('2026-10-26', -LIVE_WINDOW_DAYS))
    const closedYesterday = shift('2026-10-25')
    await upload(
      hub.hub,
      numbered([
        ...old.events,
        ...edge.events,
        ...closedYesterday.events,
        ...closedYesterday.close(140_900),
      ]),
    )
    const live = await fromCloud(hub)
    expect(live.open.map((o) => o.shift_id)).toEqual([edge.id])
    expect(live.closed).toEqual([])
  })

  it('a location without hubs or events: nothing, without errors', async () => {
    expect(await fromCloud(hub)).toEqual({ open: [], closed: [], asOf: null, rounds: 1 })
    const none = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      registersNow(tx, { restaurantId: hub.restaurantId, hubIds: [] }, '2026-10-01', '2026-10-26'),
    )
    expect(none).toEqual({ open: [], closed: [], asOf: null, rounds: 0 })
  })
})

// ── The route ────────────────────────────────────────────────────────────

describe('the order of the open registers', () => {
  it('by opening time and, at the same instant, by shift id: always the same order', async () => {
    const time = '2026-10-26T13:00:00.000Z'
    const [a, b, c] = [
      shift('2026-10-26', { time }),
      shift('2026-10-26', { time }),
      shift('2026-10-26', { time: '2026-10-26T12:00:00.000Z' }),
    ]
    await upload(hub.hub, numbered([...a.events, ...b.events, ...c.events]))
    const ids = (await fromCloud(hub)).open.map((o) => o.shift_id)
    expect(ids).toEqual([c.id, ...[a.id, b.id].sort()])
  })
})

describe('GET /v1/panel/register', () => {
  async function signedIn(h: TestHub, permissions: string[], name = 'Dueña') {
    const user = remoteUser(
      `u${newId().slice(-6).toLowerCase()}`,
      'clave-de-prueba-1',
      permissions,
      name,
    )
    expect(await putSnapshot(m, h, 'remote_users', [user])).toBe(204)
    expect(
      await putSnapshot(m, h, 'people', [
        { id: CASHIER, name: 'Carla Caja', role_id: null, active: true },
      ]),
    ).toBe(204)
    const r = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
      body: {
        restaurant: await slugOf(m, h.restaurantId),
        username: user.username,
        password: 'clave-de-prueba-1',
      },
    })
    expect(r.status).toBe(200)
    return cookieFrom(r) as string
  }
  const get = (cookie: string | null) => panelRequest(m, 'GET', '/v1/panel/register', { cookie })

  it('asks for a session and for «Ver todos los reportes»', async () => {
    expect((await get(null)).status).toBe(401)
    const r = await get(await signedIn(hub, ['remote_access']))
    expect(r.status).toBe(403)
    expect(((await r.json()) as { message: string }).message).toBe(
      'No tienes permiso para ver los reportes',
    )
    expect((await panelRequest(m, 'POST', '/v1/panel/register', {})).status).toBe(404)
  })

  it('the open registers and today’s closes, with the threshold and the names', async () => {
    const open = shift('2026-10-26', { time: '2026-10-26T13:00:00.000Z' })
    const closed = shift('2026-10-26')
    await upload(hub.hub, numbered([...open.events, ...closed.events, ...closed.close(140_900)]))
    const r = await get(await signedIn(hub, ['remote_access', 'view_reports']))
    expect(r.status).toBe(200)
    const body = (await r.json()) as RegisterAnswer
    expect(Object.keys(body).sort()).toEqual(
      ['as_of', 'closed', 'local', 'open', 'server_now', 'threshold', 'today', 'users'].sort(),
    )
    expect(body.server_now).toBe('2026-10-26T15:00:00.000Z')
    expect(body.today).toBe('2026-10-26')
    expect(body.threshold).toBe(1_000)
    expect(body.open.map((o) => o.shift_id)).toEqual([open.id])
    expect(body.open[0]).toMatchObject({
      opened_by: CASHIER,
      opened_at: '2026-10-26T13:00:00.000Z',
    })
    expect(body.open[0]?.reconciliation.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 40_900, tip: 0, payments: 1 },
    ])
    expect(body.closed.map((c) => c.shiftId)).toEqual([closed.id])
    expect(body.users).toEqual({ [CASHIER]: 'Carla Caja' })
  })

  it('the threshold is the location’s config', async () => {
    expect(
      await putSnapshot(m, hub, 'config', {
        config: { register_variance_threshold: 5_000 },
        time_zone: 'America/Bogota',
      }),
    ).toBe(204)
    const body = (await (
      await get(await signedIn(hub, ['remote_access', 'view_reports']))
    ).json()) as RegisterAnswer
    expect(body.threshold).toBe(5_000)
  })

  it('each session sees only its own restaurant', async () => {
    const other = await m.newHub()
    const mine = shift('2026-10-26')
    const theirs = shift('2026-10-26')
    await upload(hub.hub, numbered(mine.events))
    await upload(other.hub, numbered(theirs.events))
    for (const [h, expected] of [
      [hub, mine.id],
      [other, theirs.id],
    ] as const) {
      const body = (await (
        await get(await signedIn(h, ['remote_access', 'view_reports']))
      ).json()) as RegisterAnswer
      expect(body.open.map((o) => o.shift_id)).toEqual([expected])
    }
  })
})

describe('isolation', () => {
  it('another restaurant, or another location of the same one, never shows up', async () => {
    const other = await m.newHub()
    const sibling = await m.newHub(hub.restaurantId)
    const mine = shift('2026-10-26')
    await upload(hub.hub, numbered(mine.events))
    await upload(other.hub, numbered(shift('2026-10-26').events))
    await upload(sibling.hub, numbered(shift('2026-10-26').events))
    expect((await fromCloud(hub)).open.map((o) => o.shift_id)).toEqual([mine.id])
    // The other restaurant's hub ids, asked for from this restaurant, give nothing.
    const leak = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      registersNow(
        tx,
        { restaurantId: hub.restaurantId, hubIds: [other.hub.id] },
        '2026-10-01',
        '2026-10-26',
      ),
    )
    expect(leak.open).toEqual([])
  })
})
