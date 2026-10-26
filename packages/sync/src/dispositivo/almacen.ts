import { type AcceptanceData, type ApplicableEvent, affectsOrder, type NewEvent } from '@pos/core'

export type EstadoLocal = 'pending' | 'confirmed' | 'rejected' | 'quarantine'

export interface EventoLocal {
  /** El evento tal como se creó; con los campos del hub cuando ya está confirmado. */
  event: ApplicableEvent
  status: EstadoLocal
  /** Lo creó este dispositivo (solo esos se envían). */
  own: boolean
  /** Orden de registro en este dispositivo: da el orden de los pendientes. */
  position: number
  reason?: string
  /** El hub lo aceptó como conflicto (aparece en caja). */
  conflict?: string | null
}

export interface Cursor {
  /** Instancia del hub con la que se sincronizó; si cambia, el hub se restauró. */
  instancia: string | null
  /** Última secuencia contigua recibida. */
  until: number
  /** Cuánto va adelantado el reloj del hub respecto al de este dispositivo, en ms. */
  desfaseMs?: number
}

/**
 * Almacén local del dispositivo (IndexedDB en el navegador, docs/SYNC.md). Asíncrono como
 * IndexedDB; cada método es atómico.
 */
export interface AlmacenDispositivo {
  guardar(locales: readonly EventoLocal[]): Promise<void>
  obtener(id: string): Promise<EventoLocal | undefined>
  /** Todos los eventos, en orden de registro local. */
  listAll(): Promise<EventoLocal[]>
  /** Los propios pendientes, en orden de registro local (en IndexedDB, por índice). */
  ownPending(limite?: number): Promise<EventoLocal[]>
  /** Los que tocan ese pedido (en IndexedDB, por índice). */
  dePedido(orderId: string): Promise<EventoLocal[]>
  erase(ids: readonly string[]): Promise<void>
  cursor(): Promise<Cursor>
  guardarCursor(cursor: Cursor): Promise<void>
}

export class AlmacenDispositivoMemoria implements AlmacenDispositivo {
  private readonly events = new Map<string, EventoLocal>()
  private cursorActual: Cursor = { instancia: null, until: 0 }

  async guardar(locales: readonly EventoLocal[]) {
    for (const local of locales) this.events.set(local.event.id, structuredClone(local))
  }

  async obtener(id: string) {
    const local = this.events.get(id)
    return local ? structuredClone(local) : undefined
  }

  async listAll() {
    return [...this.events.values()]
      .sort((a, b) => a.position - b.position)
      .map((l) => structuredClone(l))
  }

  async ownPending(limite = Number.POSITIVE_INFINITY) {
    return (await this.listAll()).filter((l) => l.own && l.status === 'pending').slice(0, limite)
  }

  async dePedido(orderId: string) {
    return (await this.listAll()).filter((l) => affectsOrder(l.event, orderId))
  }

  async erase(ids: readonly string[]) {
    for (const id of ids) this.events.delete(id)
  }

  async cursor() {
    return { ...this.cursorActual }
  }

  async guardarCursor(cursor: Cursor) {
    this.cursorActual = { ...cursor }
  }
}

/** El evento sin los campos del hub: lo que se reenvía. */
export function sinAceptacion(event: ApplicableEvent): NewEvent {
  const {
    sequence: _s,
    received_at: _r,
    business_day: _d,
    assignments: _a,
    affects: _f,
    authorized_by_id: _p,
    ...fresh
  } = event as ApplicableEvent & Partial<AcceptanceData>
  return fresh as NewEvent
}
