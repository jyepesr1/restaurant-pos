import { describe, expect, it } from 'vitest'
import { newId } from '../id'
import { ORDER_TOTAL_LIMIT, PRICE_LIMIT } from '../money'
import { cardPaymentData, cashPaymentData, itemCopy, SHIFT, TIME } from '../testing/factory'
import { validateNewEvent } from './order'

// Schemas: negatives where they do not belong, fractions, unsafe integers and amounts over the
// limit (docs/DINERO.md#principios, point 6). Each case rejects the bad value and accepts the edge.

const envelope = (type: string, data: unknown, extras: Record<string, unknown> = {}) => ({
  id: newId(),
  type,
  schema_version: 1,
  aggregate_type: 'order',
  aggregate_id: newId(),
  related: [],
  data,
  session_id: null,
  user_id: newId(),
  device_id: newId(),
  authorization_id: null,
  reason: null,
  device_time: TIME,
  hub_estimated_time: TIME,
  base_sequence: 0,
  ...extras,
})

const accepts = (type: string, data: unknown, extras?: Record<string, unknown>) =>
  validateNewEvent(envelope(type, data, extras)).ok
const REASON = { reason: 'Motivo de prueba' }

/** Values no amount in pesos can take. */
const BAD_VALUES = {
  negative: -1,
  fraction: 1000.5,
  'entero no seguro': 2 ** 53,
  'sobre el límite': ORDER_TOTAL_LIMIT + 1,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  text: '1000',
} as const

const badCases = Object.entries(BAD_VALUES)

describe('payment amounts', () => {
  it.each(badCases)('PaymentRecorded rejects amount %s', (_n, value) => {
    expect(accepts('PaymentRecorded', { ...cardPaymentData(1000), amount: value })).toBe(false)
  })

  it.each(badCases)('PaymentRecorded rejects tip %s', (_n, value) => {
    expect(accepts('PaymentRecorded', { ...cardPaymentData(1000), tip: value })).toBe(false)
  })

  it.each(badCases)('cash PaymentRecorded rejects change %s', (_n, value) => {
    expect(accepts('PaymentRecorded', { ...cashPaymentData(1000), change: value })).toBe(false)
  })

  it.each(badCases.filter(([name]) => name !== 'negative'))(
    'PaymentRecorded rejects rounding adjustment %s',
    (_n, value) => {
      expect(
        accepts('PaymentRecorded', { ...cashPaymentData(1000), rounding_adjustment: value }),
      ).toBe(false)
    },
  )

  it('the rounding adjustment is the only amount that can be negative, up to the limit', () => {
    expect(accepts('PaymentRecorded', cashPaymentData(1000, { rounding_adjustment: -50 }))).toBe(
      true,
    )
    const largeCard = cardPaymentData(ORDER_TOTAL_LIMIT)
    expect(accepts('PaymentRecorded', largeCard)).toBe(true)
    expect(accepts('PaymentRecorded', { ...largeCard, amount: ORDER_TOTAL_LIMIT + 1 })).toBe(false)
    expect(
      accepts('PaymentRecorded', {
        ...cashPaymentData(ORDER_TOTAL_LIMIT),
        rounding_adjustment: -(ORDER_TOTAL_LIMIT + 1),
        tendered: 0,
      }),
    ).toBe(false)
  })

  it('a payment without a shift or with a non-ULID shift is rejected', () => {
    expect(accepts('PaymentRecorded', { ...cardPaymentData(1000), register_shift_id: null })).toBe(
      false,
    )
    expect(
      accepts('PaymentRecorded', { ...cardPaymentData(1000), register_shift_id: 'turno-1' }),
    ).toBe(false)
    const { register_shift_id: _removed, ...withoutShift } = cardPaymentData(1000)
    expect(accepts('PaymentRecorded', withoutShift)).toBe(false)
    expect(accepts('PaymentRecorded', cardPaymentData(1000, { register_shift_id: SHIFT }))).toBe(
      true,
    )
  })

  it('voiding a payment also requires the shift in which the void is recorded', () => {
    expect(
      accepts('PaymentVoided', { payment_id: newId(), register_shift_id: newId() }, REASON),
    ).toBe(true)
    expect(accepts('PaymentVoided', { payment_id: newId(), register_shift_id: null }, REASON)).toBe(
      false,
    )
    expect(accepts('PaymentVoided', { payment_id: newId() }, REASON)).toBe(false)
  })
})

describe('refunds', () => {
  const refund = (fields: Record<string, unknown>) => ({
    payment_id: newId(),
    refund_id: newId(),
    sale_amount: 1000,
    tip_amount: 0,
    method: 'card',
    register_shift_id: SHIFT,
    ...fields,
  })

  it.each(badCases)('rejects sale_amount %s', (_n, value) => {
    expect(accepts('RefundRecorded', refund({ sale_amount: value }), REASON)).toBe(false)
  })

  it.each(badCases)('rejects tip_amount %s', (_n, value) => {
    expect(accepts('RefundRecorded', refund({ tip_amount: value }), REASON)).toBe(false)
  })

  it('requires something to refund, in sale or in tip', () => {
    expect(accepts('RefundRecorded', refund({ sale_amount: 0, tip_amount: 0 }), REASON)).toBe(false)
    expect(accepts('RefundRecorded', refund({ sale_amount: 0, tip_amount: 500 }), REASON)).toBe(
      true,
    )
  })
})

