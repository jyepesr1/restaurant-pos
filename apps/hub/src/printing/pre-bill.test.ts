import { fullConfig, newId, orderTaxes, orderTip, orderTotals } from '@pos/core'
import { COLUMNS, type PreBill } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { item } from '../access/hub-setup'
import { type Device, type PrintingSetup, setupPrinting } from './printing-setup'
import { jobsForEvent } from './tickets'

// The printed pre-bill (task 1.6): `PreBillPrinted` creates a `preBill` job in the queue with
// the amounts the hub calculates, the queue prints it and the pending list names it.

const shiftAndPayment = (register: Device, order: string, amount: number, extra: object = {}) => {
  const shift = newId()
  const opened = register.submit(
    shift,
    'ShiftOpened',
    { register_id: register.connection.deviceId, base: 0 },
    { aggregate_type: 'register_shift' },
  )
  expect(opened.status).toBe('confirmed')
  return payment(register, order, shift, amount, extra)
}
const payment = (
  register: Device,
  order: string,
  shift: string,
  amount: number,
  extra: object = {},
) =>
  register.submit(order, 'PaymentRecorded', {
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method: 'nequi',
    amount,
    tip: 0,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
    ...extra,
  })

function world(options: { width?: 58 | 80; withPrinter?: boolean } = {}) {
  const t = setupPrinting()
  const ana = t.device('waiter')
  const cashier = t.device('cashier', 'register')
  const admin = t.device('admin', 'register')
  const printer = t.newPrinter('Caja', [], { width: options.width ?? 80 })
  const select = (id: string | null) =>
    t.post('/api/register/pre-bill', { ...admin.sessionBody, printer_id: id }, admin.token)
  if (options.withPrinter !== false) {
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer.id }), t.restaurantId)
  }
  const addWith = (order: string, price: number, fields: object = {}) => {
    const it = { ...item(), unit_price: price, ...fields }
    const r = ana.submit(order, 'ItemAdded', it)
    expect(r.status).toBe('confirmed')
    return it
  }
  const preBill = (order: string, checkId: string | null = null, extra: object = {}) =>
    ana.submit(order, 'PreBillPrinted', {
      check_id: checkId,
      subtotal: 0,
      suggested_tip: 0,
      ...extra,
    })
  const saved = (): PreBill[] =>
    t.jobs("WHERE type = 'preBill'").map((f) => t.content(f) as PreBill)
  return { t, ana, cashier, admin, printer, select, addWith, preBill, saved }
}

