import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { SyncClient } from './device/client'
import { MemoryDeviceStore } from './device/store'
import { FloorSync } from './hub/floor'
import { type Connection, HubSync } from './hub/hub'
import { MemoryStore } from './hub/store'
import { type CloudState, type CloudStatus, DeviceMessage, type HubMessage } from './protocol'
import { openAccess } from './testing/access'

// The `cloud` message (task 1.11, ADR-016): the hub tells every connected device how the upload
// to the cloud is going, when they connect and every time it changes.

const STATUS: CloudStatus = { state: 'uploading', pending: 12, last_upload_at: null }
const AT_DAY: CloudStatus = {
  state: 'up_to_date',
  pending: 0,
  last_upload_at: '2026-10-29T15:00:00.000Z',
}

function setupFloor() {
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: () => '2026-10-29T15:00:00.000Z',
    access: openAccess,
  })
  const tokens = new Map<string, Connection>([
    ['t-ana', { deviceId: newId(), type: 'waiter', revokedAt: null }],
    ['t-caja', { deviceId: newId(), type: 'register', revokedAt: null }],
    ['t-cocina', { deviceId: newId(), type: 'kds', revokedAt: null }],
    ['t-rev', { deviceId: newId(), type: 'waiter', revokedAt: '2026-10-24T10:00:00.000Z' }],
  ])
  const floor = new FloorSync(hub, (t) => tokens.get(t) ?? null)
  const connect = (token?: string) => {
    const received: HubMessage[] = []
    const link = floor.connect((msg) => received.push(JSON.parse(JSON.stringify(msg))))
    if (token)
      link.receive({ type: 'hello', token, hub_instance: null, until: 0, version_app: 'x' })
    return { received, link }
  }
  const clouds = (r: HubMessage[]) => r.filter((x) => x.type === 'cloud')
  return { floor, connect, clouds, tokens }
}

describe('the hub notifies the cloud status', () => {
  it('every connected device receives it, whatever its type', () => {
    const { floor, connect, clouds } = setupFloor()
    const all = [connect('t-ana'), connect('t-caja'), connect('t-cocina')]
    floor.notifyCloud(STATUS)
    for (const d of all) expect(clouds(d.received)).toEqual([{ type: 'cloud', cloud: STATUS }])
  })

  it('every change is a new message, in order', () => {
    const { floor, connect, clouds } = setupFloor()
    const ana = connect('t-ana')
    const states: CloudState[] = ['not_connected', 'offline', 'uploading', 'stuck', 'revoked']
    for (const state of states) floor.notifyCloud({ state, pending: 1, last_upload_at: null })
    floor.notifyCloud(AT_DAY)
    expect(clouds(ana.received).map((m) => (m as { cloud: CloudStatus }).cloud.state)).toEqual([
      ...states,
      'up_to_date',
    ])
  })

  it('a device that connects later receives the latest status right after the welcome', () => {
    const { floor, connect } = setupFloor()
    floor.notifyCloud(STATUS)
    floor.notifyCloud(AT_DAY)
    const late = connect('t-ana')
    expect(late.received.map((r) => r.type)).toEqual(['welcome', 'cloud'])
    expect(late.received[1]).toEqual({ type: 'cloud', cloud: AT_DAY })
  })

  it('while nothing is known, only the welcome arrives on connect', () => {
    const { connect } = setupFloor()
    expect(connect('t-ana').received.map((r) => r.type)).toEqual(['welcome'])
  })

  it('the order on connect is welcome, printers, cloud', () => {
    const { floor, connect } = setupFloor()
    floor.notifyPrinters([
      { id: newId(), name: 'Cocina', status: 'ready', error: null, pendingList: 0 },
    ])
    floor.notifyCloud(STATUS)
    expect(connect('t-caja').received.map((r) => r.type)).toEqual(['welcome', 'printers', 'cloud'])
  })

  it('it is not sent to whoever did not say hello, nor to an invalid token', () => {
    const { floor, connect, clouds } = setupFloor()
    const anonymous = connect()
    const fake = connect('inventado')
    floor.notifyCloud(STATUS)
    expect(clouds(anonymous.received)).toHaveLength(0)
    expect(clouds(fake.received)).toHaveLength(0)
  })

  it('a retired device receives it neither on notify nor on connect', () => {
    const { floor, connect, clouds } = setupFloor()
    const rev = connect('t-rev')
    floor.notifyCloud(STATUS)
    expect(clouds(rev.received)).toHaveLength(0)
    expect(clouds(connect('t-rev').received)).toHaveLength(0)
  })

  it('a device revoked later stops receiving it', () => {
    const { floor, connect, clouds, tokens } = setupFloor()
    const ana = connect('t-ana')
    floor.notifyCloud(STATUS)
    floor.revoke((tokens.get('t-ana') as Connection).deviceId, '2026-10-29T16:00:00.000Z')
    floor.notifyCloud(AT_DAY)
    expect(clouds(ana.received)).toHaveLength(1)
  })

  it('a broken connection does not keep the others from receiving it, and is dropped', () => {
    const hub = new HubSync(new MemoryStore(), {
      restaurantId: newId(),
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'h',
      clock: () => '2026-10-29T15:00:00.000Z',
      access: openAccess,
    })
    const connection: Connection = { deviceId: newId(), type: 'waiter', revokedAt: null }
    const floor = new FloorSync(hub, () => connection)
    let broken = false
    const received: HubMessage[] = []
    const bad = floor.connect(() => {
      if (broken) throw new Error('socket closed')
    })
    const healthy = floor.connect((msg) => received.push(msg))
    for (const e of [bad, healthy])
      e.receive({ type: 'hello', token: 't', hub_instance: null, until: 0, version_app: 'x' })
    broken = true
    expect(() => floor.notifyCloud(STATUS)).not.toThrow()
    expect(received.filter((r) => r.type === 'cloud')).toHaveLength(1)
  })

  it('the message is a copy: changing the status later does not change what was told', () => {
    const { floor, connect } = setupFloor()
    const status = { ...STATUS }
    floor.notifyCloud(status)
    const ana = connect('t-ana')
    expect(ana.received[1]).toEqual({ type: 'cloud', cloud: STATUS })
  })

  it('the status travels as three plain fields: no credential, no hub id', () => {
    const { floor, connect } = setupFloor()
    const ana = connect('t-ana')
    floor.notifyCloud(AT_DAY)
    const message = ana.received.find((r) => r.type === 'cloud') as { cloud: object }
    expect(Object.keys(message.cloud).sort()).toEqual(['last_upload_at', 'pending', 'state'])
  })
})

