import 'fake-indexeddb/auto'
import { type NewEvent, newId, signEvent, validateNewEvent } from '@pos/core'
import {
  type AccessControl,
  type Catalog,
  type Channel,
  type DeviceMessage,
  FloorSync,
  type Handlers,
  HubSync,
  MemoryStore,
} from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Device, Floor, type Session } from './engine'
import { openOrders } from './projection'
import { DeviceDatabase } from './store'
import { testCatalog } from './testing'

// Floor failures (docs/SYNC.md): the hub goes down mid-batch, the token stops being valid, the
// session expires from inactivity, fast taps and a skewed clock. All with simulated clocks
// (no real waits) and an in-memory hub that requires the event's signature and device.

const T0 = new Date('2026-10-24T15:00:00.000Z')
const MIN = 60_000

const secretOf = (sessionId: string) => `secreto-${sessionId}`

const accessWithSignature: AccessControl = {
  verify: (_c, event) =>
    event.session_id && event.signature === signEvent(event, secretOf(event.session_id))
      ? { ok: true, authorizedById: null, authorizationId: null }
      : { ok: false, reason: 'invalid_signature' },
  recordUse: () => {},
}

// ── Time: timers and Date are fake; IndexedDB stays in real time ─────────────────────────────

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: T0,
  })
  // `exit` notifies the hub over HTTP; here it is only recorded.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  )
})

/** Lets IndexedDB operations run (they use `setImmediate`, which is not faked). */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

/** Advances the simulated clock in steps, letting IndexedDB run between steps. */
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(Math.min(100, ms - t))
    await settle(3)
  }
}

/** Advances until the condition holds; fails if it does not within `maxMs` of simulated clock. */
async function until(condition: () => Promise<boolean> | boolean, maxMs = 20_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (await condition()) return
    await advance(100)
  }
  throw new Error('Condition not met within the simulated time')
}

// ── In-memory hub with failures ──────────────────────────────────────────────────────────────

interface HubDevice extends Device {
  revokedAt: string | null
}

function setupHub(options: { hubOffsetMs?: number } = {}) {
  const tokens = new Map<string, HubDevice>()
  const store = new MemoryStore()
  const hub = new HubSync(store, {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date(Date.now() + (options.hubOffsetMs ?? 0)).toISOString(),
    access: accessWithSignature,
  })
  const hubFloor = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: e.revokedAt } : null
  })

  const channels = new Set<{ cut: () => void }>()
  const h = {
    hub,
    tokens,
    hubFloor,
    /** While true, no attempt to open reaches the hub. */
    down: false,
    openings: 0,
    /** Device messages that reached the hub, in order. */
    received: [] as DeviceMessage[],
    /** If it returns true for a message already on the hub, the channel is cut right after. */
    cutAfter: null as ((m: DeviceMessage) => boolean) | null,
    cutAll() {
      for (const c of [...channels]) c.cut()
    },
    open(m: Handlers): Channel {
      h.openings += 1
      let link: ReturnType<FloorSync['connect']> | null = null
      let closed = false
      const channel = {
        cut: () => {
          if (closed) return
          closed = true
          channels.delete(channel)
          link?.close()
          link = null
          m.onClose()
        },
      }
      channels.add(channel)
      setTimeout(() => {
        if (closed) return
        if (h.down) {
          channel.cut()
          return
        }
        link = hubFloor.connect((msg) => {
          const copy = JSON.parse(JSON.stringify(msg))
          setTimeout(() => {
            if (!closed) m.onMessage(copy)
          })
        })
        m.onOpen()
      })
      return {
        send: (msg) => {
          if (!link || closed) return
          const copy = JSON.parse(JSON.stringify(msg)) as DeviceMessage
          h.received.push(copy)
          link.receive(copy)
          if (h.cutAfter?.(copy)) channel.cut()
        },
        close: () => {
          closed = true
          channels.delete(channel)
          link?.close()
          link = null
        },
      }
    },
  }
  return h
}
type Hub = ReturnType<typeof setupHub>

