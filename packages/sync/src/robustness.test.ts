import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { SyncClient } from './device/client'
import { MemoryDeviceStore } from './device/store'
import { canonicalJson, eventFingerprint, fingerprint, MAX_DEPTH } from './fingerprint'
import { HubSync } from './hub/hub'
import { MemoryStore } from './hub/store'
import type { DeviceMessage, HubMessage } from './protocol'
import { openAccess } from './testing/access'
import type { NetNode } from './testing/network'
import { eventsOf, item, NOW, openOrder, type Setup, seeTheSame, setup } from './testing/setup'

// What the task 0.6 review found: inputs that must not crash the hub, device races on
// reconnect, the skewed clock and what a revoked device sees.

const raw = (node: NetNode, order: string, type: string, data: unknown, extras = {}) => ({
  id: newId(),
  type,
  schema_version: 1,
  aggregate_type: 'order',
  aggregate_id: order,
  related: [],
  data,
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

const open = (node: NetNode, order: string, extras = {}) =>
  raw(node, order, 'OrderOpened', { channel: 'bar', table_id: null, guests: 1 }, extras)

const connectionOf = (m: Setup, node: NetNode) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`No token for ${node.name}`)
  return connection
}

function nested(nestLevels: number): unknown {
  let value: unknown = 'fondo'
  for (let i = 0; i < nestLevels; i++) value = { a: value }
  return value
}

describe('fingerprint', () => {
  it('does not depend on key order or on `base_sequence`', () => {
    expect(fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }),
    )
    expect(eventFingerprint({ id: 'x', base_sequence: 7 })).toBe(
      eventFingerprint({ id: 'x', base_sequence: 0 }),
    )
    expect(eventFingerprint({ id: 'x', reason: 'a' })).not.toBe(
      eventFingerprint({ id: 'x', reason: 'b' }),
    )
  })

  it('stops walking something too deeply nested instead of exhausting the stack', () => {
    expect(() => canonicalJson(nested(MAX_DEPTH - 1))).not.toThrow()
    expect(() => canonicalJson(nested(MAX_DEPTH + 1))).toThrow(RangeError)
    expect(() => fingerprint(nested(100_000))).toThrow(RangeError)
  })
})

describe('hub: inputs that must not crash it', () => {
  it('an event without id, malformed, repeated: same response and a single stored rejection', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const badCase = { type: 'OrderOpened', data: null }
    const r1 = m.hub().receiveBatch(connectionOf(m, ana), [badCase])
    const r2 = m.hub().receiveBatch(connectionOf(m, ana), [badCase])

    expect(r1.results).toEqual(r2.results)
    expect(r1.results[0]).toMatchObject({ id: '', status: 'rejected' })
    expect(m.db.prepare('SELECT count(*) AS n FROM rejected_events').get()?.n).toBe(1)
  })

  it('huge or deeply nested events are rejected without walking them and the batch goes on', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const order = newId()
    const r = m
      .hub()
      .receiveBatch(connectionOf(m, ana), [
        { ...open(ana, order), reason: 'x'.repeat(70_000) },
        { ...open(ana, newId()), data: nested(100_000) },
        open(ana, newId()),
      ])

    expect(r.results.map((x) => x.status)).toEqual(['rejected', 'rejected', 'confirmed'])
    expect(r.results[0]).toMatchObject({ reason: 'schema: too_large' })
    expect(r.results[1]).toMatchObject({ reason: 'schema: too_deeply_nested' })
  })

  it('an event that makes the hub fail is rejected as `internal_error`; the rest of the batch goes on', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const errors: string[] = []
    const store = new MemoryStore()
    const poison = open(ana, newId())
    const original = store.saveEvent.bind(store)
    store.saveEvent = (event, ...rest) => {
      if (event.id === poison.id) throw new Error('fails with this event')
      original(event, ...rest)
    }
    const hub = new HubSync(store, {
      restaurantId: '',
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      access: openAccess,
      instance: 'hub-1',
      clock: m.network.isoTime,
      onInternalError: (_error, id) => errors.push(id),
    })

    const r = hub.receiveBatch(connectionOf(m, ana), [poison, open(ana, newId())])
    const onceMore = hub.receiveBatch(connectionOf(m, ana), [poison])

    expect(r.results.map((x) => x.status)).toEqual(['rejected', 'confirmed'])
    expect(r.results[0]).toMatchObject({ reason: 'internal_error' })
    expect(onceMore.results).toEqual([r.results[0]])
    expect(errors).toEqual([poison.id])
  })

  it('if the store cannot even save the rejection, the hub throws (restarts) and nothing is left half done', () => {
    const m = setup({ store: 'memory' })
    const ana = m.network.device('ana')
    const store = m.store as MemoryStore
    store.fail = () => {
      throw new Error('disk full')
    }

    expect(() => m.hub().receiveBatch(connectionOf(m, ana), [open(ana, newId())])).toThrow(
      'disk full',
    )
    expect(store.events).toHaveLength(0)
    expect(store.rejections).toHaveLength(0)
  })

  it('a connection that fails on send does not leave the others without the event', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const broken = m.network.floor.connect((message) => {
      if (message.type === 'new') throw new Error('socket closed')
    })
    broken.receive({
      type: 'hello',
      token: 'token-luis',
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })

    const order = await openOrder(ana)
    await m.network.settle()

    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [order])
  })
})

