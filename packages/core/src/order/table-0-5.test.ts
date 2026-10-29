import { describe, expect, it } from 'vitest'
import { ORDER_EVENT_TYPES, type OrderEvent } from '../events/order'
import { newId } from '../id'
import {
  allocate,
  allocateOrderDiscount,
  chargedInCash,
  equalParts,
  percent,
  suggestedTip,
} from '../money'
import {
  again,
  cardPaymentData,
  cashPaymentData,
  event,
  itemCopy,
  SHIFT,
  WAITER,
} from '../testing/factory'
import { applyAll, issueOf, orderOpened, sendItems } from '../testing/helpers'
import { applyEvent } from './apply'
import type { OrderState } from './state'
import { checkBalance, itemTotals, orderTotals } from './totals'

// Cases from the task 0.5 table (docs/DINERO.md) not covered by apply.test.ts or
// guards.test.ts: payments, cash, splitting, discounts, reports and projection.

const REASON = { reason: 'Motivo de prueba' }

function discountEvent(
  order: string,
  scope: 'item' | 'order',
  rule: 'percent' | 'value' | 'comp',
  value: number,
  amounts: [string, number][],
  units: number | null = null,
) {
  return event(
    order,
    'DiscountApplied',
    {
      discount_id: newId(),
      scope,
      rule,
      value,
      unit_count: units,
      amounts: amounts.map(([item_id, amount]) => ({ item_id, amount })),
    },
    REASON,
  )
}

const checksOf = (amounts: number[], tips: number[] = []) =>
  amounts.map((amount, i) => ({
    check_id: newId(),
    name: `Cuenta ${i + 1}`,
    amount,
    suggested_tip: tips[i] ?? 0,
    items: [],
  }))

