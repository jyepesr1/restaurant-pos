import { fullConfig, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertVersioned, SYSTEM } from '../access/records'
import { readCatalog } from '../catalog'
import { type Device, setupPrinting } from './printing-setup'

// The routes of task 1.6: `/api/register/pre-bill`, `/api/register/config`,
// `/api/register/payment-methods`, `/api/register/tip` and `/api/card-terminals`, and what the
// menu says about checkout. All of them require a device with a token and a session with
// `manage_devices`.

type Json = Record<string, unknown>

function world() {
  const t = setupPrinting()
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const manager = t.device('manager', 'register')
  const waiter = t.device('waiter')
  const makeCall = (e: Device, url: string, extra: Json = {}) =>
    t.post(url, { ...e.sessionBody, ...extra }, e.token)
  const catalog = () => readCatalog(t.db, t.restaurantId)
  const savedConfig = () =>
    fullConfig(
      JSON.parse(
        String(
          t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(t.restaurantId)?.config,
        ),
      ),
    )
  const preBill = (printer_id: unknown, e: Device = admin) =>
    makeCall(e, '/api/register/pre-bill', { printer_id })
  const methods = (m: unknown, e: Device = admin) =>
    makeCall(e, '/api/register/payment-methods', { methods: m })
  const tip = (points: unknown, e: Device = admin) => makeCall(e, '/api/register/tip', { points })
  const cardTerminal = (d: Json, e: Device = admin) =>
    makeCall(e, '/api/card-terminals', { cardTerminal: d })
  const settings = async (e: Device = admin) =>
    (await makeCall(e, '/api/register/config')).json() as {
      payment_methods: string[]
      suggested_tip: number
      cardTerminals: { id: string; name: string; provider: string; active: boolean }[]
    }
  /** Another restaurant in the same database, with its own printer and card terminal. */
  const outsider = () => {
    const other = newId()
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(other, other, new Date(t.clock()).toISOString(), new Date(t.clock()).toISOString())
    t.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    const printer = insertVersioned(
      t.db,
      'printers',
      other,
      { name: 'Barra ajena', connection: 'network', address: '10.9.9.9', port: 9100, width: 80 },
      SYSTEM,
      new Date(t.clock()).toISOString(),
    )
    const cardTerminalId = insertVersioned(
      t.db,
      'card_terminals',
      other,
      { name: 'Bold ajeno', provider: 'bold' },
      SYSTEM,
      new Date(t.clock()).toISOString(),
    )
    return { other, printer, cardTerminalId }
  }
  return {
    t,
    admin,
    cashier,
    manager,
    waiter,
    makeCall,
    catalog,
    savedConfig,
    preBill,
    methods,
    tip,
    cardTerminal,
    settings,
    outsider,
  }
}

type World = ReturnType<typeof world>