const floors: Floor[] = []
const databases: DeviceDatabase[] = []
afterEach(async () => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  await settle(10)
  vi.useRealTimers()
  await settle(10)
  for (const b of databases.splice(0)) await b.delete()
  vi.unstubAllGlobals()
})

interface DeviceOptions {
  /** Makes `lastUsed` older or newer than now (ms). */
  msAgo?: number
  catalog?: Catalog | null
  /** The token is not on the hub (device retired or hub reinstalled). */
  withoutToken?: boolean
  /** A secret different from the one the hub knows. */
  secret?: string
  /** Start offline (the user turned off the connection before starting). */
  noConnection?: boolean
  db?: DeviceDatabase
}

async function device(h: Hub, name: string, o: DeviceOptions = {}) {
  const db = o.db ?? new DeviceDatabase(`resiliencia-${newId()}`)
  if (!o.db) databases.push(db)
  const e: HubDevice = {
    deviceId: newId(),
    token: newId(),
    name,
    type: 'waiter',
    revokedAt: null,
  }
  if (!o.withoutToken) h.tokens.set(e.token, e)
  const sessionId = newId()
  const session: Session = {
    sessionId,
    secret: o.secret ?? secretOf(sessionId),
    user: { id: newId(), name, role: 'Mesero' },
    permissions: ['take_order'],
    lastUsed: Date.now() - (o.msAgo ?? 0),
  }
  await db.saveSetting('device', {
    deviceId: e.deviceId,
    token: e.token,
    name: e.name,
    type: e.type,
  } satisfies Device)
  await db.saveSetting('session', session)
  if (o.catalog !== null) await db.saveSetting('catalog', o.catalog ?? testCatalog())
  const floor = new Floor({ db, open: (m) => h.open(m) })
  floors.push(floor)
  if (o.noConnection) floor.simulateOffline(true)
  await floor.load()
  return { floor, db, e, session }
}

const item = (price = 1_000) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Limonada',
  unit_price: price,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 4,
  price_channel_id: null,
})

const openOrder = (s: Floor, id = newId()) =>
  s.record('OrderOpened', id, { channel: 'dine_in', table_id: null, guests: 1 }).then(() => id)

