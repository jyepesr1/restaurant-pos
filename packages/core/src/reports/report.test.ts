import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { applyEvent } from '../order/apply'
import type { OrderState } from '../order/state'
import { orderTotals } from '../order/totals'
import {
  cardPaymentData,
  cashPaymentData,
  event,
  inOrder,
  itemCopy,
  SHIFT,
} from '../testing/factory'
import { type ReportInput, report } from './report'

// The basic reports (task 1.9) with the formulas from docs/KPIS.md.

const ANA = newId()
const LUIS = newId()
const CONFIG: ReportInput['config'] = {
  sales_by_waiter: 'added_by',
  rounding_mode: 'half_up',
}

function apply(events: OrderEvent[], from: OrderState | null = null): OrderState {
  return events.reduce<OrderState | null>((status, e) => {
    const r = applyEvent(status, inOrder(e, status?.lastSequence ?? 0))
    if (r.issue) throw new Error(`${e.type}: ${r.issue.type}`)
    return r.status
  }, from) as OrderState
}

/** An order with its events, to build scenarios and keep the ones in the period. */
function order(guests = 2, waiter = ANA) {
  const id = newId()
  const events: OrderEvent[] = [
    event(
      id,
      'OrderOpened',
      { channel: 'dine_in', table_id: newId(), guests },
      { user_id: waiter },
    ),
  ]
  const add = (fields: Parameters<typeof itemCopy>[0] = {}, lookup = waiter) => {
    const item = itemCopy(fields)
    events.push(event(id, 'ItemAdded', item, { user_id: lookup }))
    // Sent to the kitchen right away: only what was sent is voided (the rest is removed).
    events.push(
      event(id, 'ItemsSent', {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [item.item_id] }],
      }),
    )
    return item
  }
  const record = (e: OrderEvent) => {
    events.push(e)
    return e
  }
  return {
    id,
    events,
    add,
    record,
    pay: (data: ReturnType<typeof cashPaymentData>, day = '2026-10-24') =>
      record(event(id, 'PaymentRecorded', data, { business_day: day })),
    close: (day = '2026-10-24') => record(event(id, 'OrderClosed', {}, { business_day: day })),
    status: () => apply(events),
  }
}

const period = { from: '2026-10-24', until: '2026-10-24' }

describe('report: sales', () => {
  it('adds gross, voided, discounts, net, tips, checks and guests', () => {
    const a = order(3)
    const margarita = a.add({ unit_price: 40_900, quantity: 2 })
    a.record(
      event(
        a.id,
        'ItemVoided',
        { item_id: margarita.item_id, quantity: 1, already_prepared: true, ticket_id: null },
        { reason: 'Se cayó' },
      ),
    )
    a.add({ unit_price: 12_000, tax_type: 'iva', rate: 1900 })
    a.pay(cashPaymentData(52_900, { tip: 5_000 }))
    a.close()

    const b = order(2, LUIS)
    b.add({ unit_price: 30_000 })
    b.pay(cardPaymentData(30_000, { tip: 3_000 }))
    b.close()

    const r = report({
      ...period,
      closedIds: [a.status(), b.status()],
      related: [],
      events: [...a.events, ...b.events],
      config: CONFIG,
    })
    expect(r.sales).toMatchObject({
      gross: 81_800 + 12_000 + 30_000,
      voided: 40_900,
      discounts: 0,
      net: 82_900,
      tips: 8_000,
      checks: 2,
      guests: 5,
      averageTicket: 41_450,
      spendPerGuest: 16_580,
    })
    // Base plus tax gives the net.
    expect(r.sales.taxes.reduce((s, i) => s + i.base + i.tax, 0)).toBe(82_900)
    expect(r.sales.taxes.map((i) => `${i.type}:${i.rate}`)).toEqual(['inc:800', 'iva:1900'])
  })

  it('the average ticket rounds half up and gives 0 without checks or guests', () => {
    const p = [10_001, 10_000].map((price) => {
      const x = order(0)
      x.add({ unit_price: price })
      x.pay(cashPaymentData(price))
      x.close()
      return x
    })
    const r = report({
      ...period,
      closedIds: p.map((x) => x.status()),
      related: [],
      events: p.flatMap((x) => x.events),
      config: CONFIG,
    })
    expect(r.sales.averageTicket).toBe(10_001) // 20.001 ÷ 2 = 10.000,5 → 10.001
    expect(r.sales.spendPerGuest).toBe(0)

    const empty = report({
      ...period,
      closedIds: [],
      related: [],
      events: [],
      config: CONFIG,
    })
    expect(empty.sales).toMatchObject({ net: 0, checks: 0, averageTicket: 0 })
  })

  it('a full comp does not count as a check but does count as guests', () => {
    const x = order(4)
    const item = x.add({ unit_price: 20_000 })
    x.record(
      event(
        x.id,
        'DiscountApplied',
        {
          discount_id: newId(),
          scope: 'item',
          rule: 'comp',
          value: 0,
          unit_count: 1,
          amounts: [{ item_id: item.item_id, amount: 20_000 }],
        },
        { reason: 'Cumpleaños' },
      ),
    )
    x.close()
    const r = report({
      ...period,
      closedIds: [x.status()],
      related: [],
      events: x.events,
      config: CONFIG,
    })
    expect(r.sales).toMatchObject({ gross: 20_000, discounts: 20_000, net: 0, checks: 0 })
    expect(r.sales.guests).toBe(4)
    expect(r.discounts).toEqual([
      {
        orderId: x.id,
        orderNumber: null,
        rule: 'comp',
        value: 0,
        amount: 20_000,
        reason: 'Cumpleaños',
      },
    ])
    expect(r.byWaiter).toEqual([])
  })
})

