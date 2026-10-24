import {
  afectaAPedido,
  type DatosAceptacion,
  type EventoAplicable,
  type EventoNuevo,
} from '@pos/core'

export type EstadoLocal = 'pendiente' | 'confirmado' | 'rechazado' | 'cuarentena'

export interface EventoLocal {
  /** El evento tal como se creó; con los campos del hub cuando ya está confirmado. */
  evento: EventoAplicable
  estado: EstadoLocal
  /** Lo creó este dispositivo (solo esos se envían). */
  propio: boolean
  /** Orden de registro en este dispositivo: da el orden de los pendientes. */
  orden: number
  motivo?: string
  /** El hub lo aceptó como conflicto (aparece en caja). */
  conflicto?: string | null
}

export interface Cursor {
  /** Instancia del hub con la que se sincronizó; si cambia, el hub se restauró. */
  instancia: string | null
  /** Última secuencia contigua recibida. */
  hasta: number
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
  listar(): Promise<EventoLocal[]>
  /** Los propios pendientes, en orden de registro local (en IndexedDB, por índice). */
  pendientesPropios(limite?: number): Promise<EventoLocal[]>
  /** Los que tocan ese pedido (en IndexedDB, por índice). */
  dePedido(pedidoId: string): Promise<EventoLocal[]>
  borrar(ids: readonly string[]): Promise<void>
  cursor(): Promise<Cursor>
  guardarCursor(cursor: Cursor): Promise<void>
}

export class AlmacenDispositivoMemoria implements AlmacenDispositivo {
  private readonly eventos = new Map<string, EventoLocal>()
  private cursorActual: Cursor = { instancia: null, hasta: 0 }

  async guardar(locales: readonly EventoLocal[]) {
    for (const local of locales) this.eventos.set(local.evento.id, structuredClone(local))
  }

  async obtener(id: string) {
    const local = this.eventos.get(id)
    return local ? structuredClone(local) : undefined
  }

  async listar() {
    return [...this.eventos.values()]
      .sort((a, b) => a.orden - b.orden)
      .map((l) => structuredClone(l))
  }

  async pendientesPropios(limite = Number.POSITIVE_INFINITY) {
    return (await this.listar())
      .filter((l) => l.propio && l.estado === 'pendiente')
      .slice(0, limite)
  }

  async dePedido(pedidoId: string) {
    return (await this.listar()).filter((l) => afectaAPedido(l.evento, pedidoId))
  }

  async borrar(ids: readonly string[]) {
    for (const id of ids) this.eventos.delete(id)
  }

  async cursor() {
    return { ...this.cursorActual }
  }

  async guardarCursor(cursor: Cursor) {
    this.cursorActual = { ...cursor }
  }
}

/** El evento sin los campos del hub: lo que se reenvía. */
export function sinAceptacion(evento: EventoAplicable): EventoNuevo {
  const {
    secuencia: _s,
    recibido_en: _r,
    dia_operativo: _d,
    asignaciones: _a,
    afecta: _f,
    autorizado_por_id: _p,
    ...nuevo
  } = evento as EventoAplicable & Partial<DatosAceptacion>
  return nuevo as EventoNuevo
}