const isConnected = (s: Floor) => s.snapshot().connection === 'connected'
const noPending = (s: Floor) => s.snapshot().pendingList === 0
const locals = async (s: Floor) => (await s.sync?.locals()) ?? []

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('record signs the event', () => {
  it('carries the session signature and the hub accepts it', async () => {
    const h = setupHub()
    const { floor, session, e } = await device(h, 'Ana')
    await until(() => isConnected(floor))
    const p = newId()
    const event = await floor.record('OrderOpened', p, {
      channel: 'dine_in',
      table_id: null,
      guests: 2,
    })

    const { signature, ...unsigned } = event
    expect(signature).toBe(signEvent(unsigned as NewEvent, session.secret))
    expect(event).toMatchObject({
      session_id: session.sessionId,
      user_id: session.user.id,
      device_id: e.deviceId,
      aggregate_type: 'order',
      aggregate_id: p,
      schema_version: 1,
    })
    expect(validateNewEvent(event).ok).toBe(true)
    // The envelope carries the device time and the hub's estimated time.
    expect(event.device_time).toBe(new Date(Date.now()).toISOString())

    await until(() => noPending(floor))
    expect(h.hub.order(p)).not.toBeNull()
  })

  it('with a secret the hub does not recognize the event is rejected and not shown', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana', { secret: 'secreto-equivocado' })
    await until(() => isConnected(floor))
    const p = await openOrder(floor)
    // Persist before showing: while the hub does not respond, it is already visible.
    expect(openOrders(await locals(floor)).map((v) => v.status.id)).toEqual([p])

    await until(() => noPending(floor))
    const [l] = await locals(floor)
    expect(l?.status).toBe('rejected')
    expect(l?.reason).toBe('invalid_signature')
    expect(openOrders(await locals(floor))).toEqual([])
    expect(h.hub.order(p)).toBeNull()
  })

  it('each signed event covers its own data: the signature changes with the data', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana', { noConnection: true })
    const p = newId()
    const a = await floor.record('OrderOpened', p, {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    const b = await floor.record('OrderOpened', newId(), {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    expect(a.signature).not.toBe(b.signature)
    expect(a.id).not.toBe(b.id)
  })
})

describe('the hub goes down in the middle of an operation', () => {
  it('goes down right after accepting a batch, before the response arrives: nothing is duplicated on return', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana', { noConnection: true })
    const p = await openOrder(floor)
    const ids = []
    for (let i = 0; i < 5; i++) {
      const it = item(2_000)
      await floor.record('ItemAdded', p, it)
      ids.push(it.item_id)
    }
    expect(floor.snapshot().pendingList).toBe(6)

    // The hub processes the batch and cuts off before the response arrives; it stays down a while.
    h.cutAfter = (m) => {
      if (m.type !== 'push') return false
      h.down = true
      return true
    }
    floor.simulateOffline(false)
    await until(() => h.received.some((m) => m.type === 'push'))
    await settle(10)
    expect(h.hub.order(p)?.items).toBeDefined()
    expect(Object.keys(h.hub.order(p)?.items ?? {})).toHaveLength(5)
    // The device did not see the response: it still believes they are pending.
    expect(floor.snapshot().pendingList).toBe(6)
    expect(floor.snapshot().connection).not.toBe('connected')

    // While it stays down there are retries, but spaced out (not a tight loop).
    const attempts = h.openings
    await advance(10_000)
    expect(h.openings - attempts).toBeLessThanOrEqual(6)
    expect(floor.snapshot().pendingList).toBe(6)

    h.down = false
    h.cutAfter = null
    await until(() => noPending(floor))

    const allConfirmed = (await locals(floor)).filter((l) => l.status === 'confirmed')
    expect(allConfirmed.map((l) => l.event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(Object.keys(h.hub.order(p)?.items ?? {}).sort()).toEqual([...ids].sort())
    expect(openOrders(await locals(floor))[0]?.total).toBe(10_000)
  })

  it('goes down between two batches of 100: the 150 events end up exactly once and in order', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana', { noConnection: true })
    const p = await openOrder(floor)
    for (let i = 0; i < 149; i++) await floor.record('ItemAdded', p, item(1_000))
    expect(floor.snapshot().pendingList).toBe(150)

    let batches = 0
    h.cutAfter = (m) => {
      if (m.type === 'push') batches += 1
      // The first batch arrives complete and the connection is cut before the response.
      return m.type === 'push' && batches === 1
    }
    floor.simulateOffline(false)
    await until(() => noPending(floor), 30_000)

    const eventsInHub = h.hub.order(p)
    expect(Object.keys(eventsInHub?.items ?? {})).toHaveLength(149)
    const allConfirmed = (await locals(floor)).filter((l) => l.status === 'confirmed')
    expect(allConfirmed).toHaveLength(150)
    expect(allConfirmed.map((l) => l.event.sequence)).toEqual(
      Array.from({ length: 150 }, (_, i) => i + 1),
    )
    expect(new Set(allConfirmed.map((l) => l.event.id)).size).toBe(150)
  })

  it('the hub is off at startup: what was recorded is kept and uploaded when it returns', async () => {
    const h = setupHub()
    h.down = true
    const { floor } = await device(h, 'Ana')
    await advance(3_000)
    expect(floor.snapshot().connection).not.toBe('connected')

    const p = await openOrder(floor)
    await floor.record('ItemAdded', p, item(5_000))
    expect(floor.snapshot().pendingList).toBe(2)
    expect(openOrders(await locals(floor))[0]?.total).toBe(5_000)

    h.down = false
    // The maximum wait between retries is 5 s (docs/SYNC.md).
    await until(() => isConnected(floor) && noPending(floor), 8_000)
    expect(h.hub.order(p)).not.toBeNull()
  })

  it('the hub process restarts (new floor, same database): the device reconnects on its own', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana')
    await until(() => isConnected(floor))
    const p = await openOrder(floor)
    await until(() => noPending(floor))

    h.down = true
    h.cutAll()
    expect(floor.snapshot().connection).not.toBe('connected')
    // Offline, order taking goes on.
    await floor.record('ItemAdded', p, item(3_000))
    expect(floor.snapshot().pendingList).toBe(1)

    h.down = false
    await until(() => isConnected(floor) && noPending(floor), 8_000)
    expect(Object.keys(h.hub.order(p)?.items ?? {})).toHaveLength(1)
  })
})

describe('invalid or revoked token', () => {
  it('the hub does not recognize the token: hubError is set, the connection stops and it does not retry', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana', { withoutToken: true })
    await until(() => floor.snapshot().hubError !== null)

    expect(floor.snapshot().hubError).toMatchObject({ code: 'invalid_token' })
    expect(floor.snapshot().connection).toBe('disconnected')

    // A long time passes and it does not retry (each attempt would only waste battery and data).
    const attempts = h.openings
    await advance(60_000)
    expect(h.openings).toBe(attempts)
    expect(floor.snapshot().connection).toBe('disconnected')
  })

  it('with the invalid token recording can go on: it is stored as pending', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana', { withoutToken: true })
    await until(() => floor.snapshot().hubError !== null)
    await openOrder(floor)
    expect(floor.snapshot().pendingList).toBe(1)
    await advance(10_000)
    expect(floor.snapshot().pendingList).toBe(1)
  })

  it('outdated_app also stops the connection', async () => {
    const h = setupHub()
    const outdated = new Floor({
      db: (() => {
        const db = new DeviceDatabase(`resiliencia-${newId()}`)
        databases.push(db)
        return db
      })(),
      open: (m) => {
        h.openings += 1
        setTimeout(() => m.onOpen())
        return {
          send: (msg) => {
            if (msg.type === 'hello')
              setTimeout(() =>
                m.onMessage({ type: 'error', code: 'outdated_app', message: 'Actualiza la app' }),
              )
          },
          close: () => {},
        }
      },
    })
    floors.push(outdated)
    await outdated.sync // no device yet
    const db = (outdated as unknown as { db: DeviceDatabase }).db
    await db.saveSetting('device', {
      deviceId: newId(),
      token: 't',
      name: 'Viejo',
      type: 'waiter',
    })
    await outdated.load()
    await until(() => outdated.snapshot().hubError !== null)
    expect(outdated.snapshot().hubError).toMatchObject({ code: 'outdated_app' })
    const attempts = h.openings
    await advance(30_000)
    expect(h.openings).toBe(attempts)
  })

  it('token revoked with the device connected: it notifies, stays connected and stops receiving the floor', async () => {
    const h = setupHub()
    const ana = await device(h, 'Ana')
    const beto = await device(h, 'Beto')
    await until(() => isConnected(ana.floor) && isConnected(beto.floor))

    // The manager retires Ana's device.
    const now = new Date().toISOString()
    const row = h.tokens.get(ana.e.token) as HubDevice
    row.revokedAt = now
    h.hubFloor.revoke(ana.e.deviceId, now)
    await until(() => ana.floor.snapshot().hubError !== null)
    expect(ana.floor.snapshot().hubError?.code).toBe('revoked_token')
    expect(isConnected(ana.floor)).toBe(true)

    // What Beto does afterwards no longer reaches Ana, but it still works for Beto.
    const p = await openOrder(beto.floor)
    await until(() => noPending(beto.floor))
    await advance(2_000)
    expect(openOrders(await locals(ana.floor))).toEqual([])
    expect(openOrders(await locals(beto.floor)).map((v) => v.status.id)).toEqual([p])
  })

  it('what the retired device does after the revocation does not enter the floor', async () => {
    const h = setupHub()
    const ana = await device(h, 'Ana')
    await until(() => isConnected(ana.floor))
    const now = new Date().toISOString()
    ;(h.tokens.get(ana.e.token) as HubDevice).revokedAt = now
    h.hubFloor.revoke(ana.e.deviceId, now)
    await until(() => ana.floor.snapshot().hubError !== null)

    vi.setSystemTime(Date.now() + 5_000)
    const p = await openOrder(ana.floor)
    await until(() => noPending(ana.floor))
    expect(h.hub.order(p)).toBeNull()
    const [l] = await locals(ana.floor)
    expect(l?.status).toBe('rejected')
    expect(openOrders(await locals(ana.floor))).toEqual([])
  })
})

