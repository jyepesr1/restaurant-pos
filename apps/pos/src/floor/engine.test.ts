import 'fake-indexeddb/auto'
import { newId, signEvent } from '@pos/core'
import {
  type AccessControl,
  type Catalog,
  type Channel,
  FloorSync,
  type Handlers,
  HubSync,
  MemoryStore,
} from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { type Device, Floor, type Session } from './engine'
import { openOrders } from './projection'
import { DeviceDatabase } from './store'

// The Phase 0 acceptance test without a browser: two devices with their IndexedDB, an in-memory
// hub that requires the session signature, orders made offline and, on return, both see the
// same without duplicates.

const secretOf = (sessionId: string) => `secreto-${sessionId}`

/** Requires each event to come signed with its session's secret. */
const accessWithSignature: AccessControl = {
  verify: (_c, event) =>
    event.session_id && event.signature === signEvent(event, secretOf(event.session_id))
      ? { ok: true, authorizedById: null, authorizationId: null }
      : { ok: false, reason: 'invalid_signature' },
  recordUse: () => {},
}

const tableId = newId()
const catalog: Catalog = {
  version: 3,
  restaurant: { name: 'Prueba', sessionIdleMin: 30 },
  zones: [{ id: newId(), name: 'Salón', level: 1 }],
  tables: [],
  elements: [],
  staff: [],
  stations: [{ id: newId(), name: 'Cocina' }],
  categories: [],
}

const floors: Floor[] = []
const databases: DeviceDatabase[] = []
afterEach(async () => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  // Let background work (saving the sign-out) finish before deleting the database.
  await new Promise((r) => setTimeout(r, 50))
  for (const b of databases.splice(0)) await b.delete()
})

function setupHub() {
  const tokens = new Map<string, Device>()
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date().toISOString(),
    access: accessWithSignature,
  })
  const hubFloor = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: null } : null
  })
  /** An in-memory "WebSocket": messages travel as JSON and arrive on another tick. */
  const open = (m: Handlers): Channel => {
    let link: ReturnType<FloorSync['connect']> | null = null
    setTimeout(() => {
      link = hubFloor.connect((msg) => {
        const copy = JSON.parse(JSON.stringify(msg))
        setTimeout(() => link && m.onMessage(copy))
      })
      m.onOpen()
    })
    return {
      send: (msg) => link?.receive(JSON.parse(JSON.stringify(msg))),
      close: () => {
        link?.close()
        link = null
      },
    }
  }
  return { hub, tokens, open }
}

async function device(h: ReturnType<typeof setupHub>, name: string) {
  const db = new DeviceDatabase(`prueba-${newId()}`)
  databases.push(db)
  const e: Device = { deviceId: newId(), token: newId(), name, type: 'waiter' }
  h.tokens.set(e.token, e)
  const sessionId = newId()
  const session: Session = {
    sessionId,
    secret: secretOf(sessionId),
    user: { id: newId(), name, role: 'Mesero' },
    permissions: ['take_order'],
    lastUsed: Date.now(),
  }
  await db.saveSetting('device', e)
  await db.saveSetting('session', session)
  await db.saveSetting('catalog', catalog)
  const floor = new Floor({ db, open: h.open })
  floors.push(floor)
  await floor.load()
  return floor
}

const item = (name: string, price: number) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name,
  unit_price: price,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 3,
  price_channel_id: null,
})

async function wait(condition: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('Condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const view = async (s: Floor) =>
  openOrders((await s.sync?.locals()) ?? []).map((p) => ({
    id: p.status.id,
    total: p.total,
    items: Object.keys(p.status.items).sort(),
  }))

describe('Floor (the app engine)', () => {
  it('two offline devices create orders and on return see the same, without duplicates', async () => {
    const h = setupHub()
    const ana = await device(h, 'Ana')
    const beto = await device(h, 'Beto')
    await wait(() => ana.snapshot().connection === 'connected')
    await wait(() => beto.snapshot().connection === 'connected')

    ana.simulateOffline(true)
    beto.simulateOffline(true)
    expect(ana.snapshot().connection).toBe('disconnected')

    const p1 = newId()
    await ana.record('OrderOpened', p1, { channel: 'dine_in', table_id: tableId, guests: 2 })
    await ana.record('ItemAdded', p1, item('Aperol Spritz', 32_000))
    const p2 = newId()
    await beto.record('OrderOpened', p2, { channel: 'dine_in', table_id: null, guests: 1 })
    await beto.record('ItemAdded', p2, item('Pizza Margarita', 44_900))
    await beto.record('ItemAdded', p2, item('Limonada', 9_900))

    // Persist before showing: offline it is already visible, as pending.
    expect(ana.snapshot().pendingList).toBe(2)
    expect(beto.snapshot().pendingList).toBe(3)
    expect(await view(ana)).toEqual([expect.objectContaining({ id: p1, total: 32_000 })])

    ana.simulateOffline(false)
    beto.simulateOffline(false)
    await wait(async () => {
      const [a, b] = [await view(ana), await view(beto)]
      return (
        ana.snapshot().pendingList === 0 &&
        beto.snapshot().pendingList === 0 &&
        a.length === 2 &&
        JSON.stringify(a) === JSON.stringify(b)
      )
    })
    expect(h.hub.order(p1)).not.toBeNull()
    const allConfirmed = (await ana.sync?.locals())?.filter((l) => l.status === 'confirmed')
    expect(allConfirmed?.map((l) => l.event.sequence).sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('without a session an event cannot be created; after the idle time the session closes', async () => {
    const h = setupHub()
    const s = await device(h, 'Ana')
    const session = s.snapshot().session as Session
    s.expireSessionIfDue(session.lastUsed + 29 * 60_000)
    expect(s.snapshot().session).not.toBeNull()
    s.expireSessionIfDue(session.lastUsed + 30 * 60_000)
    expect(s.snapshot().session).toBeNull()
    await expect(
      s.record('OrderOpened', newId(), { channel: 'dine_in', table_id: null, guests: 0 }),
    ).rejects.toThrow('Sin sesión')
  })

  it('an event with invalid data is not stored', async () => {
    const h = setupHub()
    const s = await device(h, 'Ana')
    await expect(
      s.record('OrderOpened', newId(), { channel: 'dine_in', table_id: null, guests: -1 }),
    ).rejects.toThrow('Evento inválido')
    expect(s.snapshot().pendingList).toBe(0)
  })
})
