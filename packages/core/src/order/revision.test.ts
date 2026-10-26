import { describe, expect, it } from 'vitest'
import { type ApplicableEvent, type OrderEvent, validateNewEvent } from '../events/order'
import { newId } from '../id'
import { PRICE_LIMIT } from '../money'
import {
  again,
  cardPaymentData,
  cashPaymentData,
  event,
  itemCopy,
  SHIFT,
  WAITER,
} from '../testing/factory'
import { applyAll, issueOf, orderOpened } from '../testing/helpers'
import { applyEvent, rebuild } from './apply'

// Rules added after the review of task 0.5 (revisor-codigo and auditor-dinero).

const send = (order: string, ids: string[]) =>
  event(order, 'ItemsSent', {
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: ids }],
  })
const REASON = { reason: 'Motivo de prueba' }

describe('idempotency and foreign events', () => {
  it('an already applied event is ignored and one from another order is not applied', () => {
    const { order, status } = orderOpened()
    const add = event(order, 'ItemAdded', itemCopy())
    const withItem = applyAll([add], status)

    expect(issueOf(withItem, add)).toBe('event_already_applied')
    expect(issueOf(withItem, event(newId(), 'ItemAdded', itemCopy()))).toBe('foreign_event')
  })

  it('rebuild does not apply the same event twice', () => {
    const { order } = orderOpened()
    const open = event(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 })
    const item = itemCopy({ quantity: 3 })
    const add = event(order, 'ItemAdded', item)
    const sendIt = send(order, [item.item_id])
    const voidItem = event(
      order,
      'ItemVoided',
      { item_id: item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
      REASON,
    )

    expect(
      rebuild([open, add, sendIt, voidItem, voidItem], order)?.items[item.item_id]?.voidedQuantity,
    ).toBe(1)
  })

  it('a repeated refund is not applied twice', () => {
    const { order, status } = orderOpened()
    const payment = cardPaymentData(20_000)
    const paid = applyAll(
      [event(order, 'ItemAdded', itemCopy()), event(order, 'PaymentRecorded', payment)],
      status,
    )
    const refund = event(
      order,
      'RefundRecorded',
      {
        payment_id: payment.payment_id,
        refund_id: newId(),
        sale_amount: 1000,
        tip_amount: 0,
        method: 'card',
        register_shift_id: SHIFT,
      },
      REASON,
    )
    const makeOne = applyAll([refund], paid)

    expect(issueOf(makeOne, again(refund))).toBe('refund_already_exists')
  })

  it('projects an own event not yet confirmed (no sequence or hub fields)', () => {
    const { order, status } = orderOpened()
    const {
      sequence: _s,
      received_at: _r,
      business_day: _d,
      assignments: _a,
      affects: _f,
      authorized_by_id: _p,
      ...pending
    } = event(order, 'ItemAdded', itemCopy())
    const r = applyEvent(status, pending as ApplicableEvent)

    expect(r.issue).toBeNull()
    expect(r.status?.lastSequence).toBe(status.lastSequence)
  })
})

describe('kitchen and closed orders', () => {
  it('with the table already paid the kitchen keeps marking ready and served', () => {
    const { order, status } = orderOpened()
    const item = itemCopy({ unit_price: 10_000 })
    const closed = applyAll(
      [
        event(order, 'ItemAdded', item),
        send(order, [item.item_id]),
        event(order, 'PaymentRecorded', cardPaymentData(10_000)),
        event(order, 'OrderClosed', {}),
      ],
      status,
    )
    const ready = applyAll(
      [
        event(order, 'ItemReady', { item_ids: [item.item_id] }),
        event(order, 'TicketReprinted', { ticket_id: newId() }),
      ],
      closed,
    )

    expect(ready.items[item.item_id]?.status).toBe('ready')
    expect(issueOf(closed, event(order, 'WaiterAssigned', { waiter_id: newId() }))).toBe(
      'order_closed',
    )
  })

  it('without a KDS the waiter serves directly from sent', () => {
    const { order, status } = orderOpened()
    const item = itemCopy()
    const served = applyAll(
      [
        event(order, 'ItemAdded', item),
        send(order, [item.item_id]),
        event(order, 'ItemServed', { item_ids: [item.item_id] }),
      ],
      status,
    )

    expect(served.items[item.item_id]?.status).toBe('served')
  })

  it('a send with an item removed from another device still sends the rest', () => {
    const { order, status } = orderOpened()
    const a = itemCopy()
    const b = itemCopy()
    const withItems = applyAll(
      [
        event(order, 'ItemAdded', a),
        event(order, 'ItemAdded', b),
        event(order, 'ItemRemoved', { item_id: b.item_id }),
      ],
      status,
    )
    const r = applyEvent(withItems, send(order, [a.item_id, b.item_id]))

    expect(r.issue?.type).toBe('items_omitted')
    expect(r.status?.items[a.item_id]?.status).toBe('sent')
  })
})

