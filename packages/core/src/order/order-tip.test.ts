import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { newId } from '../id'
import { allocateTip, suggestedTip } from '../money'
import { cardPaymentData, cashPaymentData, event, itemCopy } from '../testing/factory'
import { applyAll, orderOpened, sendItems } from '../testing/helpers'
import { orderTip, orderTotals } from './totals'

// `orderTip` against orders built with real events (task 1.6, docs/DINERO.md#propina-
// sugerida): the tip comes from the base without INC, net of discounts and voids, with a single
// rounding, and on the balance when there are earlier payments.

const CONFIG = { suggested_tip: 1000, rounding_mode: 'half_up' as const }

const withItems = (...items: ReturnType<typeof itemCopy>[]) => {
  const { order, status } = orderOpened()
  return {
    order,
    status: applyAll(
      items.map((i) => event(order, 'ItemAdded', i)),
      status,
    ),
  }
}

const discount = (
  order: string,
  scope: 'item' | 'order',
  rule: 'percent' | 'value',
  value: number,
  amounts: [string, number][],
) =>
  event(
    order,
    'DiscountApplied',
    {
      discount_id: newId(),
      scope,
      rule,
      value,
      unit_count: null,
      amounts: amounts.map(([item_id, amount]) => ({ item_id, amount })),
    },
    { reason: 'Prueba' },
  )

describe('orderTip: the docs/DINERO.md examples with real orders', () => {
  it.each([
    [100_000, 9_259],
    [16_000, 1_481],
    [2_500, 231],
  ])('a $%i dish at 8 %% → tip %i', (price, expected) => {
    const { status } = withItems(itemCopy({ unit_price: price }))
    expect(orderTip(status, orderTotals(status).balance, CONFIG)).toBe(expected)
  })

  it('$53.800 with a 10 % discount (net 48.420) → 4.483, on the net and not on the gross', () => {
    const dish = itemCopy({ unit_price: 53_800 })
    const { order, status } = withItems(dish)
    const final = applyAll(
      [discount(order, 'order', 'percent', 1000, [[dish.item_id, 5_380]])],
      status,
    )
    expect(orderTotals(final)).toMatchObject({ gross: 53_800, discount: 5_380, net: 48_420 })
    expect(orderTip(final, 48_420, CONFIG)).toBe(4_483)
    // On the gross it would have been 4.981: the discount is taken into account.
    expect(orderTip(status, 53_800, CONFIG)).toBe(4_981)
  })

  it('$100.000 at 8 % with $40.000 paid: tip on the $60.000 balance is 5.556 (2.778 + 2.778)', () => {
    const dish = itemCopy({ unit_price: 100_000 })
    const { order, status } = withItems(dish)
    const withPayment = applyAll([event(order, 'PaymentRecorded', cardPaymentData(40_000))], status)
    const balance = orderTotals(withPayment).balance
    expect(balance).toBe(60_000)
    const tip = orderTip(withPayment, balance, CONFIG)
    expect(tip).toBe(5_556)
    expect(allocateTip(tip, [30_000, 30_000])).toEqual([2_778, 2_778])
  })

  it('an earlier payment with its own tip does not change the suggested tip on the balance', () => {
    const { order, status } = withItems(itemCopy({ unit_price: 100_000 }))
    const withPayment = applyAll(
      [event(order, 'PaymentRecorded', cashPaymentData(40_000, { tip: 4_000 }))],
      status,
    )
    expect(orderTip(withPayment, 60_000, CONFIG)).toBe(5_556)
  })
})

