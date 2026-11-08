import { fullConfig, newId } from '@pos/core'
import { drawerPulse } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { insertVersioned, SYSTEM } from '../access/records'
import { type Device, setupPrinting } from './printing-setup'
import type { WindowsPrinter } from './windows-print'

// Task 1.13 routes: `/api/printers/windows` (the printers installed in Windows), saving a USB
// printer, `/api/register/cash-drawer` (which printer the drawer is wired to) and
// `/api/register/cash-drawer/test`. All of them require a device with a token and a session with
// `manage_devices`, like the rest of «Cocina e impresoras» and «Caja y pagos».

type Json = Record<string, unknown>

function world(windowsPrinters?: () => Promise<WindowsPrinter[] | null>) {
  const t = setupPrinting({ windowsPrinters })
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const manager = t.device('manager', 'register')
  const waiter = t.device('waiter')
  const makeCall = (e: Device, url: string, extra: Json = {}) =>
    t.post(url, { ...e.sessionBody, ...extra }, e.token)
  const savedConfig = () =>
    fullConfig(
      JSON.parse(
        String(
          t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(t.restaurantId)?.config,
        ),
      ),
    )
  const drawer = (printer_id: unknown, e: Device = admin) =>
    makeCall(e, '/api/register/cash-drawer', { printer_id })
  const testDrawer = (e: Device = admin) => makeCall(e, '/api/register/cash-drawer/test')
  const windows = (e: Device = admin) => makeCall(e, '/api/printers/windows')
  const usbPrinter = (address: string, extra: Json = {}) =>
    makeCall(admin, '/api/printers', {
      printer: {
        name: 'Caja',
        connection: 'usb',
        address,
        port: 9100,
        width: 80,
        code_page: 'pc850',
        fallback_id: null,
        station_ids: [],
        active: true,
        ...extra,
      },
    })
  return {
    t,
    admin,
    cashier,
    manager,
    waiter,
    makeCall,
    savedConfig,
    drawer,
    testDrawer,
    windows,
    usbPrinter,
  }
}

type World = ReturnType<typeof world>

describe('permissions: the drawer and Windows routes require manage_devices', () => {
  const routes: [string, Json][] = [
    ['/api/printers/windows', {}],
    ['/api/register/cash-drawer', { printer_id: null }],
    ['/api/register/cash-drawer/test', {}],
  ]

  it.each(routes)('%s: without a token or with a made-up one, 401', async (url, body) => {
    const m = world()
    expect((await m.t.post(url, { ...m.admin.sessionBody, ...body })).statusCode).toBe(401)
    expect((await m.t.post(url, 'text')).statusCode).toBe(401)
    expect((await m.t.post(url, { ...m.admin.sessionBody, ...body }, 'inventado')).statusCode).toBe(
      401,
    )
  })

  it.each(routes)('%s: a made-up session, 401; without the session, 400', async (url, body) => {
    const m = world()
    const session = { session_id: '01JB0000000000000000000000', secret: 'inventado' }
    expect((await m.t.post(url, { ...session, ...body }, m.admin.token)).statusCode).toBe(401)
    expect((await m.t.post(url, body, m.admin.token)).statusCode).toBe(400)
  })

  it.each(routes)(
    '%s: cashier, manager and waiter get 403 and nothing happens',
    async (url, body) => {
      const m = world(async () => [{ name: 'POS-80', port: 'USB001', driver: null }])
      const p = m.t.newPrinter('Caja', [])
      await m.drawer(p.id)
      const version = m.t.catalogChanges.length
      for (const who of ['cashier', 'manager', 'waiter'] as const) {
        const r = await m.makeCall(m[who], url, body)
        expect(r.statusCode, `${url} · ${who}`).toBe(403)
      }
      expect(m.t.catalogChanges).toHaveLength(version)
      expect(m.savedConfig().cash_drawer_printer_id).toBe(p.id)
      expect(p.paper.attempts).toBe(0)
    },
  )
})