describe('permissions: the five routes require manage_devices', () => {
  const routes: [string, (m: World, e: Device) => Promise<{ statusCode: number }>][] = [
    ['/api/register/pre-bill', (m, e) => m.preBill(null, e)],
    ['/api/register/config', (m, e) => m.makeCall(e, '/api/register/config')],
    ['/api/register/payment-methods', (m, e) => m.methods(['cash', 'nequi'], e)],
    ['/api/register/tip', (m, e) => m.tip(500, e)],
    [
      '/api/card-terminals',
      (m, e) => m.cardTerminal({ name: 'Nuevo', provider: 'other', active: true }, e),
    ],
  ]
  /** The rest of the body each route expects, to test the session with valid data. */
  const BODY: Record<string, Json> = {
    '/api/register/pre-bill': { printer_id: null },
    '/api/register/config': {},
    '/api/register/payment-methods': { methods: ['cash'] },
    '/api/register/tip': { points: 500 },
    '/api/register/custom-methods': { method: { name: 'Sodexo', active: true } },
    '/api/card-terminals': { cardTerminal: { name: 'Nuevo', provider: 'other', active: true } },
  }

  it.each(routes)('%s: without a token replies 401, even if the body is garbage', async (url) => {
    const m = world()
    for (const body of [{}, 'text', [1], { methods: 1 }]) {
      const r = await m.t.post(url, body)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_token' })
    }
  })

  it.each(routes)('%s: a made-up token, 401', async (url) => {
    const m = world()
    const r = await m.t.post(url, { ...m.admin.sessionBody, ...BODY[url] }, 'inventado')
    expect(r.statusCode).toBe(401)
  })

  it.each(routes)('%s: made-up session or one with another secret, 401', async (url) => {
    const m = world()
    for (const session of [
      { session_id: '01JB0000000000000000000000', secret: 'inventado' },
      { session_id: m.admin.sessionBody.session_id, secret: 'otro-secreto' },
    ]) {
      const r = await m.t.post(url, { ...session, ...BODY[url] }, m.admin.token)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_session' })
    }
  })

  it.each(routes)('%s: another device session does not work', async (url, makeCall) => {
    const m = world()
    const r = await m.t.post(url, { ...m.admin.sessionBody, ...BODY[url] }, m.waiter.token)
    expect(r.statusCode).toBe(401)
    expect(makeCall).toBeTypeOf('function')
  })

  it.each(routes)('%s: without the session data, 400', async (url) => {
    const m = world()
    const {
      session_id: _s,
      secret: _x,
      ...withoutSession
    } = { ...m.admin.sessionBody, ...BODY[url] }
    const r = await m.t.post(url, withoutSession, m.admin.token)
    expect(r.statusCode).toBe(400)
  })

  it.each(routes)(
    '%s: cashier, manager and waiter get 403 and change nothing',
    async (url, makeCall) => {
      for (const who of ['cashier', 'manager', 'waiter'] as const) {
        const m = world()
        const before = m.catalog().version
        const r = await makeCall(m, m[who])
        expect(r.statusCode, `${url} · ${who}`).toBe(403)
        expect(m.catalog().version).toBe(before)
        expect(m.t.catalogChanges).toEqual([])
        expect(m.savedConfig().payment_methods).toEqual(fullConfig().payment_methods)
      }
    },
  )

  it.each(routes)('%s: a closed session, 401', async (url, makeCall) => {
    const m = world()
    await m.t.post('/api/sessions/close', m.admin.sessionBody, m.admin.token)
    expect((await makeCall(m, m.admin)).statusCode, url).toBe(401)
  })

  it('a removed device loses access to the register routes', async () => {
    const m = world()
    await m.t.post(
      `/api/devices/${m.waiter.connection.deviceId}/revoke`,
      m.admin.sessionBody,
      m.admin.token,
    )
    expect((await m.methods(['cash'], m.waiter)).statusCode).toBe(401)
  })
})