describe('hub: up to date and projections', () => {
  it('what the same device did before counts as known: its own error is rejected', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const order = newId()
    const r = m.hub().receiveBatch(connectionOf(m, ana), [
      open(ana, order),
      raw(ana, order, 'ItemAdded', item()),
      // Everything in the order was done by ana: there is nothing it did not know about.
      raw(ana, order, 'ItemRemoved', { item_id: newId() }),
    ])

    expect(r.results[2]).toMatchObject({ status: 'rejected', reason: 'item_not_found' })
    expect(m.hub().conflicts()).toEqual([])
  })

  it('a canceled order leaves the hub memory but can still be read from the database', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    const order = newId()
    m.hub().receiveBatch(connectionOf(m, ana), [
      open(ana, order),
      raw(ana, order, 'OrderCanceled', {}, { base_sequence: 1, reason: 'Se fueron' }),
    ])
    expect(m.hub().order(order)?.status).toBe('canceled')

    // Luis did not know about the cancellation: his change comes in as a conflict and does not
    // change the order.
    const late = m
      .hub()
      .receiveBatch(connectionOf(m, luis), [
        raw(luis, order, 'GuestsChanged', { guests: 3 }, { base_sequence: 1 }),
      ])
    expect(late.results[0]).toMatchObject({ status: 'confirmed', conflict: 'order_closed' })
    expect(m.hub().order(order)?.guests).toBe(1)
  })
})

