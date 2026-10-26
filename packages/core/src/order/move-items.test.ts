import { describe, expect, it } from 'vitest'
import { validateNewEvent } from '../events/order'
import { newId } from '../id'
import { event, itemCopy, TIME, WAITER } from '../testing/factory'
import { applyAll, issueOf, sendItems } from '../testing/helpers'
import { applyEvent } from './apply'
import type { OrderState } from './state'
import { orderTotals } from './totals'

// Moving products to another table (task 1.5): `ItemsMoved`, with the target order in
// `related`. The copy that travels must be exactly the source item.

type Copy = ReturnType<typeof itemCopy>
type Moved = { item: Copy; status: 'sent'; voided_quantity: number; added_by: string }

const moved = (item: Copy, extras: Partial<Moved> = {}): Moved => ({
  item,
  status: 'sent',
  voided_quantity: 0,
  added_by: WAITER,
  ...extras,
})

/** Source with one sent item and a freshly opened target. */
function twoOrders(fields: Partial<Copy> = {}) {
  const source = newId()
  const target = newId()
  const item = itemCopy(fields)
  const sourceState = applyAll([
    event(source, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
    event(source, 'ItemAdded', item),
    sendItems(source, [item.item_id]),
  ])
  const targetState = applyAll([
    event(target, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 1 }),
  ])
  const move = (items: Moved[], extras = {}) =>
    event(source, 'ItemsMoved', { target_order_id: target, items }, extras)
  return { source, target, item, sourceState, targetState, move }
}

const appliesToBoth = (m: ReturnType<typeof twoOrders>, e: ReturnType<typeof m.move>) => ({
  source: applyEvent(m.sourceState, e),
  target: applyEvent(m.targetState, e),
})

