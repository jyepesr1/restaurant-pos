import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HubMessage } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { readMenu } from './seed/menu'
import { seed } from './seed/seed'
import { createAppServer } from './server'
import { openData, prepareAccess, prepareSync } from './startup'

// When the menu is edited, the hub notifies connected devices over WebSocket (not removed ones)
// and they request it again. Wired the same as in `main.ts`.

const MENU = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

let folder = ''
afterEach(() => rmSync(folder, { recursive: true, force: true }))

async function setup() {
  folder = mkdtempSync(join(tmpdir(), 'pos-aviso-'))
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
  const fixedFloor = floor
  const app = createAppServer({
    access: access.access,
    sync: { floor, heartbeatIntervalMs: 600_000 },
    catalog: {
      db,
      restaurantId: access.restaurantId,
      access: access.access,
      onChange: (version) => fixedFloor.notifyCatalog(version),
    },
  })
  await app.ready()
  const post = async (url: string, body: object, token?: string) =>
    (
      await app.inject({
        method: 'POST',
        url,
        payload: body,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    ).json()

  let register: string | undefined
  /**
   * A device as in the restaurant (ADR-013): the register and the phone sign in without pairing
   * (the hub registers them); the kitchen screen is paired from the register.
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
    const wait = (type: string) =>
      waitFor(() => received.find((m) => m.type === type) as HubMessage)
    /** A ping as a barrier: when the pong comes back, everything before it has arrived. */
    const barrier = async () => {
      const brand = `b${received.length}`
      send({ type: 'ping', brand })
      await waitFor(() => received.find((m) => m.type === 'pong' && m.brand === brand))
    }
    const catalogs = () => received.filter((m) => m.type === 'catalog')
    return { ws, received, send, wait, barrier, catalogs }
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
    return { code: r.statusCode, body: r.json() }
  }
  const product = () => {
    const f = db
      .prepare('SELECT id, price FROM products WHERE active = 1 ORDER BY name LIMIT 1')
      .get()
    return { id: String(f?.id), price: Number(f?.price) }
  }
  return { app, db, access, post, device, connect, admin, patch, product }
}

const waitFor = <T>(fn: () => T | undefined) =>
  vi.waitFor(() => {
    const v = fn()
    if (!v) throw new Error('not yet')
    return v
  })

describe('catalog alert over WebSocket', () => {
  it('on edit, everyone connected receives the new version, including whoever edited', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const kitchen = await m.device('kds', 'Cocina')
    const [atRegister, onPhone, inKitchen] = await Promise.all([
      m.connect(register.token),
      m.connect(phone.token),
      m.connect(kitchen.token),
    ])
    for (const c of [atRegister, onPhone, inKitchen]) await c.wait('welcome')

    const session = await m.admin(register)
    const p = m.product()
    const r = await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    expect(r.code).toBe(200)

    for (const c of [atRegister, onPhone, inKitchen]) {
      await c.barrier()
      expect(c.catalogs()).toEqual([{ type: 'catalog', version: r.body.version }])
    }
    // And the menu they request already has that version.
    const menu = await m.app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { authorization: `Bearer ${phone.token}` },
    })
    expect(menu.json().version).toBe(r.body.version)

    for (const c of [atRegister, onPhone, inKitchen]) c.ws.terminate()
    await m.app.close()
  })

  it('each edit sends its own alert, in order and without repeating versions', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const c = await m.connect(register.token)
    await c.wait('welcome')
    const session = await m.admin(register)
    const p = m.product()
    const versions: number[] = []
    for (let i = 1; i <= 5; i++) {
      const r = await m.patch(register, session, [
        { entity: 'products', id: p.id, data: { price: p.price + i } },
      ])
      versions.push(r.body.version)
    }
    await c.barrier()
    expect(c.catalogs().map((x) => (x as { version: number }).version)).toEqual(versions)
    expect(new Set(versions).size).toBe(5)
    c.ws.terminate()
    await m.app.close()
  })

  it('a device removed while connected does not receive the alert, and the others do', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const atRegister = await m.connect(register.token)
    const onPhone = await m.connect(phone.token)
    await atRegister.wait('welcome')
    await onPhone.wait('welcome')
    const session = await m.admin(register)

    const withdrawal = await m.app.inject({
      method: 'POST',
      url: `/api/devices/${phone.device_id}/revoke`,
      payload: session,
      headers: { authorization: `Bearer ${register.token}` },
    })
    expect(withdrawal.statusCode).toBe(200)
    await waitFor(() => onPhone.received.find((x) => x.type === 'error'))

    const p = m.product()
    const r = await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    expect(r.code).toBe(200)
    await atRegister.barrier()
    await onPhone.barrier()
    expect(atRegister.catalogs()).toHaveLength(1)
    expect(onPhone.catalogs()).toEqual([])

    atRegister.ws.terminate()
    onPhone.ws.terminate()
    await m.app.close()
  })

  it('whoever connects with an already revoked token does not receive alerts either', async () => {
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
    const onPhone = await m.connect(phone.token)
    await onPhone.wait('welcome')
    const p = m.product()
    await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    await onPhone.barrier()
    expect(onPhone.catalogs()).toEqual([])
    onPhone.ws.terminate()
    await m.app.close()
  })

  it('a connection that did not say hello, or with a made-up token, receives nothing', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const withoutHello = await m.connect(null)
    const madeUp = await m.connect('token-que-no-existe')
    await waitFor(() => madeUp.received.find((x) => x.type === 'error'))
    const session = await m.admin(register)
    const p = m.product()
    await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    await withoutHello.barrier()
    await madeUp.barrier()
    expect(withoutHello.catalogs()).toEqual([])
    expect(madeUp.catalogs()).toEqual([])
    withoutHello.ws.terminate()
    madeUp.ws.terminate()
    await m.app.close()
  })

  it('an edit that is rejected, lacks permission or changes nothing alerts nobody', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const c = await m.connect(register.token)
    await c.wait('welcome')
    const session = await m.admin(register)
    const p = m.product()

    // Invalid.
    expect(
      (await m.patch(register, session, [{ entity: 'products', id: p.id, data: { price: -5 } }]))
        .code,
    ).toBe(400)
    // Without a valid session.
    expect(
      (
        await m.patch(register, { ...session, secret: 'x' }, [
          { entity: 'products', id: p.id, data: { price: p.price + 1 } },
        ])
      ).code,
    ).toBe(401)
    // The same value it already has.
    const equal = await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price } },
    ])
    expect(equal.code).toBe(200)
    expect(equal.body.changedCount).toBe(0)

    await c.barrier()
    expect(c.catalogs()).toEqual([])
    c.ws.terminate()
    await m.app.close()
  })

  it('a connection broken midway does not stop the others from receiving the alert', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja')
    const phone = await m.device('waiter', 'Celular')
    const atRegister = await m.connect(register.token)
    const onPhone = await m.connect(phone.token)
    await atRegister.wait('welcome')
    await onPhone.wait('welcome')
    // The phone loses the network (cut without a clean close).
    onPhone.ws.terminate()
    const session = await m.admin(register)
    const p = m.product()
    const r = await m.patch(register, session, [
      { entity: 'products', id: p.id, data: { price: p.price + 1_000 } },
    ])
    expect(r.code).toBe(200)
    await atRegister.barrier()
    expect(atRegister.catalogs()).toHaveLength(1)
    atRegister.ws.terminate()
    await m.app.close()
  })
})
