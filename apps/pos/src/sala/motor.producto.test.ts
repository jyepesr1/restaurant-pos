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
import { BaseDispositivo } from './almacen'
import { type Device, Sala, type Session } from './motor'
import { agotados, claveAgotado, pedidosAbiertos } from './proyeccion'

// Agotado (86) por el motor de la app: `registrar` arma el sobre del producto, lo firma, lo guarda
// antes de mostrarlo y el hub de prueba lo acepta, lo difunde o lo rechaza (tarea 1.3).

const secretOf = (sessionId: string) => `secreto-${sessionId}`

const firmaValida = (event: Parameters<AccessControl['verify']>[1]) =>
  event.session_id !== null && event.signature === signEvent(event, secretOf(event.session_id))

const accesoConFirma: AccessControl = {
  verify: (_c, event) =>
    firmaValida(event)
      ? { ok: true, authorizedById: null, authorizationId: null }
      : { ok: false, reason: 'invalid_signature' },
  recordUse: () => {},
}
/** Como el real: el agotado exige permiso, y este usuario no lo tiene. */
const accesoSinPermisoDeAgotar: AccessControl = {
  verify: (c, event, order) =>
    event.type === 'ProductSoldOut' || event.type === 'ProductAvailable'
      ? { ok: false, reason: 'no_permission' }
      : accesoConFirma.verify(c, event, order),
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

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  await new Promise((r) => setTimeout(r, 50))
  for (const b of bases.splice(0)) await b.delete()
})

function setupHub(access: AccessControl = accesoConFirma) {
  const tokens = new Map<string, Device>()
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date().toISOString(),
    access,
  })
  const salaHub = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: null } : null
  })
  const open = (m: Handlers): Channel => {
    let link: ReturnType<FloorSync['connect']> | null = null
    setTimeout(() => {
      link = salaHub.connect((msg) => {
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
  const db = new BaseDispositivo(`prueba-${newId()}`)
  bases.push(db)
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
  const floor = new Sala({ db, open: h.open })
  salas.push(floor)
  await floor.load()
  return { floor, session, device: e }
}

async function wait(condicion: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!(await condicion())) {
    if (Date.now() > end) throw new Error('No se cumplió a tiempo')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const locals = async (s: Sala) => (await s.sync?.locals()) ?? []
const online = (s: Sala) => wait(() => s.instantanea().connection === 'connected')

describe('Sala.registrar con eventos de producto', () => {
  it('arma el sobre del producto: agregado_tipo producto, su id, firmado y sin pedido', async () => {
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
    // Persistir antes de mostrar: ya se ve agotado, y ningún pedido nació.
    expect(agotados(savedList)).toEqual(new Set([product]))
    expect(pedidosAbiertos(savedList)).toEqual([])
  })

  it('un evento de pedido sigue armándose como pedido', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Caja')
    const order = newId()
    const created = await floor.record('OrderOpened', order, {
      channel: 'takeout',
      table_id: null,
      guests: 1,
    })
    expect(created.aggregate_type).toBe('order')
    expect(pedidosAbiertos(await locals(floor))).toHaveLength(1)
  })

  it('el hub de prueba lo acepta con su secuencia y el otro equipo lo recibe', async () => {
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
    await wait(() => register.floor.instantanea().pendingList === 0)

    for (const s of [register.floor, waiter.floor]) {
      const l = await locals(s)
      expect(l[0]).toMatchObject({ status: 'confirmed' })
      expect(l[0]?.event.sequence).toBe(1)
      expect(agotados(l)).toEqual(new Set([claveAgotado(product, bottle)]))
    }
    expect(h.hub.order(product)).toBeNull()

    // Y la reposición también les llega a los dos.
    await register.floor.record('ProductAvailable', product, {
      product_id: product,
      variant_id: bottle,
    })
    await wait(async () => agotados(await locals(waiter.floor)).size === 0)
    expect(agotados(await locals(register.floor))).toEqual(new Set())
  })

  it('sin conexión se ve agotado al instante y al volver se confirma sin duplicarse', async () => {
    const h = setupHub()
    const register = await device(h, 'Caja')
    const waiter = await device(h, 'Ana')
    await online(register.floor)
    await online(waiter.floor)
    register.floor.simularSinConexion(true)
    const product = newId()

    await register.floor.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })
    expect(register.floor.instantanea().pendingList).toBe(1)
    expect(agotados(await locals(register.floor))).toEqual(new Set([product]))
    // El mesero todavía no lo sabe.
    expect(agotados(await locals(waiter.floor))).toEqual(new Set())

    register.floor.simularSinConexion(false)
    await wait(async () => agotados(await locals(waiter.floor)).has(product))
    await wait(() => register.floor.instantanea().pendingList === 0)
    expect(await locals(register.floor)).toHaveLength(1)
    expect(await locals(waiter.floor)).toHaveLength(1)
  })

  it('si el hub lo rechaza (sin permiso), deja de verse agotado en el equipo', async () => {
    const h = setupHub(accesoSinPermisoDeAgotar)
    const register = await device(h, 'Caja')
    register.floor.simularSinConexion(true)
    const product = newId()
    await register.floor.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })
    expect(agotados(await locals(register.floor))).toEqual(new Set([product]))

    register.floor.simularSinConexion(false)
    await wait(async () => (await locals(register.floor))[0]?.status === 'rejected')
    const [l] = await locals(register.floor)
    expect(l?.reason).toBe('no_permission')
    expect(agotados(await locals(register.floor))).toEqual(new Set())
  })

  it('un agotado con datos inválidos no se guarda', async () => {
    const h = setupHub()
    const { floor } = await device(h, 'Caja')
    await expect(
      floor.record('ProductSoldOut', newId(), {
        product_id: 'no-es-ulid',
        variant_id: null,
      }),
    ).rejects.toThrow('Evento inválido')
    // El agregado y el producto deben ser el mismo.
    await expect(
      floor.record('ProductSoldOut', newId(), { product_id: newId(), variant_id: null }),
    ).rejects.toThrow('Evento inválido')
    expect(floor.instantanea().pendingList).toBe(0)
    expect(await locals(floor)).toEqual([])
  })

  it('un hub que se reinicia y vuelve: el agotado propio ya confirmado sigue visible', async () => {
    const h = setupHub()
    const register = await device(h, 'Caja')
    await online(register.floor)
    const product = newId()
    await register.floor.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })
    await wait(() => register.floor.instantanea().pendingList === 0)

    register.floor.simularSinConexion(true)
    register.floor.simularSinConexion(false)
    await online(register.floor)
    expect(agotados(await locals(register.floor))).toEqual(new Set([product]))
    expect(await locals(register.floor)).toHaveLength(1)
  })
})
