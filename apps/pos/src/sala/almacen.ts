import { type AlmacenDispositivo, type Cursor, type EventoLocal, pedidosDe } from '@pos/sync'
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
  local: EventoLocal
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

const fila = (local: EventoLocal): FilaEvento => ({
  id: local.event.id,
  position: local.position,
  pending: local.own && local.status === 'pending' ? 1 : 0,
  orders: pedidosDe(local.event),
  local,
})

export class AlmacenIndexedDb implements AlmacenDispositivo {
  private readonly db: BaseDispositivo

  constructor(db: BaseDispositivo) {
    this.db = db
  }

  async guardar(locales: readonly EventoLocal[]) {
    if (locales.length > 0) await this.db.events.bulkPut(locales.map(fila))
  }

  async obtener(id: string) {
    return (await this.db.events.get(id))?.local
  }

  async listAll() {
    return (await this.db.events.orderBy('position').toArray()).map((f) => f.local)
  }

  async ownPending(limite = Number.POSITIVE_INFINITY) {
    const consulta = this.db.events
      .where('[pending+position]')
      .between([1, Dexie.minKey], [1, Dexie.maxKey])
    const rows = await (Number.isFinite(limite) ? consulta.limit(limite) : consulta).toArray()
    return rows.map((f) => f.local)
  }

  async dePedido(orderId: string) {
    const rows = await this.db.events.where('orders').equals(orderId).toArray()
    return rows.sort((a, b) => a.position - b.position).map((f) => f.local)
  }

  async erase(ids: readonly string[]) {
    await this.db.events.bulkDelete([...ids])
  }

  async cursor(): Promise<Cursor> {
    return (await this.db.leerAjuste<Cursor>(CURSOR)) ?? { instancia: null, until: 0 }
  }

  async guardarCursor(cursor: Cursor) {
    await this.db.saveSetting(CURSOR, cursor)
  }
}
