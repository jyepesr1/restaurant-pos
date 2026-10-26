import { describe, expect, it } from 'vitest'
import { permissionFor } from '../access/permissions'
import { newId } from '../id'
import { applyEvent, rebuild } from '../order/apply'
import { aggregateOf, type NewEvent, validateNewEvent } from './order'

// Sold out (86): product events, not order events. They travel in the same sequence as orders.

const product = newId()
const envelope = (type: string, data: unknown, fields: Record<string, unknown> = {}) => ({
  id: newId(),
  type,
  schema_version: 1,
  aggregate_type: 'product',
  aggregate_id: product,
  related: [],
  data,
  session_id: null,
  user_id: newId(),
  device_id: newId(),
  authorization_id: null,
  reason: null,
  device_time: '2026-10-24T20:00:00.000Z',
  hub_estimated_time: '2026-10-24T20:00:00.000Z',
  base_sequence: 0,
  ...fields,
})

describe('product events (sold out)', () => {
  it('they are validated with their aggregate: the product', () => {
    for (const type of ['ProductSoldOut', 'ProductAvailable'])
      expect(validateNewEvent(envelope(type, { product_id: product, variant_id: null })).ok).toBe(
        true,
      )
    expect(
      validateNewEvent(envelope('ProductSoldOut', { product_id: product, variant_id: newId() })).ok,
    ).toBe(true)
  })

  it('rejects a sold-out event that claims to belong to an order, or to another product', () => {
    const r1 = validateNewEvent(
      envelope(
        'ProductSoldOut',
        { product_id: product, variant_id: null },
        { aggregate_type: 'order' },
      ),
    )
    expect(r1.ok).toBe(false)
    const r2 = validateNewEvent(
      envelope('ProductSoldOut', { product_id: newId(), variant_id: null }),
    )
    expect(r2.ok).toBe(false)
  })

  it('an order event cannot claim to belong to a product', () => {
    const r = validateNewEvent(
      envelope(
        'OrderOpened',
        { channel: 'dine_in', table_id: null, guests: 2 },
        { aggregate_type: 'product' },
      ),
    )
    expect(r.ok).toBe(false)
  })

  it('requires the mark_product_sold_out permission and touches no order', () => {
    const e = envelope('ProductSoldOut', { product_id: product, variant_id: null }) as NewEvent
    expect(permissionFor(e)).toBe('mark_product_sold_out')
    expect(aggregateOf('ProductAvailable')).toBe('product')
    expect(aggregateOf('ItemAdded')).toBe('order')
    expect(applyEvent(null, e).issue?.type).toBe('not_in_order')
    expect(rebuild([e], product)).toBeNull()
  })
})