describe('ItemsMoved: what reaches the target', () => {
  it('the item moves from source to target with its id, its status and who added it', () => {
    const m = twoOrders()
    const r = appliesToBoth(m, m.move([moved(m.item)]))
    expect(r.source.issue).toBeNull()
    expect(r.target.issue).toBeNull()
    expect(r.source.status?.items).toEqual({})
    const arrived = r.target.status?.items[m.item.item_id]
    expect(arrived).toMatchObject({
      id: m.item.item_id,
      status: 'sent',
      addedBy: WAITER,
      quantity: 1,
      unitPrice: m.item.unit_price,
    })
  })

  it('with modifiers, note, guest and course: the copy arrives the same', () => {
    const mod = { modifier_id: newId(), name: 'Extra limón', extra_price: 2000 }
    const m = twoOrders({
      modifiers: [mod],
      notes: 'sin hielo',
      guest: 3,
      course: 'main',
    })
    const r = appliesToBoth(m, m.move([moved(m.item)]))
    expect(r.target.issue).toBeNull()
    expect(r.target.status?.items[m.item.item_id]).toMatchObject({
      notes: 'sin hielo',
      guest: 3,
      course: 'main',
      modifiers: [{ modifierId: mod.modifier_id, extraPrice: 2000 }],
    })
  })

  it('a partial void travels: what was voided stays voided and the net is kept', () => {
    const m = twoOrders({ quantity: 3 })
    const voided = applyAll(
      [
        event(
          m.source,
          'ItemVoided',
          { item_id: m.item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
          { reason: 'Error del mesero' },
        ),
      ],
      m.sourceState,
    )
    const e = m.move([moved(m.item, { voided_quantity: 1 })])
    const source = applyEvent(voided, e)
    const target = applyEvent(m.targetState, e)
    expect(source.issue).toBeNull()
    expect(target.issue).toBeNull()
    expect(target.status?.items[m.item.item_id]).toMatchObject({ quantity: 3, voidedQuantity: 1 })
    expect(orderTotals(target.status as OrderState).net).toBe(orderTotals(voided).net)
    expect(orderTotals(source.status as OrderState).net).toBe(0)
  })

  it('if the copy says nothing was voided but something was, it is mismatched_copy', () => {
    const m = twoOrders({ quantity: 3 })
    const voided = applyAll(
      [
        event(
          m.source,
          'ItemVoided',
          { item_id: m.item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
          { reason: 'x' },
        ),
      ],
      m.sourceState,
    )
    expect(issueOf(voided, m.move([moved(m.item, { voided_quantity: 0 })]))).toBe('mismatched_copy')
  })

  it('the target keeps its own and adds what was moved', () => {
    const m = twoOrders()
    const own = itemCopy({ name: 'Aperol' })
    const targetWithItem = applyAll([event(m.target, 'ItemAdded', own)], m.targetState)
    const r = applyEvent(targetWithItem, m.move([moved(m.item)]))
    expect(r.issue).toBeNull()
    expect(Object.keys(r.status?.items ?? {}).sort()).toEqual([own.item_id, m.item.item_id].sort())
    // The incoming one is placed after the target's own.
    const position = (id: string) => r.status?.items[id]?.position ?? 0
    expect(position(m.item.item_id)).toBeGreaterThan(position(own.item_id))
  })

  it('moving an already served line leaves it served at the target', () => {
    const m = twoOrders()
    const served = applyAll(
      [event(m.source, 'ItemServed', { item_ids: [m.item.item_id] })],
      m.sourceState,
    )
    const e = m.move([{ ...moved(m.item), status: 'sent' }])
    // The copy says «sent» but the item is served: it does not match.
    expect(issueOf(served, e)).toBe('mismatched_copy')
    const fine = event(m.source, 'ItemsMoved', {
      target_order_id: m.target,
      items: [{ ...moved(m.item), status: 'served' as never }],
    })
    expect(applyEvent(served, fine).issue).toBeNull()
    expect(applyEvent(m.targetState, fine).status?.items[m.item.item_id]?.status).toBe('served')
  })

  it('moving several at once moves all of them or none', () => {
    const m = twoOrders()
    const other = itemCopy()
    const two = applyAll(
      [event(m.source, 'ItemAdded', other), sendItems(m.source, [other.item_id])],
      m.sourceState,
    )
    const fine = m.move([moved(m.item), moved(other)])
    const r = applyEvent(two, fine)
    expect(r.issue).toBeNull()
    expect(r.status?.items).toEqual({})
    // If one does not match, none is moved.
    const wrong = m.move([moved(m.item), moved({ ...other, unit_price: 1 })])
    const rm = applyEvent(two, wrong)
    expect(rm.issue?.type).toBe('mismatched_copy')
    expect(rm.status).toBe(two)
  })

  it('moving something only changes the distribution: the sum of the two orders is kept', () => {
    const m = twoOrders({ quantity: 2, unit_price: 12_900 })
    const before = orderTotals(m.sourceState).net + orderTotals(m.targetState).net
    const r = appliesToBoth(m, m.move([moved(m.item)]))
    const after =
      orderTotals(r.source.status as OrderState).net +
      orderTotals(r.target.status as OrderState).net
    expect(after).toBe(before)
  })
})

describe('ItemsMoved: what is rejected', () => {
  it.each([
    ['another product', { product_id: newId() }],
    ['another price', { unit_price: 1 }],
    ['another rate', { rate: 1900 }],
    ['another tax', { tax_type: 'iva' as const }],
    ['another quantity', { quantity: 5 }],
    ['other modifiers', { modifiers: [{ modifier_id: newId(), name: 'x', extra_price: 0 }] }],
  ])('a copy with %s does not match the source item', (_n, change) => {
    const m = twoOrders()
    const e = m.move([moved({ ...m.item, ...change })])
    expect(issueOf(m.sourceState, e)).toBe('mismatched_copy')
  })

  it('with another added_by it does not match either', () => {
    const m = twoOrders()
    expect(issueOf(m.sourceState, m.move([moved(m.item, { added_by: newId() })]))).toBe(
      'mismatched_copy',
    )
  })

  it('an item the source does not have is item_not_found', () => {
    const m = twoOrders()
    expect(issueOf(m.sourceState, m.move([moved(itemCopy())]))).toBe('item_not_found')
  })

  it('a fully voided item is not moved', () => {
    const m = twoOrders()
    const voided = applyAll(
      [
        event(
          m.source,
          'ItemVoided',
          { item_id: m.item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
          { reason: 'x' },
        ),
      ],
      m.sourceState,
    )
    expect(issueOf(voided, m.move([moved(m.item)]))).toBe('item_not_found')
  })

  it('an item with a discount is not moved until it is removed', () => {
    const m = twoOrders()
    const withDiscount = applyAll(
      [
        event(
          m.source,
          'DiscountApplied',
          {
            discount_id: newId(),
            scope: 'item',
            rule: 'value',
            value: 1000,
            unit_count: null,
            amounts: [{ item_id: m.item.item_id, amount: 1000 }],
          },
          { reason: 'm' },
        ),
      ],
      m.sourceState,
    )
    expect(issueOf(withDiscount, m.move([moved(m.item)]))).toBe('has_discounts')
  })

  it('the same item twice at the target is item_already_exists', () => {
    const m = twoOrders()
    const already = applyAll([event(m.target, 'ItemAdded', { ...m.item })], m.targetState)
    expect(issueOf(already, m.move([moved(m.item)]))).toBe('item_already_exists')
  })

  it.each(['closed', 'canceled'] as const)('a %s target receives nothing', (final) => {
    const m = twoOrders()
    const closed = applyAll(
      [event(m.target, final === 'closed' ? 'OrderClosed' : 'OrderCanceled', {}, { reason: 'x' })],
      m.targetState,
    )
    expect(issueOf(closed, m.move([moved(m.item)]))).toBe('order_closed')
  })

  it('an order that is neither source nor target ignores the event', () => {
    const m = twoOrders()
    const thirdOne = applyAll([
      event(newId(), 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 }),
    ])
    expect(issueOf(thirdOne, m.move([moved(m.item)]))).toBe('foreign_event')
  })

  it('a source with a split check does not move', () => {
    const m = twoOrders()
    const divided = applyAll(
      [
        event(m.source, 'CheckSplit', {
          checks: [
            { check_id: newId(), name: 'A', amount: 20_000, suggested_tip: 0, items: [] },
            { check_id: newId(), name: 'B', amount: 20_900, suggested_tip: 0, items: [] },
          ],
        }),
      ],
      m.sourceState,
    )
    expect(issueOf(divided, m.move([moved(m.item)]))).toBe('order_split')
  })
})

describe('ItemsMoved schema', () => {
  const envelope = (data: unknown, related: string[], aggregate = newId()) => ({
    id: newId(),
    type: 'ItemsMoved',
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: aggregate,
    related,
    data,
    session_id: null,
    user_id: WAITER,
    device_id: newId(),
    authorization_id: null,
    reason: null,
    device_time: TIME,
    hub_estimated_time: TIME,
    base_sequence: 0,
  })
  const { catalog_version: _v, price_channel_id: _c, ...withoutCatalog } = itemCopy()
  const oneItem = { item: withoutCatalog, status: 'sent', voided_quantity: 0, added_by: WAITER }

  it('requires the target in related', () => {
    const target = newId()
    const data = { target_order_id: target, items: [oneItem] }
    expect(validateNewEvent(envelope(data, [target])).ok).toBe(true)
    expect(validateNewEvent(envelope(data, [])).ok).toBe(false)
    expect(validateNewEvent(envelope(data, [newId()])).ok).toBe(false)
  })

  it('cannot be from the order to itself', () => {
    const same = newId()
    expect(
      validateNewEvent(envelope({ target_order_id: same, items: [oneItem] }, [same], same)).ok,
    ).toBe(false)
  })

  it('requires at least one item and rejects duplicates', () => {
    const target = newId()
    expect(validateNewEvent(envelope({ target_order_id: target, items: [] }, [target])).ok).toBe(
      false,
    )
    expect(
      validateNewEvent(envelope({ target_order_id: target, items: [oneItem, oneItem] }, [target]))
        .ok,
    ).toBe(false)
  })
})
