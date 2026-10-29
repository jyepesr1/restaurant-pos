import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId, signEvent } from '@pos/core'
import type { HubMessage } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import { readMenu } from './seed/menu'
import { seed } from './seed/seed'
import { createAppServer } from './server'
import { openData, prepareAccess, prepareSync } from './startup'

// Sold out (86) over the hub's real WebSocket, with the pilot's menu: the `new` message reaches
// the other devices, whoever lacks permission does not broadcast it, and an item of a sold-out
// product gets in.

const MENU = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

let folder = ''
afterEach(() => rmSync(folder, { recursive: true, force: true }))

type Session = { session_id: string; secret: string; user: { id: string } }

async function setup() {
  folder = mkdtempSync(join(tmpdir(), 'pos-sold-out-'))
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
    sync: { floor, heartbeatIntervalMs: 60_000 },
    catalog: { db, restaurantId: access.restaurantId, access: access.access },
  })
  await app.ready()
  /** What each person signs in with: username and password if they have them (ADR-013), else PIN. */
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
   * Signs in without pairing (ADR-013): the hub registers the device, as a register if whoever
   * signs in can charge. Each call's type and name only say which device it is in the test.
   */
  async function device(_type: 'waiter' | 'register', _name: string, who: string) {
    const r = await post('/api/sign-in', credentialsOf(who))
    return {
      token: r.device.token as string,
      deviceId: r.device.device_id as string,
      session: r as Session,
    }
  }

  /** Opens the WebSocket; `wait` resolves when such a message arrives (or already arrived). */
  async function connect(token: string) {
    const received: HubMessage[] = []
    const pendingList: { accepts: (m: HubMessage) => boolean; ready: (m: HubMessage) => void }[] =
      []
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as HubMessage
      received.push(m)
      for (const [i, p] of pendingList.entries())
        if (p.accepts(m)) {
          pendingList.splice(i, 1)
          p.ready(m)
          break
        }
    })
    const send = (m: object) => ws.send(JSON.stringify(m))
    send({ type: 'hello', token, hub_instance: null, until: 0, version_app: 'test' })
    const wait = <T extends HubMessage['type']>(
      type: T,
      accepts: (m: Extract<HubMessage, { type: T }>) => boolean = () => true,
    ) =>
      new Promise<Extract<HubMessage, { type: T }>>((ready) => {
        const meets = (m: HubMessage) =>
          m.type === type && accepts(m as Extract<HubMessage, { type: T }>)
        const already = received.find(meets)
        if (already) ready(already as Extract<HubMessage, { type: T }>)
        else pendingList.push({ accepts: meets, ready: ready as (m: HubMessage) => void })
      })
    await wait('welcome')
    return { ws, received, send, wait }
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
  e: { session: Session; deviceId: string },
  type: string,
  data: unknown,
  extras: Record<string, unknown> = {},
) => {
  const now = new Date().toISOString()
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
    device_id: e.deviceId,
    authorization_id: null,
    reason: null,
    device_time: now,
    hub_estimated_time: now,
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
const firstSimpleProduct = (catalog: { categories: { products: MenuProduct[] }[] }) =>
  catalog.categories.flatMap((c) => c.products).find((p) => p.variants.length === 0) as MenuProduct

describe('sold out over the WebSocket', () => {
  it("the register marks sold out: it is confirmed and the waiter's phone gets the new message, without the session", async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana', 'Mesero 1')
    const product = firstSimpleProduct(await m.catalog(register.token))
    const atRegister = await m.connect(register.token)
    const onPhone = await m.connect(phone.token)

    const e = markSoldOut(register, product.id)
    atRegister.send({ type: 'push', batch_id: 'l1', events: [e] })

    const result = await atRegister.wait('result')
    expect(result).toMatchObject({
      batch_id: 'l1',
      results: [{ id: e.id, status: 'confirmed', acceptance: { sequence: 1 } }],
    })
    const alert = await onPhone.wait('new', (n) => n.event.id === e.id)
    expect(alert).toMatchObject({
      previous_until: 0,
      until: 1,
      event: {
        type: 'ProductSoldOut',
        aggregate_type: 'product',
        aggregate_id: product.id,
        session_id: null,
        data: { product_id: product.id, variant_id: null },
      },
    })

    atRegister.ws.terminate()
    onPhone.ws.terminate()
    await m.app.close()
  })

  it('the waiter cannot mark sold out: it is rejected with no_permission and nobody is notified', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana', 'Mesero 1')
    const product = firstSimpleProduct(await m.catalog(register.token))
    const atRegister = await m.connect(register.token)
    const onPhone = await m.connect(phone.token)

    const e = markSoldOut(phone, product.id)
    onPhone.send({ type: 'push', batch_id: 'l1', events: [e] })
    expect(await onPhone.wait('result')).toMatchObject({
      results: [{ id: e.id, status: 'rejected', reason: 'no_permission' }],
    })
    // The pong arrives after everything before it, in order: any message would already be here.
    atRegister.send({ type: 'ping', stamp: 'end' })
    await atRegister.wait('pong')
    expect(atRegister.received.some((x) => x.type === 'new')).toBe(false)
    expect(onPhone.received.some((x) => x.type === 'new')).toBe(false)

    atRegister.ws.terminate()
    onPhone.ws.terminate()
    await m.app.close()
  })

  it('an item of a sold-out product gets in with the menu price and no conflict', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana', 'Mesero 1')
    const catalog = await m.catalog(register.token)
    const product = firstSimpleProduct(catalog)
    const atRegister = await m.connect(register.token)
    const onPhone = await m.connect(phone.token)
    atRegister.send({ type: 'push', batch_id: 'a', events: [markSoldOut(register, product.id)] })
    await onPhone.wait('new')

    // The phone, which already knows it is sold out, still sends what its waiter had taken.
    const order = newId()
    const open = event(
      phone,
      'OrderOpened',
      { channel: 'bar', table_id: null, guests: 1 },
      { aggregate_id: order },
    )
    const soldOutItem = event(
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
    onPhone.send({ type: 'push', batch_id: 'b', events: [open, soldOutItem] })

    const r = await onPhone.wait('result', (x) => x.batch_id === 'b')
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(r.results[1]).toMatchObject({ conflict: null })

    atRegister.ws.terminate()
    onPhone.ws.terminate()
    await m.app.close()
  })

  it('a device that connects later gets the sold out with `pull`, in its place in the sequence', async () => {
    const m = await setup()
    const register = await m.device('register', 'Caja', 'Caja')
    const phone = await m.device('waiter', 'Celular Ana', 'Mesero 1')
    const product = firstSimpleProduct(await m.catalog(register.token))
    const atRegister = await m.connect(register.token)
    atRegister.send({ type: 'push', batch_id: 'a', events: [markSoldOut(register, product.id)] })
    await atRegister.wait('result')
    atRegister.send({
      type: 'push',
      batch_id: 'b',
      events: [
        event(
          register,
          'ProductAvailable',
          { product_id: product.id, variant_id: null },
          { aggregate_type: 'product', aggregate_id: product.id, base_sequence: 1 },
        ),
      ],
    })
    await atRegister.wait('result', (x) => x.batch_id === 'b')

    const late = await m.connect(phone.token)
    late.send({ type: 'pull', from: 0 })
    const fetched = await late.wait('events')
    expect(fetched.events.map((x) => [x.sequence, x.type, x.aggregate_type])).toEqual([
      [1, 'ProductSoldOut', 'product'],
      [2, 'ProductAvailable', 'product'],
    ])

    atRegister.ws.terminate()
    late.ws.terminate()
    await m.app.close()
  })
})
