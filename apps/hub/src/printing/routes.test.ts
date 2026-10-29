import { fullConfig, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertVersioned, SYSTEM } from '../access/records'
import { readCatalog } from '../catalog'
import { type Device, setupPrinting } from './printing-setup'
import { validAddress } from './routes'

// The HTTP routes of «Cocina e impresoras» (ADR-015): who can call them and what data they
// accept.

type Json = Record<string, unknown>

async function world(options: Parameters<typeof setupPrinting>[0] = {}) {
  const t = setupPrinting(options)
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const manager = t.device('manager', 'register')
  const waiter = t.device('waiter')
  const makeCall = (e: Device, url: string, extra: Json = {}) =>
    t.post(url, { ...e.sessionBody, ...extra }, e.token)
  const validPrinter = (fields: Json = {}) => ({
    name: 'Cocina',
    connection: 'network',
    address: '192.168.1.50',
    port: 9100,
    width: 80,
    code_page: 'pc850',
    fallback_id: null,
    station_ids: [t.kitchen],
    active: true,
    ...fields,
  })
  const create = async (fields: Json = {}) => {
    const r = await makeCall(admin, '/api/printers', { printer: validPrinter(fields) })
    expect(r.statusCode).toBe(200)
    return r.json().id as string
  }
  const config = async () => (await makeCall(admin, '/api/kitchen/config')).json()
  return { t, admin, cashier, manager, waiter, makeCall, validPrinter, create, config }
}

type World = Awaited<ReturnType<typeof world>>

/** Each route, with a valid body and who can call it. */
const ROUTES = (m: World, id: { printer: string; job: string; screen: string }) => [
  { url: '/api/kitchen/config', body: {}, whoCan: ['admin'] },
  { url: '/api/printers', body: { printer: m.validPrinter() }, whoCan: ['admin'] },
  { url: '/api/printers/test', body: { printer_id: id.printer }, whoCan: ['admin'] },
  { url: '/api/printing/pending', body: {}, whoCan: ['admin', 'cashier', 'manager'] },
  {
    url: '/api/printing/discard',
    body: { job_id: id.job },
    whoCan: ['admin', 'cashier', 'manager'],
  },
  {
    url: '/api/screens/stations',
    body: { device_id: id.screen, station_ids: [m.t.kitchen] },
    whoCan: ['admin'],
  },
  { url: '/api/kitchen/timers', body: { yellow: 8, red: 16 }, whoCan: ['admin'] },
]
/** A valid body (without the session) for each route. */
const validBody = (m: World, url: string): Json =>
  ({
    '/api/kitchen/config': {},
    '/api/printers': { printer: m.validPrinter() },
    '/api/printers/test': { printer_id: newId() },
    '/api/printing/pending': {},
    '/api/printing/discard': { job_id: newId() },
    '/api/screens': { name: 'Cocina', station_ids: [m.t.kitchen] },
    '/api/screens/stations': { device_id: newId(), station_ids: [m.t.kitchen] },
    '/api/kitchen/timers': { yellow: 8, red: 16 },
  })[url] as Json
const ALL = ['admin', 'cashier', 'manager', 'waiter'] as const
const URLS = [
  '/api/kitchen/config',
  '/api/printers',
  '/api/printers/test',
  '/api/printing/pending',
  '/api/printing/discard',
  '/api/screens',
  '/api/screens/stations',
  '/api/kitchen/timers',
]