describe('payments', () => {
  it('mixed payment: card and then rounded cash; only the last one carries an adjustment', () => {
    const { order, status } = orderOpened()
    const item = itemCopy({ unit_price: 100_000 })
    const withCard = applyAll(
      [event(order, 'ItemAdded', item), event(order, 'PaymentRecorded', cardPaymentData(63_190))],
      status,
    )
    const balance = orderTotals(withCard).balance
    expect(balance).toBe(36_810)
    expect(chargedInCash(balance, 100) - balance).toBe(-10)

    const closed = applyAll(
      [
        event(
          order,
          'PaymentRecorded',
          cashPaymentData(balance, { rounding_adjustment: -10, change: 3200 }),
        ),
        event(order, 'OrderClosed', {}),
      ],
      withCard,
    )
    expect(closed.status).toBe('closed')
    expect(orderTotals(closed)).toMatchObject({
      paid: 100_000,
      balance: 0,
      roundingAdjustments: -10,
    })
    // Σ charged = Σ amount + Σ adjustment: 99.990 in total.
    const charged = Object.values(closed.payments).reduce(
      (a, p) => a + p.amount + p.roundingAdjustment,
      0,
    )
    expect(charged).toBe(99_990)
  })

  it('$30 and $50 balance after a card payment: $0 charged, negative adjustment, closes', () => {
    for (const rest of [30, 50]) {
      const { order, status } = orderOpened()
      const ready = applyAll(
        [
          event(order, 'ItemAdded', itemCopy({ unit_price: 40_000 + rest })),
          event(order, 'PaymentRecorded', cardPaymentData(40_000)),
          event(order, 'PaymentRecorded', cashPaymentData(rest, { rounding_adjustment: -rest })),
          event(order, 'OrderClosed', {}),
        ],
        status,
      )
      expect(ready.status).toBe('closed')
      expect(orderTotals(ready)).toMatchObject({ balance: 0, roundingAdjustments: -rest })
    }
  })

  it('balance that is a multiple of 100: no adjustment', () => {
    const { order, status } = orderOpened()
    const paid = applyAll(
      [
        event(order, 'ItemAdded', itemCopy({ unit_price: 36_800 })),
        event(order, 'PaymentRecorded', cashPaymentData(36_800)),
      ],
      status,
    )
    expect(orderTotals(paid)).toMatchObject({ balance: 0, roundingAdjustments: 0 })
    expect(Object.values(paid.payments)[0]?.roundingAdjustment).toBe(0)
  })

  it('the change the customer leaves is recorded as a tip', () => {
    const { order, status } = orderOpened()
    const withItem = applyAll([event(order, 'ItemAdded', itemCopy({ unit_price: 36_810 }))], status)
    // Gives $40.000 for $36.810 (36.800 is charged): the $3.200 change is left as a tip.
    const withTip = cashPaymentData(36_810, { rounding_adjustment: -10, tip: 3200, change: 0 })
    expect(withTip.tendered).toBe(40_000)
    const final = applyAll([event(order, 'PaymentRecorded', withTip)], withItem)
    expect(orderTotals(final)).toMatchObject({ balance: 0, tips: 3200, roundingAdjustments: -10 })

    const withChange = applyAll(
      [
        event(
          order,
          'PaymentRecorded',
          cashPaymentData(36_810, { rounding_adjustment: -10, change: 3200 }),
        ),
      ],
      withItem,
    )
    expect(orderTotals(withChange)).toMatchObject({ balance: 0, tips: 0 })
  })

  it('a void in another shift keeps the payment in its own shift and restores the balance', () => {
    const { order, status } = orderOpened()
    const payment = cardPaymentData(40_900)
    const otherShift = newId()
    const paid = applyAll(
      [event(order, 'ItemAdded', itemCopy()), event(order, 'PaymentRecorded', payment)],
      status,
    )
    const voided = applyAll(
      [
        event(
          order,
          'PaymentVoided',
          { payment_id: payment.payment_id, register_shift_id: otherShift },
          REASON,
        ),
      ],
      paid,
    )
    expect(voided.payments[payment.payment_id]).toMatchObject({
      registerShiftId: SHIFT,
      voided: true,
    })
    expect(orderTotals(voided)).toMatchObject({
      paid: 0,
      balance: 40_900,
      tips: 0,
      roundingAdjustments: 0,
    })
  })

  it('a voided payment does not count toward the adjustment and does not allow closing', () => {
    const { order, status } = orderOpened()
    const payment = cashPaymentData(36_810, { rounding_adjustment: -10, change: 3200 })
    const voided = applyAll(
      [
        event(order, 'ItemAdded', itemCopy({ unit_price: 36_810 })),
        event(order, 'PaymentRecorded', payment),
        event(
          order,
          'PaymentVoided',
          { payment_id: payment.payment_id, register_shift_id: SHIFT },
          REASON,
        ),
      ],
      status,
    )
    expect(orderTotals(voided)).toMatchObject({ roundingAdjustments: 0, balance: 36_810 })
    expect(issueOf(voided, event(order, 'OrderClosed', {}))).toBe('pending_balance')
  })

  describe('refunds', () => {
    function withPayment(method: 'card' | 'cash') {
      const { order, status } = orderOpened()
      const payment =
        method === 'card'
          ? cardPaymentData(20_000, { tip: 2000 })
          : cashPaymentData(36_850, { rounding_adjustment: -50, tip: 1000 })
      const final = applyAll(
        [
          event(order, 'ItemAdded', itemCopy({ unit_price: method === 'card' ? 20_000 : 36_850 })),
          event(order, 'PaymentRecorded', payment),
        ],
        status,
      )
      const issueRefund = (sale: number, tip: number) =>
        event(
          order,
          'RefundRecorded',
          {
            payment_id: payment.payment_id,
            refund_id: newId(),
            sale_amount: sale,
            tip_amount: tip,
            method,
            register_shift_id: newId(),
          },
          REASON,
        )
      return { order, status: final, payment, issueRefund }
    }

    it('partial and cumulative, split into sale and tip, without exceeding what was paid', () => {
      const { status, payment, issueRefund } = withPayment('card')
      const afterFirstRefund = applyAll([issueRefund(5000, 500)], status)
      expect(afterFirstRefund.payments[payment.payment_id]).toMatchObject({
        refundedSale: 5000,
        refundedTip: 500,
      })
      expect(orderTotals(afterFirstRefund)).toMatchObject({
        paid: 15_000,
        tips: 1500,
        balance: 5000,
      })

      // Second refund: sale and tip each count separately against their own cap.
      expect(issueOf(afterFirstRefund, issueRefund(15_001, 0))).toBe('refund_exceeds')
      expect(issueOf(afterFirstRefund, issueRefund(0, 1501))).toBe('refund_exceeds')
      const afterSecondRefund = applyAll([issueRefund(15_000, 1500)], afterFirstRefund)
      expect(orderTotals(afterSecondRefund)).toMatchObject({ paid: 0, tips: 0, balance: 20_000 })
      expect(issueOf(afterSecondRefund, issueRefund(1, 0))).toBe('refund_exceeds')
      expect(issueOf(afterSecondRefund, issueRefund(0, 1))).toBe('refund_exceeds')
    })

    it('a tip-only refund does not touch the sale', () => {
      const { status, issueRefund } = withPayment('card')
      const final = applyAll([issueRefund(0, 2000)], status)
      expect(orderTotals(final)).toMatchObject({ paid: 20_000, tips: 0, balance: 0 })
    })

    it('in cash with a negative adjustment the total refunded does not exceed the charge', () => {
      // Charged = 36.850 − 50 + 1.000 tip = 37.800.
      const { status, issueRefund } = withPayment('cash')
      expect(issueOf(status, issueRefund(36_850, 1000))).toBe('refund_exceeds')
      const partial = applyAll([issueRefund(36_000, 0)], status)
      // 1.800 left to refund (37.800 − 36.000).
      expect(issueOf(partial, issueRefund(801, 1000))).toBe('refund_exceeds')
      // Refunding the whole charged sale (36.800) would leave the adjustment dangling: a void is
      // required.
      expect(issueOf(partial, issueRefund(800, 1000))).toBe('use_void')
      expect(issueOf(partial, issueRefund(750, 1000))).toBeUndefined()
    })

    it('a fully refunded payment allows canceling the order', () => {
      const { order, status, issueRefund } = withPayment('card')
      const returned = applyAll([issueRefund(20_000, 2000)], status)
      expect(applyAll([event(order, 'OrderCanceled', {}, REASON)], returned).status).toBe(
        'canceled',
      )
    })
  })
})

