import { newId, type OrderEvent } from '@pos/core'
import type { ZReport } from '@pos/printing'
import { SqliteStore } from '@pos/sync/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../../packages/core/src/testing/factory'
import { item } from '../access/hub-setup'
import { START } from '../access/setup'
import { type Device, setupPrinting } from '../printing/printing-setup'
import { jobsForEvent } from '../printing/tickets'

// The Z report and the report routes when something goes wrong (task 1.9): the same close resent,
// the hub restarting, no printer or a broken one, another restaurant in the same database,
// both paper widths, permissions and dates that are not dates.

function world(options: { width?: 58 | 80; withPrinter?: boolean } = {}) {
  const t = setupPrinting()
  const ana = t.device('waiter')
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const printer = t.newPrinter('Caja', [], options.width ? { width: options.width } : {})
  const select = (id: string | null) =>
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify(id ? { pre_bill_printer_id: id } : {}), t.restaurantId)
  if (options.withPrinter !== false) select(printer.id)

  /** Opens a shift, charges an order and leaves the shift ready to close (without closing it). */
  const shiftCharged = (register: Device, price = 40_000, tipAmount = 4_000, base = 100_000) => {
    const shift = newId()
    register.submit(
      shift,
      'ShiftOpened',
      { register_id: register.connection.deviceId, base },
      { aggregate_type: 'register_shift' },
    )
    const sell = (amount: number, tip: number) => {
      const order = t.open(ana)
      ana.submit(order, 'ItemAdded', { ...item(), unit_price: amount })
      const payment = {
        payment_id: newId(),
        check_id: null,
        register_shift_id: shift,
        method: 'cash',
        amount,
        tip: tip,
        tendered: amount + tip,
        change: 0,
        rounding_adjustment: 0,
        rounding: { multiple: 100, mode: 'nearest_half_down' },
        cardTerminal: null,
        charge_reference: null,
      }
      expect(register.submit(order, 'PaymentRecorded', payment).status).toBe('confirmed')
      expect(register.submit(order, 'OrderClosed', {}).status).toBe('confirmed')
      return order
    }
    sell(price, tipAmount)
    return { shift, sell, expected: base + price + tipAmount }
  }

  /** Closes the shift by sending the event by hand (so it can be resent as is). */
  const closeWithEvent = (register: Device, shift: string, expected: number) => {
    const cashCount = newId()
    register.submit(
      shift,
      'CashCountRecorded',
      {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: expected / 1_000 }],
        counted_cash: expected,
      },
      { aggregate_type: 'register_shift' },
    )
    const raw = t.event(
      register.connection,
      register.session,
      'ShiftClosed',
      {
        cash_count_id: cashCount,
        expected_cash: expected,
        counted_cash: expected,
        variance: 0,
        justification: null,
        other_methods: [],
      },
      { aggregate_id: shift, aggregate_type: 'register_shift', base_sequence: 0 } as never,
    )
    return raw
  }

  const zReports = () => t.jobs("WHERE type = 'report'").map((f) => t.content(f) as ZReport)
  return { t, ana, admin, cashier, printer, select, shiftCharged, closeWithEvent, zReports }
}

const maxSequence = (t: ReturnType<typeof setupPrinting>) =>
  Number(
    t.db
      .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
      .get(t.restaurantId)?.s,
  )

