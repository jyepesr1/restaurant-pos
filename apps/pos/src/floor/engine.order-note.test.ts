import 'fake-indexeddb/auto'
import { type NewEvent, newId, signEvent } from '@pos/core'
import { type AccessControl, type Channel, HubSync, MemoryStore } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Device, Floor, type Session } from './engine'
import { currentItems, openOrders } from './projection'
import { DeviceDatabase } from './store'
import { itemData, testCatalog } from './testing'

// Floor engine with the new order settings: the note for the whole order (also
// offline) and the courses switch, on the real engine (`record`, IndexedDB, reducer).

const floors: Floor[] = []
const databases: DeviceDatabase[] = []
afterEach(async () => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of databases.splice(0)) await b.delete()
})

const noNetwork = (): Channel => ({ send: () => {}, close: () => {} })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const device: Device = {
  deviceId: newId(),
  token: 'token-mesero',
  name: 'Celular',
  type: 'waiter',
}
const session = (): Session => ({
  sessionId: newId(),
  secret: 'secreto-ana',
  user: { id: newId(), name: 'Ana', role: 'Mesero' },
  permissions: ['take_order', 'manage_devices'],
  lastUsed: Date.now(),
})

async function open(catalog = testCatalog(), noConnection = true) {
  const db = new DeviceDatabase(`nota-${newId()}`)
  databases.push(db)
  await db.saveSetting('device', device)
  await db.saveSetting('session', session())
  await db.saveSetting('catalog', catalog)
  const floor = new Floor({ db, open: noNetwork })
  floors.push(floor)
  if (noConnection) floor.simulateOffline(true)
  await floor.load()
  return { floor, db }
}

const locals = async (s: Floor) => (await s.sync?.locals()) ?? []
const stateOf = async (s: Floor, id: string) =>
  openOrders(await locals(s)).find((p) => p.status.id === id)?.status ?? null

async function orderWithLemonades(
  floor: Floor,
  quantity: number,
  fields: Record<string, unknown> = {},
) {
  const order = newId()
  await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
  const it = itemData({ quantity, ...fields })
  await floor.record('ItemAdded', order, it)
  return { order, it }
}

describe('OrderNoteChanged on the engine', () => {
  it('is saved before being shown, signed, and the projection shows it offline', async () => {
    const { floor } = await open()
    const order = newId()
    await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    const e = await floor.record('OrderNoteChanged', order, { notes: 'alérgico al maní' })
    const { signature, ...unsigned } = e
    expect(signature).toBe(signEvent(unsigned as NewEvent, 'secreto-ana'))
    expect(e).toMatchObject({
      type: 'OrderNoteChanged',
      aggregate_type: 'order',
      aggregate_id: order,
    })
    expect((await stateOf(floor, order))?.notes).toBe('alérgico al maní')
    expect(floor.snapshot().pendingList).toBe(2)
    expect(floor.snapshot().connection).not.toBe('connected')
  })

  it('rejects on the client a note over 500 characters (it is not saved)', async () => {
    const { floor } = await open()
    const order = newId()
    await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await expect(
      floor.record('OrderNoteChanged', order, { notes: 'a'.repeat(501) }),
    ).rejects.toThrow('Evento inválido')
    expect((await stateOf(floor, order))?.notes).toBeNull()
    expect(floor.snapshot().pendingList).toBe(1)
  })

  it('removing the note leaves it at null; the last event wins', async () => {
    const { floor } = await open()
    const order = newId()
    await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await floor.record('OrderNoteChanged', order, { notes: 'uno' })
    await floor.record('OrderNoteChanged', order, { notes: '  dos  ' })
    expect((await stateOf(floor, order))?.notes).toBe('dos')
    await floor.record('OrderNoteChanged', order, { notes: null })
    expect((await stateOf(floor, order))?.notes).toBeNull()
  })

  it('after restarting the app the note is still there (it comes from IndexedDB)', async () => {
    const { floor, db } = await open()
    const order = newId()
    await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await floor.record('OrderNoteChanged', order, { notes: 'todo junto' })
    floor.simulateOffline(true)
    const another = new Floor({ db, open: noNetwork })
    floors.push(another)
    another.simulateOffline(true)
    await another.load()
    expect((await stateOf(another, order))?.notes).toBe('todo junto')
  })

  it('when the connection comes back, the hub accepts the order, the items and the note in order', async () => {
    const { floor } = await open()
    const { order } = await orderWithLemonades(floor, 1)
    await floor.record('OrderNoteChanged', order, { notes: 'cumpleaños' })

    // A memory hub that checks the signature, like the real one.
    const access: AccessControl = {
      verify: (_c, ev) =>
        ev.session_id && ev.signature === signEvent(ev, 'secreto-ana')
          ? { ok: true, authorizedById: null, authorizationId: null }
          : { ok: false, reason: 'invalid_signature' },
      recordUse: () => {},
    }
    const hub = new HubSync(new MemoryStore(), {
      restaurantId: newId(),
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-test',
      clock: () => new Date().toISOString(),
      access,
    })
    const events = (await locals(floor)).map((l) => l.event as NewEvent)
    const r = hub.receiveBatch({ deviceId: device.deviceId, type: 'waiter' } as never, events)
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(hub.order(order)?.notes).toBe('cumpleaños')
  })
})

