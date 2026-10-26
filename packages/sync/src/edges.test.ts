import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from './hub/store'
import type { HubMessage } from './protocol'
import { PAGE_SIZE } from './protocol'
import type { NetNode } from './testing/network'
import { eventsOf, item, NOW, openOrder, type Setup, seeTheSame, setup } from './testing/setup'

// Edge cases of the sync protocol (docs/SYNC.md): out-of-order hub messages, multi-page
// `pull`, drops with a batch and a `pull` in flight, and resent rejections.

/** Raw event, as a device sends it, to talk to the hub without going through the client. */
const raw = (node: NetNode, order: string, type: string, data: unknown, base = 0) => ({
  id: newId(),
  type,
  schema_version: 1,
  aggregate_type: 'order',
  aggregate_id: order,
  related: [],
  data,
  session_id: null,
  user_id: node.userId,
  device_id: node.deviceId,
  authorization_id: null,
  reason: null,
  device_time: NOW,
  hub_estimated_time: NOW,
  base_sequence: base,
})

const connectionOf = (m: Setup, node: NetNode) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`No token for ${node.name}`)
  return connection
}

const open = (node: NetNode, order: string) =>
  raw(node, order, 'OrderOpened', { channel: 'bar', table_id: null, guests: 1 })

/** Puts `total` events straight into the hub (an order and its items), with no device connected. */
function seed(m: Setup, node: NetNode, total: number) {
  const order = newId()
  const events = [open(node, order)]
  for (let i = 1; i < total; i++) events.push(raw(node, order, 'ItemAdded', item(1000 + (i % 500))))
  for (let i = 0; i < events.length; i += 100) {
    const r = m.hub().receiveBatch(connectionOf(m, node), events.slice(i, i + 100))
    expect(r.acceptedEvents).toHaveLength(Math.min(100, events.length - i))
  }
  return order
}

/** Records every hub message a device receives. */
function spy(node: NetNode) {
  const seenSet: HubMessage[] = []
  const original = node.client.receive.bind(node.client)
  node.client.receive = (message) => {
    seenSet.push(message)
    return original(message)
  }
  return seenSet
}

/** Delivers to the hub the in-flight message of that type, whatever its place in the queue. */
async function deliverToHub(m: Setup, node: NetNode, type: string) {
  const index = node.toHub.findIndex((x) => x.type === type)
  expect(index, `no ${type} in flight`).toBeGreaterThanOrEqual(0)
  await m.network.deliverOne(node, 'to_hub', index)
}

const types = (messages: readonly { type: string }[]) => messages.map((x) => x.type)

describe('out-of-order hub messages', () => {
  it('an old `events` page after a `new` neither moves the cursor back nor duplicates', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await m.network.connectAll()
    const order = await openOrder(ana)
    await m.network.settle()

    const oldPage = m.hub().pull(0, 'register') // up to 1
    expect(oldPage).toMatchObject({ until: 1, has_more: false })
    await ana.create(order, 'ItemAdded', item())
    await ana.create(order, 'ItemAdded', item(12_900))
    await m.network.settle()
    expect((await register.store.cursor()).until).toBe(3)

    await register.client.receive(oldPage)

    expect((await register.store.cursor()).until).toBe(3)
    expect(await register.client.locals()).toHaveLength(3)
    await seeTheSame(m.hub(), eventsOf(m), [ana, register], [order])
  })

  it('an old page with `has_more` pulls again from the cursor, without breaking anything', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await m.network.connectAll()
    const order = await openOrder(ana)
    await m.network.settle()
    const oldPage = { ...m.hub().pull(0, 'register'), has_more: true }
    await ana.create(order, 'ItemAdded', item())
    await m.network.settle()

    const seenSet = spy(register)
    await register.client.receive(oldPage)
    // The cursor is already at 2: it does not request again what it has.
    expect(register.toHub).toEqual([{ type: 'pull', from: 2 }])
    await m.network.settle()

    expect(types(seenSet)).toEqual(['events', 'events'])
    await seeTheSame(m.hub(), eventsOf(m), [ana, register], [order])
  })

  it('a `new` that arrives before the page that already includes it is absorbed without leaving the device behind', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await ana.connect()
    await m.network.settle()
    const order = await openOrder(ana)
    await ana.create(order, 'ItemAdded', item())
    await m.network.settle()

    // The register connects and sends `pull 0`; while the response travels, ana adds another item.
    await register.connect()
    await m.network.deliverOne(register, 'to_hub') // hello
    await m.network.deliverOne(register, 'to_device') // welcome → pull
    await m.network.deliverOne(register, 'to_hub') // pull → events (1 and 2)
    await ana.create(order, 'ItemAdded', item(12_900))
    await m.network.deliverOne(ana, 'to_hub') // the hub accepts 3 and broadcasts `new`
    expect(types(register.toDevice)).toEqual(['events', 'new'])

    // The channel reorders them: `new` (gap: the register is at 0) arrives before `events`.
    await m.network.deliverOne(register, 'to_device', 1)
    await m.network.settle()

    await seeTheSame(m.hub(), eventsOf(m), [ana, register], [order])
  })

  it('a repeated `result`, or one for a batch no longer in flight, is ignored', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    await m.network.connectAll()
    const seenSet = spy(ana)
    const order = await openOrder(ana)
    await m.network.settle()
    const result = seenSet.find((x) => x.type === 'result')
    expect(result).toBeDefined()

    const before = await ana.client.locals()
    await ana.client.receive(result as HubMessage)
    await ana.client.receive({
      ...(result as HubMessage & { type: 'result' }),
      batch_id: 'other',
    })

    expect(await ana.client.locals()).toEqual(before)
    await seeTheSame(m.hub(), eventsOf(m), [ana], [order])
  })
})