describe('item changes', () => {
  it('changing the course respects the hold', () => {
    const { order, status } = orderOpened()
    const entry = itemCopy({ course: 'entry' })
    const held = applyAll(
      [event(order, 'CourseHeld', { course: 'dessert' }), event(order, 'ItemAdded', entry)],
      status,
    )

    const toDessert = applyAll(
      [event(order, 'ItemChanged', { item_id: entry.item_id, course: 'dessert' })],
      held,
    )
    expect(toDessert.items[entry.item_id]?.status).toBe('held')
    const toMainCourse = applyAll(
      [event(order, 'ItemChanged', { item_id: entry.item_id, course: 'main' })],
      toDessert,
    )
    expect(toMainCourse.items[entry.item_id]?.status).toBe('pending')
  })

  it('with a discount or split, notes, guest and course can change, but not the quantity', () => {
    const { order, status } = orderOpened()
    const item = itemCopy()
    const discounted = applyAll(
      [
        event(order, 'ItemAdded', item),
        event(
          order,
          'DiscountApplied',
          {
            discount_id: newId(),
            scope: 'item',
            rule: 'value',
            value: 1000,
            unit_count: null,
            amounts: [{ item_id: item.item_id, amount: 1000 }],
          },
          REASON,
        ),
      ],
      status,
    )

    expect(
      issueOf(
        discounted,
        event(order, 'ItemChanged', { item_id: item.item_id, notes: 'Sin hielo', guest: 2 }),
      ),
    ).toBeUndefined()
    expect(
      issueOf(discounted, event(order, 'ItemChanged', { item_id: item.item_id, quantity: 2 })),
    ).toBe('has_discounts')
  })

  it('an order does not exceed the total limit', () => {
    const { order, status } = orderOpened()
    const expensive = itemCopy({ unit_price: PRICE_LIMIT, quantity: 100 })
    const withExpensive = applyAll([event(order, 'ItemAdded', expensive)], status)

    expect(issueOf(withExpensive, event(order, 'ItemAdded', itemCopy({ unit_price: 1 })))).toBe(
      'total_exceeds',
    )
    expect(
      issueOf(
        withExpensive,
        event(order, 'ItemChanged', { item_id: expensive.item_id, quantity: 101 }),
      ),
    ).toBe('total_exceeds')
  })
})

