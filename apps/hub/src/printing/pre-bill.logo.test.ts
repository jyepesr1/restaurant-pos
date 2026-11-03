import { fullConfig, newId, type PrintLogo } from '@pos/core'
import type { PreBill } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { item } from '../access/hub-setup'
import { type Device, setupPrinting } from './printing-setup'

// The pre-bill header (name or logo): `POST /api/register/pre-bill-header`, the kitchen settings
// that return it, and the printed pre-bill carrying the image only when the owner chose «logo».

const logoOf = (width: number, height: number, fill = 0xa5): PrintLogo => ({
  width,
  height,
  data: Buffer.alloc((width / 8) * height, fill).toString('base64'),
})

function world() {
  const t = setupPrinting()
  const ana = t.device('waiter')
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const manager = t.device('manager', 'register')
  const printer = t.newPrinter('Caja', [], { width: 80 })
  t.db
    .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
    .run(JSON.stringify({ pre_bill_printer_id: printer.id }), t.restaurantId)
  const call = (e: Device, body: Record<string, unknown>) =>
    t.post('/api/register/pre-bill-header', { ...e.sessionBody, ...body }, e.token)
  const header = (header: unknown, logo: unknown, e: Device = admin) => call(e, { header, logo })
  const savedConfig = () =>
    fullConfig(
      JSON.parse(
        String(
          t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(t.restaurantId)?.config,
        ),
      ),
    )
  const settings = async (e: Device = admin) =>
    (await t.post('/api/kitchen/config', e.sessionBody, e.token)).json() as {
      pre_bill_header: string
      print_logo: PrintLogo | null
      pre_bill_printer_id: string | null
    }
  const print = async () => {
    const order = t.open(ana, t.table('5'))
    expect(ana.submit(order, 'ItemAdded', { ...item(), unit_price: 40_900 }).status).toBe(
      'confirmed',
    )
    expect(
      ana.submit(order, 'PreBillPrinted', { check_id: null, subtotal: 0, suggested_tip: 0 }).status,
    ).toBe('confirmed')
    await t.queue.runOnce()
    const jobs = t.jobs("WHERE type = 'preBill'")
    return {
      content: t.content(jobs[jobs.length - 1] as (typeof jobs)[number]) as PreBill,
      paper: printer.paper.texts().at(-1) ?? '',
      jobs: jobs.length,
    }
  }
  return { t, ana, admin, cashier, manager, printer, header, call, savedConfig, settings, print }
}

describe('POST /api/register/pre-bill-header: permissions', () => {
  it('without a token, 401, and a made-up token too', async () => {
    const m = world()
    expect((await m.t.post('/api/register/pre-bill-header', {})).statusCode).toBe(401)
    const r = await m.t.post(
      '/api/register/pre-bill-header',
      { ...m.admin.sessionBody, header: 'name', logo: null },
      'inventado',
    )
    expect(r.statusCode).toBe(401)
  })

  it('a session that does not exist or has another secret, 401', async () => {
    const m = world()
    for (const session of [
      { session_id: newId(), secret: 'inventado' },
      { session_id: m.admin.sessionBody.session_id, secret: 'otro-secreto' },
    ]) {
      const r = await m.t.post(
        '/api/register/pre-bill-header',
        { ...session, header: 'name', logo: null },
        m.admin.token,
      )
      expect(r.statusCode).toBe(401)
    }
    expect(m.savedConfig().pre_bill_header).toBe('name')
  })

  it('cashier, manager and waiter get 403 and change nothing', async () => {
    for (const who of ['cashier', 'manager', 'ana'] as const) {
      const m = world()
      const before = m.t.catalogChanges.length
      const r = await m.header('logo', logoOf(16, 2), m[who])
      expect(r.statusCode, who).toBe(403)
      expect(m.savedConfig().pre_bill_header).toBe('name')
      expect(m.savedConfig().print_logo).toBeNull()
      expect(m.t.catalogChanges).toHaveLength(before)
    }
  })

  it('the administrator can save it: 204', async () => {
    const m = world()
    const r = await m.header('logo', logoOf(16, 2))
    expect(r.statusCode).toBe(204)
    expect(r.body).toBe('')
  })
})

