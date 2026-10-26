import { type NewEvent, newId, type OrderEventType } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { NetNode } from './testing/network'
import { type CrashingStore, eventsOf, item, setup } from './testing/setup'

// Phase 0 acceptance criterion: whatever happens on the network (drops, lost or duplicated
// messages, hub down), in the end every device and the hub see exactly the same thing and no
// event is lost. Fixed seed: the test is deterministic (`FC_SEED` to explore).

const SEED = Number(process.env.FC_SEED ?? 20_261_024)
const RUNS = Number(process.env.FC_RUNS ?? 150)

type Direction = 'to_hub' | 'to_device'

type Action =
  | { t: 'open'; node: number; table: number }
  | { t: 'add'; node: number; order: number; price: number }
  | { t: 'send'; node: number; order: number }
  | { t: 'remove'; node: number; order: number; item: number }
  | { t: 'disconnect'; node: number }
  | { t: 'connect'; node: number }
  | { t: 'drop'; node: number; direction: Direction; type: number }
  | { t: 'duplicate'; node: number; direction: Direction; type: number }
  | { t: 'serve'; node: number; direction: Direction; index: number }
  | { t: 'settle' }
  | { t: 'crashHub' }
  | { t: 'crashOnSave'; en: number }

const MESSAGE_TYPES: Record<Direction, string[]> = {
  to_hub: ['push', 'pull', 'hello'],
  to_device: ['result', 'new', 'events', 'welcome'],
}

const sel = fc.nat({ max: 9 })
const direction = fc.constantFrom<Direction>('to_hub', 'to_device')

const arbAction: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ t: fc.constant('open' as const), node: sel, table: fc.nat({ max: 3 }) }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant('add' as const),
      node: sel,
      order: sel,
      price: fc.integer({ min: 1000, max: 90_000 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('send' as const), node: sel, order: sel }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('remove' as const), node: sel, order: sel, item: sel }),
  },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('disconnect' as const), node: sel }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('connect' as const), node: sel }) },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('drop' as const), node: sel, direction, type: sel }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('duplicate' as const), node: sel, direction, type: sel }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant('serve' as const),
      node: sel,
      direction,
      index: sel,
    }),
  },
  { weight: 4, arbitrary: fc.constant({ t: 'settle' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'crashHub' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('crashOnSave' as const),
      en: fc.integer({ min: 1, max: 4 }),
    }),
  },
)

const arbScenario = fc.record({
  devices: fc.integer({ min: 2, max: 4 }),
  actions: fc.array(arbAction, { minLength: 8, maxLength: 80, size: 'max' }),
})

/** Runs the actions against a real hub (SQLite) and a simulated network. */
async function execute(devices: number, actions: Action[], orderedChannel = false) {
  const m = setup()
  const store = m.store as CrashingStore
  const nodes = Array.from({ length: devices }, (_, i) => m.network.device(`d${i}`))
  const tables = Array.from({ length: 4 }, () => newId())
  const station = newId()
  /** Every event any device created, to check that none is lost. */
  const createdList: { id: string; node: NetNode }[] = []
  const orders: string[] = []

  const record = async <T extends OrderEventType>(
    node: NetNode,
    order: string,
    type: T,
    data: Extract<NewEvent, { type: T }>['data'],
  ) => {
    const event = await node.create(order, type, data as never)
    createdList.push({ id: event.id, node })
  }

  /** Orders this device sees as open in its own copy. */
  const openOrdersOf = async (node: NetNode) => {
    const seenSet: string[] = []
    for (const id of orders) if ((await node.client.order(id))?.status === 'open') seenSet.push(id)
    return seenSet
  }

  for (const action of actions) {
    // Channel like a healthy WebSocket: no losses, duplicates or reordering.
    if (orderedChannel && (action.t === 'drop' || action.t === 'duplicate')) continue
    const node = nodes[('node' in action ? action.node : 0) % nodes.length] as NetNode
    switch (action.t) {
      case 'open': {
        const order = newId()
        orders.push(order)
        // Table 3 is "no table" (bar); the others are shared between devices.
        const table = action.table === 3 ? null : (tables[action.table] as string)
        await record(node, order, 'OrderOpened', {
          channel: table ? 'dine_in' : 'bar',
          table_id: table,
          guests: 2,
        })
        break
      }
      case 'add': {
        const openOnes = await openOrdersOf(node)
        const order = openOnes[action.order % openOnes.length]
        if (order) await record(node, order, 'ItemAdded', item(action.price))
        break
      }
      case 'send': {
        const openOnes = await openOrdersOf(node)
        const order = openOnes[action.order % openOnes.length]
        const status = order ? await node.client.order(order) : null
        const ids = Object.values(status?.items ?? {})
          .filter((i) => i.status === 'pending')
          .slice(0, 3)
          .map((i) => i.id)
        if (order && ids.length > 0)
          await record(node, order, 'ItemsSent', {
            tickets: [{ ticket_id: newId(), station_id: station, item_ids: ids }],
          })
        break
      }
      case 'remove': {
        const openOnes = await openOrdersOf(node)
        const order = openOnes[action.order % openOnes.length]
        const status = order ? await node.client.order(order) : null
        const removable = Object.values(status?.items ?? {}).filter((i) => i.status === 'pending')
        const selectedProduct = removable[action.item % removable.length]
        if (order && selectedProduct)
          await record(node, order, 'ItemRemoved', { item_id: selectedProduct.id })
        break
      }
      case 'disconnect':
        node.disconnect()
        break
      case 'connect':
        if (!node.online) await node.connect()
        break
      case 'drop':
      case 'duplicate': {
        const types = MESSAGE_TYPES[action.direction]
        node.rule(
          action.direction,
          types[action.type % types.length] as string,
          action.t === 'drop' ? 'drop' : 'duplicate',
        )
        break
      }
      case 'serve':
        await m.network.deliverOne(node, action.direction, orderedChannel ? 0 : action.index)
        break
      case 'settle':
        await m.network.settle()
        break
      case 'crashHub':
        m.network.crashHub()
        break
      case 'crashOnSave':
        store.crashAt = action.en
        break
    }
  }

  // End: the network settles (no new losses or duplicates) and everyone connects. Those still
  // online reopen the connection: with a message lost on a live channel, the heartbeat (15 s with
  // nothing) would declare it dead and the device would reconnect. With an ordered, lossless
  // channel this is not needed: live connections must catch up on their own.
  store.crashAt = 0
  for (const n of nodes) {
    n.rules = []
    if (!orderedChannel) n.disconnect()
  }
  await m.network.connectAll()
  return { m, nodes, createdList, orders }
}

