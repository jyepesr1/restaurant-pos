import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { eventsOf, openOrder, setup } from './testing/setup'

// Sold out (86) in sync: the hub accepts it with its sequence, broadcasts it to everyone, and does
// not mistake it for an order (task 1.3).

describe('product events', () => {
  it('a sold-out is confirmed, reaches the others and creates no order', async () => {
    const m = setup()
    const register = m.network.device('register')
    const phone = m.network.device('phone')
    await register.connect()
    await phone.connect()
    await m.network.settle()

    const product = newId()
    await register.create(
      product,
      'ProductSoldOut',
      { product_id: product, variant_id: null },
      { aggregate_type: 'product' },
    )
    const order = await openOrder(phone)
    await m.network.settle()

    expect(eventsOf(m).map((e) => [e.type, e.sequence])).toEqual([
      ['ProductSoldOut', 1],
      ['OrderOpened', 2],
    ])
    const phoneEvent = (await phone.client.locals()).find((l) => l.event.type === 'ProductSoldOut')
    expect(phoneEvent?.status).toBe('confirmed')
    expect(m.hub().order(product)).toBeNull()
    expect(m.hub().order(order)?.status).toBe('open')
    expect(await phone.client.order(product)).toBeNull()
  })

  it('after restarting the hub, sold-outs do not get in the way of rebuilding orders', async () => {
    const m = setup()
    const register = m.network.device('register')
    await register.connect()
    const product = newId()
    await register.create(
      product,
      'ProductSoldOut',
      { product_id: product, variant_id: null },
      { aggregate_type: 'product' },
    )
    const order = await openOrder(register)
    await m.network.settle()
    const floor = m.createFloor()
    expect(floor).toBeDefined()
    expect(m.hub().order(order)?.status).toBe('open')
    expect(m.hub().hasOpenOrder('x')).toBe(false)
  })
})
