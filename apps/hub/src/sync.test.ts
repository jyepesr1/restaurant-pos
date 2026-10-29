import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId, signEvent } from '@pos/core'
import type { FloorSync, HubMessage } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { readMenu } from './seed/menu'
import { seed } from './seed/seed'
import { createAppServer } from './server'
import { hubInstance, openData, prepareAccess, prepareSync } from './startup'

// Task 0.10 end to end on the hub: pair, sign in with PIN, push a signed event over the
// WebSocket and have another device receive it. With the pilot menu seeded.

const MENU = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

let folder = ''
afterEach(() => rmSync(folder, { recursive: true, force: true }))

async function setup(options: { helloWaitMs?: number; onFailure?: (error: unknown) => void } = {}) {
  folder = mkdtempSync(join(tmpdir(), 'pos-sync-'))
  const { db } = openData(folder)
  let floor: ReturnType<typeof prepareSync> | null = null
  const access = prepareAccess(
    db,
    folder,
    () => {},
    (id, en) => floor?.revoke(id, en),
  )
  const { pins } = seed(
    db,
    access.access,
    { restaurantId: access.restaurantId, roles: access.roles, menu: readMenu(MENU) },
    new Date().toISOString(),
  )
  floor = prepareSync(db, folder, access.restaurantId, access.access)
  const app = createAppServer({
    access: access.access,
    sync: { floor, heartbeatIntervalMs: 60_000, ...options },
    catalog: { db, restaurantId: access.restaurantId, access: access.access },
  })
  await app.ready()
  /** How each person signs in: username and password if they have one (ADR-013), else a PIN. */
  const credentialsOf = (name: string) => {
    if (name === 'Administrador')
      return {
        user: access.admin.user as string,
        password: access.admin.password as string,
      }
    const p = pins.find((x) => x.name === name)
    return p?.user ? { user: p.user, password: p.password as string } : { pin: p?.pin as string }
  }
  const post = async (url: string, body: object, token?: string) =>
    (
      await app.inject({
        method: 'POST',
        url,
        payload: body,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    ).json()

  /**
   * A device as in the restaurant (ADR-013): it signs in without pairing and the hub registers it.
   * The register signs in with the admin password; the phone, with a waiter PIN.
   */
  async function device(type: 'waiter' | 'register', _name: string) {
    const r = await post(
      '/api/sign-in',
      credentialsOf(type === 'register' ? 'Administrador' : 'Mesero 2'),
    )
    return { token: r.device.token as string, device_id: r.device.device_id as string }
  }

  /** Opens the WebSocket and collects what arrives. */
  async function connect(token: string) {
    const received: HubMessage[] = []
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    ws.on('message', (d) => received.push(JSON.parse(d.toString())))
    const send = (m: object) => ws.send(JSON.stringify(m))
    send({ type: 'hello', token, hub_instance: null, until: 0, version_app: 'test' })
    const wait = async (type: string) => {
      for (let i = 0; i < 100 && !received.some((m) => m.type === type); i++)
        await new Promise((r) => setTimeout(r, 10))
      return received.find((m) => m.type === type)
    }
    return { ws, received, send, wait }
  }

  return { app, db, access, credentialsOf, post, device, connect }
}

describe('sync WebSocket', () => {
  it('a signed order from a waiter arrives confirmed and the other device receives it', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana')
    const session = await m.post('/api/sign-in', m.credentialsOf('Mesero 1'), phone.token)

    const atRegister = await m.connect(register.token)
    const onPhone = await m.connect(phone.token)
    const welcome = await onPhone.wait('welcome')
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
    const signed = { ...event, signature: signEvent(event as never, session.secret) }
    onPhone.send({ type: 'push', batch_id: 'l1', events: [signed] })

    const result = await onPhone.wait('result')
    expect(result).toMatchObject({
      batch_id: 'l1',
      results: [{ id: event.id, status: 'confirmed' }],
    })
    const fresh = await atRegister.wait('new')
    expect(fresh).toMatchObject({ event: { id: event.id, sequence: 1, session_id: null } })

    atRegister.ws.terminate()
    onPhone.ws.terminate()
    await m.app.close()
  })

  it('what is not JSON or not a message gets an error reply without cutting the connection', async () => {
    const m = await setup()
    const device = await m.device('register', 'Caja')
    const c = await m.connect(device.token)
    await c.wait('welcome')
    c.ws.send('esto no es json')
    const error = await c.wait('error')
    expect(error).toMatchObject({ code: 'invalid_message' })
    c.send({ type: 'ping', stamp: 'x' })
    expect(await c.wait('pong')).toMatchObject({ stamp: 'x' })
    c.ws.terminate()
    await m.app.close()
  })
})

describe('catalog for the devices', () => {
  it('delivers tables, stations and the seeded menu, only with a token', async () => {
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
    const wine = products.find((p: { name: string }) => p.name === 'Ramón Bilbao Crianza')
    expect(wine.variants.map((v: { name: string }) => v.name)).toEqual(['Copa', 'Botella'])
    expect(wine.tax).toEqual({ type: 'inc', rate: 800 })
    expect(catalog.version).toBeGreaterThan(0)
    await m.app.close()
  })
})

describe('hub instance', () => {
  it('is created once and kept', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-instance-'))
    const a = hubInstance(folder)
    expect(hubInstance(folder)).toBe(a)
  })
})

