import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { setupHub } from './access/hub-setup'

// Sold out (86) with the real access control: whoever has `mark_product_sold_out` (cashier,
// kitchen, manager) marks it, not the waiter; and the hub stores it in the sequence without
// touching orders.

describe('sold out in the hub', () => {
  it('the waiter cannot mark sold out; the cashier can, and it is confirmed with its sequence', () => {
    const m = setupHub()
    const product = newId()
    const data = { product_id: product, variant_id: null }
    const extras = { aggregate_type: 'product' as const, aggregate_id: product }

    const phone = m.pair('waiter')
    const waiter = m.signIn(phone.connection, 'waiter')
    const r1 = m.hub.receiveBatch(phone.connection, [
      m.event(phone.connection, waiter, 'ProductSoldOut', data, extras),
    ])
    expect(r1.results).toEqual([
      expect.objectContaining({ status: 'rejected', reason: 'no_permission' }),
    ])

    const register = m.pair('register')
    const cashier = m.signIn(register.connection, 'cashier')
    const r2 = m.hub.receiveBatch(register.connection, [
      m.event(register.connection, cashier, 'ProductSoldOut', data, extras),
      m.event(register.connection, cashier, 'ProductAvailable', data, extras),
    ])
    expect(r2.results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(m.hub.order(product)).toBeNull()
  })

  it('a sold out with an order aggregate is rejected by format', () => {
    const m = setupHub()
    const product = newId()
    const register = m.pair('register')
    const cashier = m.signIn(register.connection, 'cashier')
    const r = m.hub.receiveBatch(register.connection, [
      m.event(
        register.connection,
        cashier,
        'ProductSoldOut',
        { product_id: product, variant_id: null },
        {
          aggregate_id: product,
        },
      ),
    ])
    expect(r.results[0]).toMatchObject({ status: 'rejected' })
    expect((r.results[0] as { reason: string }).reason).toMatch(/schema/)
  })
})