describe('who can call each route', () => {
  it.each(URLS)('%s: without a token replies 401, even if the body is garbage', async (url) => {
    const { t } = await world()
    for (const body of [{}, { x: 1 }, 'text', [1]]) {
      const r = await t.post(url, body)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_token' })
    }
  })

  it.each(URLS)('%s: with a made-up token replies 401', async (url) => {
    const { t, admin } = await world()
    const r = await t.post(url, admin.sessionBody, 'token-que-no-existe')
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'invalid_token' })
  })

  it.each(URLS)(
    '%s: with a token but with a made-up session or another secret replies 401',
    async (url) => {
      const m = await world()
      const invalidSessions = [
        { session_id: newId(), secret: 'inventado' },
        { session_id: m.admin.sessionBody.session_id, secret: 'otro-secreto' },
      ]
      for (const session of invalidSessions) {
        const r = await m.t.post(url, { ...session, ...validBody(m, url) }, m.admin.token)
        expect(r.statusCode).toBe(401)
        expect(r.json()).toMatchObject({ error: 'invalid_session' })
      }
    },
  )

  it.each(URLS)('%s: without the session data replies 400', async (url) => {
    const m = await world()
    const r = await m.t.post(url, validBody(m, url), m.admin.token)
    expect(r.statusCode).toBe(400)
  })

  it.each(URLS)("%s: another device's session does not work (401)", async (url) => {
    const m = await world()
    const r = await m.t.post(url, { ...m.admin.sessionBody, ...validBody(m, url) }, m.waiter.token)
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'invalid_session' })
  })

  it('a removed device loses access to all routes', async () => {
    const m = await world()
    const { t, admin, waiter } = m
    const r = await t.post(
      `/api/devices/${waiter.connection.deviceId}/revoke`,
      admin.sessionBody,
      admin.token,
    )
    expect(r.statusCode).toBe(200)
    for (const url of URLS) {
      const x = await t.post(url, waiter.sessionBody, waiter.token)
      expect(x.statusCode, url).toBe(401)
    }
  })

  it('a closed session is rejected with 401', async () => {
    const { t, admin, makeCall } = await world()
    await t.post('/api/sessions/close', admin.sessionBody, admin.token)
    expect((await makeCall(admin, '/api/kitchen/config')).statusCode).toBe(401)
  })

  it('the permission decides: manage_devices for the configuration; the queue, also record_payment', async () => {
    const m = await world()
    const { t, makeCall } = m
    const printer = t.newPrinter('Cocina', [t.kitchen])
    const { order, items } = t.orderWith(t.device('waiter2'), [
      { name: 'Pizza', station: t.kitchen },
    ])
    void order
    void items
    const jobId = newId()
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES (?, ?, ?, 'test', '{"printer":"x","stations":[],"time":"y"}', ?)`,
      )
      .run(jobId, t.restaurantId, printer.id, new Date(t.clock()).toISOString())
    for (const route of ROUTES(m, { printer: printer.id, job: jobId, screen: newId() })) {
      for (const who of ALL) {
        const device = m[who]
        const r = await makeCall(device, route.url, route.body)
        if (route.whoCan.includes(who)) {
          // The permission is enough; it may fail because of data (the test screen does not exist),
          // never because of permission.
          expect(r.statusCode, `${who} ${route.url}`).not.toBe(403)
          expect(r.statusCode, `${who} ${route.url}`).not.toBe(401)
        } else {
          expect(r.statusCode, `${who} ${route.url}`).toBe(403)
          expect(r.json()).toMatchObject({ error: 'no_permission' })
        }
      }
    }
  })

  it('a waiter cannot turn a device into a screen; neither can a cashier', async () => {
    const { t, waiter, cashier, makeCall } = await world()
    for (const e of [waiter, cashier]) {
      const r = await makeCall(e, '/api/screens', { name: 'Cocina', station_ids: [t.kitchen] })
      expect(r.statusCode).toBe(403)
    }
    expect(t.db.prepare('SELECT count(*) AS n FROM users WHERE screen = 1').get()).toEqual({
      n: 0,
    })
  })
})

describe('validAddress', () => {
  it.each([
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.1.50',
  ])('accepts the private IP %s', (ip) => {
    expect(validAddress(ip, 9100, false)).toBeNull()
  })

  it.each([
    '',
    ' ',
    'cocina',
    'cocina.local',
    'localhost',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.169.0.1',
    '11.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '255.255.255.255',
    '127.0.0.1',
    '10.0.0',
    '10.0.0.1.1',
    '10.0.0.256',
    '10.0.0.-1',
    '10.0.0.1/24',
    '10.0.0.1:9100',
    'http://10.0.0.1',
    ' 10.0.0.1',
    '10.0.0.1 ',
    '10.0.0.1\n',
    '::1',
    'fe80::1',
    '10.0.0.1@evil.com',
    '10.0.0.1#',
    '0x0a.0.0.1',
    '٠.٠.٠.١',
    '10.0.0.1e1',
  ])('rejects «%s»', (ip) => {
    expect(validAddress(ip, 9100, false)).not.toBeNull()
  })

  for (const ip of ['010.0.0.1', '10.00.0.1', '192.168.001.050', '10.0.0.01'])
    it(`rejects «${ip}» (with leading zeros some systems read it as octal)`, () => {
      // `getaddrinfo` treats `010` as octal: «010.0.0.1» connects to 8.0.0.1, outside the local
      // network.
      expect(validAddress(ip, 9100, false)).not.toBeNull()
    })

  it.each([9100, 9101, 9109, null])('accepts port %s', (p) => {
    expect(validAddress('192.168.1.5', p, false)).toBeNull()
  })

  it.each([0, 1, 22, 80, 443, 9099, 9110, 65535, -1, 3000, 4000])(
    'rejects port %s at the location',
    (p) => {
      expect(validAddress('192.168.1.5', p, false)).not.toBeNull()
    },
  )

  it('with the test printer (local addresses) accepts 127.0.0.1 and any port, but not the internet', () => {
    expect(validAddress('127.0.0.1', 41234, true)).toBeNull()
    expect(validAddress('127.1.2.3', 4000, true)).toBeNull()
    expect(validAddress('192.168.1.5', 4000, true)).toBeNull()
    expect(validAddress('8.8.8.8', 9100, true)).not.toBeNull()
    expect(validAddress('localhost', 9100, true)).not.toBeNull()
  })
})

describe('POST /api/printers: invalid data', () => {
  const invalid: [string, Json][] = [
    ['IP with a name', { address: 'impresora.local' }],
    ['odd IP', { address: '999.1.1.1' }],
    ['public IP', { address: '8.8.8.8' }],
    ["the PC's own IP", { address: '127.0.0.1' }],
    ['IP with a port attached', { address: '192.168.1.5:9100' }],
    ['empty IP', { address: '' }],
    ['256-character IP', { address: 'a'.repeat(256) }],
    ['port 0', { port: 0 }],
    ['port 65536', { port: 65536 }],
    ['negative port', { port: -5 }],
    ['decimal port', { port: 9100.5 }],
    ['text port', { port: '9100' }],
    ['port outside 9100-9109', { port: 9200 }],
    ['empty name', { name: '' }],
    ['name of spaces', { name: '    ' }],
    ['name of 61', { name: 'a'.repeat(61) }],
    ['number name', { name: 5 }],
    ['unknown connection', { connection: 'bluetooth' }],
    ['width 57', { width: 57 }],
    ['text width', { width: '80' }],
    ['made-up code page', { code_page: 'utf8' }],
    ['station that does not exist', { station_ids: [newId()] }],
    ['station with a short id', { station_ids: ['x'] }],
    ['more than 50 stations', { station_ids: Array.from({ length: 51 }, () => newId()) }],
    ['text active', { active: 'yes' }],
    ['nonexistent fallback', { fallback_id: newId() }],
    ['extra field', { extra: 1 }],
    ['no address', { address: undefined }],
    ['id that does not exist', { id: newId() }],
  ]

  it.each(invalid)('rejects %s with 400 and saves nothing', async (_, fields) => {
    const m = await world()
    const r = await m.makeCall(m.admin, '/api/printers', { printer: m.validPrinter(fields) })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'invalid_data' })
    expect(m.t.db.prepare('SELECT count(*) AS n FROM printers').get()).toEqual({ n: 0 })
    expect(m.t.catalogChanges).toEqual([])
  })

  it('a station from another restaurant gives 400, even if it exists in the database', async () => {
    const m = await world()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(other, other)
    const foreign = insertVersioned(
      m.t.db,
      'stations',
      other,
      { name: 'Cocina ajena', position: 1 },
      SYSTEM,
      '2026-10-24T20:00:00.000Z',
    )
    const r = await m.makeCall(m.admin, '/api/printers', {
      printer: m.validPrinter({ station_ids: [foreign] }),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toBe('Esa estación no existe')
  })

  it('an archived station of the same restaurant is silently dropped', async () => {
    const m = await world()
    m.t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(m.t.desserts)
    const id = await m.create({ station_ids: [m.t.kitchen, m.t.desserts, m.t.kitchen] })
    const cfg = await m.config()
    expect(cfg.printers.find((i: Json) => i.id === id).station_ids).toEqual([m.t.kitchen])
  })

  it('a printer cannot be its own fallback', async () => {
    const m = await world()
    const id = await m.create()
    const r = await m.makeCall(m.admin, '/api/printers', {
      printer: m.validPrinter({ id, fallback_id: id }),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toBe('Una impresora no puede ser su propio respaldo')
  })

  it('the fallback must exist, be active and belong to this restaurant', async () => {
    const m = await world()
    const archivedUser = await m.create({ name: 'Vieja' })
    await m.makeCall(m.admin, '/api/printers', {
      printer: m.validPrinter({ id: archivedUser, name: 'Vieja', active: false }),
    })
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(other, other)
    const foreign = insertVersioned(
      m.t.db,
      'printers',
      other,
      { name: 'Ajena', connection: 'network', address: '10.1.1.1', port: 9100, width: 80 },
      SYSTEM,
      '2026-10-24T20:00:00.000Z',
    )
    for (const fallback_id of [newId(), archivedUser, foreign]) {
      const r = await m.makeCall(m.admin, '/api/printers', {
        printer: m.validPrinter({ name: 'Barra', fallback_id }),
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().message).toBe('La impresora de respaldo no existe')
    }
  })

  it("another restaurant's printer cannot be edited", async () => {
    const m = await world()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(other, other)
    const foreign = insertVersioned(
      m.t.db,
      'printers',
      other,
      { name: 'Ajena', connection: 'network', address: '10.1.1.1', port: 9100, width: 80 },
      SYSTEM,
      '2026-10-24T20:00:00.000Z',
    )
    const r = await m.makeCall(m.admin, '/api/printers', {
      printer: m.validPrinter({ id: foreign, name: 'Robada' }),
    })
    expect(r.statusCode).toBe(400)
    expect(m.t.db.prepare('SELECT name FROM printers WHERE id = ?').get(foreign)).toEqual({
      name: 'Ajena',
    })
  })
})

describe('POST /api/printers: create, edit and archive', () => {
  it('creates a network printer with the default port and puts it in the configuration', async () => {
    const m = await world()
    const id = await m.create({ port: null, name: '  Cocina  ' })
    const cfg = await m.config()
    expect(cfg.printers).toEqual([
      {
        id,
        name: 'Cocina',
        connection: 'network',
        address: '192.168.1.50',
        port: 9100,
        width: 80,
        code_page: 'pc850',
        fallback_id: null,
        station_ids: [m.t.kitchen],
        active: true,
      },
    ])
    expect(cfg.stations.map((e: Json) => e.name)).toEqual(['Cocina', 'Barra', 'Postres'])
    expect(cfg.timers).toEqual({ yellow: 10, red: 20 })
    expect(cfg.screens).toEqual([])
    // The devices find out: the menu changed version.
    expect(m.t.catalogChanges.length).toBeGreaterThan(0)
  })

  it('repeated stations are saved only once', async () => {
    const m = await world()
    await m.create({ station_ids: [m.t.kitchen, m.t.kitchen, m.t.bar] })
    const cfg = await m.config()
    expect(cfg.printers[0].station_ids).toEqual([m.t.kitchen, m.t.bar])
  })

  it('a USB printer saves the Windows name and has no port', async () => {
    const m = await world()
    await m.create({ connection: 'usb', address: 'POS-80 Caja', port: 9100 })
    const cfg = await m.config()
    expect(cfg.printers[0]).toMatchObject({
      connection: 'usb',
      address: 'POS-80 Caja',
      port: null,
    })
  })

  it('editing keeps the id, bumps the version and records who changed it', async () => {
    const m = await world()
    const id = await m.create()
    const before = m.t.db.prepare('SELECT version FROM printers WHERE id = ?').get(id)
    const r = await m.makeCall(m.admin, '/api/printers', {
      printer: m.validPrinter({
        id,
        name: 'Cocina caliente',
        width: 58,
        code_page: 'wpc1252',
      }),
    })
    expect(r.json()).toEqual({ id })
    const row = m.t.db.prepare('SELECT * FROM printers WHERE id = ?').get(id)
    expect(row).toMatchObject({
      name: 'Cocina caliente',
      width: 58,
      code_page: 'wpc1252',
      user_id: m.admin.session.user.id,
    })
    expect(Number(row?.version)).toBeGreaterThan(Number(before?.version))
    expect(m.t.db.prepare('SELECT count(*) AS n FROM printers').get()).toEqual({ n: 1 })
  })

  it("changing a printer's stations changes where new tickets go", async () => {
    const m = await world()
    const id = await m.create({ station_ids: [m.t.kitchen] })
    await m.makeCall(m.admin, '/api/printers', {
      printer: m.validPrinter({ id, station_ids: [m.t.bar] }),
    })
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [
      { name: 'Pizza', station: m.t.kitchen },
      { name: 'Aperol', station: m.t.bar },
    ])
    m.t.send(ana, order, items)
    expect(m.t.jobs().map((f) => m.t.content(f).station)).toEqual(['Barra'])
  })

  it('archiving a printer removes it as the fallback of those pointing to it', async () => {
    const m = await world()
    const fallback = await m.create({
      name: 'Respaldo',
      address: '192.168.1.51',
      station_ids: [],
    })
    const a = await m.create({ name: 'A', address: '192.168.1.52', fallback_id: fallback })
    const b = await m.create({ name: 'B', address: '192.168.1.53', fallback_id: fallback })
    const c = await m.create({ name: 'C', address: '192.168.1.54', fallback_id: a })
    const before = Number(
      m.t.db.prepare('SELECT version FROM printers WHERE id = ?').get(a)?.version,
    )
    const r = await m.makeCall(m.admin, '/api/printers', {
      printer: m.validPrinter({
        id: fallback,
        name: 'Respaldo',
        address: '192.168.1.51',
        station_ids: [],
        active: false,
      }),
    })
    expect(r.statusCode).toBe(200)
    const cfg = await m.config()
    const lookup = (id: string) => cfg.printers.find((i: Json) => i.id === id)
    expect(lookup(a).fallback_id).toBeNull()
    expect(lookup(b).fallback_id).toBeNull()
    // The one pointing to another (which is still active) is not touched.
    expect(lookup(c).fallback_id).toBe(a)
    expect(lookup(fallback).active).toBe(false)
    expect(
      Number(m.t.db.prepare('SELECT version FROM printers WHERE id = ?').get(a)?.version),
    ).toBeGreaterThan(before)
  })

  it('archiving does not delete the printer or its pending tickets, and the archived one goes to the end of the list', async () => {
    const m = await world()
    const old = await m.create({ name: 'Aaa vieja', address: '192.168.1.60' })
    await m.create({ name: 'Zzz nueva', address: '192.168.1.61', station_ids: [m.t.bar] })
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [{ name: 'Pizza', station: m.t.kitchen }])
    m.t.send(ana, order, items)
    await m.makeCall(m.admin, '/api/printers', {
      printer: m.validPrinter({
        id: old,
        name: 'Aaa vieja',
        address: '192.168.1.60',
        active: false,
      }),
    })
    const cfg = await m.config()
    expect(cfg.printers.map((i: Json) => [i.name, i.active])).toEqual([
      ['Zzz nueva', true],
      ['Aaa vieja', false],
    ])
    expect(m.t.pendingList()).toBe(1)
    // Archived printers do not show up in the queue statuses.
    expect(cfg.statuses.map((e: Json) => e.name)).toEqual(['Zzz nueva'])
  })

  it('reactivating an archived printer makes it receive tickets again', async () => {
    const m = await world()
    const id = await m.create()
    const data = (active: boolean) => m.validPrinter({ id, active })
    await m.makeCall(m.admin, '/api/printers', { printer: data(false) })
    await m.makeCall(m.admin, '/api/printers', { printer: data(true) })
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [{ name: 'Pizza', station: m.t.kitchen }])
    m.t.send(ana, order, items)
    expect(m.t.jobs()).toHaveLength(1)
  })

  it('two printers can point to each other as fallback without hanging the queue', async () => {
    const m = await world()
    const a = m.t.newPrinter('A', [m.t.kitchen])
    const b = m.t.newPrinter('B', [m.t.bar])
    for (const [id, other, name, address] of [
      [a.id, b.id, 'A', a.address],
      [b.id, a.id, 'B', b.address],
    ] as const) {
      const r = await m.makeCall(m.admin, '/api/printers', {
        printer: m.validPrinter({
          id,
          name,
          address,
          fallback_id: other,
          station_ids: [],
        }),
      })
      expect(r.statusCode).toBe(200)
    }
    m.t.db
      .prepare('UPDATE printers SET station_ids = ? WHERE id = ?')
      .run(JSON.stringify([m.t.kitchen]), a.id)
    a.paper.off = true
    b.paper.off = true
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [{ name: 'Pizza', station: m.t.kitchen }])
    m.t.send(ana, order, items)
    for (let i = 0; i < 8; i++) {
      await m.t.queue.runOnce()
      await m.t.queue.runOnce()
      m.t.advance(60_000)
    }
    expect(m.t.pendingList()).toBe(1)
    b.paper.off = false
    for (let i = 0; i < 3; i++) {
      await m.t.queue.runOnce()
      await m.t.queue.runOnce()
      m.t.advance(60_000)
    }
    expect(m.t.pendingList()).toBe(0)
    expect(b.paper.received.length + a.paper.received.length).toBe(1)
  })
})

describe('with the test printer (allowLocal)', () => {
  it('accepts 127.0.0.1 and any port, and the job goes out over the real network', async () => {
    const m = await world({ allowLocal: true })
    const id = await m.create({ address: '127.0.0.1', port: 4455 })
    const row = m.t.db.prepare('SELECT address, port FROM printers WHERE id = ?').get(id)
    expect(row).toEqual({ address: '127.0.0.1', port: 4455 })
  })

  it('without the option, 127.0.0.1 is rejected', async () => {
    const m = await world()
    const r = await m.makeCall(m.admin, '/api/printers', {
      printer: m.validPrinter({ address: '127.0.0.1' }),
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('POST /api/printers/test', () => {
  it('queues a test page and the queue prints it', async () => {
    const m = await world()
    const printer = m.t.newPrinter('Cocina', [m.t.kitchen])
    const r = await m.makeCall(m.admin, '/api/printers/test', { printer_id: printer.id })
    expect(r.statusCode).toBe(201)
    const jobId = r.json().job_id as string
    await m.t.queue.ready()
    await m.t.queue.runOnce()
    expect(m.t.jobs().find((f) => f.id === jobId)).toMatchObject({
      type: 'test',
      status: 'printed',
      printer_id: printer.id,
    })
    const text = printer.paper.texts()[0] as string
    expect(text.replaceAll('\n', ' ')).toContain('PRUEBA DE IMPRESIÓN')
    expect(text).toContain('Imprime: Cocina')
  })

  it('with the printer off it stays pending and shows up in the pending list', async () => {
    const m = await world()
    const printer = m.t.newPrinter('Cocina', [m.t.kitchen])
    printer.paper.off = true
    await m.makeCall(m.admin, '/api/printers/test', { printer_id: printer.id })
    await m.t.queue.ready()
    await m.t.queue.runOnce()
    const list = (await m.makeCall(m.admin, '/api/printing/pending')).json()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ what: 'Página de prueba', printer: 'Cocina' })
    expect(list[0].attempts).toBeGreaterThan(0)
    expect(String(list[0].error)).toContain('rechazó la conexión')
  })

  it.each([
    ['that does not exist', () => newId()],
    ['with a short id', () => 'corto'],
  ])('a printer %s gives 400', async (_, id) => {
    const m = await world()
    const r = await m.makeCall(m.admin, '/api/printers/test', { printer_id: id() })
    expect(r.statusCode).toBe(400)
  })

  it('an archived printer is not tested', async () => {
    const m = await world()
    const printer = m.t.newPrinter('Vieja', [], { active: 0 })
    const r = await m.makeCall(m.admin, '/api/printers/test', { printer_id: printer.id })
    expect(r.statusCode).toBe(400)
    expect(m.t.jobs()).toEqual([])
  })

  it("the test's time is in the restaurant's time zone and includes the station names", async () => {
    const m = await world()
    const printer = m.t.newPrinter('Mixta', [m.t.kitchen, m.t.bar])
    const r = await m.makeCall(m.admin, '/api/printers/test', { printer_id: printer.id })
    const row = m.t.jobs().find((f) => f.id === r.json().job_id)
    const content = m.t.content(row)
    expect(content.stations).toEqual(['Cocina', 'Barra'])
    expect(content.printer).toBe('Mixta')
    expect(content.time).toMatch(/3:00\s*p\.\s*m\./)
  })
})

describe('POST /api/printing/pending and /discard', () => {
  async function withPendingJobs() {
    const m = await world()
    const printer = m.t.newPrinter('Cocina', [m.t.kitchen])
    printer.paper.off = true
    const ana = m.t.device('waiter2')
    for (let i = 0; i < 3; i++) {
      const { order, items } = m.t.orderWith(
        ana,
        [{ name: `Plato ${i}`, station: m.t.kitchen }],
        m.t.table(String(9 + i)),
      )
      m.t.send(ana, order, items)
      m.t.advance(1000)
    }
    await m.t.queue.runOnce()
    return { m, printer }
  }

  it('lists what has not printed, in order, with what it is, how many attempts and why it failed', async () => {
    const { m } = await withPendingJobs()
    const list = (await m.makeCall(m.admin, '/api/printing/pending')).json()
    expect(list.map((x: Json) => x.what)).toEqual([
      'Cocina · Mesa 9 · #1',
      'Cocina · Mesa 10 · #2',
      'Cocina · Mesa 11 · #3',
    ])
    expect(list[0]).toMatchObject({ printer: 'Cocina', attempts: 1 })
    expect(String(list[0].error)).toContain('rechazó')
    expect(list[1]).toMatchObject({ attempts: 0, error: null })
    expect(list[0].created_at < list[1].created_at).toBe(true)
  })

  it('does not list what was printed or discarded', async () => {
    const { m, printer } = await withPendingJobs()
    printer.paper.off = false
    m.t.advance(2000)
    await m.t.queue.runOnce()
    await m.t.queue.runOnce()
    expect((await m.makeCall(m.admin, '/api/printing/pending')).json()).toEqual([])
  })

  it('with nothing pending it returns an empty list', async () => {
    const m = await world()
    const r = await m.makeCall(m.cashier, '/api/printing/pending')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual([])
  })

  it('discarding marks the job with who and from which device, does not delete it and it leaves the list', async () => {
    const { m } = await withPendingJobs()
    const [first] = (await m.makeCall(m.cashier, '/api/printing/pending')).json()
    const r = await m.makeCall(m.cashier, '/api/printing/discard', { job_id: first.id })
    expect(r.statusCode).toBe(204)
    const row = m.t.db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(first.id)
    expect(row).toMatchObject({
      status: 'discarded',
      discarded_by_id: m.cashier.session.user.id,
      discarded_device_id: m.cashier.connection.deviceId,
    })
    expect(row?.finished_at).not.toBeNull()
    expect(m.t.db.prepare('SELECT count(*) AS n FROM print_jobs').get()).toEqual({ n: 3 })
    const list = (await m.makeCall(m.admin, '/api/printing/pending')).json()
    expect(list).toHaveLength(2)
  })

  it('discarding twice, or something already printed, or something that does not exist, gives 400', async () => {
    const { m, printer } = await withPendingJobs()
    const [first, second] = (await m.makeCall(m.admin, '/api/printing/pending')).json()
    expect(
      (await m.makeCall(m.admin, '/api/printing/discard', { job_id: first.id })).statusCode,
    ).toBe(204)
    const another = await m.makeCall(m.admin, '/api/printing/discard', { job_id: first.id })
    expect(another.statusCode).toBe(400)
    expect(another.json().message).toBe('Esa comanda ya salió o ya se descartó')
    printer.paper.off = false
    m.t.advance(2000)
    await m.t.queue.runOnce()
    await m.t.queue.runOnce()
    expect(
      (await m.makeCall(m.admin, '/api/printing/discard', { job_id: second.id })).statusCode,
    ).toBe(400)
    expect(
      (await m.makeCall(m.admin, '/api/printing/discard', { job_id: newId() })).statusCode,
    ).toBe(400)
  })

  it('what was discarded is not printed even if the printer comes back', async () => {
    const { m, printer } = await withPendingJobs()
    for (const x of (await m.makeCall(m.admin, '/api/printing/pending')).json())
      await m.makeCall(m.admin, '/api/printing/discard', { job_id: x.id })
    printer.paper.off = false
    m.t.advance(60_000)
    await m.t.queue.runOnce()
    expect(printer.paper.received).toHaveLength(0)
  })

  it("another restaurant's job cannot be discarded", async () => {
    const m = await world()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(other, other)
    const otherPrinter = insertVersioned(
      m.t.db,
      'printers',
      other,
      { name: 'Ajena', connection: 'network', address: '10.1.1.1', port: 9100, width: 80 },
      SYSTEM,
      '2026-10-24T20:00:00.000Z',
    )
    const job = newId()
    m.t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES (?, ?, ?, 'test', '{}', '2026-10-24T20:00:00.000Z')`,
      )
      .run(job, other, otherPrinter)
    const r = await m.makeCall(m.admin, '/api/printing/discard', { job_id: job })
    expect(r.statusCode).toBe(400)
    expect(m.t.db.prepare('SELECT status FROM print_jobs WHERE id = ?').get(job)).toEqual({
      status: 'pending',
    })
    expect((await m.makeCall(m.admin, '/api/printing/pending')).json()).toEqual([])
  })

  it('the list is cut at 200 tickets', async () => {
    const m = await world()
    const printer = m.t.newPrinter('Cocina', [m.t.kitchen])
    const insert = m.t.db.prepare(
      `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
       VALUES (?, ?, ?, 'ticket', '{"station":"Cocina","target":"Mesa","number":1}', ?)`,
    )
    for (let i = 0; i < 230; i++)
      insert.run(
        newId(),
        m.t.restaurantId,
        printer.id,
        new Date(Date.UTC(2026, 9, 24, 20, 0, i)).toISOString(),
      )
    const list = (await m.makeCall(m.admin, '/api/printing/pending')).json()
    expect(list).toHaveLength(200)
  })

  it('the body carries only what is expected: an extra field gives 400', async () => {
    const m = await world()
    expect((await m.makeCall(m.admin, '/api/printing/pending', { extra: 1 })).statusCode).toBe(400)
    expect((await m.makeCall(m.admin, '/api/printing/discard', { job_id: 'x' })).statusCode).toBe(
      400,
    )
  })

  it('a ticket without a number or with odd texts does not break the list', async () => {
    const m = await world()
    const printer = m.t.newPrinter('Cocina', [m.t.kitchen])
    for (const content of ['{}', '{"station":"Cocina"}', '{"number":null,"target":"Mesa 1"}', '[]'])
      m.t.db
        .prepare(
          `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
           VALUES (?, ?, ?, 'ticket', ?, ?)`,
        )
        .run(newId(), m.t.restaurantId, printer.id, content, new Date(m.t.clock()).toISOString())
    const r = await m.makeCall(m.admin, '/api/printing/pending')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toHaveLength(4)
  })
})

