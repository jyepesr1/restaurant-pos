import { newId, type OrderEvent } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { eventFingerprint } from './fingerprint'
import { FloorSync } from './hub/floor'
import { type AccessControl, HubSync, ordersOf } from './hub/hub'
import { MemoryStore } from './hub/store'
import { PAGE_SIZE } from './protocol'
import { openAccess } from './testing/access'
import type { NetNode } from './testing/network'
import {
  type CrashingStore,
  eventsOf,
  item,
  openOrder,
  type Setup,
  seeTheSame,
  setup,
} from './testing/setup'

// Sold out (86) mixed with orders in sync: batches, drops, hub crashes, restored hub, chained
// rejections and convergence between offline devices (task 1.3).

const markSoldOut = (
  node: NetNode,
  product: string,
  variant: string | null = null,
  type: 'ProductSoldOut' | 'ProductAvailable' = 'ProductSoldOut',
) =>
  node.create(
    product,
    type,
    { product_id: product, variant_id: variant },
    { aggregate_type: 'product' },
  )

const release = (node: NetNode, product: string, variant: string | null = null) =>
  markSoldOut(node, product, variant, 'ProductAvailable')

/** The test hub with its own access control, over the same store. */
function withAccess(m: Setup, access: AccessControl) {
  const hub = new HubSync(m.store, {
    restaurantId: m.restaurantId,
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    access,
    instance: m.status.instance,
    clock: m.network.isoTime,
  })
  m.status.hub = hub
  m.network.floor = new FloorSync(hub, m.network.authenticate)
}

/** What these events say is sold out, in the given order (the last one per key wins). */
function soldOutOf(events: readonly Pick<OrderEvent, 'type' | 'data' | 'sequence'>[]) {
  const result = new Set<string>()
  for (const e of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (e.type !== 'ProductSoldOut' && e.type !== 'ProductAvailable') continue
    // `Pick` loses the link between type and data.
    const d = e.data as { product_id: string; variant_id: string | null }
    const key = `${d.product_id}:${d.variant_id ?? ''}`
    if (e.type === 'ProductSoldOut') result.add(key)
    else result.delete(key)
  }
  return result
}

const confirmedOf = async (node: NetNode) =>
  (await node.client.locals())
    .filter((l) => l.status === 'confirmed')
    .map((l) => l.event as OrderEvent)

describe('ordersOf with product events', () => {
  it('a sold-out event touches only its product: it is not mistaken for any order', () => {
    const product = newId()
    const order = newId()
    const soldOut = { aggregate_id: product, related: [], affects: [] }
    expect(ordersOf(soldOut)).toEqual([product])
    expect(ordersOf(soldOut)).not.toContain(order)
    expect(ordersOf({ aggregate_id: order, related: [] })).toEqual([order])
  })
})

describe('fingerprint of a product event', () => {
  it('ignores base_sequence and signature, and tells apart type, variant and aggregate_type', () => {
    const product = newId()
    const e = {
      id: newId(),
      type: 'ProductSoldOut',
      schema_version: 1,
      aggregate_type: 'product',
      aggregate_id: product,
      related: [],
      data: { product_id: product, variant_id: null },
      session_id: null,
      user_id: newId(),
      device_id: newId(),
      authorization_id: null,
      reason: null,
      device_time: '2026-10-24T20:00:00.000Z',
      hub_estimated_time: '2026-10-24T20:00:00.000Z',
      base_sequence: 0,
    }
    const h = eventFingerprint(e)
    expect(eventFingerprint({ ...e, base_sequence: 99, signature: 'f'.repeat(64) })).toBe(h)
    expect(eventFingerprint({ ...e, type: 'ProductAvailable' })).not.toBe(h)
    expect(eventFingerprint({ ...e, aggregate_type: 'order' })).not.toBe(h)
    expect(eventFingerprint({ ...e, data: { product_id: product, variant_id: newId() } })).not.toBe(
      h,
    )
  })
})

