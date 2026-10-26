import { type EstadoImpresora, MensajeDispositivo, type MensajeHub } from '../protocolo'
import type { Conexion, HubSync } from './hub'

/** Valida el token de un dispositivo (tarea 0.7). `null` si no es válido. */
export type Autenticador = (token: string) => Conexion | null

interface Participante {
  connection: Conexion | null
  send: (message: MensajeHub) => void
}

/**
 * Las conexiones abiertas con el hub: traduce mensajes a llamadas de `HubSync` y difunde cada
 * evento aceptado a todos los dispositivos conectados (también al que lo envió, que lo descarta
 * por id).
 */
export class SalaSync {
  private readonly hub: HubSync
  private readonly authenticate: Autenticador
  private readonly participantes = new Set<Participante>()
  /** Lo último que se supo de las impresoras: se le cuenta a cada equipo que se conecta. */
  private printers: EstadoImpresora[] = []

  constructor(hub: HubSync, authenticate: Autenticador) {
    this.hub = hub
    this.authenticate = authenticate
  }

  /** Abre una conexión. Devuelve cómo entregarle mensajes del dispositivo y cómo cerrarla. */
  connect(send: (message: MensajeHub) => void): {
    recibir: (crudo: unknown) => void
    close: () => void
  } {
    const participante: Participante = { connection: null, send }
    this.participantes.add(participante)
    return {
      recibir: (crudo) => this.recibir(participante, crudo),
      close: () => this.participantes.delete(participante),
    }
  }

  /**
   * Se revocó un dispositivo: sus conexiones abiertas dejan de recibir el salón desde ya y se
   * le avisa. Lo que tenga pendiente todavía puede entregarlo (va a cuarentena).
   */
  revoke(dispositivoId: string, revocadoEn: string) {
    for (const p of this.participantes) {
      if (p.connection?.dispositivoId !== dispositivoId) continue
      p.connection = { ...p.connection, revocadoEn }
      try {
        p.send({
          type: 'error',
          code: 'revoked_token',
          message: 'Este equipo fue retirado del restaurante',
        })
      } catch {
        this.participantes.delete(p)
      }
    }
  }

  /** Si la mesa tiene un pedido abierto. */
  tienePedidoAbierto(tableId: string): boolean {
    return this.hub.tienePedidoAbierto(tableId)
  }

  /** Latido para todas las conexiones (docs/SYNC.md: cada 5 s). */
  latir() {
    for (const p of this.participantes) if (p.connection) p.send({ type: 'heartbeat' })
  }

  /** Se editó el catálogo: los conectados lo vuelven a pedir (docs/SYNC.md#catálogo-y-configuración). */
  avisarCatalogo(version: number) {
    for (const p of this.participantes)
      if (p.connection && !p.connection.revocadoEn) p.send({ type: 'catalog', version })
  }

  /** Cambió el estado de alguna impresora de comandas (ADR-015): lo ven todos los conectados. */
  avisarImpresoras(printers: EstadoImpresora[]) {
    this.printers = printers
    for (const p of this.participantes)
      if (p.connection && !p.connection.revocadoEn)
        this.enviarSeguro(p, { type: 'printers', printers })
  }

  private enviarSeguro(participante: Participante, message: MensajeHub) {
    try {
      participante.send(message)
    } catch {
      this.participantes.delete(participante)
    }
  }

  private recibir(participante: Participante, crudo: unknown) {
    const lectura = MensajeDispositivo.safeParse(crudo)
    if (!lectura.success) {
      participante.send({
        type: 'error',
        code: 'invalid_message',
        message: 'Mensaje con formato inesperado',
      })
      return
    }
    const message = lectura.data

    if (message.type === 'hello') {
      const connection = this.authenticate(message.token)
      if (!connection) {
        participante.send({
          type: 'error',
          code: 'invalid_token',
          message: 'Este equipo ya no tiene acceso al restaurante: hay que entrar otra vez',
        })
        return
      }
      participante.connection = connection
      participante.send(this.hub.bienvenida())
      if (this.printers.length > 0 && !connection.revocadoEn)
        participante.send({ type: 'printers', printers: this.printers })
      return
    }
    if (message.type === 'ping') {
      participante.send({ type: 'pong', brand: message.brand })
      return
    }
    const connection = participante.connection
    if (!connection) {
      participante.send({
        type: 'error',
        code: 'invalid_token',
        message: 'Primero hay que saludar',
      })
      return
    }

    if (message.type === 'pull') {
      // Un dispositivo revocado puede entregar lo que tenga pendiente (va a cuarentena), pero ya
      // no lee nada del salón.
      if (connection.revocadoEn) {
        participante.send({
          type: 'error',
          code: 'revoked_token',
          message: 'Este equipo fue retirado del restaurante',
        })
        return
      }
      participante.send(this.hub.pull(message.from, connection.type, connection.dispositivoId))
      return
    }

    const { resultados, aceptados } = this.hub.recibirLote(connection, message.events)
    participante.send({ type: 'result', lote_id: message.lote_id, resultados })
    for (const event of aceptados) {
      for (const other of this.participantes) {
        const c = other.connection
        if (!c || c.revocadoEn || !this.hub.ve(c.type, event)) continue
        try {
          other.send(this.hub.fresh(event, c.dispositivoId))
        } catch {
          // Una conexión rota no debe dejar sin el evento a las demás; volverá a ponerse al día.
          this.participantes.delete(other)
        }
      }
    }
  }
}
