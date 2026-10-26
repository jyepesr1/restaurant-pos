import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId, signEvent } from '@pos/core'
import type { MensajeHub } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import { abrirDatos, prepararAcceso, prepararSincronizacion } from './arranque'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Agotado (86) por el WebSocket real del hub, con la carta del piloto: el aviso `nuevo` llega a
// los demás equipos, quien no tiene permiso no lo difunde y un ítem de un producto agotado entra.

const CARTA = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

let carpeta = ''
afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

type Sesion = { session_id: string; secret: string; user: { id: string } }

async function montar() {
  carpeta = mkdtempSync(join(tmpdir(), 'pos-agotados-'))
  const { db } = abrirDatos(carpeta)
  let sala: ReturnType<typeof prepararSincronizacion> | null = null
  const access = prepararAcceso(
    db,
    carpeta,
    () => {},
    (id, en) => sala?.revoke(id, en),
  )
  const { pins } = sembrar(
    db,
    access.access,
    { restauranteId: access.restauranteId, roles: access.roles, menu: leerCarta(CARTA) },
    new Date().toISOString(),
  )
  sala = prepararSincronizacion(db, carpeta, access.restauranteId, access.access)
  const app = crearServidor({
    access: access.access,
    sincronizacion: { sala, intervaloLatidoMs: 60_000 },
    catalog: { db, restauranteId: access.restauranteId, access: access.access },
  })
  await app.ready()
  /** Con qué entra cada quien: usuario y contraseña si los tiene (ADR-013), si no su PIN. */
  const credencialesDe = (name: string) => {
    if (name === 'Administrador')
      return {
        user: access.admin.user as string,
        password: access.admin.password as string,
      }
    const p = pins.find((x) => x.name === name)
    return p?.user ? { user: p.user, password: p.password as string } : { pin: p?.pin as string }
  }
  const post = async (url: string, cuerpo: object, token?: string) =>
    (
      await app.inject({
        method: 'POST',
        url,
        payload: cuerpo,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    ).json()

  /**
   * Entra sin emparejar (ADR-013): el hub registra el equipo, de caja si quien entra cobra. El
   * tipo y el nombre de cada llamada solo dicen qué equipo es en la prueba.
   */
  async function device(_tipo: 'waiter' | 'register', _nombre: string, quien: string) {
    const r = await post('/api/sign-in', credencialesDe(quien))
    return {
      token: r.device.token as string,
      dispositivoId: r.device.device_id as string,
      session: r as Sesion,
    }
  }

  /** Abre el WebSocket; `esperar` se resuelve cuando llega (o ya llegó) un mensaje así. */
  async function connect(token: string) {
    const recibidos: MensajeHub[] = []
    const pendingList: { sirve: (m: MensajeHub) => boolean; ready: (m: MensajeHub) => void }[] = []
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as MensajeHub
      recibidos.push(m)
      for (const [i, p] of pendingList.entries())
        if (p.sirve(m)) {
          pendingList.splice(i, 1)
          p.ready(m)
          break
        }
    })
    const send = (m: object) => ws.send(JSON.stringify(m))
    send({ type: 'hello', token, hub_instancia: null, until: 0, version_app: 'prueba' })
    const esperar = <T extends MensajeHub['type']>(
      type: T,
      sirve: (m: Extract<MensajeHub, { type: T }>) => boolean = () => true,
    ) =>
      new Promise<Extract<MensajeHub, { type: T }>>((ready) => {
        const cumple = (m: MensajeHub) =>
          m.type === type && sirve(m as Extract<MensajeHub, { type: T }>)
        const already = recibidos.find(cumple)
        if (already) ready(already as Extract<MensajeHub, { type: T }>)
        else pendingList.push({ sirve: cumple, ready: ready as (m: MensajeHub) => void })
      })
    await esperar('welcome')
    return { ws, recibidos, send, esperar }
  }

  const catalog = async (token: string) =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/catalog',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()

  return { app, device, connect, catalog }
}

const event = (
  e: { session: Sesion; dispositivoId: string },
  type: string,
  data: unknown,
  extras: Record<string, unknown> = {},
) => {
  const ahora = new Date().toISOString()
  const base = {
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    related: [],
    data,
    session_id: e.session.session_id,
    user_id: e.session.user.id,
    device_id: e.dispositivoId,
    authorization_id: null,
    reason: null,
    device_time: ahora,
    hub_estimated_time: ahora,
    base_sequence: 0,
    ...extras,
  }
  return { ...base, signature: signEvent(base as never, e.session.secret) }
}

const markSoldOut = (
  e: Parameters<typeof event>[0],
  product: string,
  variant: string | null = null,
) =>
  event(
    e,
    'ProductSoldOut',
    { product_id: product, variant_id: variant },
    { aggregate_type: 'product', aggregate_id: product },
  )

type MenuProduct = {
  id: string
  name: string
  price: number
  tax: { type: string; rate: number }
  variants: { id: string }[]
}
const primerProductoSimple = (catalog: { categories: { products: MenuProduct[] }[] }) =>
  catalog.categories.flatMap((c) => c.products).find((p) => p.variants.length === 0) as MenuProduct

