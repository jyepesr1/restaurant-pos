import type { OrderEvent } from '@pos/core'

/** Tipos de conflicto que acepta la tabla `conflicto` (docs/MODELO_DATOS.md). */
export type TipoConflicto =
  | 'duplicate_table'
  | 'table_locked'
  | 'item_not_found'
  | 'item_already_sent'
  | 'item_already_voided'
  | 'item_moved'
  | 'order_closed'
  | 'price_mismatch'

export interface Conflicto {
  id: string
  type: TipoConflicto
  eventId: string
  agregadoId: string
  description: string
  detectadoEn: string
}

export interface Rechazo {
  eventId: string
  fingerprint: string
  dispositivoId: string
  reason: string
  content: string
  recibidoEn: string
}

export interface Cuarentena {
  eventId: string
  dispositivoId: string
  reason: string
  content: string
  recibidoEn: string
}

/**
 * Lo que el hub necesita guardar (docs/SYNC.md). Síncrono: el hub usa `node:sqlite`, que lo es,
 * y así una transacción no puede intercalarse con otro mensaje.
 */
/** Los eventos que mueven plata en un turno de caja (llevan `register_shift_id`). */
export const TIPOS_COBRO: readonly string[] = ['PaymentRecorded', 'PaymentVoided', 'RefundRecorded']

export interface AlmacenHub {
  transaccion<T>(trabajo: () => T): T
  maxSecuencia(): number
  porId(id: string): { event: OrderEvent; fingerprint: string } | undefined
  rechazo(eventId: string, fingerprint: string): Rechazo | undefined
  conflictoDe(eventId: string): Conflicto | undefined
  /**
   * Mayor secuencia entre los eventos que tocan alguno de esos agregados (0 si ninguno). Con
   * `excepto`, sin contar los de ese dispositivo: los propios siempre los conoce.
   */
  ultimaSecuenciaDe(agregados: readonly string[], excepto?: string): number
  /** Eventos que tocan un agregado, en orden de secuencia. */
  eventosDeAgregado(agregadoId: string): OrderEvent[]
  /** Cuántos eventos de ese dispositivo hay en cuarentena. */
  cuarentenasDe(dispositivoId: string): number
  /** Cuántos pedidos se abrieron en el día operativo: da el número de pedido del día. */
  aperturasDelDia(day: string): number
  /** Cuántas comandas se numeraron en el día operativo: da el número de la siguiente. */
  comandasDelDia(day: string): number
  eventosDesde(from: number, limite: number): OrderEvent[]
  /** Eventos de esos tipos con día operativo entre `desde` y `hasta` (inclusive), por secuencia. */
  eventosDelPeriodo(types: readonly string[], from: string, until: string): OrderEvent[]
  /**
   * Pagos, anulaciones de pago y reembolsos registrados en un turno de caja, por secuencia. `desde`
   * es el día operativo en que se abrió: acota la búsqueda (un turno no recibe cobros de antes).
   */
  cobrosDeTurno(shiftId: string, from: string): OrderEvent[]
  saveEvent(event: OrderEvent, fingerprint: string, agregados: readonly string[]): void
  /** Si ya hay un rechazo con ese id y esa huella, no hace nada. */
  guardarRechazo(rechazo: Rechazo): void
  guardarCuarentena(quarantine: Cuarentena): void
  guardarConflicto(conflict: Conflicto): void
  conflictos(): Conflicto[]
}

/** Almacén en memoria para pruebas. `fallar` permite simular una caída en un punto dado. */
export class AlmacenMemoria implements AlmacenHub {
  events: { event: OrderEvent; fingerprint: string; agregados: readonly string[] }[] = []
  rechazos: Rechazo[] = []
  cuarentenas: Cuarentena[] = []
  listaConflictos: Conflicto[] = []
  /** Se llama antes de confirmar cada transacción; si lanza, nada de esa transacción queda. */
  fallar: (() => void) | null = null

  transaccion<T>(trabajo: () => T): T {
    const copy = {
      events: [...this.events],
      rechazos: [...this.rechazos],
      cuarentenas: [...this.cuarentenas],
      conflictos: [...this.listaConflictos],
    }
    try {
      const result = trabajo()
      this.fallar?.()
      return result
    } catch (error) {
      this.events = copy.events
      this.rechazos = copy.rechazos
      this.cuarentenas = copy.cuarentenas
      this.listaConflictos = copy.conflictos
      throw error
    }
  }

  maxSecuencia(): number {
    return this.events.at(-1)?.event.sequence ?? 0
  }

  porId(id: string) {
    return this.events.find((e) => e.event.id === id)
  }

  rechazo(eventId: string, fingerprint: string) {
    return this.rechazos.find((r) => r.eventId === eventId && r.fingerprint === fingerprint)
  }

  conflictoDe(eventId: string) {
    return this.listaConflictos.find((c) => c.eventId === eventId)
  }

  ultimaSecuenciaDe(agregados: readonly string[], excepto?: string): number {
    return this.events
      .filter((e) => e.agregados.some((a) => agregados.includes(a)))
      .filter((e) => e.event.device_id !== excepto)
      .reduce((max, e) => Math.max(max, e.event.sequence), 0)
  }

  eventosDeAgregado(agregadoId: string): OrderEvent[] {
    return this.events.filter((e) => e.agregados.includes(agregadoId)).map((e) => e.event)
  }

  cuarentenasDe(dispositivoId: string): number {
    return this.cuarentenas.filter((c) => c.dispositivoId === dispositivoId).length
  }

  aperturasDelDia(day: string): number {
    return this.events.filter((e) => e.event.type === 'OrderOpened' && e.event.business_day === day)
      .length
  }

  comandasDelDia(day: string): number {
    return this.events
      .map((e) => e.event)
      .filter((e) => e.type === 'ItemsSent' && e.business_day === day)
      .reduce((n, e) => n + Object.keys(e.assignments.ticket_numbers ?? {}).length, 0)
  }

  eventosDelPeriodo(types: readonly string[], from: string, until: string): OrderEvent[] {
    return this.events
      .map((e) => e.event)
      .filter((e) => types.includes(e.type) && e.business_day >= from && e.business_day <= until)
      .sort((a, b) => a.sequence - b.sequence)
  }

  cobrosDeTurno(shiftId: string, from: string): OrderEvent[] {
    return this.events
      .map((e) => e.event)
      .filter(
        (e) =>
          TIPOS_COBRO.includes(e.type) &&
          e.business_day >= from &&
          (e.data as { register_shift_id?: string }).register_shift_id === shiftId,
      )
      .sort((a, b) => a.sequence - b.sequence)
  }

  eventosDesde(from: number, limite: number): OrderEvent[] {
    return this.events
      .filter((e) => e.event.sequence > from)
      .slice(0, limite)
      .map((e) => e.event)
  }

  saveEvent(event: OrderEvent, fingerprint: string, agregados: readonly string[]) {
    this.events.push({ event, fingerprint, agregados })
  }

  guardarRechazo(rechazo: Rechazo) {
    if (!this.rechazo(rechazo.eventId, rechazo.fingerprint)) this.rechazos.push(rechazo)
  }

  guardarCuarentena(quarantine: Cuarentena) {
    if (!this.cuarentenas.some((c) => c.eventId === quarantine.eventId))
      this.cuarentenas.push(quarantine)
  }

  guardarConflicto(conflict: Conflicto) {
    if (!this.conflictoDe(conflict.eventId)) this.listaConflictos.push(conflict)
  }

  conflictos(): Conflicto[] {
    return [...this.listaConflictos]
  }
}