describe('POST /api/register/pre-bill-header: validation', () => {
  it('«logo» without a logo is rejected with 400 and a message, and nothing changes', async () => {
    const m = world()
    const r = await m.header('logo', null)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      error: 'invalid_data',
      message: 'Sube el logo antes de elegirlo para la precuenta',
    })
    expect(m.savedConfig().pre_bill_header).toBe('name')
  })

  it('«logo» with the logo missing from the body is rejected too', async () => {
    const m = world()
    expect((await m.call(m.admin, { header: 'logo' })).statusCode).toBe(400)
    expect(m.savedConfig().pre_bill_header).toBe('name')
  })

  it('an unknown header or a missing one, 400', async () => {
    const m = world()
    for (const header of ['banner', '', null, 1, undefined])
      expect((await m.header(header, null)).statusCode, String(header)).toBe(400)
    expect((await m.call(m.admin, { logo: null })).statusCode).toBe(400)
  })

  it('an invalid logo is rejected with 400 and nothing is saved', async () => {
    const m = world()
    const good = logoOf(16, 2)
    for (const bad of [
      { ...good, width: 15 },
      { ...good, width: 392 },
      { ...good, height: 241 },
      { ...good, height: 0 },
      { ...good, data: good.data.slice(4) },
      { ...good, data: '***=' },
      { width: 16, height: 2 },
      'logo',
    ]) {
      const r = await m.header('logo', bad)
      expect(r.statusCode, JSON.stringify(bad)).toBe(400)
      expect(r.json()).toMatchObject({
        error: 'invalid_data',
        message: 'Datos con formato inesperado',
      })
    }
    expect(m.savedConfig().print_logo).toBeNull()
    expect(m.savedConfig().pre_bill_header).toBe('name')
  })

  it('a bad logo is rejected even if the header is «name»', async () => {
    const m = world()
    expect((await m.header('name', { ...logoOf(16, 2), width: 9 })).statusCode).toBe(400)
    expect(m.savedConfig().print_logo).toBeNull()
  })

  it('the largest logo (384 x 240) is accepted', async () => {
    const m = world()
    expect((await m.header('logo', logoOf(384, 240))).statusCode).toBe(204)
    expect(m.savedConfig().print_logo).toEqual(logoOf(384, 240))
  })
})

describe('POST /api/register/pre-bill-header: saving', () => {
  it('stores header and logo, bumps the version, notifies and records who changed it', async () => {
    const m = world()
    const logo = logoOf(48, 10)
    await m.header('logo', logo)
    expect(m.savedConfig()).toMatchObject({ pre_bill_header: 'logo', print_logo: logo })
    expect(m.t.catalogChanges).toHaveLength(1)
    expect(
      m.t.db
        .prepare('SELECT user_id, device_id FROM restaurants WHERE id = ?')
        .get(m.t.restaurantId),
    ).toEqual({ user_id: m.t.people.admin.userId, device_id: m.admin.connection.deviceId })
  })

  it('does not touch the rest of the config', async () => {
    const m = world()
    const before = m.savedConfig()
    await m.header('logo', logoOf(16, 2))
    expect({ ...m.savedConfig(), pre_bill_header: 'name', print_logo: null }).toEqual(before)
  })

  it('the kitchen settings return the header and the logo', async () => {
    const m = world()
    expect(await m.settings()).toMatchObject({ pre_bill_header: 'name', print_logo: null })
    const logo = logoOf(32, 4)
    await m.header('logo', logo)
    expect(await m.settings()).toMatchObject({ pre_bill_header: 'logo', print_logo: logo })
  })

  it('repeating the same request does not bump the version or notify again', async () => {
    const m = world()
    await m.header('logo', logoOf(16, 2))
    const alerts = m.t.catalogChanges.length
    expect((await m.header('logo', logoOf(16, 2))).statusCode).toBe(204)
    expect(m.t.catalogChanges).toHaveLength(alerts)
  })

  it('«name» with a logo keeps the logo saved, for choosing it again later', async () => {
    const m = world()
    const logo = logoOf(16, 2)
    await m.header('name', logo)
    expect(m.savedConfig()).toMatchObject({ pre_bill_header: 'name', print_logo: logo })
  })

  it('removing the logo (name and null) goes back to the name', async () => {
    const m = world()
    await m.header('logo', logoOf(16, 2))
    expect((await m.header('name', null)).statusCode).toBe(204)
    expect(m.savedConfig()).toMatchObject({ pre_bill_header: 'name', print_logo: null })
    expect(await m.settings()).toMatchObject({ pre_bill_header: 'name', print_logo: null })
  })

  it('it replaces a logo with another one', async () => {
    const m = world()
    await m.header('logo', logoOf(16, 2, 0x00))
    await m.header('logo', logoOf(24, 3, 0xff))
    expect(m.savedConfig().print_logo).toEqual(logoOf(24, 3, 0xff))
  })

  it('a config saved before this feature reads with «name» and no logo', async () => {
    const m = world()
    expect(m.savedConfig()).toMatchObject({ pre_bill_header: 'name', print_logo: null })
    expect(await m.settings()).toMatchObject({ pre_bill_header: 'name', print_logo: null })
  })
})

