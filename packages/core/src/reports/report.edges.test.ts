import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { rebuild } from '../order/apply'
import type { OrderState } from '../order/state'
import {
  cardPaymentData,
  cashPaymentData,
  event,
  inOrder,
  itemCopy,
  SHIFT,
  WAITER,
} from '../testing/factory'
import { type ReportInput, report } from './report'

// Report edge cases (task 1.9): rounding of the average, fallback texts, custom methods,
// refunds from another day, tips, and what happens when a table is merged or moved after
// voiding something.

const CONFIG: ReportInput['config'] = {
  sales_by_waiter: 'added_by',
  rounding_mode: 'half_up',
}
const DAY = '2026-10-24'
const period = { from: DAY, until: DAY }

/** Applies in the given order (with increasing sequences) and returns the state of `orderId`. */
function stateOf(events: OrderEvent[], orderId: string): OrderState {
  let last = 0
  const sortedEvents = events.map((e) => {
    const fresh = inOrder(e, last)
    last = fresh.sequence
    return fresh
  })
  const status = rebuild(sortedEvents, orderId)
  if (!status) throw new Error('The order was not rebuilt')
  return status
}

const open = (id: string, guests = 2) =>
  event(id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests })
const send = (id: string, itemIds: string[]) =>
  event(id, 'ItemsSent', {
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: itemIds }],
  })

describe('report: averages', () => {
  it('with half_even the average ticket rounds the half to even; with half_up, upward', () => {
    // 3 checks of 1 peso and 1 of 2 pesos does not work: net/checks = x,5 is needed.
    // Checks of 10.001 and 10.000: 20.001 ÷ 2 = 10.000,5.
    const orders = [10_001, 10_000].map((price) => {
      const id = newId()
      const item = itemCopy({ unit_price: price })
      const events = [
        open(id),
        event(id, 'ItemAdded', item),
        event(id, 'PaymentRecorded', cashPaymentData(price)),
        event(id, 'OrderClosed', {}, { business_day: DAY }),
      ]
      return stateOf(events, id)
    })
    const base = { ...period, closedIds: orders, related: [], events: [] }
    expect(report({ ...base, config: CONFIG }).sales.averageTicket).toBe(10_001)
    expect(
      report({ ...base, config: { ...CONFIG, rounding_mode: 'half_even' } }).sales.averageTicket,
    ).toBe(10_000)
  })

  it('spend per guest uses the guests of all orders, including those without a check', () => {
    const a = newId()
    const b = newId()
    const itemA = itemCopy({ unit_price: 30_000 })
    const orderA = stateOf(
      [
        open(a, 3),
        event(a, 'ItemAdded', itemA),
        event(a, 'PaymentRecorded', cashPaymentData(30_000)),
        event(a, 'OrderClosed', {}, { business_day: DAY }),
      ],
      a,
    )
    // An empty order: closed with 1 guest, it does not count as a check.
    const orderB = stateOf([open(b, 1), event(b, 'OrderClosed', {}, { business_day: DAY })], b)
    const r = report({
      ...period,
      closedIds: [orderA, orderB],
      related: [],
      events: [],
      config: CONFIG,
    })
    expect(r.sales).toMatchObject({ checks: 1, guests: 4, spendPerGuest: 7_500 })
    expect(r.sales.averageTicket).toBe(30_000)
  })
})

