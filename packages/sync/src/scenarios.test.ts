import { type NewEvent, newId, type OrderEvent } from '@pos/core'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { MemoryDeviceStore } from './device/store'
import { FloorSync } from './hub/floor'
import { HubSync } from './hub/hub'
import { MemoryStore } from './hub/store'
import { SqliteStore } from './hub/store-sqlite'
import { openAccess } from './testing/access'
import { type NetNode, SimulatedNetwork } from './testing/network'

// Acceptance scenarios for task 0.6 (docs/SYNC.md#pruebas-de-aceptación-tarea-06).

const NOW = '2026-10-24T15:00:00.000Z'

function sqliteDatabase() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurantId = newId()
  db.prepare(
    `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
     VALUES (?, ?, ?, ?, 1, 'La Spritzzería', '{}')`,
  ).run(restaurantId, restaurantId, NOW, NOW)
  return { db, restaurantId }
}

/**
 * Hub + simulated network. With `crash`, the store throws when saving event number `crash` and,
 * like a stopped process, saves nothing else until the hub comes back up.
 */
function setup(options: { store?: 'sqlite' | 'memory'; crash?: number } = {}) {
  const { db, restaurantId } = sqliteDatabase()
  let savedList = 0
  let down = false
  class CrashingStore extends SqliteStore {
    override transaction<T>(job: () => T): T {
      if (down) throw new Error('the hub is down')
      return super.transaction(job)
    }
    override saveEvent(...args: Parameters<SqliteStore['saveEvent']>) {
      savedList += 1
      if (savedList === options.crash) {
        down = true
        throw new Error('the hub went down')
      }
      super.saveEvent(...args)
    }
  }
  const store = options.store === 'memory' ? new MemoryStore() : new CrashingStore(db, restaurantId)
  const status: { hub: HubSync | null; instance: string } = { hub: null, instance: 'hub-1' }
  const network: SimulatedNetwork = new SimulatedNetwork(null as unknown as FloorSync)
  const createFloor = (hubStore = store) => {
    status.hub = new HubSync(hubStore, {
      restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      access: openAccess,
      instance: status.instance,
      clock: network.isoTime,
    })
    return new FloorSync(status.hub, network.authenticate)
  }
  network.floor = createFloor()
  network.onHubCrash = () => {
    down = false
    return createFloor()
  }
  return { network, db, store, hub: () => status.hub as HubSync, createFloor, status }
}

const openOrder = (node: NetNode, order = newId(), table: string | null = newId()) =>
  node
    .create(order, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 2 })
    .then(() => order)

const item = (price = 40_900, fields = {}) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Garden Margarita',
  unit_price: price,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 1,
  price_channel_id: null,
  ...fields,
})

/** "See the same": the hub has events 1..N with no gaps and every device, equal projections. */
async function seeTheSame(
  hub: HubSync,
  hubEvents: OrderEvent[],
  nodes: NetNode[],
  orders: string[],
) {
  expect(hubEvents.map((e) => e.sequence)).toEqual(hubEvents.map((_, i) => i + 1))
  expect(new Set(hubEvents.map((e) => e.id)).size).toBe(hubEvents.length)
  for (const node of nodes) {
    expect(await node.client.pendingList()).toBe(0)
    const allConfirmed = (await node.client.locals())
      .filter((l) => l.status === 'confirmed')
      .map((l) => l.event.id)
    expect(new Set(allConfirmed)).toEqual(new Set(hubEvents.map((e) => e.id)))
    for (const order of orders) expect(await node.client.order(order)).toEqual(hub.order(order))
  }
}

const eventsOf = (m: ReturnType<typeof setup>) => m.store.eventsSince(0, 100_000)