describe('batches mixing sold-out events and orders', () => {
  it('offline: order, items and sold-out events are sent together, in order, and all are confirmed', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await luis.connect()
    const order = newId()
    const x = newId()
    const bottle = newId()
    await openOrder(ana, order)
    await ana.create(order, 'ItemAdded', item(10_000))
    await markSoldOut(ana, x)
    await ana.create(order, 'ItemAdded', item(20_000))
    await markSoldOut(ana, x, bottle)
    await release(ana, x)
    await m.network.connectAll()

    expect(eventsOf(m).map((e) => [e.sequence, e.type])).toEqual([
      [1, 'OrderOpened'],
      [2, 'ItemAdded'],
      [3, 'ProductSoldOut'],
      [4, 'ItemAdded'],
      [5, 'ProductSoldOut'],
      [6, 'ProductAvailable'],
    ])
    expect(Object.keys(m.hub().order(order)?.items ?? {})).toHaveLength(2)
    expect(m.hub().order(order)?.status).toBe('open')
    expect(m.hub().order(x)).toBeNull()
    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [order, x])
    // The product does not leak into the state of any order on the device.
    expect(await luis.client.order(x)).toBeNull()
    expect(soldOutOf(await confirmedOf(luis))).toEqual(new Set([`${x}:${bottle}`]))
  })

  it('duplicated or lost product messages on the network neither repeat nor lose the sold out', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const order = await openOrder(ana)
    const x = newId()
    ana.disconnect()
    await ana.create(order, 'ItemAdded', item())
    await markSoldOut(ana, x)
    await release(ana, x)
    await markSoldOut(ana, x)

    ana.rule('to_hub', 'push', 'duplicate')
    ana.rule('to_device', 'result', 'drop')
    luis.rule('to_device', 'new', 'duplicate', 3)
    await m.network.connectAll()
    ana.disconnect()
    await m.network.connectAll()

    expect(eventsOf(m).map((e) => e.type)).toEqual([
      'OrderOpened',
      'ItemAdded',
      'ProductSoldOut',
      'ProductAvailable',
      'ProductSoldOut',
    ])
    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [order, x])
    expect(soldOutOf(await confirmedOf(luis))).toEqual(new Set([`${x}:`]))
  })

  it('the hub crashes halfway through a mixed batch: on return there are no duplicates or gaps', async () => {
    for (const crash of [1, 2, 3, 4, 5]) {
      const m = setup()
      const ana = m.network.device('ana')
      const luis = m.network.device('luis')
      await luis.connect()
      const order = newId()
      const x = newId()
      await openOrder(ana, order)
      await markSoldOut(ana, x)
      await ana.create(order, 'ItemAdded', item())
      await release(ana, x)
      await markSoldOut(ana, newId())
      ;(m.store as CrashingStore).crashAt = crash

      await m.network.connectAll()
      await m.network.connectAll()

      const events = eventsOf(m)
      expect(events, `crash on save ${crash}`).toHaveLength(5)
      await seeTheSame(m.hub(), events, [ana, luis], [order, x])
    }
  })

  it('after restarting the hub, orders rebuild the same and sold-out events stay in the sequence', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    await m.network.connectAll()
    const order = await openOrder(ana)
    const x = newId()
    await markSoldOut(ana, x)
    await ana.create(order, 'ItemAdded', item(7_000))
    await m.network.settle()
    const before = structuredClone(m.hub().order(order))

    // The process restarts: same store, new hub, same instance.
    ana.disconnect()
    m.network.floor = m.createFloor()
    expect(m.hub().order(order)).toEqual(before)
    expect(m.hub().order(x)).toBeNull()

    await release(ana, x)
    await m.network.connectAll()
    expect(eventsOf(m).map((e) => e.sequence)).toEqual([1, 2, 3, 4])
    await seeTheSame(m.hub(), eventsOf(m), [ana], [order, x])
    // A third device that arrives later receives the product events in their place.
    const fresh = m.network.device('nuevo')
    await fresh.connect()
    await m.network.settle()
    expect(soldOutOf(await confirmedOf(fresh))).toEqual(new Set())
    expect((await confirmedOf(fresh)).map((e) => e.type)).toContain('ProductSoldOut')
  })

  it('more sold-out events than a page: the new device fetches them all and ends up the same', async () => {
    const m = setup()
    const register = m.network.device('register')
    await register.connect()
    const x = newId()
    for (let i = 0; i < PAGE_SIZE + 20; i++) {
      await (i % 2 === 0 ? markSoldOut(register, x) : release(register, x))
    }
    await m.network.settle()
    const fresh = m.network.device('nuevo')
    await fresh.connect()
    await m.network.settle()

    expect(eventsOf(m)).toHaveLength(PAGE_SIZE + 20)
    await seeTheSame(m.hub(), eventsOf(m), [register, fresh], [x])
    // 520 events: the last one (index 519) is "available".
    expect(soldOutOf(await confirmedOf(fresh))).toEqual(new Set())
  })

  it('with the device clock off, the sold out is accepted and the hub stamps its own time', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    ana.offsetMs = -3 * 3_600_000
    await ana.connect()
    await m.network.settle()
    const x = newId()
    const e = await markSoldOut(ana, x)
    await m.network.settle()

    const saved = eventsOf(m)[0] as OrderEvent
    expect(saved.id).toBe(e.id)
    expect(saved.received_at).toBe(m.network.isoTime())
    expect(Date.parse(saved.device_time)).toBeLessThan(Date.parse(saved.received_at))
  })
})

