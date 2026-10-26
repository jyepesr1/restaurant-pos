import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROLES,
  ONLY_FROM_REGISTER,
  PASSWORD_PERMISSIONS,
  permissionFor,
} from '../access/permissions'
import { newId } from '../id'
import { ORDER_TOTAL_LIMIT } from '../money'
import { applyEvent, rebuild } from '../order/apply'
import { cardPaymentData, cashPaymentData, event, itemCopy, TIME } from '../testing/factory'
import { applyAll, orderOpened } from '../testing/helpers'
import { aggregateOf, ORDER_EVENT_TYPES, SHIFT_EVENT_TYPES, validateNewEvent } from './order'

// `ShiftOpened` and the card payment without an approval code (task 1.6).

const shiftEnvelope = (data: unknown, extras: Record<string, unknown> = {}) => ({
  id: newId(),
  type: 'ShiftOpened',
  schema_version: 1,
  aggregate_type: 'register_shift',
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

const validShift = () => shiftEnvelope({ register_id: newId(), base: 200_000 })

describe('ShiftOpened: schema', () => {
  it('accepts a register and a base in whole pesos', () => {
    expect(errors(validShift())).toEqual([])
  })

  it('a $0 base is valid (register with no float) and so is the order cap', () => {
    expect(errors(shiftEnvelope({ register_id: newId(), base: 0 }))).toEqual([])
    expect(errors(shiftEnvelope({ register_id: newId(), base: ORDER_TOTAL_LIMIT }))).toEqual([])
  })

  it.each([
    ['negative', -1],
    ['fractional', 1000.5],
    ['over the limit', ORDER_TOTAL_LIMIT + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', 2 ** 53],
    ['text', '200000'],
    ['null', null],
    ['missing', undefined],
  ])('rejects a base that is %s', (_, base) => {
    expect(errors(shiftEnvelope({ register_id: newId(), base }))).not.toEqual([])
  })

  it('requires a register_id that is a ULID', () => {
    expect(errors(shiftEnvelope({ base: 0 }))).not.toEqual([])
    expect(errors(shiftEnvelope({ register_id: 'caja-1', base: 0 }))).not.toEqual([])
    expect(errors(shiftEnvelope({ register_id: null, base: 0 }))).not.toEqual([])
  })

  it('does not allow extra fields (strict schema)', () => {
    expect(
      errors(shiftEnvelope({ register_id: newId(), base: 0, closeout: 'x' } as unknown)),
    ).not.toEqual([])
  })

  it('is a register_shift aggregate event: stated as order or product it is rejected', () => {
    const data = { register_id: newId(), base: 0 }
    expect(errors(shiftEnvelope(data, { aggregate_type: 'order' }))).not.toEqual([])
    expect(errors(shiftEnvelope(data, { aggregate_type: 'product' }))).not.toEqual([])
    expect(errors(shiftEnvelope(data, { aggregate_type: 'shift' }))).not.toEqual([])
  })

  it('an order event cannot claim to belong to a register_shift', () => {
    const opened = event(newId(), 'OrderOpened', {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    const { sequence: _s, received_at: _r, business_day: _d, ...rest } = opened
    const fresh = { ...rest, aggregate_type: 'register_shift' }
    expect(errors(fresh)).not.toEqual([])
  })

  it('aggregateOf: register_shift for ShiftOpened and, for the rest, as usual', () => {
    expect(aggregateOf('ShiftOpened')).toBe('register_shift')
    expect([...SHIFT_EVENT_TYPES]).toEqual([
      'ShiftOpened',
      'CashMovementRecorded',
      'CashCountRecorded',
      'ShiftClosed',
    ])
    expect(ORDER_EVENT_TYPES).toContain('ShiftOpened')
    expect(aggregateOf('PaymentRecorded')).toBe('order')
    expect(aggregateOf('ProductSoldOut')).toBe('product')
  })

  it('the event accepted by the hub (with sequence and day) is the same type', () => {
    const e = event(newId(), 'ShiftOpened', { register_id: newId(), base: 50_000 }, {
      aggregate_type: 'register_shift',
    } as never)
    expect(e.aggregate_type).toBe('register_shift')
    expect(e.data.base).toBe(50_000)
  })
})

describe('ShiftOpened: does not touch orders', () => {
  // BUG: a ShiftOpened can name an order in `related` and the hub stores it as an event of that
  // order (aggregateEvents(order) includes it). ProductSoldOut already prevents it in
  // packages/core/src/events/order.ts (superRefine of NewOrderEvent, «Un evento de producto
  // no toca pedidos»); the same guard is missing for register_shift aggregate events.
  it('a ShiftOpened cannot name an order in related', () => {
    const withOrder = shiftEnvelope({ register_id: newId(), base: 0 }, { related: [newId()] })
    expect(errors(withOrder)).not.toEqual([])
  })
})

describe('ShiftOpened: permission and register', () => {
  const shift = () =>
    event(newId(), 'ShiftOpened', { register_id: newId(), base: 0 }, {
      aggregate_type: 'register_shift',
    } as never)

  it('requires open_register_shift', () => {
    expect(permissionFor(shift())).toBe('open_register_shift')
  })

  it('is only created from a register device', () => {
    expect(ONLY_FROM_REGISTER.has('ShiftOpened')).toBe(true)
  })

  it('admin and cashier can do it; waiter and reports cannot', () => {
    const has = (role: keyof typeof DEFAULT_ROLES) =>
      (DEFAULT_ROLES[role].permissions as readonly string[]).includes('open_register_shift')
    expect(has('admin')).toBe(true)
    expect(has('cashier')).toBe(true)
    expect(has('waiter')).toBe(false)
    expect(has('reports')).toBe(false)
  })

  it('opening the register requires a password, a PIN is not enough', () => {
    expect(PASSWORD_PERMISSIONS.has('open_register_shift')).toBe(true)
  })
})

describe('ShiftOpened: the order reducer ignores it', () => {
  it('with no order, it creates none and reports it is not an order event', () => {
    const r = applyEvent(
      null,
      event(newId(), 'ShiftOpened', { register_id: newId(), base: 0 }, {
        aggregate_type: 'register_shift',
      } as never),
    )
    expect(r.status).toBeNull()
    expect(r.issue?.type).toBe('not_in_order')
  })

  it('with an open order, the state stays identical, even if the event names its id', () => {
    const { order, status } = orderOpened()
    const withItem = applyAll([event(order, 'ItemAdded', itemCopy())], status)
    const r = applyEvent(
      withItem,
      event(order, 'ShiftOpened', { register_id: newId(), base: 99_999 }, {
        aggregate_type: 'register_shift',
      } as never),
    )
    expect(r.status).toEqual(withItem)
    expect(r.issue?.type).toBe('not_in_order')
  })

  it('rebuilding an order with a shift in between gives the same result as without it', () => {
    const { order, status } = orderOpened()
    const item = event(order, 'ItemAdded', itemCopy({ unit_price: 10_000 }))
    const shift = event(newId(), 'ShiftOpened', { register_id: newId(), base: 0 }, {
      aggregate_type: 'register_shift',
      sequence: 2,
    } as never)
    const opened = event(
      order,
      'OrderOpened',
      { channel: 'dine_in', table_id: null, guests: 1 },
      {
        sequence: 1,
      },
    )
    const withoutShift = rebuild([opened, { ...item, sequence: 3 }], order)
    const withShift = rebuild([opened, shift, { ...item, sequence: 3 }], order)
    expect(withShift).toEqual(withoutShift)
    expect(status.id).toBe(order)
  })

  it('a shift alone leaves no order projection', () => {
    const shift = event(newId(), 'ShiftOpened', { register_id: newId(), base: 0 }, {
      aggregate_type: 'register_shift',
    } as never)
    expect(rebuild([shift], shift.aggregate_id)).toBeNull()
  })
})

describe('PaymentRecorded with a card and no approval code', () => {
  const paymentEnvelope = (data: unknown) => ({
    ...validShift(),
    type: 'PaymentRecorded',
    aggregate_type: 'order',
    data,
  })

  it('accepts the card with approval_code: null (amount only)', () => {
    const base = cardPaymentData(40_000)
    const cardTerminal = { ...(base.cardTerminal as object), approval_code: null }
    expect(errors(paymentEnvelope({ ...base, cardTerminal }))).toEqual([])
  })

  it('still accepts the card with approval code, card brand and last 4', () => {
    expect(errors(paymentEnvelope(cardPaymentData(40_000)))).toEqual([])
  })

  it('the card terminal is still required with a card, though the approval code is not', () => {
    expect(errors(paymentEnvelope({ ...cardPaymentData(40_000), cardTerminal: null }))).not.toEqual(
      [],
    )
  })

  it('an empty or whitespace approval code is not a code: null must be sent', () => {
    const base = cardPaymentData(40_000)
    for (const approval_code of ['', '   ']) {
      const cardTerminal = { ...(base.cardTerminal as object), approval_code }
      expect(errors(paymentEnvelope({ ...base, cardTerminal }))).not.toEqual([])
    }
  })

  it('the approval code cannot be missing entirely (undefined): it is null or a string', () => {
    const base = cardPaymentData(40_000)
    const { approval_code: _a, ...withoutApprovalCode } = base.cardTerminal as Record<
      string,
      unknown
    >
    expect(errors(paymentEnvelope({ ...base, cardTerminal: withoutApprovalCode }))).not.toEqual([])
  })

  it('the reducer records the card payment without an approval code and the order closes', () => {
    const { order, status } = orderOpened()
    const base = cardPaymentData(40_900)
    const payment = {
      ...base,
      cardTerminal: { ...(base.cardTerminal as object), approval_code: null },
    }
    const final = applyAll(
      [
        event(order, 'ItemAdded', itemCopy({ unit_price: 40_900 })),
        event(order, 'PaymentRecorded', payment as typeof base),
        event(order, 'OrderClosed', {}),
      ],
      status,
    )
    expect(final.status).toBe('closed')
    expect(Object.values(final.payments)[0]).toMatchObject({ method: 'card', amount: 40_900 })
  })

  it('a cash payment still carries no card terminal or approval code', () => {
    expect(errors(paymentEnvelope(cashPaymentData(10_000)))).toEqual([])
  })
})
