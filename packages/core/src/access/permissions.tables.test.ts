import { describe, expect, it } from 'vitest'
import type { NewEvent } from '../events/order'
import { newId } from '../id'
import type { OrderState } from '../order/state'
import { event, itemCopy } from '../testing/factory'
import { DEFAULT_ROLES, type Permission, permissionFor } from './permissions'

// The permission of each task 1.5 event (move, merge, void, cancel, change what was sent).

const order = newId()
const asNew = (e: unknown) => e as NewEvent
const REASON = { reason: 'Error del mesero' }

describe('permission of table events', () => {
  it.each([
    ['TablesMerged', event(order, 'TablesMerged', { table_ids: [newId()] })],
    ['TablesSeparated', event(order, 'TablesSeparated', { table_ids: [newId()] })],
    ['OrderMovedTable', event(order, 'OrderMovedTable', { target_table_id: newId() })],
  ])('%s requires take_order: any waiter can do it, without a supervisor', (_n, e) => {
    expect(permissionFor(asNew(e))).toBe('take_order')
    for (const role of Object.values(DEFAULT_ROLES).filter((r) => r.name !== 'Reportes'))
      expect(role.permissions).toContain('take_order')
  })

  it('ItemsMoved requires take_order', () => {
    const target = newId()
    const item = itemCopy()
    const e = event(
      order,
      'ItemsMoved',
      {
        target_order_id: target,
        items: [{ item, status: 'sent', voided_quantity: 0, added_by: newId() }],
      },
      { related: [target] },
    )
    expect(permissionFor(asNew(e))).toBe('take_order')
  })
})

describe('permission to void and cancel', () => {
  const voidItem = event(
    order,
    'ItemVoided',
    { item_id: newId(), quantity: 1, already_prepared: false, ticket_id: null },
    REASON,
  )
  const cancel = event(order, 'OrderCanceled', {}, REASON)

  it('voiding what was sent requires void_sent_item and canceling the order, cancel_order', () => {
    expect(permissionFor(asNew(voidItem))).toBe('void_sent_item')
    expect(permissionFor(asNew(cancel))).toBe('cancel_order')
  })

  it('they do not depend on the order state', () => {
    const something = { items: {} } as unknown as OrderState
    expect(permissionFor(asNew(voidItem), something)).toBe('void_sent_item')
    expect(permissionFor(asNew(cancel), something)).toBe('cancel_order')
  })

  const has = (role: keyof typeof DEFAULT_ROLES, permission: Permission) =>
    (DEFAULT_ROLES[role].permissions as readonly Permission[]).includes(permission)

  it('the waiter can do neither; the cashier voids but does not cancel; the admin both', () => {
    expect(has('waiter', 'void_sent_item')).toBe(false)
    expect(has('waiter', 'cancel_order')).toBe(false)
    expect(has('cashier', 'void_sent_item')).toBe(true)
    expect(has('cashier', 'cancel_order')).toBe(false)
    expect(has('admin', 'void_sent_item')).toBe(true)
    expect(has('admin', 'cancel_order')).toBe(true)
    expect(has('reports', 'void_sent_item')).toBe(false)
    expect(has('reports', 'cancel_order')).toBe(false)
  })
})

describe('permission to change what was already sent', () => {
  const item = newId()
  const orderWith = (extras: number[]) =>
    ({
      items: {
        [item]: {
          modifiers: extras.map((extraPrice) => ({
            modifierId: newId(),
            name: 'Extra',
            extraPrice,
          })),
        },
      },
    }) as unknown as OrderState
  const change = (data: { notes?: string | null; modifiers?: { extra_price: number }[] }) =>
    asNew(
      event(order, 'ItemModifiedAfterSend', {
        item_id: item,
        ticket_id: newId(),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(data.modifiers
          ? {
              modifiers: data.modifiers.map((m) => ({
                modifier_id: newId(),
                name: 'Extra',
                extra_price: m.extra_price,
              })),
            }
          : {}),
      }),
    )

  it('changing only the note requires take_order, also on a dish with extras', () => {
    expect(permissionFor(change({ notes: 'sin hielo' }), orderWith([3000]))).toBe('take_order')
    expect(permissionFor(change({ notes: null }), orderWith([3000]))).toBe('take_order')
    expect(permissionFor(change({ notes: 'sin hielo' }), null)).toBe('take_order')
  })

  it('removing the charge for an extra is a partial void; the same price or higher is not', () => {
    const p = orderWith([3000])
    expect(permissionFor(change({ modifiers: [] }), p)).toBe('void_sent_item')
    expect(permissionFor(change({ modifiers: [{ extra_price: 1000 }] }), p)).toBe('void_sent_item')
    expect(permissionFor(change({ modifiers: [{ extra_price: 3000 }] }), p)).toBe('take_order')
    expect(
      permissionFor(change({ modifiers: [{ extra_price: 3000 }, { extra_price: 0 }] }), p),
    ).toBe('take_order')
    expect(permissionFor(change({ modifiers: [{ extra_price: 4000 }] }), p)).toBe('take_order')
  })

  it('note and modifiers together: the modifier that lowers the price wins', () => {
    expect(permissionFor(change({ notes: 'x', modifiers: [] }), orderWith([2000]))).toBe(
      'void_sent_item',
    )
  })

  it('with no previous extras, changing free modifiers requires no special permission', () => {
    expect(permissionFor(change({ modifiers: [{ extra_price: 0 }] }), orderWith([]))).toBe(
      'take_order',
    )
    expect(permissionFor(change({ modifiers: [] }), orderWith([]))).toBe('take_order')
  })

  it('an item unknown to the state needs no special permission (the reducer rejects it)', () => {
    const other = { items: {} } as unknown as OrderState
    expect(permissionFor(change({ modifiers: [] }), other)).toBe('take_order')
  })
})