describe('forgetDevice', () => {
  it('deletes credentials and session, stops the connection and keeps the stored events', async () => {
    const h = setupHub()
    const { floor, db } = await device(h, 'Ana', { withoutToken: true })
    await until(() => floor.snapshot().hubError !== null)
    await openOrder(floor)

    await floor.forgetDevice()
    const i = floor.snapshot()
    expect(i).toMatchObject({
      device: null,
      session: null,
      hubError: null,
      connection: 'disconnected',
    })
    expect(await db.readSetting('device')).toBeUndefined()
    expect(await db.readSetting('session')).toBeUndefined()
    // The catalog and the events stay.
    expect(await db.readSetting('catalog')).toBeDefined()
    expect(await db.events.count()).toBe(1)
    expect(floor.sync).toBeNull()

    const attempts = h.openings
    await advance(30_000)
    expect(h.openings).toBe(attempts)

    // Without a device nothing can be created nor the hub called.
    await expect(openOrder(floor)).rejects.toThrow('Sin sesión')
    await expect(floor.updateCatalog()).rejects.toThrow('todavía no ha entrado')
  })

  it('when reopening the app it has no device (asks to pair)', async () => {
    const h = setupHub()
    const { floor, db } = await device(h, 'Ana', { withoutToken: true })
    await until(() => floor.snapshot().hubError !== null)
    await floor.forgetDevice()
    const another = new Floor({ db, open: (m) => h.open(m) })
    floors.push(another)
    await another.load()
    expect(another.snapshot()).toMatchObject({ loaded: true, device: null, session: null })
    expect(another.snapshot().catalog).not.toBeNull()
  })

  it('pairing again connects with the new token', async () => {
    const h = setupHub()
    const { floor, db } = await device(h, 'Ana', { withoutToken: true })
    await until(() => floor.snapshot().hubError !== null)
    await floor.forgetDevice()

    const fresh: HubDevice = {
      deviceId: newId(),
      token: newId(),
      name: 'Ana',
      type: 'waiter',
      revokedAt: null,
    }
    h.tokens.set(fresh.token, fresh)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('/api/pair')
        // The code is normalized: no spaces and in uppercase.
        expect(JSON.parse(String(init?.body))).toEqual({ code: 'ABC123' })
        return new Response(
          JSON.stringify({
            device_id: fresh.deviceId,
            token: fresh.token,
            name: fresh.name,
            type: fresh.type,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    await floor.pair('  abc123 ')
    await until(() => isConnected(floor))
    expect(floor.snapshot().device?.token).toBe(fresh.token)
    expect(floor.snapshot().hubError).toBeNull()
    expect(await db.readSetting<Device>('device')).toMatchObject({ token: fresh.token })
  })

  // The stored events carry the device_id of the previous pairing, and the hub rejects
  // every event whose device is not the connection's. It is documented in `forgetDevice`
  // (the screen warns about it beforehand): this test pins that it is not lost silently, it ends up
  // rejected with its reason.
  it('what was pending before forgetting the device does not enter with the new token: it is rejected with a reason', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana', { withoutToken: true })
    await until(() => floor.snapshot().hubError !== null)
    const p = await openOrder(floor)
    await floor.forgetDevice()

    const fresh: HubDevice = {
      deviceId: newId(),
      token: newId(),
      name: 'Ana',
      type: 'waiter',
      revokedAt: null,
    }
    h.tokens.set(fresh.token, fresh)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              device_id: fresh.deviceId,
              token: fresh.token,
              name: 'Ana',
              type: 'waiter',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    await floor.pair('ABC123')
    await until(() => noPending(floor))
    expect(h.hub.order(p)).toBeNull()
    const [l] = await locals(floor)
    expect(l).toMatchObject({ status: 'rejected', reason: 'device_mismatch' })
  })
})

describe('session that expires from inactivity', () => {
  it('closes exactly at the configured minutes and notifies the hub', async () => {
    const h = setupHub()
    const { floor, session, db } = await device(h, 'Ana', {
      catalog: testCatalog({ restaurant: { name: 'P', sessionIdleMin: 10 } }),
    })
    floor.expireSessionIfDue(session.lastUsed + 10 * MIN - 1)
    expect(floor.snapshot().session).not.toBeNull()
    floor.expireSessionIfDue(session.lastUsed + 10 * MIN)
    expect(floor.snapshot().session).toBeNull()
    expect(floor.snapshot().sessionClosedBy).toBe('inactivity')

    await settle(10)
    expect(await db.readSetting('session')).toBeUndefined()
    const closeout = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url) === '/api/sessions/close')
    expect(closeout).toBeDefined()
    expect(JSON.parse(String(closeout?.[1]?.body))).toEqual({
      session_id: session.sessionId,
      secret: session.secret,
    })
  })

  it('without a stored catalog it uses 30 minutes', async () => {
    const h = setupHub()
    const { floor, session } = await device(h, 'Ana', { catalog: null })
    floor.expireSessionIfDue(session.lastUsed + 29 * MIN)
    expect(floor.snapshot().session).not.toBeNull()
    floor.expireSessionIfDue(session.lastUsed + 30 * MIN)
    expect(floor.snapshot().session).toBeNull()
  })

  it('opening the app with an already expired session asks for the PIN again', async () => {
    const h = setupHub()
    const { floor, db } = await device(h, 'Ana', { msAgo: 31 * MIN })
    expect(floor.snapshot().session).toBeNull()
    await settle(10)
    expect(await db.readSetting('session')).toBeUndefined()
    await expect(openOrder(floor)).rejects.toThrow('Sin sesión')
  })

  it('coming back to the screen (unlocking the phone) checks the expiration', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana')
    vi.setSystemTime(Date.now() + 45 * MIN)
    expect(floor.snapshot().session).not.toBeNull()
    floor.changeVisibility(false)
    expect(floor.snapshot().session).not.toBeNull()
    floor.changeVisibility(true)
    expect(floor.snapshot().session).toBeNull()
  })

  it('each tap postpones the close: with taps every 10 minutes it never expires', async () => {
    const h = setupHub()
    const { floor, session } = await device(h, 'Ana')
    for (let i = 1; i <= 12; i++) floor.markUsed(session.lastUsed + i * 10 * MIN)
    expect(floor.snapshot().session).not.toBeNull()
    expect(floor.snapshot().session?.lastUsed).toBe(session.lastUsed + 120 * MIN)
    // And after 30 minutes without taps, it does.
    floor.expireSessionIfDue(session.lastUsed + 150 * MIN)
    expect(floor.snapshot().session).toBeNull()
  })

  it('an already expired tap does not revive the session', async () => {
    const h = setupHub()
    const { floor, session } = await device(h, 'Ana')
    floor.markUsed(session.lastUsed + 40 * MIN)
    expect(floor.snapshot().session).toBeNull()
    floor.markUsed(session.lastUsed + 40 * MIN + 1)
    floor.markUsed(session.lastUsed + 41 * MIN)
    expect(floor.snapshot().session).toBeNull()
    await settle(10)
    expect(await databases[0]?.readSetting('session')).toBeUndefined()
  })

  it('exiting without a connection to the hub still closes the session here', async () => {
    const h = setupHub()
    const { floor, db } = await device(h, 'Ana')
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    await floor.exit()
    expect(floor.snapshot().session).toBeNull()
    expect(await db.readSetting('session')).toBeUndefined()
  })

  it('recording with the session already expired from inactivity does not create the event', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana', { noConnection: true })
    // The session is still "open" on screen (nobody touched anything), but more than the
    // inactivity time passed.
    vi.setSystemTime(Date.now() + 31 * MIN)
    expect(floor.snapshot().session).not.toBeNull()
    await expect(openOrder(floor)).rejects.toThrow('Sin sesión')
    expect(floor.snapshot().pendingList).toBe(0)
  })
})