describe('check split', () => {
  it('does not allow a single check (the schema requires at least two)', () => {
    const { order } = orderOpened()
    expect(equalParts(87_650, 1)).toEqual([87_650])
    expect(() => event(order, 'CheckSplit', { checks: checksOf([87_650]) })).toThrow(
      /Invalid test event/,
    )
  })

  it('by items: each check carries its dishes and paying them all closes the order', () => {
    const { order, status } = orderOpened()
    const pizza = itemCopy()
    const pasta = itemCopy({ unit_price: 12_900 })
    const [ana, luis] = checksOf([40_900, 12_900])
    if (!ana || !luis) throw new Error('missing checks')
    const divided = applyAll(
      [
        event(order, 'ItemAdded', pizza),
        event(order, 'ItemAdded', pasta),
        event(order, 'CheckSplit', {
          checks: [
            { ...ana, items: [{ item_id: pizza.item_id, fraction: { n: 1, d: 1 } }] },
            { ...luis, items: [{ item_id: pasta.item_id, fraction: { n: 1, d: 1 } }] },
          ],
        }),
      ],
      status,
    )
    expect(divided.checks?.map((c) => c.amount)).toEqual([40_900, 12_900])
    const closed = applyAll(
      [
        event(order, 'PaymentRecorded', cardPaymentData(40_900, { check_id: ana.check_id })),
        event(order, 'PaymentRecorded', cardPaymentData(12_900, { check_id: luis.check_id })),
        event(order, 'OrderClosed', {}),
      ],
      divided,
    )
    expect(closed.status).toBe('closed')
  })

  it('item shared 1/3 and several shared: the checks add up to the order total', () => {
    const { order, status } = orderOpened()
    const bottle = itemCopy({ unit_price: 40_900 })
    const picada = itemCopy({ unit_price: 38_500 })
    const own = itemCopy({ unit_price: 12_900 })
    const fromBottle = allocate(40_900, [1, 1, 1])
    const fromPicada = allocate(38_500, [1, 1, 0])
    const amounts = [12_900, 0, 0].map((p, i) => p + (fromBottle[i] ?? 0) + (fromPicada[i] ?? 0))
    const checks = checksOf(amounts).map((c, i) => ({
      ...c,
      items: [
        { item_id: bottle.item_id, fraction: { n: 1, d: 3 } },
        ...(i < 2 ? [{ item_id: picada.item_id, fraction: { n: 1, d: 2 } }] : []),
        ...(i === 0 ? [{ item_id: own.item_id, fraction: { n: 1, d: 1 } }] : []),
      ],
    }))
    const divided = applyAll(
      [
        event(order, 'ItemAdded', bottle),
        event(order, 'ItemAdded', picada),
        event(order, 'ItemAdded', own),
        event(order, 'CheckSplit', { checks }),
      ],
      status,
    )
    expect(divided.checks?.reduce((a, c) => a + c.amount, 0)).toBe(orderTotals(divided).net)
    expect(divided.checks?.map((c) => c.amount)).toEqual([
      12_900 + 13_634 + 19_250,
      13_633 + 19_250,
      13_633,
    ])
  })

  it('by free amount: what is not assigned stays unassigned and is paid without a check', () => {
    const { order, status } = orderOpened()
    const [a, b] = checksOf([30_000, 20_000])
    if (!a || !b) throw new Error('missing checks')
    const divided = applyAll(
      [
        event(order, 'ItemAdded', itemCopy({ unit_price: 100_000 })),
        event(order, 'CheckSplit', { checks: [a, b] }),
      ],
      status,
    )
    // 100.000 − (30.000 + 20.000) unassigned.
    expect(issueOf(divided, event(order, 'PaymentRecorded', cardPaymentData(50_001)))).toBe(
      'payment_exceeds_balance',
    )
    const closed = applyAll(
      [
        event(order, 'PaymentRecorded', cardPaymentData(30_000, { check_id: a.check_id })),
        event(order, 'PaymentRecorded', cardPaymentData(20_000, { check_id: b.check_id })),
        event(order, 'PaymentRecorded', cardPaymentData(50_000)),
        event(order, 'OrderClosed', {}),
      ],
      divided,
    )
    expect(closed.status).toBe('closed')
  })

  it('with a prior payment: the balance is split; the payment stays in the general check', () => {
    const { order, status } = orderOpened()
    const balance = 60_000
    const tip = suggestedTip([{ net: balance, rate: 800 }], 1000)
    expect(tip).toBe(5556)
    const [a, b] = checksOf(equalParts(balance, 2), equalParts(tip, 2))
    if (!a || !b) throw new Error('missing checks')
    const previous = cashPaymentData(40_000)
    const withPayment = applyAll(
      [
        event(order, 'ItemAdded', itemCopy({ unit_price: 100_000 })),
        event(order, 'PaymentRecorded', previous),
      ],
      status,
    )
    // Splitting the full 100.000 no longer adds up; the 60.000 balance does.
    expect(
      issueOf(withPayment, event(order, 'CheckSplit', { checks: checksOf([50_000, 50_000]) })),
    ).toBe('split_mismatch')
    const divided = applyAll([event(order, 'CheckSplit', { checks: [a, b] })], withPayment)

    expect(divided.checks?.map((c) => [c.amount, c.suggestedTip])).toEqual([
      [30_000, 2778],
      [30_000, 2778],
    ])
    expect(divided.payments[previous.payment_id]?.checkId).toBeNull()
    expect(checkBalance(divided, a.check_id)).toBe(30_000)
    // The earlier payment in the general check is not recomputed and does not free what is
    // already covered.
    expect(issueOf(divided, event(order, 'PaymentRecorded', cardPaymentData(1)))).toBe(
      'payment_exceeds_balance',
    )
  })

  it('SplitUndone: rejected with payments; allowed if the payment is voided', () => {
    const { order, status } = orderOpened()
    const [a, b] = checksOf([50_000, 50_000])
    if (!a || !b) throw new Error('missing checks')
    const payment = cardPaymentData(50_000, { check_id: a.check_id })
    const withPayment = applyAll(
      [
        event(order, 'ItemAdded', itemCopy({ unit_price: 100_000 })),
        event(order, 'CheckSplit', { checks: [a, b] }),
        event(order, 'PaymentRecorded', payment),
      ],
      status,
    )
    expect(issueOf(withPayment, event(order, 'SplitUndone', {}))).toBe('has_payments')
    const voided = applyAll(
      [
        event(
          order,
          'PaymentVoided',
          { payment_id: payment.payment_id, register_shift_id: SHIFT },
          REASON,
        ),
      ],
      withPayment,
    )
    expect(applyAll([event(order, 'SplitUndone', {})], voided).checks).toBeNull()
  })
})