describe('courses off', () => {
  it('Floor.coursesEnabled calls /api/kitchen/courses with the session, the token and the boolean', async () => {
    const calls: {
      url: string
      body: Record<string, unknown> | null
      token: string | null
    }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        calls.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
          token: headers.authorization?.replace('Bearer ', '') ?? null,
        })
        return url === '/api/catalog'
          ? json(testCatalog({ version: 9 }))
          : new Response(null, { status: 204 })
      }),
    )
    const { floor } = await open(testCatalog(), false)
    await floor.coursesEnabled(true)
    await floor.coursesEnabled(false)
    const mine = calls.filter((l) => l.url === '/api/kitchen/courses')
    expect(mine.map((l) => l.body?.enabled)).toEqual([true, false])
    expect(mine[0]).toMatchObject({
      token: 'token-mesero',
      body: { secret: 'secreto-ana', enabled: true },
    })
  })

  it('a hub error (no permission) arrives as an error and does not change the local catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'no_permission', message: 'No tienes permiso' }, 403)),
    )
    const { floor } = await open(testCatalog(), false)
    await expect(floor.coursesEnabled(true)).rejects.toMatchObject({ code: 'no_permission' })
    expect(floor.snapshot().catalog?.restaurant.coursesEnabled ?? false).toBe(false)
  })

  it('offline from the register, coursesEnabled fails with offline and does not call the hub', async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fakeFetch)
    const { floor } = await open()
    await expect(floor.coursesEnabled(true)).rejects.toMatchObject({ code: 'offline' })
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('a catalog saved from before (without coursesEnabled) is read as courses off', async () => {
    const { floor } = await open()
    expect(floor.snapshot().catalog?.restaurant.coursesEnabled ?? false).toBe(false)
  })

  it('the catalog with coursesEnabled: true survives being saved and loaded', async () => {
    const base = testCatalog()
    const { floor } = await open({
      ...base,
      restaurant: { ...base.restaurant, coursesEnabled: true },
    })
    expect(floor.snapshot().catalog?.restaurant.coursesEnabled).toBe(true)
  })

  it('without courses, what is added carries no course and nothing is held or split by course', async () => {
    const { floor } = await open()
    const order = newId()
    await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    for (let i = 0; i < 4; i++) await floor.record('ItemAdded', order, itemData({ course: null }))
    const status = await stateOf(floor, order)
    const lines = currentItems(status as never)
    expect(lines).toHaveLength(4)
    expect(lines.every((i) => i.course === null && i.status === 'pending')).toBe(true)
    expect(status?.heldCourses).toEqual([])
  })
})