describe('fast taps', () => {
  it('hundreds of taps in one second do not write to IndexedDB', async () => {
    const h = setupHub()
    const { floor, session, db } = await device(h, 'Ana')
    const write = vi.spyOn(db, 'saveSetting')
    for (let i = 0; i < 300; i++) floor.markUsed(session.lastUsed + i * 3)
    expect(write).not.toHaveBeenCalled()
    expect(floor.snapshot().session?.lastUsed).toBe(session.lastUsed)
  })

  it('after 15 s it writes once, and taps in the same instant do not repeat the write', async () => {
    const h = setupHub()
    const { floor, session, db } = await device(h, 'Ana')
    const write = vi.spyOn(db, 'saveSetting')
    const t = session.lastUsed + 15_000
    for (let i = 0; i < 50; i++) floor.markUsed(t)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('session', expect.objectContaining({ lastUsed: t }))
    await settle(5)
    expect(await db.readSetting<Session>('session')).toMatchObject({ lastUsed: t })
  })

  it('14.9 s does not write; taps every 10 s for two hours keep the session alive without writing on each one', async () => {
    const h = setupHub()
    const { floor, session, db } = await device(h, 'Ana')
    floor.markUsed(session.lastUsed + 14_999)
    const write = vi.spyOn(db, 'saveSetting')
    expect(write).not.toHaveBeenCalled()

    let taps = 0
    for (let t = 10_000; t <= 120 * MIN; t += 10_000) {
      floor.markUsed(session.lastUsed + t)
      taps += 1
    }
    expect(floor.snapshot().session).not.toBeNull()
    expect(write.mock.calls.length).toBeLessThan(taps / 1.5)
    expect(write.mock.calls.length).toBeGreaterThan(0)
  })

  it('several record calls at once store everything, each event once, and the hub confirms them', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana')
    await until(() => isConnected(floor))
    const p = await openOrder(floor)
    const its = Array.from({ length: 12 }, () => item(1_500))
    await Promise.all(its.map((it) => floor.record('ItemAdded', p, it)))

    const all = await locals(floor)
    expect(all).toHaveLength(13)
    expect(new Set(all.map((l) => l.position)).size).toBe(13)
    expect(new Set(all.map((l) => l.event.id)).size).toBe(13)

    await until(() => noPending(floor))
    const hub = h.hub.order(p)
    expect(Object.keys(hub?.items ?? {}).sort()).toEqual(its.map((i) => i.item_id).sort())
    expect(openOrders(await locals(floor))[0]?.total).toBe(18_000)
  })

  it('double tap on "enviar a cocina": only one ticket counts and both devices see the same', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana')
    await until(() => isConnected(floor))
    const p = await openOrder(floor)
    const it = item(8_000)
    await floor.record('ItemAdded', p, it)
    await until(() => noPending(floor))

    const submission = () => ({
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    await Promise.all([
      floor.record('ItemsSent', p, submission()),
      floor.record('ItemsSent', p, submission()),
    ])
    await until(() => noPending(floor))

    const inHub = h.hub.order(p)
    expect(inHub?.items[it.item_id]?.status).toBe('sent')
    const [view] = openOrders(await locals(floor))
    expect(view?.status.items[it.item_id]?.status).toBe('sent')
    expect(view?.total).toBe(8_000)
    // The second send is not lost silently: it was either rejected or accepted as a conflict.
    const submissions = (await locals(floor)).filter((l) => l.event.type === 'ItemsSent')
    expect(submissions).toHaveLength(2)
    expect(submissions.every((l) => l.status !== 'pending')).toBe(true)
  })
})

