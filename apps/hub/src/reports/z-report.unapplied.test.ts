import { newId, type OrderEvent } from '@pos/core'
import { escpos, type ZReport, zReportLines } from '@pos/printing'
import { HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { item } from '../access/hub-setup'
import { type Device, setupPrinting } from '../printing/printing-setup'
import { buildZReport } from './z-report'

// The printed Z report and money the hub did not apply (task 1.7b): by the owner's decision the
// paper does not change (no line of its own); the money just stays out of the register. History
// saved before the mark counts as before, and its Z reprints byte for byte.

const FORMAT = { columns: 48, page: 'pc850' } as const
const Z_KEYS = [
  'cash',
  'charged',
  'closed',
  'closedByName',
  'day',
  'justification',
  'opened',
  'openedByName',
  'otherMethods',
  'reprinted',
  'restaurant',
  'sales',
]

/** The hub before 1.7b: it saved the same event, without the verdict. */
class OldHubStore extends SqliteStore {
  override saveEvent(e: OrderEvent, fingerprint: string, aggregates: readonly string[]) {
    const { unapplied: _u, ...before } = e
    super.saveEvent(before as OrderEvent, fingerprint, aggregates)
  }
}

function world() {
  const t = setupPrinting()
  const ana = t.device('waiter')
  const registerA = t.device('admin', 'register')
  const registerB = t.device('cashier', 'register')
  const printer = t.newPrinter('Caja', [])
  t.db
    .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
    .run(JSON.stringify({ pre_bill_printer_id: printer.id }), t.restaurantId)
  const maxSequence = () =>
    Number(
      t.db
        .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
        .get(t.restaurantId)?.s,
    )
  const asShift = { aggregate_type: 'register_shift' }
  const openShift = (register: Device) => {
    const shift = newId()
    expect(
      register.submit(
        shift,
        'ShiftOpened',
        { register_id: register.connection.deviceId, base: 100_000 },
        asShift,
      ).status,
    ).toBe('confirmed')
    return shift
  }
  const cash = (shift: string, amount: number, tip: number, rounding: object | null) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method: 'cash',
    amount,
    tip,
    tendered: amount + tip,
    change: 0,
    rounding_adjustment: 0,
    rounding,
    cardTerminal: null,
    charge_reference: null,
  })
  const close = (
    register: Device,
    shift: string,
    expected: number,
    justification: string | null,
    target: HubSync = t.hub,
  ) => {
    const cashCount = newId()
    register.submit(
      shift,
      'CashCountRecorded',
      {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: expected / 1_000 }],
        counted_cash: expected,
      },
      asShift,
      target,
    )
    return register.submit(
      shift,
      'ShiftClosed',
      {
        cash_count_id: cashCount,
        expected_cash: expected,
        counted_cash: expected,
        variance: 0,
        justification,
        other_methods: [],
      },
      asShift,
      target,
    )
  }
  /**
   * A charges and closes a $40.000 table (tip $4.000); then B, which did not know, charges $10.000
   * on it (through `late`, the hub that receives it, started right then).
   */
  const day = (late: () => HubSync = () => t.hub) => {
    const shiftA = openShift(registerA)
    const shiftB = openShift(registerB)
    const order = t.open(ana)
    expect(ana.submit(order, 'ItemAdded', { ...item(), unit_price: 40_000 }).status).toBe(
      'confirmed',
    )
    const stale = maxSequence()
    const rounding = { multiple: 100, mode: 'nearest_half_down' }
    expect(
      registerA.submit(order, 'PaymentRecorded', cash(shiftA, 40_000, 4_000, rounding)).status,
    ).toBe('confirmed')
    expect(registerA.submit(order, 'OrderClosed', {}).status).toBe('confirmed')
    const charged = registerB.submit(
      order,
      'PaymentRecorded',
      cash(shiftB, 10_000, 0, null),
      { base_sequence: stale },
      late(),
    )
    expect(charged.result).toMatchObject({ status: 'confirmed', conflict: 'order_closed' })
    return { shiftA, shiftB, order, charged }
  }
  const options = { db: t.db, restaurantId: t.restaurantId, timeZone: t.timeZone }
  return { t, ana, registerA, registerB, printer, day, close, options }
}