describe('preBillJob: when it is created', () => {
  it('with no pre-bill printer chosen nothing is created, and the event is accepted', () => {
    const { t, ana, preBill, addWith } = world({ withPrinter: false })
    const order = t.open(ana)
    addWith(order, 40_900)
    const r = preBill(order)
    expect(r.status).toBe('confirmed')
    expect(t.jobs()).toEqual([])
    expect(t.saveFailures).toEqual([])
  })

  it('with a printer chosen it creates a pending pre-bill job for that printer', () => {
    const { t, ana, preBill, addWith, printer } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    preBill(order)
    const jobs = t.jobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      type: 'preBill',
      printer_id: printer.id,
      status: 'pending',
      attempts: 0,
      ticket_id: 'preBill',
      restaurant_id: t.restaurantId,
    })
    expect(jobs[0]?.event_id).toBeTruthy()
  })

  it('an archived printer does not receive pre-bills', () => {
    const { t, ana, preBill, addWith, printer } = world()
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(printer.id)
    const order = t.open(ana)
    addWith(order, 40_900)
    expect(preBill(order).status).toBe('confirmed')
    expect(t.jobs()).toEqual([])
  })

  it('if the printer is reactivated, the next pre-bill does print', () => {
    const { t, ana, preBill, addWith, printer } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(printer.id)
    preBill(order)
    t.db.prepare('UPDATE printers SET active = 1 WHERE id = ?').run(printer.id)
    preBill(order)
    expect(t.jobs()).toHaveLength(1)
  })

  it('a printer from another restaurant (tampered config) receives nothing', () => {
    const { t, ana, preBill, addWith } = world({ withPrinter: false })
    const other = newId()
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, new Date(t.clock()).toISOString(), new Date(t.clock()).toISOString())
    const foreign = newId()
    t.db
      .prepare(
        `INSERT INTO printers (id, restaurant_id, created_at, updated_at, version, name, connection, address, port, width)
         VALUES (?, ?, ?, ?, 1, 'Ajena', 'network', '10.9.9.9', 9100, 80)`,
      )
      .run(foreign, other, new Date(t.clock()).toISOString(), new Date(t.clock()).toISOString())
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: foreign }), t.restaurantId)
    const order = t.open(ana)
    addWith(order, 40_900)
    expect(preBill(order).status).toBe('confirmed')
    expect(t.jobs()).toEqual([])
  })

  it('choosing it and removing it through the route turns printing on and off', async () => {
    const { t, ana, preBill, addWith, printer, select } = world({ withPrinter: false })
    const order = t.open(ana)
    addWith(order, 40_900)
    preBill(order)
    expect(t.jobs()).toHaveLength(0)
    expect((await select(printer.id)).statusCode).toBe(204)
    preBill(order)
    expect(t.jobs()).toHaveLength(1)
    expect((await select(null)).statusCode).toBe(204)
    preBill(order)
    expect(t.jobs()).toHaveLength(1)
  })

  it('other order events do not create pre-bills', () => {
    const { t, ana, addWith } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    ana.submit(order, 'GuestsChanged', { guests: 3 })
    expect(t.jobs("WHERE type = 'preBill'")).toEqual([])
  })
})