describe('agotados por el WebSocket', () => {
  it('la caja marca agotado: se confirma y el celular del mesero recibe el aviso nuevo, sin la sesión', async () => {
    const m = await montar()
    const register = await m.device('register', 'Caja', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana', 'Mesero 1')
    const product = primerProductoSimple(await m.catalog(register.token))
    const enCaja = await m.connect(register.token)
    const enCelular = await m.connect(phone.token)

    const e = markSoldOut(register, product.id)
    enCaja.send({ type: 'push', lote_id: 'l1', events: [e] })

    const result = await enCaja.esperar('result')
    expect(result).toMatchObject({
      lote_id: 'l1',
      resultados: [{ id: e.id, status: 'confirmed', aceptacion: { sequence: 1 } }],
    })
    const alert = await enCelular.esperar('new', (n) => n.event.id === e.id)
    expect(alert).toMatchObject({
      hasta_anterior: 0,
      until: 1,
      event: {
        type: 'ProductSoldOut',
        aggregate_type: 'product',
        aggregate_id: product.id,
        session_id: null,
        data: { product_id: product.id, variant_id: null },
      },
    })

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('el mesero no puede agotar: lo rechaza con sin_permiso y no se avisa a nadie', async () => {
    const m = await montar()
    const register = await m.device('register', 'Caja', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana', 'Mesero 1')
    const product = primerProductoSimple(await m.catalog(register.token))
    const enCaja = await m.connect(register.token)
    const enCelular = await m.connect(phone.token)

    const e = markSoldOut(phone, product.id)
    enCelular.send({ type: 'push', lote_id: 'l1', events: [e] })
    expect(await enCelular.esperar('result')).toMatchObject({
      resultados: [{ id: e.id, status: 'rejected', reason: 'no_permission' }],
    })
    // El pong llega después de todo lo anterior en el mismo orden: si hubiera aviso, ya estaría.
    enCaja.send({ type: 'ping', brand: 'fin' })
    await enCaja.esperar('pong')
    expect(enCaja.recibidos.some((x) => x.type === 'new')).toBe(false)
    expect(enCelular.recibidos.some((x) => x.type === 'new')).toBe(false)

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('un ítem de un producto agotado entra con el precio de la carta y sin conflicto', async () => {
    const m = await montar()
    const register = await m.device('register', 'Caja', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana', 'Mesero 1')
    const catalog = await m.catalog(register.token)
    const product = primerProductoSimple(catalog)
    const enCaja = await m.connect(register.token)
    const enCelular = await m.connect(phone.token)
    enCaja.send({ type: 'push', lote_id: 'a', events: [markSoldOut(register, product.id)] })
    await enCelular.esperar('new')

    // El celular, que ya sabe que está agotado, igual manda lo que su mesero ya había tomado.
    const order = newId()
    const open = event(
      phone,
      'OrderOpened',
      { channel: 'bar', table_id: null, guests: 1 },
      { aggregate_id: order },
    )
    const itemAgotado = event(
      phone,
      'ItemAdded',
      {
        item_id: newId(),
        product_id: product.id,
        variant_id: null,
        name: product.name,
        unit_price: product.price,
        tax_type: product.tax.type,
        rate: product.tax.type === 'exempt' ? 0 : product.tax.rate,
        quantity: 2,
        guest: null,
        course: null,
        modifiers: [],
        notes: null,
        catalog_version: catalog.version,
        price_channel_id: null,
      },
      { aggregate_id: order, base_sequence: 1 },
    )
    enCelular.send({ type: 'push', lote_id: 'b', events: [open, itemAgotado] })

    const r = await enCelular.esperar('result', (x) => x.lote_id === 'b')
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(r.resultados[1]).toMatchObject({ conflict: null })

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('un equipo que se conecta después trae el agotado con `traer`, en su lugar de la secuencia', async () => {
    const m = await montar()
    const register = await m.device('register', 'Caja', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana', 'Mesero 1')
    const product = primerProductoSimple(await m.catalog(register.token))
    const enCaja = await m.connect(register.token)
    enCaja.send({ type: 'push', lote_id: 'a', events: [markSoldOut(register, product.id)] })
    await enCaja.esperar('result')
    enCaja.send({
      type: 'push',
      lote_id: 'b',
      events: [
        event(
          register,
          'ProductAvailable',
          { product_id: product.id, variant_id: null },
          { aggregate_type: 'product', aggregate_id: product.id, base_sequence: 1 },
        ),
      ],
    })
    await enCaja.esperar('result', (x) => x.lote_id === 'b')

    const tarde = await m.connect(phone.token)
    tarde.send({ type: 'pull', from: 0 })
    const traido = await tarde.esperar('events')
    expect(traido.events.map((x) => [x.sequence, x.type, x.aggregate_type])).toEqual([
      [1, 'ProductSoldOut', 'product'],
      [2, 'ProductAvailable', 'product'],
    ])

    enCaja.ws.terminate()
    tarde.ws.terminate()
    await m.app.close()
  })
})