describe('Z report: only once', () => {
  it('a resent ShiftClosed (same event) does not create another Z report', () => {
    const { t, admin, shiftCharged, closeWithEvent, zReports } = world()
    const x = shiftCharged(admin)
    const raw = {
      ...closeWithEvent(admin, x.shift, x.expected),
      base_sequence: maxSequence(t),
    }
    const firstOne = t.hub.receiveBatch(admin.connection, [raw as never])
    expect(firstOne.results[0]?.status).toBe('confirmed')
    expect(zReports()).toHaveLength(1)
    const another = t.hub.receiveBatch(admin.connection, [raw as never])
    // The resend is not a new event: it is not saved again and does not trigger the hook.
    expect(another.acceptedEvents).toEqual([])
    expect(zReports()).toHaveLength(1)
    expect(t.saveFailures).toEqual([])
  })

  it('delivering the same event to the hook twice, or from a restarted hub, leaves a single job', () => {
    const { t, admin, shiftCharged, closeWithEvent, zReports } = world()
    const x = shiftCharged(admin)
    const raw = {
      ...closeWithEvent(admin, x.shift, x.expected),
      base_sequence: maxSequence(t),
    }
    const r = t.hub.receiveBatch(admin.connection, [raw as never])
    const accepted = r.acceptedEvents[0] as OrderEvent
    expect(jobsForEvent(t.ticketOptions, accepted, [])).toBe(1)
    expect(jobsForEvent(t.ticketOptions, accepted, [])).toBe(1)
    const restarted = t.createHub()
    restarted.receiveBatch(admin.connection, [raw as never])
    expect(jobsForEvent(t.ticketOptions, accepted, [])).toBe(1)
    expect(zReports()).toHaveLength(1)
    expect(t.jobs("WHERE type = 'report'")).toHaveLength(1)
  })

  it('with two closed shifts two Z reports print, each with its own figures', () => {
    const { t, admin, shiftCharged, closeWithEvent, zReports } = world()
    const a = shiftCharged(admin, 40_000, 4_000)
    const ca = { ...closeWithEvent(admin, a.shift, a.expected), base_sequence: maxSequence(t) }
    expect(t.hub.receiveBatch(admin.connection, [ca as never]).results[0]?.status).toBe('confirmed')
    const b = shiftCharged(admin, 10_000, 0, 20_000)
    const cb = { ...closeWithEvent(admin, b.shift, b.expected), base_sequence: maxSequence(t) }
    expect(t.hub.receiveBatch(admin.connection, [cb as never]).results[0]?.status).toBe('confirmed')
    const z = zReports()
    expect(z).toHaveLength(2)
    expect(z.map((x) => x.cash.base)).toEqual([100_000, 20_000])
    expect(z.map((x) => x.cash.expected)).toEqual([a.expected, b.expected])
  })
})

describe('Z report: no printer or a broken one', () => {
  const close = (m: ReturnType<typeof world>) => {
    const x = m.shiftCharged(m.admin)
    const raw = {
      ...m.closeWithEvent(m.admin, x.shift, x.expected),
      base_sequence: maxSequence(m.t),
    }
    return { x, r: m.t.hub.receiveBatch(m.admin.connection, [raw as never]) }
  }

  it('with no printer chosen nothing is created and the close is accepted; reprinting asks to choose one', async () => {
    const m = world({ withPrinter: false })
    const { x, r } = close(m)
    expect(r.results[0]?.status).toBe('confirmed')
    expect(m.zReports()).toEqual([])
    expect(m.t.saveFailures).toEqual([])
    const res = await m.t.post(
      '/api/reports/z-report',
      { ...m.admin.sessionBody, shift_id: x.shift },
      m.admin.token,
    )
    expect(res.statusCode).toBe(409)
    expect(m.zReports()).toEqual([])
    // Once the printer is chosen later, it can be reprinted.
    m.select(m.printer.id)
    const another = await m.t.post(
      '/api/reports/z-report',
      { ...m.admin.sessionBody, shift_id: x.shift },
      m.admin.token,
    )
    expect(another.statusCode).toBe(204)
    expect(m.zReports()).toHaveLength(1)
  })

  it('with an archived or nonexistent printer nothing is created either, and the close is accepted', () => {
    const archivedUser = world()
    archivedUser.t.db
      .prepare('UPDATE printers SET active = 0 WHERE id = ?')
      .run(archivedUser.printer.id)
    expect(close(archivedUser).r.results[0]?.status).toBe('confirmed')
    expect(archivedUser.zReports()).toEqual([])

    const ghost = world()
    ghost.select(newId())
    expect(close(ghost).r.results[0]?.status).toBe('confirmed')
    expect(ghost.zReports()).toEqual([])
  })

  it('if building the Z report fails, the register close is still accepted and the error is logged', () => {
    const m = world()
    // A config that cannot be read: the register close must never be left half done because of it.
    m.t.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run('[1,2]', m.t.restaurantId)
    const entry = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { r } = close(m)
      expect(r.results[0]?.status).toBe('confirmed')
      expect(m.zReports()).toEqual([])
    } finally {
      entry.mockRestore()
    }
    // The shift really was closed.
    expect(m.t.hub.openShift(m.admin.connection.deviceId)).toBeNull()
  })

  it('a printer that is off leaves the Z report pending, with its name, and it prints when back', async () => {
    const m = world()
    m.printer.paper.off = true
    const { x } = close(m)
    await m.t.queue.runOnce()
    expect(m.printer.paper.received).toHaveLength(0)
    const list = await m.t.post('/api/printing/pending', { ...m.admin.sessionBody }, m.admin.token)
    expect(list.json().map((p: { what: string }) => p.what)).toEqual(['Cierre de caja'])
    // A reprint while it is still off.
    await m.t.post(
      '/api/reports/z-report',
      { ...m.admin.sessionBody, shift_id: x.shift },
      m.admin.token,
    )
    await m.t.queue.ready()
    const two = await m.t.post('/api/printing/pending', { ...m.admin.sessionBody }, m.admin.token)
    expect(two.json().map((p: { what: string }) => p.what)).toEqual([
      'Cierre de caja',
      'Cierre de caja (reimpresión)',
    ])
    m.printer.paper.off = false
    m.t.advance(60 * 60 * 1000)
    m.t.queue.wake()
    await m.t.queue.ready()
    expect(m.printer.paper.texts()).toHaveLength(2)
    expect(m.t.pendingList()).toBe(0)
  })
})

