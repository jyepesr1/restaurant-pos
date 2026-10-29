import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { allocateOrderDiscount, chargedInCash, equalParts, percent } from '../money'
import {
  again,
  cardPaymentData,
  cashPaymentData,
  event,
  inOrder,
  itemCopy,
  WAITER,
} from '../testing/factory'
import { applyEvent, rebuild } from './apply'
import type { OrderState } from './state'
import { checkBalance, orderTotals } from './totals'

/** Applies events in order and fails if any could not be applied. */
function applyAll(events: OrderEvent[], initial: OrderState | null = null): OrderState {
  return events.reduce<OrderState | null>((status, e) => {
    const r = applyEvent(status, inOrder(e, status?.lastSequence ?? 0))
    if (r.issue) throw new Error(`${e.type}: ${r.issue.type} (${r.issue.description})`)
    return r.status
  }, initial) as OrderState
}

function opened(order = newId()) {
  return {
    order,
    status: applyAll([
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
    ]),
  }
}

const send = (order: string, itemIds: string[]) =>
  event(order, 'ItemsSent', {
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: itemIds }],
  })

describe('full service', () => {
  it('opens, adds, sends, charges rounded cash and closes', () => {
    const { order, status } = opened()
    const pizza = itemCopy()
    const beer = itemCopy({ name: 'Corona', unit_price: 13_900, quantity: 2 })
    const withItems = applyAll(
      [
        event(order, 'ItemAdded', pizza),
        event(order, 'ItemAdded', beer),
        send(order, [pizza.item_id, beer.item_id]),
        event(order, 'ItemReady', { item_ids: [pizza.item_id] }),
        event(order, 'ItemServed', { item_ids: [pizza.item_id] }),
        event(order, 'PreBillPrinted', {
          check_id: null,
          subtotal: 68_700,
          suggested_tip: 6361,
        }),
      ],
      status,
    )
    expect(orderTotals(withItems)).toMatchObject({ gross: 68_700, net: 68_700, balance: 68_700 })

    const balance = orderTotals(withItems).balance
    const adjustment = chargedInCash(balance, 100) - balance
    const closed = applyAll(
      [
        event(
          order,
          'PaymentRecorded',
          cashPaymentData(balance, { rounding_adjustment: adjustment, tip: 6361, change: 4939 }),
        ),
        event(order, 'OrderClosed', {}, { business_day: '2026-10-24' }),
      ],
      withItems,
    )

    expect(closed.status).toBe('closed')
    expect(closed.businessDay).toBe('2026-10-24')
    expect(orderTotals(closed)).toMatchObject({
      balance: 0,
      paid: 68_700,
      tips: 6361,
      roundingAdjustments: 0,
    })
    expect(closed.items[pizza.item_id]?.status).toBe('served')
    expect(closed.items[beer.item_id]?.status).toBe('sent')
  })

  it('does not modify the previous state', () => {
    const { order, status } = opened()
    const frozen = structuredClone(status)

    applyEvent(status, event(order, 'ItemAdded', itemCopy()))

    expect(status).toEqual(frozen)
  })

  it('records who added each item and its order', () => {
    const { order, status } = opened()
    const luis = newId()
    const a = itemCopy()
    const b = itemCopy()
    const final = applyAll(
      [event(order, 'ItemAdded', a), event(order, 'ItemAdded', b, { user_id: luis })],
      status,
    )

    expect(final.items[a.item_id]).toMatchObject({ addedBy: WAITER })
    expect(final.items[b.item_id]).toMatchObject({ addedBy: luis, position: 2 })
  })
})

