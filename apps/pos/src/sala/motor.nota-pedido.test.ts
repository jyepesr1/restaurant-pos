import 'fake-indexeddb/auto'
import { type NewEvent, newId, signEvent } from '@pos/core'
import { AlmacenMemoria, type Channel, type ControlAcceso, HubSync } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { itemsVigentes, pedidosAbiertos } from './proyeccion'
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
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

const device: Equipo = {
  dispositivoId: newId(),
  token: 'token-mesero',
  name: 'Celular',
  type: 'waiter',
}
const session = (): Sesion => ({
  sesionId: newId(),
  secret: 'secreto-ana',
  user: { id: newId(), name: 'Ana', role: 'Mesero' },
  permissions: ['take_order', 'manage_devices'],
  ultimoUso: Date.now(),
})

async function open(catalog = catalogoDePrueba(), sinConexion = true) {
  const db = new BaseDispositivo(`nota-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', device)
  await db.saveSetting('session', session())
  await db.saveSetting('catalog', catalog)
  const sala = new Sala({ db, open: sinRed })
  salas.push(sala)
  if (sinConexion) sala.simularSinConexion(true)
  await sala.cargar()
  return { sala, db }
}

const locales = async (s: Sala) => (await s.sync?.locales()) ?? []
const stateOf = async (s: Sala, id: string) =>
  pedidosAbiertos(await locales(s)).find((p) => p.status.id === id)?.status ?? null

async function pedidoConLimonadas(
  sala: Sala,
  quantity: number,
  fields: Record<string, unknown> = {},
) {
  const order = newId()
  await sala.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
  const it = datosItem({ quantity, ...fields })
  await sala.record('ItemAdded', order, it)
  return { order, it }
}

describe('NotaPedidoCambiada sobre el motor', () => {
  it('se guarda antes de mostrarse, firmada, y la proyección la muestra sin conexión', async () => {
    const { sala } = await open()
    const order = newId()
    await sala.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    const e = await sala.record('OrderNoteChanged', order, { notes: 'alérgico al maní' })
    const { signature, ...sinFirma } = e
    expect(signature).toBe(signEvent(sinFirma as NewEvent, 'secreto-ana'))
    expect(e).toMatchObject({
      type: 'OrderNoteChanged',
      aggregate_type: 'order',
      aggregate_id: order,
    })
    expect((await stateOf(sala, order))?.notes).toBe('alérgico al maní')
    expect(sala.instantanea().pendingList).toBe(2)
    expect(sala.instantanea().connection).not.toBe('connected')
  })

  it('rechaza en el cliente una nota de más de 500 caracteres (no se guarda)', async () => {
    const { sala } = await open()
    const order = newId()
    await sala.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await expect(
      sala.record('OrderNoteChanged', order, { notes: 'a'.repeat(501) }),
    ).rejects.toThrow('Evento inválido')
    expect((await stateOf(sala, order))?.notes).toBeNull()
    expect(sala.instantanea().pendingList).toBe(1)
  })

  it('quitar la nota la deja en null; el último evento manda', async () => {
    const { sala } = await open()
    const order = newId()
    await sala.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await sala.record('OrderNoteChanged', order, { notes: 'uno' })
    await sala.record('OrderNoteChanged', order, { notes: '  dos  ' })
    expect((await stateOf(sala, order))?.notes).toBe('dos')
    await sala.record('OrderNoteChanged', order, { notes: null })
    expect((await stateOf(sala, order))?.notes).toBeNull()
  })

  it('al reiniciar la app la nota sigue ahí (viene de IndexedDB)', async () => {
    const { sala, db } = await open()
    const order = newId()
    await sala.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await sala.record('OrderNoteChanged', order, { notes: 'todo junto' })
    sala.simularSinConexion(true)
    const another = new Sala({ db, open: sinRed })
    salas.push(another)
    another.simularSinConexion(true)
    await another.cargar()
    expect((await stateOf(another, order))?.notes).toBe('todo junto')
  })

  it('al volver la conexión, el hub acepta el pedido, los ítems y la nota en orden', async () => {
    const { sala } = await open()
    const { order } = await pedidoConLimonadas(sala, 1)
    await sala.record('OrderNoteChanged', order, { notes: 'cumpleaños' })

    // Un hub en memoria que revisa la firma, como el real.
    const access: ControlAcceso = {
      verify: (_c, ev) =>
        ev.session_id && ev.signature === signEvent(ev, 'secreto-ana')
          ? { ok: true, authorizedById: null, autorizacionId: null }
          : { ok: false, reason: 'invalid_signature' },
      registrarUso: () => {},
    }
    const hub = new HubSync(new AlmacenMemoria(), {
      restauranteId: newId(),
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-test',
      clock: () => new Date().toISOString(),
      access,
    })
    const events = (await locales(sala)).map((l) => l.event as NewEvent)
    const r = hub.recibirLote(
      { dispositivoId: device.dispositivoId, type: 'waiter' } as never,
      events,
    )
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(hub.order(order)?.notes).toBe('cumpleaños')
  })
})

describe('cursos apagados', () => {
  it('Sala.usarCursos llama a /api/cocina/cursos con la sesión, el token y el booleano', async () => {
    const llamadas: {
      url: string
      cuerpo: Record<string, unknown> | null
      token: string | null
    }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        llamadas.push({
          url,
          cuerpo: init?.body ? JSON.parse(String(init.body)) : null,
          token: headers.authorization?.replace('Bearer ', '') ?? null,
        })
        return url === '/api/catalog'
          ? json(catalogoDePrueba({ version: 9 }))
          : new Response(null, { status: 204 })
      }),
    )
    const { sala } = await open(catalogoDePrueba(), false)
    await sala.usarCursos(true)
    await sala.usarCursos(false)
    const mias = llamadas.filter((l) => l.url === '/api/kitchen/courses')
    expect(mias.map((l) => l.cuerpo?.usar)).toEqual([true, false])
    expect(mias[0]).toMatchObject({
      token: 'token-mesero',
      cuerpo: { secret: 'secreto-ana', usar: true },
    })
  })

  it('un error del hub (sin permiso) llega como error y no cambia el catálogo local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'no_permission', message: 'No tienes permiso' }, 403)),
    )
    const { sala } = await open(catalogoDePrueba(), false)
    await expect(sala.usarCursos(true)).rejects.toMatchObject({ code: 'no_permission' })
    expect(sala.instantanea().catalog?.restaurant.usarCursos ?? false).toBe(false)
  })

  it('sin conexión con la caja, usarCursos falla con sin_conexion y no llama al hub', async () => {
    const fetchFalso = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchFalso)
    const { sala } = await open()
    await expect(sala.usarCursos(true)).rejects.toMatchObject({ code: 'offline' })
    expect(fetchFalso).not.toHaveBeenCalled()
  })

  it('un catálogo guardado de antes (sin usarCursos) se lee como cursos apagados', async () => {
    const { sala } = await open()
    expect(sala.instantanea().catalog?.restaurant.usarCursos ?? false).toBe(false)
  })

  it('el catálogo con usarCursos: true sobrevive a guardarse y cargarse', async () => {
    const base = catalogoDePrueba()
    const { sala } = await open({
      ...base,
      restaurant: { ...base.restaurant, usarCursos: true },
    })
    expect(sala.instantanea().catalog?.restaurant.usarCursos).toBe(true)
  })

  it('sin cursos, lo que se agrega no lleva curso y nada queda retenido ni se separa por curso', async () => {
    const { sala } = await open()
    const order = newId()
    await sala.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    for (let i = 0; i < 4; i++) await sala.record('ItemAdded', order, datosItem({ course: null }))
    const status = await stateOf(sala, order)
    const lines = itemsVigentes(status as never)
    expect(lines).toHaveLength(4)
    expect(lines.every((i) => i.course === null && i.status === 'pending')).toBe(true)
    expect(status?.heldCourses).toEqual([])
  })
})
