import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId, signEvent } from '@pos/core'
import type { FloorSync, HubMessage } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { abrirDatos, instanciaDelHub, prepararAcceso, prepararSincronizacion } from './arranque'
import { leerCarta } from './seed/carta'
import { seed } from './seed/sembrar'
import { crearServidor } from './servidor'

// La 0.10 de punta a punta en el hub: emparejar, entrar con PIN, empujar un evento firmado por el
// WebSocket y que otro equipo lo reciba. Con la carta del piloto sembrada.

const CARTA = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

let folder = ''
afterEach(() => rmSync(folder, { recursive: true, force: true }))

async function setup(
  options: { esperaSaludoMs?: number; onFailure?: (error: unknown) => void } = {},
) {
  folder = mkdtempSync(join(tmpdir(), 'pos-sync-'))
  const { db } = abrirDatos(folder)
  let floor: ReturnType<typeof prepararSincronizacion> | null = null
  const access = prepararAcceso(
    db,
    folder,
    () => {},
    (id, en) => floor?.revoke(id, en),
  )
  const { pins } = seed(
    db,
    access.access,
    { restaurantId: access.restaurantId, roles: access.roles, menu: leerCarta(CARTA) },
    new Date().toISOString(),
  )
  floor = prepararSincronizacion(db, folder, access.restaurantId, access.access)
  const app = crearServidor({
    access: access.access,
    sincronizacion: { floor, intervaloLatidoMs: 60_000, ...options },
    catalog: { db, restaurantId: access.restaurantId, access: access.access },
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
   * Un equipo como en el restaurante (ADR-013): entra sin emparejar y el hub lo registra. La caja
   * entra con la contraseña del administrador; el celular, con el PIN de un mesero.
   */
  async function device(type: 'waiter' | 'register', _nombre: string) {
    const r = await post(
      '/api/sign-in',
      credencialesDe(type === 'register' ? 'Administrador' : 'Mesero 2'),
    )
    return { token: r.device.token as string, device_id: r.device.device_id as string }
  }

  /** Abre el WebSocket y junta lo que llega. */
  async function connect(token: string) {
    const received: HubMessage[] = []
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    ws.on('message', (d) => received.push(JSON.parse(d.toString())))
    const send = (m: object) => ws.send(JSON.stringify(m))
    send({ type: 'hello', token, hub_instance: null, until: 0, version_app: 'prueba' })
    const esperar = async (type: string) => {
      for (let i = 0; i < 100 && !received.some((m) => m.type === type); i++)
        await new Promise((r) => setTimeout(r, 10))
      return received.find((m) => m.type === type)
    }
    return { ws, received, send, esperar }
  }

  return { app, db, access, credencialesDe, post, device, connect }
}

describe('WebSocket de sincronización', () => {
  it('un pedido firmado de un mesero llega confirmado y el otro equipo lo recibe', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana')
    const session = await m.post('/api/sign-in', m.credencialesDe('Mesero 1'), phone.token)

    const enCaja = await m.connect(register.token)
    const enCelular = await m.connect(phone.token)
    const welcome = await enCelular.esperar('welcome')
    expect(welcome).toMatchObject({ type: 'welcome', max_sequence: 0 })
    expect(typeof (welcome as { hub_instance: string }).hub_instance).toBe('string')

    const now = new Date().toISOString()
    const event = {
      id: newId(),
      type: 'OrderOpened',
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: newId(),
      related: [],
      data: { channel: 'dine_in', table_id: null, guests: 2 },
      session_id: session.session_id,
      user_id: session.user.id,
      device_id: phone.device_id,
      authorization_id: null,
      reason: null,
      device_time: now,
      hub_estimated_time: now,
      base_sequence: 0,
    }
    const firmado = { ...event, signature: signEvent(event as never, session.secret) }
    enCelular.send({ type: 'push', batch_id: 'l1', events: [firmado] })

    const result = await enCelular.esperar('result')
    expect(result).toMatchObject({
      batch_id: 'l1',
      results: [{ id: event.id, status: 'confirmed' }],
    })
    const fresh = await enCaja.esperar('new')
    expect(fresh).toMatchObject({ event: { id: event.id, sequence: 1, session_id: null } })

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('lo que no es JSON o no es un mensaje se responde con error sin cortar', async () => {
    const m = await setup()
    const device = await m.device('register', 'Caja')
    const c = await m.connect(device.token)
    await c.esperar('welcome')
    c.ws.send('esto no es json')
    const error = await c.esperar('error')
    expect(error).toMatchObject({ code: 'invalid_message' })
    c.send({ type: 'ping', brand: 'x' })
    expect(await c.esperar('pong')).toMatchObject({ brand: 'x' })
    c.ws.terminate()
    await m.app.close()
  })
})

describe('catálogo para los equipos', () => {
  it('entrega mesas, estaciones y la carta sembrada, solo con token', async () => {
    const m = await setup()
    const device = await m.device('waiter', 'Celular')
    const without = await m.app.inject({ method: 'GET', url: '/api/catalog' })
    expect(without.statusCode).toBe(401)

    const r = await m.app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { authorization: `Bearer ${device.token}` },
    })
    const catalog = r.json()
    expect(catalog.tables).toHaveLength(25)
    expect(catalog.stations.map((e: { name: string }) => e.name)).toEqual(['Cocina', 'Barra'])
    const products = catalog.categories.flatMap((c: { products: unknown[] }) => c.products)
    expect(products).toHaveLength(98)
    const vino = products.find((p: { name: string }) => p.name === 'Ramón Bilbao Crianza')
    expect(vino.variants.map((v: { name: string }) => v.name)).toEqual(['Copa', 'Botella'])
    expect(vino.tax).toEqual({ type: 'inc', rate: 800 })
    expect(catalog.version).toBeGreaterThan(0)
    await m.app.close()
  })
})

describe('instancia del hub', () => {
  it('se crea una vez y se mantiene', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-instancia-'))
    const a = instanciaDelHub(folder)
    expect(instanciaDelHub(folder)).toBe(a)
  })
})

