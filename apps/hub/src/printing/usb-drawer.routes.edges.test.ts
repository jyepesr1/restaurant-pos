import { fullConfig, newId } from '@pos/core'
import { drawerPulse } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { insertVersioned, SYSTEM } from '../access/records'
import { createAppServer } from '../server'
import { type Device, setupPrinting } from './printing-setup'
import type { Target } from './transport'
import type { WindowsPrinter } from './windows-print'

// Task 1.13 routes, the odd inputs: bodies that are not objects, sessions that were closed or
// whose device was removed, printers of another restaurant, a USB printer edited and printed on,
// and the phone addresses. Complements `usb-drawer.routes.test.ts`.

type Json = Record<string, unknown>

function world(windowsPrinters?: () => Promise<WindowsPrinter[] | null>) {
  const t = setupPrinting({ windowsPrinters })
  const admin = t.device('admin', 'register')
  const other = t.device('admin', 'register')
  const call = (e: Device, url: string, extra: Json = {}) =>
    t.post(url, { ...e.sessionBody, ...extra }, e.token)
  const config = () =>
    fullConfig(
      JSON.parse(
        String(
          t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(t.restaurantId)?.config,
        ),
      ),
    )
  const usb = (address: string, extra: Json = {}) => ({
    name: 'Caja',
    connection: 'usb',
    address,
    port: null,
    width: 80,
    code_page: 'pc850',
    fallback_id: null,
    station_ids: [],
    active: true,
    ...extra,
  })
  return { t, admin, other, call, config, usb }
}

const ROUTES: [string, Json][] = [
  ['/api/printers/windows', {}],
  ['/api/register/cash-drawer', { printer_id: null }],
  ['/api/register/cash-drawer/test', {}],
]

