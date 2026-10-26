import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROLES,
  isPermission,
  ONLY_FROM_REGISTER,
  permissionFor,
} from '../access/permissions'
import { authorizableFingerprint, signEvent } from '../access/signature'
import { canonicalJson } from '../canonical'
import { newId } from '../id'
import { applyEvent, rebuild } from '../order/apply'
import { event as factory } from '../testing/factory'
import { actionArb, Service } from '../testing/simulator'
import {
  aggregateOf,
  type NewEvent,
  ORDER_EVENT_TYPES,
  PRODUCT_EVENT_TYPES,
  SHIFT_EVENT_TYPES,
  validateNewEvent,
} from './order'

// Edge cases of product events (sold out, task 1.3): variant, aggregate, signature, fingerprint,
// permissions, and that they never mix with an order.

const TIME = '2026-10-24T20:00:00.000Z'
const TYPES = ['ProductSoldOut', 'ProductAvailable'] as const

const envelope = (
  type: string,
  productId: string,
  data: unknown,
  fields: Record<string, unknown> = {},
) => ({
  id: newId(),
  type,
  schema_version: 1,
  aggregate_type: 'product',
  aggregate_id: productId,
  related: [],
  data,
  session_id: null,
  user_id: newId(),
  device_id: newId(),
  authorization_id: null,
  reason: null,
  device_time: TIME,
  hub_estimated_time: TIME,
  base_sequence: 0,
  ...fields,
})

const errors = (entry: unknown) => {
  const r = validateNewEvent(entry)
  return r.ok ? [] : r.errors
}

const markSoldOut = (variant: string | null = null, fields: Record<string, unknown> = {}) => {
  const product = newId()
  return envelope('ProductSoldOut', product, { product_id: product, variant_id: variant }, fields)
}

describe('ProductSoldOut and ProductAvailable: data', () => {
  it.each(TYPES)('%s with or without a variant is valid', (type) => {
    const product = newId()
    expect(errors(envelope(type, product, { product_id: product, variant_id: newId() }))).toEqual(
      [],
    )
    expect(errors(envelope(type, product, { product_id: product, variant_id: null }))).toEqual([])
  })

  it.each(TYPES)('%s rejects malformed data', (type) => {
    const product = newId()
    const withIt = (data: unknown) => errors(envelope(type, product, data))
    expect(withIt({ product_id: product })).not.toEqual([]) // missing variant_id
    expect(withIt({ variant_id: null })).not.toEqual([]) // missing product_id
    expect(withIt({ product_id: product, variant_id: 'botella' })).not.toEqual([])
    expect(withIt({ product_id: product, variant_id: '' })).not.toEqual([])
    expect(withIt({ product_id: product, variant_id: undefined })).not.toEqual([])
    expect(withIt({ product_id: product, variant_id: newId().toLowerCase() })).not.toEqual([])
    expect(withIt({ product_id: 'x', variant_id: null })).not.toEqual([])
    expect(withIt({ product_id: product, variant_id: null, quantity: 1 })).not.toEqual([])
    expect(withIt(null)).not.toEqual([])
    expect(withIt([])).not.toEqual([])
    expect(withIt({})).not.toEqual([])
  })

  it('the aggregate must be the product, with or without a variant, and a valid ULID', () => {
    const product = newId()
    const variant = newId()
    // The aggregate is the variant: not allowed (it is the product).
    expect(
      errors(envelope('ProductSoldOut', variant, { product_id: product, variant_id: variant })),
    ).toContainEqual(expect.stringContaining('aggregate_id'))
    expect(
      errors(
        envelope('ProductSoldOut', 'no-es-ulid', { product_id: 'no-es-ulid', variant_id: null }),
      ),
    ).not.toEqual([])
  })

  it('aggregate_type is one of the two values and only that one', () => {
    expect(errors(markSoldOut(null, { aggregate_type: 'table' }))).not.toEqual([])
    expect(errors(markSoldOut(null, { aggregate_type: 'Product' }))).not.toEqual([])
    expect(errors(markSoldOut(null, { aggregate_type: undefined }))).not.toEqual([])
    expect(errors(markSoldOut(null, { aggregate_type: 'order' }))).toContainEqual(
      'aggregate_type: ProductSoldOut es de un product',
    )
  })

  it('does not require a reason, but allows one', () => {
    expect(errors(markSoldOut(null, { reason: null }))).toEqual([])
    expect(errors(markSoldOut(null, { reason: 'Se acabó la botella' }))).toEqual([])
  })

  it('is consistent with the type catalog', () => {
    expect([...PRODUCT_EVENT_TYPES].sort()).toEqual([...TYPES].sort())
    for (const type of PRODUCT_EVENT_TYPES) expect(ORDER_EVENT_TYPES).toContain(type)
    for (const type of ORDER_EVENT_TYPES)
      expect(aggregateOf(type)).toBe(
        PRODUCT_EVENT_TYPES.includes(type)
          ? 'product'
          : SHIFT_EVENT_TYPES.includes(type)
            ? 'register_shift'
            : 'order',
      )
  })

  // Found by qa-pruebas in 1.3 and already fixed: a product event could name an order in
  // `related` and the hub stored it as an event of that order.
  it('a sold-out event cannot name an order in related', () => {
    expect(errors(markSoldOut(null, { related: [newId()] }))).not.toEqual([])
  })
})