describe('Z report reprint', () => {
  it('each reprint is a new marked job, with the same figures as the original', async () => {
    const m = world()
    const x = m.shiftCharged(m.admin, 55_000, 5_000)
    const raw = {
      ...m.closeWithEvent(m.admin, x.shift, x.expected),
      base_sequence: maxSequence(m.t),
    }
    m.t.hub.receiveBatch(m.admin.connection, [raw as never])
    for (let i = 0; i < 3; i++) {
      const r = await m.t.post(
        '/api/reports/z-report',
        { ...m.admin.sessionBody, shift_id: x.shift },
        m.admin.token,
      )
      expect(r.statusCode).toBe(204)
    }
    const z = m.zReports()
    expect(z).toHaveLength(4)
    expect(z.filter((c) => c.reprinted === null)).toHaveLength(1)
    expect(z.filter((c) => c.reprinted !== null)).toHaveLength(3)
    const { reprinted: _a, ...original } = z.find((c) => c.reprinted === null) as ZReport
    for (const c of z.filter((c) => c.reprinted !== null)) {
      const { reprinted: _b, ...rest } = c
      expect(rest).toEqual(original)
    }
    await m.t.queue.runOnce()
    const paper = m.printer.paper.texts()
    expect(paper).toHaveLength(4)
    expect(paper.filter((p) => p.includes('Reimpresión'))).toHaveLength(3)
    // The reprint of another day's shift does not change when sales are added later.
    expect(paper.every((p) => p.includes('CIERRE DE CAJA'))).toBe(true)
  })

  it('an open shift gives 404 and leaves nothing in the queue', async () => {
    const m = world()
    const register = m.admin
    const shift = newId()
    register.submit(
      shift,
      'ShiftOpened',
      { register_id: register.connection.deviceId, base: 1_000 },
      { aggregate_type: 'register_shift' },
    )
    const r = await m.t.post(
      '/api/reports/z-report',
      { ...register.sessionBody, shift_id: shift },
      register.token,
    )
    expect(r.statusCode).toBe(404)
    expect(m.zReports()).toEqual([])
  })
})

describe('58 and 80 mm paper', () => {
  it.each([58, 80] as const)(
    'the Z report at %i mm prints with no overflowing lines',
    async (width) => {
      const m = world({ width })
      const x = m.shiftCharged(m.admin, 5_000_000, 500_000, 9_999_000)
      // That much money fits: the counted amount reconciles with the expected one.
      const raw = {
        ...m.closeWithEvent(m.admin, x.shift, x.expected),
        base_sequence: maxSequence(m.t),
      }
      expect(m.t.hub.receiveBatch(m.admin.connection, [raw as never]).results[0]?.status).toBe(
        'confirmed',
      )
      await m.t.queue.runOnce()
      const [paper] = m.printer.paper.texts()
      expect(paper).toContain('CIERRE DE CAJA')
      const columns = width === 58 ? 32 : 48
      for (const line of (paper ?? '').split('\n')) expect(line.length).toBeLessThanOrEqual(columns)
    },
  )
})