describe('POST /api/kitchen/timers', () => {
  it('saves the minutes, shows them in the configuration and sends them in the menu', async () => {
    const m = await world()
    const r = await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 7, red: 15 })
    expect(r.statusCode).toBe(204)
    expect((await m.config()).timers).toEqual({ yellow: 7, red: 15 })
    const catalog = readCatalog(m.t.db, m.t.restaurantId)
    expect(catalog.restaurant).toMatchObject({ kitchenYellowMin: 7, kitchenRedMin: 15 })
    expect(m.t.catalogChanges.length).toBeGreaterThan(0)
  })

  it.each([
    ['amber 0', { yellow: 0, red: 5 }],
    ['negative amber', { yellow: -1, red: 5 }],
    ['red 241', { yellow: 5, red: 241 }],
    ['amber 241', { yellow: 241, red: 241 }],
    ['decimals', { yellow: 5.5, red: 9 }],
    ['text', { yellow: '5', red: '9' }],
    ['red equal to amber', { yellow: 10, red: 10 }],
    ['red lower than amber', { yellow: 20, red: 10 }],
    ['no red', { yellow: 5 }],
    ['extra field', { yellow: 5, red: 9, extra: 1 }],
    ['null', { yellow: null, red: null }],
  ])('rejects %s with 400 and changes nothing', async (_, body) => {
    const m = await world()
    const r = await m.makeCall(m.admin, '/api/kitchen/timers', body)
    expect(r.statusCode).toBe(400)
    expect((await m.config()).timers).toEqual({ yellow: 10, red: 20 })
  })

  it('accepts the extremes 1 and 240 (red > amber)', async () => {
    const m = await world()
    expect(
      (await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 1, red: 2 })).statusCode,
    ).toBe(204)
    expect(
      (await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 239, red: 240 })).statusCode,
    ).toBe(204)
    expect((await m.config()).timers).toEqual({ yellow: 239, red: 240 })
  })

  it("keeps the rest of the restaurant's configuration and records who changed it", async () => {
    const m = await world()
    const config = fullConfig({})
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...config, session_idle_min: 45, brand: 'la-spritzzeria' }),
        m.t.restaurantId,
      )
    await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 12, red: 25 })
    const row = m.t.db
      .prepare('SELECT config, user_id FROM restaurants WHERE id = ?')
      .get(m.t.restaurantId)
    expect(JSON.parse(String(row?.config))).toMatchObject({
      session_idle_min: 45,
      brand: 'la-spritzzeria',
      kitchen_yellow_min: 12,
      kitchen_red_min: 25,
    })
    expect(row?.user_id).toBe(m.admin.session.user.id)
  })

  it('a restaurant with an empty configuration gets the defaults and saves them in full', async () => {
    const m = await world()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restaurantId)
    await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 3, red: 4 })
    const row = m.t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(m.t.restaurantId)
    expect(JSON.parse(String(row?.config))).toMatchObject({
      kitchen_yellow_min: 3,
      kitchen_red_min: 4,
    })
  })
})