describe('report: fallback texts and times', () => {
  it('a void or cancellation of an unknown order does not make up values', () => {
    const id = newId()
    const voided = event(
      id,
      'ItemVoided',
      { item_id: newId(), quantity: 2, already_prepared: true, ticket_id: null },
      { reason: 'Se cayó', hub_estimated_time: '2026-10-24T21:00:00.000Z', received_at: undefined },
    )
    const canceled = event(id, 'OrderCanceled', {}, { reason: 'x' })
    const r = report({
      ...period,
      closedIds: [],
      related: [],
      events: [voided, canceled],
      config: CONFIG,
    })
    expect(r.voids).toEqual([
      expect.objectContaining({
        name: 'Producto',
        value: 0,
        orderNumber: null,
        units: 2,
        // Without a received time it falls back to the hub's estimate.
        time: '2026-10-24T21:00:00.000Z',
        authorizedById: null,
      }),
    ])
    expect(r.cancellations).toEqual([expect.objectContaining({ value: 0, orderNumber: null })])
  })

  it('the order number comes from the state and who authorized it, from the event', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 8_000, quantity: 3 })
    const authorizes = newId()
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      send(id, [item.item_id]),
      event(
        id,
        'ItemVoided',
        { item_id: item.item_id, quantity: 2, already_prepared: false, ticket_id: null },
        { reason: 'Error', authorized_by_id: authorizes },
      ),
    ]
    const status = stateOf(events, id)
    const r = report({
      ...period,
      closedIds: [],
      related: [{ ...status, dayNumber: 7 }],
      events,
      config: CONFIG,
    })
    expect(r.voids[0]).toMatchObject({
      orderNumber: 7,
      value: 16_000,
      authorizedById: authorizes,
      userId: WAITER,
    })
  })
})

describe('report: methods and refunds', () => {
  it('a custom method is listed separately by its id, and its void subtracts from that method', () => {
    const own = newId()
    const other = newId()
    const id = newId()
    const item = itemCopy({ unit_price: 40_000 })
    const p1 = cardPaymentData(10_000, {
      method: 'other',
      custom_method_id: own,
      cardTerminal: null,
    })
    const p2 = cardPaymentData(10_000, {
      method: 'other',
      custom_method_id: other,
      cardTerminal: null,
    })
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      event(id, 'PaymentRecorded', p1),
      event(id, 'PaymentRecorded', p2),
      event(
        id,
        'PaymentVoided',
        { payment_id: p1.payment_id, register_shift_id: SHIFT },
        { reason: 'm' },
      ),
    ]
    const r = report({
      ...period,
      closedIds: [],
      related: [stateOf(events, id)],
      events,
      config: CONFIG,
    })
    // The voided custom method ends with 0 payments and is not shown; the other one remains.
    expect(r.byMethod).toEqual([
      { method: 'other', customMethodId: other, sale: 10_000, tip: 0, payments: 1 },
    ])
  })

  it('a refund today of a payment from yesterday subtracts today, with the refund method and tip', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 30_000 })
    const payment = cardPaymentData(30_000, { tip: 3_000 })
    const refund = event(
      id,
      'RefundRecorded',
      {
        payment_id: payment.payment_id,
        refund_id: newId(),
        sale_amount: 5_000,
        tip_amount: 500,
        method: 'card',
        register_shift_id: SHIFT,
      },
      { reason: 'Cobro de más', business_day: DAY },
    )
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      event(id, 'PaymentRecorded', payment, { business_day: '2026-10-23' }),
      refund,
    ]
    const today = report({
      ...period,
      closedIds: [],
      related: [stateOf(events, id)],
      events,
      config: CONFIG,
    })
    expect(today.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: -5_000, tip: -500, payments: 0 },
    ])
    expect(today.tipPool.tips).toBe(-500)
    const yesterday = report({
      from: '2026-10-23',
      until: '2026-10-23',
      closedIds: [],
      related: [],
      events,
      config: CONFIG,
    })
    expect(yesterday.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 30_000, tip: 3_000, payments: 1 },
    ])
  })

  it('a closed order tip subtracts the refunded tip and the net subtracts the refunded sale', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 20_000, quantity: 2 })
    const payment = cashPaymentData(40_000, { tip: 4_000 })
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      send(id, [item.item_id]),
      event(id, 'PaymentRecorded', payment),
      event(id, 'OrderClosed', {}, { business_day: DAY }),
      event(id, 'OrderReopened', {}, { reason: 'm' }),
      event(
        id,
        'RefundRecorded',
        {
          payment_id: payment.payment_id,
          refund_id: newId(),
          sale_amount: 20_000,
          tip_amount: 1_000,
          method: 'cash',
          register_shift_id: SHIFT,
        },
        { reason: 'm' },
      ),
      event(
        id,
        'ItemVoided',
        { item_id: item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        { reason: 'm' },
      ),
      event(id, 'OrderClosed', {}, { business_day: '2026-10-25' }),
    ]
    const status = stateOf(events, id)
    expect(status.status).toBe('closed')
    // Reopened and closed again: it still belongs to the day of its first close.
    expect(status.businessDay).toBe(DAY)
    const r = report({ ...period, closedIds: [status], related: [], events, config: CONFIG })
    expect(r.sales).toMatchObject({ net: 20_000, voided: 20_000, tips: 3_000, checks: 1 })
  })
})