describe('no order event accepts aggregate_type product', () => {
  it('every order type the simulator exercises fails when it claims to be a product', () => {
    const seenSet = new Map<string, NewEvent>()
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 20, maxLength: 80, size: 'max' }), (actions) => {
        const service = new Service()
        for (const a of actions) service.step(a)
        for (const e of service.log) if (!seenSet.has(e.type)) seenSet.set(e.type, e)
      }),
      { seed: 20_261_024, numRuns: 300 },
    )

    const orderTypes = ORDER_EVENT_TYPES.filter((t) => aggregateOf(t) === 'order')
    // The rescue order is created by the hub and the simulator does not exercise it: built by hand.
    const rescue = factory(newId(), 'RescueOrderCreated', {
      original_order_id: newId(),
      channel: 'dine_in',
      table_id: null,
      waiter_id: newId(),
    })
    seenSet.set('RescueOrderCreated', rescue as unknown as NewEvent)
    expect(orderTypes.filter((t) => !seenSet.has(t))).toEqual([])

    for (const type of orderTypes) {
      const e = seenSet.get(type) as NewEvent
      // As the device creates it (without hub fields), as is and with the aggregate changed.
      const {
        sequence: _s,
        received_at: _r,
        business_day: _d,
        assignments: _a,
        affects: _f,
        authorized_by_id: _p,
        ...fresh
      } = e as unknown as Record<string, unknown>
      expect(errors(fresh), `${type} original`).toEqual([])
      expect(errors({ ...fresh, aggregate_type: 'product' }), `${type} as product`).toContainEqual(
        `aggregate_type: ${type} es de un order`,
      )
    }
  })

  it('neither does a product event with an order type and product data', () => {
    const product = newId()
    const data = { product_id: product, variant_id: null }
    for (const type of ['ItemAdded', 'OrderOpened', 'OrderClosed', 'ItemRemoved'])
      expect(errors(envelope(type, product, data))).not.toEqual([])
  })
})

describe('signature and fingerprint of a product event', () => {
  const base = () => {
    const product = newId()
    return envelope('ProductSoldOut', product, {
      product_id: product,
      variant_id: null,
    }) as unknown as NewEvent
  }

  it('the signature is a stable hex HMAC-SHA256, unchanged by base_sequence or another signature', () => {
    const e = base()
    const f = signEvent(e, 'secret')
    expect(f).toMatch(/^[0-9a-f]{64}$/)
    expect(signEvent({ ...e }, 'secret')).toBe(f)
    expect(signEvent({ ...e, base_sequence: 77 }, 'secret')).toBe(f)
    expect(signEvent({ ...e, signature: 'a'.repeat(64) }, 'secret')).toBe(f)
  })

  it('the signature changes with the secret, type, product, variant or aggregate_type', () => {
    const e = base()
    const f = signEvent(e, 'secret')
    const data = e.data as { product_id: string; variant_id: string | null }
    const differentOnes = [
      signEvent(e, 'other'),
      signEvent({ ...e, type: 'ProductAvailable' } as NewEvent, 'secret'),
      signEvent({ ...e, data: { ...data, variant_id: newId() } } as NewEvent, 'secret'),
      signEvent({ ...e, data: { ...data, product_id: newId() } } as NewEvent, 'secret'),
      signEvent({ ...e, aggregate_type: 'order' } as NewEvent, 'secret'),
      signEvent({ ...e, device_time: '2026-10-24T20:00:00.001Z' }, 'secret'),
    ]
    for (const another of differentOnes) expect(another).not.toBe(f)
    expect(new Set([f, ...differentOnes]).size).toBe(differentOnes.length + 1)
  })

  it('with a null or missing variant in canonical JSON the signature equals the one without the key', () => {
    // undefined is omitted from canonical JSON: variant_id undefined == missing key; null differs.
    const e = base()
    const data = e.data as { product_id: string }
    const withNull = signEvent({ ...e, data: { ...data, variant_id: null } } as NewEvent, 's')
    const withoutKey = signEvent(
      { ...e, data: { product_id: data.product_id } } as unknown as NewEvent,
      's',
    )
    expect(withNull).not.toBe(withoutKey)
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
  })

  it('the approval fingerprint ignores authorization_id, signature and base_sequence but not content', () => {
    const e = base()
    const h = authorizableFingerprint(e)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(authorizableFingerprint({ ...e, authorization_id: newId() })).toBe(h)
    expect(authorizableFingerprint({ ...e, base_sequence: 9, signature: 'f'.repeat(64) })).toBe(h)
    const data = e.data as { product_id: string }
    expect(
      authorizableFingerprint({ ...e, data: { ...data, variant_id: newId() } } as NewEvent),
    ).not.toBe(h)
    expect(authorizableFingerprint({ ...e, type: 'ProductAvailable' } as NewEvent)).not.toBe(h)
  })

  it('for any product and variant, signing is deterministic and tells sold out from available', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 20 }),
        (withVariant, secret) => {
          const product = newId()
          const data = { product_id: product, variant_id: withVariant ? newId() : null }
          const a = envelope('ProductSoldOut', product, data) as unknown as NewEvent
          const d = { ...a, type: 'ProductAvailable' } as NewEvent
          expect(signEvent(a, secret)).toBe(signEvent({ ...a }, secret))
          expect(signEvent(a, secret)).not.toBe(signEvent(d, secret))
          expect(authorizableFingerprint(a)).not.toBe(authorizableFingerprint(d))
        },
      ),
      { seed: 7, numRuns: 100 },
    )
  })
})