describe('a device cannot send it', () => {
  it('the cloud message is not a device message', () => {
    expect(DeviceMessage.safeParse({ type: 'cloud', cloud: STATUS }).success).toBe(false)
  })

  it('the hub answers a forged one with an error and does not tell the others', () => {
    const { floor, connect, clouds } = setupFloor()
    const forger = connect('t-ana')
    const other = connect('t-caja')
    forger.link.receive({ type: 'cloud', cloud: STATUS } as never)
    expect(forger.received.at(-1)).toMatchObject({ type: 'error', code: 'invalid_message' })
    expect(clouds(other.received)).toHaveLength(0)
    // And what a new device is told later is still unknown.
    expect(connect('t-cocina').received.map((r) => r.type)).toEqual(['welcome'])
    void floor
  })
})

describe('the device receives it', () => {
  async function connected() {
    const sent: unknown[] = []
    let changes = 0
    const failures: unknown[] = []
    const store = new MemoryDeviceStore()
    const client = new SyncClient({
      store,
      token: 't',
      versionApp: 'x',
      send: (m) => sent.push(m),
      onChange: () => {
        changes += 1
      },
      onFailure: (e) => failures.push(e),
    })
    await client.onConnect()
    await client.ready()
    return { client, store, sent, failures, changes: () => changes }
  }

  it('stores nothing, does not make the screen reread and asks the hub nothing', async () => {
    const c = await connected()
    const before = { sent: c.sent.length, changes: c.changes() }
    await c.client.receive({ type: 'cloud', cloud: STATUS })
    await c.client.ready()
    expect(c.sent).toHaveLength(before.sent)
    expect(c.changes()).toBe(before.changes)
    expect(c.failures).toEqual([])
    expect(await c.store.cursor()).toMatchObject({ until: 0 })
    expect(await c.client.locals()).toEqual([])
  })

  it('many notices in a row (repeated, out of order, with a huge count) break nothing', async () => {
    const c = await connected()
    const before = c.changes()
    for (const cloud of [
      AT_DAY,
      STATUS,
      STATUS,
      { state: 'stuck' as const, pending: Number.MAX_SAFE_INTEGER, last_upload_at: null },
      AT_DAY,
    ])
      await c.client.receive({ type: 'cloud', cloud })
    await c.client.ready()
    expect(c.failures).toEqual([])
    expect(c.changes()).toBe(before)
  })

  it('a notice between two events of the hub does not break their continuity', async () => {
    const c = await connected()
    const event = (sequence: number) =>
      ({
        id: newId(),
        type: 'OrderOpened',
        schema_version: 1,
        aggregate_type: 'order',
        aggregate_id: newId(),
        related: [],
        data: { channel: 'takeout', table_id: null, guests: 0 },
        session_id: null,
        user_id: newId(),
        device_id: newId(),
        authorization_id: null,
        reason: null,
        device_time: '2026-10-29T15:00:00.000Z',
        hub_estimated_time: '2026-10-29T15:00:00.000Z',
        base_sequence: 0,
        sequence,
        received_at: '2026-10-29T15:00:00.000Z',
        business_day: '2026-10-29',
        assignments: { day_number: sequence },
        affects: [],
        authorized_by_id: null,
      }) as unknown as OrderEvent
    await c.client.receive({ type: 'new', event: event(1), previous_until: 0, until: 1 })
    await c.client.receive({ type: 'cloud', cloud: STATUS })
    await c.client.receive({ type: 'new', event: event(2), previous_until: 1, until: 2 })
    await c.client.ready()
    expect((await c.client.locals()).map((l) => l.event.sequence)).toEqual([1, 2])
    expect(c.failures).toEqual([])
    // No request to catch up was needed.
    expect(c.sent.filter((m) => (m as { type: string }).type === 'pull')).toHaveLength(0)
  })
})