describe('report: by payment method', () => {
  it('counts the payments recorded in the period, not those of the closed order', () => {
    // A partial payment from yesterday on an order closed today: counts yesterday by method and
    // today in sales.
    const x = order()
    x.add({ unit_price: 50_000 })
    x.pay(cardPaymentData(20_000), '2026-10-23')
    x.pay(cashPaymentData(30_000, { tip: 2_000 }))
    x.close()
    const r = report({
      ...period,
      closedIds: [x.status()],
      related: [],
      events: x.events,
      config: CONFIG,
    })
    expect(r.sales.net).toBe(50_000)
    expect(r.byMethod).toEqual([
      expect.objectContaining({ method: 'cash', sale: 30_000, tip: 2_000 }),
    ])
    expect(r.tipPool).toEqual({ tips: 2_000, paidOut: 0, balance: 2_000 })
  })

  it('a void today of a payment from yesterday subtracts today', () => {
    const x = order()
    x.add({ unit_price: 15_000 })
    const payment = cardPaymentData(15_000, { tip: 1_500 })
    x.pay(payment, '2026-10-23')
    x.record(
      event(
        x.id,
        'PaymentVoided',
        { payment_id: payment.payment_id, register_shift_id: SHIFT },
        { reason: 'Error', business_day: '2026-10-24' },
      ),
    )
    const r = report({
      ...period,
      closedIds: [],
      related: [x.status()],
      events: x.events,
      config: CONFIG,
    })
    expect(r.byMethod).toEqual([
      expect.objectContaining({ method: 'card', sale: -15_000, tip: -1_500 }),
    ])
    expect(r.tipPool.tips).toBe(-1_500)
  })
})

describe('report: by waiter and by product', () => {
  it('credits whoever added each item, or the table waiter if so configured', () => {
    const x = order(2, ANA)
    x.add({ unit_price: 40_000 }, ANA)
    x.add({ unit_price: 10_000 }, LUIS)
    x.pay(cashPaymentData(50_000))
    x.close()
    const entry = {
      ...period,
      closedIds: [x.status()],
      related: [],
      events: x.events,
    }
    expect(report({ ...entry, config: CONFIG }).byWaiter).toEqual([
      { userId: ANA, net: 40_000, checks: 1, averageTicket: 40_000 },
      { userId: LUIS, net: 10_000, checks: 1, averageTicket: 10_000 },
    ])
    const assigned = report({
      ...entry,
      config: { ...CONFIG, sales_by_waiter: 'assigned_waiter' },
    })
    expect(assigned.byWaiter).toEqual([
      { userId: x.status().assignedWaiterId, net: 50_000, checks: 1, averageTicket: 50_000 },
    ])
  })

  it('groups by product and variant, with units sold excluding voided ones', () => {
    const product = newId()
    const another = newId()
    const x = order()
    const a = x.add({ product_id: product, quantity: 3, unit_price: 10_000 })
    x.add({ product_id: product, quantity: 1, unit_price: 10_000 })
    x.add({
      product_id: product,
      variant_id: another,
      name: 'Grande',
      unit_price: 15_000,
    })
    x.record(
      event(
        x.id,
        'ItemVoided',
        { item_id: a.item_id, quantity: 3, already_prepared: false, ticket_id: null },
        { reason: 'Cambió de idea' },
      ),
    )
    x.pay(cashPaymentData(25_000))
    x.close()
    const r = report({
      ...period,
      closedIds: [x.status()],
      related: [],
      events: x.events,
      config: CONFIG,
    })
    expect(r.byProduct).toEqual([
      expect.objectContaining({ variantId: another, units: 1, net: 15_000 }),
      expect.objectContaining({ variantId: null, units: 1, net: 10_000 }),
    ])
    expect(r.byProduct.reduce((s, p) => s + p.net, 0)).toBe(r.sales.net)
    expect(r.voids).toEqual([
      expect.objectContaining({
        orderId: x.id,
        units: 3,
        value: 30_000,
        reason: 'Cambió de idea',
        alreadyPrepared: false,
      }),
    ])
  })
})