describe('bodies that are not what the route expects', () => {
  it.each(ROUTES)('%s: a body that is not an object is 400 (with a valid token)', async (url) => {
    const m = world()
    for (const payload of ['text', '[]', '7', 'null', '""', 'true']) {
      const r = await m.t.app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${m.admin.token}`, 'content-type': 'application/json' },
      })
      expect([400, 415], `${url} ${payload} -> ${r.statusCode}`).toContain(r.statusCode)
    }
  })

  it.each(ROUTES)(
    '%s: malformed JSON or a body with no content type is a 4xx, never a 500',
    async (url) => {
      const m = world()
      const bad = await m.t.app.inject({
        method: 'POST',
        url,
        payload: '{"session_id":',
        headers: { authorization: `Bearer ${m.admin.token}`, 'content-type': 'application/json' },
      })
      expect(bad.statusCode).toBeGreaterThanOrEqual(400)
      expect(bad.statusCode).toBeLessThan(500)
      const none = await m.t.app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${m.admin.token}` },
      })
      expect(none.statusCode).toBeGreaterThanOrEqual(400)
      expect(none.statusCode).toBeLessThan(500)
    },
  )

  it.each(ROUTES)('%s: session fields of the wrong shape are 400', async (url, body) => {
    const m = world()
    const s = m.admin.sessionBody
    for (const session of [
      { session_id: s.session_id.slice(1), secret: s.secret },
      { session_id: `${s.session_id}0`, secret: s.secret },
      { session_id: s.session_id, secret: '' },
      { session_id: s.session_id, secret: 'x'.repeat(101) },
      { session_id: 5, secret: s.secret },
      { session_id: s.session_id, secret: null },
      { session_id: s.session_id },
    ]) {
      const r = await m.t.post(url, { ...session, ...body }, m.admin.token)
      expect(r.statusCode, `${url} ${JSON.stringify(session).slice(0, 60)}`).toBe(400)
    }
  })

  it.each(ROUTES)('%s: an unknown extra field is 400', async (url, body) => {
    const m = world()
    expect((await m.call(m.admin, url, { ...body, surprise: 1 })).statusCode).toBe(400)
  })

  it('printer_id: 26 characters that are not a printer are 400 with the message, not 500', async () => {
    const m = world()
    for (const id of [
      'x'.repeat(26),
      '0'.repeat(26),
      "'; DROP TABLE printers;--".padEnd(26, 'x').slice(0, 26),
    ]) {
      const r = await m.call(m.admin, '/api/register/cash-drawer', { printer_id: id })
      expect(r.statusCode).toBe(400)
      expect(r.json()).toMatchObject({ message: 'Esa impresora no existe o está archivada' })
    }
    expect(m.config().cash_drawer_printer_id).toBeNull()
    expect(Number(m.t.db.prepare('SELECT count(*) AS n FROM printers').get()?.n)).toBe(0)
  })

  it('a lowercase version of a real printer id is not that printer', async () => {
    const m = world()
    const p = m.t.newPrinter('Caja', [])
    const r = await m.call(m.admin, '/api/register/cash-drawer', { printer_id: p.id.toLowerCase() })
    expect(r.statusCode).toBe(400)
    expect(m.config().cash_drawer_printer_id).toBeNull()
  })

  it('a very large body is refused without 500', async () => {
    const m = world()
    const r = await m.call(m.admin, '/api/register/cash-drawer', {
      printer_id: 'x'.repeat(5_000_000),
    })
    expect(r.statusCode).toBeGreaterThanOrEqual(400)
    expect(r.statusCode).toBeLessThan(500)
  })

  it('GET on the POST routes does not exist', async () => {
    const m = world()
    for (const [url] of ROUTES) {
      const r = await m.t.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${m.admin.token}` },
      })
      expect(r.statusCode).toBe(404)
    }
  })
})

describe('sessions and devices that are no longer valid', () => {
  it.each(ROUTES)('%s: a closed session is 401 and changes nothing', async (url, body) => {
    const m = world()
    const p = m.t.newPrinter('Caja', [])
    await m.call(m.admin, '/api/register/cash-drawer', { printer_id: p.id })
    const closed = await m.t.post('/api/sessions/close', m.admin.sessionBody, m.admin.token)
    expect(closed.statusCode).toBe(204)
    const r = await m.call(m.admin, url, body)
    expect(r.statusCode).toBe(401)
    expect(m.config().cash_drawer_printer_id).toBe(p.id)
    expect(p.paper.attempts).toBe(0)
  })

  it.each(ROUTES)('%s: the session of another device is 401', async (url, body) => {
    const m = world()
    const r = await m.t.post(url, { ...m.other.sessionBody, ...body }, m.admin.token)
    expect(r.statusCode).toBe(401)
  })

  it.each(ROUTES)('%s: a revoked device is 401 even with a valid session', async (url, body) => {
    const m = world()
    const removed = m.t.access.revokeDevice(m.other.connection, {
      sessionId: m.other.session.sessionId,
      secret: m.other.session.secret,
      deviceId: m.admin.connection.deviceId,
    })
    expect(removed.ok).toBe(true)
    const r = await m.call(m.admin, url, body)
    expect(r.statusCode).toBe(401)
  })

  it('a waiter’s device with an admin signed in on it can do it; the same device without them cannot', async () => {
    const m = world()
    const waiter = m.t.device('waiter', 'waiter')
    expect((await m.call(waiter, '/api/register/cash-drawer/test')).statusCode).toBe(403)
    expect((await m.call(waiter, '/api/printers/windows')).statusCode).toBe(403)
  })
})

describe('printers of another restaurant', () => {
  function foreignPrinter(t: ReturnType<typeof world>['t']) {
    const other = newId()
    const now = new Date(t.clock()).toISOString()
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, now, now)
    t.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    return insertVersioned(
      t.db,
      'printers',
      other,
      {
        name: 'Ajena',
        connection: 'usb',
        address: 'POS-AJENA',
        port: null,
        width: 80,
        code_page: 'pc850',
        station_ids: '[]',
      },
      SYSTEM,
      now,
    )
  }

  it('cannot be edited, used as a fallback, tested or chosen as the drawer', async () => {
    const m = world()
    const id = foreignPrinter(m.t)
    const edit = await m.call(m.admin, '/api/printers', {
      printer: { ...m.usb('HACKED'), id },
    })
    expect(edit.statusCode).toBe(400)
    expect(m.t.db.prepare('SELECT address FROM printers WHERE id = ?').get(id)?.address).toBe(
      'POS-AJENA',
    )
    const mine = await m.call(m.admin, '/api/printers', {
      printer: m.usb('POS-80', { fallback_id: id }),
    })
    expect(mine.statusCode).toBe(400)
    expect((await m.call(m.admin, '/api/printers/test', { printer_id: id })).statusCode).toBe(400)
    expect(
      (await m.call(m.admin, '/api/register/cash-drawer', { printer_id: id })).statusCode,
    ).toBe(400)
    expect(m.config().cash_drawer_printer_id).toBeNull()
    expect(m.t.jobs()).toEqual([])
  })
})

describe('a USB printer saved, edited and printed on', () => {
  it('network to USB drops the port; USB back to network needs an IP', async () => {
    const m = world()
    const made = await m.call(m.admin, '/api/printers', {
      printer: {
        name: 'Cocina',
        connection: 'network',
        address: '10.0.0.7',
        port: 9100,
        width: 80,
        code_page: 'pc850',
        fallback_id: null,
        station_ids: [],
        active: true,
      },
    })
    const { id } = made.json() as { id: string }
    const toUsb = await m.call(m.admin, '/api/printers', {
      printer: { ...m.usb('POS-80'), id, port: 9100 },
    })
    expect(toUsb.statusCode).toBe(200)
    expect(
      m.t.db.prepare('SELECT connection, address, port FROM printers WHERE id = ?').get(id),
    ).toEqual({
      connection: 'usb',
      address: 'POS-80',
      port: null,
    })
    const back = await m.call(m.admin, '/api/printers', {
      printer: { ...m.usb('POS-80'), id, connection: 'network' },
    })
    expect(back.statusCode).toBe(400)
    expect(m.t.db.prepare('SELECT connection FROM printers WHERE id = ?').get(id)?.connection).toBe(
      'usb',
    )
  })

  it('a USB printer rejects names with the characters Windows does not allow, whatever its other fields', async () => {
    const m = world()
    for (const address of ['\\\\PC\\Cocina', 'Local Port,XcvPort', 'a\nb', 'x'.repeat(221)]) {
      const r = await m.call(m.admin, '/api/printers', { printer: m.usb(address) })
      expect(r.statusCode, address).toBe(400)
    }
    expect(Number(m.t.db.prepare('SELECT count(*) AS n FROM printers').get()?.n)).toBe(0)
  })

  it('names with quotes and shell characters are kept exactly and listed back exactly', async () => {
    const m = world()
    const name = `POS "80" $(x) \`y\` 'z' ñ`
    const r = await m.call(m.admin, '/api/printers', { printer: m.usb(name) })
    expect(r.statusCode).toBe(200)
    const listed = (await m.call(m.admin, '/api/kitchen/config')).json() as {
      printers: { address: string }[]
    }
    expect(listed.printers.map((p) => p.address)).toEqual([name])
  })

  it('a ticket for a USB printer reaches the sender as a USB target with the Windows name, not as a pulse', async () => {
    const targets: Target[] = []
    const t = setupPrinting({
      send: () => async (target) => {
        targets.push(target)
      },
    })
    const admin = t.device('admin', 'register')
    const saved = await t.post(
      '/api/printers',
      {
        ...admin.sessionBody,
        printer: {
          name: 'Cocina USB',
          connection: 'usb',
          address: 'POS-80 "Cocina"',
          port: null,
          width: 80,
          code_page: 'pc850',
          fallback_id: null,
          station_ids: [t.kitchen],
          active: true,
        },
      },
      admin.token,
    )
    expect(saved.statusCode).toBe(200)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Plato', station: t.kitchen }])
    t.send(ana, order, items)
    await t.queue.runOnce()
    expect(targets).toEqual([{ connection: 'usb', address: 'POS-80 "Cocina"', port: null }])
    expect(targets[0]?.nowOrNever).toBeUndefined()
    expect(t.pendingList()).toBe(0)
  })

  it('the drawer on a USB printer: the test button sends the pulse with nowOrNever', async () => {
    const targets: { target: Target; bytes: number[] }[] = []
    const t = setupPrinting({
      send: () => async (target, bytes) => {
        targets.push({ target, bytes: [...bytes] })
      },
    })
    const admin = t.device('admin', 'register')
    const p = t.newPrinter('Caja', [], { connection: 'usb', address: 'POS-80', port: null })
    await t.post(
      '/api/register/cash-drawer',
      { ...admin.sessionBody, printer_id: p.id },
      admin.token,
    )
    const r = await t.post('/api/register/cash-drawer/test', admin.sessionBody, admin.token)
    expect(r.statusCode).toBe(204)
    expect(targets).toEqual([
      {
        target: { connection: 'usb', address: 'POS-80', port: null, nowOrNever: true },
        bytes: [...drawerPulse()],
      },
    ])
  })

  it('the test button when the sender refuses the USB printer is 502, not 500', async () => {
    // No custom sender: the real transport, which on this machine is not Windows.
    const t = setupPrinting()
    const admin = t.device('admin', 'register')
    const p = t.newPrinter('Caja', [], { connection: 'usb', address: 'POS-80', port: null })
    await t.post(
      '/api/register/cash-drawer',
      { ...admin.sessionBody, printer_id: p.id },
      admin.token,
    )
    const r = await t.post('/api/register/cash-drawer/test', admin.sessionBody, admin.token)
    // The fake network has no paper under a Windows name: the sender refuses, the route says so.
    expect(r.statusCode).toBe(502)
    expect(r.json()).toMatchObject({ error: 'printer_failed' })
  })
})