describe('POST /api/printers/windows', () => {
  it('off Windows: not available, so the screen asks to type the name', async () => {
    const m = world()
    const r = await m.windows()
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ available: false, printers: [] })
  })

  it('on Windows: the installed printers', async () => {
    const printers = [
      { name: 'POS-80', port: 'USB001', driver: 'POS-80C' },
      { name: 'Microsoft Print to PDF', port: 'PORTPROMPT:', driver: null },
    ]
    const m = world(async () => printers)
    expect((await m.windows()).json()).toEqual({ available: true, printers })
  })

  it('on Windows with no printers installed: available and empty', async () => {
    const m = world(async () => [])
    expect((await m.windows()).json()).toEqual({ available: true, printers: [] })
  })

  it('if Windows does not answer: not available (the name is typed), not an error', async () => {
    const m = world(async () => {
      throw new Error('Get-Printer failed')
    })
    const r = await m.windows()
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ available: false, printers: [] })
  })
})

describe('POST /api/printers with a USB printer', () => {
  it('saves the Windows name as the address and no port', async () => {
    const m = world()
    const r = await m.usbPrinter('POS-80 (copia 1) ñ')
    expect(r.statusCode).toBe(200)
    const { id } = r.json() as { id: string }
    const row = m.t.db
      .prepare('SELECT connection, address, port FROM printers WHERE id = ?')
      .get(id)
    expect(row).toEqual({ connection: 'usb', address: 'POS-80 (copia 1) ñ', port: null })
    const config = (await m.makeCall(m.admin, '/api/kitchen/config')).json() as {
      printers: Json[]
    }
    expect(config.printers).toContainEqual(
      expect.objectContaining({ id, connection: 'usb', address: 'POS-80 (copia 1) ñ', port: null }),
    )
  })

  it('a printer shared by another PC (\\\\PC\\Impresora) is rejected: it must be USB on this PC', async () => {
    const m = world()
    const r = await m.usbPrinter('\\\\CAJA\\POS-80')
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      message: 'Elige la impresora conectada por USB a este PC: no una compartida por otro equipo',
    })
  })

  it.each([
    ['a line break', 'POS-80\nOtra'],
    ['a NUL', 'POS\u000080'],
    ['a tab', 'POS\t80'],
    ['over 220 characters', 'x'.repeat(221)],
  ])('rejects a name with %s', async (_, address) => {
    const m = world()
    const r = await m.usbPrinter(address)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      message: 'Escribe el nombre de la impresora como aparece en Windows',
    })
  })

  it('an empty name is rejected', async () => {
    const m = world()
    expect((await m.usbPrinter('   ')).statusCode).toBe(400)
  })

  it('a network printer still needs a private IP', async () => {
    const m = world()
    const r = await m.usbPrinter('POS-80', { connection: 'network' })
    expect(r.statusCode).toBe(400)
  })
})