describe('permissionFor with product events', () => {
  it.each(TYPES)('%s requires mark_product_sold_out, with or without an order at hand', (type) => {
    const product = newId()
    const e = envelope(type, product, {
      product_id: product,
      variant_id: newId(),
    }) as unknown as NewEvent
    expect(permissionFor(e)).toBe('mark_product_sold_out')
    expect(permissionFor(e, null)).toBe('mark_product_sold_out')
    const order = rebuild(
      [factory(newId(), 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 })],
      '',
    )
    expect(order).toBeNull()
    expect(isPermission(permissionFor(e))).toBe(true)
  })

  it('is not register-only; by default cashier and admin have it, not waiter or reports', () => {
    for (const type of TYPES) expect(ONLY_FROM_REGISTER.has(type)).toBe(false)
    const has = (role: keyof typeof DEFAULT_ROLES) =>
      (DEFAULT_ROLES[role].permissions as readonly string[]).includes('mark_product_sold_out')
    expect(has('cashier')).toBe(true)
    expect(has('admin')).toBe(true)
    expect(has('waiter')).toBe(false)
    expect(has('reports')).toBe(false)
  })
})

describe('a product event touches no order', () => {
  it('with an order in progress it returns the same state and the not_in_order issue', () => {
    const orderId = newId()
    const opened = factory(orderId, 'OrderOpened', {
      channel: 'dine_in',
      table_id: null,
      guests: 2,
    })
    const status = applyEvent(null, opened).status
    const product = newId()
    const soldOut = factory(
      product,
      'ProductSoldOut',
      { product_id: product, variant_id: null },
      { aggregate_type: 'product' },
    )
    // Foreign to the order: it does not even look at it.
    expect(applyEvent(status, soldOut).issue?.type).toBe('foreign_event')
    expect(applyEvent(status, soldOut).status).toBe(status)
    // Even if it claims the same aggregate (id repeated by mistake): not_in_order and no changes.
    const sameId = { ...soldOut, aggregate_id: orderId, sequence: 9_999_999 }
    const r = applyEvent(status, sameId)
    expect(r.issue?.type).toBe('not_in_order')
    expect(r.status).toBe(status)
    expect(status?.lastSequence).not.toBe(9_999_999)
  })

  it('rebuilding an order mixed with product events gives the same as without them', () => {
    const orderId = newId()
    const product = newId()
    const events = [
      factory(orderId, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 }),
      factory(
        product,
        'ProductSoldOut',
        { product_id: product, variant_id: null },
        { aggregate_type: 'product' },
      ),
      factory(
        product,
        'ProductAvailable',
        { product_id: product, variant_id: null },
        { aggregate_type: 'product' },
      ),
    ]
    const only = rebuild(events.slice(0, 1), orderId)
    expect(rebuild(events, orderId)).toEqual(only)
    expect(rebuild(events, product)).toBeNull()
  })

  it('a sold-out event with the product related to an order does not change the order', () => {
    const orderId = newId()
    const product = newId()
    const opened = factory(orderId, 'OrderOpened', {
      channel: 'dine_in',
      table_id: null,
      guests: 2,
    })
    // The schema no longer lets it through; even so, the reducer must not apply it to the order.
    const odd = {
      ...factory(
        product,
        'ProductSoldOut',
        { product_id: product, variant_id: null },
        { aggregate_type: 'product' },
      ),
      related: [orderId],
    }
    const before = rebuild([opened], orderId)
    expect(rebuild([opened, odd], orderId)).toEqual(before)
  })
})
