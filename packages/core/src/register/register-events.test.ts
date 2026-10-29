import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROLES,
  ONLY_FROM_REGISTER,
  PASSWORD_PERMISSIONS,
  permissionFor,
} from '../access/permissions'
import { fullConfig } from '../config'
import {
  aggregateOf,
  type NewEvent,
  ORDER_EVENT_TYPES,
  SHIFT_EVENT_TYPES,
  validateNewEvent,
} from '../events/order'
import { newId } from '../id'
import { ORDER_TOTAL_LIMIT } from '../money'
import { applyEvent, rebuild } from '../order/apply'
import { event, itemCopy, TIME } from '../testing/factory'
import { applyAll, orderOpened } from '../testing/helpers'

// The three register events of task 1.7 (CashMovementRecorded, CashCountRecorded and
// ShiftClosed): schema with its edges, register_shift aggregate, permissions, only from the
// register and that the order reducer ignores them.

const REGISTER_TYPES = ['CashMovementRecorded', 'CashCountRecorded', 'ShiftClosed'] as const

const envelope = (type: string, data: unknown, extras: Record<string, unknown> = {}) => ({
  id: newId(),
  type,
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
const ok = (e: unknown) => validateNewEvent(e).ok

const movement = (fields: Record<string, unknown> = {}) => ({
  movement_id: newId(),
  type: 'cash_in',
  amount: 10_000,
  description: 'Cambio de billetes',
  to_whom: null,
  days: [],
  ...fields,
})
const tips = (fields: Record<string, unknown> = {}) =>
  movement({ type: 'tip_payout', to_whom: 'Equipo de sala', days: ['2026-10-25'], ...fields })
const cashCount = (fields: Record<string, unknown> = {}) => ({
  cash_count_id: newId(),
  tally: [{ value: 20_000, quantity: 3 }],
  counted_cash: 60_000,
  ...fields,
})
const closeout = (fields: Record<string, unknown> = {}) => ({
  cash_count_id: newId(),
  expected_cash: 100_000,
  counted_cash: 98_000,
  variance: -2_000,
  justification: null,
  ...fields,
})

describe('CashMovementRecorded: schema', () => {
  it.each([
    ['cash_in', movement()],
    ['cash_out', movement({ type: 'cash_out' })],
    ['tip_payout', tips()],
  ])('accepts a valid %s', (_, data) => {
    expect(ok(envelope('CashMovementRecorded', data))).toBe(true)
  })

  it('the amount goes from $1 to the order limit; $0 and anything over the limit are rejected', () => {
    expect(ok(envelope('CashMovementRecorded', movement({ amount: 1 })))).toBe(true)
    expect(ok(envelope('CashMovementRecorded', movement({ amount: ORDER_TOTAL_LIMIT })))).toBe(true)
    for (const amount of [0, ORDER_TOTAL_LIMIT + 1])
      expect(ok(envelope('CashMovementRecorded', movement({ amount })))).toBe(false)
  })

  it.each([
    ['negative', -1],
    ['fractional', 1000.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', 2 ** 53],
    ['text', '10000'],
    ['null', null],
    ['missing', undefined],
  ])('rejects a %s amount', (_, amount) => {
    expect(ok(envelope('CashMovementRecorded', movement({ amount })))).toBe(false)
  })

  it('the description is required: empty, blank or 501 characters is rejected; 500 is valid', () => {
    for (const description of ['', '   ', 'x'.repeat(501), null, undefined])
      expect(ok(envelope('CashMovementRecorded', movement({ description })))).toBe(false)
    expect(ok(envelope('CashMovementRecorded', movement({ description: 'x'.repeat(500) })))).toBe(
      true,
    )
  })

  it('the type must be entry, output or tip_payout (not a withdrawal or anything else)', () => {
    for (const type of ['partial_withdrawal', 'Entrada', '', null])
      expect(ok(envelope('CashMovementRecorded', movement({ type })))).toBe(false)
  })

  it('only the tip payout says to whom; an entry or output with to_whom is rejected', () => {
    expect(ok(envelope('CashMovementRecorded', movement({ to_whom: 'Ana' })))).toBe(false)
    expect(
      ok(envelope('CashMovementRecorded', movement({ type: 'cash_out', to_whom: 'Ana' }))),
    ).toBe(false)
    expect(ok(envelope('CashMovementRecorded', tips({ to_whom: null })))).toBe(false)
    // "to whom" cannot be empty or blank text.
    expect(ok(envelope('CashMovementRecorded', tips({ to_whom: '  ' })))).toBe(false)
  })

  it('the tip payout says which days it comes from; an entry or output carries no days', () => {
    expect(ok(envelope('CashMovementRecorded', tips({ days: [] })))).toBe(false)
    expect(ok(envelope('CashMovementRecorded', movement({ days: ['2026-10-25'] })))).toBe(false)
  })

  it('the days are real dates; up to 31', () => {
    for (const days of [['2026-13-01'], ['2026-02-30'], ['25/10/2026'], [''], [20261025]])
      expect(ok(envelope('CashMovementRecorded', tips({ days })))).toBe(false)
    const month = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
    expect(ok(envelope('CashMovementRecorded', tips({ days: month })))).toBe(true)
    expect(ok(envelope('CashMovementRecorded', tips({ days: [...month, '2026-11-01'] })))).toBe(
      false,
    )
  })

  it('movement_id must be a ULID', () => {
    for (const movement_id of ['mov-1', '', null, undefined])
      expect(ok(envelope('CashMovementRecorded', movement({ movement_id })))).toBe(false)
  })

  it('strict schema: an extra field is rejected', () => {
    expect(ok(envelope('CashMovementRecorded', movement({ register_shift_id: newId() })))).toBe(
      false,
    )
  })
})

describe('CashCountRecorded: schema', () => {
  it('accepts a count that adds up to the counted amount', () => {
    expect(ok(envelope('CashCountRecorded', cashCount()))).toBe(true)
  })

  it('an empty drawer is valid: empty count and $0; empty count with money is not', () => {
    expect(ok(envelope('CashCountRecorded', cashCount({ tally: [], counted_cash: 0 })))).toBe(true)
    expect(ok(envelope('CashCountRecorded', cashCount({ tally: [], counted_cash: 1 })))).toBe(false)
  })

  it('adds several denominations, and a row with quantity 0 adds nothing', () => {
    const tally = [
      { value: 50_000, quantity: 2 },
      { value: 2_000, quantity: 5 },
      { value: 500, quantity: 3 },
      { value: 100_000, quantity: 0 },
    ]
    expect(ok(envelope('CashCountRecorded', cashCount({ tally, counted_cash: 111_500 })))).toBe(
      true,
    )
    expect(ok(envelope('CashCountRecorded', cashCount({ tally, counted_cash: 111_000 })))).toBe(
      false,
    )
  })

  it('the counted total must be exact: $1 over or under is rejected', () => {
    for (const counted_cash of [59_999, 60_001, 0])
      expect(ok(envelope('CashCountRecorded', cashCount({ counted_cash })))).toBe(false)
  })

  it('the value is $1 or more; a negative or fractional quantity is rejected', () => {
    for (const textLine of [
      { value: 0, quantity: 3 },
      { value: -1_000, quantity: 3 },
      { value: 1_000.5, quantity: 2 },
      { value: 1_000, quantity: -1 },
      { value: 1_000, quantity: 1.5 },
    ])
      expect(
        ok(envelope('CashCountRecorded', cashCount({ tally: [textLine], counted_cash: 0 }))),
      ).toBe(false)
  })

  it('up to 30 rows and 100,000 units per row', () => {
    const thirty = Array.from({ length: 30 }, (_, i) => ({ value: i + 1, quantity: 1 }))
    const sum = thirty.reduce((s, c) => s + c.value, 0)
    expect(ok(envelope('CashCountRecorded', cashCount({ tally: thirty, counted_cash: sum })))).toBe(
      true,
    )
    const thirtyOne = [...thirty, { value: 31, quantity: 1 }]
    expect(
      ok(envelope('CashCountRecorded', cashCount({ tally: thirtyOne, counted_cash: sum + 31 }))),
    ).toBe(false)
    expect(
      ok(
        envelope(
          'CashCountRecorded',
          cashCount({ tally: [{ value: 100, quantity: 100_000 }], counted_cash: 10_000_000 }),
        ),
      ),
    ).toBe(true)
    expect(
      ok(
        envelope(
          'CashCountRecorded',
          cashCount({ tally: [{ value: 100, quantity: 100_001 }], counted_cash: 10_000_100 }),
        ),
      ),
    ).toBe(false)
  })

  it('a count over the order limit is rejected even if it matches', () => {
    const one = { value: 100_000, quantity: 100_000 }
    expect(
      ok(
        envelope('CashCountRecorded', cashCount({ tally: [one], counted_cash: ORDER_TOTAL_LIMIT })),
      ),
    ).toBe(true)
    expect(
      ok(
        envelope(
          'CashCountRecorded',
          cashCount({
            tally: [one, { value: 1, quantity: 1 }],
            counted_cash: ORDER_TOTAL_LIMIT + 1,
          }),
        ),
      ),
    ).toBe(false)
  })

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['NaN', Number.NaN],
    ['text', '60000'],
    ['null', null],
    ['missing', undefined],
  ])('rejects a %s counted amount', (_, counted_cash) => {
    expect(ok(envelope('CashCountRecorded', cashCount({ counted_cash })))).toBe(false)
  })

  it('cash_count_id must be a ULID and extra fields are not allowed', () => {
    expect(ok(envelope('CashCountRecorded', cashCount({ cash_count_id: 'a1' })))).toBe(false)
    expect(ok(envelope('CashCountRecorded', cashCount({ expected_cash: 60_000 })))).toBe(false)
  })
})

describe('ShiftClosed: schema', () => {
  it('accepts shortage, overage and exact match', () => {
    expect(ok(envelope('ShiftClosed', closeout()))).toBe(true)
    expect(ok(envelope('ShiftClosed', closeout({ counted_cash: 103_000, variance: 3_000 })))).toBe(
      true,
    )
    expect(ok(envelope('ShiftClosed', closeout({ counted_cash: 100_000, variance: 0 })))).toBe(true)
  })

  it('the variance is counted − expected, signed: a flipped sign is rejected', () => {
    expect(ok(envelope('ShiftClosed', closeout({ variance: 2_000 })))).toBe(false)
    expect(ok(envelope('ShiftClosed', closeout({ variance: -1_999 })))).toBe(false)
    expect(ok(envelope('ShiftClosed', closeout({ variance: 0 })))).toBe(false)
  })

  it('expected can be negative (more was refunded than there was) and the variance honors it', () => {
    expect(
      ok(
        envelope(
          'ShiftClosed',
          closeout({ expected_cash: -5_000, counted_cash: 0, variance: 5_000 }),
        ),
      ),
    ).toBe(true)
  })

  it('counted cannot be negative or fractional; expected cannot be fractional either', () => {
    expect(ok(envelope('ShiftClosed', closeout({ counted_cash: -1, variance: -100_001 })))).toBe(
      false,
    )
    expect(ok(envelope('ShiftClosed', closeout({ expected_cash: 100_000.5 })))).toBe(false)
    expect(ok(envelope('ShiftClosed', closeout({ counted_cash: 98_000.5 })))).toBe(false)
  })

  it('limit bounds: ±limit are valid, one more is rejected', () => {
    expect(
      ok(
        envelope(
          'ShiftClosed',
          closeout({
            expected_cash: ORDER_TOTAL_LIMIT,
            counted_cash: 0,
            variance: -ORDER_TOTAL_LIMIT,
          }),
        ),
      ),
    ).toBe(true)
    expect(
      ok(
        envelope(
          'ShiftClosed',
          closeout({
            expected_cash: ORDER_TOTAL_LIMIT + 1,
            counted_cash: ORDER_TOTAL_LIMIT,
            variance: -1,
          }),
        ),
      ),
    ).toBe(false)
    // The variance should never exceed the limit with an already bounded expected, but it is
    // validated anyway.
    expect(
      ok(
        envelope(
          'ShiftClosed',
          closeout({
            expected_cash: -ORDER_TOTAL_LIMIT,
            counted_cash: ORDER_TOTAL_LIMIT,
            variance: 2 * ORDER_TOTAL_LIMIT,
          }),
        ),
      ),
    ).toBe(false)
  })

  it('the justification is non-blank text, up to 500 characters, or null', () => {
    expect(ok(envelope('ShiftClosed', closeout({ justification: 'Faltó un vale' })))).toBe(true)
    expect(ok(envelope('ShiftClosed', closeout({ justification: 'x'.repeat(500) })))).toBe(true)
    for (const justification of ['', '   ', 'x'.repeat(501), 5])
      expect(ok(envelope('ShiftClosed', closeout({ justification })))).toBe(false)
  })

  it('cash_count_id is required and a ULID; no extra fields allowed', () => {
    const { cash_count_id: _a, ...withoutCashCount } = closeout()
    expect(ok(envelope('ShiftClosed', withoutCashCount))).toBe(false)
    expect(ok(envelope('ShiftClosed', closeout({ cash_count_id: 'x' })))).toBe(false)
    expect(ok(envelope('ShiftClosed', closeout({ withdrawal: 1 })))).toBe(false)
  })
})

describe('register events: register_shift aggregate and no orders', () => {
  const validEntries = {
    CashMovementRecorded: movement(),
    CashCountRecorded: cashCount(),
    ShiftClosed: closeout(),
  }

  it.each(REGISTER_TYPES)('%s belongs to the register_shift aggregate', (type) => {
    expect(aggregateOf(type)).toBe('register_shift')
    expect(SHIFT_EVENT_TYPES).toContain(type)
    expect(ORDER_EVENT_TYPES).toContain(type)
    expect(ok(envelope(type, validEntries[type]))).toBe(true)
  })

  it.each(REGISTER_TYPES)('%s declared as an order or product event is rejected', (type) => {
    for (const aggregate_type of ['order', 'product', 'shift', 'register', undefined])
      expect(ok(envelope(type, validEntries[type], { aggregate_type }))).toBe(false)
  })

  it.each(REGISTER_TYPES)('%s cannot name an order in related', (type) => {
    expect(ok(envelope(type, validEntries[type], { related: [newId()] }))).toBe(false)
    expect(ok(envelope(type, validEntries[type], { related: [newId(), newId()] }))).toBe(false)
    const r = validateNewEvent(envelope(type, validEntries[type], { related: [newId()] }))
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/no toca pedidos/)
  })

  it.each(REGISTER_TYPES)('%s with empty related is valid (control)', (type) => {
    expect(ok(envelope(type, validEntries[type], { related: [] }))).toBe(true)
  })

  it('an order event cannot claim to be from the register_shift', () => {
    const data = { channel: 'dine_in', table_id: null, guests: 1 }
    expect(ok(envelope('OrderOpened', data, { aggregate_type: 'order' }))).toBe(true)
    expect(ok(envelope('OrderOpened', data, { aggregate_type: 'register_shift' }))).toBe(false)
  })

  it('with the same shift id as aggregate and a different order: the event is not an order event', () => {
    // The aggregate of a register event is the shift: the type says so, not the content.
    const shift = newId()
    const e = event(
      shift,
      'CashMovementRecorded',
      movement() as never,
      {
        aggregate_type: 'register_shift',
      } as never,
    )
    expect(e.aggregate_id).toBe(shift)
    expect(e.aggregate_type).toBe('register_shift')
  })
})