describe('discounts in the reducer', () => {
  it('comp of 1 of 3 $14.900 beers', () => {
    const { order, status } = orderOpened()
    const beers = itemCopy({ unit_price: 14_900, quantity: 3 })
    const final = applyAll(
      [
        event(order, 'ItemAdded', beers),
        discountEvent(order, 'item', 'comp', 14_900, [[beers.item_id, 14_900]], 1),
      ],
      status,
    )
    expect(orderTotals(final)).toMatchObject({ gross: 44_700, discount: 14_900, net: 29_800 })
  })

  it('full comp and then 10 % off the order: all to the pizza, no negative line', () => {
    const { order, status } = orderOpened()
    const beers = itemCopy({ unit_price: 14_900, quantity: 3 })
    const pizza = itemCopy()
    const withComp = applyAll(
      [
        event(order, 'ItemAdded', beers),
        event(order, 'ItemAdded', pizza),
        discountEvent(order, 'item', 'comp', 44_700, [[beers.item_id, 44_700]], 3),
      ],
      status,
    )
    // The 10 % is computed on the lines' net (40.900) and allocated over what is left.
    const discount = percent(orderTotals(withComp).net, 1000)
    expect(discount).toBe(4090)
    const final = applyAll(
      [
        discountEvent(order, 'order', 'percent', 1000, [
          [beers.item_id, 0],
          [pizza.item_id, 4090],
        ]),
      ],
      withComp,
    )
    const netOf = (id: string) => {
      const line = final.items[id]
      if (!line) throw new Error(`missing line ${id}`)
      return itemTotals(final, line).net
    }
    expect(netOf(beers.item_id)).toBe(0)
    expect(netOf(pizza.item_id)).toBe(36_810)
    // Allocating 4.470 to the beer would leave −4.470: it is rejected.
    expect(
      issueOf(
        withComp,
        discountEvent(order, 'order', 'percent', 1000, [
          [beers.item_id, 4470],
          [pizza.item_id, 0],
        ]),
      ),
    ).toBe('discount_exceeds')
  })

  it('several order discounts without cascading the amount: each on the same base', () => {
    const { order, status } = orderOpened()
    const pizza = itemCopy()
    const pasta = itemCopy({ unit_price: 12_900 })
    const withItems = applyAll(
      [event(order, 'ItemAdded', pizza), event(order, 'ItemAdded', pasta)],
      status,
    )
    const base = orderTotals(withItems).net
    const lines = [40_900, 12_900]
    const firstAllocation = allocateOrderDiscount(percent(base, 1000), lines) ?? []
    const leftover = lines.map((l, i) => l - (firstAllocation[i] ?? 0))
    const secondAllocation = allocateOrderDiscount(percent(base, 1000), leftover) ?? []
    const final = applyAll(
      [
        discountEvent(order, 'order', 'percent', 1000, [
          [pizza.item_id, firstAllocation[0] ?? 0],
          [pasta.item_id, firstAllocation[1] ?? 0],
        ]),
        discountEvent(order, 'order', 'percent', 1000, [
          [pizza.item_id, secondAllocation[0] ?? 0],
          [pasta.item_id, secondAllocation[1] ?? 0],
        ]),
      ],
      withItems,
    )
    // 2 × 5.380, not 5.380 + 4.842.
    expect(orderTotals(final)).toMatchObject({ discount: 10_760, net: 43_040 })
  })

  it('$0 order: accepts a $0 discount and rejects a larger one', () => {
    const { order, status } = orderOpened()
    const comp = itemCopy({ unit_price: 0 })
    const withItem = applyAll([event(order, 'ItemAdded', comp)], status)
    expect(orderTotals(withItem)).toMatchObject({ gross: 0, net: 0, balance: 0 })
    expect(
      issueOf(withItem, discountEvent(order, 'order', 'value', 0, [[comp.item_id, 0]])),
    ).toBeUndefined()
    expect(issueOf(withItem, discountEvent(order, 'order', 'value', 1, [[comp.item_id, 1]]))).toBe(
      'discount_exceeds',
    )
    // A $0 order also closes without payments.
    expect(applyAll([event(order, 'OrderClosed', {})], withItem).status).toBe('closed')
  })

  it('changing the quantity with a discount requires removing it; once removed, it can', () => {
    const { order, status } = orderOpened()
    const pizza = itemCopy()
    const discount = discountEvent(order, 'item', 'value', 5000, [[pizza.item_id, 5000]])
    const discounted = applyAll([event(order, 'ItemAdded', pizza), discount], status)
    const patch = event(order, 'ItemChanged', { item_id: pizza.item_id, quantity: 2 })
    expect(issueOf(discounted, patch)).toBe('has_discounts')

    const removed = applyAll(
      [event(order, 'DiscountRemoved', { discount_id: discount.data.discount_id }, REASON)],
      discounted,
    )
    expect(orderTotals(applyAll([again(patch)], removed))).toMatchObject({
      gross: 81_800,
      net: 81_800,
    })
  })
})