describe('POST /api/register/pre-bill', () => {
  const newPrinter = (m: World, extra: Record<string, string | number> = {}) =>
    m.t.newPrinter('Caja', [m.t.kitchen], extra)

  it('by default there is no pre-bill printer and the menu says it does not print', () => {
    const m = world()
    expect(m.savedConfig().pre_bill_printer_id).toBeNull()
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
  })

  it('choosing an active printer: 204, stores it, notifies and the menu says it prints', async () => {
    const m = world()
    const { id } = newPrinter(m)
    const before = m.catalog().version
    const r = await m.preBill(id)
    expect(r.statusCode).toBe(204)
    expect(r.body).toBe('')
    expect(m.savedConfig().pre_bill_printer_id).toBe(id)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(true)
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.catalogChanges).toEqual([m.catalog().version])
  })

  it('the change is recorded under who made it', async () => {
    const m = world()
    await m.preBill(newPrinter(m).id)
    const row = m.t.db
      .prepare('SELECT user_id, device_id FROM restaurants WHERE id = ?')
      .get(m.t.restaurantId)
    expect(row).toEqual({
      user_id: m.t.people.admin.userId,
      device_id: m.admin.connection.deviceId,
    })
  })

  it('removing it (null) leaves it without a printer and repeating it does not bump the version', async () => {
    const m = world()
    await m.preBill(newPrinter(m).id)
    expect((await m.preBill(null)).statusCode).toBe(204)
    expect(m.savedConfig().pre_bill_printer_id).toBeNull()
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
    const v = m.catalog().version
    expect((await m.preBill(null)).statusCode).toBe(204)
    expect(m.catalog().version).toBe(v)
  })

  it('choosing the same printer again does not bump the version or notify', async () => {
    const m = world()
    const { id } = newPrinter(m)
    await m.preBill(id)
    const v = m.catalog().version
    const alerts = m.t.catalogChanges.length
    await m.preBill(id)
    expect(m.catalog().version).toBe(v)
    expect(m.t.catalogChanges).toHaveLength(alerts)
  })

  it('an archived printer is rejected with 400', async () => {
    const m = world()
    const { id } = newPrinter(m, { active: 0 })
    const r = await m.preBill(id)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      error: 'invalid_data',
      message: 'Esa impresora no existe o está archivada',
    })
    expect(m.savedConfig().pre_bill_printer_id).toBeNull()
  })

  it('a printer that does not exist is rejected with 400', async () => {
    const m = world()
    expect((await m.preBill(newId())).statusCode).toBe(400)
    expect(m.savedConfig().pre_bill_printer_id).toBeNull()
  })

  it('the printer of ANOTHER restaurant is rejected with 400', async () => {
    const m = world()
    const { printer } = m.outsider()
    const r = await m.preBill(printer)
    expect(r.statusCode).toBe(400)
    expect(m.savedConfig().pre_bill_printer_id).toBeNull()
  })

  it.each([
    ['short text', 'abc'],
    ['empty string', ''],
    ['number', 7],
    ['object', {}],
    ['array', [newId()]],
    ['27-character id', `${newId()}X`],
  ])('rejects printer_id = %s with 400', async (_, value) => {
    const m = world()
    expect((await m.preBill(value)).statusCode).toBe(400)
  })

  it('without printer_id and with extra fields, 400', async () => {
    const m = world()
    expect((await m.makeCall(m.admin, '/api/register/pre-bill', {})).statusCode).toBe(400)
    expect(
      (await m.makeCall(m.admin, '/api/register/pre-bill', { printer_id: null, other: 1 }))
        .statusCode,
    ).toBe(400)
  })

  it('archiving the chosen printer turns printing off; reactivating it turns it on', async () => {
    const m = world()
    const { id } = newPrinter(m)
    await m.preBill(id)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(true)
    m.t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(id)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
    // The choice is not lost: it stays stored in the config.
    expect(m.savedConfig().pre_bill_printer_id).toBe(id)
    m.t.db.prepare('UPDATE printers SET active = 1 WHERE id = ?').run(id)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(true)
  })

  it('the «Cocina e impresoras» screen returns the chosen pre-bill printer', async () => {
    const m = world()
    const { id } = newPrinter(m)
    await m.preBill(id)
    const r = await m.makeCall(m.admin, '/api/kitchen/config')
    expect(r.json()).toMatchObject({ pre_bill_printer_id: id })
  })
})

describe('catalog: restaurant.checkout and cardTerminals', () => {
  it('returns the checkout defaults', () => {
    const { catalog } = world()
    expect(catalog().restaurant.checkout).toEqual({
      paymentMethods: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
      customMethods: [],
      archivedCustomMethods: [],
      suggestedTip: 1000,
      roundingMode: 'half_up',
      cashRounding: 100,
      cashRoundingMode: 'nearest_half_down',
      varianceThreshold: 1000,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      printsPreBill: false,
    })
    expect(catalog().cardTerminals).toEqual([])
  })

  it('reflects the stored restaurant config', () => {
    const m = world()
    m.t.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run(
      JSON.stringify({
        payment_methods: ['nequi', 'cash'],
        suggested_tip: 700,
        rounding_mode: 'half_even',
        cash_rounding: 50,
        cash_rounding_mode: 'up',
      }),
      m.t.restaurantId,
    )
    expect(m.catalog().restaurant.checkout).toMatchObject({
      paymentMethods: ['nequi', 'cash'],
      suggestedTip: 700,
      roundingMode: 'half_even',
      cashRounding: 50,
      cashRoundingMode: 'up',
    })
  })

  it('an old config, without the new fields, takes the defaults', () => {
    const m = world()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.paymentMethods).toEqual(fullConfig().payment_methods)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
  })

  it('printsPreBill is false if the chosen printer belongs to another restaurant', () => {
    const m = world()
    const { printer } = m.outsider()
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
  })

  it('printsPreBill is false if the chosen printer no longer exists', () => {
    const m = world()
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: newId() }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
  })

  it('card terminals: only the active ones of this restaurant, by name', async () => {
    const m = world()
    const outsider = m.outsider()
    await m.cardTerminal({ name: 'Bold 2', provider: 'bold', active: true })
    await m.cardTerminal({ name: 'Bold 1', provider: 'bold', active: true })
    const archived = (
      await m.cardTerminal({ name: 'Viejo', provider: 'redeban', active: true })
    ).json() as { id: string }
    await m.cardTerminal({ id: archived.id, name: 'Viejo', provider: 'redeban', active: false })
    expect(m.catalog().cardTerminals?.map((d) => d.name)).toEqual(['Bold 1', 'Bold 2'])
    expect(m.catalog().cardTerminals?.map((d) => d.id)).not.toContain(outsider.cardTerminalId)
    // The catalog gives id, name and provider: those of the same provider share a single close, so
    // at checkout the provider is chosen only if there are several.
    for (const d of m.catalog().cardTerminals ?? [])
      expect(Object.keys(d).sort()).toEqual(['id', 'name', 'provider'])
  })
})