describe('preBillJob: the amounts match the order', () => {
  it('carries restaurant, table, waiter, order number, guests and the lines', () => {
    const { t, ana, addWith, preBill, saved } = world()
    const table = t.table('5')
    const order = t.open(ana, table)
    addWith(order, 40_900, { name: 'Garden Margarita', quantity: 2 })
    addWith(order, 58_900, { name: 'Tagliata' })
    preBill(order)
    const [p] = saved()
    expect(p).toMatchObject({
      target: 'Mesa 5',
      waiter: 'Ana',
      order: 1,
      guests: 2,
      check: null,
    })
    expect(p?.restaurant).toBeTruthy()
    expect(p?.time).toMatch(/\d/)
    expect(p?.lines).toEqual([
      { quantity: 2, name: 'Garden Margarita', options: [], value: 81_800 },
      { quantity: 1, name: 'Tagliata', options: [], value: 58_900 },
    ])
  })

  it('total, subtotal and tip come from the order: 140.700 at 10 % gives 13.028', () => {
    const { t, ana, addWith, preBill, saved } = world()
    const order = t.open(ana)
    addWith(order, 81_800)
    addWith(order, 58_900)
    preBill(order, null, { suggested_tip: 13_028 })
    const [p] = saved()
    const status = t.hub.order(order)
    if (!status) throw new Error('no order')
    expect(p).toMatchObject({ total: 140_700, paid: 0, subtotal: 140_700, tipRate: 1000 })
    expect(p?.tip).toBe(orderTip(status, 140_700, fullConfig()))
    expect(p?.tip).toBe(13_028)
  })

  it('the hub calculates what is owed: the event subtotal is ignored', () => {
    const { t, ana, addWith, preBill, saved } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    preBill(order, null, { subtotal: 1, suggested_tip: 3_787 })
    const [p] = saved()
    expect(p?.subtotal).toBe(40_900)
    expect(p?.total).toBe(40_900)
  })

  it('the tip is the one chosen when requesting the pre-bill: the suggested one carries its rate; another does not', () => {
    const { t, ana, addWith, preBill, saved } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    preBill(order, null, { suggested_tip: 3_787 })
    preBill(order, null, { suggested_tip: 5_000 })
    preBill(order, null, { suggested_tip: 0 })
    expect(saved().map((p) => [p.tip, p.tipRate])).toEqual([
      [3_787, 1000],
      [5_000, null],
      [0, null],
    ])
    // The balance and the total do not depend on the chosen tip.
    for (const p of saved()) expect(p).toMatchObject({ subtotal: 40_900, total: 40_900 })
  })

  it('the sum of the lines is the total, and base + tax of each group adds up to the total', () => {
    const { t, ana, addWith, preBill, saved } = world()
    const order = t.open(ana)
    addWith(order, 12_900, { quantity: 3 })
    addWith(order, 16_000)
    addWith(order, 10_000, { tax_type: 'iva', rate: 1900 })
    addWith(order, 5_000, { tax_type: 'exempt', rate: 0 })
    preBill(order)
    const [p] = saved()
    expect(p?.lines.reduce((a, l) => a + l.value, 0)).toBe(p?.total)
    expect(p?.taxes?.reduce((a, i) => a + i.base + i.value, 0)).toBe(p?.total)
    expect(p?.taxes?.map((i) => i.name).sort()).toEqual(['Exento', 'INC 8 %', 'IVA 19 %'])
    expect(p?.taxes?.find((i) => i.name === 'Exento')?.value).toBe(0)
    const status = t.hub.order(order)
    if (!status) throw new Error('no order')
    expect(p?.taxes?.map((i) => i.value).sort()).toEqual(
      orderTaxes(status, 'half_up')
        .map((i) => i.tax)
        .sort(),
    )
  })

  it('the dish options print on its line', () => {
    const { t, ana, addWith, preBill, saved } = world()
    const order = t.open(ana)
    addWith(order, 58_900, {
      name: 'Tagliata',
      modifiers: [{ modifier_id: newId(), name: 'Término medio', extra_price: 0 }],
    })
    preBill(order)
    expect(saved()[0]?.lines[0]?.options).toEqual(['Término medio'])
  })

  it('a voided dish does not print; a partly voided one prints with the remaining units', () => {
    const { t, ana, addWith, preBill, saved } = world()
    const order = t.open(ana)
    const beers = addWith(order, 14_900, { name: 'Heineken', quantity: 3 })
    const dish = addWith(order, 40_900, { name: 'Pizza' })
    t.send(ana, order, [
      { id: beers.item_id, station: t.bar },
      { id: dish.item_id, station: t.kitchen },
    ])
    const voidItem = (item_id: string, quantity: number) =>
      ana.submit(order, 'ItemVoided', {
        item_id,
        quantity,
        already_prepared: false,
        ticket_id: null,
      })
    // The waiter cannot void what was sent: someone with the permission does it.
    const cashier = t.device('cashier', 'register')
    const cashierVoids = (item_id: string, quantity: number) =>
      cashier.submit(order, 'ItemVoided', {
        item_id,
        quantity,
        already_prepared: false,
        ticket_id: null,
      })
    expect(voidItem(dish.item_id, 1).status).toBe('rejected')
    expect(cashierVoids(beers.item_id, 1).status).toBe('confirmed')
    expect(cashierVoids(dish.item_id, 1).status).toBe('confirmed')
    preBill(order, null, { suggested_tip: 2_759 })
    const [p] = saved()
    expect(p?.lines).toEqual([{ quantity: 2, name: 'Heineken', options: [], value: 29_800 }])
    expect(p?.total).toBe(29_800)
    expect(p?.subtotal).toBe(29_800)
    expect(p?.tip).toBe(2_759)
  })

  it('a discount lowers the total and the tip', () => {
    const { t, ana, addWith, preBill, saved } = world()
    const cashier = t.device('cashier', 'register')
    const order = t.open(ana)
    const dish = addWith(order, 53_800)
    const r = cashier.submit(
      order,
      'DiscountApplied',
      {
        discount_id: newId(),
        scope: 'order',
        rule: 'percent',
        value: 1000,
        unit_count: null,
        amounts: [{ item_id: dish.item_id, amount: 5_380 }],
      },
      { reason: 'Cumpleaños' },
    )
    expect(r.status).toBe('confirmed')
    preBill(order, null, { suggested_tip: 4_483 })
    const [p] = saved()
    expect(p).toMatchObject({ total: 48_420, subtotal: 48_420, tip: 4_483, tipRate: 1000 })
    expect(p?.lines).toEqual([expect.objectContaining({ name: 'Aperol Spritz', value: 48_420 })])
  })

  it('with earlier payments: full total, what was already paid, the balance and the tip on the balance', () => {
    const { t, ana, cashier, addWith, preBill, saved } = world()
    const order = t.open(ana)
    addWith(order, 100_000)
    expect(shiftAndPayment(cashier, order, 40_000).status).toBe('confirmed')
    preBill(order, null, { suggested_tip: 5_556 })
    const [p] = saved()
    expect(p).toMatchObject({
      total: 100_000,
      paid: 40_000,
      subtotal: 60_000,
      tip: 5_556,
      tipRate: 1000,
      check: null,
    })
    // Σ lines = total (the pre-bill shows everything consumed, not just the balance).
    expect(p?.lines.reduce((a, l) => a + l.value, 0)).toBe(100_000)
  })

  it('a payment with its own tip does not change the suggested tip on the balance', () => {
    const { t, ana, cashier, addWith, preBill, saved } = world()
    const order = t.open(ana)
    addWith(order, 100_000)
    shiftAndPayment(cashier, order, 40_000, { tip: 4_000 })
    preBill(order, null, { suggested_tip: 5_556 })
    expect(saved()[0]).toMatchObject({
      paid: 40_000,
      subtotal: 60_000,
      tip: 5_556,
      tipRate: 1000,
    })
  })

  it('a fully paid order: balance 0 and tip 0', () => {
    const { t, ana, cashier, addWith, preBill, saved } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    shiftAndPayment(cashier, order, 40_900)
    preBill(order)
    expect(saved()[0]).toMatchObject({ total: 40_900, paid: 40_900, subtotal: 0, tip: 0 })
  })

  it('an empty table (no products) does not break either: all zero', () => {
    const { t, ana, preBill, saved } = world()
    const order = t.open(ana)
    expect(preBill(order).status).toBe('confirmed')
    expect(saved()[0]).toMatchObject({
      lines: [],
      total: 0,
      subtotal: 0,
      tip: 0,
      taxes: [],
    })
    expect(t.saveFailures).toEqual([])
  })

  it('a different tip rate in the restaurant: the pre-bill uses the current one', () => {
    const { t, ana, addWith, preBill, saved, printer } = world()
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer.id, suggested_tip: 500 }), t.restaurantId)
    const order = t.open(ana)
    addWith(order, 100_000)
    preBill(order, null, { suggested_tip: 4_630 })
    expect(saved()[0]).toMatchObject({ tipRate: 500, tip: 4_630 })
  })

  it('with the suggested tip at 0 %, the pre-bill has tip 0', () => {
    const { t, ana, addWith, preBill, saved, printer } = world()
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer.id, suggested_tip: 0 }), t.restaurantId)
    const order = t.open(ana)
    addWith(order, 100_000)
    preBill(order, null, { suggested_tip: 0 })
    expect(saved()[0]).toMatchObject({ tipRate: 0, tip: 0, subtotal: 100_000 })
  })

  it('the destination follows the order: takeout, several merged tables', () => {
    const { t, ana, addWith, preBill, saved } = world()
    const takeoutOrder = t.open(ana, null, 'takeout')
    addWith(takeoutOrder, 10_000)
    preBill(takeoutOrder)
    const m5 = t.table('5')
    const m6 = t.table('6')
    const group = t.open(ana, m5)
    addWith(group, 10_000)
    expect(ana.submit(group, 'TablesMerged', { table_ids: [m6] }).status).toBe('confirmed')
    preBill(group)
    expect(saved().map((p) => p.target)).toEqual(['Para llevar', 'Mesa 5 + 6'])
  })
})

