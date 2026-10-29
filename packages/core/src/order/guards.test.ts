import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { again, cardPaymentData, event, inOrder, itemCopy, SHIFT, WAITER } from '../testing/factory'
import { applyEvent, rebuild } from './apply'
import type { OrderState } from './state'

// Each rule that prevents applying an event, tested one by one
// (docs/MODELO_DATOS.md#reglas-de-aplicación).

function applyAll(events: OrderEvent[], initial: OrderState | null = null): OrderState {
  return events.reduce<OrderState | null>((status, e) => {
    const r = applyEvent(status, inOrder(e, status?.lastSequence ?? 0))
    if (r.issue) throw new Error(`${e.type}: ${r.issue.type}`)
    return r.status
  }, initial) as OrderState
}

const send = (order: string, ids: string[]) =>
  event(order, 'ItemsSent', {
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: ids }],
  })

const moved = (item: ReturnType<typeof itemCopy>) => ({
  item,
  status: 'sent' as const,
  voided_quantity: 0,
  added_by: WAITER,
})

/** Order with one sent $40.900 item. */
function base() {
  const order = newId()
  const item = itemCopy()
  const status = applyAll([
    event(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 }),
    event(order, 'ItemAdded', item),
    send(order, [item.item_id]),
  ])
  return { order, item, status }
}

const applyDiscount = (order: string, itemId: string, amount: number, discount = newId()) =>
  event(
    order,
    'DiscountApplied',
    {
      discount_id: discount,
      scope: 'item',
      rule: 'value',
      value: amount,
      unit_count: null,
      amounts: [{ item_id: itemId, amount }],
    },
    { reason: 'm' },
  )

const issue = (status: OrderState | null, e: OrderEvent) => applyEvent(status, e).issue?.type

