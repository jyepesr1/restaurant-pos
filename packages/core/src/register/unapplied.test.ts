import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { applyEvent, rebuild } from '../order/apply'
import { alerts } from '../reports/alerts'
import { report } from '../reports/report'
import { cardPaymentData, cashPaymentData, event, itemCopy, SHIFT } from '../testing/factory'
import { chargedInShift, shiftReconciliation, unappliedMoney } from './shift'

// Money the hub saved as not applied (`unapplied`, task 1.7b, docs/DINERO.md#caja): the reducer
// skips it, and the register, the reports and the alerts leave it apart with the sign it would have
// moved the register.

const DAY = '2026-10-24'
const CONFIG = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const
const NOT_APPLIED = { unapplied: true } as const
const SODEXO = newId()
const CASHIER = newId()
const SUPERVISOR = newId()

const opening = event(
  SHIFT,
  'ShiftOpened',
  { register_id: newId(), base: 100_000 },
  {
    aggregate_type: 'register_shift',
  },
)

/** An order with one item, already sent. */
function order(price = 40_900) {
  const id = newId()
  const item = itemCopy({ unit_price: price })
  const events: OrderEvent[] = [
    event(
      id,
      'OrderOpened',
      { channel: 'dine_in', table_id: newId(), guests: 2 },
      { assignments: { day_number: 7 } },
    ),
    event(id, 'ItemAdded', item),
    event(id, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [item.item_id] }],
    }),
  ]
  return { id, item, events }
}

describe('the reducer honors the verdict', () => {
  it('a marked event changes nothing and says why, even one that would apply', () => {
    const o = order()
    const status = rebuild(o.events, o.id)
    const payment = event(o.id, 'PaymentRecorded', cardPaymentData(40_900), NOT_APPLIED)
    const r = applyEvent(status, payment)
    expect(r.status).toBe(status)
    expect(r.issue?.type).toBe('unapplied')
    expect(rebuild([...o.events, payment], o.id)).toEqual(status)
    // Without the mark, it applies.
    expect(applyEvent(status, { ...payment, unapplied: undefined }).issue).toBeNull()
  })
})

describe('the register leaves it apart', () => {
  const o = order(50_000)
  const cash = event(o.id, 'PaymentRecorded', cashPaymentData(30_000, { tip: 2_000 }))
  const custom = event(
    o.id,
    'PaymentRecorded',
    cardPaymentData(20_000, { method: 'other', custom_method_id: SODEXO, cardTerminal: null }),
  )
  const lateCash = event(o.id, 'PaymentRecorded', cashPaymentData(5_000, { tip: 500 }), {
    ...NOT_APPLIED,
    user_id: CASHIER,
  })
  const lateVoid = event(
    o.id,
    'PaymentVoided',
    { payment_id: cash.data.payment_id, register_shift_id: SHIFT },
    { ...NOT_APPLIED, reason: 'Tarde', authorized_by_id: SUPERVISOR },
  )
  const lateRefund = event(
    o.id,
    'RefundRecorded',
    {
      payment_id: custom.data.payment_id,
      refund_id: newId(),
      sale_amount: 3_000,
      tip_amount: 0,
      method: 'other',
      register_shift_id: SHIFT,
    },
    { ...NOT_APPLIED, reason: 'Tarde' },
  )
  const orphanVoid = event(
    o.id,
    'PaymentVoided',
    { payment_id: newId(), register_shift_id: SHIFT },
    { ...NOT_APPLIED, reason: 'Tarde' },
  )
  const movement = event(
    SHIFT,
    'CashMovementRecorded',
    {
      movement_id: newId(),
      type: 'cash_in',
      amount: 10_000,
      description: 'Sencillo',
      to_whom: null,
      days: [],
    },
    { aggregate_type: 'register_shift' },
  )
  const events = [
    opening,
    ...o.events,
    cash,
    custom,
    movement,
    lateCash,
    lateVoid,
    lateRefund,
    orphanVoid,
  ]

  it('outside the expected cash and the methods; each one with its method, sign and tip', () => {
    const r = shiftReconciliation(events, SHIFT)
    const withoutTheLate = shiftReconciliation(
      events.filter((e) => !e.unapplied),
      SHIFT,
    )
    expect(r?.cash).toEqual(withoutTheLate?.cash)
    expect(r?.cash).toMatchObject({
      charged: 32_000,
      refunds: 0,
      cashIn: 10_000,
      expected: 142_000,
    })
    expect(r?.byMethod).toEqual(withoutTheLate?.byMethod)
    expect(chargedInShift(events, SHIFT)).toEqual(r?.byMethod)
    expect(r?.unapplied).toEqual([
      {
        eventId: lateCash.id,
        orderId: o.id,
        type: 'PaymentRecorded',
        method: 'cash',
        customMethodId: null,
        amount: 5_500,
        tip: 500,
        userId: CASHIER,
        time: lateCash.received_at,
      },
      expect.objectContaining({
        eventId: lateVoid.id,
        type: 'PaymentVoided',
        method: 'cash',
        amount: -32_000,
        tip: -2_000,
      }),
      expect.objectContaining({
        eventId: lateRefund.id,
        type: 'RefundRecorded',
        method: 'other',
        customMethodId: SODEXO,
        amount: -3_000,
        tip: 0,
      }),
      // The payment it would void is not among the events: method and amount unknown, not 0.
      expect.objectContaining({
        eventId: orphanVoid.id,
        method: null,
        customMethodId: null,
        amount: null,
        tip: null,
      }),
    ])
    expect(withoutTheLate?.unapplied).toEqual([])
  })

  it('only the events the check accepts (another shift is not this one)', () => {
    const elsewhere = event(
      o.id,
      'PaymentRecorded',
      cashPaymentData(1_000, { register_shift_id: newId() }),
      NOT_APPLIED,
    )
    const list = unappliedMoney([...events, elsewhere], (e) => e.data.register_shift_id === SHIFT)
    expect(list.map((u) => u.eventId)).toEqual([
      lateCash.id,
      lateVoid.id,
      lateRefund.id,
      orphanVoid.id,
    ])
  })

  it('the report: not in the methods nor the tip pool, apart in `unapplied`; the owner gets an alert each', () => {
    const closed = event(o.id, 'OrderClosed', {})
    const all = [...events.filter((e) => e.aggregate_type === 'order'), closed]
    const status = rebuild(all, o.id)
    expect(status?.status).toBe('closed')
    const r = report({
      from: DAY,
      until: DAY,
      closedIds: status ? [status] : [],
      related: [],
      events: all,
      config: CONFIG,
    })
    expect(r.byMethod.map((m) => [m.method, m.sale, m.tip])).toEqual([
      ['cash', 30_000, 2_000],
      ['other', 20_000, 0],
    ])
    expect(r.tipPool.tips).toBe(2_000)
    expect(r.unapplied.map((u) => u.amount)).toEqual([5_500, -32_000, -3_000, null])
    // Another day's not-applied money is not this day's.
    const other = report({
      from: '2026-10-25',
      until: '2026-10-25',
      related: [],
      events: all,
      config: CONFIG,
    })
    expect(other.unapplied).toEqual([])

    const list = alerts({
      day: DAY,
      voids: r.voids,
      cancellations: r.cancellations,
      orders: new Map([[o.id, all]]),
      registerClosings: [],
      threshold: 1_000,
      unapplied: r.unapplied,
    })
    expect(list.map((a) => a.type)).toEqual(Array(4).fill('unapplied_money'))
    const byId = new Map(list.map((a) => [a.id, a]))
    expect(byId.get(lateVoid.id)).toMatchObject({
      type: 'unapplied_money',
      kind: 'PaymentVoided',
      value: -32_000,
      method: 'cash',
      customMethodId: null,
      reason: 'Tarde',
      authorizedById: SUPERVISOR,
      order: { id: o.id, number: 7, channel: 'dine_in' },
    })
    expect(byId.get(lateCash.id)).toMatchObject({
      kind: 'PaymentRecorded',
      value: 5_500,
      userId: CASHIER,
      reason: null,
      authorizedById: null,
    })
    expect(byId.get(lateRefund.id)).toMatchObject({ value: -3_000, customMethodId: SODEXO })
    expect(byId.get(orphanVoid.id)).toMatchObject({ value: null, method: null })
    // Without the order's events at hand it is still an alert, with what the report knows.
    const bare = alerts({
      day: DAY,
      voids: [],
      cancellations: [],
      orders: new Map(),
      registerClosings: [],
      threshold: 1_000,
      unapplied: r.unapplied,
    })
    expect(bare.find((a) => a.id === lateVoid.id)).toMatchObject({
      order: { id: o.id, number: null, tableId: null, channel: null },
      reason: null,
      authorizedById: null,
    })
  })
})