describe('order lifecycle', () => {
  it('cannot open twice or touch an order that does not exist', () => {
    const { order, status } = opened()

    expect(
      applyEvent(
        status,
        event(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 0 }),
      ).issue?.type,
    ).toBe('order_already_exists')
    expect(applyEvent(null, event(newId(), 'ItemAdded', itemCopy())).issue?.type).toBe(
      'order_not_found',
    )
  })

  it('closing requires a 0 balance; closed accepts no changes; reopening keeps the first close day', () => {
    const { order, status } = opened()
    const item = itemCopy({ unit_price: 20_000 })
    const withItem = applyAll([event(order, 'ItemAdded', item)], status)

    expect(applyEvent(withItem, event(order, 'OrderClosed', {})).issue?.type).toBe(
      'pending_balance',
    )

    const closed = applyAll(
      [
        event(order, 'PaymentRecorded', cardPaymentData(20_000)),
        event(order, 'OrderClosed', {}, { business_day: '2026-10-23' }),
      ],
      withItem,
    )
    expect(applyEvent(closed, event(order, 'ItemAdded', itemCopy())).issue?.type).toBe(
      'order_closed',
    )
    expect(applyEvent(closed, event(order, 'OrderReopened', {}, { reason: 'x' })).issue).toBeNull()
    expect(
      applyEvent(withItem, event(order, 'OrderReopened', {}, { reason: 'x' })).issue?.type,
    ).toBe('order_not_closed')

    const reopenedAndClosed = applyAll(
      [
        event(order, 'OrderReopened', {}, { reason: 'Faltó un postre' }),
        event(order, 'OrderClosed', {}, { business_day: '2026-10-24' }),
      ],
      closed,
    )
    expect(reopenedAndClosed.businessDay).toBe('2026-10-23')
  })

  it('canceling requires no current payments', () => {
    const { order, status } = opened()
    const withPayment = applyAll(
      [
        event(order, 'ItemAdded', itemCopy()),
        event(order, 'PaymentRecorded', cardPaymentData(10_000)),
      ],
      status,
    )

    expect(
      applyEvent(withPayment, event(order, 'OrderCanceled', {}, { reason: 'm' })).issue?.type,
    ).toBe('has_payments')
    expect(
      applyEvent(status, event(order, 'OrderCanceled', {}, { reason: 'm' })).status?.status,
    ).toBe('canceled')
  })

  it('waiter, guests and table', () => {
    const { order, status } = opened()
    const other = newId()
    const table = newId()
    const final = applyAll(
      [
        event(order, 'WaiterAssigned', { waiter_id: other }),
        event(order, 'GuestsChanged', { guests: 6 }),
        event(order, 'OrderMovedTable', { target_table_id: table }),
      ],
      status,
    )

    expect(final).toMatchObject({ assignedWaiterId: other, guests: 6, tableId: table })
  })

  it('a large party merges tables and separates them; its own does not count twice', () => {
    const { order, status } = opened()
    const [m5, m6] = [newId(), newId()]
    const mergedState = applyAll(
      [
        event(order, 'OrderMovedTable', { target_table_id: m5 }),
        event(order, 'TablesMerged', { table_ids: [m6, m5] }),
      ],
      status,
    )
    expect(mergedState.mergedTables).toEqual([m6])
    expect(
      applyEvent(mergedState, event(order, 'TablesMerged', { table_ids: [m6] })).issue?.type,
    ).toBe('tables_already_merged')
    // Moving to the merged table makes it the main one.
    expect(
      applyAll([event(order, 'OrderMovedTable', { target_table_id: m6 })], mergedState),
    ).toMatchObject({
      tableId: m6,
      mergedTables: [],
    })
    expect(
      applyAll([event(order, 'TablesSeparated', { table_ids: [m6] })], mergedState).mergedTables,
    ).toEqual([])
  })

  it('the order note is set without extra spaces and removed with null or empty', () => {
    const { order, status } = opened()
    expect(status.notes).toBeNull()
    const noteSet = applyAll(
      [event(order, 'OrderNoteChanged', { notes: '  alérgico al maní ' })],
      status,
    )
    expect(noteSet.notes).toBe('alérgico al maní')
    expect(applyAll([event(order, 'OrderNoteChanged', { notes: '   ' })], noteSet).notes).toBeNull()
    expect(applyAll([event(order, 'OrderNoteChanged', { notes: null })], noteSet).notes).toBeNull()
  })
})