// ── Fallas del WebSocket ─────────────────────────────────────────────────────────────────────

/** Espera a que el socket se cierre y devuelve el código con que lo cerró el hub. */
const closeout = (ws: WebSocket) =>
  new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))

function eventoPedido(
  session: { session_id: string; secret: string; user: { id: string } },
  deviceId: string,
) {
  const now = new Date().toISOString()
  const event = {
    id: newId(),
    type: 'OrderOpened',
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    related: [],
    data: { channel: 'dine_in', table_id: null, guests: 1 },
    session_id: session.session_id,
    user_id: session.user.id,
    device_id: deviceId,
    authorization_id: null,
    reason: null,
    device_time: now,
    hub_estimated_time: now,
    base_sequence: 0,
  }
  return { ...event, signature: signEvent(event as never, session.secret) }
}

describe('WebSocket: mensajes enormes', () => {
  it('un mensaje de más de 1 MB cierra esa conexión (1009) y el hub sigue atendiendo a los demás', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const badCase = await m.connect(phone.token)
    await badCase.esperar('welcome')
    const closed = closeout(badCase.ws)
    badCase.ws.send(JSON.stringify({ type: 'ping', brand: 'x'.repeat(1024 * 1024 + 1) }))
    expect(await closed).toBe(1009)

    const other = await m.connect(register.token)
    expect(await other.esperar('welcome')).toBeDefined()
    other.send({ type: 'ping', brand: 'vivo' })
    expect(await other.esperar('pong')).toMatchObject({ brand: 'vivo' })
    other.ws.terminate()
    await m.app.close()
  })

  it('un mensaje grande pero bajo el límite se responde con error y no corta la conexión', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const c = await m.connect(register.token)
    await c.esperar('welcome')
    c.ws.send(JSON.stringify({ type: 'ping', brand: 'x'.repeat(900 * 1024) }))
    expect(await c.esperar('error')).toMatchObject({ code: 'invalid_message' })
    c.send({ type: 'ping', brand: 'sigue' })
    expect(await c.esperar('pong')).toMatchObject({ brand: 'sigue' })
    c.ws.terminate()
    await m.app.close()
  })

  it('un lote de más de 100 eventos se responde con error de formato', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const c = await m.connect(register.token)
    await c.esperar('welcome')
    c.send({ type: 'push', batch_id: 'l', events: Array.from({ length: 101 }, () => ({})) })
    expect(await c.esperar('error')).toMatchObject({ code: 'invalid_message' })
    c.ws.terminate()
    await m.app.close()
  })
})

