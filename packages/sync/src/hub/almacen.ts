import type { EventoPedido } from '@pos/core'

/** Tipos de conflicto que acepta la tabla `conflicto` (docs/MODELO_DATOS.md). */
export type TipoConflicto =
  | 'mesa_duplicada'
  | 'mesa_bloqueada'
  | 'item_inexistente'
  | 'item_ya_enviado'
  | 'item_ya_anulado'
  | 'item_movido'
  | 'pedido_cerrado'
  | 'precio_distinto'

export interface Conflicto {
  id: string
  tipo: TipoConflicto
  eventoId: string
  agregadoId: string
  descripcion: string
  detectadoEn: string
}

export interface Rechazo {
  eventoId: string
  huella: string
  dispositivoId: string
  motivo: string
  contenido: string
  recibidoEn: string
}

export interface Cuarentena {
  eventoId: string
  dispositivoId: string
  motivo: string
  contenido: string
  recibidoEn: string
}

/**
 * Lo que el hub necesita guardar (docs/SYNC.md). Síncrono: el hub usa `node:sqlite`, que lo es,
 * y así una transacción no puede intercalarse con otro mensaje.
 */
export interface AlmacenHub {
  transaccion<T>(trabajo: () => T): T
  maxSecuencia(): number
  porId(id: string): { evento: EventoPedido; huella: string } | undefined
  rechazo(eventoId: string, huella: string): Rechazo | undefined
  conflictoDe(eventoId: string): Conflicto | undefined
  /**
   * Mayor secuencia entre los eventos que tocan alguno de esos agregados (0 si ninguno). Con
   * `excepto`, sin contar los de ese dispositivo: los propios siempre los conoce.
   */
  ultimaSecuenciaDe(agregados: readonly string[], excepto?: string): number
  /** Eventos que tocan un agregado, en orden de secuencia. */
  eventosDeAgregado(agregadoId: string): EventoPedido[]
  /** Cuántos eventos de ese dispositivo hay en cuarentena. */
  cuarentenasDe(dispositivoId: string): number
  /** Cuántos pedidos se abrieron en el día operativo: da el número de pedido del día. */
  aperturasDelDia(dia: string): number
  eventosDesde(desde: number, limite: number): EventoPedido[]
  guardarEvento(evento: EventoPedido, huella: string, agregados: readonly string[]): void
  /** Si ya hay un rechazo con ese id y esa huella, no hace nada. */
  guardarRechazo(rechazo: Rechazo): void
  guardarCuarentena(cuarentena: Cuarentena): void
  guardarConflicto(conflicto: Conflicto): void
  conflictos(): Conflicto[]
}

/** Almacén en memoria para pruebas. `fallar` permite simular una caída en un punto dado. */
export class AlmacenMemoria implements AlmacenHub {
  eventos: { evento: EventoPedido; huella: string; agregados: readonly string[] }[] = []
  rechazos: Rechazo[] = []
  cuarentenas: Cuarentena[] = []
  listaConflictos: Conflicto[] = []
  /** Se llama antes de confirmar cada transacción; si lanza, nada de esa transacción queda. */
  fallar: (() => void) | null = null

  transaccion<T>(trabajo: () => T): T {
    const copia = {
      eventos: [...this.eventos],
      rechazos: [...this.rechazos],
      cuarentenas: [...this.cuarentenas],
      conflictos: [...this.listaConflictos],
    }
    try {
      const resultado = trabajo()
      this.fallar?.()
      return resultado
    } catch (error) {
      this.eventos = copia.eventos
      this.rechazos = copia.rechazos
      this.cuarentenas = copia.cuarentenas
      this.listaConflictos = copia.conflictos
      throw error
    }
  }

  maxSecuencia(): number {
    return this.eventos.at(-1)?.evento.secuencia ?? 0
  }

  porId(id: string) {
    return this.eventos.find((e) => e.evento.id === id)
  }

  rechazo(eventoId: string, huella: string) {
    return this.rechazos.find((r) => r.eventoId === eventoId && r.huella === huella)
  }

  conflictoDe(eventoId: string) {
    return this.listaConflictos.find((c) => c.eventoId === eventoId)
  }

  ultimaSecuenciaDe(agregados: readonly string[], excepto?: string): number {
    return this.eventos
      .filter((e) => e.agregados.some((a) => agregados.includes(a)))
      .filter((e) => e.evento.dispositivo_id !== excepto)
      .reduce((max, e) => Math.max(max, e.evento.secuencia), 0)
  }

  eventosDeAgregado(agregadoId: string): EventoPedido[] {
    return this.eventos.filter((e) => e.agregados.includes(agregadoId)).map((e) => e.evento)
  }

  cuarentenasDe(dispositivoId: string): number {
    return this.cuarentenas.filter((c) => c.dispositivoId === dispositivoId).length
  }

  aperturasDelDia(dia: string): number {
    return this.eventos.filter(
      (e) => e.evento.tipo === 'PedidoAbierto' && e.evento.dia_operativo === dia,
    ).length
  }

  eventosDesde(desde: number, limite: number): EventoPedido[] {
    return this.eventos
      .filter((e) => e.evento.secuencia > desde)
      .slice(0, limite)
      .map((e) => e.evento)
  }

  guardarEvento(evento: EventoPedido, huella: string, agregados: readonly string[]) {
    this.eventos.push({ evento, huella, agregados })
  }

  guardarRechazo(rechazo: Rechazo) {
    if (!this.rechazo(rechazo.eventoId, rechazo.huella)) this.rechazos.push(rechazo)
  }

  guardarCuarentena(cuarentena: Cuarentena) {
    if (!this.cuarentenas.some((c) => c.eventoId === cuarentena.eventoId))
      this.cuarentenas.push(cuarentena)
  }

  guardarConflicto(conflicto: Conflicto) {
    if (!this.conflictoDe(conflicto.eventoId)) this.listaConflictos.push(conflicto)
  }

  conflictos(): Conflicto[] {
    return [...this.listaConflictos]
  }
}