/** Everything that must hold at the end of any sequence of actions. */
async function verify({ m, nodes, createdList, orders }: Awaited<ReturnType<typeof execute>>) {
  const hub = eventsOf(m)

  // The hub has 1..N with no gaps or repeated ids.
  expect(hub.map((e) => e.sequence)).toEqual(hub.map((_, i) => i + 1))
  expect(new Set(hub.map((e) => e.id)).size).toBe(hub.length)
  // A single conflict per event.
  const conflicts = m.hub().conflicts()
  expect(new Set(conflicts.map((c) => c.eventId)).size).toBe(conflicts.length)

  const hubById = new Map(hub.map((e) => [e.id, e]))
  for (const node of nodes) {
    // Nothing pending.
    expect(await node.client.pendingList()).toBe(0)
    const locals = await node.client.locals()
    expect(locals.filter((l) => l.status === 'pending')).toEqual([])

    // The same confirmed events as the hub, identical field by field.
    const allConfirmed = locals.filter((l) => l.status === 'confirmed')
    expect(allConfirmed.map((l) => l.event.id).sort()).toEqual(hub.map((e) => e.id).sort())
    for (const l of allConfirmed) expect(l.event).toEqual(hubById.get(l.event.id))
    expect((await node.store.cursor()).until).toBe(hub.length)

    // The same projections.
    for (const order of orders)
      expect(await node.client.order(order), `order ${order} on ${node.name}`).toEqual(
        m.hub().order(order),
      )
  }

  // No created event was lost: confirmed, rejected with a reason or in quarantine.
  for (const { id, node } of createdList) {
    const local = await node.store.get(id)
    expect(local, `event ${id} disappeared from ${node.name}`).toBeDefined()
    if (local?.status === 'confirmed') expect(hubById.has(id)).toBe(true)
    else if (local?.status === 'rejected') {
      expect(local.reason, `rejection without reason (${id})`).toBeTruthy()
      expect(hubById.has(id), `rejected on ${node.name} but confirmed on the hub`).toBe(false)
    } else expect(local?.status).toBe('quarantine')
  }
}

describe('convergence (properties)', () => {
  it('with drops, losses, duplicates and hub crashes, everyone ends up seeing the same thing', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ devices, actions }) => {
        await verify(await execute(devices, actions))
      }),
      { seed: SEED, numRuns: RUNS },
    )
  }, 120_000)

  it('with an ordered, lossless channel, live connections catch up without reconnecting', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ devices, actions }) => {
        await verify(await execute(devices, actions, true))
      }),
      { seed: SEED, numRuns: RUNS },
    )
  }, 120_000)
})
