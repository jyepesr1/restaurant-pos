import { newId } from '@pos/core'
import type { ZReport } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { item } from '../access/hub-setup'
import { type Device, setupPrinting } from '../printing/printing-setup'

// Reports (task 1.9): the Z report prints only when the register is closed, is reprinted from
// Reportes, and the report route requires «Ver todos los reportes».

function world(options: { withPrinter?: boolean } = {}) {
  const t = setupPrinting()
  const ana = t.device('waiter')
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const printer = t.newPrinter('Caja', [])
  if (options.withPrinter !== false)
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer.id }), t.restaurantId)

  /** Opens a shift at the register, charges a `price` order in cash and closes it balanced. */
  const day = (register: Device, price = 40_000, tip = 4_000) => {
    const shift = newId()
    expect(
      register.submit(
        shift,
        'ShiftOpened',
        { register_id: register.connection.deviceId, base: 100_000 },
        { aggregate_type: 'register_shift' },
      ).status,
    ).toBe('confirmed')
    const order = t.open(ana)
    expect(ana.submit(order, 'ItemAdded', { ...item(), unit_price: price }).status).toBe(
      'confirmed',
    )
    expect(
      register.submit(order, 'PaymentRecorded', {
        payment_id: newId(),
        check_id: null,
        register_shift_id: shift,
        method: 'cash',
        amount: price,
        tip,
        tendered: price + tip,
        change: 0,
        rounding_adjustment: 0,
        rounding: { multiple: 100, mode: 'nearest_half_down' },
        cardTerminal: null,
        charge_reference: null,
      }).status,
    ).toBe('confirmed')
    expect(register.submit(order, 'OrderClosed', {}).status).toBe('confirmed')
    const counted = 100_000 + price + tip
    const cashCount = newId()
    register.submit(
      shift,
      'CashCountRecorded',
      {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: counted / 1_000 }],
        counted_cash: counted,
      },
      { aggregate_type: 'register_shift' },
    )
    const closeout = register.submit(
      shift,
      'ShiftClosed',
      {
        cash_count_id: cashCount,
        expected_cash: counted,
        counted_cash: counted,
        variance: 0,
        justification: null,
        other_methods: [],
      },
      { aggregate_type: 'register_shift' },
    )
    return { shift, order, closeout }
  }
  const zReports = () => t.jobs("WHERE type = 'report'").map((f) => t.content(f) as ZReport)
  return { t, ana, admin, cashier, printer, day, zReports }
}

describe('Z report on register close', () => {
  it('closing the shift puts the Z report on the pre-bill printer, and it prints', async () => {
    const { t, admin, printer, day, zReports } = world()
    const { closeout } = day(admin)
    expect(closeout.status).toBe('confirmed')
    const [z] = zReports()
    expect(z).toMatchObject({
      reprinted: null,
      cash: { base: 100_000, charged: 44_000, expected: 144_000, variance: 0 },
      charged: [{ name: 'Efectivo', sale: 40_000, tip: 4_000 }],
      sales: { net: 40_000, tips: 4_000, checks: 1 },
    })
    await t.queue.runOnce()
    const [paper] = printer.paper.texts()
    expect(paper).toContain('CIERRE DE CAJA')
    expect(paper).toContain('$144.000')
  })

  it('without a pre-bill printer nothing is created and the close is still accepted', () => {
    const { t, admin, day, zReports } = world({ withPrinter: false })
    expect(day(admin).closeout.status).toBe('confirmed')
    expect(zReports()).toEqual([])
    expect(t.saveFailures).toEqual([])
  })
})

describe('report routes', () => {
  it("today's report, with the closes and the names; the cashier without the permission cannot see it", async () => {
    const { t, admin, cashier, day } = world()
    const { shift } = day(admin)
    const r = await t.post('/api/reports', { ...admin.sessionBody }, admin.token)
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.report.sales).toMatchObject({ net: 40_000, checks: 1 })
    expect(body.closings).toEqual([
      expect.objectContaining({
        shiftId: shift,
        closed: expect.objectContaining({ variance: 0 }),
      }),
    ])
    expect(Object.values(body.users)).toContain('Ana')
    expect(body.printer).toBe(true)

    const withoutPermission = await t.post(
      '/api/reports',
      { ...cashier.sessionBody },
      cashier.token,
    )
    expect(withoutPermission.statusCode).toBe(403)
    expect((await t.post('/api/reports', { ...admin.sessionBody })).statusCode).toBe(401)
  })

  it('rejects reversed or invalid dates or a period longer than 62 days', async () => {
    const { t, admin } = world()
    const request = (from: string, until: string) =>
      t.post('/api/reports', { ...admin.sessionBody, from, until }, admin.token)
    expect((await request('2026-10-24', '2026-10-23')).statusCode).toBe(400)
    expect((await request('2026-02-30', '2026-03-01')).statusCode).toBe(400)
    expect((await request('2026-01-01', '2026-03-04')).statusCode).toBe(400)
    expect((await request('2026-01-01', '2026-03-03')).statusCode).toBe(200)
  })

  it('reprints the Z report of a closed shift; an open or nonexistent one gives 404', async () => {
    const { t, admin, day, zReports } = world()
    const { shift } = day(admin)
    const request = (shift_id: string) =>
      t.post('/api/reports/z-report', { ...admin.sessionBody, shift_id }, admin.token)
    expect((await request(shift)).statusCode).toBe(204)
    expect(zReports()).toHaveLength(2)
    expect(zReports()[1]?.reprinted).not.toBeNull()
    expect((await request(newId())).statusCode).toBe(404)
  })

  it('without a pre-bill printer, the reprint says so', async () => {
    const { t, admin, day } = world({ withPrinter: false })
    const { shift } = day(admin)
    const r = await t.post(
      '/api/reports/z-report',
      { ...admin.sessionBody, shift_id: shift },
      admin.token,
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('no_printer')
  })
})