// ── WebSocket failures ───────────────────────────────────────────────────────────────────────

/** Waits for the socket to close and returns the code the hub closed it with. */
const closeout = (ws: WebSocket) =>
  new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))

function orderEvent(
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

describe('WebSocket: huge messages', () => {
  it('a message over 1 MB closes that connection (1009) and the hub keeps serving the others', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const badCase = await m.connect(phone.token)
    await badCase.wait('welcome')
    const closed = closeout(badCase.ws)
    badCase.ws.send(JSON.stringify({ type: 'ping', stamp: 'x'.repeat(1024 * 1024 + 1) }))
    expect(await closed).toBe(1009)

    const other = await m.connect(register.token)
    expect(await other.wait('welcome')).toBeDefined()
    other.send({ type: 'ping', stamp: 'alive' })
    expect(await other.wait('pong')).toMatchObject({ stamp: 'alive' })
    other.ws.terminate()
    await m.app.close()
  })

  it('a large message under the limit gets an error reply and does not cut the connection', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const c = await m.connect(register.token)
    await c.wait('welcome')
    c.ws.send(JSON.stringify({ type: 'ping', stamp: 'x'.repeat(900 * 1024) }))
    expect(await c.wait('error')).toMatchObject({ code: 'invalid_message' })
    c.send({ type: 'ping', stamp: 'still' })
    expect(await c.wait('pong')).toMatchObject({ stamp: 'still' })
    c.ws.terminate()
    await m.app.close()
  })

  it('a batch of more than 100 events gets a format error reply', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const c = await m.connect(register.token)
    await c.wait('welcome')
    c.send({ type: 'push', batch_id: 'l', events: Array.from({ length: 101 }, () => ({})) })
    expect(await c.wait('error')).toMatchObject({ code: 'invalid_message' })
    c.ws.terminate()
    await m.app.close()
  })
})