describe('revoked device', () => {
  it('receives no floor events; what it did before goes to quarantine, with a cap', async () => {
    const m = setup({ store: 'memory' })
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    const errors: string[] = []
    await m.network.connectAll()
    const connection = connectionOf(m, ana)
    connection.revokedAt = m.network.isoTime()
    ana.toDevice = []

    await openOrder(luis)
    await m.network.settle()
    expect(ana.toDevice).toEqual([])

    const floor = m.network.floor.connect((message) => {
      if (message.type === 'error') errors.push(message.code)
    })
    floor.receive({
      type: 'hello',
      token: 'token-ana',
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    floor.receive({ type: 'pull', from: 0 })
    expect(errors).toEqual(['revoked_token'])

    const before = { hub_estimated_time: '2026-10-24T19:00:00.000Z' }
    for (let i = 0; i < 6; i++) {
      m.hub().receiveBatch(
        connection,
        Array.from({ length: 100 }, () => open(ana, newId(), before)),
      )
    }
    expect((m.store as MemoryStore).quarantines).toHaveLength(500)
  })
})

describe('session of whoever created the event', () => {
  it('only the device that created it receives it', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const session = newId()
    await ana.create(
      newId(),
      'OrderOpened',
      { channel: 'bar', table_id: null, guests: 1 },
      {
        session_id: session,
      },
    )
    await m.network.settle()

    const [fromAna] = await ana.client.locals()
    const [fromLuis] = await luis.client.locals()
    expect(fromAna?.event.session_id).toBe(session)
    expect(fromLuis?.event.session_id).toBeNull()
    expect(m.hub().pull(0, 'waiter', ana.deviceId).events[0]?.session_id).toBe(session)
    expect(m.hub().pull(0, 'waiter', luis.deviceId).events[0]?.session_id).toBeNull()
  })
})

describe('client: reconnections and clock', () => {
  /** A standalone client, without network: what it sends stays in `sentList`. */
  function lone() {
    const sentList: DeviceMessage[] = []
    const store = new MemoryDeviceStore()
    let clock = Date.parse('2026-10-24T20:00:00.000Z')
    const client = new SyncClient({
      store,
      token: 't',
      versionApp: 'x',
      send: (message) => sentList.push(message),
      now: () => clock,
    })
    return { client, sentList, store, advance: (ms: number) => (clock += ms) }
  }
  const welcome = (time = '2026-10-24T20:00:00.000Z'): HubMessage => ({
    type: 'welcome',
    hub_instance: 'hub-1',
    max_sequence: 0,
    hub_time: time,
  })

  it('what arrives through an already closed connection is not processed and sends nothing on the new one', async () => {
    const { client, sentList } = lone()
    await client.onConnect()
    const belated = client.receive(welcome())
    client.onDisconnect()
    const newOne = client.onConnect()
    await Promise.all([belated, newOne])

    expect(sentList.map((x) => x.type)).toEqual(['hello', 'hello'])
  })

  it('an event recorded twice is saved only once', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const event = await ana.create(newId(), 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })
    expect(await ana.client.record(event)).toEqual({ ok: true })
    expect(await ana.client.pendingList()).toBe(1)
  })

  it('learns the clock offset on connect, uses it in `hub_estimated_time` and saves it', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    ana.offsetMs = -59_000 // like the Android in the phone test (ADR-001)
    await m.network.connectAll()

    const event = await ana.create(newId(), 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })
    expect(event.hub_estimated_time).toBe(m.network.isoTime())
    expect(event.device_time).not.toBe(m.network.isoTime())
    expect((await ana.store.cursor()).offsetMs).toBe(59_000)

    const other = new SyncClient({
      store: ana.store,
      token: 't',
      versionApp: 'x',
      send: () => {},
      now: () => m.network.now() - 59_000,
    })
    await other.begin()
    expect(other.hubEstimatedTime()).toBe(m.network.isoTime())
  })

  it('a rejection arriving after the event came back confirmed does not undo it', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    await m.network.connectAll()
    ana.rule('to_device', 'result', 'drop')
    const event = await ana.create(newId(), 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })
    await m.network.settle()
    expect((await ana.client.locals())[0]?.status).toBe('confirmed')

    // A late result (from a resend) arrives saying no.
    const batch = (ana.client as unknown as { inFlightBatch: unknown }).inFlightBatch
    expect(batch).toBeNull()
    ;(ana.client as unknown as { inFlightBatch: unknown }).inFlightBatch = {
      id: 'tarde',
      events: [event.id],
    }
    await ana.client.receive({
      type: 'result',
      batch_id: 'tarde',
      results: [{ id: event.id, status: 'rejected', reason: 'duplicate_id' }],
    })
    expect((await ana.client.locals())[0]?.status).toBe('confirmed')
  })

  it('a hub error for an invalid token stops sending and notifies the app', async () => {
    const errors: string[] = []
    const sentList: DeviceMessage[] = []
    const client = new SyncClient({
      store: new MemoryDeviceStore(),
      token: 't',
      versionApp: 'x',
      send: (message) => sentList.push(message),
      onHubError: (code) => errors.push(code),
    })
    await client.onConnect()
    await client.receive({ type: 'error', code: 'invalid_token', message: 'no' })
    await client.receive(welcome())

    expect(errors).toEqual(['invalid_token'])
    expect(sentList.map((x) => x.type)).toEqual(['hello'])
  })

  it('a failure processing a message does not break the queue: it reaches `onFailure` and the rest goes on', async () => {
    const failures: unknown[] = []
    const store = new MemoryDeviceStore()
    const sentList: DeviceMessage[] = []
    const client = new SyncClient({
      store,
      token: 't',
      versionApp: 'x',
      send: (message) => sentList.push(message),
      onFailure: (error) => failures.push(error),
    })
    await client.onConnect()
    const cursor = store.cursor.bind(store)
    store.cursor = async () => {
      store.cursor = cursor
      throw new Error('IndexedDB closed')
    }
    await client.receive(welcome())
    await client.receive(welcome())

    expect(failures).toHaveLength(1)
    expect(sentList.map((x) => x.type)).toEqual(['hello', 'pull'])
  })
})