describe('the report: what was not applied is not a void or a cancellation', () => {
  it('a marked second void and a marked cancellation are left out; the first void stays', () => {
    const o = order()
    const voidOf = (extras = {}) =>
      event(
        o.id,
        'ItemVoided',
        { item_id: o.item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        { reason: 'Error', ...extras },
      )
    const first = voidOf()
    const twice = voidOf(NOT_APPLIED)
    const canceled = event(o.id, 'OrderCanceled', {}, { reason: 'Se fueron', ...NOT_APPLIED })
    const all = [...o.events, first, twice, canceled]
    const status = rebuild(all, o.id)
    expect(status?.status).toBe('open')
    const r = report({
      from: DAY,
      until: DAY,
      related: status ? [status] : [],
      events: all,
      config: CONFIG,
    })
    expect(r.voids.map((v) => v.eventId)).toEqual([first.id])
    expect(r.cancellations).toEqual([])
    expect(r.unapplied).toEqual([])
  })
})

describe('alerts: the mark is enough, with or without the order’s opening', () => {
  it('a marked voided payment and refund are not payment_voided or refund alerts; a marked removal does not remove', () => {
    const o = order()
    const payment = event(o.id, 'PaymentRecorded', cardPaymentData(40_900))
    const discount = event(
      o.id,
      'DiscountApplied',
      {
        discount_id: newId(),
        scope: 'order',
        rule: 'value',
        value: 1_000,
        unit_count: null,
        amounts: [{ item_id: o.item.item_id, amount: 1_000 }],
      },
      { reason: 'Demora' },
    )
    const removal = event(
      o.id,
      'DiscountRemoved',
      { discount_id: discount.data.discount_id },
      { reason: 'Tarde', ...NOT_APPLIED },
    )
    const voided = event(
      o.id,
      'PaymentVoided',
      { payment_id: payment.data.payment_id, register_shift_id: SHIFT },
      { reason: 'Tarde', ...NOT_APPLIED },
    )
    // Only the day's events of the order, without its opening: the replay cannot judge them.
    const list = alerts({
      day: DAY,
      voids: [],
      cancellations: [],
      orders: new Map([[o.id, [discount, payment, removal, voided]]]),
      registerClosings: [],
      threshold: 1_000,
      unapplied: [],
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ type: 'discount', removedAt: null, removedBy: null })
  })
})