describe('orderTip: discounts, voids, extras and rates', () => {
  it('with different rates, each line contributes its pre-tax base (8 %, exempt and 19 %)', () => {
    const { status } = withItems(
      itemCopy({ unit_price: 50_000, rate: 800 }),
      itemCopy({ unit_price: 50_000, rate: 0, tax_type: 'exempt' }),
      itemCopy({ unit_price: 11_900, rate: 1900, tax_type: 'iva' }),
    )
    // 46.296,2963 + 50.000 + 10.000 = 106.296,2963 → 10 % = 10.629,63 → 10.630.
    expect(orderTip(status, 111_900, CONFIG)).toBe(10_630)
  })

  it('an item discount lowers the tip for that item', () => {
    const beer = itemCopy({ unit_price: 14_900, quantity: 3 })
    const pizza = itemCopy({ unit_price: 40_000 })
    const { order, status } = withItems(beer, pizza)
    const final = applyAll(
      [discount(order, 'item', 'value', 14_900, [[beer.item_id, 14_900]])],
      status,
    )
    const net = orderTotals(final).net
    expect(net).toBe(44_700 + 40_000 - 14_900)
    // (29.800 + 40.000) / 1,08 = 64.629,6296 → 6.463.
    expect(orderTip(final, net, CONFIG)).toBe(6_463)
  })

  it('a full comp leaves the line out of the tip without breaking the math', () => {
    const cocktail = itemCopy({ unit_price: 20_000 })
    const food = itemCopy({ unit_price: 30_000 })
    const { order, status } = withItems(cocktail, food)
    const final = applyAll(
      [discount(order, 'item', 'percent', 10_000, [[cocktail.item_id, 20_000]])],
      status,
    )
    expect(orderTotals(final).net).toBe(30_000)
    expect(orderTip(final, 30_000, CONFIG)).toBe(2_778)
  })

  it('a voided item does not count; a partially voided one, only the remaining units', () => {
    const beers = itemCopy({ unit_price: 14_900, quantity: 3 })
    const dish = itemCopy({ unit_price: 40_900 })
    const { order, status } = withItems(beers, dish)
    const sent = applyAll([sendItems(order, [beers.item_id, dish.item_id])], status)
    const voidEntry = (item_id: string, quantity: number) =>
      event(
        order,
        'ItemVoided',
        { item_id, quantity, already_prepared: false, ticket_id: null },
        { reason: 'Cliente cambió' },
      )

    const partial = applyAll([voidEntry(beers.item_id, 1)], sent)
    // (29.800 + 40.900) / 1,08 = 65.462,96 → 6.546.
    expect(orderTip(partial, orderTotals(partial).net, CONFIG)).toBe(6_546)

    const withoutDish = applyAll([voidEntry(dish.item_id, 1)], partial)
    // 29.800 / 1,08 = 27.592,59 → 2.759.
    expect(orderTotals(withoutDish).net).toBe(29_800)
    expect(orderTip(withoutDish, 29_800, CONFIG)).toBe(2_759)
  })

  it('with everything voided there is no base: tip 0 for $0, an error for a larger amount', () => {
    const dish = itemCopy({ unit_price: 40_900 })
    const { order, status } = withItems(dish)
    const voided = applyAll(
      [
        sendItems(order, [dish.item_id]),
        event(
          order,
          'ItemVoided',
          { item_id: dish.item_id, quantity: 1, already_prepared: false, ticket_id: null },
          { reason: 'Error' },
        ),
      ],
      status,
    )
    expect(orderTip(voided, 0, CONFIG)).toBe(0)
    expect(() => orderTip(voided, 1, CONFIG)).toThrow(RangeError)
  })

  it('an order without items has no tip either', () => {
    const { status } = orderOpened()
    expect(orderTip(status, 0, CONFIG)).toBe(0)
  })

  it('modifier extras are part of the base (unit price with extras)', () => {
    const dish = itemCopy({
      unit_price: 38_000,
      quantity: 2,
      modifiers: [{ modifier_id: newId(), name: 'Queso extra', extra_price: 2_900 }],
    })
    const { status } = withItems(dish)
    expect(orderTotals(status).net).toBe(81_800)
    // 81.800 / 1,08 = 75.740,74 → 7.574.
    expect(orderTip(status, 81_800, CONFIG)).toBe(7_574)
  })

  it('a single rounding for the whole order: two lines do not add up their rounded tips', () => {
    const { status } = withItems(itemCopy({ unit_price: 16_000 }), itemCopy({ unit_price: 16_000 }))
    // Each alone gives 1.481 (sum 2.962); together, 32.000 / 1,08 × 10 % = 2.962,96 → 2.963.
    expect(orderTip(status, 32_000, CONFIG)).toBe(2_963)
  })

  it('rate 0: no suggested tip', () => {
    const { status } = withItems(itemCopy({ unit_price: 100_000 }))
    expect(orderTip(status, 100_000, { ...CONFIG, suggested_tip: 0 })).toBe(0)
  })

  it('the configured rounding mode decides an exact half-peso tie', () => {
    // 5 exempt pesos at 10 % = exactly 0,5.
    const { status } = withItems(itemCopy({ unit_price: 5, rate: 0, tax_type: 'exempt' }))
    expect(orderTip(status, 5, { ...CONFIG, rounding_mode: 'half_up' })).toBe(1)
    expect(orderTip(status, 5, { ...CONFIG, rounding_mode: 'half_even' })).toBe(0)
  })

  it('an amount greater than the current net is an error, not an inflated tip', () => {
    const { status } = withItems(itemCopy({ unit_price: 10_000 }))
    expect(() => orderTip(status, 10_001, CONFIG)).toThrow(RangeError)
  })
})

describe('orderTip: properties', () => {
  it('with the whole net it matches suggestedTip of the lines, and is monotonic in amount', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            price: fc.integer({ min: 0, max: 500_000 }),
            quantity: fc.integer({ min: 1, max: 9 }),
            rate: fc.constantFrom(0, 800, 1900),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 1000 }),
        (rows, fraction, tipRate) => {
          const { status } = withItems(
            ...rows.map((f) =>
              itemCopy({
                unit_price: f.price,
                quantity: f.quantity,
                rate: f.rate,
                tax_type: f.rate === 0 ? 'exempt' : f.rate === 800 ? 'inc' : 'iva',
              }),
            ),
          )
          const net = orderTotals(status).net
          const config = { suggested_tip: tipRate, rounding_mode: 'half_up' as const }
          const total = orderTip(status, net, config)
          expect(total).toBe(
            suggestedTip(
              rows.map((f) => ({ net: f.price * f.quantity, rate: f.rate })),
              tipRate,
            ),
          )
          const share = Math.floor(net * fraction)
          const tipShare = orderTip(status, share, config)
          expect(tipShare).toBeGreaterThanOrEqual(0)
          expect(tipShare).toBeLessThanOrEqual(total)
          // The tip on the rest + the tip on the share differ from the total by at most 1 peso
          // (each one has its own rounding).
          const rest = orderTip(status, net - share, config)
          expect(Math.abs(tipShare + rest - total)).toBeLessThanOrEqual(1)
        },
      ),
    )
  })
})

describe('ItemAdded clears the last pre-bill', () => {
  it('after requesting the pre-bill, adding a product sets it to null (no longer valid)', () => {
    const { order, status } = withItems(itemCopy({ unit_price: 10_000 }))
    const withPreBill = applyAll(
      [
        event(order, 'PreBillPrinted', {
          check_id: null,
          subtotal: 10_000,
          suggested_tip: 926,
        }),
      ],
      status,
    )
    expect(withPreBill.lastPreBill).toMatchObject({ subtotal: 10_000, suggestedTip: 926 })
    const after = applyAll([event(order, 'ItemAdded', itemCopy())], withPreBill)
    expect(after.lastPreBill).toBeNull()
  })
})
