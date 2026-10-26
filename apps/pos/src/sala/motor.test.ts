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
import { pedidosAbiertos } from './proyeccion'

// La prueba de aceptación de la Fase 0 sin navegador: dos equipos con su IndexedDB, un hub en
// memoria que exige la firma de la sesión, pedidos hechos sin conexión y, al volver, los dos ven
// lo mismo sin duplicados.

const secretOf = (sessionId: string) => `secreto-${sessionId}`

/** Exige que cada evento venga firmado con el secreto de su sesión. */
const accesoConFirma: AccessControl = {
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

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  // Que terminen los trabajos de fondo (guardar el cierre de sesión) antes de borrar la base.
  await new Promise((r) => setTimeout(r, 50))
  for (const b of bases.splice(0)) await b.delete()
})

function setupHub() {
  const tokens = new Map<string, Device>()
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date().toISOString(),
    access: accesoConFirma,
  })
  const salaHub = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: null } : null
  })
  /** Un "WebSocket" en memoria: los mensajes viajan como JSON y llegan en otra vuelta. */
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
  const floor = new Sala({ db, open: h.open })
  salas.push(floor)
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

async function wait(condicion: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!(await condicion())) {
    if (Date.now() > end) throw new Error('No se cumplió a tiempo')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const vista = async (s: Sala) =>
  pedidosAbiertos((await s.sync?.locals()) ?? []).map((p) => ({
    id: p.status.id,
    total: p.total,
    items: Object.keys(p.status.items).sort(),
  }))

describe('Sala (motor de la app)', () => {
  it('dos equipos sin conexión crean pedidos y al volver ven lo mismo, sin duplicados', async () => {
    const h = setupHub()
    const ana = await device(h, 'Ana')
    const beto = await device(h, 'Beto')
    await wait(() => ana.instantanea().connection === 'connected')
    await wait(() => beto.instantanea().connection === 'connected')

    ana.simularSinConexion(true)
    beto.simularSinConexion(true)
    expect(ana.instantanea().connection).toBe('disconnected')

    const p1 = newId()
    await ana.record('OrderOpened', p1, { channel: 'dine_in', table_id: tableId, guests: 2 })
    await ana.record('ItemAdded', p1, item('Aperol Spritz', 32_000))
    const p2 = newId()
    await beto.record('OrderOpened', p2, { channel: 'dine_in', table_id: null, guests: 1 })
    await beto.record('ItemAdded', p2, item('Pizza Margarita', 44_900))
    await beto.record('ItemAdded', p2, item('Limonada', 9_900))

    // Persistir antes de mostrar: sin conexión ya se ve, como pendiente.
    expect(ana.instantanea().pendingList).toBe(2)
    expect(beto.instantanea().pendingList).toBe(3)
    expect(await vista(ana)).toEqual([expect.objectContaining({ id: p1, total: 32_000 })])

    ana.simularSinConexion(false)
    beto.simularSinConexion(false)
    await wait(async () => {
      const [a, b] = [await vista(ana), await vista(beto)]
      return (
        ana.instantanea().pendingList === 0 &&
        beto.instantanea().pendingList === 0 &&
        a.length === 2 &&
        JSON.stringify(a) === JSON.stringify(b)
      )
    })
    expect(h.hub.order(p1)).not.toBeNull()
    const allConfirmed = (await ana.sync?.locals())?.filter((l) => l.status === 'confirmed')
    expect(allConfirmed?.map((l) => l.event.sequence).sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('sin sesión no se puede crear un evento; tras el tiempo sin uso la sesión se cierra', async () => {
    const h = setupHub()
    const s = await device(h, 'Ana')
    const session = s.instantanea().session as Session
    s.vencerSesionSiToca(session.lastUsed + 29 * 60_000)
    expect(s.instantanea().session).not.toBeNull()
    s.vencerSesionSiToca(session.lastUsed + 30 * 60_000)
    expect(s.instantanea().session).toBeNull()
    await expect(
      s.record('OrderOpened', newId(), { channel: 'dine_in', table_id: null, guests: 0 }),
    ).rejects.toThrow('Sin sesión')
  })

  it('un evento con datos inválidos no se guarda', async () => {
    const h = setupHub()
    const s = await device(h, 'Ana')
    await expect(
      s.record('OrderOpened', newId(), { channel: 'dine_in', table_id: null, guests: -1 }),
    ).rejects.toThrow('Evento inválido')
    expect(s.instantanea().pendingList).toBe(0)
  })
})
