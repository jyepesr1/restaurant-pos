import { newId, type OrderEvent } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cardPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { type ApiEnv, BACK_ONLINE_AFTER_MS, handle } from './api'
import type { LiveFloor } from './live'
import { roomOf } from './live-protocol'
import { panelRequest } from './testing/panel'
import { type Rooms, realRooms } from './testing/rooms'
import { person, publish, signInAs } from './testing/session'
import { createWorld, type TestHub, type World } from './testing/world'

// The restaurant’s hub goes off, restarts with events to upload, resends what the cloud already
// has and uploads out of order (task 1.11c-2): the panel must only ever show what the cloud was
// really told, say how much is missing, and catch up once the hub does.

let m: World
let hub: TestHub
let cookie: string
let rooms: Rooms
let environment: Partial<ApiEnv>

const TODAY = '2026-10-26'
const at = (minute: number) => ({
  business_day: TODAY,
  received_at: `2026-10-26T14:${String(minute).padStart(2, '0')}:00.000Z`,
})

beforeEach(async () => {
  rooms = realRooms()
  environment = rooms.environment
  m = await createWorld()
  hub = await m.newHub()
  const owner = person(['remote_access', 'view_reports'], 'Dueña')
  await publish(m, hub, [owner])
  cookie = await signInAs(m, hub, owner)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A call from the hub, as its uploader makes it (`max` is the `x-faro-hub-max` header). */
function fromHub(method: string, route: string, body?: unknown, max?: number) {
  return handle(
    new Request(`https://cloud.faro.test${route}`, {
      method,
      headers: {
        authorization: `Bearer ${hub.credential}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(max !== undefined ? { 'x-faro-hub-max': String(max) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { sql: m.sql, clock: () => m.clock.now, ...environment },
  )
}

const floor = async () => {
  const r = await panelRequest(m, 'GET', '/v1/panel/floor', { cookie })
  expect(r.status).toBe(200)
  return (await r.json()) as LiveFloor
}

const advance = (ms: number) => {
  m.clock.now = new Date(m.clock.now.getTime() + ms)
  rooms.setNow(m.clock.now)
}

/** A table with a pizza in the kitchen, as three events with consecutive sequences from `from`. */
function pizzaOrder(from: number, minute = 1) {
  const order = newId()
  const copy = itemCopy({ name: 'Pizza', unit_price: 40_000 })
  const ticket = newId()
  const events = [
    event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }, at(minute)),
    event(order, 'ItemAdded', copy, at(minute)),
    event(
      order,
      'ItemsSent',
      { tickets: [{ ticket_id: ticket, station_id: newId(), item_ids: [copy.item_id] }] },
      { ...at(minute), assignments: { ticket_numbers: { [ticket]: 1 } } },
    ),
  ].map((e, i) => ({ ...e, sequence: from + i }))
  return { order, copy, ticket, events }
}

const upload = (events: readonly OrderEvent[], max?: number) =>
  fromHub('POST', '/v1/events', { events }, max)

describe('the hub is off for a while', () => {
  it('the panel keeps the last known floor and the cloud says when the hub was last heard', async () => {
    const a = pizzaOrder(1)
    expect((await upload(a.events, 3)).status).toBe(200)
    const heard = m.clock.now.toISOString()
    // Ten minutes of nothing: no calls from the hub.
    advance(10 * 60_000)
    const body = await floor()
    expect(body.orders.map((o) => o.id)).toEqual([a.order])
    expect(body.local.last_seen_at).toBe(heard)
    expect(Date.parse(body.server_now) - Date.parse(body.local.last_seen_at ?? '')).toBe(
      10 * 60_000,
    )
    expect(body.local.pending).toBe(0)
  })

  it('exactly two minutes of silence is not «back online»; one second more is', async () => {
    const socket = await connected()
    expect((await fromHub('GET', '/v1/events/last')).status).toBe(200)
    await rooms.settle()
    // The first call of its life counts as coming back.
    expect(told(socket)).toEqual(['back_online'])
    advance(BACK_ONLINE_AFTER_MS)
    await fromHub('GET', '/v1/events/last')
    await rooms.settle()
    expect(told(socket)).toEqual(['back_online'])
    advance(BACK_ONLINE_AFTER_MS + 1)
    await fromHub('GET', '/v1/events/last')
    await rooms.settle()
    expect(told(socket)).toEqual(['back_online', 'back_online'])
  })

  it('back after a silence with its queue: one «events» notice per batch, and the panel catches up', async () => {
    const socket = await connected()
    await fromHub('GET', '/v1/events/last')
    await rooms.settle()
    socket.sent.length = 0
    // Cut for 20 minutes; meanwhile the hub took two orders it could not upload.
    advance(20 * 60_000)
    const first = pizzaOrder(1, 5)
    const second = pizzaOrder(4, 12)
    // It calls first to ask where it was, with 6 events pending…
    await fromHub('GET', '/v1/events/last', undefined, 6)
    await rooms.settle()
    expect(told(socket)).toEqual(['back_online'])
    expect((await floor()).local.pending).toBe(6)
    expect((await floor()).orders).toEqual([])
    // …and uploads them in two batches.
    await upload(first.events, 6)
    await upload(second.events, 6)
    await rooms.settle()
    expect(told(socket)).toEqual(['back_online', 'events', 'events'])
    const body = await floor()
    expect(body.local.pending).toBe(0)
    expect(body.orders.map((o) => o.id).sort()).toEqual([first.order, second.order].sort())
    expect(body.tickets).toHaveLength(2)
  })
})

describe('the hub restarts with events to upload', () => {
  it('never shows a table whose opening has not arrived, and says how much is missing', async () => {
    const a = pizzaOrder(1)
    // The hub lost its connection after the first event of the batch and restarts: the cloud only
    // has the order’s later events (the opening is still queued in the hub).
    expect((await upload(a.events.slice(1), 3)).status).toBe(200)
    const partial = await floor()
    expect(partial.orders).toEqual([])
    expect(partial.tickets).toEqual([])
    expect(partial.local.pending).toBe(3)
    // The opening arrives (the cloud keeps the order of the hub’s sequence).
    await upload(a.events.slice(0, 1), 3)
    const whole = await floor()
    expect(whole.orders.map((o) => o.id)).toEqual([a.order])
    expect(Object.keys(whole.orders[0]?.items ?? {})).toEqual([a.copy.item_id])
    expect(whole.tickets).toHaveLength(1)
    expect(whole.local.pending).toBe(0)
  })

  it('a batch that arrives before the previous one: the floor is the same as when they arrive in order', async () => {
    const a = pizzaOrder(1)
    const b = pizzaOrder(4, 3)
    const inOrder = await (async () => {
      await upload([...a.events, ...b.events])
      return floor()
    })()
    // A fresh restaurant gets the second batch first.
    m = await createWorld()
    hub = await m.newHub()
    const owner = person(['remote_access'], 'Dueña')
    await publish(m, hub, [owner])
    cookie = await signInAs(m, hub, owner)
    await upload(b.events, 6)
    expect((await floor()).orders.map((o) => o.id)).toEqual([b.order])
    expect((await floor()).local.pending).toBe(6)
    await upload(a.events, 6)
    const swapped = await floor()
    expect(swapped.orders).toEqual(inOrder.orders)
    expect(swapped.tickets).toEqual(inOrder.tickets)
    expect(swapped.local.pending).toBe(0)
  })

  it('resending what the cloud already has changes nothing and does not wake the panels', async () => {
    const socket = await connected()
    const a = pizzaOrder(1)
    await upload(a.events, 3)
    await rooms.settle()
    const before = await floor()
    socket.sent.length = 0
    // The restarted hub does not know how far the cloud got and sends everything again.
    const again = await upload(a.events, 3)
    expect(
      ((await again.json()) as { results: { status: string }[] }).results.map((r) => r.status),
    ).toEqual(['already_stored', 'already_stored', 'already_stored'])
    await rooms.settle()
    expect(told(socket)).toEqual([])
    const after = await floor()
    expect({ ...after, server_now: '', local: null }).toEqual({
      ...before,
      server_now: '',
      local: null,
    })
  })

  it('the hub’s own sequence does not need to be contiguous: pending counts what is really missing', async () => {
    const a = pizzaOrder(1)
    const gap = pizzaOrder(10)
    await upload(a.events, 12)
    await upload(gap.events, 12)
    const body = await floor()
    // Events 4..9 never arrived: the cloud knows it only has up to 3 contiguous.
    expect(body.local.pending).toBe(9)
    expect(body.orders).toHaveLength(2)
  })

  it('a hub that reports a smaller maximum than before (restored from a backup) never shows a negative pending', async () => {
    const a = pizzaOrder(1)
    await upload(a.events, 3)
    await fromHub('GET', '/v1/events/last', undefined, 1)
    const body = await floor()
    expect(body.local.pending).toBeGreaterThanOrEqual(0)
  })
})

describe('the register PC is replaced', () => {
  // D1 (docs/PANEL.md#pc-de-caja-revocado): what is live is only what an active hub stands behind.
  // The orders the old PC left open do not stay in «Salón» and «Cocina» as ghosts; they do stay
  // in the reports, which are history.
  it('the open orders of a revoked hub do not stay on the floor as ghosts', async () => {
    const old = pizzaOrder(1)
    await upload(old.events, 3)
    expect((await floor()).orders).toHaveLength(1)
    // The new PC takes over the same location, and the old one is revoked.
    const code = await m.cloud.createCode(hub.restaurantId)
    if (!code) throw new Error('no code')
    const registered = await m.cloud.registerHub({
      code: code.code,
      restaurant_id: hub.restaurantId,
      hub_id: newId(),
      location_id: hub.hub.locationId,
      name: 'Caja nueva',
      instance: 'i2',
    })
    expect(registered.ok).toBe(true)
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(true)
    expect((await floor()).orders).toEqual([])
  })

  it('the new PC resends the old one’s events: what is still open comes back; the reports always had it', async () => {
    const open = pizzaOrder(1)
    const closed = pizzaOrder(4)
    const card = cardPaymentData(40_000)
    const closing = [
      event(closed.order, 'PaymentRecorded', card, at(2)),
      event(closed.order, 'OrderClosed', {}, at(2)),
    ].map((e, i) => ({ ...e, sequence: 7 + i }))
    await upload([...open.events, ...closed.events, ...closing], 8)
    const code = await m.cloud.createCode(hub.restaurantId)
    if (!code) throw new Error('no code')
    const registered = await m.cloud.registerHub({
      code: code.code,
      restaurant_id: hub.restaurantId,
      hub_id: newId(),
      location_id: hub.hub.locationId,
      name: 'Caja nueva',
      instance: 'i2',
    })
    if (!registered.ok) throw new Error('not registered')
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(true)
    expect((await floor()).orders).toEqual([])
    const sales = async () => {
      const r = await panelRequest(m, 'GET', '/v1/panel/reports', { cookie })
      return ((await r.json()) as { report: { sales: { net: number } } }).report.sales.net
    }
    // History: the revoked PC's sales still count.
    expect(await sales()).toBe(40_000)
    // The new PC (the same database, restored) uploads its series from the start: the cloud
    // already has those events (under the old PC), and now an active hub stands behind them.
    const resent = await handle(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${registered.credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ events: [...open.events, ...closed.events, ...closing] }),
      }),
      { sql: m.sql, clock: () => m.clock.now, ...environment },
    )
    expect(resent.status).toBe(200)
    expect((await floor()).orders.map((o) => o.id)).toEqual([open.order])
    expect(await sales()).toBe(40_000)
  })

  it('a shift the revoked PC left open is not an open register; one it closed today is still listed', async () => {
    const register = newId()
    const shift = () => ({
      ...at(1),
      aggregate_type: 'register_shift' as const,
      device_id: register,
    })
    const [left, done, count] = [newId(), newId(), newId()]
    const events = [
      event(left, 'ShiftOpened', { register_id: register, base: 50_000 }, shift()),
      event(done, 'ShiftOpened', { register_id: newId(), base: 10_000 }, shift()),
      event(
        done,
        'CashCountRecorded',
        { cash_count_id: count, tally: [{ value: 10_000, quantity: 1 }], counted_cash: 10_000 },
        shift(),
      ),
      event(
        done,
        'ShiftClosed',
        {
          cash_count_id: count,
          expected_cash: 10_000,
          counted_cash: 10_000,
          variance: 0,
          justification: null,
          other_methods: [],
        },
        shift(),
      ),
    ].map((e, i) => ({ ...e, sequence: i + 1 }))
    await upload(events, 4)
    const registers = async () => {
      const r = await panelRequest(m, 'GET', '/v1/panel/register', { cookie })
      return (await r.json()) as { open: { shift_id: string }[]; closed: { shiftId: string }[] }
    }
    expect((await registers()).open.map((o) => o.shift_id)).toEqual([left])
    const code = await m.cloud.createCode(hub.restaurantId)
    if (!code) throw new Error('no code')
    await m.cloud.registerHub({
      code: code.code,
      restaurant_id: hub.restaurantId,
      hub_id: newId(),
      location_id: hub.hub.locationId,
      name: 'Caja nueva',
      instance: 'i3',
    })
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(true)
    const after = await registers()
    expect(after.open).toEqual([])
    expect(after.closed.map((c) => c.shiftId)).toEqual([done])
  })
})

describe('the hub’s clock is off', () => {
  it('events stamped in the future or far in the past still show, in the hub’s order', async () => {
    const future = pizzaOrder(1)
    const past = pizzaOrder(4)
    const stamp = (events: OrderEvent[], received_at: string) =>
      events.map((e) => ({ ...e, received_at }))
    await upload(stamp(future.events, '2026-10-26T20:00:00.000Z'), 6)
    await upload(stamp(past.events, '2026-10-26T09:00:00.000Z'), 6)
    const body = await floor()
    expect(body.orders.map((o) => o.id).sort()).toEqual([future.order, past.order].sort())
    // `as_of` is the newest receipt the cloud read, even if the hub says it is later than now.
    expect(body.as_of).toBe('2026-10-26T20:00:00.000Z')
    // Cards are in the order they were sent according to the hub.
    expect(body.tickets.map((t) => t.order_id)).toEqual([past.order, future.order])
  })
})

// ── helpers that need the live rooms ──

/** Opens the panel’s socket in the location’s room and returns the server side. */
async function connected() {
  const r = await panelRequest(
    m,
    'GET',
    '/v1/panel/live',
    {
      cookie,
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZQ==',
      },
    },
    environment,
  )
  expect(r.status).toBe(101)
  const sockets = rooms.sockets(roomOf(hub.restaurantId, hub.hub.locationId))
  return sockets.at(-1) as (typeof sockets)[number]
}

const told = (socket: { sent: string[] }) =>
  socket.sent.map((s) => (JSON.parse(s) as { reason: string }).reason)