describe('sync scenarios', () => {
  it('1. two devices without a hub create orders on different tables and on reconnect see the same, with no duplicates', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')

    const p1 = await openOrder(ana)
    await ana.create(p1, 'ItemAdded', item())
    const p2 = await openOrder(luis)
    await luis.create(p2, 'ItemAdded', item(12_900))
    expect(await ana.client.pendingList()).toBe(2)

    await m.network.connectAll()
    // Reconnecting again duplicates nothing.
    ana.disconnect()
    luis.disconnect()
    await m.network.connectAll()

    expect(eventsOf(m)).toHaveLength(4)
    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [p1, p2])
    expect(m.hub().order(p1)?.dayNumber).toBe(1)
    expect(m.hub().order(p2)?.dayNumber).toBe(2)
  })

  it('2. both add items to the same order offline: all are kept', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const order = await openOrder(ana)
    await m.network.settle()

    ana.disconnect()
    luis.disconnect()
    await ana.create(order, 'ItemAdded', item())
    await luis.create(order, 'ItemAdded', item(12_900))
    await luis.create(order, 'ItemAdded', item(8900))
    await m.network.connectAll()

    expect(Object.keys(m.hub().order(order)?.items ?? {})).toHaveLength(3)
    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [order])
  })

  it('3. both open the same table offline: two orders and exactly one conflict, also on resend', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    const table = newId()
    const p1 = await openOrder(ana, newId(), table)
    const p2 = await openOrder(luis, newId(), table)

    luis.rule('to_hub', 'push', 'duplicate')
    await m.network.connectAll()

    expect(m.hub().order(p1)?.status).toBe('open')
    expect(m.hub().order(p2)?.status).toBe('open')
    expect(
      m
        .hub()
        .conflicts()
        .map((c) => c.type),
    ).toEqual(['duplicate_table'])
    const conflicting = (await luis.client.locals()).find((l) => l.event.aggregate_id === p2)
    expect(conflicting?.conflict).toBe('duplicate_table')
    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [p1, p2])
  })

  it('3b. with up-to-date information, opening an occupied table is rejected', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const table = newId()
    await openOrder(ana, newId(), table)
    await m.network.settle()

    const p2 = await openOrder(luis, newId(), table)
    await m.network.settle()

    expect((await luis.client.locals()).find((l) => l.event.aggregate_id === p2)).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().order(p2)).toBeNull()
  })

  it('4. the response is lost and the same batch arrives twice: no duplicates', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()

    ana.rule('to_device', 'result', 'drop')
    ana.rule('to_device', 'new', 'drop', 2)
    const order = await openOrder(ana)
    await ana.create(order, 'ItemAdded', item())
    await m.network.settle()
    expect(await ana.client.pendingList()).toBe(2)

    // The connection reopens (for example, on returning to the screen) and the batch is resent.
    ana.disconnect()
    await m.network.connectAll()

    expect(eventsOf(m)).toHaveLength(2)
    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [order])
  })

  it('5a. the hub crashes mid-batch: on return, nothing lost or duplicated', async () => {
    const m = setup({ crash: 3 })
    const ana = m.network.device('ana')
    const order = await openOrder(ana)
    for (const price of [10_000, 20_000, 30_000]) await ana.create(order, 'ItemAdded', item(price))

    await m.network.connectAll()
    expect(ana.online).toBe(false)
    expect(eventsOf(m)).toHaveLength(2)

    await m.network.connectAll()
    expect(eventsOf(m)).toHaveLength(4)
    await seeTheSame(m.hub(), eventsOf(m), [ana], [order])
  })

  it('5b. the hub saves and crashes before replying: the resend does not duplicate', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    await m.network.connectAll()
    ana.rule('to_device', 'result', 'drop')
    ana.rule('to_device', 'new', 'drop', 5)
    const order = await openOrder(ana)
    await ana.create(order, 'ItemAdded', item())
    await m.network.settle()

    m.network.crashHub()
    await m.network.connectAll()

    expect(eventsOf(m)).toHaveLength(2)
    await seeTheSame(m.hub(), eventsOf(m), [ana], [order])
  })

  it('6. a device with its clock hours off: the order comes from the sequence', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    luis.offsetMs = -5 * 60 * 60 * 1000
    await m.network.connectAll()
    const order = await openOrder(ana)
    await m.network.settle()

    const firstOne = item(10_000)
    const secondOne = item(20_000)
    await ana.create(order, 'ItemAdded', firstOne)
    await m.network.settle()
    await luis.create(order, 'ItemAdded', secondOne)
    await m.network.settle()

    const status = m.hub().order(order)
    expect(status?.items[firstOne.item_id]?.position).toBe(1)
    expect(status?.items[secondOne.item_id]?.position).toBe(2)
    // Luis's device time is 5 hours "earlier", but the order does not change.
    const [, e1, e2] = eventsOf(m)
    expect((e2?.device_time ?? '') < (e1?.device_time ?? '')).toBe(true)
    expect(e2?.sequence).toBeGreaterThan(e1?.sequence ?? 0)
    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [order])
  })

  it('7. a rejection drags along its dependents in the same order and the device undoes its effect', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const order = await openOrder(ana)
    await m.network.settle()
    const other = await openOrder(luis)
    await m.network.settle()

    ana.disconnect()
    // 999 units of $100.000.000 exceed the order cap: it is rejected, and so is what follows in
    // the order.
    const expensive = item(100_000_000, { quantity: 999 })
    await ana.create(order, 'ItemAdded', expensive)
    const after = item()
    await ana.create(order, 'ItemAdded', after)
    await ana.create(other, 'ItemAdded', item(5000))
    // On the phone itself the item over the cap is no longer applied; the next one is, for now.
    expect(Object.keys((await ana.client.order(order))?.items ?? {})).toHaveLength(1)

    await m.network.connectAll()

    const locals = await ana.client.locals()
    expect(
      locals.find(
        (l) => l.event.id && (l.event as NewEvent<'ItemAdded'>).data.item_id === expensive.item_id,
      )?.reason,
    ).toBe('total_exceeds')
    expect(
      locals.find((l) => (l.event as NewEvent<'ItemAdded'>).data.item_id === after.item_id)?.reason,
    ).toBe('depends_on_rejected')
    expect(Object.keys((await ana.client.order(order))?.items ?? {})).toHaveLength(0)
    // The event from the other order did not depend on it and was accepted.
    expect(Object.keys(m.hub().order(other)?.items ?? {})).toHaveLength(1)
    await seeTheSame(m.hub(), eventsOf(m), [luis], [order, other])
  })

  it('8. an event arrives with a gap: the device pulls what is missing before advancing', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await m.network.connectAll()

    register.rule('to_device', 'new', 'drop')
    const order = await openOrder(ana)
    await ana.create(order, 'ItemAdded', item())
    await ana.create(order, 'ItemAdded', item(12_900))
    await m.network.settle()

    expect((await register.store.cursor()).until).toBe(3)
    await seeTheSame(m.hub(), eventsOf(m), [ana, register], [order])
  })

  it('9. the hub is restored from an old backup: devices resend and all end up equal', async () => {
    const m = setup({ store: 'memory' })
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const order = await openOrder(ana)
    await ana.create(order, 'ItemAdded', item())
    await m.network.settle()
    const fallback = structuredClone((m.store as MemoryStore).events)

    await luis.create(order, 'ItemAdded', item(12_900))
    await ana.create(order, 'ItemAdded', item(8900))
    await m.network.settle()
    expect(eventsOf(m)).toHaveLength(4)

    // The backup (2 events) is restored on a reinstalled hub.
    for (const node of m.network.nodes) node.disconnect()
    const restored = new MemoryStore()
    restored.events = fallback
    m.status.instance = 'hub-2'
    m.network.floor = m.createFloor(restored)
    await m.network.connectAll()

    const events = restored.eventsSince(0, 1000)
    expect(events).toHaveLength(4)
    await seeTheSame(m.hub(), events, [ana, luis], [order])
  })

  it('10. the data on a device is wiped: on reconnect it ends up equal to the others', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    await m.network.connectAll()
    const order = await openOrder(ana)
    await ana.create(order, 'ItemAdded', item())
    await m.network.settle()

    // Same device (same token), storage wiped by the browser.
    ana.disconnect()
    m.network.nodes.splice(m.network.nodes.indexOf(ana), 1)
    const anaAgain = m.network.device('ana', new MemoryDeviceStore())
    await m.network.connectAll()

    await seeTheSame(m.hub(), eventsOf(m), [anaAgain], [order])
  })

  it('11. more than 100 pending events are sent in full, in order', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const order = await openOrder(ana)
    const items = Array.from({ length: 150 }, (_, i) => item(1000 + i))
    for (const i of items) await ana.create(order, 'ItemAdded', i)

    await m.network.connectAll()

    const events = eventsOf(m)
    expect(events).toHaveLength(151)
    const position = events.slice(1).map((e) => (e.data as { item_id: string }).item_id)
    expect(position).toEqual(items.map((i) => i.item_id))
    await seeTheSame(m.hub(), events, [ana], [order])
  })

  it('12. a revoked device with events from before the revocation: they go to quarantine', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const order = await openOrder(ana)
    m.network.advance(60_000)
    const connection = m.network.tokens.get('token-ana')
    if (connection) connection.revokedAt = m.network.isoTime()
    m.network.advance(60_000)
    await ana.create(order, 'ItemAdded', item())

    await m.network.connectAll()

    const locals = await ana.client.locals()
    expect(locals.map((l) => l.status)).toEqual(['quarantine', 'rejected'])
    expect(m.db.prepare('SELECT count(*) AS n FROM quarantined_events').get()?.n).toBe(1)
    expect(eventsOf(m)).toHaveLength(0)
  })
})

