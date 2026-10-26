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
import { openOrders, soldOutIds, soldOutKey } from './projection'
import { DeviceDatabase } from './store'

// Sold out (86) through the app engine: `record` builds the product envelope, signs it, saves it
// before showing it and the test hub accepts it, broadcasts it or rejects it (task 1.3).

const secretOf = (sessionId: string) => `secreto-${sessionId}`

const validSignature = (event: Parameters<AccessControl['verify']>[1]) =>
  event.session_id !== null && event.signature === signEvent(event, secretOf(event.session_id))

const accessWithSignature: AccessControl = {
  verify: (_c, event) =>
    validSignature(event)
      ? { ok: true, authorizedById: null, authorizationId: null }
      : { ok: false, reason: 'invalid_signature' },
  recordUse: () => {},
}
/** Like the real one: sold out requires a permission, and this user does not have it. */
const accessWithoutSoldOutPermission: AccessControl = {
  verify: (c, event, order) =>
    event.type === 'ProductSoldOut' || event.type === 'ProductAvailable'
      ? { ok: false, reason: 'no_permission' }
      : accessWithSignature.verify(c, event, order),
  recordUse: () => {},
}

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
  await new Promise((r) => setTimeout(r, 50))
  for (const b of databases.splice(0)) await b.delete()
})

function setupHub(access: AccessControl = accessWithSignature) {
  const tokens = new Map<string, Device>()
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date().toISOString(),
    access,
  })
  const hubFloor = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: null } : null
  })
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
  const e: Device = { deviceId: newId(), token: newId(), name, type: 'register' }
  h.tokens.set(e.token, e)
  const sessionId = newId()
  const session: Session = {
    sessionId,
    secret: secretOf(sessionId),
    user: { id: newId(), name, role: 'Cajero' },
    permissions: ['take_order', 'mark_product_sold_out'],
    lastUsed: Date.now(),
  }
  await db.saveSetting('device', e)
  await db.saveSetting('session', session)
  await db.saveSetting('catalog', catalog)
  const floor = new Floor({ db, open: h.open })
  floors.push(floor)
  await floor.load()
  return { floor, session, device: e }
}

async function wait(condition: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('Condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const locals = async (s: Floor) => (await s.sync?.locals()) ?? []
const online = (s: Floor) => wait(() => s.snapshot().connection === 'connected')

describe('Floor.record with product events', () => {
  it('builds the product envelope: aggregate_type product, its id, signed and with no order', async () => {
    const h = setupHub()
    const { floor, session, device: e } = await device(h, 'Caja')
    const product = newId()

    const created = await floor.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })

    expect(created).toMatchObject({
      type: 'ProductSoldOut',
      aggregate_type: 'product',
      aggregate_id: product,
      related: [],
      session_id: session.sessionId,
      user_id: session.user.id,
      device_id: e.deviceId,
      reason: null,
      authorization_id: null,
    })
    expect(created.signature).toBe(
      signEvent({ ...created, signature: undefined } as never, session.secret),
    )
    const savedList = await locals(floor)
    expect(savedList).toHaveLength(1)
    expect(savedList[0]?.status).toBe('pending')
    // Persist before showing: it already shows as sold out, and no order was created.
    expect(soldOutIds(savedList)).toEqual(new Set([product]))
    expect(openOrders(savedList)).toEqual([])
  })

  it('an order event is still built as an order', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Caja')
    const order = newId()
    const created = await floor.record('OrderOpened', order, {
      channel: 'takeout',
      table_id: null,
      guests: 1,
    })
    expect(created.aggregate_type).toBe('order')
    expect(openOrders(await locals(floor))).toHaveLength(1)
  })

  it('the test hub accepts it with its sequence and the other device receives it', async () => {
    const h = setupHub()
    const register = await device(h, 'Caja')
    const waiter = await device(h, 'Ana')
    await online(register.floor)
    await online(waiter.floor)
    const product = newId()
    const bottle = newId()

    await register.floor.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: bottle,
    })
    await wait(async () => (await locals(waiter.floor)).length === 1)
    await wait(() => register.floor.snapshot().pendingList === 0)

    for (const s of [register.floor, waiter.floor]) {
      const l = await locals(s)
      expect(l[0]).toMatchObject({ status: 'confirmed' })
      expect(l[0]?.event.sequence).toBe(1)
      expect(soldOutIds(l)).toEqual(new Set([soldOutKey(product, bottle)]))
    }
    expect(h.hub.order(product)).toBeNull()

    // And the restock also reaches both.
    await register.floor.record('ProductAvailable', product, {
      product_id: product,
      variant_id: bottle,
    })
    await wait(async () => soldOutIds(await locals(waiter.floor)).size === 0)
    expect(soldOutIds(await locals(register.floor))).toEqual(new Set())
  })

  it('offline it shows as sold out instantly and on return it is confirmed without duplicating', async () => {
    const h = setupHub()
    const register = await device(h, 'Caja')
    const waiter = await device(h, 'Ana')
    await online(register.floor)
    await online(waiter.floor)
    register.floor.simulateOffline(true)
    const product = newId()

    await register.floor.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })
    expect(register.floor.snapshot().pendingList).toBe(1)
    expect(soldOutIds(await locals(register.floor))).toEqual(new Set([product]))
    // The waiter does not know yet.
    expect(soldOutIds(await locals(waiter.floor))).toEqual(new Set())

    register.floor.simulateOffline(false)
    await wait(async () => soldOutIds(await locals(waiter.floor)).has(product))
    await wait(() => register.floor.snapshot().pendingList === 0)
    expect(await locals(register.floor)).toHaveLength(1)
    expect(await locals(waiter.floor)).toHaveLength(1)
  })

  it('if the hub rejects it (no permission), it stops showing as sold out on the device', async () => {
    const h = setupHub(accessWithoutSoldOutPermission)
    const register = await device(h, 'Caja')
    register.floor.simulateOffline(true)
    const product = newId()
    await register.floor.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })
    expect(soldOutIds(await locals(register.floor))).toEqual(new Set([product]))

    register.floor.simulateOffline(false)
    await wait(async () => (await locals(register.floor))[0]?.status === 'rejected')
    const [l] = await locals(register.floor)
    expect(l?.reason).toBe('no_permission')
    expect(soldOutIds(await locals(register.floor))).toEqual(new Set())
  })

  it('a sold-out event with invalid data is not saved', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Caja')
    await expect(
      floor.record('ProductSoldOut', newId(), {
        product_id: 'no-es-ulid',
        variant_id: null,
      }),
    ).rejects.toThrow('Evento inválido')
    // The aggregate and the product must be the same.
    await expect(
      floor.record('ProductSoldOut', newId(), { product_id: newId(), variant_id: null }),
    ).rejects.toThrow('Evento inválido')
    expect(floor.snapshot().pendingList).toBe(0)
    expect(await locals(floor)).toEqual([])
  })

  it('a hub that restarts and comes back: its own already confirmed sold-out stays visible', async () => {
    const h = setupHub()
    const register = await device(h, 'Caja')
    await online(register.floor)
    const product = newId()
    await register.floor.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })
    await wait(() => register.floor.snapshot().pendingList === 0)

    register.floor.simulateOffline(true)
    register.floor.simulateOffline(false)
    await online(register.floor)
    expect(soldOutIds(await locals(register.floor))).toEqual(new Set([product]))
    expect(await locals(register.floor)).toHaveLength(1)
  })
})