/** The Z report frozen at close for that ShiftClosed event. */
const frozenZ = (t: ReturnType<typeof setupPrinting>, closeEventId: string) =>
  t.content(t.jobs("WHERE type = 'report'").find((f) => f.event_id === closeEventId)) as ZReport

describe('the Z report does not change with money the hub did not apply (task 1.7b)', () => {
  it('B’s close leaves the money out, asks for a justification, and its Z has the same lines as always', async () => {
    const { t, registerA, registerB, printer, day, close, options } = world()
    const { shiftA, shiftB, charged } = day()
    expect(charged.accepted?.unapplied).toBe(true)

    const closeA = close(registerA, shiftA, 144_000, null)
    expect(closeA.status).toBe('confirmed')
    expect(close(registerB, shiftB, 100_000, null).result).toMatchObject({
      status: 'rejected',
      reason: 'missing_justification',
    })
    const closeB = close(registerB, shiftB, 100_000, 'Cobré una mesa ya cerrada')
    expect(closeB.status).toBe('confirmed')

    const zA = frozenZ(t, closeA.accepted?.id as string)
    const zB = frozenZ(t, closeB.accepted?.id as string)
    expect(Object.keys(zA).sort()).toEqual(Z_KEYS)
    expect(Object.keys(zB).sort()).toEqual(Z_KEYS)
    expect(Object.keys(zB.cash)).toEqual(Object.keys(zA.cash))
    expect(Object.keys(zB.sales)).toEqual(Object.keys(zA.sales))
    expect(zB).toMatchObject({
      cash: { base: 100_000, charged: 0, refunds: 0, expected: 100_000, variance: 0 },
      charged: [],
      justification: 'Cobré una mesa ya cerrada',
    })
    expect(zA).toMatchObject({
      cash: { charged: 44_000, expected: 144_000 },
      charged: [{ name: 'Efectivo', sale: 40_000, tip: 4_000 }],
      sales: { net: 40_000, tips: 4_000, checks: 1 },
    })
    await t.queue.runOnce()
    const texts = printer.paper.texts()
    expect(texts).toHaveLength(2)
    for (const text of texts) expect(text).not.toMatch(/aplicad|10\.000/i)

    // Reprinted after a restart (from the database): the same, byte for byte.
    t.createHub()
    for (const [shift, z] of [
      [shiftA, zA],
      [shiftB, zB],
    ] as const) {
      const again = buildZReport(options, shift, null)
      expect(again).toEqual(z)
      expect(escpos(zReportLines(again as ZReport, FORMAT), FORMAT)).toEqual(
        escpos(zReportLines(z, FORMAT), FORMAT),
      )
    }
  })

  it('a payment saved before the mark counts as it always did, and its Z reprints byte for byte', () => {
    const { t, registerB, day, close, options } = world()
    const old = () =>
      new HubSync(new OldHubStore(t.db, t.restaurantId), {
        restaurantId: t.restaurantId,
        timeZone: t.timeZone,
        businessDayStart: '06:00',
        instance: 'hub-1',
        clock: () => new Date(t.clock()).toISOString(),
        access: t.access,
      })
    const { shiftB, charged } = day(old)
    const saved = t.db
      .prepare('SELECT unapplied FROM events WHERE restaurant_id = ? AND id = ?')
      .get(t.restaurantId, charged.result?.id as string)
    expect(saved?.unapplied).toBe(0)

    // The hub comes back up with what is stored: the old payment is in B's cash, as before 1.7b,
    // and closing needs no justification.
    const hub = t.createHub()
    expect(hub.reconciliation(shiftB)).toMatchObject({
      cash: { charged: 10_000, expected: 110_000 },
      byMethod: [{ method: 'cash', sale: 10_000, tip: 0, payments: 1 }],
      unapplied: [],
    })
    const closeB = close(registerB, shiftB, 110_000, null, hub)
    expect(closeB.status).toBe('confirmed')
    const z = frozenZ(t, closeB.accepted?.id as string)
    expect(z).toMatchObject({
      cash: { charged: 10_000, expected: 110_000, variance: 0 },
      charged: [{ name: 'Efectivo', sale: 10_000, tip: 0 }],
      justification: null,
    })
    const again = buildZReport(options, shiftB, null)
    expect(again).toEqual(z)
    expect(escpos(zReportLines(again as ZReport, FORMAT), FORMAT)).toEqual(
      escpos(zReportLines(z, FORMAT), FORMAT),
    )
  })
})
