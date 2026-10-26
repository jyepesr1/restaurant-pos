import 'fake-indexeddb/auto'
import { type NewEvent, newId, signEvent } from '@pos/core'
import { type AccessControl, type Channel, HubSync, MemoryStore } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Device, Sala, type Session } from './motor'
import { currentItems, pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba, datosItem } from './pruebas'

// Motor de la sala con lo nuevo de los ajustes del pedido: la nota de todo el pedido (también
// sin conexión) y el interruptor de cursos, sobre el motor real (`registrar`, IndexedDB, reductor).

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of bases.splice(0)) await b.delete()
})

const sinRed = (): Channel => ({ send: () => {}, close: () => {} })
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

async function open(catalog = catalogoDePrueba(), sinConexion = true) {
  const db = new BaseDispositivo(`nota-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', device)
  await db.saveSetting('session', session())
  await db.saveSetting('catalog', catalog)
  const floor = new Sala({ db, open: sinRed })
  salas.push(floor)
  if (sinConexion) floor.simularSinConexion(true)
  await floor.load()
  return { floor, db }
}

const locals = async (s: Sala) => (await s.sync?.locals()) ?? []
const stateOf = async (s: Sala, id: string) =>
  pedidosAbiertos(await locals(s)).find((p) => p.status.id === id)?.status ?? null

async function pedidoConLimonadas(
  floor: Sala,
  quantity: number,
  fields: Record<string, unknown> = {},
) {
  const order = newId()
  await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
  const it = datosItem({ quantity, ...fields })
  await floor.record('ItemAdded', order, it)
  return { order, it }
}

describe('NotaPedidoCambiada sobre el motor', () => {
  it('se guarda antes de mostrarse, firmada, y la proyección la muestra sin conexión', async () => {
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
    expect(floor.instantanea().pendingList).toBe(2)
    expect(floor.instantanea().connection).not.toBe('connected')
  })

  it('rechaza en el cliente una nota de más de 500 caracteres (no se guarda)', async () => {
    const { floor } = await open()
    const order = newId()
    await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await expect(
      floor.record('OrderNoteChanged', order, { notes: 'a'.repeat(501) }),
    ).rejects.toThrow('Evento inválido')
    expect((await stateOf(floor, order))?.notes).toBeNull()
    expect(floor.instantanea().pendingList).toBe(1)
  })

  it('quitar la nota la deja en null; el último evento manda', async () => {
    const { floor } = await open()
    const order = newId()
    await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await floor.record('OrderNoteChanged', order, { notes: 'uno' })
    await floor.record('OrderNoteChanged', order, { notes: '  dos  ' })
    expect((await stateOf(floor, order))?.notes).toBe('dos')
    await floor.record('OrderNoteChanged', order, { notes: null })
    expect((await stateOf(floor, order))?.notes).toBeNull()
  })

  it('al reiniciar la app la nota sigue ahí (viene de IndexedDB)', async () => {
    const { floor, db } = await open()
    const order = newId()
    await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await floor.record('OrderNoteChanged', order, { notes: 'todo junto' })
    floor.simularSinConexion(true)
    const another = new Sala({ db, open: sinRed })
    salas.push(another)
    another.simularSinConexion(true)
    await another.load()
    expect((await stateOf(another, order))?.notes).toBe('todo junto')
  })

  it('al volver la conexión, el hub acepta el pedido, los ítems y la nota en orden', async () => {
    const { floor } = await open()
    const { order } = await pedidoConLimonadas(floor, 1)
    await floor.record('OrderNoteChanged', order, { notes: 'cumpleaños' })

    // Un hub en memoria que revisa la firma, como el real.
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

describe('cursos apagados', () => {
  it('Sala.usarCursos llama a /api/cocina/cursos con la sesión, el token y el booleano', async () => {
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
          ? json(catalogoDePrueba({ version: 9 }))
          : new Response(null, { status: 204 })
      }),
    )
    const { floor } = await open(catalogoDePrueba(), false)
    await floor.coursesEnabled(true)
    await floor.coursesEnabled(false)
    const mias = calls.filter((l) => l.url === '/api/kitchen/courses')
    expect(mias.map((l) => l.body?.enabled)).toEqual([true, false])
    expect(mias[0]).toMatchObject({
      token: 'token-mesero',
      body: { secret: 'secreto-ana', enabled: true },
    })
  })

  it('un error del hub (sin permiso) llega como error y no cambia el catálogo local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'no_permission', message: 'No tienes permiso' }, 403)),
    )
    const { floor } = await open(catalogoDePrueba(), false)
    await expect(floor.coursesEnabled(true)).rejects.toMatchObject({ code: 'no_permission' })
    expect(floor.instantanea().catalog?.restaurant.coursesEnabled ?? false).toBe(false)
  })

  it('sin conexión con la caja, usarCursos falla con sin_conexion y no llama al hub', async () => {
    const fetchFalso = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchFalso)
    const { floor } = await open()
    await expect(floor.coursesEnabled(true)).rejects.toMatchObject({ code: 'offline' })
    expect(fetchFalso).not.toHaveBeenCalled()
  })

  it('un catálogo guardado de antes (sin usarCursos) se lee como cursos apagados', async () => {
    const { floor } = await open()
    expect(floor.instantanea().catalog?.restaurant.coursesEnabled ?? false).toBe(false)
  })

  it('el catálogo con usarCursos: true sobrevive a guardarse y cargarse', async () => {
    const base = catalogoDePrueba()
    const { floor } = await open({
      ...base,
      restaurant: { ...base.restaurant, coursesEnabled: true },
    })
    expect(floor.instantanea().catalog?.restaurant.coursesEnabled).toBe(true)
  })

  it('sin cursos, lo que se agrega no lleva curso y nada queda retenido ni se separa por curso', async () => {
    const { floor } = await open()
    const order = newId()
    await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    for (let i = 0; i < 4; i++) await floor.record('ItemAdded', order, datosItem({ course: null }))
    const status = await stateOf(floor, order)
    const lines = currentItems(status as never)
    expect(lines).toHaveLength(4)
    expect(lines.every((i) => i.course === null && i.status === 'pending')).toBe(true)
    expect(status?.heldCourses).toEqual([])
  })
})