describe('WebSocket: el socket se cierra a mitad', () => {
  it('si el dispositivo se corta justo tras empujar, el evento queda guardado y al reenviar no se duplica', async () => {
    const failures: unknown[] = []
    const m = await setup({ onFailure: (e) => failures.push(e) })
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const session = await m.post('/api/sign-in', m.credencialesDe('Mesero 1'), phone.token)
    const event = eventoPedido(session, phone.device_id)

    const firstOne = await m.connect(phone.token)
    await firstOne.esperar('welcome')
    firstOne.send({ type: 'push', batch_id: 'a', events: [event] })
    const closed = closeout(firstOne.ws)
    firstOne.ws.terminate() // sin respuesta: el celular perdió la señal
    await closed

    // Reconecta y reenvía el mismo lote: el hub reconoce el evento, no lo guarda dos veces.
    const secondOne = await m.connect(phone.token)
    await secondOne.esperar('welcome')
    secondOne.send({ type: 'push', batch_id: 'b', events: [event] })
    expect(await secondOne.esperar('result')).toMatchObject({
      batch_id: 'b',
      results: [{ id: event.id, status: 'confirmed' }],
    })

    const enCaja = await m.connect(register.token)
    await enCaja.esperar('welcome')
    enCaja.send({ type: 'pull', from: 0 })
    const traido = await enCaja.esperar('events')
    expect(traido).toMatchObject({ until: 1, has_more: false })
    expect((traido as { events: unknown[] }).events).toHaveLength(1)
    expect(failures).toEqual([])

    secondOne.ws.terminate()
    enCaja.ws.terminate()
    await m.app.close()
  })

  it('un equipo que se fue sin avisar no estorba al difundir lo que hace otro', async () => {
    const failures: unknown[] = []
    const m = await setup({ onFailure: (e) => failures.push(e) })
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const session = await m.post('/api/sign-in', m.credencialesDe('Mesero 1'), phone.token)

    const enCaja = await m.connect(register.token)
    await enCaja.esperar('welcome')
    const closed = closeout(enCaja.ws)
    enCaja.ws.terminate()
    await closed

    const enCelular = await m.connect(phone.token)
    await enCelular.esperar('welcome')
    const event = eventoPedido(session, phone.device_id)
    enCelular.send({ type: 'push', batch_id: 'l', events: [event] })
    expect(await enCelular.esperar('result')).toMatchObject({
      results: [{ id: event.id, status: 'confirmed' }],
    })
    expect(failures).toEqual([])
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('si el hub falla al procesar un mensaje, corta esa conexión (1011) y lo registra', async () => {
    const failing = new Error('el almacén no responde')
    const floor = {
      connect: () => ({
        receive: () => {
          throw failing
        },
        close: vi.fn(),
      }),
      beat: () => {},
    } as unknown as FloorSync
    const failures: unknown[] = []
    const app = crearServidor({ sincronizacion: { floor, onFailure: (e) => failures.push(e) } })
    await app.ready()
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    const closed = closeout(ws)
    ws.send(JSON.stringify({ type: 'ping', brand: 'x' }))
    expect(await closed).toBe(1011)
    expect(failures).toEqual([failing])
    await app.close()
  })

  it('una conexión que nunca saluda se cierra (1008) y se libera su lugar en la sala', async () => {
    const close = vi.fn()
    const floor = {
      connect: () => ({ receive: () => {}, close }),
      beat: () => {},
    } as unknown as FloorSync
    const app = crearServidor({ sincronizacion: { floor, esperaSaludoMs: 20 } })
    // Con un cliente real (el de `injectWS` deja el cierre a medias y el hub no ve el 'close').
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${port}/api/sync/ws`)
    const code = await new Promise<number>((resolve) =>
      ws.addEventListener('close', (e) => resolve(e.code)),
    )
    expect(code).toBe(1008)
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    await app.close()
  })
})

describe('WebSocket: token revocado con el equipo conectado', () => {
  it('avisa al equipo retirado, deja de mandarle el salón y lo que haga después no entra', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const admin = await m.post(
      '/api/sign-in',
      { user: m.access.admin.user, password: m.access.admin.password },
      register.token,
    )
    expect(admin.session_id).toBeDefined()
    const sesionMesero = await m.post('/api/sign-in', m.credencialesDe('Mesero 1'), phone.token)

    const enCaja = await m.connect(register.token)
    const enCelular = await m.connect(phone.token)
    await enCaja.esperar('welcome')
    await enCelular.esperar('welcome')

    // Estando conectado, la caja retira el celular.
    const r = await m.app.inject({
      method: 'POST',
      url: `/api/devices/${phone.device_id}/revoke`,
      payload: { session_id: admin.session_id, secret: admin.secret },
      headers: { authorization: `Bearer ${register.token}` },
    })
    expect(r.statusCode).toBe(200)
    expect(await enCelular.esperar('error')).toMatchObject({ code: 'revoked_token' })

    // Ya no lee el salón: ni lo nuevo ni lo que pide con `traer`.
    const delCaja = eventoPedido(admin, register.device_id)
    enCaja.send({ type: 'push', batch_id: 'c', events: [delCaja] })
    await enCaja.esperar('result')
    enCelular.send({ type: 'pull', from: 0 })
    await vi.waitFor(() =>
      expect(enCelular.received.filter((x) => x.type === 'error')).toHaveLength(2),
    )
    expect(enCelular.received.filter((x) => x.type === 'error')).toHaveLength(2)
    expect(enCelular.received.some((x) => x.type === 'new' || x.type === 'events')).toBe(false)

    // Lo que intente entregar después de la revocación no entra al salón.
    const late = eventoPedido(sesionMesero, phone.device_id)
    enCelular.send({ type: 'push', batch_id: 't', events: [late] })
    const result = await enCelular.esperar('result')
    expect(result).toMatchObject({ results: [{ id: late.id }] })
    expect((result as { results: { status: string }[] }).results[0]?.status).not.toBe('confirmed')
    expect(enCaja.received.some((x) => x.type === 'new' && x.event.id === late.id)).toBe(false)

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('con un token que ya estaba revocado al conectar no se le entrega el salón', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const admin = await m.post(
      '/api/sign-in',
      { user: m.access.admin.user, password: m.access.admin.password },
      register.token,
    )
    await m.app.inject({
      method: 'POST',
      url: `/api/devices/${phone.device_id}/revoke`,
      payload: { session_id: admin.session_id, secret: admin.secret },
      headers: { authorization: `Bearer ${register.token}` },
    })
    const c = await m.connect(phone.token)
    await c.esperar('welcome')
    c.send({ type: 'pull', from: 0 })
    expect(await c.esperar('error')).toMatchObject({ code: 'revoked_token' })
    expect(c.received.some((x) => x.type === 'events')).toBe(false)
    c.ws.terminate()
    await m.app.close()
  })
})
