import 'fake-indexeddb/auto'
import { newId, signEvent } from '@pos/core'
import {
  AlmacenMemoria,
  type Catalogo,
  type Channel,
  type ControlAcceso,
  HubSync,
  type Manejadores,
  SalaSync,
} from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { agotados, claveAgotado, pedidosAbiertos } from './proyeccion'

// Agotado (86) por el motor de la app: `registrar` arma el sobre del producto, lo firma, lo guarda
// antes de mostrarlo y el hub de prueba lo acepta, lo difunde o lo rechaza (tarea 1.3).

const secretoDe = (sesionId: string) => `secreto-${sesionId}`

const firmaValida = (event: Parameters<ControlAcceso['verify']>[1]) =>
  event.session_id !== null && event.signature === signEvent(event, secretoDe(event.session_id))

const accesoConFirma: ControlAcceso = {
  verify: (_c, event) =>
    firmaValida(event)
      ? { ok: true, authorizedById: null, autorizacionId: null }
      : { ok: false, reason: 'invalid_signature' },
  registrarUso: () => {},
}
/** Como el real: el agotado exige permiso, y este usuario no lo tiene. */
const accesoSinPermisoDeAgotar: ControlAcceso = {
  verify: (c, event, order) =>
    event.type === 'ProductSoldOut' || event.type === 'ProductAvailable'
      ? { ok: false, reason: 'no_permission' }
      : accesoConFirma.verify(c, event, order),
  registrarUso: () => {},
}

const catalog: Catalogo = {
  version: 3,
  restaurant: { name: 'Prueba', sesionInactividadMin: 30 },
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

function montarHub(access: ControlAcceso = accesoConFirma) {
  const tokens = new Map<string, Equipo>()
  const hub = new HubSync(new AlmacenMemoria(), {
    restauranteId: newId(),
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-test',
    clock: () => new Date().toISOString(),
    access,
  })
  const salaHub = new SalaSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { dispositivoId: e.dispositivoId, type: e.type, revocadoEn: null } : null
  })
  const open = (m: Manejadores): Channel => {
    let enlace: ReturnType<SalaSync['connect']> | null = null
    setTimeout(() => {
      enlace = salaHub.connect((msg) => {
        const copy = JSON.parse(JSON.stringify(msg))
        setTimeout(() => enlace && m.alMensaje(copy))
      })
      m.alAbrir()
    })
    return {
      send: (msg) => enlace?.recibir(JSON.parse(JSON.stringify(msg))),
      close: () => {
        enlace?.close()
        enlace = null
      },
    }
  }
  return { hub, tokens, open }
}

async function device(h: ReturnType<typeof montarHub>, name: string) {
  const db = new BaseDispositivo(`prueba-${newId()}`)
  bases.push(db)
  const e: Equipo = { dispositivoId: newId(), token: newId(), name, type: 'register' }
  h.tokens.set(e.token, e)
  const sesionId = newId()
  const session: Sesion = {
    sesionId,
    secret: secretoDe(sesionId),
    user: { id: newId(), name, role: 'Cajero' },
    permissions: ['take_order', 'mark_product_sold_out'],
    ultimoUso: Date.now(),
  }
  await db.saveSetting('device', e)
  await db.saveSetting('session', session)
  await db.saveSetting('catalog', catalog)
  const sala = new Sala({ db, open: h.open })
  salas.push(sala)
  await sala.cargar()
  return { sala, session, device: e }
}

