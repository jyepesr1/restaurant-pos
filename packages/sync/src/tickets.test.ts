import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { SyncClient } from './device/client'
import { MemoryDeviceStore } from './device/store'
import { FloorSync } from './hub/floor'
import { type Connection, HubSync, type OrderChange } from './hub/hub'
import { MemoryStore } from './hub/store'
import { SqliteStore } from './hub/store-sqlite'
import type { HubMessage, PrinterStatus } from './protocol'
import { openAccess } from './testing/access'
import { item, sqliteDatabase } from './testing/setup'

// Task 1.4 (ADR-015) in sync: the hub assigns each ticket's number, per business day; `onSave`
// runs with the event already saved and cannot stop it; and the printer status travels to the
// devices over the WebSocket.

const BOGOTA = (time: string) => new Date(`${time}-05:00`).getTime()
const WAITER: Connection = { deviceId: newId(), type: 'waiter', revokedAt: null }
const OTHER: Connection = { deviceId: newId(), type: 'waiter', revokedAt: null }
const USER = newId()

type Store = 'memory' | 'sqlite'

function setup(store: Store, config: Partial<ConstructorParameters<typeof HubSync>[1]> = {}) {
  const { db, restaurantId } = sqliteDatabase()
  const saved = store === 'sqlite' ? new SqliteStore(db, restaurantId) : new MemoryStore()
  let ms = BOGOTA('2026-10-24T15:00:00')
  const hub = new HubSync(saved, {
    restaurantId,
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: () => new Date(ms).toISOString(),
    access: openAccess,
    ...config,
  })
  /** A raw event as a device sends it (estimated time = whatever is given). */
  const raw = (
    connection: Connection,
    order: string,
    type: string,
    data: unknown,
    estimatedTime = new Date(ms).toISOString(),
  ) => ({
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: order,
    related: [],
    data,
    session_id: null,
    user_id: USER,
    device_id: connection.deviceId,
    authorization_id: null,
    reason: null,
    device_time: estimatedTime,
    hub_estimated_time: estimatedTime,
    base_sequence: saved.maxSequence(),
  })
  const send = (
    connection: Connection,
    order: string,
    type: string,
    data: unknown,
    estimatedTime?: string,
  ) => {
    const r = hub.receiveBatch(connection, [raw(connection, order, type, data, estimatedTime)])
    return { result: r.results[0], accepted: r.acceptedEvents[0] }
  }
  return {
    db,
    restaurantId,
    saved,
    hub,
    raw,
    send,
    now: () => ms,
    setFor: (time: string) => {
      ms = BOGOTA(time)
    },
    advance: (n: number) => {
      ms += n
    },
  }
}
type Setup = ReturnType<typeof setup>

/** Opens an order with `n` dishes and leaves them ready to send. */
function withDishes(m: Setup, n: number, connection = WAITER, time?: string) {
  const order = newId()
  expect(
    m.send(
      connection,
      order,
      'OrderOpened',
      { channel: 'dine_in', table_id: null, guests: 2 },
      time,
    ).result?.status,
  ).toBe('confirmed')
  const dishes = Array.from({ length: n }, () => item())
  for (const p of dishes)
    expect(m.send(connection, order, 'ItemAdded', p, time).result?.status).toBe('confirmed')
  return { order, ids: dishes.map((p) => p.item_id) }
}

const ticket = (itemIds: string[], station = newId()) => ({
  ticket_id: newId(),
  station_id: station,
  item_ids: itemIds,
})

const numbers = (e: OrderEvent | undefined) =>
  (e?.assignments as { ticket_numbers?: Record<string, number> } | undefined)?.ticket_numbers