describe('preBillJob: split check', () => {
  /** A $100.000 order split into two $50.000 checks (tips 4.630 and 4.629). */
  function divided() {
    const m = world()
    const { t, ana, cashier, addWith } = m
    const order = t.open(ana)
    addWith(order, 100_000)
    const checks = [
      {
        check_id: newId(),
        name: 'Cuenta 1',
        amount: 50_000,
        suggested_tip: 4_630,
        items: [],
      },
      {
        check_id: newId(),
        name: 'Cuenta 2',
        amount: 50_000,
        suggested_tip: 4_629,
        items: [],
      },
    ]
    expect(cashier.submit(order, 'CheckSplit', { checks }).status).toBe('confirmed')
    return { ...m, order, checks }
  }

  it('the pre-bill of a check carries its name, its amount and the tip fixed at split time', () => {
    const { preBill, saved, order, checks } = divided()
    preBill(order, checks[0]?.check_id, { suggested_tip: 4_630 })
    preBill(order, checks[1]?.check_id, { suggested_tip: 4_629 })
    const [a, b] = saved()
    expect(a).toMatchObject({
      check: { name: 'Cuenta 1', amount: 50_000 },
      subtotal: 50_000,
      tip: 4_630,
      tipRate: 1000,
      total: 100_000,
    })
    expect(b).toMatchObject({
      check: { name: 'Cuenta 2', amount: 50_000 },
      subtotal: 50_000,
      tip: 4_629,
      tipRate: 1000,
    })
    // The two tips add up to the whole order tip (9.259).
    expect((a?.tip ?? 0) + (b?.tip ?? 0)).toBe(9_259)
  })

  it('the pre-bill of the split order without requesting a check carries the whole balance', () => {
    const { preBill, saved, order } = divided()
    preBill(order, null, { suggested_tip: 9_259 })
    expect(saved()[0]).toMatchObject({ check: null, subtotal: 100_000, tip: 9_259 })
  })

  it('a check with a partial payment: its balance remains and the proportional part of its tip', () => {
    const { t, cashier, preBill, saved, order, checks } = divided()
    const check = checks[0]?.check_id as string
    const shift = newId()
    cashier.submit(
      shift,
      'ShiftOpened',
      { register_id: cashier.connection.deviceId, base: 0 },
      { aggregate_type: 'register_shift' },
    )
    expect(payment(cashier, order, shift, 20_000, { check_id: check }).status).toBe('confirmed')
    preBill(order, check, { suggested_tip: 2_778 })
    const [p] = saved()
    // 30.000 of 50.000 remain: the check tip (4.630) allocated between what was paid and the rest.
    expect(p).toMatchObject({
      check: { name: 'Cuenta 1', amount: 30_000 },
      subtotal: 30_000,
      tip: 2_778,
      tipRate: 1000,
      paid: 20_000,
    })
    expect(t.saveFailures).toEqual([])
  })

  it('a fully paid check prints balance 0 and tip 0', () => {
    const { cashier, preBill, saved, order, checks } = divided()
    const check = checks[1]?.check_id as string
    shiftAndPayment(cashier, order, 50_000, { check_id: check })
    preBill(order, check)
    expect(saved()[0]).toMatchObject({ subtotal: 0, tip: 0, check: { amount: 0 } })
  })

  it('a check that no longer exists (the split was undone) prints the order balance', () => {
    const { cashier, preBill, saved, order, checks } = divided()
    expect(cashier.submit(order, 'SplitUndone', {}).status).toBe('confirmed')
    preBill(order, checks[0]?.check_id, { suggested_tip: 9_259 })
    expect(saved()[0]).toMatchObject({ check: null, subtotal: 100_000, tip: 9_259 })
  })

  it('with earlier payments on the general check, the split check stays at what was split', () => {
    const m = world()
    const { t, ana, cashier, addWith, preBill, saved } = m
    const order = t.open(ana)
    addWith(order, 100_000)
    shiftAndPayment(cashier, order, 40_000)
    const checks = [
      {
        check_id: newId(),
        name: 'Cuenta 1',
        amount: 30_000,
        suggested_tip: 2_778,
        items: [],
      },
      {
        check_id: newId(),
        name: 'Cuenta 2',
        amount: 30_000,
        suggested_tip: 2_778,
        items: [],
      },
    ]
    expect(cashier.submit(order, 'CheckSplit', { checks }).status).toBe('confirmed')
    preBill(order, checks[0]?.check_id, { suggested_tip: 2_778 })
    expect(saved()[0]).toMatchObject({
      total: 100_000,
      paid: 40_000,
      subtotal: 30_000,
      tip: 2_778,
      check: { name: 'Cuenta 1', amount: 30_000 },
    })
  })
})

