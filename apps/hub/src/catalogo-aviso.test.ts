import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HubMessage } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { abrirDatos, prepararAcceso, prepararSincronizacion } from './arranque'
import { leerCarta } from './seed/carta'
import { seed } from './seed/sembrar'
import { crearServidor } from './servidor'

// Al editar la carta, el hub avisa por WebSocket a los equipos conectados (no a los retirados)
// y ellos vuelven a pedirla. Cableado igual que en `main.ts`.

const CARTA = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

let folder = ''
afterEach(() => rmSync(folder, { recursive: true, force: true }))

async function setup() {
  folder = mkdtempSync(join(tmpdir(), 'pos-aviso-'))
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
  const salaFija = floor
  const app = crearServidor({
    access: access.access,
    sincronizacion: { floor, intervaloLatidoMs: 600_000 },
    catalog: {
      db,
      restaurantId: access.restaurantId,
      access: access.access,
      onChange: (version) => salaFija.notifyCatalog(version),
    },
  })
  await app.ready()
  const post = async (url: string, cuerpo: object, token?: string) =>
    (
      await app.inject({
        method: 'POST',
        url,
        payload: cuerpo,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    ).json()

  let register: string | undefined
  /**
   * Un equipo como en el restaurante (ADR-013): la caja y el celular entran sin emparejar (el hub
   * los registra); la pantalla de cocina se empareja desde la caja.
   */
  async function device(type: 'waiter' | 'register' | 'kds', name: string) {
    if (type === 'kds') {
      const { code } = await post('/api/pairings', { pin: access.admin.pin, name, type }, register)
      return (await post('/api/pair', { code })) as { token: string; device_id: string }
    }
    const r = await post(
      '/api/sign-in',
      type === 'register'
        ? { user: access.admin.user, password: access.admin.password }
        : { pin: pins.find((p) => p.name === 'Mesero 1')?.pin },
    )
    if (type === 'register') register ??= r.device.token
    return { token: r.device.token as string, device_id: r.device.device_id as string }
  }

  async function connect(token: string | null) {
    const received: HubMessage[] = []
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    ws.on('message', (d) => received.push(JSON.parse(d.toString())))
    const send = (m: object) => ws.send(JSON.stringify(m))
    if (token) send({ type: 'hello', token, hub_instance: null, until: 0, version_app: 'prueba' })
    const esperar = (type: string) =>
      esperarA(() => received.find((m) => m.type === type) as HubMessage)
    /** Un ping a modo de barrera: cuando vuelve el pong, todo lo anterior ya llegó. */
    const barrera = async () => {
      const brand = `b${received.length}`
      send({ type: 'ping', brand })
      await esperarA(() => received.find((m) => m.type === 'pong' && m.brand === brand))
    }
    const catalogos = () => received.filter((m) => m.type === 'catalog')
    return { ws, received, send, esperar, barrera, catalogos }
  }

  const admin = async (register: { token: string }) => {
    const r = await post(
      '/api/sign-in',
      { user: access.admin.user, password: access.admin.password },
      register.token,
    )
    return { session_id: String(r.session_id), secret: String(r.secret) }
  }
  const patch = async (register: { token: string }, session: object, changes: unknown[]) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      payload: { ...session, changes },
      headers: { authorization: `Bearer ${register.token}` },
    })
    return { code: r.statusCode, cuerpo: r.json() }
  }
  const product = () => {
    const f = db
      .prepare('SELECT id, price FROM products WHERE active = 1 ORDER BY name LIMIT 1')
      .get()
    return { id: String(f?.id), price: Number(f?.price) }
  }
  return { app, db, access, post, device, connect, admin, patch, product }
}

const esperarA = <T>(fn: () => T | undefined) =>
  vi.waitFor(() => {
    const v = fn()
    if (!v) throw new Error('todavía no')
    return v
  })