describe('the printed pre-bill and the header', () => {
  it('by default it carries no logo and the paper has the restaurant name', async () => {
    const m = world()
    const { content, paper } = await m.print()
    expect(content.logo ?? null).toBeNull()
    expect(paper).not.toContain('[logo')
    expect(paper).toContain('PRECUENTA')
  })

  it('with «logo» chosen, the job carries the image and the paper shows it', async () => {
    const m = world()
    const logo = logoOf(48, 10)
    await m.header('logo', logo)
    const { content, paper } = await m.print()
    expect(content.logo).toEqual(logo)
    expect(paper.split('\n')[0]).toBe('[logo 48×10]')
    expect(paper).toContain('PRECUENTA')
    expect(paper).toContain('$40.900')
  })

  it('with a logo saved but «name» chosen, the pre-bill does not carry it', async () => {
    const m = world()
    await m.header('name', logoOf(48, 10))
    const { content, paper } = await m.print()
    expect(content.logo ?? null).toBeNull()
    expect(paper).not.toContain('[logo')
  })

  it('removing the logo goes back to printing the name', async () => {
    const m = world()
    await m.header('logo', logoOf(48, 10))
    expect((await m.print()).paper).toContain('[logo')
    await m.header('name', null)
    const { content, paper } = await m.print()
    expect(content.logo ?? null).toBeNull()
    expect(paper).not.toContain('[logo')
  })

  it('a pre-bill already queued keeps the header it was created with', async () => {
    const m = world()
    const order = m.t.open(m.ana, m.t.table('5'))
    m.ana.submit(order, 'ItemAdded', { ...item(), unit_price: 40_900 })
    await m.header('logo', logoOf(16, 2))
    m.ana.submit(order, 'PreBillPrinted', { check_id: null, subtotal: 0, suggested_tip: 0 })
    await m.header('name', null)
    await m.t.queue.runOnce()
    expect(m.printer.paper.texts().at(-1)).toContain('[logo 16×2]')
  })

  it('a 58 mm printer also gets the image', async () => {
    const m = world()
    const narrow = m.t.newPrinter('Barra chica', [], { width: 58 })
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: narrow.id }), m.t.restaurantId)
    await m.header('logo', logoOf(384, 20))
    const order = m.t.open(m.ana, m.t.table('5'))
    m.ana.submit(order, 'ItemAdded', { ...item(), unit_price: 40_900 })
    m.ana.submit(order, 'PreBillPrinted', { check_id: null, subtotal: 0, suggested_tip: 0 })
    await m.t.queue.runOnce()
    expect(narrow.paper.texts().at(-1)?.split('\n')[0]).toBe('[logo 384×20]')
  })
})
