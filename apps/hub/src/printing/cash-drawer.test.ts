import { newId, type OrderEvent } from '@pos/core'
import { drawerPulse } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { item } from '../access/hub-setup'
import { CashDrawer, opensDrawer, STALE_MS } from './cash-drawer'
import { setupPrinting } from './printing-setup'
import { PrinterError, type Send } from './transport'

// The cash drawer (task 1.13): it opens on its own when cash goes in or out, only for what the hub
// applied and only right after it happened; it gets one attempt and one retry, and it is never
// stored as a print job.

const PULSE = [...drawerPulse()]
const asShift = { aggregate_type: 'register_shift' }

function world(options: Parameters<typeof setupPrinting>[0] = {}) {
  const t = setupPrinting(options)
  const register = t.device('admin', 'register')
  const ana = t.device('waiter')
  const printer = t.newPrinter('Caja', [])
  const chooseDrawer = (id: string | null) =>
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ cash_drawer_printer_id: id }), t.restaurantId)
  chooseDrawer(printer.id)
  const shift = newId()
  expect(
    register.submit(
      shift,
      'ShiftOpened',
      { register_id: register.connection.deviceId, base: 100_000 },
      asShift,
    ).status,
  ).toBe('confirmed')
  const order = t.open(ana)
  expect(ana.submit(order, 'ItemAdded', { ...item(), unit_price: 40_000 }).status).toBe('confirmed')
  const payment = (method: 'cash' | 'nequi', amount = 10_000) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method,
    amount,
    tip: 0,
    tendered: method === 'cash' ? amount : null,
    change: method === 'cash' ? 0 : null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
  })
  /** Records the payment and hands the saved event to the drawer, as `main.ts` does. */
  const charge = (method: 'cash' | 'nequi', extras: Record<string, unknown> = {}) => {
    const r = register.submit(order, 'PaymentRecorded', payment(method), extras)
    expect(r.status, JSON.stringify(r.result)).toBe('confirmed')
    t.drawer.afterSave(r.accepted as OrderEvent)
    return r
  }
  const movement = (extras: Record<string, unknown> = {}) => {
    const r = register.submit(
      shift,
      'CashMovementRecorded',
      {
        movement_id: newId(),
        type: 'cash_out',
        amount: 5_000,
        description: 'Hielo',
        to_whom: null,
        days: [],
      },
      { ...asShift, ...extras },
    )
    expect(r.status).toBe('confirmed')
    t.drawer.afterSave(r.accepted as OrderEvent)
    return r
  }
  const pulses = () => printer.paper.received.map((b) => [...b])
  return { t, register, order, printer, chooseDrawer, payment, charge, movement, pulses }
}

describe('when the drawer opens on its own', () => {
  it('a cash payment opens it once with the pulse, and nothing goes to print_jobs', async () => {
    const m = world()
    m.charge('cash')
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([PULSE])
    expect(m.t.jobs()).toEqual([])
    expect(m.t.drawerFailures).toEqual([])
  })

  it('a payment by any other method does not open it', async () => {
    const m = world()
    m.charge('nequi')
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([])
  })

  it('a cash movement (cash out) opens it', async () => {
    const m = world()
    m.movement()
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([PULSE])
  })

  it('a cash payment the hub saved as a conflict (unapplied) does not open it', async () => {
    const m = world()
    // Register B opens its shift; then A charges it all and closes it, and B did not know.
    const registerB = m.t.device('cashier', 'register')
    const shiftB = newId()
    registerB.submit(
      shiftB,
      'ShiftOpened',
      { register_id: registerB.connection.deviceId, base: 0 },
      asShift,
    )
    const stale = Number(m.t.db.prepare('SELECT max(sequence) AS s FROM events').get()?.s ?? 0)
    expect(m.register.submit(m.order, 'PaymentRecorded', m.payment('nequi', 40_000)).status).toBe(
      'confirmed',
    )
    expect(m.register.submit(m.order, 'OrderClosed', {}).status).toBe('confirmed')
    const late = registerB.submit(
      m.order,
      'PaymentRecorded',
      { ...m.payment('cash'), register_shift_id: shiftB },
      { base_sequence: stale },
    )
    expect(late.result).toMatchObject({ status: 'confirmed', conflict: 'order_closed' })
    expect(late.accepted?.unapplied).toBe(true)
    m.t.drawer.afterSave(late.accepted as OrderEvent)
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([])
  })

  it('a cash payment created offline more than 2 minutes ago does not open it when it arrives', async () => {
    const m = world()
    m.t.advance(10 * 60_000)
    const created = new Date(m.t.clock() - STALE_MS - 1000).toISOString()
    m.charge('cash', { device_time: created, hub_estimated_time: created })
    m.movement({ device_time: created, hub_estimated_time: created })
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([])
  })

  it('one created within the 2 minutes still opens it', async () => {
    const m = world()
    m.t.advance(10 * 60_000)
    const created = new Date(m.t.clock() - STALE_MS + 1000).toISOString()
    m.charge('cash', { device_time: created, hub_estimated_time: created })
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([PULSE])
  })

  it('without a drawer chosen, or with its printer archived, nothing is sent', async () => {
    const m = world()
    m.chooseDrawer(null)
    m.charge('cash')
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
    m.chooseDrawer(m.printer.id)
    m.t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(m.printer.id)
    m.charge('cash')
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
    expect(m.t.drawerFailures).toEqual([])
  })

  it('an event that was never stored (rolled back) does not open it', async () => {
    const m = world()
    const r = m.register.submit(m.order, 'PaymentRecorded', m.payment('nequi'))
    const accepted = r.accepted as OrderEvent<'PaymentRecorded'>
    const ghost = { ...accepted, id: newId(), data: { ...accepted.data, method: 'cash' } }
    m.t.drawer.afterSave(ghost as OrderEvent)
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
  })
})