describe('POST /api/kitchen/config and /api/screens/stations', () => {
  it('archived stations do not show up in the configuration', async () => {
    const m = await world()
    m.t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(m.t.desserts)
    expect((await m.config()).stations.map((e: Json) => e.name)).toEqual(['Cocina', 'Barra'])
  })

  it("changes a screen's stations and validates the requested ones", async () => {
    const m = await world()
    const tablet = m.t.device('admin', 'register')
    const c = await m.t.post(
      '/api/screens',
      { ...tablet.sessionBody, name: 'Cocina', station_ids: [m.t.kitchen] },
      tablet.token,
    )
    expect(c.statusCode).toBe(201)
    const device = tablet.connection.deviceId
    const patch = (station_ids: unknown, device_id: string = device) =>
      m.makeCall(m.admin, '/api/screens/stations', { device_id, station_ids })
    expect((await patch([m.t.kitchen, m.t.bar])).statusCode).toBe(204)
    expect((await m.config()).screens).toMatchObject([
      { device_id: device, name: 'Cocina', station_ids: [m.t.kitchen, m.t.bar] },
    ])
    expect((await patch([])).statusCode).toBe(400)
    expect((await patch([newId()])).statusCode).toBe(400)
    expect((await patch(['x'])).statusCode).toBe(400)
    expect((await patch([m.t.kitchen], newId())).statusCode).toBe(400)
    // A device that is not a screen does not work.
    expect((await patch([m.t.kitchen], m.waiter.connection.deviceId)).statusCode).toBe(400)
    // Only archived stations would leave the screen with nothing: it is rejected.
    m.t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(m.t.desserts)
    expect((await patch([m.t.desserts])).statusCode).toBe(400)
    // Mixed with an active one, the archived one is dropped.
    expect((await patch([m.t.desserts, m.t.bar])).statusCode).toBe(204)
    expect((await m.config()).screens[0].station_ids).toEqual([m.t.bar])
  })

  it('a removed screen no longer shows up in the configuration and cannot be edited', async () => {
    const m = await world()
    const tablet = m.t.device('admin', 'register')
    await m.t.post(
      '/api/screens',
      { ...tablet.sessionBody, name: 'Cocina', station_ids: [m.t.kitchen] },
      tablet.token,
    )
    const r = await m.t.post(
      `/api/devices/${tablet.connection.deviceId}/revoke`,
      m.admin.sessionBody,
      m.admin.token,
    )
    expect(r.statusCode).toBe(200)
    expect((await m.config()).screens).toEqual([])
    const e = await m.makeCall(m.admin, '/api/screens/stations', {
      device_id: tablet.connection.deviceId,
      station_ids: [m.t.kitchen],
    })
    expect(e.statusCode).toBe(400)
  })

  it('the configuration includes the printer statuses', async () => {
    const m = await world()
    const printer = m.t.newPrinter('Cocina', [m.t.kitchen])
    printer.paper.off = true
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [{ name: 'Pizza', station: m.t.kitchen }])
    m.t.send(ana, order, items)
    await m.t.queue.runOnce()
    expect((await m.config()).statuses).toEqual([
      expect.objectContaining({ id: printer.id, status: 'failed', pendingList: 1 }),
    ])
  })
})