describe('report: voids, cancellations and register', () => {
  it('lists the cancellations in the period with what the order had', () => {
    const x = order()
    x.add({ unit_price: 22_000 })
    x.record(event(x.id, 'OrderCanceled', {}, { reason: 'Se fueron' }))
    const status = x.status()
    const r = report({
      ...period,
      closedIds: [],
      related: [status],
      events: x.events,
      config: CONFIG,
    })
    expect(r.cancellations).toEqual([
      expect.objectContaining({ orderId: x.id, value: 22_000, reason: 'Se fueron' }),
    ])
    expect(r.sales.net).toBe(0)
  })

  it('leaves out what was recorded outside the period', () => {
    const x = order()
    const item = x.add({ unit_price: 9_000, quantity: 2 })
    x.record(
      event(
        x.id,
        'ItemVoided',
        { item_id: item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        { reason: 'm', business_day: '2026-10-25' },
      ),
    )
    const r = report({
      ...period,
      closedIds: [],
      related: [x.status()],
      events: x.events,
      config: CONFIG,
    })
    expect(r.voids).toEqual([])
  })

  it('the tip pool subtracts what was paid out from the register in the period', () => {
    const x = order()
    x.add({ unit_price: 40_000 })
    x.pay(cashPaymentData(40_000, { tip: 4_000 }))
    x.close()
    const shift = newId()
    const tipPayout = event(
      shift,
      'CashMovementRecorded',
      {
        movement_id: newId(),
        type: 'tip_payout',
        amount: 3_000,
        description: 'Propinas',
        to_whom: 'Equipo',
        days: ['2026-10-24'],
      },
      { aggregate_type: 'register_shift' } as never,
    )
    const r = report({
      ...period,
      closedIds: [x.status()],
      related: [],
      events: [...x.events, tipPayout],
      config: CONFIG,
    })
    expect(r.tipPool).toEqual({ tips: 4_000, paidOut: 3_000, balance: 1_000 })
  })

  it('the net matches what was paid for the closed orders (KPIS.md identity)', () => {
    const orders = [12_345, 67_890, 1_000].map((price, i) => {
      const x = order(i + 1)
      x.add({ unit_price: price })
      x.pay(cashPaymentData(price))
      x.close()
      return x.status()
    })
    const r = report({
      ...period,
      closedIds: orders,
      related: [],
      events: [],
      config: CONFIG,
    })
    expect(r.sales.net).toBe(orders.reduce((s, p) => s + orderTotals(p).net, 0))
  })
})

describe('report: taxes and rounding adjustment (money audit)', () => {
  it('adds the hundredths of all orders and rounds only once: 3 × $16.000 at 8 % = $3.556', () => {
    const orders = [1, 2, 3].map(() => {
      const x = order()
      x.add({ unit_price: 16_000 })
      x.pay(cashPaymentData(16_000))
      x.close()
      return x.status()
    })
    const r = report({
      ...period,
      closedIds: orders,
      related: [],
      events: [],
      config: CONFIG,
    })
    // Each order rounded would give $1.185 × 3 = $3.555.
    expect(r.sales.taxes).toEqual([{ type: 'inc', rate: 800, base: 44_444, tax: 3_556 }])
  })

  it('the cash rounding adjustment is its own line, and does not change the net', () => {
    const x = order()
    x.add({ unit_price: 36_810 })
    x.pay(cashPaymentData(36_810, { rounding_adjustment: -10 }))
    x.close()
    const r = report({
      ...period,
      closedIds: [x.status()],
      related: [],
      events: x.events,
      config: CONFIG,
    })
    expect(r.sales).toMatchObject({ net: 36_810, roundingAdjustments: -10 })
    expect(r.byMethod[0]).toMatchObject({ method: 'cash', sale: 36_800 })
  })

  it('a void takes the order item as it was when voided (even if it is moved later)', () => {
    const x = order()
    const lemonade = x.add({ name: 'Limonada', unit_price: 12_000, quantity: 2 })
    const voidEntry = x.record(
      event(
        x.id,
        'ItemVoided',
        { item_id: lemonade.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        { reason: 'm' },
      ),
    )
    const before = x.status()
    // Without the state at void time, an order that no longer has the item would show it at $0.
    const empty = { ...before, items: {} }
    const r = report({
      ...period,
      closedIds: [],
      related: [empty],
      onVoid: new Map([[voidEntry.id, before]]),
      events: x.events,
      config: CONFIG,
    })
    expect(r.voids).toEqual([
      expect.objectContaining({ name: 'Limonada', units: 1, value: 12_000 }),
    ])
  })
})