describe('discounts, checks and pre-bill', () => {
  const discount = (fields: Record<string, unknown>, amount: unknown = 1000) => ({
    discount_id: newId(),
    scope: 'item',
    rule: 'value',
    value: 1000,
    unit_count: null,
    amounts: [{ item_id: newId(), amount }],
    ...fields,
  })

  it.each(badCases)('DiscountApplied rejects a per-line amount %s', (_n, value) => {
    expect(accepts('DiscountApplied', discount({}, value), REASON)).toBe(false)
  })

  it.each(badCases.filter(([name]) => name !== 'sobre el límite'))(
    'DiscountApplied rejects a value %s',
    (_n, value) => {
      expect(accepts('DiscountApplied', discount({ value }), REASON)).toBe(false)
    },
  )

  it('a $0 discount on a line is valid ($0 order), but with no lines it is not', () => {
    expect(accepts('DiscountApplied', discount({ value: 0 }, 0), REASON)).toBe(true)
    expect(accepts('DiscountApplied', discount({ amounts: [] }), REASON)).toBe(false)
  })

  it.each(['amount', 'suggested_tip'])('CheckSplit rejects bad %s', (field) => {
    const check = (value: unknown) => ({
      check_id: newId(),
      name: 'Cuenta',
      amount: 1000,
      suggested_tip: 0,
      items: [],
      [field]: value,
    })
    for (const [, value] of badCases) {
      expect(accepts('CheckSplit', { checks: [check(value), check(1000)] })).toBe(false)
    }
    expect(accepts('CheckSplit', { checks: [check(ORDER_TOTAL_LIMIT), check(0)] })).toBe(true)
  })

  it('a split needs at least two checks', () => {
    const check = {
      check_id: newId(),
      name: 'Único',
      amount: 1000,
      suggested_tip: 0,
      items: [],
    }
    expect(accepts('CheckSplit', { checks: [check] })).toBe(false)
    expect(accepts('CheckSplit', { checks: [] })).toBe(false)
  })

  it.each(['subtotal', 'suggested_tip'])('PreBillPrinted rejects bad %s', (field) => {
    for (const [, value] of badCases) {
      expect(
        accepts('PreBillPrinted', {
          check_id: null,
          subtotal: 1000,
          suggested_tip: 0,
          [field]: value,
        }),
      ).toBe(false)
    }
  })
})

describe('items', () => {
  const item = (fields: Record<string, unknown>) => ({ ...itemCopy(), ...fields })

  it.each([
    ['negative', -1],
    ['fracción', 40_900.5],
    ['entero no seguro', 2 ** 53],
    ['sobre el límite', PRICE_LIMIT + 1],
    ['NaN', Number.NaN],
  ])('rejects a unit_price %s', (_n, value) => {
    expect(accepts('ItemAdded', item({ unit_price: value }))).toBe(false)
  })

  it.each([
    ['negative', -1],
    ['fracción', 0.5],
    ['entero no seguro', 2 ** 53],
    ['sobre el límite', PRICE_LIMIT + 1],
  ])('rejects an extra_price %s', (_n, value) => {
    const modifier = { modifier_id: newId(), name: 'Extra', extra_price: value }
    expect(accepts('ItemAdded', item({ modifiers: [modifier] }))).toBe(false)
  })

  it.each([
    ['fracción', 1.5],
    ['entero no seguro', 2 ** 53],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['text', '2'],
  ])('rejects a quantity %s', (_n, value) => {
    expect(accepts('ItemAdded', item({ quantity: value }))).toBe(false)
    expect(accepts('ItemChanged', { item_id: newId(), quantity: value })).toBe(false)
    expect(
      accepts(
        'ItemVoided',
        { item_id: newId(), quantity: value, already_prepared: false, ticket_id: null },
        REASON,
      ),
    ).toBe(false)
  })

  it('rejects a fractional or negative rate', () => {
    expect(accepts('ItemAdded', item({ rate: 800.5 }))).toBe(false)
    expect(accepts('ItemAdded', item({ rate: -800 }))).toBe(false)
  })

  it('accepts the edges: the unit with extras at the limit, quantity 1 and 999, price 0', () => {
    const extra = (extra_price: number) => ({
      modifier_id: newId(),
      name: 'Extra',
      extra_price,
    })
    expect(
      accepts('ItemAdded', item({ unit_price: PRICE_LIMIT - 1000, modifiers: [extra(1000)] })),
    ).toBe(true)
    // The limit is for the whole unit (price + extras), not for each part.
    expect(accepts('ItemAdded', item({ unit_price: PRICE_LIMIT, modifiers: [extra(1)] }))).toBe(
      false,
    )
    expect(accepts('ItemAdded', item({ quantity: 999 }))).toBe(true)
    expect(accepts('ItemAdded', item({ quantity: 1, unit_price: 0 }))).toBe(true)
  })

  it('the moved item rejects a negative or fractional voided quantity', () => {
    const target = newId()
    const { catalog_version: _c, price_channel_id: _p, ...copy } = itemCopy()
    const moved = (voided_quantity: number) => ({
      target_order_id: target,
      items: [
        {
          item: copy,
          status: 'sent',
          voided_quantity,
          added_by: newId(),
        },
      ],
    })
    const withTarget = { related: [target] }
    expect(accepts('ItemsMoved', moved(0), withTarget)).toBe(true)
    expect(accepts('ItemsMoved', moved(-1), withTarget)).toBe(false)
    expect(accepts('ItemsMoved', moved(0.5), withTarget)).toBe(false)
    // A fully voided item (1 of 1) is not moved.
    expect(accepts('ItemsMoved', moved(1), withTarget)).toBe(false)
  })
})
