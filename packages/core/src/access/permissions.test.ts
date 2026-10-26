import { describe, expect, it } from 'vitest'
import { ORDER_EVENT_TYPES } from '../events/order'
import { event } from '../testing/factory'
import {
  DEFAULT_ROLES,
  isPermission,
  ONLY_FROM_REGISTER,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
  permissionFor,
} from './permissions'

describe('permissions', () => {
  it('recognizes only the fixed keys', () => {
    expect(isPermission('take_order')).toBe(true)
    expect(isPermission('delete_all')).toBe(false)
    expect(isPermission(3)).toBe(false)
  })

  it('the default roles follow the matrix in MODELO_DATOS.md (ADR-013)', () => {
    const has = (role: keyof typeof DEFAULT_ROLES, permission: string) =>
      (DEFAULT_ROLES[role].permissions as readonly string[]).includes(permission)

    expect(has('admin', 'manage_devices')).toBe(true)
    expect(has('admin', 'manage_users')).toBe(true)
    expect(has('cashier', 'manage_users')).toBe(false)
    expect(has('cashier', 'void_sent_item')).toBe(true)
    expect(has('waiter', 'void_sent_item')).toBe(false)
    expect(has('waiter', 'record_payment')).toBe(false)
    expect(has('cashier', 'close_table')).toBe(true)
    expect(has('cashier', 'void_payment')).toBe(false)
    expect(DEFAULT_ROLES.reports.permissions).toEqual(['view_reports'])
    for (const role of Object.values(DEFAULT_ROLES))
      for (const permission of role.permissions) expect(PERMISSIONS).toContain(permission)
  })

  it('the roles screen describes each permission exactly once', () => {
    const described = PERMISSION_DESCRIPTIONS.flatMap((g) => g.permissions.map((p) => p.permission))
    expect([...described].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('each event type has its permission; a comp requires its own', () => {
    const order = event('01JB0000000000000000000000', 'OrderOpened', {
      channel: 'dine_in',
      table_id: null,
      guests: 2,
    })
    expect(permissionFor(order)).toBe('take_order')
    const voided = { ...order, type: 'ItemVoided' } as unknown as Parameters<
      typeof permissionFor
    >[0]
    expect(permissionFor(voided)).toBe('void_sent_item')

    const discount = (rule: string) =>
      ({ ...order, type: 'DiscountApplied', data: { rule } }) as unknown as Parameters<
        typeof permissionFor
      >[0]
    expect(permissionFor(discount('comp'))).toBe('comp')
    expect(permissionFor(discount('percent'))).toBe('apply_discount')

    const rescue = { ...order, type: 'RescueOrderCreated' } as unknown as Parameters<
      typeof permissionFor
    >[0]
    expect(permissionFor(rescue)).toBeNull()
    for (const type of ORDER_EVENT_TYPES) {
      const p = permissionFor({ ...order, type } as unknown as Parameters<typeof permissionFor>[0])
      expect(p === null || isPermission(p)).toBe(true)
    }
  })

  it('payments and closes only from the register', () => {
    expect([...ONLY_FROM_REGISTER].sort()).toEqual(
      [
        'PaymentVoided',
        'PaymentRecorded',
        'OrderClosed',
        'RefundRecorded',
        'ShiftOpened',
        'CashMovementRecorded',
        'CashCountRecorded',
        'ShiftClosed',
      ].sort(),
    )
  })

  it('lowering the modifier price of a sent item requires a void; raising it does not', () => {
    const itemId = '01JB0000000000000000000009'
    const change = (prices: number[]) =>
      ({
        ...event('01JB0000000000000000000000', 'OrderOpened', {
          channel: 'dine_in',
          table_id: null,
          guests: 2,
        }),
        type: 'ItemModifiedAfterSend',
        data: {
          item_id: itemId,
          ticket_id: '01JB0000000000000000000008',
          modifiers: prices.map((extra_price, i) => ({
            modifier_id: `01JB000000000000000000000${i}`,
            name: 'Extra',
            extra_price,
          })),
        },
      }) as unknown as Parameters<typeof permissionFor>[0]
    const order = {
      items: {
        [itemId]: { modifiers: [{ modifierId: 'x', name: 'Extra', extraPrice: 3000 }] },
      },
    } as unknown as Parameters<typeof permissionFor>[1]

    expect(permissionFor(change([]), order)).toBe('void_sent_item')
    expect(permissionFor(change([3000]), order)).toBe('take_order')
    expect(permissionFor(change([5000]), order)).toBe('take_order')
    expect(permissionFor(change([]), null)).toBe('take_order')
  })
})
