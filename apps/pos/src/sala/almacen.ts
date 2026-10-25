import { type AlmacenDispositivo, type Cursor, type EventoLocal, pedidosDe } from '@pos/sync'
import Dexie, { type EntityTable } from 'dexie'

// Almacén del dispositivo en IndexedDB (docs/SYNC.md): los eventos con su estado local, el cursor
// y lo del equipo (credenciales y sesión). Cada método es una transacción. Los índices dan los
// pendientes propios en orden y los eventos de un pedido sin leerlo todo.

interface FilaEvento {
  id: string
  orden: number
  /** 1 si es propio y pendiente (IndexedDB no indexa booleanos). */
  pendiente: 0 | 1
  /** Pedidos que toca (agregado, relacionados y afecta): índice de varias entradas. */
  pedidos: string[]
  local: EventoLocal
}

interface FilaAjuste {
  clave: string
  valor: unknown
}

export class BaseDispositivo extends Dexie {
  eventos!: EntityTable<FilaEvento, 'id'>
  ajustes!: EntityTable<FilaAjuste, 'clave'>

  constructor(nombre = 'pos') {
    super(nombre)
    this.version(1).stores({
      eventos: 'id, orden, [pendiente+orden], *pedidos',
      ajustes: 'clave',
    })
  }

  async leerAjuste<T>(clave: string): Promise<T | undefined> {
    return (await this.ajustes.get(clave))?.valor as T | undefined
  }

  async guardarAjuste(clave: string, valor: unknown): Promise<void> {
    await this.ajustes.put({ clave, valor })
  }

  async borrarAjuste(clave: string): Promise<void> {
    await this.ajustes.delete(clave)
  }
}

const CURSOR = 'cursor'

const fila = (local: EventoLocal): FilaEvento => ({
  id: local.evento.id,
  orden: local.orden,
  pendiente: local.propio && local.estado === 'pendiente' ? 1 : 0,
  pedidos: pedidosDe(local.evento),
  local,
})

export class AlmacenIndexedDb implements AlmacenDispositivo {
  private readonly db: BaseDispositivo

  constructor(db: BaseDispositivo) {
    this.db = db
  }

  async guardar(locales: readonly EventoLocal[]) {
    if (locales.length > 0) await this.db.eventos.bulkPut(locales.map(fila))
  }

  async obtener(id: string) {
    return (await this.db.eventos.get(id))?.local
  }

  async listar() {
    return (await this.db.eventos.orderBy('orden').toArray()).map((f) => f.local)
  }

  async pendientesPropios(limite = Number.POSITIVE_INFINITY) {
    const consulta = this.db.eventos
      .where('[pendiente+orden]')
      .between([1, Dexie.minKey], [1, Dexie.maxKey])
    const filas = await (Number.isFinite(limite) ? consulta.limit(limite) : consulta).toArray()
    return filas.map((f) => f.local)
  }

  async dePedido(pedidoId: string) {
    const filas = await this.db.eventos.where('pedidos').equals(pedidoId).toArray()
    return filas.sort((a, b) => a.orden - b.orden).map((f) => f.local)
  }

  async borrar(ids: readonly string[]) {
    await this.db.eventos.bulkDelete([...ids])
  }

  async cursor(): Promise<Cursor> {
    return (await this.db.leerAjuste<Cursor>(CURSOR)) ?? { instancia: null, hasta: 0 }
  }

  async guardarCursor(cursor: Cursor) {
    await this.db.guardarAjuste(CURSOR, cursor)
  }
}