describe('projection: amounts are read from the event, never recomputed', () => {
  it('a discount keeps the event amounts even if they do not match its rule', () => {
    const { order, status } = orderOpened()
    const item = itemCopy({ unit_price: 12_950 })
    const final = applyAll(
      [
        event(order, 'ItemAdded', item),
        // 15 % of 12.950 would be 1.943; the event says 1.000 and that is what is projected.
        discountEvent(order, 'item', 'percent', 1500, [[item.item_id, 1000]]),
      ],
      status,
    )
    expect(orderTotals(final)).toMatchObject({ discount: 1000, net: 11_950 })
  })

  it('the checks, the suggested tip and the rounding adjustment are those of the event', () => {
    const { order, status } = orderOpened()
    const [a, b] = checksOf([70_000, 10_000], [123, 4])
    if (!a || !b) throw new Error('missing checks')
    const divided = applyAll(
      [
        event(order, 'ItemAdded', itemCopy({ unit_price: 100_000 })),
        event(order, 'CheckSplit', { checks: [a, b] }),
      ],
      status,
    )
    expect(divided.checks).toEqual([
      { id: a.check_id, name: 'Cuenta 1', amount: 70_000, suggestedTip: 123 },
      { id: b.check_id, name: 'Cuenta 2', amount: 10_000, suggestedTip: 4 },
    ])

    const withPreBill = applyAll(
      [
        event(order, 'PreBillPrinted', {
          check_id: a.check_id,
          subtotal: 7,
          suggested_tip: 9,
        }),
      ],
      divided,
    )
    expect(withPreBill.lastPreBill).toEqual({
      checkId: a.check_id,
      subtotal: 7,
      suggestedTip: 9,
    })

    // The adjustment must follow the rounding rule: 36.860 → 36.900, adjustment +40. One that only
    // balances (−40) is rejected: with it an order could be closed without charging it.
    const { order: p2, status: e2 } = orderOpened()
    const withItem = applyAll([event(p2, 'ItemAdded', itemCopy({ unit_price: 36_860 }))], e2)
    const badCase = event(
      p2,
      'PaymentRecorded',
      cashPaymentData(36_860, { rounding_adjustment: -40, change: 3180 }),
    )
    expect(applyEvent(withItem, badCase).issue?.type).toBe('invalid_adjustment')
    const paid = applyAll(
      [
        event(
          p2,
          'PaymentRecorded',
          cashPaymentData(36_860, { rounding_adjustment: 40, change: 3100 }),
        ),
      ],
      withItem,
    )
    expect(Object.values(paid.payments)[0]?.roundingAdjustment).toBe(40)
  })

  it('the item price, extras and rate are those copied into the event', () => {
    const { order, status } = orderOpened()
    const item = itemCopy({
      unit_price: 39_900,
      quantity: 2,
      rate: 1900,
      tax_type: 'iva',
      modifiers: [{ modifier_id: newId(), name: 'Queso', extra_price: 3000 }],
    })
    const final = applyAll([event(order, 'ItemAdded', item)], status)
    expect(orderTotals(final).gross).toBe(85_800)
    expect(final.items[item.item_id]).toMatchObject({
      unitPrice: 39_900,
      rate: 1900,
      taxType: 'iva',
    })
  })

  it('applyEvent never throws, with any event type or state, even if data is missing', () => {
    const { order, status } = orderOpened()
    const closed = applyAll([event(order, 'OrderClosed', {})], status)
    const base = event(order, 'TicketReprinted', { ticket_id: newId() })
    const garbage: unknown[] = [null, undefined, 42, 'text', [], {}, { item_ids: 'x', items: null }]

    for (const type of ORDER_EVENT_TYPES) {
      for (const data of garbage) {
        const badCase = { ...base, type, data } as unknown as OrderEvent
        for (const previous of [null, status, closed] as (OrderState | null)[]) {
          const r = applyEvent(previous, badCase)
          expect(r).toHaveProperty('status')
          expect(r).toHaveProperty('issue')
        }
      }
    }
    // And an event with an incomplete envelope.
    const withoutEnvelope = { type: 'ItemAdded', data: itemCopy() } as unknown as OrderEvent
    expect(() => applyEvent(status, withoutEnvelope)).not.toThrow()
  })
})