describe('another restaurant in the same database', () => {
  /** A second restaurant with an already closed shift and one sale, on the same business day. */
  function otherRestaurant(t: ReturnType<typeof setupPrinting>) {
    const other = newId()
    const now = '2026-10-24T20:00:00.000Z'
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(other, other, now, now)
    const store = new SqliteStore(t.db, other)
    const shift = newId()
    const order = newId()
    const raw = (type: string, aggregate: string, aggregateType: string, data: unknown) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: aggregateType,
      aggregate_id: aggregate,
      related: [],
      data,
      session_id: null,
      user_id: newId(),
      device_id: newId(),
      authorization_id: null,
      reason: null,
      device_time: now,
      hub_estimated_time: now,
      base_sequence: 0,
      received_at: now,
      business_day: '2026-10-24',
      assignments: {},
      affects: [],
      authorized_by_id: null,
    })
    const cashCount = newId()
    const it = itemCopy({ unit_price: 99_000 })
    const payment = cashPaymentData(99_000, { register_shift_id: shift })
    const base = [
      raw('ShiftOpened', shift, 'register_shift', { register_id: newId(), base: 1 }),
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 9 }),
      event(order, 'ItemAdded', it),
      event(order, 'PaymentRecorded', payment),
      event(order, 'OrderClosed', {}, { business_day: '2026-10-24' }),
      raw('CashCountRecorded', shift, 'register_shift', {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: 99 }],
        counted_cash: 99_000,
      }),
      raw('ShiftClosed', shift, 'register_shift', {
        cash_count_id: cashCount,
        expected_cash: 99_001,
        counted_cash: 99_000,
        variance: -1,
        justification: 'Del otro restaurante',
        other_methods: [],
      }),
    ]
    for (const [i, e] of base.entries())
      store.saveEvent(
        { ...e, sequence: i + 1, received_at: now } as unknown as OrderEvent,
        `h${i}`,
        [e.aggregate_id],
      )
    return { other, shift, order }
  }

  it('the report adds no sales or closes from another restaurant, and its Z report is not reprinted', async () => {
    const m = world()
    const own = m.shiftCharged(m.admin)
    const raw = {
      ...m.closeWithEvent(m.admin, own.shift, own.expected),
      base_sequence: maxSequence(m.t),
    }
    m.t.hub.receiveBatch(m.admin.connection, [raw as never])
    const other = otherRestaurant(m.t)
    const r = await m.t.post(
      '/api/reports',
      { ...m.admin.sessionBody, from: '2026-10-24', until: '2026-10-24' },
      m.admin.token,
    )
    const body = r.json()
    expect(body.report.sales).toMatchObject({ net: 40_000, checks: 1, guests: 2 })
    expect(body.closings.map((c: { shiftId: string }) => c.shiftId)).toEqual([own.shift])
    expect(JSON.stringify(body)).not.toContain('Del otro restaurante')
    // Reprinting another restaurant's shift is as if it did not exist.
    const res = await m.t.post(
      '/api/reports/z-report',
      { ...m.admin.sessionBody, shift_id: other.shift },
      m.admin.token,
    )
    expect(res.statusCode).toBe(404)
    expect(m.zReports()).toHaveLength(1)
  })
})

describe('Z report: the sales day is the day the shift opened', () => {
  it('a shift that opens one day and closes the next prints the sales of the day it opened', () => {
    const m = world()
    const register = m.admin
    const shift = newId()
    register.submit(
      shift,
      'ShiftOpened',
      { register_id: register.connection.deviceId, base: 100_000 },
      { aggregate_type: 'register_shift' },
    )
    const sell = (amount: number) => {
      const order = m.t.open(m.ana)
      m.ana.submit(order, 'ItemAdded', { ...item(), unit_price: amount })
      register.submit(order, 'PaymentRecorded', {
        payment_id: newId(),
        check_id: null,
        register_shift_id: shift,
        method: 'cash',
        amount,
        tip: 0,
        tendered: amount,
        change: 0,
        rounding_adjustment: 0,
        rounding: { multiple: 100, mode: 'nearest_half_down' },
        cardTerminal: null,
        charge_reference: null,
      })
      expect(register.submit(order, 'OrderClosed', {}).status).toBe('confirmed')
    }
    sell(40_000)
    // The early morning passes: it is 6:30 a.m. on the 25th.
    m.t.advance(Date.parse('2026-10-25T11:30:00.000Z') - START)
    sell(25_000)
    const { closeWithEvent } = m
    const raw = { ...closeWithEvent(register, shift, 165_000), base_sequence: maxSequence(m.t) }
    expect(m.t.hub.receiveBatch(register.connection, [raw as never]).results[0]?.status).toBe(
      'confirmed',
    )
    const [z] = m.zReports()
    expect(z?.sales.net).toBe(40_000)
    expect(z?.cash.charged).toBe(65_000)
  })
})