describe('skewed device clock', () => {
  it.each([
    ['behind', 2 * 60 * MIN],
    ['ahead', -2 * 60 * MIN],
  ])(
    'with the hub %s 2 h relative to the device, the estimated time follows the hub',
    async (_n, offset) => {
      const h = setupHub({ hubOffsetMs: offset })
      const { floor } = await device(h, 'Ana')
      await until(() => isConnected(floor))
      await advance(500)

      const event = await floor.record('OrderOpened', newId(), {
        channel: 'dine_in',
        table_id: null,
        guests: 1,
      })
      expect(event.device_time).toBe(new Date(Date.now()).toISOString())
      const variance = Date.parse(event.hub_estimated_time) - Date.now()
      expect(Math.abs(variance - offset)).toBeLessThan(1_000)

      await until(() => noPending(floor))
      const [l] = await locals(floor)
      expect(l?.status).toBe('confirmed')
    },
  )

  it('after reopening the app offline it remembers the learned offset', async () => {
    const h = setupHub({ hubOffsetMs: 2 * 60 * MIN })
    const { floor, db } = await device(h, 'Ana')
    await until(() => isConnected(floor))
    await settle(10)
    floor.simulateOffline(true)

    const another = new Floor({ db, open: (m) => h.open(m) })
    floors.push(another)
    another.simulateOffline(true)
    await another.load()
    const event = await another.record('OrderOpened', newId(), {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    const variance = Date.parse(event.hub_estimated_time) - Date.now()
    expect(Math.abs(variance - 2 * 60 * MIN)).toBeLessThan(1_000)
  })

  it('without ever having talked to the hub, the estimated time is the device time', async () => {
    const h = setupHub({ hubOffsetMs: 2 * 60 * MIN })
    const { floor } = await device(h, 'Ana', { noConnection: true })
    const event = await floor.record('OrderOpened', newId(), {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    expect(event.hub_estimated_time).toBe(event.device_time)
  })
})

describe('startup and simulated outage', () => {
  it('loading twice at once connects only once', async () => {
    const h = setupHub()
    const { db } = await device(h, 'Ana', { noConnection: true })
    const another = new Floor({ db, open: (m) => h.open(m) })
    floors.push(another)
    const [a, b] = [another.load(), another.load()]
    expect(a).toBe(b)
    await Promise.all([a, b])
    await until(() => isConnected(another))
    await advance(2_000)
    expect(h.openings).toBe(1)
  })

  it('with the simulated outage HTTP calls fail as if offline, without touching the network', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana')
    await until(() => isConnected(floor))
    floor.simulateOffline(true)
    vi.mocked(fetch).mockClear()
    await expect(floor.updateCatalog()).rejects.toMatchObject({ code: 'offline' })
    await expect(floor.signIn('1234')).rejects.toMatchObject({ code: 'offline' })
    expect(fetch).not.toHaveBeenCalled()
    expect(floor.snapshot().connection).toBe('disconnected')
  })

  it('the heartbeat and the pong do not make the screen re-read', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana')
    await until(() => isConnected(floor))
    await advance(500)
    const before = floor.snapshot().changes
    h.hubFloor.beat()
    await advance(500)
    expect(floor.snapshot().changes).toBe(before)
  })

  it('turning the connection off and on several times in a row leaves a single live connection', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Ana')
    await until(() => isConnected(floor))
    for (let i = 0; i < 10; i++) {
      floor.simulateOffline(true)
      floor.simulateOffline(false)
    }
    await until(() => isConnected(floor))
    const p = await openOrder(floor)
    await until(() => noPending(floor))
    expect(Object.keys(h.hub.order(p) ?? {})).not.toHaveLength(0)
    expect((await locals(floor)).filter((l) => l.status === 'confirmed')).toHaveLength(1)
  })
})