describe('reports: business day and payments across shifts', () => {
  it('partial payment on a still open table: the balance stays open, with no business day', () => {
    const { order, status } = orderOpened()
    const partiallyPaid = applyAll(
      [
        event(order, 'ItemAdded', itemCopy()),
        event(order, 'PaymentRecorded', cardPaymentData(20_000)),
      ],
      status,
    )
    expect(partiallyPaid).toMatchObject({ status: 'open', businessDay: null })
    expect(orderTotals(partiallyPaid)).toMatchObject({ paid: 20_000, balance: 20_900 })
  })

  it('partial payment before the day cutoff and close after: the day is the close day', () => {
    const { order, status } = orderOpened()
    const yesterdayAfternoon = event(
      order,
      'PaymentRecorded',
      cardPaymentData(20_000, { register_shift_id: newId() }),
      { business_day: '2026-10-23' },
    )
    const closed = applyAll(
      [
        event(order, 'ItemAdded', itemCopy(), { business_day: '2026-10-23' }),
        again(yesterdayAfternoon),
        event(order, 'PaymentRecorded', cardPaymentData(20_900), { business_day: '2026-10-24' }),
        event(order, 'OrderClosed', {}, { business_day: '2026-10-24' }),
      ],
      status,
    )
    expect(closed.businessDay).toBe('2026-10-24')
    // Σ net = Σ amount, regardless of the day or shift each payment was recorded in.
    const amounts = Object.values(closed.payments).reduce((a, p) => a + p.amount, 0)
    expect(amounts).toBe(orderTotals(closed).net)
    expect(new Set(Object.values(closed.payments).map((p) => p.registerShiftId)).size).toBe(2)
  })

  it('reopening on another day: the order keeps the day of the first close', () => {
    const { order, status } = orderOpened()
    const item = itemCopy({ unit_price: 10_000 })
    const extra = itemCopy({ unit_price: 5000 })
    const firstClose = applyAll(
      [
        event(order, 'ItemAdded', item),
        event(order, 'PaymentRecorded', cardPaymentData(10_000)),
        event(order, 'OrderClosed', {}, { business_day: '2026-10-23' }),
      ],
      status,
    )
    const reopened = applyAll(
      [
        event(order, 'OrderReopened', {}, { ...REASON, business_day: '2026-10-24' }),
        event(order, 'ItemAdded', extra, { business_day: '2026-10-24' }),
        event(order, 'PaymentRecorded', cardPaymentData(5000), { business_day: '2026-10-24' }),
        event(order, 'OrderClosed', {}, { business_day: '2026-10-24' }),
      ],
      firstClose,
    )
    expect(reopened.businessDay).toBe('2026-10-23')
    expect(orderTotals(reopened)).toMatchObject({ net: 15_000, paid: 15_000, balance: 0 })
  })
})