// Hundreds of items in a single order: each event copies the whole order, so these take a few
// seconds. A real order has dozens of items.
describe('pull with several pages', () => {
  it.each([
    // [events in the hub, expected `events` pages]
    [PAGE_SIZE - 1, 1],
    [PAGE_SIZE, 2], // exactly one full page: `has_more` forces another pull, which comes back empty
    [PAGE_SIZE + 1, 2],
    [2 * PAGE_SIZE + 203, 3],
  ])('a new device with %i events in the hub catches up in %i page(s)', async (total, pages) => {
    const m = setup()
    const ana = m.network.device('ana')
    const order = seed(m, ana, total)
    expect(eventsOf(m)).toHaveLength(total)

    const register = m.network.device('register')
    const seenSet = spy(register)
    await m.network.connectAll()

    const receivedPages = seenSet.filter((x) => x.type === 'events')
    expect(receivedPages).toHaveLength(pages)
    expect(receivedPages.map((p) => p.events.length)).toEqual(
      Array.from({ length: pages }, (_, i) =>
        Math.min(PAGE_SIZE, Math.max(0, total - i * PAGE_SIZE)),
      ),
    )
    // No repeated `pull`s either: one per page.
    expect(receivedPages.map((p) => p.has_more)).toEqual(
      Array.from({ length: pages }, (_, i) => i < pages - 1),
    )
    await seeTheSame(m.hub(), eventsOf(m), [register], [order])
  })

  it('a new event that arrives between two pages is neither lost nor delays the cursor', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const order = seed(m, ana, 2 * PAGE_SIZE + 203)
    // Ana only says hello: she stays connected to send an event, without downloading the seed.
    await ana.connect()
    await m.network.deliverOne(ana, 'to_hub') // hello

    const register = m.network.device('register')
    await register.connect()
    await m.network.deliverOne(register, 'to_hub') // hello
    await m.network.deliverOne(register, 'to_device') // welcome → pull 0
    await m.network.deliverOne(register, 'to_hub') // pull
    await m.network.deliverOne(register, 'to_device') // page 1 → pull 500
    expect((await register.store.cursor()).until).toBe(PAGE_SIZE)

    await ana.create(order, 'ItemAdded', item(7000))
    await deliverToHub(m, ana, 'push') // the hub accepts 1204 and broadcasts it to the register
    expect(types(register.toDevice)).toEqual(['new'])
    await m.network.deliverOne(register, 'to_device') // `new` with a gap: does not advance
    expect((await register.store.cursor()).until).toBe(PAGE_SIZE)

    await m.network.settle()
    expect(eventsOf(m)).toHaveLength(2 * PAGE_SIZE + 204)
    await seeTheSame(m.hub(), eventsOf(m), [register], [order])
  })

  it('the connection drops between two pages: on return it continues from its cursor, not from zero', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const order = seed(m, ana, 2 * PAGE_SIZE + 1)
    const register = m.network.device('register')
    await register.connect()
    await m.network.deliverOne(register, 'to_hub') // hello
    await m.network.deliverOne(register, 'to_device') // welcome
    await m.network.deliverOne(register, 'to_hub') // pull 0
    await m.network.deliverOne(register, 'to_device') // page 1
    expect((await register.store.cursor()).until).toBe(PAGE_SIZE)

    register.disconnect()
    await register.connect()
    await m.network.deliverOne(register, 'to_hub') // hello
    await m.network.deliverOne(register, 'to_device') // welcome
    expect(register.toHub).toEqual([{ type: 'pull', from: PAGE_SIZE }])

    await m.network.settle()
    await seeTheSame(m.hub(), eventsOf(m), [register], [order])
  })
})