describe('preBillJob: no repeats', () => {
  it('the same event resent by the device does not create another job', () => {
    const { t, ana, addWith } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    const event = t.device('waiter')
    const data = { check_id: null, subtotal: 0, suggested_tip: 0 }
    const raw = t.event(event.connection, event.session, 'PreBillPrinted', data, {
      aggregate_id: order,
      base_sequence: Number(t.db.prepare('SELECT max(sequence) AS s FROM events').get()?.s ?? 0),
    } as never)
    const a = t.hub.receiveBatch(event.connection, [raw])
    const b = t.hub.receiveBatch(event.connection, [raw])
    expect(a.results[0]?.status).toBe('confirmed')
    expect(b.results[0]?.status).toBe('confirmed')
    expect(b.acceptedEvents).toEqual([])
    expect(t.jobs("WHERE type = 'preBill'")).toHaveLength(1)
  })

  it('reprocessing the same accepted event (hook retry) does not duplicate the job', () => {
    const { t, ana, addWith, preBill } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    const r = preBill(order)
    const after = t.hub.order(order)
    expect(r.accepted && after).toBeTruthy()
    jobsForEvent(t.ticketOptions, r.accepted as never, [{ before: after, after }])
    jobsForEvent(t.ticketOptions, r.accepted as never, [{ before: after, after }])
    expect(t.jobs("WHERE type = 'preBill'")).toHaveLength(1)
  })

  it('requesting the pre-bill twice is two events: two jobs (it can be reprinted)', () => {
    const { t, ana, addWith, preBill } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    preBill(order)
    preBill(order)
    expect(t.jobs("WHERE type = 'preBill'")).toHaveLength(2)
  })

  it('a pre-bill does not mix with tickets: sending to the kitchen does not create pre-bills', () => {
    const { t, ana, addWith } = world()
    t.newPrinter('Cocina', [t.kitchen])
    const order = t.open(ana)
    const dish = addWith(order, 40_900)
    t.send(ana, order, [{ id: dish.item_id, station: t.kitchen }])
    expect(t.jobs("WHERE type = 'preBill'")).toEqual([])
    expect(t.jobs("WHERE type = 'ticket'")).toHaveLength(1)
  })
})