describe('when the printer does not answer', () => {
  it('retries once and opens if the second attempt works', async () => {
    let failures = 1
    const m = world({
      send: (base) => async (target, bytes) => {
        if (failures-- > 0) throw new PrinterError('Ocupada')
        await base(target, bytes)
      },
    })
    m.charge('cash')
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([PULSE])
    expect(m.t.drawerFailures).toEqual([])
  })

  it('gives up after the retry, reports it once and leaves nothing pending', async () => {
    const m = world()
    m.printer.paper.off = true
    m.charge('cash')
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(2)
    expect(m.t.drawerFailures).toHaveLength(1)
    expect(m.t.drawerFailures[0]).toBeInstanceOf(PrinterError)
    expect(m.t.jobs()).toEqual([])
    // Turned on later: nothing opens by itself hours after.
    m.printer.paper.off = false
    await m.t.queue.runOnce()
    expect(m.pulses()).toEqual([])
  })

  it('a failure reading the config goes to onFailure and does not throw', () => {
    const m = world()
    const failures: unknown[] = []
    const drawer = new CashDrawer({
      db: m.t.db,
      restaurantId: m.t.restaurantId,
      clock: m.t.clock,
      onFailure: (e) => failures.push(e),
    })
    const r = m.register.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run('{"brand":7}', m.t.restaurantId)
    expect(() => drawer.afterSave(r.accepted as OrderEvent)).not.toThrow()
    expect(failures).toHaveLength(1)
  })
})

describe('opensDrawer', () => {
  const NOW = Date.parse('2026-11-08T15:00:00.000Z')
  const event = (type: string, data: object, extra: object = {}) =>
    ({
      type,
      data,
      hub_estimated_time: new Date(NOW - 1000).toISOString(),
      ...extra,
    }) as unknown as OrderEvent

  it.each([
    ['cash payment', 'PaymentRecorded', { method: 'cash' }, true],
    ['card payment', 'PaymentRecorded', { method: 'card' }, false],
    ['custom method payment', 'PaymentRecorded', { method: 'other' }, false],
    ['cash refund', 'RefundRecorded', { method: 'cash' }, true],
    ['Nequi refund', 'RefundRecorded', { method: 'nequi' }, false],
    ['cash in', 'CashMovementRecorded', { type: 'cash_in' }, true],
    ['cash out', 'CashMovementRecorded', { type: 'cash_out' }, true],
    ['tip payout', 'CashMovementRecorded', { type: 'tip_payout' }, true],
    ['voided payment', 'PaymentVoided', {}, false],
    ['register close', 'ShiftClosed', {}, false],
    ['register open', 'ShiftOpened', {}, false],
    ['order closed', 'OrderClosed', {}, false],
  ])('%s → %s', (_n, type, data, expected) => {
    expect(opensDrawer(event(type, data), NOW)).toBe(expected)
  })

  it('never for an unapplied event', () => {
    expect(
      opensDrawer(event('PaymentRecorded', { method: 'cash' }, { unapplied: true }), NOW),
    ).toBe(false)
    expect(opensDrawer(event('CashMovementRecorded', {}, { unapplied: true }), NOW)).toBe(false)
  })

  it('up to 2 minutes old exactly; a device clock slightly ahead also counts', () => {
    const at = (ms: number) =>
      event(
        'PaymentRecorded',
        { method: 'cash' },
        { hub_estimated_time: new Date(ms).toISOString() },
      )
    expect(opensDrawer(at(NOW - STALE_MS), NOW)).toBe(true)
    expect(opensDrawer(at(NOW - STALE_MS - 1), NOW)).toBe(false)
    expect(opensDrawer(at(NOW + 30_000), NOW)).toBe(true)
  })

  it('an unreadable time does not open it', () => {
    expect(
      opensDrawer(event('PaymentRecorded', { method: 'cash' }, { hub_estimated_time: 'x' }), NOW),
    ).toBe(false)
  })
})

describe('CashDrawer.open (the test button)', () => {
  it('sends the pulse once to the chosen printer, with no retry', async () => {
    const sent: { address: string; bytes: number[] }[] = []
    const send: Send = async (target, bytes) => {
      sent.push({ address: target.address, bytes: [...bytes] })
      throw new PrinterError('No hay papel')
    }
    const t = setupPrinting()
    const p = t.newPrinter('Caja', [], { connection: 'usb', address: 'POS-80 Caja', port: null })
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ cash_drawer_printer_id: p.id }), t.restaurantId)
    const drawer = new CashDrawer({ db: t.db, restaurantId: t.restaurantId, send, retryMs: 1 })
    expect(drawer.connected()).toBe(true)
    await expect(drawer.open()).rejects.toThrow('No hay papel')
    expect(sent).toEqual([{ address: 'POS-80 Caja', bytes: PULSE }])
  })

  it('without a drawer it says to choose the printer first', async () => {
    const t = setupPrinting()
    const drawer = new CashDrawer({ db: t.db, restaurantId: t.restaurantId })
    expect(drawer.connected()).toBe(false)
    await expect(drawer.open()).rejects.toBeInstanceOf(PrinterError)
  })
})