describe('register events: permissions and only from the register', () => {
  const fresh = (type: string, data: unknown) => {
    const r = validateNewEvent(envelope(type, data))
    if (!r.ok) throw new Error(r.errors.join('; '))
    return r.event as NewEvent
  }

  it('the movement requires cash_movement; the cash count and the close require close_register_shift', () => {
    expect(permissionFor(fresh('CashMovementRecorded', movement()))).toBe('cash_movement')
    expect(permissionFor(fresh('CashMovementRecorded', tips()))).toBe('cash_movement')
    expect(permissionFor(fresh('CashCountRecorded', cashCount()))).toBe('close_register_shift')
    expect(permissionFor(fresh('ShiftClosed', closeout()))).toBe('close_register_shift')
  })

  it.each(REGISTER_TYPES)('%s is only created from a register device', (type) => {
    expect(ONLY_FROM_REGISTER.has(type)).toBe(true)
  })

  it('admin and cashier have both permissions; waiter and reports, neither', () => {
    const has = (role: keyof typeof DEFAULT_ROLES, p: string) =>
      (DEFAULT_ROLES[role].permissions as readonly string[]).includes(p)
    for (const p of ['cash_movement', 'close_register_shift']) {
      expect(has('admin', p), `admin ${p}`).toBe(true)
      expect(has('cashier', p), `cashier ${p}`).toBe(true)
      expect(has('waiter', p), `waiter ${p}`).toBe(false)
      expect(has('reports', p), `reports ${p}`).toBe(false)
    }
  })

  it('both permissions require a password, a PIN is not enough', () => {
    expect(PASSWORD_PERMISSIONS.has('cash_movement')).toBe(true)
    expect(PASSWORD_PERMISSIONS.has('close_register_shift')).toBe(true)
  })
})