describe('the queue prints the pre-bill', () => {
  it('prints on the pre-bill printer paper with the amounts and is marked printed', async () => {
    const { t, ana, addWith, preBill, printer } = world()
    const order = t.open(ana, t.table('5'))
    addWith(order, 40_900, { name: 'Garden Margarita', quantity: 2 })
    preBill(order, null, { suggested_tip: 7_574 })
    await t.queue.runOnce()
    const [paper] = printer.paper.texts()
    expect(paper).toContain('PRECUENTA')
    expect(paper).toContain('Mesa 5')
    expect(paper).toContain('2 x Garden Margarita')
    expect(paper).toContain('$81.800')
    expect(paper).toContain('Propina sugerida (10 %)')
    expect(paper).toContain('$7.574')
    expect(paper).toContain('$89.374')
    expect(t.pendingList()).toBe(0)
    expect(t.jobs("WHERE type = 'preBill'")[0]).toMatchObject({
      status: 'printed',
      attempts: 1,
      printed_on_id: printer.id,
    })
    expect(printer.paper.received).toHaveLength(1)
  })

  it('if the customer asked for another tip, the paper says «Propina» (not «sugerida») and adds that', async () => {
    const { t, ana, addWith, preBill, printer } = world()
    const order = t.open(ana, t.table('5'))
    addWith(order, 40_900)
    preBill(order, null, { suggested_tip: 5_000 })
    await t.queue.runOnce()
    const paper = (printer.paper.texts()[0] ?? '').replace(/[ ]+/g, ' ')
    expect(paper).toContain('Propina $5.000')
    expect(paper).not.toContain('Propina sugerida')
    expect(paper).toContain('$45.900')
  })

  it('without a tip the paper says «A pagar» with the balance', async () => {
    const { t, ana, addWith, preBill, printer } = world()
    const order = t.open(ana, t.table('5'))
    addWith(order, 40_900)
    preBill(order, null, { suggested_tip: 0 })
    await t.queue.runOnce()
    const paper = (printer.paper.texts()[0] ?? '').replace(/[ ]+/g, ' ')
    expect(paper).toContain('A pagar $40.900')
    expect(paper).not.toContain('Propina')
  })

  it('on a 58 mm printer the lines fit in 32 columns', async () => {
    const { t, ana, addWith, preBill, printer } = world({ width: 58 })
    const order = t.open(ana, t.table('5'))
    addWith(order, 40_900, { name: 'Garden Margarita con nombre bien largo', quantity: 2 })
    preBill(order)
    await t.queue.runOnce()
    const text = printer.paper.texts()[0] ?? ''
    expect(text).toContain('$81.800')
    for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(COLUMNS[58])
  })

  it('prints only once even if the queue makes more passes, and cuts the paper once', async () => {
    const { t, ana, addWith, preBill, printer } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    preBill(order)
    await t.queue.runOnce()
    await t.queue.runOnce()
    t.advance(60_000)
    await t.queue.runOnce()
    expect(printer.paper.received).toHaveLength(1)
  })

  it('with the printer off it stays pending and prints when it comes back, with the same amounts', async () => {
    const { t, ana, addWith, preBill, printer } = world()
    const order = t.open(ana)
    addWith(order, 40_900)
    printer.paper.off = true
    preBill(order)
    await t.queue.runOnce()
    expect(t.pendingList()).toBe(1)
    expect(t.jobs()[0]).toMatchObject({ attempts: 1 })
    // The order changes meanwhile: the pre-bill was already fixed with what there was then.
    addWith(order, 10_000)
    printer.paper.off = false
    t.advance(5_000)
    await t.queue.runOnce()
    expect(t.pendingList()).toBe(0)
    const text = printer.paper.texts()[0] ?? ''
    expect(text).toContain('$40.900')
    expect(text).not.toContain('$50.900')
  })

  it('the pre-bill goes to the fallback printer if the main one is still down', async () => {
    const { t, ana, addWith, preBill, printer } = world()
    const fallback = t.newPrinter('Barra', [])
    t.db.prepare('UPDATE printers SET fallback_id = ? WHERE id = ?').run(fallback.id, printer.id)
    printer.paper.off = true
    const order = t.open(ana)
    addWith(order, 40_900)
    preBill(order)
    // Three failures in a row; then, before the main one's wait expires, it prints on the fallback.
    for (let i = 0; i < 3; i++) {
      await t.queue.runOnce()
      t.advance(60_000)
    }
    t.advance(-60_000 + 1)
    await t.queue.runOnce()
    expect(fallback.paper.texts()[0]).toContain('PRECUENTA')
    expect(t.jobs("WHERE type = 'preBill'")[0]).toMatchObject({
      status: 'printed',
      printed_on_id: fallback.id,
    })
  })

  it('content that cannot be understood does not hold up the tickets behind it', async () => {
    const { t, ana, printer } = world()
    t.newPrinter('Cocina', [t.kitchen])
    const broken = newId()
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, event_id, ticket_id, content, created_at)
         VALUES (?, ?, ?, 'preBill', ?, 'preBill', '{"lines":"no es lista"}', ?)`,
      )
      .run(broken, t.restaurantId, printer.id, newId(), new Date(t.clock()).toISOString())
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    t.send(ana, order, items)
    await t.queue.runOnce()
    await t.queue.runOnce()
    expect(t.jobs("WHERE type = 'ticket'")[0]).toMatchObject({ status: 'printed' })
  })
})

describe('«Pedidos que no han salido»: the pre-bill is named', () => {
  const pendingList = async (t: PrintingSetup, e: Device) =>
    (await t.post('/api/printing/pending', e.sessionBody, e.token)).json() as {
      id: string
      printer: string
      what: string
      attempts: number
      error: string | null
    }[]

  it('«Precuenta · Mesa 5», with the printer and the error', async () => {
    const { t, ana, admin, addWith, preBill, printer } = world()
    printer.paper.off = true
    const order = t.open(ana, t.table('5'))
    addWith(order, 40_900)
    preBill(order)
    await t.queue.runOnce()
    const list = await pendingList(t, admin)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ what: 'Precuenta · Mesa 5', printer: 'Caja', attempts: 1 })
    expect(list[0]?.error).toContain('rechazó la conexión')
  })

  it('takeout: «Precuenta · Para llevar»; the cashier with record_payment sees it too', async () => {
    const { t, ana, cashier, addWith, preBill, printer } = world()
    printer.paper.off = true
    const order = t.open(ana, null, 'takeout')
    addWith(order, 40_900)
    preBill(order)
    const list = await pendingList(t, cashier)
    expect(list.map((x) => x.what)).toEqual(['Precuenta · Para llevar'])
  })

  it('a pre-bill that is no longer useful can be discarded', async () => {
    const { t, ana, admin, addWith, preBill, printer } = world()
    printer.paper.off = true
    const order = t.open(ana, t.table('5'))
    addWith(order, 40_900)
    preBill(order)
    const [job] = await pendingList(t, admin)
    const r = await t.post(
      '/api/printing/discard',
      { ...admin.sessionBody, job_id: job?.id },
      admin.token,
    )
    expect(r.statusCode).toBe(204)
    expect(await pendingList(t, admin)).toEqual([])
    expect(t.jobs("WHERE type = 'preBill'")[0]).toMatchObject({ status: 'discarded' })
  })

  it('tickets and pre-bills live in the same list, each with its name', async () => {
    const { t, ana, admin, addWith, preBill, printer } = world()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    printer.paper.off = true
    const table = t.table('7')
    const order = t.open(ana, table)
    const dish = addWith(order, 40_900, { name: 'Pizza' })
    t.send(ana, order, [{ id: dish.item_id, station: t.kitchen }])
    t.advance(1_000)
    preBill(order)
    const list = (await pendingList(t, admin)).map((x) => x.what)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatch(/^Cocina · Mesa 7/)
    expect(list[1]).toBe('Precuenta · Mesa 7')
  })

  it('a pre-bill with an empty destination does not leave «Precuenta · » dangling', async () => {
    const { t, admin, printer } = world()
    printer.paper.off = true
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES (?, ?, ?, 'preBill', '{}', ?)`,
      )
      .run(newId(), t.restaurantId, printer.id, new Date(t.clock()).toISOString())
    const list = await pendingList(t, admin)
    expect(list[0]?.what).toBe('Precuenta')
  })

  it('the hub orderTotals and the printed pre-bill match on the balance', () => {
    const { t, ana, cashier, addWith, preBill, saved } = world()
    const order = t.open(ana)
    addWith(order, 73_400)
    shiftAndPayment(cashier, order, 13_400)
    preBill(order)
    const status = t.hub.order(order)
    if (!status) throw new Error('no order')
    expect(saved()[0]?.subtotal).toBe(orderTotals(status).balance)
  })
})