describe('POST /api/register/payment-methods', () => {
  it('defaults: cash, card, Nequi, Daviplata, Bre-B and transfer, in that order', async () => {
    const m = world()
    expect((await m.settings()).payment_methods).toEqual([
      'cash',
      'card',
      'nequi',
      'daviplata',
      'breb',
      'transfer',
    ])
  })

  it('stores the methods in the chosen order, notifies and the menu returns them', async () => {
    const m = world()
    const before = m.catalog().version
    const r = await m.methods(['nequi', 'cash', 'card'])
    expect(r.statusCode).toBe(204)
    expect((await m.settings()).payment_methods).toEqual(['nequi', 'cash', 'card'])
    expect(m.catalog().restaurant.checkout?.paymentMethods).toEqual(['nequi', 'cash', 'card'])
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.catalogChanges).toEqual([m.catalog().version])
  })

  it('cash alone is valid; the voucher can be added', async () => {
    const m = world()
    expect((await m.methods(['cash'])).statusCode).toBe(204)
    expect((await m.methods(['cash', 'voucher'])).statusCode).toBe(204)
    expect(m.savedConfig().payment_methods).toEqual(['cash', 'voucher'])
  })

  it('duplicates are removed and the first one stays', async () => {
    const m = world()
    expect((await m.methods(['card', 'cash', 'card', 'cash'])).statusCode).toBe(204)
    expect(m.savedConfig().payment_methods).toEqual(['card', 'cash'])
  })

  it('without cash it is rejected with 400 and the message explains it', async () => {
    const m = world()
    const before = m.catalog().version
    const r = await m.methods(['card', 'nequi'])
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'El efectivo siempre se recibe' })
    expect(m.savedConfig().payment_methods).toEqual(fullConfig().payment_methods)
    expect(m.catalog().version).toBe(before)
  })

  it.each([
    ['empty list', []],
    ['a method that does not exist', ['cash', 'cheque']],
    ['uppercase', ['Efectivo']],
    ['not a list', 'cash'],
    ['null', null],
    ['non-text element', ['cash', 3]],
    ['more than ten', Array(11).fill('cash')],
  ])('rejects methods = %s with 400', async (_, value) => {
    const m = world()
    expect((await m.methods(value)).statusCode).toBe(400)
    expect(m.savedConfig().payment_methods).toEqual(fullConfig().payment_methods)
  })

  it('without methods and with extra fields, 400', async () => {
    const m = world()
    expect((await m.makeCall(m.admin, '/api/register/payment-methods', {})).statusCode).toBe(400)
    expect(
      (await m.makeCall(m.admin, '/api/register/payment-methods', { methods: ['cash'], x: 1 }))
        .statusCode,
    ).toBe(400)
  })

  it('repeating the same list does not bump the version or notify', async () => {
    const m = world()
    await m.methods(['cash', 'card'])
    const v = m.catalog().version
    const alerts = m.t.catalogChanges.length
    expect((await m.methods(['cash', 'card'])).statusCode).toBe(204)
    expect(m.catalog().version).toBe(v)
    expect(m.t.catalogChanges).toHaveLength(alerts)
  })

  it('changing only the order is a change', async () => {
    const m = world()
    await m.methods(['cash', 'card'])
    const v = m.catalog().version
    await m.methods(['card', 'cash'])
    expect(m.catalog().version).toBeGreaterThan(v)
  })

  it('does not touch the rest of the restaurant config', async () => {
    const m = world()
    const before = { ...m.savedConfig(), payment_methods: undefined }
    await m.methods(['cash', 'nequi'])
    expect({ ...m.savedConfig(), payment_methods: undefined }).toEqual(before)
  })
})