describe('/api/printers/windows', () => {
  it('returns exactly name, port and driver, and nothing else', async () => {
    const m = world(async () => [
      { name: 'POS-80', port: 'USB001', driver: 'POS-80C', extra: 'leak' } as WindowsPrinter,
    ])
    const r = await m.call(m.admin, '/api/printers/windows')
    expect(r.json().printers[0]).toMatchObject({
      name: 'POS-80',
      port: 'USB001',
      driver: 'POS-80C',
    })
  })

  it('two requests at once both answer', async () => {
    let calls = 0
    const m = world(async () => {
      calls += 1
      return []
    })
    const [a, b] = await Promise.all([
      m.call(m.admin, '/api/printers/windows'),
      m.call(m.admin, '/api/printers/windows'),
    ])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect(calls).toBe(2)
  })

  it('a listing that rejects with something that is not an Error is still “not available”', async () => {
    const m = world(async () => {
      throw 'texto'
    })
    expect((await m.call(m.admin, '/api/printers/windows')).json()).toEqual({
      available: false,
      printers: [],
    })
  })
})

describe('/api/addresses', () => {
  const get = (app: ReturnType<typeof createAppServer>, url = '/api/addresses', method = 'GET') =>
    app.inject({ method: method as 'GET', url })

  it('only GET exists; POST, PUT and DELETE are not routes', async () => {
    const app = createAppServer({ addresses: () => [] })
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'])
      expect((await get(app, '/api/addresses', method)).statusCode, method).toBeGreaterThanOrEqual(
        404,
      )
    await app.close()
  })

  it('it asks the function every time (the network can change while the hub runs)', async () => {
    let list = ['http://192.168.1.20:4000']
    const app = createAppServer({ addresses: () => list })
    expect((await get(app)).json()).toEqual({ addresses: ['http://192.168.1.20:4000'] })
    list = ['http://10.0.0.5:4000', 'http://192.168.1.20:4000']
    expect((await get(app)).json().addresses).toHaveLength(2)
    list = []
    expect((await get(app)).json()).toEqual({ addresses: [] })
    await app.close()
  })

  it('if listing the network fails, that request fails and the server keeps answering', async () => {
    let fail = true
    const app = createAppServer({
      addresses: () => {
        if (fail) throw new Error('uv_interface_addresses failed')
        return ['http://10.0.0.5:4000']
      },
    })
    expect((await get(app)).statusCode).toBe(500)
    fail = false
    expect((await get(app)).statusCode).toBe(200)
    await app.close()
  })

  it('query strings and trailing slashes do not break it, and the health check is unaffected', async () => {
    const app = createAppServer({ addresses: () => ['http://10.0.0.5:4000'] })
    expect((await get(app, '/api/addresses?x=1')).statusCode).toBe(200)
    expect((await get(app, '/api/health')).statusCode).toBe(200)
    await app.close()
  })

  it('it is public on purpose: no token, no session, same answer', async () => {
    const app = createAppServer({ addresses: () => ['http://10.0.0.5:4000'] })
    const noAuth = await get(app)
    const bad = await app.inject({
      method: 'GET',
      url: '/api/addresses',
      headers: { authorization: 'Bearer inventado' },
    })
    expect(bad.statusCode).toBe(noAuth.statusCode)
    expect(bad.json()).toEqual(noAuth.json())
    await app.close()
  })
})