describe('hub: validations', () => {
  const raw = (node: NetNode, extras: Record<string, unknown> = {}) => ({
    id: newId(),
    type: 'OrderOpened',
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    related: [],
    data: { channel: 'bar', table_id: null, guests: 1 },
    session_id: null,
    user_id: node.userId,
    device_id: node.deviceId,
    authorization_id: null,
    reason: null,
    device_time: NOW,
    hub_estimated_time: NOW,
    base_sequence: 0,
    ...extras,
  })
  const connectionOf = (m: ReturnType<typeof setup>, node: NetNode) => {
    const connection = m.network.tokens.get(`token-${node.name}`)
    if (!connection) throw new Error(`No token for ${node.name}`)
    return connection
  }

  it('the same id with other content is rejected; with the same content, same response', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const event = raw(ana)
    const firstOne = m.hub().receiveBatch(connectionOf(m, ana), [event])
    const duplicate = m.hub().receiveBatch(connectionOf(m, ana), [event])
    const different = m
      .hub()
      .receiveBatch(connectionOf(m, ana), [{ ...event, data: { ...event.data, guests: 5 } }])

    expect(duplicate.results).toEqual(firstOne.results)
    expect(duplicate.acceptedEvents).toEqual([])
    expect(different.results[0]).toMatchObject({ status: 'rejected', reason: 'duplicate_id' })
  })

  it('rejects invalid format, another device and a base sequence from the future', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const r = m
      .hub()
      .receiveBatch(connectionOf(m, ana), [
        { ...raw(ana), data: { channel: 'dine_in' } },
        raw(ana, { device_id: newId() }),
        raw(ana, { base_sequence: 99 }),
        null,
      ])
    expect(
      r.results.map((x) => (x.status === 'rejected' ? x.reason.split(':')[0] : x.status)),
    ).toEqual(['schema', 'device_mismatch', 'invalid_base_sequence', 'schema'])
  })

  it('the business day comes from the estimated time if reasonable; otherwise, from the hub time', () => {
    const m = setup()
    const ana = m.network.device('ana')
    // Hub: 15:00 UTC on the 24th (10 a.m. in Bogotá).
    m.network.advance(Date.parse(NOW) - m.network.now())
    const r = m.hub().receiveBatch(connectionOf(m, ana), [
      raw(ana, { hub_estimated_time: '2026-10-24T09:00:00.000Z' }), // 4 a.m.: previous day
      raw(ana, { hub_estimated_time: '2026-10-20T09:00:00.000Z' }), // days ago: ignored
    ])
    expect(r.acceptedEvents.map((e) => e.business_day)).toEqual(['2026-10-23', '2026-10-24'])
  })

  it('an event on a closed order: conflict if it was not up to date, rejection if it was', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    const connection = connectionOf(m, ana)
    const order = newId()
    // The register opens its shift: without it there is no checkout (task 1.6).
    const shift = newId()
    m.hub().receiveBatch(connectionOf(m, register), [
      raw(register, {
        type: 'ShiftOpened',
        aggregate_type: 'register_shift',
        aggregate_id: shift,
        data: { register_id: register.deviceId, base: 0 },
      }),
    ])
    const payment = {
      payment_id: newId(),
      check_id: null,
      register_shift_id: shift,
      method: 'card',
      amount: 10_000,
      tip: 0,
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: {
        card_terminal_id: newId(),
        franchise: null,
        last4: null,
        approval_code: '1',
        receipt: null,
      },
      charge_reference: null,
    }
    const base = { aggregate_id: order }
    m.hub().receiveBatch(connection, [
      raw(ana, { ...base, data: { channel: 'dine_in', table_id: null, guests: 1 } }),
      raw(ana, { ...base, type: 'ItemAdded', data: item(10_000), base_sequence: 2 }),
    ])
    // The register charges and closes: ana only knows about it if her `base_sequence` reaches 5.
    m.hub().receiveBatch(connectionOf(m, register), [
      raw(register, { ...base, type: 'PaymentRecorded', data: payment, base_sequence: 3 }),
      raw(register, { ...base, type: 'OrderClosed', data: {}, base_sequence: 4 }),
    ])

    const late = m.hub().receiveBatch(connection, [
      raw(ana, {
        ...base,
        type: 'GuestsChanged',
        data: { guests: 4 },
        base_sequence: 3,
      }),
    ])
    const upToDate = m.hub().receiveBatch(connection, [
      raw(ana, {
        ...base,
        type: 'GuestsChanged',
        data: { guests: 4 },
        base_sequence: 6,
      }),
    ])

    expect(late.results[0]).toMatchObject({
      status: 'confirmed',
      conflict: 'order_closed',
    })
    expect(upToDate.results[0]).toMatchObject({ status: 'rejected', reason: 'order_closed' })
    expect(m.hub().order(order)?.guests).toBe(1)
  })

  it('the hub rebuilds its projections from the database on startup', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    await m.network.connectAll()
    const order = await openOrder(ana)
    await ana.create(order, 'ItemAdded', item())
    await m.network.settle()
    const before = m.hub().order(order)

    const fresh = new HubSync(m.store, {
      restaurantId: '',
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      access: openAccess,
      instance: 'hub-1',
      clock: m.network.isoTime,
    })
    expect(fresh.order(order)).toEqual(before)
  })

  it('the floor rejects messages with invalid format and unknown tokens', () => {
    const m = setup()
    const received: unknown[] = []
    const link = m.network.floor.connect((msg) => received.push(msg))
    link.receive({ type: 'push' })
    link.receive({
      type: 'hello',
      token: 'unknown',
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    link.receive({ type: 'pull', from: 0 })
    link.receive({ type: 'ping', stamp: 'm1' })

    expect(received).toEqual([
      expect.objectContaining({ type: 'error', code: 'invalid_message' }),
      expect.objectContaining({ type: 'error', code: 'invalid_token' }),
      expect.objectContaining({ type: 'error', code: 'invalid_token' }),
      { type: 'pong', stamp: 'm1' },
    ])
  })
})