describe('POST /api/register/tip', () => {
  it.each([0, 1, 500, 750, 1000])('stores %i basis points', async (points) => {
    const m = world()
    expect((await m.tip(points)).statusCode).toBe(204)
    expect(m.savedConfig().suggested_tip).toBe(points)
    expect(m.catalog().restaurant.checkout?.suggestedTip).toBe(points)
    expect((await m.settings()).suggested_tip).toBe(points)
  })

  it.each([
    ['negative', -1],
    ['above the legal cap of 10 %', 1001],
    ['with decimals', 10.5],
    ['text', '1000'],
    ['null', null],
    ['NaN as text', 'NaN'],
  ])('rejects %s with 400 and the message explains the range', async (_, points) => {
    const m = world()
    const r = await m.tip(points)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'La propina sugerida va de 0 % a 10 %' })
    expect(m.savedConfig().suggested_tip).toBe(1000)
  })

  it('the same value does not bump the version', async () => {
    const m = world()
    const v = m.catalog().version
    await m.tip(1000)
    expect(m.catalog().version).toBe(v)
  })
})

describe('POST /api/register/config', () => {
  it('returns the methods, the suggested tip and the card terminals (active first)', async () => {
    const m = world()
    const a = (await m.cardTerminal({ name: 'Zeta', provider: 'other', active: true })).json() as {
      id: string
    }
    await m.cardTerminal({ name: 'Bold 1', provider: 'bold', active: true })
    await m.cardTerminal({ id: a.id, name: 'Zeta', provider: 'other', active: false })
    const r = await m.settings()
    expect(r.payment_methods).toEqual(fullConfig().payment_methods)
    expect(r.suggested_tip).toBe(1000)
    expect(r.cardTerminals.map((d) => [d.name, d.provider, d.active])).toEqual([
      ['Bold 1', 'bold', true],
      ['Zeta', 'other', false],
    ])
  })

  it('does not show card terminals of another restaurant', async () => {
    const m = world()
    m.outsider()
    expect((await m.settings()).cardTerminals).toEqual([])
  })

  it('with extra fields, 400', async () => {
    const m = world()
    expect((await m.makeCall(m.admin, '/api/register/config', { x: 1 })).statusCode).toBe(400)
  })
})