describe('aviso de catálogo por WebSocket', () => {
  it('al editar, todos los conectados reciben la versión nueva, también quien editó', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const kitchen = await m.device('kds', 'Cocina')
    const [enCaja, enCelular, enCocina] = await Promise.all([
      m.connect(register.token),
      m.connect(phone.token),
      m.connect(kitchen.token),
    ])
    for (const c of [enCaja, enCelular, enCocina]) await c.esperar('welcome')

    const session = await m.admin(register)
    const p = m.product()
    const r = await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    expect(r.code).toBe(200)

    for (const c of [enCaja, enCelular, enCocina]) {
      await c.barrera()
      expect(c.catalogos()).toEqual([{ type: 'catalog', version: r.cuerpo.version }])
    }
    // Y la carta que piden ya trae esa versión.
    const menu = await m.app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { authorization: `Bearer ${phone.token}` },
    })
    expect(menu.json().version).toBe(r.cuerpo.version)

    for (const c of [enCaja, enCelular, enCocina]) c.ws.terminate()
    await m.app.close()
  })

  it('cada edición manda su propio aviso, en orden y sin repetir versiones', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const c = await m.connect(register.token)
    await c.esperar('welcome')
    const session = await m.admin(register)
    const p = m.product()
    const versiones: number[] = []
    for (let i = 1; i <= 5; i++) {
      const r = await m.patch(register, session, [
        { entity: 'products', id: p.id, data: { price: p.price + i } },
      ])
      versiones.push(r.cuerpo.version)
    }
    await c.barrera()
    expect(c.catalogos().map((x) => (x as { version: number }).version)).toEqual(versiones)
    expect(new Set(versiones).size).toBe(5)
    c.ws.terminate()
    await m.app.close()
  })

  it('un equipo retirado estando conectado no recibe el aviso, y los demás sí', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const enCaja = await m.connect(register.token)
    const enCelular = await m.connect(phone.token)
    await enCaja.esperar('welcome')
    await enCelular.esperar('welcome')
    const session = await m.admin(register)

    const withdrawal = await m.app.inject({
      method: 'POST',
      url: `/api/devices/${phone.device_id}/revoke`,
      payload: session,
      headers: { authorization: `Bearer ${register.token}` },
    })
    expect(withdrawal.statusCode).toBe(200)
    await esperarA(() => enCelular.received.find((x) => x.type === 'error'))

    const p = m.product()
    const r = await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    expect(r.code).toBe(200)
    await enCaja.barrera()
    await enCelular.barrera()
    expect(enCaja.catalogos()).toHaveLength(1)
    expect(enCelular.catalogos()).toEqual([])

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('quien se conecta con un token ya retirado tampoco recibe avisos', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const session = await m.admin(register)
    await m.app.inject({
      method: 'POST',
      url: `/api/devices/${phone.device_id}/revoke`,
      payload: session,
      headers: { authorization: `Bearer ${register.token}` },
    })
    const enCelular = await m.connect(phone.token)
    await enCelular.esperar('welcome')
    const p = m.product()
    await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    await enCelular.barrera()
    expect(enCelular.catalogos()).toEqual([])
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('una conexión que no saludó, o con un token inventado, no recibe nada', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const sinSaludar = await m.connect(null)
    const inventado = await m.connect('token-que-no-existe')
    await esperarA(() => inventado.received.find((x) => x.type === 'error'))
    const session = await m.admin(register)
    const p = m.product()
    await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    await sinSaludar.barrera()
    await inventado.barrera()
    expect(sinSaludar.catalogos()).toEqual([])
    expect(inventado.catalogos()).toEqual([])
    sinSaludar.ws.terminate()
    inventado.ws.terminate()
    await m.app.close()
  })

  it('una edición rechazada, sin permiso o que no cambia nada no avisa a nadie', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const c = await m.connect(register.token)
    await c.esperar('welcome')
    const session = await m.admin(register)
    const p = m.product()

    // Inválida.
    expect(
      (await m.patch(register, session, [{ entity: 'products', id: p.id, data: { price: -5 } }]))
        .code,
    ).toBe(400)
    // Sin sesión válida.
    expect(
      (
        await m.patch(register, { ...session, secret: 'x' }, [
          { entity: 'products', id: p.id, data: { price: p.price + 1 } },
        ])
      ).code,
    ).toBe(401)
    // El mismo valor que ya tiene.
    const equal = await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price } },
    ])
    expect(equal.code).toBe(200)
    expect(equal.cuerpo.cambiados).toBe(0)

    await c.barrera()
    expect(c.catalogos()).toEqual([])
    c.ws.terminate()
    await m.app.close()
  })

  it('una conexión rota en medio no impide que las demás reciban el aviso', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const enCaja = await m.connect(register.token)
    const enCelular = await m.connect(phone.token)
    await enCaja.esperar('welcome')
    await enCelular.esperar('welcome')
    // El celular pierde la red (corte sin cierre limpio).
    enCelular.ws.terminate()
    const session = await m.admin(register)
    const p = m.product()
    const r = await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    expect(r.code).toBe(200)
    await enCaja.barrera()
    expect(enCaja.catalogos()).toHaveLength(1)
    enCaja.ws.terminate()
    await m.app.close()
  })
})