describe('items', () => {
  it('change or remove only before sending', () => {
    const { order, status } = opened()
    const item = itemCopy()
    const withItem = applyAll([event(order, 'ItemAdded', item)], status)

    expect(
      applyEvent(
        withItem,
        event(order, 'ItemChanged', {
          item_id: item.item_id,
          quantity: 3,
          notes: 'Sin cebolla',
        }),
      ).status?.items[item.item_id],
    ).toMatchObject({ quantity: 3, notes: 'Sin cebolla' })
    expect(
      applyEvent(withItem, event(order, 'ItemRemoved', { item_id: item.item_id })).status?.items[
        item.item_id
      ],
    ).toBeUndefined()

    const sent = applyAll([send(order, [item.item_id])], withItem)
    const r = applyEvent(sent, event(order, 'ItemRemoved', { item_id: item.item_id }))
    expect(r.issue?.type).toBe('item_already_sent')
    expect(r.status).toBe(sent)
  })

  it('removing or changing an unsent item in an already paid order leaves no negative balance', () => {
    // Case found by the property test.
    const { order, status } = opened()
    const item = itemCopy({ unit_price: 10_000, quantity: 2 })
    const paid = applyAll(
      [event(order, 'ItemAdded', item), event(order, 'PaymentRecorded', cardPaymentData(20_000))],
      status,
    )

    expect(
      applyEvent(paid, event(order, 'ItemRemoved', { item_id: item.item_id })).issue?.type,
    ).toBe('negative_balance')
    expect(
      applyEvent(paid, event(order, 'ItemChanged', { item_id: item.item_id, quantity: 1 })).issue
        ?.type,
    ).toBe('negative_balance')
    expect(
      applyEvent(paid, event(order, 'ItemChanged', { item_id: item.item_id, quantity: 3 })).issue,
    ).toBeNull()
  })

  it('a repeated item is not added twice', () => {
    const { order, status } = opened()
    const item = itemCopy()
    const withItem = applyAll([event(order, 'ItemAdded', item)], status)

    expect(applyEvent(withItem, event(order, 'ItemAdded', item)).issue?.type).toBe(
      'item_already_exists',
    )
  })

  it('a held course holds its items until it is fired', () => {
    const { order, status } = opened()
    const dessert = itemCopy({ name: 'Panna Cotta', course: 'dessert' })
    const otherDessert = itemCopy({ name: 'Pera Tentazione', course: 'dessert' })
    const held = applyAll(
      [
        event(order, 'ItemAdded', dessert),
        event(order, 'CourseHeld', { course: 'dessert' }),
        event(order, 'ItemAdded', otherDessert),
      ],
      status,
    )

    expect(held.items[dessert.item_id]?.status).toBe('held')
    expect(held.items[otherDessert.item_id]?.status).toBe('held')
    expect(applyEvent(held, send(order, [dessert.item_id])).issue?.type).toBe('invalid_item_status')

    const fired = applyAll([event(order, 'CourseFired', { course: 'dessert' })], held)
    expect(fired.items[dessert.item_id]?.status).toBe('pending')
    expect(fired.heldCourses).toEqual([])
  })

  it('preparation: sent → in preparation → ready → served, and recovering one marked by mistake', () => {
    const { order, status } = opened()
    const item = itemCopy()
    const ready = applyAll(
      [
        event(order, 'ItemAdded', item),
        send(order, [item.item_id]),
        event(order, 'ItemInPreparation', { item_ids: [item.item_id] }),
        event(order, 'ItemReady', { item_ids: [item.item_id] }),
      ],
      status,
    )
    expect(ready.items[item.item_id]?.status).toBe('ready')
    expect(
      applyAll([event(order, 'ItemReturnedToQueue', { item_ids: [item.item_id] })], ready).items[
        item.item_id
      ]?.status,
    ).toBe('sent')
    expect(
      applyEvent(ready, event(order, 'ItemInPreparation', { item_ids: [item.item_id] })).issue
        ?.type,
    ).toBe('invalid_item_status')
  })

  it('a status change of several items applies to those that can and reports the rest', () => {
    const { order, status } = opened()
    const a = itemCopy()
    const b = itemCopy()
    const partial = applyAll(
      [event(order, 'ItemAdded', a), event(order, 'ItemAdded', b), send(order, [a.item_id])],
      status,
    )

    const r = applyEvent(partial, event(order, 'ItemReady', { item_ids: [a.item_id, b.item_id] }))
    // b has not been sent: a becomes ready anyway and b is reported as left out.
    expect(r.issue?.type).toBe('items_omitted')
    expect(r.status?.items[a.item_id]?.status).toBe('ready')
    expect(r.status?.items[b.item_id]?.status).toBe('pending')
    expect(
      applyEvent(partial, event(order, 'ItemReady', { item_ids: [b.item_id] })).issue?.type,
    ).toBe('invalid_item_status')
    expect(
      applyEvent(partial, event(order, 'ItemReady', { item_ids: [newId()] })).issue?.type,
    ).toBe('item_not_found')
  })

  it('modifying after sending changes notes and extras; does not apply to unsent items', () => {
    const { order, status } = opened()
    const item = itemCopy()
    const withItem = applyAll([event(order, 'ItemAdded', item)], status)
    const modify = event(order, 'ItemModifiedAfterSend', {
      item_id: item.item_id,
      ticket_id: newId(),
      notes: 'Bien cocido',
      modifiers: [{ modifier_id: newId(), name: 'Extra burrata', extra_price: 8000 }],
    })

    expect(applyEvent(withItem, modify).issue?.type).toBe('item_not_sent')
    const modified = applyAll([send(order, [item.item_id]), again(modify)], withItem)
    expect(modified.items[item.item_id]?.notes).toBe('Bien cocido')
    expect(orderTotals(modified).net).toBe(48_900)
  })
})