describe('POST /api/card-terminals', () => {
  const bold = { name: 'Bold 1', provider: 'bold', active: true }

  it('creates a card terminal: returns its id and the list, is recorded under who created it and bumps the version', async () => {
    const m = world()
    const before = m.catalog().version
    const r = await m.cardTerminal(bold)
    expect(r.statusCode).toBe(200)
    const body = r.json() as { id: string; cardTerminals: { id: string; name: string }[] }
    expect(body.cardTerminals).toEqual([
      { id: body.id, name: 'Bold 1', provider: 'bold', active: true },
    ])
    expect(m.t.db.prepare('SELECT * FROM card_terminals WHERE id = ?').get(body.id)).toMatchObject({
      user_id: m.t.people.admin.userId,
      device_id: m.admin.connection.deviceId,
      active: 1,
    })
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.catalogChanges).toEqual([m.catalog().version])
    expect(m.catalog().cardTerminals).toEqual([{ id: body.id, name: 'Bold 1', provider: 'bold' }])
  })

  it.each(['bold', 'redeban', 'credibanco', 'other'])('accepts provider %s', async (provider) => {
    const m = world()
    expect((await m.cardTerminal({ ...bold, provider })).statusCode).toBe(200)
  })

  it('the name is trimmed, and 60 characters pass but 61 do not', async () => {
    const m = world()
    const r = await m.cardTerminal({ ...bold, name: '   Bold   ' })
    expect((r.json() as { cardTerminals: { name: string }[] }).cardTerminals[0]?.name).toBe('Bold')
    expect((await m.cardTerminal({ ...bold, name: 'x'.repeat(60) })).statusCode).toBe(200)
    expect((await m.cardTerminal({ ...bold, name: 'y'.repeat(61) })).statusCode).toBe(400)
  })

  it.each([
    ['empty name', { name: '' }],
    ['name of spaces', { name: '    ' }],
    ['name that is not text', { name: 5 }],
    ['no name', { name: undefined }],
    ['unknown provider', { provider: 'visa' }],
    ['uppercase provider', { provider: 'BOLD' }],
    ['no provider', { provider: undefined }],
    ['active as text', { active: 'true' }],
    ['no active', { active: undefined }],
    ['id that is not a ULID', { id: 'abc' }],
    ['extra field', { color: 'rojo' }],
  ])('rejects %s with 400 and creates nothing', async (_, change) => {
    const m = world()
    const r = await m.cardTerminal({ ...bold, ...change })
    expect(r.statusCode).toBe(400)
    expect((await m.settings()).cardTerminals).toEqual([])
  })

  it('without the cardTerminal object, 400', async () => {
    const m = world()
    expect((await m.makeCall(m.admin, '/api/card-terminals', {})).statusCode).toBe(400)
    expect(
      (await m.makeCall(m.admin, '/api/card-terminals', { cardTerminal: null })).statusCode,
    ).toBe(400)
  })

  it('duplicate name among active ones: 400, regardless of case or extra accents', async () => {
    const m = world()
    await m.cardTerminal(bold)
    for (const name of ['Bold 1', 'bold 1', 'BOLD 1']) {
      const r = await m.cardTerminal({ ...bold, name })
      expect(r.statusCode, name).toBe(400)
      expect(r.json()).toMatchObject({ message: 'Ya hay un datáfono con ese nombre' })
    }
    expect((await m.settings()).cardTerminals).toHaveLength(1)
  })

  it('two different names coexist, and the same name in another restaurant does not count', async () => {
    const m = world()
    m.outsider()
    expect((await m.cardTerminal({ ...bold, name: 'Bold bar' })).statusCode).toBe(200)
    expect((await m.cardTerminal({ ...bold, name: 'Bold ajeno' })).statusCode).toBe(200)
    expect((await m.settings()).cardTerminals).toHaveLength(2)
  })

  it('renaming and saving the same name of the card terminal itself does not count as duplicate', async () => {
    const m = world()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    expect((await m.cardTerminal({ ...bold, id })).statusCode).toBe(200)
    const r = await m.cardTerminal({ ...bold, id, name: 'Bold barra' })
    expect(r.statusCode).toBe(200)
    expect((await m.settings()).cardTerminals.map((d) => d.name)).toEqual(['Bold barra'])
  })

  it('renaming to a name another active one already has, 400', async () => {
    const m = world()
    await m.cardTerminal(bold)
    const { id } = (await m.cardTerminal({ ...bold, name: 'Bold 2' })).json() as { id: string }
    const r = await m.cardTerminal({ ...bold, id, name: 'bold 1' })
    expect(r.statusCode).toBe(400)
    expect((await m.settings()).cardTerminals.map((d) => d.name).sort()).toEqual([
      'Bold 1',
      'Bold 2',
    ])
  })

  it('editing bumps the version of the card terminal and of the counter; the id and creation date do not change', async () => {
    const m = world()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    const before = m.t.db.prepare('SELECT * FROM card_terminals WHERE id = ?').get(id)
    m.t.advance(5000)
    await m.cardTerminal({ ...bold, id, name: 'Bold terraza', provider: 'redeban' })
    const after = m.t.db.prepare('SELECT * FROM card_terminals WHERE id = ?').get(id)
    expect(after).toMatchObject({ name: 'Bold terraza', provider: 'redeban', id })
    expect(Number(after?.version)).toBeGreaterThan(Number(before?.version))
    expect(after?.created_at).toBe(before?.created_at)
    expect(after?.updated_at).not.toBe(before?.updated_at)
  })

  it('archiving: active false removes it from the menu but it stays in the register list, and it is not deleted', async () => {
    const m = world()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    const r = await m.cardTerminal({ ...bold, id, active: false })
    expect(r.statusCode).toBe(200)
    expect((await m.settings()).cardTerminals).toEqual([
      { id, name: 'Bold 1', provider: 'bold', active: false },
    ])
    expect(m.catalog().cardTerminals).toEqual([])
    expect(Number(m.t.db.prepare('SELECT count(*) AS n FROM card_terminals').get()?.n)).toBe(1)
  })

  it('reusing an archived one: active true brings it back to the menu', async () => {
    const m = world()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    await m.cardTerminal({ ...bold, id, active: false })
    const r = await m.cardTerminal({ ...bold, id, active: true })
    expect(r.statusCode).toBe(200)
    expect(m.catalog().cardTerminals).toEqual([{ id, name: 'Bold 1', provider: 'bold' }])
  })

  it('an archived one does not block the name: another one with the same name can be created', async () => {
    const m = world()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    await m.cardTerminal({ ...bold, id, active: false })
    expect((await m.cardTerminal(bold)).statusCode).toBe(200)
  })

  it('but reactivating the archived one when another active one has that name, 400', async () => {
    const m = world()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    await m.cardTerminal({ ...bold, id, active: false })
    await m.cardTerminal(bold)
    const r = await m.cardTerminal({ ...bold, id, active: true })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'Ya hay un datáfono con ese nombre' })
    expect((await m.settings()).cardTerminals.filter((d) => d.active)).toHaveLength(1)
  })

  it('renaming an archived one to a name in use is allowed while it stays archived', async () => {
    const m = world()
    await m.cardTerminal(bold)
    const { id } = (await m.cardTerminal({ ...bold, name: 'Bold 2' })).json() as { id: string }
    await m.cardTerminal({ ...bold, name: 'Bold 2', id, active: false })
    expect((await m.cardTerminal({ ...bold, id, name: 'Bold 1', active: false })).statusCode).toBe(
      200,
    )
  })

  it('an id that does not exist, 400 and creates nothing', async () => {
    const m = world()
    const r = await m.cardTerminal({ ...bold, id: newId() })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'Ese datáfono no existe' })
    expect((await m.settings()).cardTerminals).toEqual([])
  })

  it('the id of a card terminal of ANOTHER restaurant, 400, and the other one stays intact', async () => {
    const m = world()
    const outsider = m.outsider()
    const before = m.t.db
      .prepare('SELECT * FROM card_terminals WHERE id = ?')
      .get(outsider.cardTerminalId)
    const r = await m.cardTerminal({ ...bold, id: outsider.cardTerminalId, name: 'Robado' })
    expect(r.statusCode).toBe(400)
    expect(
      m.t.db.prepare('SELECT * FROM card_terminals WHERE id = ?').get(outsider.cardTerminalId),
    ).toEqual(before)
    expect((await m.settings()).cardTerminals).toEqual([])
  })

  it('a rejection does not bump the catalog version or notify the devices', async () => {
    const m = world()
    await m.cardTerminal(bold)
    const v = m.catalog().version
    const alerts = m.t.catalogChanges.length
    await m.cardTerminal(bold)
    await m.cardTerminal({ ...bold, id: newId() })
    expect(m.catalog().version).toBe(v)
    expect(m.t.catalogChanges).toHaveLength(alerts)
  })

  it('two identical requests at once do not leave two card terminals with the same name', async () => {
    const m = world()
    const [a, b] = await Promise.all([m.cardTerminal(bold), m.cardTerminal(bold)])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400])
    expect((await m.settings()).cardTerminals).toHaveLength(1)
  })
})