describe('once the order is split its amounts cannot change', () => {
  const { order, item, status } = base()
  const pending = itemCopy()
  const withPending = applyAll([event(order, 'ItemAdded', pending)], status)
  const checks = [20_450, 20_450].map((amount, i) => ({
    check_id: newId(),
    name: `P${i}`,
    amount,
    suggested_tip: 0,
    items: [],
  }))
  const divided = applyAll([event(order, 'CheckSplit', { checks })], withPending)
  const voidItem = event(
    order,
    'ItemVoided',
    { item_id: item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
    { reason: 'm' },
  )

  it.each<[string, OrderEvent]>([
    ['change an item', event(order, 'ItemChanged', { item_id: pending.item_id, quantity: 2 })],
    ['void', voidItem],
    ['move', event(order, 'ItemsMoved', { target_order_id: newId(), items: [moved(item)] })],
    ['apply_discount', applyDiscount(order, item.item_id, 1000)],
    [
      'add priced extras',
      event(order, 'ItemModifiedAfterSend', {
        item_id: item.item_id,
        ticket_id: newId(),
        modifiers: [{ modifier_id: newId(), name: 'Extra', extra_price: 3000 }],
      }),
    ],
    [
      'receive a merged order',
      event(order, 'OrdersMerged', { source_order_id: newId(), items: [] }),
    ],
  ])('%s', (_case, e) => {
    expect(issue(divided, e)).toBe('order_split')
  })

  it('merge into another', () => {
    const merge = event(newId(), 'OrdersMerged', { source_order_id: order, items: [] })
    expect(issue(divided, merge)).toBe('order_split')
  })

  it('remove a discount', () => {
    const discount = newId()
    const discounted = applyAll([applyDiscount(order, item.item_id, 1000, discount)], withPending)
    const dividedWithDiscount = applyAll(
      [
        event(order, 'CheckSplit', {
          checks: checks.map((c) => ({ ...c, amount: 19_950 })),
        }),
      ],
      discounted,
    )
    expect(
      issue(
        dividedWithDiscount,
        event(order, 'DiscountRemoved', { discount_id: discount }, { reason: 'm' }),
      ),
    ).toBe('order_split')
  })
})

describe('with a discount on the line', () => {
  const { order, item, status } = base()
  const discounted = applyAll([applyDiscount(order, item.item_id, 5000)], status)

  it('it cannot be voided, moved or have its price changed', () => {
    expect(
      issue(
        discounted,
        event(
          order,
          'ItemVoided',
          { item_id: item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
          { reason: 'm' },
        ),
      ),
    ).toBe('has_discounts')
    expect(
      issue(
        discounted,
        event(order, 'ItemsMoved', { target_order_id: newId(), items: [moved(item)] }),
      ),
    ).toBe('has_discounts')
    expect(
      issue(
        discounted,
        event(order, 'ItemModifiedAfterSend', {
          item_id: item.item_id,
          ticket_id: newId(),
          modifiers: [{ modifier_id: newId(), name: 'Extra', extra_price: 3000 }],
        }),
      ),
    ).toBe('has_discounts')
  })

  it('changing only the notes is allowed', () => {
    expect(
      issue(
        discounted,
        event(order, 'ItemModifiedAfterSend', {
          item_id: item.item_id,
          ticket_id: newId(),
          notes: 'Sin albahaca',
        }),
      ),
    ).toBeUndefined()
  })

  it('a repeated discount or removing one that does not exist', () => {
    const discount = newId()
    const withDiscount = applyAll([applyDiscount(order, item.item_id, 1000, discount)], status)
    expect(issue(withDiscount, applyDiscount(order, item.item_id, 1000, discount))).toBe(
      'discount_already_exists',
    )
    expect(
      issue(status, event(order, 'DiscountRemoved', { discount_id: newId() }, { reason: 'm' })),
    ).toBe('discount_not_found')
  })

  it('discounting a nonexistent item or an already paid order', () => {
    expect(issue(status, applyDiscount(order, newId(), 1000))).toBe('item_not_found')
    const paid = applyAll([event(order, 'PaymentRecorded', cardPaymentData(40_900))], status)
    expect(issue(paid, applyDiscount(order, item.item_id, 1000))).toBe('negative_balance')
  })
})

describe('move and merge: invalid cases', () => {
  it('moving a nonexistent item, repeating it in the target or something already paid', () => {
    const { order, item, status } = base()
    const target = newId()
    const move = event(order, 'ItemsMoved', {
      target_order_id: target,
      items: [moved(item)],
    })
    expect(
      issue(
        status,
        event(order, 'ItemsMoved', {
          target_order_id: target,
          items: [moved(itemCopy())],
        }),
      ),
    ).toBe('item_not_found')

    const targetState = applyAll([
      event(target, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 0 }),
      move,
    ])
    expect(issue(targetState, again(move))).toBe('item_already_exists')

    const paid = applyAll([event(order, 'PaymentRecorded', cardPaymentData(40_900))], status)
    expect(issue(paid, again(move))).toBe('negative_balance')
  })

  it('merge: the order must be source or target and must not repeat items', () => {
    const { order, item, status } = base()
    expect(
      issue(status, event(newId(), 'OrdersMerged', { source_order_id: newId(), items: [] })),
    ).toBe('foreign_event')
    expect(
      issue(
        status,
        event(order, 'OrdersMerged', { source_order_id: newId(), items: [moved(item)] }),
      ),
    ).toBe('item_already_exists')
  })
})

describe('other cases', () => {
  it('modify after send: nonexistent item, voided item or one leaving a negative balance', () => {
    const { order, item, status } = base()
    const withExtra = itemCopy()
    const withExtras = applyAll(
      [
        event(order, 'ItemAdded', {
          ...withExtra,
          modifiers: [{ modifier_id: newId(), name: 'Extra', extra_price: 3000 }],
        }),
        send(order, [withExtra.item_id]),
        event(order, 'PaymentRecorded', cardPaymentData(84_800)),
      ],
      status,
    )
    const removeExtras = event(order, 'ItemModifiedAfterSend', {
      item_id: withExtra.item_id,
      ticket_id: newId(),
      modifiers: [],
    })
    expect(issue(withExtras, removeExtras)).toBe('negative_balance')
    expect(
      issue(
        status,
        event(order, 'ItemModifiedAfterSend', {
          item_id: newId(),
          ticket_id: newId(),
          notes: 'x',
        }),
      ),
    ).toBe('item_not_found')

    const voided = applyAll(
      [
        event(
          order,
          'ItemVoided',
          { item_id: item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
          { reason: 'm' },
        ),
      ],
      status,
    )
    expect(
      issue(
        voided,
        event(order, 'ItemModifiedAfterSend', {
          item_id: item.item_id,
          ticket_id: newId(),
          notes: 'x',
        }),
      ),
    ).toBe('item_already_voided')
  })

  it('change guest and course of an unsent item', () => {
    const { order, status } = base()
    const item = itemCopy()
    const changed = applyAll(
      [
        event(order, 'ItemAdded', item),
        event(order, 'ItemChanged', { item_id: item.item_id, guest: 2, course: 'main' }),
      ],
      status,
    )
    expect(changed.items[item.item_id]).toMatchObject({ guest: 2, course: 'main' })
    expect(issue(status, event(order, 'ItemChanged', { item_id: newId(), quantity: 2 }))).toBe(
      'item_not_found',
    )
  })

  it('holding a course does not touch items of other courses', () => {
    const { order, item, status } = base()
    const held = applyAll([event(order, 'CourseHeld', { course: 'dessert' })], status)
    expect(held.items[item.item_id]?.status).toBe('sent')
  })

  it('reprinting a ticket changes nothing in the order', () => {
    const { order, status } = base()
    const reprinted = applyAll([event(order, 'TicketReprinted', { ticket_id: newId() })], status)
    expect({ ...reprinted, lastSequence: 0 }).toEqual({ ...status, lastSequence: 0 })
  })

  it('a rescue order starts open and linked to the original', () => {
    const original = newId()
    const rescue = newId()
    const status = applyAll([
      event(rescue, 'RescueOrderCreated', {
        original_order_id: original,
        channel: 'dine_in',
        table_id: null,
        waiter_id: WAITER,
      }),
    ])
    expect(status).toMatchObject({
      id: rescue,
      status: 'open',
      rescueOf: original,
      guests: 0,
    })
  })

  it('refunding a nonexistent or voided payment', () => {
    const { order, status } = base()
    const payment = cardPaymentData(10_000)
    const voided = applyAll(
      [
        event(order, 'PaymentRecorded', payment),
        event(
          order,
          'PaymentVoided',
          { payment_id: payment.payment_id, register_shift_id: SHIFT },
          { reason: 'm' },
        ),
      ],
      status,
    )
    const issueRefund = (paymentId: string) =>
      event(
        order,
        'RefundRecorded',
        {
          payment_id: paymentId,
          refund_id: newId(),
          sale_amount: 1,
          tip_amount: 0,
          method: 'card',
          register_shift_id: SHIFT,
        },
        { reason: 'm' },
      )
    expect(issue(voided, issueRefund(newId()))).toBe('payment_not_found')
    expect(issue(voided, issueRefund(payment.payment_id))).toBe('payment_already_voided')
  })

  it('rebuild ignores events from other orders, even if they arrive first', () => {
    const { order } = base()
    const other = newId()
    const fromOther = event(
      other,
      'OrderOpened',
      { channel: 'bar', table_id: null, guests: 1 },
      { sequence: 1 },
    )
    const own = event(
      order,
      'OrderOpened',
      { channel: 'dine_in', table_id: null, guests: 2 },
      { sequence: 2 },
    )

    expect(rebuild([fromOther, own], order)?.id).toBe(order)
    expect(rebuild([fromOther], order)).toBeNull()
  })
})