describe('report: tables merged or moved after a void', () => {
  // When two tables are merged the source order ends canceled and empty: the void made on it is
  // explained with the order as it was right before the void (`onVoid`, built by the hub).
  it('the void made before merging the tables keeps its product and its value', () => {
    const source = newId()
    const target = newId()
    const item = itemCopy({ unit_price: 12_000, quantity: 2, name: 'Limonada' })
    const before = [
      open(source),
      open(target),
      event(source, 'ItemAdded', item),
      send(source, [item.item_id]),
    ]
    const voidEvent = event(
      source,
      'ItemVoided',
      { item_id: item.item_id, quantity: 1, already_prepared: true, ticket_id: null },
      { reason: 'Se cayó' },
    )
    const mergeEvent = event(
      target,
      'OrdersMerged',
      {
        source_order_id: source,
        items: [{ item, status: 'sent', voided_quantity: 1, added_by: WAITER }],
      },
      { related: [source] },
    )
    const events = [...before, voidEvent, mergeEvent]
    const a = stateOf(events, source)
    const b = stateOf(events, target)
    expect(a.status).toBe('canceled')
    expect(b.items[item.item_id]).toMatchObject({ quantity: 2, voidedQuantity: 1 })
    const onVoid = new Map([[voidEvent.id, stateOf([...before, voidEvent].slice(0, -1), source)]])
    const r = report({
      ...period,
      closedIds: [],
      related: [a, b],
      onVoid,
      events,
      config: CONFIG,
    })
    expect(r.voids).toHaveLength(1)
    expect(r.voids[0]).toMatchObject({ name: 'Limonada', value: 12_000 })
  })

  it('tax is summed across orders and rounded once per group', () => {
    // Three checks of $16.000 at 8 %: each carries $1.185,19; together, $3.555,56 → $3.556
    // (rounding each check would give $3.555).
    const orders = [1, 2, 3].map(() => {
      const id = newId()
      const item = itemCopy({ unit_price: 16_000 })
      return stateOf(
        [
          open(id),
          event(id, 'ItemAdded', item),
          event(id, 'PaymentRecorded', cashPaymentData(16_000)),
          event(id, 'OrderClosed', {}, { business_day: DAY }),
        ],
        id,
      )
    })
    const r = report({
      ...period,
      closedIds: orders,
      related: [],
      events: [],
      config: CONFIG,
    })
    expect(r.sales.taxes).toEqual([{ type: 'inc', rate: 800, base: 48_000 - 3_556, tax: 3_556 }])
  })

  it('the cash rounding adjustment adds up the payments of closed orders', () => {
    const order = (price: number, adjustment: number) => {
      const id = newId()
      return stateOf(
        [
          open(id),
          event(id, 'ItemAdded', itemCopy({ unit_price: price })),
          event(id, 'PaymentRecorded', cashPaymentData(price, { rounding_adjustment: adjustment })),
          event(id, 'OrderClosed', {}, { business_day: DAY }),
        ],
        id,
      )
    }
    const r = report({
      ...period,
      closedIds: [order(12_960, 40), order(12_920, -20), order(10_000, 0)],
      related: [],
      events: [],
      config: CONFIG,
    })
    expect(r.sales.roundingAdjustments).toBe(20)
  })
})