describe.each(['memory', 'sqlite'] as const)('ticket number (%s)', (store) => {
  it('each ticket in a send gets a consecutive number, one per station', () => {
    const m = setup(store)
    const { order, ids } = withDishes(m, 3)
    const [a, b, c] = [
      ticket([ids[0] as string]),
      ticket([ids[1] as string]),
      ticket([ids[2] as string]),
    ]
    const r = m.send(WAITER, order, 'ItemsSent', { tickets: [a, b, c] })
    expect(numbers(r.accepted)).toEqual({ [a.ticket_id]: 1, [b.ticket_id]: 2, [c.ticket_id]: 3 })
    expect(r.result?.status === 'confirmed' && r.result.acceptance.assignments).toEqual({
      ticket_numbers: numbers(r.accepted),
    })
  })

  it('the next send, even from another order or device, continues the day count', () => {
    const m = setup(store)
    const one = withDishes(m, 2)
    const two = withDishes(m, 1, OTHER)
    const e1 = m.send(WAITER, one.order, 'ItemsSent', {
      tickets: [ticket([one.ids[0] as string]), ticket([one.ids[1] as string])],
    })
    const c2 = ticket([two.ids[0] as string])
    const e2 = m.send(OTHER, two.order, 'ItemsSent', { tickets: [c2] })
    expect(Object.values(numbers(e1.accepted) ?? {})).toEqual([1, 2])
    expect(numbers(e2.accepted)).toEqual({ [c2.ticket_id]: 3 })
  })

  it('only ItemsSent carries ticket numbers; OrderOpened still carries the order number', () => {
    const m = setup(store)
    const order = newId()
    const opened = m.send(WAITER, order, 'OrderOpened', {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    expect(opened.accepted?.assignments).toEqual({ day_number: 1 })
    const dish = item()
    const aggregate = m.send(WAITER, order, 'ItemAdded', dish)
    expect(aggregate.accepted?.assignments).toEqual({})
    const sent = m.send(WAITER, order, 'ItemsSent', {
      tickets: [ticket([dish.item_id])],
    })
    expect(Object.keys(sent.accepted?.assignments ?? {})).toEqual(['ticket_numbers'])
    // An event that creates no ticket uses up no numbers.
    const ready = m.send(WAITER, order, 'ItemReady', { item_ids: [dish.item_id] })
    expect(ready.accepted?.assignments).toEqual({})
  })

  it('a rejected send uses up no numbers', () => {
    const m = setup(store)
    const { order, ids } = withDishes(m, 2)
    const badCase = m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([newId()])] })
    expect(badCase.result?.status).toBe('rejected')
    const c = ticket([ids[0] as string])
    const good = m.send(WAITER, order, 'ItemsSent', { tickets: [c] })
    expect(numbers(good.accepted)).toEqual({ [c.ticket_id]: 1 })
  })

  it('the same send resent (same id) returns the same number and does not use up another', () => {
    const m = setup(store)
    const { order, ids } = withDishes(m, 1)
    const c = ticket([ids[0] as string])
    const event = m.raw(WAITER, order, 'ItemsSent', { tickets: [c] })
    const original = m.hub.receiveBatch(WAITER, [event])
    const duplicate = m.hub.receiveBatch(WAITER, [event])
    expect(duplicate.acceptedEvents).toHaveLength(0)
    expect(duplicate.results[0]).toEqual(original.results[0])
    const other = withDishes(m, 1)
    const c2 = ticket([other.ids[0] as string])
    expect(numbers(m.send(WAITER, other.order, 'ItemsSent', { tickets: [c2] }).accepted)).toEqual({
      [c2.ticket_id]: 2,
    })
  })

  describe('business day', () => {
    const sendTicketAt = (m: Setup, time: string) => {
      m.setFor(time)
      const { order, ids } = withDishes(m, 1)
      const c = ticket([ids[0] as string])
      const r = m.send(WAITER, order, 'ItemsSent', { tickets: [c] })
      return { number: numbers(r.accepted)?.[c.ticket_id], day: r.accepted?.business_day }
    }

    it('at 6:00 a.m. a new day starts and numbering goes back to 1', () => {
      const m = setup(store)
      expect(sendTicketAt(m, '2026-10-24T20:00:00')).toEqual({ number: 1, day: '2026-10-24' })
      expect(sendTicketAt(m, '2026-10-24T21:00:00')).toEqual({ number: 2, day: '2026-10-24' })
      expect(sendTicketAt(m, '2026-10-25T05:59:00')).toEqual({ number: 3, day: '2026-10-24' })
      expect(sendTicketAt(m, '2026-10-25T06:00:00')).toEqual({ number: 1, day: '2026-10-25' })
      expect(sendTicketAt(m, '2026-10-25T06:01:00')).toEqual({ number: 2, day: '2026-10-25' })
    })

    it('the early hours (after midnight) still belong to the previous day', () => {
      const m = setup(store)
      sendTicketAt(m, '2026-10-24T22:00:00')
      expect(sendTicketAt(m, '2026-10-25T01:30:00')).toEqual({ number: 2, day: '2026-10-24' })
    })

    it('a send with yesterday device time that arrives today counts on yesterday', () => {
      const m = setup(store)
      sendTicketAt(m, '2026-10-24T22:00:00')
      sendTicketAt(m, '2026-10-25T07:00:00')
      // Offline since 11 p.m.; the hub receives it at 7:10 a.m., within the 12 h window.
      m.setFor('2026-10-25T07:10:00')
      const { order, ids } = withDishes(
        m,
        1,
        OTHER,
        new Date(BOGOTA('2026-10-24T23:00:00')).toISOString(),
      )
      const c = ticket([ids[0] as string])
      const r = m.send(
        OTHER,
        order,
        'ItemsSent',
        { tickets: [c] },
        new Date(BOGOTA('2026-10-24T23:05:00')).toISOString(),
      )
      expect(r.accepted?.business_day).toBe('2026-10-24')
      expect(numbers(r.accepted)).toEqual({ [c.ticket_id]: 2 })
      // Today does not move.
      expect(sendTicketAt(m, '2026-10-25T07:20:00')).toEqual({ number: 2, day: '2026-10-25' })
    })

    it('a device with a clock far behind does not put its ticket in an old day: the hub time wins', () => {
      const m = setup(store)
      sendTicketAt(m, '2026-10-24T20:00:00')
      m.setFor('2026-10-25T10:00:00')
      const { order, ids } = withDishes(m, 1)
      const c = ticket([ids[0] as string])
      // The device says it is 2 p.m. on October 20 (more than 12 h off).
      const r = m.send(
        WAITER,
        order,
        'ItemsSent',
        { tickets: [c] },
        new Date(BOGOTA('2026-10-20T14:00:00')).toISOString(),
      )
      expect(r.accepted?.business_day).toBe('2026-10-25')
      expect(numbers(r.accepted)).toEqual({ [c.ticket_id]: 1 })
    })

    it('a clock more than a minute ahead does not move the day forward either', () => {
      const m = setup(store)
      m.setFor('2026-10-24T23:00:00')
      const { order, ids } = withDishes(m, 1)
      const c = ticket([ids[0] as string])
      const r = m.send(
        WAITER,
        order,
        'ItemsSent',
        { tickets: [c] },
        new Date(BOGOTA('2026-10-25T09:00:00')).toISOString(),
      )
      expect(r.accepted?.business_day).toBe('2026-10-24')
    })

    it('the day start is configurable (4:00 a.m.)', () => {
      const m = setup(store, { businessDayStart: '04:00' })
      expect(sendTicketAt(m, '2026-10-25T03:59:00').day).toBe('2026-10-24')
      expect(sendTicketAt(m, '2026-10-25T04:00:00')).toEqual({ number: 1, day: '2026-10-25' })
    })
  })

  it('the restarted hub continues the count where it was (numbering lives in the saved events)', () => {
    const m = setup(store)
    const { order, ids } = withDishes(m, 2)
    m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([ids[0] as string])] })
    const restarted = new HubSync(m.saved, {
      restaurantId: m.restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-2',
      clock: () => new Date(m.now()).toISOString(),
      access: openAccess,
    })
    const c = ticket([ids[1] as string])
    const r = restarted.receiveBatch(WAITER, [m.raw(WAITER, order, 'ItemsSent', { tickets: [c] })])
    expect(numbers(r.acceptedEvents[0])).toEqual({ [c.ticket_id]: 2 })
  })

  it('a send with 40 tickets numbers 1 to 40 in the order received, with no repeats', () => {
    const m = setup(store)
    const { order, ids } = withDishes(m, 40)
    const tickets = ids.map((id) => ticket([id]))
    const r = m.send(WAITER, order, 'ItemsSent', { tickets })
    expect(r.result?.status).toBe('confirmed')
    const given = numbers(r.accepted) ?? {}
    expect(tickets.map((c) => given[c.ticket_id])).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    )
  })
})