describe('drop with a batch and a `pull` in flight', () => {
  /** What made it to the hub before the drop. */
  const cases = [
    { delivered: 'nothing', pull: false, push: false },
    { delivered: 'only the pull', pull: true, push: false },
    { delivered: 'only the batch', pull: false, push: true },
    { delivered: 'the pull and the batch', pull: true, push: true },
  ] as const

  for (const caseName of cases) {
    for (const withLate of [false, true]) {
      it(`${caseName.delivered} arrived${withLate ? ' and the old messages arrive late' : ''}: nothing is lost or duplicated`, async () => {
        const m = setup()
        const ana = m.network.device('ana')
        const luis = m.network.device('luis')
        await m.network.connectAll()
        const order = await openOrder(luis)
        await m.network.settle()

        ana.disconnect()
        await ana.create(order, 'ItemAdded', item(10_000))
        await ana.create(order, 'ItemAdded', item(20_000))
        await ana.create(order, 'ItemAdded', item(30_000))

        // Reconnects: `pull` and the batch of 3 go out, and the connection drops with both
        // in flight.
        await ana.connect()
        await m.network.deliverOne(ana, 'to_hub') // hello
        await m.network.deliverOne(ana, 'to_device') // welcome
        expect(types(ana.toHub)).toEqual(['pull', 'push'])
        if (caseName.pull) await deliverToHub(m, ana, 'pull')
        if (caseName.push) await deliverToHub(m, ana, 'push')
        const oldEntries = [...ana.toDevice]
        const inTheHub = eventsOf(m).length
        expect(inTheHub).toBe(caseName.push ? 4 : 1)

        ana.disconnect()
        await ana.connect()
        if (withLate) for (const oldOne of oldEntries) await ana.client.receive(oldOne)
        await m.network.deliverOne(ana, 'to_hub') // hello
        await m.network.deliverOne(ana, 'to_device') // welcome

        // The old connection's state is not carried over: one `pull` goes out and, if anything is
        // still pending, a single batch. (The late `new` echo may have confirmed the events.)
        const pendingList = await ana.client.pendingList()
        expect(types(ana.toHub).sort()).toEqual(pendingList > 0 ? ['pull', 'push'] : ['pull'])

        await m.network.settle()
        expect(eventsOf(m)).toHaveLength(4)
        await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [order])
      })
    }
  }

  it('when dropping with the batch in flight, the next batch goes out complete and in order', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const order = await openOrder(ana)
    const items = Array.from({ length: 230 }, (_, i) => item(1000 + i))
    for (const i of items) await ana.create(order, 'ItemAdded', i)

    await ana.connect()
    await m.network.deliverOne(ana, 'to_hub') // hello
    await m.network.deliverOne(ana, 'to_device') // welcome → pull + batch of 100
    await deliverToHub(m, ana, 'push') // the hub accepts the first 100
    expect(eventsOf(m)).toHaveLength(100)
    ana.disconnect() // the `result` is lost with the drop

    await m.network.connectAll()
    const position = eventsOf(m)
      .slice(1)
      .map((e) => (e.data as { item_id: string }).item_id)
    expect(position).toEqual(items.map((i) => i.item_id))
    await seeTheSame(m.hub(), eventsOf(m), [ana], [order])
  })
})