describe('WebSocket: the socket closes midway', () => {
  it('if the device drops right after pushing, the event stays stored and resending does not duplicate it', async () => {
    const failures: unknown[] = []
    const m = await setup({ onFailure: (e) => failures.push(e) })
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const session = await m.post('/api/sign-in', m.credentialsOf('Mesero 1'), phone.token)
    const event = orderEvent(session, phone.device_id)

    const firstSocket = await m.connect(phone.token)
    await firstSocket.wait('welcome')
    firstSocket.send({ type: 'push', batch_id: 'a', events: [event] })
    const closed = closeout(firstSocket.ws)
    firstSocket.ws.terminate() // no response: the phone lost signal
    await closed

    // Reconnects and resends the same batch: the hub recognizes the event and stores it only once.
    const reconnected = await m.connect(phone.token)
    await reconnected.wait('welcome')
    reconnected.send({ type: 'push', batch_id: 'b', events: [event] })
    expect(await reconnected.wait('result')).toMatchObject({
      batch_id: 'b',
      results: [{ id: event.id, status: 'confirmed' }],
    })

    const atRegister = await m.connect(register.token)
    await atRegister.wait('welcome')
    atRegister.send({ type: 'pull', from: 0 })
    const fetched = await atRegister.wait('events')
    expect(fetched).toMatchObject({ until: 1, has_more: false })
    expect((fetched as { events: unknown[] }).events).toHaveLength(1)
    expect(failures).toEqual([])

    reconnected.ws.terminate()
    atRegister.ws.terminate()
    await m.app.close()
  })

  it('a device that left without notice does not get in the way when broadcasting what another does', async () => {
    const failures: unknown[] = []
    const m = await setup({ onFailure: (e) => failures.push(e) })
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const session = await m.post('/api/sign-in', m.credentialsOf('Mesero 1'), phone.token)

    const atRegister = await m.connect(register.token)
    await atRegister.wait('welcome')
    const closed = closeout(atRegister.ws)
    atRegister.ws.terminate()
    await closed

    const onPhone = await m.connect(phone.token)
    await onPhone.wait('welcome')
    const event = orderEvent(session, phone.device_id)
    onPhone.send({ type: 'push', batch_id: 'l', events: [event] })
    expect(await onPhone.wait('result')).toMatchObject({
      results: [{ id: event.id, status: 'confirmed' }],
    })
    expect(failures).toEqual([])
    onPhone.ws.terminate()
    await m.app.close()
  })

  it('if the hub fails processing a message, it cuts that connection (1011) and logs it', async () => {
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
    const app = createAppServer({ sync: { floor, onFailure: (e) => failures.push(e) } })
    await app.ready()
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    const closed = closeout(ws)
    ws.send(JSON.stringify({ type: 'ping', stamp: 'x' }))
    expect(await closed).toBe(1011)
    expect(failures).toEqual([failing])
    await app.close()
  })

  it('a connection that never says hello is closed (1008) and its slot on the floor is freed', async () => {
    const close = vi.fn()
    const floor = {
      connect: () => ({ receive: () => {}, close }),
      beat: () => {},
    } as unknown as FloorSync
    const app = createAppServer({ sync: { floor, helloWaitMs: 20 } })
    // With a real client (the one from `injectWS` leaves the close half done and the hub never
    // sees the 'close').
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

describe('WebSocket: token revoked with the device connected', () => {
  it('notifies the removed device, stops sending it the dining room and what it does afterwards does not get in', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const admin = await m.post(
      '/api/sign-in',
      { user: m.access.admin.user, password: m.access.admin.password },
      register.token,
    )
    expect(admin.session_id).toBeDefined()
    const waiterSession = await m.post('/api/sign-in', m.credentialsOf('Mesero 1'), phone.token)

    const atRegister = await m.connect(register.token)
    const onPhone = await m.connect(phone.token)
    await atRegister.wait('welcome')
    await onPhone.wait('welcome')

    // While it is connected, the register removes the phone.
    const r = await m.app.inject({
      method: 'POST',
      url: `/api/devices/${phone.device_id}/revoke`,
      payload: { session_id: admin.session_id, secret: admin.secret },
      headers: { authorization: `Bearer ${register.token}` },
    })
    expect(r.statusCode).toBe(200)
    expect(await onPhone.wait('error')).toMatchObject({ code: 'revoked_token' })

    // It no longer reads the dining room: neither what is new nor what it asks for with `pull`.
    const registerEvent = orderEvent(admin, register.device_id)
    atRegister.send({ type: 'push', batch_id: 'c', events: [registerEvent] })
    await atRegister.wait('result')
    onPhone.send({ type: 'pull', from: 0 })
    await vi.waitFor(() =>
      expect(onPhone.received.filter((x) => x.type === 'error')).toHaveLength(2),
    )
    expect(onPhone.received.filter((x) => x.type === 'error')).toHaveLength(2)
    expect(onPhone.received.some((x) => x.type === 'new' || x.type === 'events')).toBe(false)

    // Whatever it tries to deliver after the revocation does not get into the dining room.
    const late = orderEvent(waiterSession, phone.device_id)
    onPhone.send({ type: 'push', batch_id: 't', events: [late] })
    const result = await onPhone.wait('result')
    expect(result).toMatchObject({ results: [{ id: late.id }] })
    expect((result as { results: { status: string }[] }).results[0]?.status).not.toBe('confirmed')
    expect(atRegister.received.some((x) => x.type === 'new' && x.event.id === late.id)).toBe(false)

    atRegister.ws.terminate()
    onPhone.ws.terminate()
    await m.app.close()
  })

  it('with a token that was already revoked when connecting, it is not given the dining room', async () => {
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
    await c.wait('welcome')
    c.send({ type: 'pull', from: 0 })
    expect(await c.wait('error')).toMatchObject({ code: 'revoked_token' })
    expect(c.received.some((x) => x.type === 'events')).toBe(false)
    c.ws.terminate()
    await m.app.close()
  })
})