describe('POST /api/register/custom-methods', () => {
  type ApiResponse = { id: string; custom_methods: { id: string; name: string; active: boolean }[] }
  const save = (m: World, method: Json, e: Device = m.admin) =>
    m.makeCall(e, '/api/register/custom-methods', { method })

  it('creates a method: returns its id and the list, it stays in the config and in the menu', async () => {
    const m = world()
    const before = m.catalog().version
    const r = await save(m, { name: 'Sodexo', active: true })
    expect(r.statusCode).toBe(200)
    const body = r.json() as ApiResponse
    expect(body.custom_methods).toEqual([{ id: body.id, name: 'Sodexo', active: true }])
    expect(m.savedConfig().custom_methods).toEqual(body.custom_methods)
    expect(m.catalog().restaurant.checkout?.customMethods).toEqual([
      { id: body.id, name: 'Sodexo' },
    ])
    expect(m.catalog().version).toBeGreaterThan(before)
    expect((await m.settings()) as unknown).toMatchObject({ custom_methods: body.custom_methods })
  })

  it('the name is trimmed; empty, only spaces or more than 30 letters, 400', async () => {
    const m = world()
    const r = (await save(m, { name: '  QR  ', active: true })).json() as ApiResponse
    expect(r.custom_methods[0]?.name).toBe('QR')
    for (const name of ['', '    ', 'x'.repeat(31), 5])
      expect((await save(m, { name, active: true })).statusCode, String(name)).toBe(400)
    expect((await save(m, { name: 'x'.repeat(30), active: true })).statusCode).toBe(200)
  })

  it('extra fields, without active or with an id that is not a ULID, 400', async () => {
    const m = world()
    expect((await save(m, { name: 'A', active: true, color: 'r' })).statusCode).toBe(400)
    expect((await save(m, { name: 'A' })).statusCode).toBe(400)
    expect((await save(m, { id: 'abc', name: 'A', active: true })).statusCode).toBe(400)
    expect((await m.makeCall(m.admin, '/api/register/custom-methods', {})).statusCode).toBe(400)
  })

  it('duplicate name among active ones (regardless of case), 400; an archived one does not block', async () => {
    const m = world()
    const a = (await save(m, { name: 'Sodexo', active: true })).json() as ApiResponse
    const r = await save(m, { name: 'SODEXO', active: true })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'Ya hay un medio con ese nombre' })
    await save(m, { id: a.id, name: 'Sodexo', active: false })
    expect((await save(m, { name: 'Sodexo', active: true })).statusCode).toBe(200)
    // Reactivating the archived one when there is already an active one with that name.
    expect((await save(m, { id: a.id, name: 'Sodexo', active: true })).statusCode).toBe(400)
  })

  it('rename, archive and reuse; the archived one leaves the menu but stays in the config', async () => {
    const m = world()
    const a = (await save(m, { name: 'Sodexo', active: true })).json() as ApiResponse
    await save(m, { id: a.id, name: 'Sodexo Pass', active: true })
    expect(m.catalog().restaurant.checkout?.customMethods?.[0]?.name).toBe('Sodexo Pass')
    await save(m, { id: a.id, name: 'Sodexo Pass', active: false })
    expect(m.catalog().restaurant.checkout?.customMethods).toEqual([])
    // The archived one no longer shows at checkout, but the menu sends it to name payments (1.8).
    expect(m.catalog().restaurant.checkout?.archivedCustomMethods).toEqual([
      { id: a.id, name: 'Sodexo Pass' },
    ])
    expect(m.savedConfig().custom_methods).toEqual([
      { id: a.id, name: 'Sodexo Pass', active: false },
    ])
    await save(m, { id: a.id, name: 'Sodexo Pass', active: true })
    expect(m.catalog().restaurant.checkout?.customMethods).toHaveLength(1)
    expect(m.catalog().restaurant.checkout?.archivedCustomMethods).toEqual([])
  })

  it('an id that does not exist, 400', async () => {
    const m = world()
    const r = await save(m, { id: newId(), name: 'A', active: true })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'Ese medio no existe' })
  })

  it('at most 20 custom methods: the 21st is rejected', async () => {
    const m = world()
    for (let i = 0; i < 20; i++)
      expect((await save(m, { name: `Medio ${i}`, active: true })).statusCode).toBe(200)
    const r = await save(m, { name: 'Uno más', active: true })
    expect(r.statusCode).toBe(400)
    expect(m.savedConfig().custom_methods).toHaveLength(20)
  })

  it('saving the same data of an existing method does not bump the version', async () => {
    const m = world()
    const a = (await save(m, { name: 'Sodexo', active: true })).json() as ApiResponse
    const v = m.catalog().version
    await save(m, { id: a.id, name: 'Sodexo', active: true })
    expect(m.catalog().version).toBe(v)
  })

  it('cashier, manager and waiter, 403 and create nothing', async () => {
    const m = world()
    for (const who of ['cashier', 'manager', 'waiter'] as const)
      expect((await save(m, { name: 'A', active: true }, m[who])).statusCode).toBe(403)
    expect(m.savedConfig().custom_methods).toEqual([])
  })

  it('custom methods and default ones coexist: changing one does not touch the other', async () => {
    const m = world()
    await save(m, { name: 'Sodexo', active: true })
    await m.methods(['cash', 'nequi'])
    expect(m.savedConfig().custom_methods).toHaveLength(1)
    await save(m, { name: 'QR', active: true })
    expect(m.savedConfig().payment_methods).toEqual(['cash', 'nequi'])
  })

  // BUG: `/api/register/payment-methods` accepts «other» in the schema (z.array(PaymentMethod))
  // but `fullConfig` rejects it on save and the route replies 500 instead of 400.
  // apps/hub/src/printing/routes.ts:567 (schema of `methods` / `updateConfig`).
  it('/api/register/payment-methods rejects «other» with 400 (not with a server error)', async () => {
    const m = world()
    const r = await m.methods(['cash', 'other'])
    expect(r.statusCode).toBe(400)
    expect(m.savedConfig().payment_methods).not.toContain('other')
  })
})
