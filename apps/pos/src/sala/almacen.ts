import { type Cursor, type DeviceStore, type LocalEvent, ordersOf } from '@pos/sync'
import Dexie, { type EntityTable } from 'dexie'

// Almacén del dispositivo en IndexedDB (docs/SYNC.md): los eventos con su estado local, el cursor
// y lo del equipo (credenciales y sesión). Cada método es una transacción. Los índices dan los
// pendientes propios en orden y los eventos de un pedido sin leerlo todo.

interface FilaEvento {
  id: string
  position: number
  /** 1 si es propio y pendiente (IndexedDB no indexa booleanos). */
  pending: 0 | 1
  /** Pedidos que toca (agregado, relacionados y afecta): índice de varias entradas. */
  orders: string[]
  local: LocalEvent
}

interface FilaAjuste {
  key: string
  value: unknown
}

export class BaseDispositivo extends Dexie {
  events!: EntityTable<FilaEvento, 'id'>
  settings!: EntityTable<FilaAjuste, 'key'>

  constructor(name = 'pos') {
    super(name)
    this.version(1).stores({
      events: 'id, position, [pending+position], *orders',
      settings: 'key',
    })
  }

  async leerAjuste<T>(key: string): Promise<T | undefined> {
    return (await this.settings.get(key))?.value as T | undefined
  }

  async saveSetting(key: string, value: unknown): Promise<void> {
    await this.settings.put({ key, value })
  }

  async borrarAjuste(key: string): Promise<void> {
    await this.settings.delete(key)
  }
}

const CURSOR = 'cursor'

const row = (local: LocalEvent): FilaEvento => ({
  id: local.event.id,
  position: local.position,
  pending: local.own && local.status === 'pending' ? 1 : 0,
  orders: ordersOf(local.event),
  local,
})

export class AlmacenIndexedDb implements DeviceStore {
  private readonly db: BaseDispositivo

  constructor(db: BaseDispositivo) {
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
    return (await this.db.leerAjuste<Cursor>(CURSOR)) ?? { instance: null, until: 0 }
  }

  async saveCursor(cursor: Cursor) {
    await this.db.saveSetting(CURSOR, cursor)
  }
}