describe('money: new rules', () => {
  it('the rounding adjustment must be exactly the one from the rule', () => {
    const { order, status } = orderOpened()
    const withItem = applyAll([event(order, 'ItemAdded', itemCopy({ unit_price: 36_810 }))], status)
    // With an adjustment of −36,810 the order would have closed without charging anything.
    const theft = {
      ...cashPaymentData(36_810, { rounding_adjustment: -10, change: 0 }),
      rounding_adjustment: -36_810,
      tendered: 0,
    }

    expect(
      validateNewEvent({ ...event(order, 'PaymentRecorded', cashPaymentData(1)), data: theft }).ok,
    ).toBe(false)
    expect(
      issueOf(
        withItem,
        event(
          order,
          'PaymentRecorded',
          cashPaymentData(36_810, { rounding_adjustment: -20, change: 0 }),
        ),
      ),
    ).toBe('invalid_adjustment')
    expect(
      issueOf(
        withItem,
        event(
          order,
          'PaymentRecorded',
          cashPaymentData(36_810, { rounding_adjustment: -10, change: 3200 }),
        ),
      ),
    ).toBeUndefined()
  })

  it('a payment with refunds is not voided (it would be returned twice)', () => {
    const { order, status } = orderOpened()
    const payment = cashPaymentData(40_900)
    const refunded = applyAll(
      [
        event(order, 'ItemAdded', itemCopy()),
        event(order, 'PaymentRecorded', payment),
        event(
          order,
          'RefundRecorded',
          {
            payment_id: payment.payment_id,
            refund_id: newId(),
            sale_amount: 10_000,
            tip_amount: 0,
            method: 'cash',
            register_shift_id: SHIFT,
          },
          REASON,
        ),
      ],
      status,
    )

    expect(
      issueOf(
        refunded,
        event(
          order,
          'PaymentVoided',
          { payment_id: payment.payment_id, register_shift_id: SHIFT },
          REASON,
        ),
      ),
    ).toBe('payment_has_refunds')
  })

  it('the refund goes through the same method as the payment', () => {
    const { order, status } = orderOpened()
    const payment = cardPaymentData(40_900)
    const paid = applyAll(
      [event(order, 'ItemAdded', itemCopy()), event(order, 'PaymentRecorded', payment)],
      status,
    )
    const inCash = event(
      order,
      'RefundRecorded',
      {
        payment_id: payment.payment_id,
        refund_id: newId(),
        sale_amount: 1000,
        tip_amount: 0,
        method: 'cash',
        register_shift_id: SHIFT,
      },
      REASON,
    )

    expect(issueOf(paid, inCash)).toBe('method_mismatch')
  })

  it('a voided cash payment with adjustment allows canceling the order', () => {
    const { order, status } = orderOpened()
    const payment = cashPaymentData(36_850, { rounding_adjustment: -50 })
    const voided = applyAll(
      [
        event(order, 'ItemAdded', itemCopy({ unit_price: 36_850 })),
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

    expect(applyAll([event(order, 'OrderCanceled', {}, REASON)], voided).status).toBe('canceled')
  })

  it('a comp must be worth exactly its units', () => {
    const { order, status } = orderOpened()
    const beers = itemCopy({ unit_price: 14_900, quantity: 3 })
    const withItem = applyAll([event(order, 'ItemAdded', beers)], status)
    const comp = (units: number, amount: number) =>
      event(
        order,
        'DiscountApplied',
        {
          discount_id: newId(),
          scope: 'item',
          rule: 'comp',
          value: amount,
          unit_count: units,
          amounts: [{ item_id: beers.item_id, amount }],
        },
        REASON,
      )

    expect(issueOf(withItem, comp(1, 14_900))).toBeUndefined()
    expect(issueOf(withItem, comp(1, 20_000))).toBe('invalid_discount')
    expect(issueOf(withItem, comp(4, 59_600))).toBe('invalid_discount')
  })

  it('a split does not name items that are not there', () => {
    const { order, status } = orderOpened()
    const withItem = applyAll([event(order, 'ItemAdded', itemCopy())], status)
    const check = (amount: number) => ({
      check_id: newId(),
      name: 'C',
      amount,
      suggested_tip: 0,
      items: [{ item_id: newId(), fraction: { n: 1, d: 2 } }],
    })

    expect(
      issueOf(withItem, event(order, 'CheckSplit', { checks: [check(1000), check(1000)] })),
    ).toBe('item_not_found')
  })
})

describe('move and merge: the copy must match', () => {
  function withItem() {
    const source = orderOpened()
    const item = itemCopy({ quantity: 2 })
    const status = applyAll([event(source.order, 'ItemAdded', item)], source.status)
    return { source: source.order, item, status }
  }
  const moved = (item: ReturnType<typeof itemCopy>, fields: Record<string, unknown> = {}) => ({
    item: { ...item, ...fields },
    status: 'pending' as const,
    voided_quantity: 0,
    added_by: WAITER,
  })

  it('moving with a price different from the real one is rejected: no sale disappears', () => {
    const { source, item, status } = withItem()
    const move = event(source, 'ItemsMoved', {
      target_order_id: newId(),
      items: [moved(item, { unit_price: 0 })],
    })

    expect(issueOf(status, move)).toBe('mismatched_copy')
  })

  it('merging without bringing all the items is rejected', () => {
    const { source, item, status } = withItem()
    const other = itemCopy()
    const withTwo = applyAll([event(source, 'ItemAdded', other)], status)
    const merge = event(newId(), 'OrdersMerged', {
      source_order_id: source,
      items: [moved(item)],
    })

    expect(issueOf(withTwo, merge)).toBe('mismatched_copy')
  })
})

describe('stricter schemas', () => {
  const base = (type: string, data: unknown, extras: Record<string, unknown> = {}) => {
    const template = event(newId(), 'TicketReprinted', {
      ticket_id: newId(),
    }) as OrderEvent
    const {
      sequence: _s,
      received_at: _r,
      business_day: _d,
      assignments: _a,
      affects: _f,
      authorized_by_id: _p,
      ...envelope
    } = template
    return validateNewEvent({ ...envelope, type, data, ...extras })
  }

  it('rejects extra fields instead of dropping them', () => {
    expect(base('GuestsChanged', { guests: 2 }).ok).toBe(true)
    expect(base('GuestsChanged', { guests: 2, extra: 'x' }).ok).toBe(false)
    expect(base('GuestsChanged', { guests: 2 }, { odd_field: 1 }).ok).toBe(false)
  })

  it('a card payment names the card terminal', () => {
    expect(base('PaymentRecorded', { ...cardPaymentData(1000), cardTerminal: null }).ok).toBe(false)
  })

  it('discounts: no repeated items, a value that adds up and percent in basis points', () => {
    const discount = (fields: Record<string, unknown>) => ({
      discount_id: newId(),
      scope: 'order',
      rule: 'value',
      value: 2000,
      unit_count: null,
      amounts: [],
      ...fields,
    })
    const a = newId()
    const reason = { reason: 'm' }
    expect(
      base(
        'DiscountApplied',
        discount({
          amounts: [
            { item_id: a, amount: 1000 },
            { item_id: a, amount: 1000 },
          ],
        }),
        reason,
      ).ok,
    ).toBe(false)
    expect(
      base('DiscountApplied', discount({ amounts: [{ item_id: a, amount: 1500 }] }), reason).ok,
    ).toBe(false)
    expect(
      base(
        'DiscountApplied',
        discount({ rule: 'percent', value: 50_000, amounts: [{ item_id: a, amount: 1000 }] }),
        reason,
      ).ok,
    ).toBe(false)
    expect(
      base(
        'DiscountApplied',
        discount({
          scope: 'item',
          amounts: [
            { item_id: a, amount: 1000 },
            { item_id: newId(), amount: 1000 },
          ],
        }),
        reason,
      ).ok,
    ).toBe(false)
  })

  it('splits: no repeated checks and item fractions that do not exceed 1', () => {
    const item = newId()
    const check = (id: string, fraction = { n: 1, d: 2 }) => ({
      check_id: id,
      name: 'C',
      amount: 1000,
      suggested_tip: 0,
      items: [{ item_id: item, fraction }],
    })
    const repeated = newId()
    expect(base('CheckSplit', { checks: [check(repeated), check(repeated)] }).ok).toBe(false)
    expect(base('CheckSplit', { checks: [check(newId()), check(newId())] }).ok).toBe(true)
    expect(
      base('CheckSplit', { checks: [check(newId(), { n: 2, d: 3 }), check(newId())] }).ok,
    ).toBe(false)
  })

  it('move names the target in related', () => {
    const target = newId()
    const { catalog_version: _c, price_channel_id: _p, ...item } = itemCopy()
    const data = {
      target_order_id: target,
      items: [{ item, status: 'pending', voided_quantity: 0, added_by: WAITER }],
    }
    expect(base('ItemsMoved', data).ok).toBe(false)
    expect(base('ItemsMoved', data, { related: [target] }).ok).toBe(true)
  })

  it('an item change must actually change something', () => {
    expect(base('ItemChanged', { item_id: newId(), quantity: undefined }).ok).toBe(false)
    expect(base('ItemModifiedAfterSend', { item_id: newId(), ticket_id: newId() }).ok).toBe(false)
  })
})
