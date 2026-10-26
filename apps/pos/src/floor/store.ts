import { type Cursor, type DeviceStore, type LocalEvent, ordersOf } from '@pos/sync'
import Dexie, { type EntityTable } from 'dexie'

// Device store in IndexedDB (docs/SYNC.md): events with their local state, the cursor and
// the device's own data (credentials and session). Each method is a transaction. The indexes give
// the device's own pending events in order and an order's events without reading everything.

interface EventRow {
  id: string
  position: number
  /** 1 if it is own and pending (IndexedDB does not index booleans). */
  pending: 0 | 1
  /** Orders it touches (aggregate, related and affects): a multi-entry index. */
  orders: string[]
  local: LocalEvent
}

interface SettingRow {
  key: string
  value: unknown
}

export class DeviceDatabase extends Dexie {
  events!: EntityTable<EventRow, 'id'>
  settings!: EntityTable<SettingRow, 'key'>

  constructor(name = 'pos') {
    super(name)
    this.version(1).stores({
      events: 'id, position, [pending+position], *orders',
      settings: 'key',
    })
  }

  async readSetting<T>(key: string): Promise<T | undefined> {
    return (await this.settings.get(key))?.value as T | undefined
  }

  async saveSetting(key: string, value: unknown): Promise<void> {
    await this.settings.put({ key, value })
  }

  async deleteSetting(key: string): Promise<void> {
    await this.settings.delete(key)
  }
}

const CURSOR = 'cursor'

const row = (local: LocalEvent): EventRow => ({
  id: local.event.id,
  position: local.position,
  pending: local.own && local.status === 'pending' ? 1 : 0,
  orders: ordersOf(local.event),
  local,
})

export class IndexedDbStore implements DeviceStore {
  private readonly db: DeviceDatabase

  constructor(db: DeviceDatabase) {
    this.db = db
  }

  async save(locals: readonly LocalEvent[]) {
    if (locals.length > 0) await this.db.events.bulkPut(locals.map(row))
  }

  async get(id: string) {
    return (await this.db.events.get(id))?.local
  }

  async listAll() {
    return (await this.db.events.orderBy('position').toArray()).map((f) => f.local)
  }

  async ownPending(limit = Number.POSITIVE_INFINITY) {
    const query = this.db.events
      .where('[pending+position]')
      .between([1, Dexie.minKey], [1, Dexie.maxKey])
    const rows = await (Number.isFinite(limit) ? query.limit(limit) : query).toArray()
    return rows.map((f) => f.local)
  }

  async ofOrder(orderId: string) {
    const rows = await this.db.events.where('orders').equals(orderId).toArray()
    return rows.sort((a, b) => a.position - b.position).map((f) => f.local)
  }

  async erase(ids: readonly string[]) {
    await this.db.events.bulkDelete([...ids])
  }

  async cursor(): Promise<Cursor> {
    return (await this.db.readSetting<Cursor>(CURSOR)) ?? { instance: null, until: 0 }
  }

  async saveCursor(cursor: Cursor) {
    await this.db.saveSetting(CURSOR, cursor)
  }
}