describe('rejected event resent as is', () => {
  const rejections = (m: Setup) =>
    Number(m.db.prepare('SELECT count(*) AS n FROM rejected_events').get()?.n)

  it('the hub answers the same and does not save a second rejection', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const connection = connectionOf(m, ana)
    const order = newId()
    m.hub().receiveBatch(connection, [open(ana, order)])
    const expensive = raw(ana, order, 'ItemAdded', item(100_000_000, { quantity: 999 }), 1)
    const after = raw(ana, order, 'ItemAdded', item(5000), 1)

    const first = m.hub().receiveBatch(connection, [expensive, after])
    const second = m.hub().receiveBatch(connection, [expensive, after])
    const onlyTheDependent = m.hub().receiveBatch(connection, [after])

    expect(first.results).toEqual([
      { id: expensive.id, status: 'rejected', reason: 'total_exceeds' },
      { id: after.id, status: 'rejected', reason: 'depends_on_rejected' },
    ])
    expect(second.results).toEqual(first.results)
    expect(onlyTheDependent.results).toEqual([first.results[1]])
    expect(second.acceptedEvents).toEqual([])
    expect(rejections(m)).toBe(2)
    expect(eventsOf(m)).toHaveLength(1)
  })

  it('the rejection is stable: even if the hub changes, the same event gets the same answer', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const connection = connectionOf(m, ana)
    const order = newId()
    const orphan = raw(ana, order, 'ItemAdded', item())

    const before = m.hub().receiveBatch(connection, [orphan])
    m.hub().receiveBatch(connection, [open(ana, order)]) // now the order does exist
    const after = m.hub().receiveBatch(connection, [orphan])

    expect(before.results[0]).toMatchObject({ status: 'rejected', reason: 'order_not_found' })
    expect(after.results).toEqual(before.results)
    expect(after.acceptedEvents).toEqual([])
    expect(eventsOf(m)).toHaveLength(1)
  })

  it('the same rejected id with other content gives `duplicate_id`, and repeated as is gives the same answer', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const connection = connectionOf(m, ana)
    const order = newId()
    const orphan = raw(ana, order, 'ItemAdded', item())
    const otherContent = { ...orphan, data: item(2000) }
    m.hub().receiveBatch(connection, [orphan])

    const a = m.hub().receiveBatch(connection, [otherContent])
    const b = m.hub().receiveBatch(connection, [otherContent])

    // Rejected before with other content: this one is new, and is rejected by the order rule.
    expect(a.results[0]).toMatchObject({ status: 'rejected' })
    expect(b.results).toEqual(a.results)
  })

  it('an already confirmed event that comes back with other content gives `duplicate_id` every time, without failing the batch', () => {
    const m = setup()
    const ana = m.network.device('ana')
    const connection = connectionOf(m, ana)
    const original = open(ana, newId())
    const tampered = { ...original, data: { channel: 'bar', table_id: null, guests: 7 } }
    const other = open(ana, newId())
    m.hub().receiveBatch(connection, [original])

    const a = m.hub().receiveBatch(connection, [tampered, other])
    const b = m.hub().receiveBatch(connection, [tampered, other])

    expect(a.results[0]).toMatchObject({ status: 'rejected', reason: 'duplicate_id' })
    expect(b.results[0]).toEqual(a.results[0])
    expect(a.results[1]?.status).toBe('confirmed')
    expect(b.results[1]).toEqual(a.results[1])
    expect(eventsOf(m)).toHaveLength(2)
  })

  it('over the network: the `result` with rejections is lost, the batch is resent and the device gets the same', async () => {
    const m = setup()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.connectAll()
    const order = await openOrder(ana)
    const other = await openOrder(luis)
    await m.network.settle()

    ana.disconnect()
    const expensive = item(100_000_000, { quantity: 999 })
    const after = item()
    await ana.create(order, 'ItemAdded', expensive)
    await ana.create(order, 'ItemAdded', after)
    await ana.create(other, 'ItemAdded', item(5000))

    ana.rule('to_device', 'result', 'drop')
    await m.network.connectAll()
    // Without `result`, the two rejected stay pending; the third was already confirmed by the echo.
    expect(await ana.client.pendingList()).toBe(2)
    const rejectionsBefore = rejections(m)
    expect(rejectionsBefore).toBe(2)

    ana.disconnect()
    await m.network.connectAll()

    const reasons = (await ana.client.locals())
      .filter((l) => l.status === 'rejected')
      .map((l) => l.reason)
    expect(reasons).toEqual(['total_exceeds', 'depends_on_rejected'])
    expect(rejections(m)).toBe(rejectionsBefore)
    expect(eventsOf(m)).toHaveLength(3)
    await seeTheSame(m.hub(), eventsOf(m), [ana, luis], [order, other])
  })

  it('a hub restored from a backup that already has the event does not reject it as `duplicate_id` on resend', async () => {
    const m = setup({ store: 'memory' })
    const ana = m.network.device('ana')
    await m.network.connectAll()
    const order = await openOrder(ana)
    await m.network.settle()
    // With the order already confirmed (cursor 1), ana adds an item: it carries `base_sequence` 1.
    await ana.create(order, 'ItemAdded', item())
    await m.network.settle()
    const fallback = structuredClone((m.store as MemoryStore).events)
    // After the backup, one more item: the only one the backup does not have.
    const latest = await ana.create(order, 'ItemAdded', item(8900))
    await m.network.settle()
    expect(eventsOf(m)).toHaveLength(3)

    for (const node of m.network.nodes) node.disconnect()
    const restored = new MemoryStore()
    restored.events = fallback
    m.status.instance = 'hub-2'
    m.network.floor = m.createFloor(restored)
    await m.network.connectAll()

    const local = await ana.store.get(latest.id)
    expect(local?.status, `the last item ended ${local?.status} (${local?.reason})`).toBe(
      'confirmed',
    )
    expect(restored.rejections).toEqual([])
    await seeTheSame(m.hub(), restored.eventsSince(0, 1000), [ana], [order])
  })
})