describe('a restored device with product events', () => {
  it('the hub comes back from an old backup: own sold-out events are resent and all end up equal', async () => {
    const m = setup({ store: 'memory' })
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await m.network.connectAll()
    const order = await openOrder(ana)
    const x = newId()
    const y = newId()
    await markSoldOut(register, x)
    await m.network.settle()
    const fallback = structuredClone((m.store as MemoryStore).events)

    // After the backup: another sold out, an item and the restock of the first one.
    await markSoldOut(register, y)
    await ana.create(order, 'ItemAdded', item())
    await release(register, x)
    await m.network.settle()
    expect(eventsOf(m)).toHaveLength(5)

    for (const node of m.network.nodes) node.disconnect()
    const restored = new MemoryStore()
    restored.events = fallback
    m.status.instance = 'hub-2'
    m.network.floor = m.createFloor(restored)
    await m.network.connectAll()

    const events = restored.eventsSince(0, 1000)
    expect(events).toHaveLength(5)
    expect(restored.rejections).toEqual([])
    await seeTheSame(m.hub(), events, [ana, register], [order, x, y])
    // Each device ends up with the same as the hub: x restocked, y sold out.
    const expected = soldOutOf(events)
    expect(expected).toEqual(new Set([`${y}:`]))
    for (const node of [ana, register]) expect(soldOutOf(await confirmedOf(node))).toEqual(expected)
    // And with `resendAll` none was left pending or with the old base.
    for (const node of [ana, register])
      for (const l of await node.client.locals())
        expect(l.event.base_sequence).toBeLessThanOrEqual(5)
  })

  it('an empty (reinstalled) hub: sold-out events from the devices are recorded again without loss', async () => {
    const m = setup({ store: 'memory' })
    const register = m.network.device('register')
    await m.network.connectAll()
    const x = newId()
    const bottle = newId()
    await markSoldOut(register, x, bottle)
    await markSoldOut(register, x)
    await m.network.settle()

    register.disconnect()
    m.status.instance = 'hub-3'
    m.network.floor = m.createFloor(new MemoryStore())
    await m.network.connectAll()

    expect(eventsOf(m).map((e) => e.type)).toEqual(['ProductSoldOut', 'ProductSoldOut'])
    await seeTheSame(m.hub(), eventsOf(m), [register], [x])
  })
})

describe('chained rejections: product and order do not drag each other', () => {
  const withoutMarkSoldOutPermission = (product: string): AccessControl => ({
    verify: (_c, event) =>
      event.type === 'ProductSoldOut' && event.aggregate_id === product
        ? { ok: false, reason: 'no_permission' }
        : { ok: true, authorizedById: null, authorizationId: null },
    recordUse: () => {},
  })

  it('a rejected sold out drags the pending events of the same product, not those of an order or another product', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const x = newId()
    const y = newId()
    const order = newId()
    withAccess(m, withoutMarkSoldOutPermission(x))

    await openOrder(ana, order)
    const a1 = await ana.create(order, 'ItemAdded', item())
    const rejected = await markSoldOut(ana, x)
    const a2 = await ana.create(order, 'ItemAdded', item())
    const sameProduct = await release(ana, x)
    const otherProduct = await markSoldOut(ana, y)
    await m.network.connectAll()

    const status = async (id: string) => (await ana.store.get(id))?.status
    expect(await status(rejected.id)).toBe('rejected')
    expect((await ana.store.get(rejected.id))?.reason).toBe('no_permission')
    expect(await status(sameProduct.id)).toBe('rejected')
    expect((await ana.store.get(sameProduct.id))?.reason).toBe('depends_on_rejected')
    expect(await status(a1.id)).toBe('confirmed')
    expect(await status(a2.id)).toBe('confirmed')
    expect(await status(otherProduct.id)).toBe('confirmed')
    expect(m.hub().order(order)?.status).toBe('open')
  })

  it('a rejected item does not drag pending sold-out events, even in the same batch', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const order = newId()
    const x = newId()
    await openOrder(ana, order)
    const expensive = await ana.create(order, 'ItemAdded', item(100_000_000, { quantity: 999 }))
    const after = await ana.create(order, 'ItemAdded', item())
    const soldOut = await markSoldOut(ana, x)
    await m.network.connectAll()

    expect((await ana.store.get(expensive.id))?.status).toBe('rejected')
    expect((await ana.store.get(after.id))?.reason).toBe('depends_on_rejected')
    expect((await ana.store.get(soldOut.id))?.status).toBe('confirmed')
    expect(soldOutOf(await confirmedOf(ana))).toEqual(new Set([`${x}:`]))
  })

  it('rejecting an already sent sold out does not undo what the hub confirmed from another device', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const x = newId()
    await markSoldOut(luis, x)
    await m.network.settle()
    // Ana was not up to date yet and marks the same with the permission removed: only hers is
    // rejected.
    withAccess(m, withoutMarkSoldOutPermission(x))
    ana.disconnect()
    const own = await markSoldOut(ana, x)
    await m.network.connectAll()

    expect((await ana.store.get(own.id))?.status).toBe('rejected')
    expect(soldOutOf(await confirmedOf(ana))).toEqual(new Set([`${x}:`]))
    expect(soldOutOf(eventsOf(m))).toEqual(new Set([`${x}:`]))
  })
})