describe('voids', () => {
  it('partial void: 1 of 3 beers keeps the original quantity for reports', () => {
    const { order, status } = opened()
    const beers = itemCopy({ name: 'Heineken', unit_price: 14_900, quantity: 3 })
    const voidedItem = applyAll(
      [
        event(order, 'ItemAdded', beers),
        send(order, [beers.item_id]),
        event(
          order,
          'ItemVoided',
          { item_id: beers.item_id, quantity: 1, already_prepared: false, ticket_id: null },
          { reason: 'Cliente cambió' },
        ),
      ],
      status,
    )

    expect(voidedItem.items[beers.item_id]).toMatchObject({
      quantity: 3,
      voidedQuantity: 1,
      status: 'sent',
    })
    expect(orderTotals(voidedItem)).toMatchObject({ gross: 44_700, voided: 14_900, net: 29_800 })

    const allRows = applyAll(
      [
        event(
          order,
          'ItemVoided',
          { item_id: beers.item_id, quantity: 2, already_prepared: false, ticket_id: null },
          { reason: 'm' },
        ),
      ],
      voidedItem,
    )
    expect(allRows.items[beers.item_id]?.status).toBe('voided')
    expect(
      applyEvent(
        allRows,
        event(
          order,
          'ItemVoided',
          { item_id: beers.item_id, quantity: 1, already_prepared: false, ticket_id: null },
          { reason: 'm' },
        ),
      ).issue?.type,
    ).toBe('item_already_voided')
  })

  it('does not void more units than remain nor unsent items', () => {
    const { order, status } = opened()
    const item = itemCopy({ quantity: 2 })
    const withItem = applyAll([event(order, 'ItemAdded', item)], status)
    const voidItem = (quantity: number) =>
      event(
        order,
        'ItemVoided',
        { item_id: item.item_id, quantity, already_prepared: true, ticket_id: null },
        { reason: 'm' },
      )

    expect(applyEvent(withItem, voidItem(1)).issue?.type).toBe('item_not_sent')
    expect(
      applyEvent(applyAll([send(order, [item.item_id])], withItem), voidItem(3)).issue?.type,
    ).toBe('invalid_quantity')
  })

  it('voiding something already paid requires a refund first', () => {
    const { order, status } = opened()
    const item = itemCopy({ unit_price: 12_900 })
    const payment = cardPaymentData(12_900)
    const paid = applyAll(
      [
        event(order, 'ItemAdded', item),
        send(order, [item.item_id]),
        event(order, 'PaymentRecorded', payment),
      ],
      status,
    )
    const voidItem = event(
      order,
      'ItemVoided',
      { item_id: item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
      { reason: 'm' },
    )

    expect(applyEvent(paid, voidItem).issue?.type).toBe('negative_balance')

    const refunded = applyAll(
      [
        event(
          order,
          'RefundRecorded',
          {
            payment_id: payment.payment_id,
            refund_id: newId(),
            sale_amount: 12_900,
            tip_amount: 0,
            method: 'card',
            register_shift_id: payment.register_shift_id,
          },
          { reason: 'Plato devuelto' },
        ),
      ],
      paid,
    )
    expect(applyEvent(refunded, again(voidItem)).issue).toBeNull()
  })
})

describe('discounts', () => {
  it('10% on the order allocated in pesos and removed', () => {
    const { order, status } = opened()
    const pizza = itemCopy()
    const beer = itemCopy({ unit_price: 12_900 })
    const withItems = applyAll(
      [event(order, 'ItemAdded', pizza), event(order, 'ItemAdded', beer)],
      status,
    )
    const amounts = allocateOrderDiscount(percent(53_800, 1000), [40_900, 12_900]) ?? []
    const discount = newId()
    const discounted = applyAll(
      [
        event(
          order,
          'DiscountApplied',
          {
            discount_id: discount,
            scope: 'order',
            rule: 'percent',
            value: 1000,
            unit_count: null,
            amounts: [
              { item_id: pizza.item_id, amount: amounts[0] ?? 0 },
              { item_id: beer.item_id, amount: amounts[1] ?? 0 },
            ],
          },
          { reason: 'Cliente frecuente' },
        ),
      ],
      withItems,
    )

    expect(orderTotals(discounted)).toMatchObject({
      gross: 53_800,
      discount: 5380,
      net: 48_420,
    })
    expect(
      applyEvent(discounted, event(order, 'ItemChanged', { item_id: pizza.item_id, quantity: 2 }))
        .issue?.type,
    ).toBe('has_discounts')
    expect(
      orderTotals(
        applyAll(
          [event(order, 'DiscountRemoved', { discount_id: discount }, { reason: 'm' })],
          discounted,
        ),
      ).net,
    ).toBe(53_800)
  })

  it('a discount that leaves a negative line is rejected', () => {
    const { order, status } = opened()
    const item = itemCopy()
    const withItem = applyAll([event(order, 'ItemAdded', item)], status)
    const apply_discount = (amount: number) =>
      event(
        order,
        'DiscountApplied',
        {
          discount_id: newId(),
          scope: 'item',
          rule: 'value',
          value: amount,
          unit_count: null,
          amounts: [{ item_id: item.item_id, amount }],
        },
        { reason: 'm' },
      )

    expect(applyEvent(withItem, apply_discount(50_000)).issue?.type).toBe('discount_exceeds')
    expect(applyEvent(withItem, apply_discount(40_900)).issue).toBeNull()
  })
})

describe('splitting and payments', () => {
  function divided() {
    const { order, status } = opened()
    const item = itemCopy({ unit_price: 100_000 })
    const amounts = equalParts(100_000, 3)
    const checks = amounts.map((amount, i) => ({
      check_id: newId(),
      name: `Parte ${i + 1}`,
      amount,
      suggested_tip: 0,
      items: [],
    }))
    const final = applyAll(
      [event(order, 'ItemAdded', item), event(order, 'CheckSplit', { checks })],
      status,
    )
    return { order, status: final, checks }
  }

  it('100,000 in 3: each check is paid separately and what is added later stays unassigned', () => {
    const { order, status, checks } = divided()
    const [first] = checks
    const paidOrder = applyAll(
      [
        event(
          order,
          'PaymentRecorded',
          cardPaymentData(33_334, { check_id: first?.check_id ?? null }),
        ),
      ],
      status,
    )

    expect(checkBalance(paidOrder, first?.check_id ?? null)).toBe(0)
    expect(
      applyEvent(
        paidOrder,
        event(order, 'PaymentRecorded', cardPaymentData(1, { check_id: first?.check_id ?? null })),
      ).issue?.type,
    ).toBe('payment_exceeds_balance')
    expect(applyEvent(paidOrder, event(order, 'ItemAdded', itemCopy())).issue).toBeNull()
    expect(
      applyEvent(paidOrder, event(order, 'ItemRemoved', { item_id: newId() })).issue?.type,
    ).toBe('item_not_found')
    expect(applyEvent(paidOrder, event(order, 'SplitUndone', {})).issue?.type).toBe('has_payments')
  })

  it('a payment without a check in a split order only covers the unassigned part', () => {
    const { order, status } = divided()
    const withExtra = applyAll(
      [event(order, 'ItemAdded', itemCopy({ unit_price: 12_900 }))],
      status,
    )

    expect(
      applyEvent(withExtra, event(order, 'PaymentRecorded', cardPaymentData(12_901))).issue?.type,
    ).toBe('payment_exceeds_balance')
    expect(
      applyEvent(withExtra, event(order, 'PaymentRecorded', cardPaymentData(12_900))).issue,
    ).toBeNull()
  })

  it('does not split twice or for more than the balance; undoing without payments works', () => {
    const { order, status, checks } = divided()

    expect(applyEvent(status, event(order, 'CheckSplit', { checks })).issue?.type).toBe(
      'order_split',
    )
    expect(applyEvent(status, event(order, 'SplitUndone', {})).status?.checks).toBeNull()

    const other = opened()
    const withItem = applyAll(
      [event(other.order, 'ItemAdded', itemCopy({ unit_price: 1000 }))],
      other.status,
    )
    expect(applyEvent(withItem, event(other.order, 'CheckSplit', { checks })).issue?.type).toBe(
      'split_mismatch',
    )
    expect(applyEvent(withItem, event(other.order, 'SplitUndone', {})).issue?.type).toBe(
      'order_not_split',
    )
  })

  it('a check that does not exist and a repeated payment', () => {
    const { order, status } = opened()
    const payment = cardPaymentData(10_000)
    const withPayment = applyAll(
      [event(order, 'ItemAdded', itemCopy()), event(order, 'PaymentRecorded', payment)],
      status,
    )

    expect(applyEvent(withPayment, event(order, 'PaymentRecorded', payment)).issue?.type).toBe(
      'payment_already_exists',
    )
    expect(
      applyEvent(
        withPayment,
        event(order, 'PaymentRecorded', cardPaymentData(1, { check_id: newId() })),
      ).issue?.type,
    ).toBe('check_not_found')
  })

  it('the rounding adjustment only goes on the payment that brings the balance to 0', () => {
    const { order, status } = opened()
    const withItem = applyAll([event(order, 'ItemAdded', itemCopy({ unit_price: 36_810 }))], status)

    expect(
      applyEvent(
        withItem,
        event(order, 'PaymentRecorded', cashPaymentData(10_000, { rounding_adjustment: -10 })),
      ).issue?.type,
    ).toBe('invalid_adjustment')
    const paid = applyAll(
      [
        event(
          order,
          'PaymentRecorded',
          cashPaymentData(36_810, { rounding_adjustment: -10, change: 3200 }),
        ),
      ],
      withItem,
    )
    expect(orderTotals(paid)).toMatchObject({ balance: 0, roundingAdjustments: -10 })
  })

  it('voiding a payment restores the balance; voiding it twice does not', () => {
    const { order, status } = opened()
    const payment = cardPaymentData(40_900)
    const paid = applyAll(
      [event(order, 'ItemAdded', itemCopy()), event(order, 'PaymentRecorded', payment)],
      status,
    )
    const voidItem = event(
      order,
      'PaymentVoided',
      { payment_id: payment.payment_id, register_shift_id: payment.register_shift_id },
      { reason: 'Datáfono rechazó' },
    )
    const voided = applyAll([voidItem], paid)

    expect(orderTotals(voided).balance).toBe(40_900)
    // The same event again is ignored; another void of the same payment is rejected.
    expect(applyEvent(voided, voidItem).issue?.type).toBe('event_already_applied')
    expect(applyEvent(voided, again(voidItem)).issue?.type).toBe('payment_already_voided')
    expect(
      applyEvent(
        paid,
        event(
          order,
          'PaymentVoided',
          { payment_id: newId(), register_shift_id: payment.register_shift_id },
          { reason: 'm' },
        ),
      ).issue?.type,
    ).toBe('payment_not_found')
  })

  it('the refund does not exceed what was paid, nor what was charged in cash with adjustment', () => {
    const { order, status } = opened()
    const payment = cashPaymentData(36_850, { rounding_adjustment: -50 })
    const paid = applyAll(
      [
        event(order, 'ItemAdded', itemCopy({ unit_price: 36_850 })),
        event(order, 'PaymentRecorded', payment),
      ],
      status,
    )
    const issueRefund = (sale: number, tip = 0) =>
      event(
        order,
        'RefundRecorded',
        {
          payment_id: payment.payment_id,
          refund_id: newId(),
          sale_amount: sale,
          tip_amount: tip,
          method: 'cash',
          register_shift_id: payment.register_shift_id,
        },
        { reason: 'm' },
      )

    expect(applyEvent(paid, issueRefund(36_850)).issue?.type).toBe('refund_exceeds')
    // Refunding the whole charged sale (36,800) leaves the adjustment dangling: the payment must be
    // voided instead.
    expect(applyEvent(paid, issueRefund(36_800)).issue?.type).toBe('use_void')
    expect(applyEvent(paid, issueRefund(36_799)).issue).toBeNull()
    expect(applyEvent(paid, issueRefund(1, 1)).issue?.type).toBe('refund_exceeds')
  })
})

describe('move and merge', () => {
  it('ItemsMoved removes from the source and adds to the target, keeping who added it', () => {
    const source = opened()
    const target = opened()
    const item = itemCopy()
    const withItem = applyAll([event(source.order, 'ItemAdded', item)], source.status)
    const moved = withItem.items[item.item_id]
    const move = event(
      source.order,
      'ItemsMoved',
      {
        target_order_id: target.order,
        items: [
          {
            item,
            status: 'pending',
            voided_quantity: 0,
            added_by: moved?.addedBy ?? WAITER,
          },
        ],
      },
      { related: [target.order] },
    )

    expect(applyAll([move], withItem).items[item.item_id]).toBeUndefined()
    expect(applyAll([move], target.status).items[item.item_id]).toMatchObject({
      addedBy: WAITER,
      status: 'pending',
    })
    expect(applyEvent(opened().status, move).issue?.type).toBe('foreign_event')
  })

  it('OrdersMerged cancels the source and moves its items to the target', () => {
    const source = opened()
    const target = opened()
    const item = itemCopy()
    const withItem = applyAll([event(source.order, 'ItemAdded', item)], source.status)
    const merge = event(
      target.order,
      'OrdersMerged',
      {
        source_order_id: source.order,
        items: [{ item, status: 'pending', voided_quantity: 0, added_by: WAITER }],
      },
      { related: [source.order] },
    )

    expect(applyAll([merge], withItem)).toMatchObject({
      status: 'canceled',
      mergedInto: target.order,
      items: {},
    })
    expect(Object.keys(applyAll([merge], target.status).items)).toEqual([item.item_id])
  })

  it('does not merge an order that already has payments', () => {
    const source = opened()
    const withPayment = applyAll(
      [
        event(source.order, 'ItemAdded', itemCopy()),
        event(source.order, 'PaymentRecorded', cardPaymentData(1000)),
      ],
      source.status,
    )
    const merge = event(
      newId(),
      'OrdersMerged',
      { source_order_id: source.order, items: [] },
      { related: [source.order] },
    )

    expect(applyEvent(withPayment, merge).issue?.type).toBe('has_payments')
  })
})

describe('reducer guarantees', () => {
  it('never throws: a malformed event is reported as an issue', () => {
    const { order, status } = opened()
    const faulty = {
      ...event(order, 'ItemReady', { item_ids: [newId()] }),
      data: null,
    } as unknown as OrderEvent

    expect(applyEvent(status, faulty).issue?.type).toBe('invalid_event')
  })

  it('rebuild applies in sequence order even if they arrive out of order', () => {
    const { order } = opened()
    const open = event(
      order,
      'OrderOpened',
      { channel: 'bar', table_id: null, guests: 1 },
      { sequence: 1 },
    )
    const item = itemCopy()
    const add = event(order, 'ItemAdded', item, { sequence: 2 })
    const sendIt = { ...send(order, [item.item_id]), sequence: 3 }

    const status = rebuild([sendIt, add, open], order)
    expect(status?.items[item.item_id]?.status).toBe('sent')
    expect(status?.lastSequence).toBe(3)
  })

  it('property: with any sequence of events it does not throw, is deterministic and the balance is never negative', () => {
    const order = newId()
    const items = Array.from({ length: 4 }, (_, i) =>
      itemCopy({ unit_price: 10_000 + i * 2900, quantity: 1 + i }),
    )
    const make = (action: number, i: number, amount: number): OrderEvent => {
      const item = items[i % items.length] ?? items[0]
      const id = item?.item_id ?? newId()
      switch (action % 9) {
        case 0:
          return event(order, 'ItemAdded', item ?? itemCopy())
        case 1:
          return send(order, [id])
        case 2:
          return event(order, 'ItemReady', { item_ids: [id] })
        case 3:
          return event(
            order,
            'ItemVoided',
            { item_id: id, quantity: 1, already_prepared: false, ticket_id: null },
            { reason: 'm' },
          )
        case 4:
          return event(
            order,
            'DiscountApplied',
            {
              discount_id: newId(),
              scope: 'item',
              rule: 'value',
              value: amount,
              unit_count: null,
              amounts: [{ item_id: id, amount }],
            },
            { reason: 'm' },
          )
        case 5:
          return event(order, 'PaymentRecorded', cardPaymentData(Math.max(1, amount)))
        case 6:
          return event(order, 'ItemRemoved', { item_id: id })
        case 7:
          return event(order, 'OrderClosed', {})
        default:
          return event(order, 'OrderReopened', {}, { reason: 'm' })
      }
    }
    const open = event(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 })

    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.integer({ min: 0, max: 60_000 })), {
          maxLength: 30,
        }),
        (actions) => {
          const events = [open, ...actions.map(([a, i, m]) => make(a, i, m))]
          const fold = () =>
            events.reduce<OrderState | null>((status, e) => applyEvent(status, e).status, null)
          const status = fold()

          expect(status).toEqual(fold())
          if (!status) return
          const t = orderTotals(status)
          expect(t.balance).toBeGreaterThanOrEqual(0)
          expect(t.gross - t.voided - t.discount).toBe(t.net)
          for (const item of Object.values(status.items)) {
            expect(item.voidedQuantity).toBeLessThanOrEqual(item.quantity)
          }
        },
      ),
      { numRuns: 2000 },
    )
  })
})