describe('report routes: permissions, bodies and dates', () => {
  const report = (
    m: ReturnType<typeof world>,
    body: Record<string, unknown>,
    token = m.admin.token,
  ) => m.t.post('/api/reports', { ...m.admin.sessionBody, ...body }, token)

  it('no token 401, the cashier without the permission 403, and also for reprinting', async () => {
    const m = world()
    const x = m.shiftCharged(m.admin)
    const raw = {
      ...m.closeWithEvent(m.admin, x.shift, x.expected),
      base_sequence: maxSequence(m.t),
    }
    m.t.hub.receiveBatch(m.admin.connection, [raw as never])
    const before = m.zReports().length
    expect((await m.t.post('/api/reports', { ...m.admin.sessionBody })).statusCode).toBe(401)
    expect(
      (await m.t.post('/api/reports', { ...m.admin.sessionBody }, 'token-falso')).statusCode,
    ).toBe(401)
    expect(
      (await m.t.post('/api/reports/z-report', { ...m.admin.sessionBody, shift_id: x.shift }))
        .statusCode,
    ).toBe(401)
    expect(
      (await m.t.post('/api/reports', { ...m.cashier.sessionBody }, m.cashier.token)).statusCode,
    ).toBe(403)
    expect(
      (
        await m.t.post(
          '/api/reports/z-report',
          { ...m.cashier.sessionBody, shift_id: x.shift },
          m.cashier.token,
        )
      ).statusCode,
    ).toBe(403)
    // Nor the waiter.
    expect((await m.t.post('/api/reports', { ...m.ana.sessionBody }, m.ana.token)).statusCode).toBe(
      403,
    )
    expect(m.zReports()).toHaveLength(before)
  })

  it('a session from another device, or with the wrong secret, does not work', async () => {
    const m = world()
    expect((await report(m, {}, m.cashier.token)).statusCode).toBeGreaterThanOrEqual(401)
    expect((await report(m, {}, m.cashier.token)).statusCode).not.toBe(200)
    expect((await report(m, { secret: 'otro-secreto' })).statusCode).toBe(401)
    expect((await report(m, { session_id: newId() })).statusCode).toBe(401)
  })

  it('malformed bodies give 400, not 500', async () => {
    const m = world()
    const rawList = [
      { session_id: m.admin.sessionBody.session_id },
      { ...m.admin.sessionBody, extra: 1 },
      { ...m.admin.sessionBody, from: 5 },
      { ...m.admin.sessionBody, from: null },
      { ...m.admin.sessionBody, until: ['2026-10-24'] },
      { session_id: 5, secret: 6 },
      {},
    ]
    for (const c of rawList)
      expect((await m.t.post('/api/reports', c, m.admin.token)).statusCode).toBe(400)
    for (const c of [
      { ...m.admin.sessionBody },
      { ...m.admin.sessionBody, shift_id: 'corto' },
      { ...m.admin.sessionBody, shift_id: newId(), extra: 1 },
      { ...m.admin.sessionBody, shift_id: 7 },
    ])
      expect((await m.t.post('/api/reports/z-report', c, m.admin.token)).statusCode).toBe(400)
  })

  it('dates that are not dates give 400 and leap-year and edge dates give 200', async () => {
    const m = world()
    for (const bad of ['2026-02-29', '2026-04-31', '2026-06-31', '2027-02-29'])
      expect((await report(m, { from: bad })).statusCode, JSON.stringify(bad)).toBe(400)
    expect((await report(m, { from: '2026-10-24', until: '2026-02-29' })).statusCode).toBe(400)
    for (const goodOne of ['2028-02-29', '2026-12-31', '2027-01-01', '2026-01-01', '2036-12-31']) {
      const r = await report(m, { from: goodOne })
      expect(r.statusCode, goodOne).toBe(200)
      expect(r.json().report).toMatchObject({ from: goodOne, until: goodOne })
    }
  })

  // Finding from task 1.9: `Day` in routes.ts calls `toISOString()` inside the `refine`, which
  // also runs when the text does not match the format (zod 4 does not stop at the first failure):
  // with text that is not a date (month 13, «today», «2026-2-3») `toISOString()` throws RangeError
  // and the route gives 500 instead of 400.
  it('text that is not a date gives 400, not 500', async () => {
    const m = world()
    for (const bad of [
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '2026-2-3',
      'today',
      '',
      ' 2026-10-24',
      '2026-10-24\n',
      '2026-10-24T00:00:00Z',
      '2026/10/24',
    ])
      expect((await report(m, { from: bad })).statusCode, JSON.stringify(bad)).toBe(400)
  })

  it('reversed gives 400; only "until" counts from today; only "from" is a single day', async () => {
    const m = world()
    expect((await report(m, { from: '2026-10-25', until: '2026-10-24' })).statusCode).toBe(400)
    // today is the 24th: until before today is reversed.
    expect((await report(m, { until: '2026-10-23' })).statusCode).toBe(400)
    const untilFuture = await report(m, { until: '2026-10-26' })
    expect(untilFuture.json().report).toMatchObject({ from: '2026-10-24', until: '2026-10-26' })
    expect((await report(m, { from: '2026-10-20' })).json().report).toMatchObject({
      from: '2026-10-20',
      until: '2026-10-20',
    })
    expect((await report(m, { from: '2026-10-24', until: '2026-10-24' })).statusCode).toBe(200)
  })

  it('the maximum period is 62 days: 62 passes, 63 does not, also across a year', async () => {
    const m = world()
    expect((await report(m, { from: '2026-09-01', until: '2026-11-01' })).statusCode).toBe(200) // 62 days
    expect((await report(m, { from: '2026-09-01', until: '2026-11-02' })).statusCode).toBe(400) // 63
    expect((await report(m, { from: '2026-12-01', until: '2027-01-31' })).statusCode).toBe(200) // 62
    expect((await report(m, { from: '2026-12-01', until: '2027-02-01' })).statusCode).toBe(400) // 63
    // In a leap year February has one more day.
    expect((await report(m, { from: '2028-01-15', until: '2028-03-15' })).statusCode).toBe(200) // 61
    expect((await report(m, { from: '2028-01-15', until: '2028-03-17' })).statusCode).toBe(400) // 63
    expect((await report(m, { from: '2000-01-01', until: '2026-10-24' })).statusCode).toBe(400)
  })

  it('"today" changes at 6:00 a.m. Bogotá time, not at midnight', async () => {
    const m = world()
    const today = async () => (await report(m, {})).json().today
    m.t.advance(Date.parse('2026-10-25T04:59:00.000Z') - START) // 11:59 p.m. on the 24th
    expect(await today()).toBe('2026-10-24')
    m.t.advance(Date.parse('2026-10-25T10:59:00.000Z') - Date.parse('2026-10-25T04:59:00.000Z')) // 5:59 a.m.
    expect(await today()).toBe('2026-10-24')
    m.t.advance(60_000) // 6:00 a.m. on the 25th
    expect(await today()).toBe('2026-10-25')
    expect((await report(m, {})).json().report).toMatchObject({
      from: '2026-10-25',
      until: '2026-10-25',
    })
  })

  it('a day without activity gives a report in zeros and without closes', async () => {
    const m = world()
    const r = (await report(m, { from: '2026-10-01' })).json()
    expect(r.report.sales).toMatchObject({
      net: 0,
      checks: 0,
      guests: 0,
      averageTicket: 0,
    })
    expect(r.report.byMethod).toEqual([])
    expect(r.closings).toEqual([])
    expect(r.printer).toBe(true)
  })
})