describe('ticket number: several restaurants in the same database', () => {
  it('each restaurant keeps its own day count', () => {
    const { db, restaurantId } = sqliteDatabase()
    const other = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, '2026-10-24T15:00:00.000Z', '2026-10-24T15:00:00.000Z', 1, 'Otro', '{}')`,
    ).run(other, other)
    const ms = BOGOTA('2026-10-24T15:00:00')
    const hubOf = (id: string) =>
      new HubSync(new SqliteStore(db, id), {
        restaurantId: id,
        timeZone: 'America/Bogota',
        businessDayStart: '06:00',
        instance: `hub-${id}`,
        clock: () => new Date(ms).toISOString(),
        access: openAccess,
      })
    const [a, b] = [hubOf(restaurantId), hubOf(other)]
    let sequence = 0
    const event = (connection: Connection, order: string, type: string, data: unknown) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data,
      session_id: null,
      user_id: USER,
      device_id: connection.deviceId,
      authorization_id: null,
      reason: null,
      device_time: new Date(ms).toISOString(),
      hub_estimated_time: new Date(ms).toISOString(),
      base_sequence: sequence,
    })
    const sendIn = (hub: HubSync, base: number, tickets: number) => {
      const order = newId()
      const dishes = Array.from({ length: tickets }, () => item())
      sequence = base
      const batch = [
        event(WAITER, order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 }),
        ...dishes.map((p) => event(WAITER, order, 'ItemAdded', p)),
        event(WAITER, order, 'ItemsSent', {
          tickets: dishes.map((p) => ticket([p.item_id])),
        }),
      ]
      const r = hub.receiveBatch(WAITER, batch)
      expect(r.results.every((x) => x.status === 'confirmed')).toBe(true)
      return Object.values(numbers(r.acceptedEvents.at(-1)) ?? {})
    }
    // Sequences are global to the database: the second restaurant starts at its own.
    const maxOf = (id: string) =>
      Number(
        db
          .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
          .get(id)?.s,
      )
    expect(sendIn(a, maxOf(restaurantId), 2)).toEqual([1, 2])
    expect(sendIn(b, maxOf(other), 3)).toEqual([1, 2, 3])
    expect(sendIn(a, maxOf(restaurantId), 1)).toEqual([3])
    expect(sendIn(b, maxOf(other), 1)).toEqual([4])
  })
})

describe('ticketsOfDay (stores)', () => {
  it.each(['memory', 'sqlite'] as const)(
    '%s: adds up the tickets of the day sends and of no other event',
    (store) => {
      const m = setup(store)
      expect(m.saved.ticketsOfDay('2026-10-24')).toBe(0)
      const { order, ids } = withDishes(m, 3)
      m.send(WAITER, order, 'ItemsSent', {
        tickets: [ticket([ids[0] as string]), ticket([ids[1] as string])],
      })
      m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([ids[2] as string])] })
      expect(m.saved.ticketsOfDay('2026-10-24')).toBe(3)
      expect(m.saved.ticketsOfDay('2026-10-23')).toBe(0)
      expect(m.saved.ticketsOfDay('2026-10-25')).toBe(0)
    },
  )
})

describe.each(['memory', 'sqlite'] as const)('onSave (%s)', (store) => {
  type Call = { event: OrderEvent; changes: OrderChange[] }
  const withHook = () => {
    const calls: Call[] = []
    const failures: { error: unknown; id: string }[] = []
    const m = setup(store, {
      onSave: (event, changes) => {
        calls.push({ event, changes })
      },
      onSaveFailure: (error, id) => failures.push({ error, id }),
    })
    return { m, calls, failures }
  }

  it('receives the event already numbered and the order before and after applying it', () => {
    const { m, calls } = withHook()
    const { order, ids } = withDishes(m, 1)
    calls.length = 0
    const c = ticket([ids[0] as string])
    const r = m.send(WAITER, order, 'ItemsSent', { tickets: [c] })
    expect(calls).toHaveLength(1)
    const { event, changes } = calls[0] as Call
    expect(event.id).toBe(r.accepted?.id)
    expect(event.sequence).toBe(r.accepted?.sequence)
    expect(numbers(event)).toEqual({ [c.ticket_id]: 1 })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.before?.items[ids[0] as string]?.status).toBe('pending')
    expect(changes[0]?.after?.items[ids[0] as string]?.status).toBe('sent')
    // The hub projection is up to date afterward.
    expect(m.hub.order(order)?.items[ids[0] as string]?.status).toBe('sent')
  })

  it('when opening an order, before is null; a product event carries no orders', () => {
    const { m, calls } = withHook()
    const order = newId()
    m.send(WAITER, order, 'OrderOpened', { channel: 'bar', table_id: null, guests: 1 })
    expect(calls[0]?.changes).toEqual([
      { before: null, after: expect.objectContaining({ id: order, status: 'open' }) },
    ])
    calls.length = 0
    const product = {
      id: newId(),
      type: 'ProductSoldOut',
      schema_version: 1,
      aggregate_type: 'product',
      aggregate_id: newId(),
      related: [],
      data: { product_id: newId(), variant_id: null },
      session_id: null,
      user_id: USER,
      device_id: WAITER.deviceId,
      authorization_id: null,
      reason: null,
      device_time: new Date(m.now()).toISOString(),
      hub_estimated_time: new Date(m.now()).toISOString(),
      base_sequence: m.saved.maxSequence(),
    }
    const r = m.hub.receiveBatch(WAITER, [product])
    if (r.acceptedEvents.length > 0) {
      expect(calls).toHaveLength(1)
      expect(calls[0]?.changes).toEqual([])
    }
  })

  it('the "before" order is not modified when applying the event (it is a snapshot)', () => {
    const { m, calls } = withHook()
    const { order, ids } = withDishes(m, 2)
    calls.length = 0
    m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([ids[0] as string])] })
    m.send(WAITER, order, 'ItemReady', { item_ids: [ids[0] as string] })
    const [sent, ready] = calls as [Call, Call]
    expect(sent.changes[0]?.before?.items[ids[0] as string]?.status).toBe('pending')
    expect(sent.changes[0]?.after?.items[ids[0] as string]?.status).toBe('sent')
    expect(ready.changes[0]?.before?.items[ids[0] as string]?.status).toBe('sent')
    expect(ready.changes[0]?.after?.items[ids[0] as string]?.status).toBe('ready')
  })

  it('does not run with a rejected event nor with a resent one', () => {
    const { m, calls } = withHook()
    const { order, ids } = withDishes(m, 1)
    const total = calls.length
    const badCase = m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([newId()])] })
    expect(badCase.result?.status).toBe('rejected')
    const event = m.raw(WAITER, order, 'ItemsSent', {
      tickets: [ticket([ids[0] as string])],
    })
    m.hub.receiveBatch(WAITER, [event])
    m.hub.receiveBatch(WAITER, [event])
    expect(calls.length).toBe(total + 1)
  })

  it('if the hook throws, the event is still accepted, confirmed and the failure reported', () => {
    const failures: { error: unknown; id: string }[] = []
    const m = setup(store, {
      onSave: () => {
        throw new Error('the printer blew up')
      },
      onSaveFailure: (error, id) => failures.push({ error, id }),
    })
    const { order, ids } = withDishes(m, 1)
    const c = ticket([ids[0] as string])
    const r = m.send(WAITER, order, 'ItemsSent', { tickets: [c] })
    expect(r.result?.status).toBe('confirmed')
    expect(r.accepted).toBeDefined()
    expect(numbers(r.accepted)).toEqual({ [c.ticket_id]: 1 })
    expect(m.saved.byId(r.accepted?.id as string)).toBeDefined()
    expect(m.hub.order(order)?.items[ids[0] as string]?.status).toBe('sent')
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.at(-1)?.id).toBe(r.accepted?.id)
    expect(String((failures.at(-1)?.error as Error | undefined)?.message)).toBe(
      'the printer blew up',
    )
    // And the hub keeps working.
    expect(
      m.send(WAITER, order, 'ItemReady', { item_ids: [ids[0] as string] }).result?.status,
    ).toBe('confirmed')
  })

  it('if the hook throws and nobody listens for the failure, it does not stop the event either', () => {
    const m = setup(store, {
      onSave: () => {
        throw new Error('x')
      },
    })
    const { order } = withDishes(m, 0)
    expect(order).toBeTruthy()
    expect(m.saved.maxSequence()).toBe(1)
  })

  it('a hook failure on one event does not affect the others in the same batch', () => {
    let n = 0
    const m = setup(store, {
      onSave: () => {
        n += 1
        if (n === 2) throw new Error('only the second')
      },
    })
    const order = newId()
    const dishes = [item(), item()]
    const batch = [
      m.raw(WAITER, order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 }),
      ...dishes.map((p) => m.raw(WAITER, order, 'ItemAdded', p)),
    ]
    const r = m.hub.receiveBatch(WAITER, batch)
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(r.acceptedEvents).toHaveLength(3)
  })
})

describe('onSave: same transaction as the event (SQLite)', () => {
  class CrashesAtEnd extends SqliteStore {
    crashes = false
    override transaction<T>(job: () => T): T {
      return super.transaction(() => {
        const r = job()
        if (this.crashes) throw new Error('power went out before the COMMIT')
        return r
      })
    }
  }

  function setupWithProbe() {
    const { db, restaurantId } = sqliteDatabase()
    db.exec('CREATE TABLE sonda (event_id TEXT, event_existed INTEGER)')
    const store = new CrashesAtEnd(db, restaurantId)
    const hub = new HubSync(store, {
      restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock: () => '2026-10-24T20:00:00.000Z',
      access: openAccess,
      onSave: (event) => {
        // The event is already saved when the hook runs.
        const row = db
          .prepare('SELECT count(*) AS n FROM events WHERE restaurant_id = ? AND id = ?')
          .get(restaurantId, event.id)
        db.prepare('INSERT INTO sonda VALUES (?, ?)').run(event.id, Number(row?.n))
      },
    })
    const raw = (order: string) => ({
      id: newId(),
      type: 'OrderOpened',
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data: { channel: 'dine_in', table_id: null, guests: 1 },
      session_id: null,
      user_id: USER,
      device_id: WAITER.deviceId,
      authorization_id: null,
      reason: null,
      device_time: '2026-10-24T20:00:00.000Z',
      hub_estimated_time: '2026-10-24T20:00:00.000Z',
      base_sequence: 0,
    })
    return { db, store, hub, raw }
  }

  it('what the hook writes is saved together with the event and sees the event already saved', () => {
    const { db, hub, raw } = setupWithProbe()
    const e = raw(newId())
    hub.receiveBatch(WAITER, [e])
    expect(db.prepare('SELECT * FROM sonda').all()).toEqual([{ event_id: e.id, event_existed: 1 }])
  })

  it('if the hub crashes before committing, neither the event nor what the hook wrote remains', () => {
    const { db, store, hub, raw } = setupWithProbe()
    store.crashes = true
    const e = raw(newId())
    // The rejection cannot be saved either: the store is down and the hub must restart.
    expect(() => hub.receiveBatch(WAITER, [e])).toThrow(/power went out/)
    expect(db.prepare('SELECT count(*) AS n FROM sonda').get()).toEqual({ n: 0 })
    expect(Number(db.prepare('SELECT count(*) AS n FROM events WHERE id = ?').get(e.id)?.n)).toBe(0)
  })
})

// ── `printers` message ──────────────────────────────────────────────────

const STATUSES: PrinterStatus[] = [
  { id: newId(), name: 'Cocina', status: 'ready', error: null, pendingList: 0 },
  {
    id: newId(),
    name: 'Barra',
    status: 'failed',
    error: 'La impresora no responde',
    pendingList: 3,
  },
]

function setupFloor() {
  const m = setup('memory')
  const tokens = new Map<string, Connection>([
    ['t-ana', { deviceId: newId(), type: 'waiter', revokedAt: null }],
    ['t-caja', { deviceId: newId(), type: 'register', revokedAt: null }],
    ['t-rev', { deviceId: newId(), type: 'waiter', revokedAt: '2026-10-24T10:00:00.000Z' }],
  ])
  const floor = new FloorSync(m.hub, (t) => tokens.get(t) ?? null)
  const connect = (token?: string) => {
    const received: HubMessage[] = []
    const link = floor.connect((msg) => received.push(JSON.parse(JSON.stringify(msg))))
    if (token)
      link.receive({ type: 'hello', token, hub_instance: null, until: 0, version_app: 'x' })
    return { received, link }
  }
  const printers = (r: HubMessage[]) => r.filter((x) => x.type === 'printers')
  return { floor, connect, printers, tokens }
}

describe('printers message', () => {
  it('connected devices receive it every time the status changes', () => {
    const { floor, connect, printers } = setupFloor()
    const ana = connect('t-ana')
    const register = connect('t-caja')
    floor.notifyPrinters(STATUSES)
    expect(printers(ana.received)).toEqual([{ type: 'printers', printers: STATUSES }])
    expect(printers(register.received)).toEqual([{ type: 'printers', printers: STATUSES }])
    const healthyPrinters = STATUSES.map((e) => ({
      ...e,
      status: 'ready' as const,
      error: null,
      pendingList: 0,
    }))
    floor.notifyPrinters(healthyPrinters)
    expect(printers(ana.received).at(-1)).toEqual({ type: 'printers', printers: healthyPrinters })
    expect(printers(ana.received)).toHaveLength(2)
  })

  it('a device that connects later receives the latest status right after the welcome', () => {
    const { floor, connect } = setupFloor()
    floor.notifyPrinters(STATUSES)
    const late = connect('t-ana')
    expect(late.received.map((r) => r.type)).toEqual(['welcome', 'printers'])
    expect(late.received[1]).toEqual({ type: 'printers', printers: STATUSES })
  })

  it('on connect it receives the most recent status, not an old one', () => {
    const { floor, connect } = setupFloor()
    floor.notifyPrinters(STATUSES)
    floor.notifyPrinters([STATUSES[0] as PrinterStatus])
    const late = connect('t-caja')
    expect(late.received[1]).toEqual({ type: 'printers', printers: [STATUSES[0]] })
  })

  it('if nothing is known about the printers yet, only the welcome arrives on connect', () => {
    const { connect } = setupFloor()
    expect(connect('t-ana').received.map((r) => r.type)).toEqual(['welcome'])
  })

  it('an empty list is sent to connected devices, but a new device receives nothing extra', () => {
    const { floor, connect, printers } = setupFloor()
    const ana = connect('t-ana')
    floor.notifyPrinters(STATUSES)
    floor.notifyPrinters([])
    expect(printers(ana.received).at(-1)).toEqual({ type: 'printers', printers: [] })
    expect(connect('t-caja').received.map((r) => r.type)).toEqual(['welcome'])
  })

  it('it is not sent to whoever did not say hello, nor to whoever has an invalid token', () => {
    const { floor, connect, printers } = setupFloor()
    const anonymous = connect()
    const fake = connect('inventado')
    floor.notifyPrinters(STATUSES)
    expect(printers(anonymous.received)).toHaveLength(0)
    expect(printers(fake.received)).toHaveLength(0)
    expect(fake.received[0]).toMatchObject({ type: 'error', code: 'invalid_token' })
  })

  it('a retired device does not receive the status, neither on notify nor on connect', () => {
    const { floor, connect, printers } = setupFloor()
    const rev = connect('t-rev')
    floor.notifyPrinters(STATUSES)
    expect(printers(rev.received)).toHaveLength(0)
    expect(printers(connect('t-rev').received)).toHaveLength(0)
  })

  it('a device revoked later stops receiving it', () => {
    const { floor, connect, printers, tokens } = setupFloor()
    const ana = connect('t-ana')
    floor.notifyPrinters(STATUSES)
    floor.revoke((tokens.get('t-ana') as Connection).deviceId, '2026-10-24T21:00:00.000Z')
    floor.notifyPrinters([])
    expect(printers(ana.received)).toHaveLength(1)
  })

  it('a broken connection does not keep the others from receiving the notice, and is dropped', () => {
    const m = setup('memory')
    const connection: Connection = { deviceId: newId(), type: 'waiter', revokedAt: null }
    const floor = new FloorSync(m.hub, () => connection)
    let broken = false
    const received: HubMessage[] = []
    const bad = floor.connect(() => {
      if (broken) throw new Error('socket closed')
    })
    const healthy = floor.connect((msg) => received.push(msg))
    for (const e of [bad, healthy])
      e.receive({ type: 'hello', token: 't', hub_instance: null, until: 0, version_app: 'x' })
    broken = true
    expect(() => floor.notifyPrinters(STATUSES)).not.toThrow()
    expect(received.filter((r) => r.type === 'printers')).toHaveLength(1)
    // It is already dropped: a second notice does not touch it again.
    let taps = 0
    broken = false
    const countingLink = floor.connect(() => {
      taps += 1
    })
    countingLink.receive({
      type: 'hello',
      token: 't',
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    taps = 0
    floor.notifyPrinters(STATUSES)
    expect(taps).toBe(1)
  })

  it('the notice does not alter the status stored by the hub: the list is copied over the network', () => {
    const { floor, connect } = setupFloor()
    floor.notifyPrinters(STATUSES)
    const a = connect('t-ana')
    const b = connect('t-caja')
    expect(a.received[1]).toEqual(b.received[1])
  })

  it('a malformed device message still gets an error, not printers', () => {
    const { floor, connect } = setupFloor()
    floor.notifyPrinters(STATUSES)
    const c = connect('t-ana')
    c.link.receive({ type: 'printers', printers: [] })
    expect(c.received.at(-1)).toMatchObject({ type: 'error', code: 'invalid_message' })
  })
})

describe('the device and the printers message', () => {
  async function connected() {
    const sentList: unknown[] = []
    let changes = 0
    const failures: unknown[] = []
    const store = new MemoryDeviceStore()
    const client = new SyncClient({
      store,
      token: 't',
      versionApp: 'x',
      send: (m) => sentList.push(m),
      onChange: () => {
        changes += 1
      },
      onFailure: (e) => failures.push(e),
    })
    await client.onConnect()
    await client.ready()
    return { client, store, sentList, failures, changes: () => changes }
  }

  it('changes nothing stored, does not make the screen reread and asks nothing of the hub', async () => {
    const c = await connected()
    const before = { sentList: c.sentList.length, changes: c.changes() }
    await c.client.receive({ type: 'printers', printers: STATUSES })
    await c.client.ready()
    expect(c.sentList).toHaveLength(before.sentList)
    expect(c.changes()).toBe(before.changes)
    expect(c.failures).toEqual([])
    expect(await c.store.cursor()).toMatchObject({ until: 0 })
    expect(await c.client.locals()).toEqual([])
  })

  it('several notices in a row (even empty or repeated) do not break the message queue', async () => {
    const c = await connected()
    for (const list of [STATUSES, STATUSES, [], STATUSES.slice(0, 1)])
      await c.client.receive({ type: 'printers', printers: list })
    // A new hub event afterward is still processed normally.
    const m = setup('memory')
    const { order } = withDishes(m, 0)
    const e = m.hub.pull(0, 'waiter').events[0]
    await c.client.receive({
      type: 'new',
      event: e as OrderEvent,
      previous_until: 0,
      until: 1,
    })
    await c.client.ready()
    expect((await c.client.locals()).map((l) => l.event.aggregate_id)).toEqual([order])
    expect(c.failures).toEqual([])
  })
})