describe('sold-out convergence between offline devices', () => {
  it('two offline devices mark the opposite: the order they reach the hub wins, and both see it', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const x = newId()
    await markSoldOut(luis, x)
    await m.network.settle()

    ana.disconnect()
    luis.disconnect()
    await release(luis, x)
    await markSoldOut(ana, x)
    // Ana connects first: her "sold out" lands before Luis's "available".
    await ana.connect()
    await m.network.settle()
    await luis.connect()
    await m.network.settle()

    expect(eventsOf(m).map((e) => e.type)).toEqual([
      'ProductSoldOut',
      'ProductSoldOut',
      'ProductAvailable',
    ])
    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [x])
    for (const node of [ana, luis]) expect(soldOutOf(await confirmedOf(node))).toEqual(new Set())
  })

  it('the variant and the whole product are independent', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    await m.network.connectAll()
    const x = newId()
    const bottle = newId()
    await markSoldOut(ana, x, bottle)
    await release(ana, x)
    await m.network.settle()
    expect(soldOutOf(eventsOf(m))).toEqual(new Set([`${x}:${bottle}`]))
    await release(ana, x, bottle)
    await m.network.settle()
    expect(soldOutOf(eventsOf(m))).toEqual(new Set())
  })

  it('property: with drops, crashes and duplicates, everyone ends with the same sold outs as the hub', async () => {
    const products = Array.from({ length: 3 }, () => newId())
    const variants = [null, newId(), newId()]
    type Acc =
      | { t: 'markSoldOut' | 'release'; node: number; p: number; v: number }
      | { t: 'cut' | 'connect' | 'settle' | 'crashHub' | 'order'; node: number }
      | { t: 'duplicate' | 'drop'; node: number }
    const sel = fc.nat({ max: 5 })
    const arbAction: fc.Arbitrary<Acc> = fc.oneof(
      {
        weight: 8,
        arbitrary: fc.record({
          t: fc.constantFrom('markSoldOut' as const, 'release' as const),
          node: sel,
          p: fc.nat({ max: 2 }),
          v: fc.nat({ max: 2 }),
        }),
      },
      { weight: 3, arbitrary: fc.record({ t: fc.constant('cut' as const), node: sel }) },
      { weight: 4, arbitrary: fc.record({ t: fc.constant('connect' as const), node: sel }) },
      { weight: 3, arbitrary: fc.record({ t: fc.constant('settle' as const), node: sel }) },
      { weight: 1, arbitrary: fc.record({ t: fc.constant('crashHub' as const), node: sel }) },
      { weight: 2, arbitrary: fc.record({ t: fc.constant('order' as const), node: sel }) },
      {
        weight: 2,
        arbitrary: fc.record({
          t: fc.constantFrom('duplicate' as const, 'drop' as const),
          node: sel,
        }),
      },
    )

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 3 }),
        fc.array(arbAction, { minLength: 6, maxLength: 40 }),
        async (howMany, actions) => {
          const m = setup()
          const nodes = Array.from({ length: howMany }, (_, i) => m.network.device(`d${i}`))
          for (const a of actions) {
            const node = nodes[a.node % nodes.length] as NetNode
            switch (a.t) {
              case 'markSoldOut':
              case 'release':
                await (a.t === 'markSoldOut' ? markSoldOut : release)(
                  node,
                  products[a.p] as string,
                  variants[a.v] ?? null,
                )
                break
              case 'order':
                await openOrder(node, newId(), null)
                break
              case 'cut':
                node.disconnect()
                break
              case 'connect':
                if (!node.online) await node.connect()
                break
              case 'settle':
                await m.network.settle()
                break
              case 'crashHub':
                m.network.crashHub()
                break
              case 'duplicate':
                node.rule('to_hub', 'push', 'duplicate')
                break
              case 'drop':
                node.rule('to_device', 'result', 'drop')
                break
            }
          }
          for (const n of nodes) {
            n.rules = []
            n.disconnect()
          }
          await m.network.connectAll()

          const hub = eventsOf(m)
          expect(hub.map((e) => e.sequence)).toEqual(hub.map((_, i) => i + 1))
          const expected = soldOutOf(hub)
          for (const n of nodes) {
            expect(await n.client.pendingList()).toBe(0)
            expect(soldOutOf(await confirmedOf(n))).toEqual(expected)
          }
        },
      ),
      { seed: 20_261_024, numRuns: 80 },
    )
  }, 120_000)
})

// So the open-access setup stays referenced if the way of setting up changes.
void openAccess
