import { describe, expect, it } from 'vitest'
import { newId } from '../id'
import { cardPaymentData, cashPaymentData, itemCopy, TIME } from '../testing/factory'
import { ORDER_EVENT_TYPES, validateNewEvent } from './order'

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

const errors = (entry: unknown) => {
  const r = validateNewEvent(entry)
  return r.ok ? [] : r.errors
}

describe('order event schemas', () => {
  it('accepts a valid ItemAdded', () => {
    expect(errors(envelope('ItemAdded', itemCopy()))).toEqual([])
  })

  it('covers every v1 catalog type: 34 order, 2 product (sold out) and 4 register', () => {
    expect(ORDER_EVENT_TYPES).toHaveLength(40)
  })

  it('rejects an unknown type', () => {
    expect(errors(envelope('ItemDeleted', {}))).not.toEqual([])
  })

  it.each([
    ['a decimal price', { unit_price: 40_900.5 }],
    ['a negative price', { unit_price: -1 }],
    ['a price over the cap', { unit_price: 100_000_001 }],
    ['quantity 0', { quantity: 0 }],
    ['quantity 1000', { quantity: 1000 }],
    ['a rate over 10.000', { rate: 10_001 }],
    ['exempt with a rate', { tax_type: 'exempt', rate: 800 }],
  ])('rejects an item with %s', (_case, fields) => {
    expect(errors(envelope('ItemAdded', { ...itemCopy(), ...fields }))).not.toEqual([])
  })

  it('rejects ids that are not canonical ULIDs', () => {
    expect(errors(envelope('ItemAdded', itemCopy(), { id: newId().toLowerCase() }))).not.toEqual([])
    expect(errors(envelope('ItemRemoved', { item_id: 'mesa-5' }))).not.toEqual([])
  })

  it('requires a reason for voids, discounts, cancellations and reopenings', () => {
    const voidEntry = { item_id: newId(), quantity: 1, already_prepared: false, ticket_id: null }
    expect(errors(envelope('ItemVoided', voidEntry))).toEqual([
      'reason: ItemVoided exige un motivo',
    ])
    expect(errors(envelope('ItemVoided', voidEntry, { reason: 'Cliente cambió de idea' }))).toEqual(
      [],
    )
    expect(errors(envelope('OrderCanceled', {}))).not.toEqual([])
    expect(errors(envelope('OrderReopened', {}, { reason: 'Faltó cobrar' }))).toEqual([])
  })

  it('in cash requires tendered = amount + adjustment + tip + change', () => {
    expect(
      errors(
        envelope(
          'PaymentRecorded',
          cashPaymentData(36_810, { rounding_adjustment: -10, change: 3200 }),
        ),
      ),
    ).toEqual([])
    expect(
      errors(
        envelope('PaymentRecorded', {
          ...cashPaymentData(36_810, { change: 3200 }),
          tendered: 40_000,
        }),
      ),
    ).not.toEqual([])
    expect(
      errors(envelope('PaymentRecorded', { ...cashPaymentData(100), tendered: null })),
    ).not.toEqual([])
  })

  it('outside cash does not allow tendered, change or adjustment', () => {
    expect(errors(envelope('PaymentRecorded', cardPaymentData(50_000)))).toEqual([])
    expect(
      errors(envelope('PaymentRecorded', { ...cardPaymentData(50_000), change: 0 })),
    ).not.toEqual([])
    expect(
      errors(envelope('PaymentRecorded', { ...cardPaymentData(50_000), rounding_adjustment: -10 })),
    ).not.toEqual([])
  })

  it('rejects a 0 payment and a negative charged amount', () => {
    expect(errors(envelope('PaymentRecorded', cardPaymentData(0)))).not.toEqual([])
    expect(
      errors(envelope('PaymentRecorded', cashPaymentData(30, { rounding_adjustment: -50 }))),
    ).not.toEqual([])
    expect(
      errors(envelope('PaymentRecorded', cashPaymentData(30, { rounding_adjustment: -30 }))),
    ).toEqual([])
  })

  it('rejects shared item fractions greater than 1', () => {
    const check = (fraction: { n: number; d: number }) => ({
      check_id: newId(),
      name: 'Comensal 1',
      amount: 1000,
      suggested_tip: 0,
      items: [{ item_id: newId(), fraction }],
    })
    const split = (fraction: { n: number; d: number }) =>
      envelope('CheckSplit', { checks: [check(fraction), check(fraction)] })

    expect(errors(split({ n: 1, d: 3 }))).toEqual([])
    expect(errors(split({ n: 4, d: 3 }))).not.toEqual([])
  })

  it('an ItemChanged must change something', () => {
    expect(errors(envelope('ItemChanged', { item_id: newId() }))).not.toEqual([])
    expect(errors(envelope('ItemChanged', { item_id: newId(), quantity: 2 }))).toEqual([])
  })

  it('does not throw on garbage input', () => {
    for (const garbage of [null, 42, 'evento', [], {}, { type: 'ItemAdded' }]) {
      expect(validateNewEvent(garbage).ok).toBe(false)
    }
  })
})
