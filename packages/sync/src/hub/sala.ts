import { type EstadoImpresora, MensajeDispositivo, type MensajeHub } from '../protocolo'
import type { Conexion, HubSync } from './hub'

/** Valida el token de un dispositivo (tarea 0.7). `null` si no es válido. */
export type Autenticador = (token: string) => Conexion | null

interface Participante {
  conexion: Conexion | null
  enviar: (mensaje: MensajeHub) => void
}

/**
 * Las conexiones abiertas con el hub: traduce mensajes a llamadas de `HubSync` y difunde cada
 * evento aceptado a todos los dispositivos conectados (también al que lo envió, que lo descarta
 * por id).
 */
export class SalaSync {
  private readonly hub: HubSync
  private readonly autenticar: Autenticador
  private readonly participantes = new Set<Participante>()
  /** Lo último que se supo de las impresoras: se le cuenta a cada equipo que se conecta. */
  private impresoras: EstadoImpresora[] = []

  constructor(hub: HubSync, autenticar: Autenticador) {
    this.hub = hub
    this.autenticar = autenticar
  }

  /** Abre una conexión. Devuelve cómo entregarle mensajes del dispositivo y cómo cerrarla. */
  conectar(enviar: (mensaje: MensajeHub) => void): {
    recibir: (crudo: unknown) => void
    cerrar: () => void
  } {
    const participante: Participante = { conexion: null, enviar }
    this.participantes.add(participante)
    return {
      recibir: (crudo) => this.recibir(participante, crudo),
      cerrar: () => this.participantes.delete(participante),
    }
  }

  /**
   * Se revocó un dispositivo: sus conexiones abiertas dejan de recibir el salón desde ya y se
   * le avisa. Lo que tenga pendiente todavía puede entregarlo (va a cuarentena).
   */
  revocar(dispositivoId: string, revocadoEn: string) {
    for (const p of this.participantes) {
      if (p.conexion?.dispositivoId !== dispositivoId) continue
      p.conexion = { ...p.conexion, revocadoEn }
      try {
        p.enviar({
          tipo: 'error',
          codigo: 'token_revocado',
          mensaje: 'Este equipo fue retirado del restaurante',
        })
      } catch {
        this.participantes.delete(p)
      }
    }
  }

  /** Si la mesa tiene un pedido abierto. */
  tienePedidoAbierto(mesaId: string): boolean {
    return this.hub.tienePedidoAbierto(mesaId)
  }

  /** Latido para todas las conexiones (docs/SYNC.md: cada 5 s). */
  latir() {
    for (const p of this.participantes) if (p.conexion) p.enviar({ tipo: 'latido' })
  }

  /** Se editó el catálogo: los conectados lo vuelven a pedir (docs/SYNC.md#catálogo-y-configuración). */
  avisarCatalogo(version: number) {
    for (const p of this.participantes)
      if (p.conexion && !p.conexion.revocadoEn) p.enviar({ tipo: 'catalogo', version })
  }

  /** Cambió el estado de alguna impresora de comandas (ADR-015): lo ven todos los conectados. */
  avisarImpresoras(impresoras: EstadoImpresora[]) {
    this.impresoras = impresoras
    for (const p of this.participantes)
      if (p.conexion && !p.conexion.revocadoEn)
        this.enviarSeguro(p, { tipo: 'impresoras', impresoras })
  }

  private enviarSeguro(participante: Participante, mensaje: MensajeHub) {
    try {
      participante.enviar(mensaje)
    } catch {
      this.participantes.delete(participante)
    }
  }

  private recibir(participante: Participante, crudo: unknown) {
    const lectura = MensajeDispositivo.safeParse(crudo)
    if (!lectura.success) {
      participante.enviar({
        tipo: 'error',
        codigo: 'mensaje_invalido',
        mensaje: 'Mensaje con formato inesperado',
      })
      return
    }
    const mensaje = lectura.data

    if (mensaje.tipo === 'hola') {
      const conexion = this.autenticar(mensaje.token)
      if (!conexion) {
        participante.enviar({
          tipo: 'error',
          codigo: 'token_invalido',
          mensaje: 'Este equipo no está emparejado',
        })
        return
      }
      participante.conexion = conexion
      participante.enviar(this.hub.bienvenida())
      if (this.impresoras.length > 0 && !conexion.revocadoEn)
        participante.enviar({ tipo: 'impresoras', impresoras: this.impresoras })
      return
    }
    if (mensaje.tipo === 'ping') {
      participante.enviar({ tipo: 'pong', marca: mensaje.marca })
      return
    }
    const conexion = participante.conexion
    if (!conexion) {
      participante.enviar({
        tipo: 'error',
        codigo: 'token_invalido',
        mensaje: 'Primero hay que saludar',
      })
      return
    }

    if (mensaje.tipo === 'traer') {
      // Un dispositivo revocado puede entregar lo que tenga pendiente (va a cuarentena), pero ya
      // no lee nada del salón.
      if (conexion.revocadoEn) {
        participante.enviar({
          tipo: 'error',
          codigo: 'token_revocado',
          mensaje: 'Este equipo fue retirado del restaurante',
        })
        return
      }
      participante.enviar(this.hub.traer(mensaje.desde, conexion.tipo, conexion.dispositivoId))
      return
    }

    const { resultados, aceptados } = this.hub.recibirLote(conexion, mensaje.eventos)
    participante.enviar({ tipo: 'resultado', lote_id: mensaje.lote_id, resultados })
    for (const evento of aceptados) {
      for (const otro of this.participantes) {
        const c = otro.conexion
        if (!c || c.revocadoEn || !this.hub.ve(c.tipo, evento)) continue
        try {
          otro.enviar(this.hub.nuevo(evento, c.dispositivoId))
        } catch {
          // Una conexión rota no debe dejar sin el evento a las demás; volverá a ponerse al día.
          this.participantes.delete(otro)
        }
      }
    }
  }
}
