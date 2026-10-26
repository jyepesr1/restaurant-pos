import { newId, type OrderEvent } from '@pos/core'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { expect } from 'vitest'
import { FloorSync } from '../hub/floor'
import { HubSync } from '../hub/hub'
import { MemoryStore } from '../hub/store'
import { SqliteStore } from '../hub/store-sqlite'
import { openAccess } from './access'
import { type NetNode, SimulatedNetwork } from './network'

// Common setup for the sync tests: a hub over real SQLite and a simulated network.

export const NOW = '2026-10-24T15:00:00.000Z'

export function sqliteDatabase() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurantId = newId()
  db.prepare(
    `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
     VALUES (?, ?, ?, ?, 1, 'La Spritzzería', '{}')`,
  ).run(restaurantId, restaurantId, NOW, NOW)
  return { db, restaurantId }
}

/**
 * SQLite store that can throw when saving an event: simulates the hub process crashing. Once
 * down, nothing else is saved until the hub comes back up (`down = false`).
 */
export class CrashingStore extends SqliteStore {
  /** How many saves remain before the crash (1 = the next one); 0 = none scheduled. */
  crashAt = 0
  down = false

  override transaction<T>(job: () => T): T {
    if (this.down) throw new Error('the hub is down')
    return super.transaction(job)
  }

  override saveEvent(...args: Parameters<SqliteStore['saveEvent']>) {
    if (this.crashAt > 0) {
      this.crashAt -= 1
      if (this.crashAt === 0) {
        this.down = true
        throw new Error('the hub went down')
      }
    }
    super.saveEvent(...args)
  }
}

/** Hub + simulated network. The hub always restarts with the same store (the database survives). */
export function setup(options: { store?: 'sqlite' | 'memory' } = {}) {
  const { db, restaurantId } = sqliteDatabase()
  const store = options.store === 'memory' ? new MemoryStore() : new CrashingStore(db, restaurantId)
  const status: { hub: HubSync | null; instance: string } = { hub: null, instance: 'hub-1' }
  const network: SimulatedNetwork = new SimulatedNetwork(null as unknown as FloorSync)
  const createFloor = (hubStore = store) => {
    status.hub = new HubSync(hubStore, {
      restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      access: openAccess,
      instance: status.instance,
      clock: network.isoTime,
    })
    return new FloorSync(status.hub, network.authenticate)
  }
  network.floor = createFloor()
  network.onHubCrash = () => {
    if (store instanceof CrashingStore) store.down = false
    return createFloor()
  }
  return {
    network,
    db,
    store,
    hub: () => status.hub as HubSync,
    createFloor,
    status,
    restaurantId,
  }
}

export type Setup = ReturnType<typeof setup>

export const openOrder = (node: NetNode, order = newId(), table: string | null = newId()) =>
  node
    .create(order, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 2 })
    .then(() => order)

export const item = (price = 40_900, fields = {}) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Garden Margarita',
  unit_price: price,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 1,
  price_channel_id: null,
  ...fields,
})

export const eventsOf = (m: Setup) => m.store.eventsSince(0, 1_000_000)

/** "See the same": the hub has 1..N with no gaps; each device, the same events and projections. */
export async function seeTheSame(
  hub: HubSync,
  hubEvents: OrderEvent[],
  nodes: NetNode[],
  orders: string[],
) {
  expect(hubEvents.map((e) => e.sequence)).toEqual(hubEvents.map((_, i) => i + 1))
  expect(new Set(hubEvents.map((e) => e.id)).size).toBe(hubEvents.length)
  for (const node of nodes) {
    expect(await node.client.pendingList()).toBe(0)
    const allConfirmed = (await node.client.locals())
      .filter((l) => l.status === 'confirmed')
      .map((l) => l.event.id)
    expect(new Set(allConfirmed)).toEqual(new Set(hubEvents.map((e) => e.id)))
    expect(allConfirmed).toHaveLength(hubEvents.length)
    expect((await node.store.cursor()).until).toBe(hubEvents.length)
    for (const order of orders) expect(await node.client.order(order)).toEqual(hub.order(order))
  }
}