describe('POST /api/register/cash-drawer', () => {
  it('by default there is no drawer', () => {
    expect(world().savedConfig().cash_drawer_printer_id).toBeNull()
  })

  it('choosing an active printer: 204, stores it under who chose it and notifies', async () => {
    const m = world()
    const p = m.t.newPrinter('Caja', [])
    const r = await m.drawer(p.id)
    expect(r.statusCode).toBe(204)
    expect(m.savedConfig().cash_drawer_printer_id).toBe(p.id)
    expect(m.t.catalogChanges).toHaveLength(1)
    expect(
      m.t.db.prepare('SELECT user_id FROM restaurants WHERE id = ?').get(m.t.restaurantId),
    ).toEqual({ user_id: m.t.people.admin.userId })
    // The same again changes nothing.
    await m.drawer(p.id)
    expect(m.t.catalogChanges).toHaveLength(1)
  })

  it('null removes it and leaves the pre-bill printer alone', async () => {
    const m = world()
    const p = m.t.newPrinter('Caja', [])
    await m.makeCall(m.admin, '/api/register/pre-bill', { printer_id: p.id })
    await m.drawer(p.id)
    expect((await m.drawer(null)).statusCode).toBe(204)
    expect(m.savedConfig()).toMatchObject({
      cash_drawer_printer_id: null,
      pre_bill_printer_id: p.id,
    })
  })

  it.each<[string, (m: World) => string]>([
    ['archived', (m) => m.t.newPrinter('Vieja', [], { active: 0 }).id],
    ['nonexistent', () => newId()],
    [
      'from another restaurant',
      (m) => {
        const other = newId()
        const now = new Date(m.t.clock()).toISOString()
        m.t.db
          .prepare(
            `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
             VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
          )
          .run(other, other, now, now)
        m.t.db
          .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
          .run(other)
        return insertVersioned(
          m.t.db,
          'printers',
          other,
          { name: 'Ajena', connection: 'network', address: '10.9.9.9', port: 9100, width: 80 },
          SYSTEM,
          now,
        )
      },
    ],
  ])('a printer %s is rejected with 400', async (_, printer) => {
    const m = world()
    const r = await m.drawer(printer(m))
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'Esa impresora no existe o está archivada' })
    expect(m.savedConfig().cash_drawer_printer_id).toBeNull()
  })

  it.each([['abc'], [''], [7], [{}], [[newId()]]])(
    'rejects printer_id = %j with 400',
    async (v) => {
      const m = world()
      expect((await m.drawer(v)).statusCode).toBe(400)
    },
  )

  it('without printer_id or with extra fields, 400', async () => {
    const m = world()
    expect((await m.makeCall(m.admin, '/api/register/cash-drawer', {})).statusCode).toBe(400)
    expect(
      (await m.makeCall(m.admin, '/api/register/cash-drawer', { printer_id: null, x: 1 }))
        .statusCode,
    ).toBe(400)
  })

  it('«Cocina e impresoras» returns the chosen drawer printer', async () => {
    const m = world()
    const r0 = await m.makeCall(m.admin, '/api/kitchen/config')
    expect(r0.json()).toMatchObject({ cash_drawer_printer_id: null })
    const p = m.t.newPrinter('Caja', [])
    await m.drawer(p.id)
    const r = await m.makeCall(m.admin, '/api/kitchen/config')
    expect(r.json()).toMatchObject({ cash_drawer_printer_id: p.id })
  })
})

describe('POST /api/register/cash-drawer/test', () => {
  it('opens the drawer now: the pulse reaches its printer and nothing is queued', async () => {
    const m = world()
    const p = m.t.newPrinter('Caja', [])
    await m.drawer(p.id)
    const r = await m.testDrawer()
    expect(r.statusCode).toBe(204)
    expect(p.paper.received.map((b) => [...b])).toEqual([[...drawerPulse()]])
    expect(m.t.jobs()).toEqual([])
  })

  it('without a drawer chosen, 400 saying to choose it first', async () => {
    const m = world()
    const r = await m.testDrawer()
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      message: 'Elige primero a qué impresora está conectado el cajón monedero',
    })
  })

  it('with its printer archived, it is as if there were none', async () => {
    const m = world()
    const p = m.t.newPrinter('Caja', [])
    await m.drawer(p.id)
    m.t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(p.id)
    expect((await m.testDrawer()).statusCode).toBe(400)
    expect(p.paper.attempts).toBe(0)
  })

  it('with the printer off it says why, tries once and leaves nothing pending', async () => {
    const m = world()
    const p = m.t.newPrinter('Caja', [])
    await m.drawer(p.id)
    p.paper.off = true
    const r = await m.testDrawer()
    expect(r.statusCode).toBe(502)
    expect(r.json()).toEqual({
      error: 'printer_failed',
      message: 'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
    })
    expect(p.paper.attempts).toBe(1)
    expect(m.t.jobs()).toEqual([])
  })
})