describe('move and merge: the total is preserved', () => {
  it('merging an order with a discount requires removing it first: no discount is lost', () => {
    const source = orderOpened()
    const target = orderOpened()
    const pizza = itemCopy()
    const discount = discountEvent(source.order, 'item', 'value', 5000, [[pizza.item_id, 5000]])
    const withDiscount = applyAll(
      [event(source.order, 'ItemAdded', pizza), discount],
      source.status,
    )
    const merge = event(
      target.order,
      'OrdersMerged',
      {
        source_order_id: source.order,
        items: [{ item: pizza, status: 'pending', voided_quantity: 0, added_by: WAITER }],
      },
      { related: [source.order] },
    )
    expect(issueOf(withDiscount, merge)).toBe('has_discounts')

    const withoutDiscount = applyAll(
      [event(source.order, 'DiscountRemoved', { discount_id: discount.data.discount_id }, REASON)],
      withDiscount,
    )
    const onceMore = again(merge)
    const after =
      orderTotals(applyAll([onceMore], withoutDiscount)).net +
      orderTotals(applyAll([onceMore], target.status)).net
    expect(after).toBe(40_900)
  })

  it('moving an item between orders preserves gross, voided and net of both', () => {
    const source = orderOpened()
    const target = orderOpened()
    const beers = itemCopy({ unit_price: 14_900, quantity: 3 })
    const sent = applyAll(
      [
        event(source.order, 'ItemAdded', beers),
        sendItems(source.order, [beers.item_id]),
        event(
          source.order,
          'ItemVoided',
          { item_id: beers.item_id, quantity: 1, already_prepared: false, ticket_id: null },
          REASON,
        ),
      ],
      source.status,
    )
    const move = event(
      source.order,
      'ItemsMoved',
      {
        target_order_id: target.order,
        items: [
          {
            item: beers,
            status: 'sent',
            voided_quantity: 1,
            added_by: WAITER,
          },
        ],
      },
      { related: [target.order] },
    )
    const newSource = applyAll([move], sent)
    const newTarget = applyAll([move], target.status)
    expect(orderTotals(newSource)).toMatchObject({ gross: 0, voided: 0, net: 0 })
    expect(orderTotals(newTarget)).toMatchObject({
      gross: 44_700,
      voided: 14_900,
      net: 29_800,
    })
  })
})