describe('register events: the order reducer ignores them', () => {
  const registerEvents = () => [
    event(
      newId(),
      'CashMovementRecorded',
      movement() as never,
      {
        aggregate_type: 'register_shift',
      } as never,
    ),
    event(
      newId(),
      'CashCountRecorded',
      cashCount() as never,
      {
        aggregate_type: 'register_shift',
      } as never,
    ),
    event(
      newId(),
      'ShiftClosed',
      closeout() as never,
      {
        aggregate_type: 'register_shift',
      } as never,
    ),
  ]

  it('without an order they create none and report they are not order events', () => {
    for (const e of registerEvents()) {
      const r = applyEvent(null, e)
      expect(r.status, e.type).toBeNull()
      expect(r.issue?.type, e.type).toBe('not_in_order')
    }
  })

  it('with an open order the state stays identical, even if the event names its id', () => {
    const { order, status } = orderOpened()
    const withItem = applyAll([event(order, 'ItemAdded', itemCopy())], status)
    for (const base of registerEvents()) {
      const e = { ...base, aggregate_id: order }
      const r = applyEvent(withItem, e)
      expect(r.status, e.type).toEqual(withItem)
      expect(r.issue?.type, e.type).toBe('not_in_order')
    }
  })

  it('rebuilding an order with register events in between gives the same as without them', () => {
    const { order } = orderOpened()
    const opened = event(
      order,
      'OrderOpened',
      { channel: 'dine_in', table_id: null, guests: 1 },
      { sequence: 1 },
    )
    const item = event(order, 'ItemAdded', itemCopy({ unit_price: 10_000 }), {
      sequence: 5,
    })
    const [mov, cc, closeEvent] = registerEvents().map((e, i) => ({ ...e, sequence: 2 + i }))
    const without = rebuild([opened, item], order)
    const withIt = rebuild([opened, mov, cc, closeEvent, item] as never, order)
    expect(withIt).toEqual(without)
  })

  it('on their own they leave no order projection', () => {
    for (const e of registerEvents()) expect(rebuild([e], e.aggregate_id)).toBeNull()
  })
})

describe('config: register_variance_threshold', () => {
  it('defaults to $1,000', () => {
    expect(fullConfig().register_variance_threshold).toBe(1000)
  })

  it('an old config, without the field, takes $1,000', () => {
    expect(fullConfig({}).register_variance_threshold).toBe(1000)
  })

  it('accepts $0 to $1,000,000', () => {
    for (const v of [0, 1, 1000, 1_000_000])
      expect(fullConfig({ register_variance_threshold: v }).register_variance_threshold).toBe(v)
  })

  it.each([
    ['negative', -1],
    ['over the limit', 1_000_001],
    ['fractional', 500.5],
    ['NaN', Number.NaN],
    ['text', '1000'],
    ['null', null],
  ])('rejects a threshold: %s', (_, v) => {
    expect(() => fullConfig({ register_variance_threshold: v as never })).toThrow()
  })
})