async function esperar(condicion: () => Promise<boolean> | boolean, ms = 3000) {
  const fin = Date.now() + ms
  while (!(await condicion())) {
    if (Date.now() > fin) throw new Error('No se cumplió a tiempo')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const locales = async (s: Sala) => (await s.sync?.locales()) ?? []
const enLinea = (s: Sala) => esperar(() => s.instantanea().connection === 'connected')

describe('Sala.registrar con eventos de producto', () => {
  it('arma el sobre del producto: agregado_tipo producto, su id, firmado y sin pedido', async () => {
    const h = montarHub()
    const { sala, session, device: e } = await device(h, 'Caja')
    const product = newId()

    const created = await sala.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })

    expect(created).toMatchObject({
      type: 'ProductSoldOut',
      aggregate_type: 'product',
      aggregate_id: product,
      related: [],
      session_id: session.sesionId,
      user_id: session.user.id,
      device_id: e.dispositivoId,
      reason: null,
      authorization_id: null,
    })
    expect(created.signature).toBe(
      signEvent({ ...created, signature: undefined } as never, session.secret),
    )
    const guardados = await locales(sala)
    expect(guardados).toHaveLength(1)
    expect(guardados[0]?.status).toBe('pending')
    // Persistir antes de mostrar: ya se ve agotado, y ningún pedido nació.
    expect(agotados(guardados)).toEqual(new Set([product]))
    expect(pedidosAbiertos(guardados)).toEqual([])
  })

  it('un evento de pedido sigue armándose como pedido', async () => {
    const h = montarHub()
    const { sala } = await device(h, 'Caja')
    const order = newId()
    const created = await sala.record('OrderOpened', order, {
      channel: 'takeout',
      table_id: null,
      guests: 1,
    })
    expect(created.aggregate_type).toBe('order')
    expect(pedidosAbiertos(await locales(sala))).toHaveLength(1)
  })

  it('el hub de prueba lo acepta con su secuencia y el otro equipo lo recibe', async () => {
    const h = montarHub()
    const register = await device(h, 'Caja')
    const waiter = await device(h, 'Ana')
    await enLinea(register.sala)
    await enLinea(waiter.sala)
    const product = newId()
    const bottle = newId()

    await register.sala.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: bottle,
    })
    await esperar(async () => (await locales(waiter.sala)).length === 1)
    await esperar(() => register.sala.instantanea().pendingList === 0)

    for (const s of [register.sala, waiter.sala]) {
      const l = await locales(s)
      expect(l[0]).toMatchObject({ status: 'confirmed' })
      expect(l[0]?.event.sequence).toBe(1)
      expect(agotados(l)).toEqual(new Set([claveAgotado(product, bottle)]))
    }
    expect(h.hub.order(product)).toBeNull()

    // Y la reposición también les llega a los dos.
    await register.sala.record('ProductAvailable', product, {
      product_id: product,
      variant_id: bottle,
    })
    await esperar(async () => agotados(await locales(waiter.sala)).size === 0)
    expect(agotados(await locales(register.sala))).toEqual(new Set())
  })

  it('sin conexión se ve agotado al instante y al volver se confirma sin duplicarse', async () => {
    const h = montarHub()
    const register = await device(h, 'Caja')
    const waiter = await device(h, 'Ana')
    await enLinea(register.sala)
    await enLinea(waiter.sala)
    register.sala.simularSinConexion(true)
    const product = newId()

    await register.sala.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })
    expect(register.sala.instantanea().pendingList).toBe(1)
    expect(agotados(await locales(register.sala))).toEqual(new Set([product]))
    // El mesero todavía no lo sabe.
    expect(agotados(await locales(waiter.sala))).toEqual(new Set())

    register.sala.simularSinConexion(false)
    await esperar(async () => agotados(await locales(waiter.sala)).has(product))
    await esperar(() => register.sala.instantanea().pendingList === 0)
    expect(await locales(register.sala)).toHaveLength(1)
    expect(await locales(waiter.sala)).toHaveLength(1)
  })

  it('si el hub lo rechaza (sin permiso), deja de verse agotado en el equipo', async () => {
    const h = montarHub(accesoSinPermisoDeAgotar)
    const register = await device(h, 'Caja')
    register.sala.simularSinConexion(true)
    const product = newId()
    await register.sala.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })
    expect(agotados(await locales(register.sala))).toEqual(new Set([product]))

    register.sala.simularSinConexion(false)
    await esperar(async () => (await locales(register.sala))[0]?.status === 'rejected')
    const [l] = await locales(register.sala)
    expect(l?.reason).toBe('no_permission')
    expect(agotados(await locales(register.sala))).toEqual(new Set())
  })

  it('un agotado con datos inválidos no se guarda', async () => {
    const h = montarHub()
    const { sala } = await device(h, 'Caja')
    await expect(
      sala.record('ProductSoldOut', newId(), {
        product_id: 'no-es-ulid',
        variant_id: null,
      }),
    ).rejects.toThrow('Evento inválido')
    // El agregado y el producto deben ser el mismo.
    await expect(
      sala.record('ProductSoldOut', newId(), { product_id: newId(), variant_id: null }),
    ).rejects.toThrow('Evento inválido')
    expect(sala.instantanea().pendingList).toBe(0)
    expect(await locales(sala)).toEqual([])
  })

  it('un hub que se reinicia y vuelve: el agotado propio ya confirmado sigue visible', async () => {
    const h = montarHub()
    const register = await device(h, 'Caja')
    await enLinea(register.sala)
    const product = newId()
    await register.sala.record('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    })
    await esperar(() => register.sala.instantanea().pendingList === 0)

    register.sala.simularSinConexion(true)
    register.sala.simularSinConexion(false)
    await enLinea(register.sala)
    expect(agotados(await locales(register.sala))).toEqual(new Set([product]))
    expect(await locales(register.sala)).toHaveLength(1)
  })
})
