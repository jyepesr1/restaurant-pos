import type { MensajeDispositivo, MensajeHub } from '../protocolo'

/** Tiempos de docs/SYNC.md#conexión-aprendido-en-celulares-reales, medidos en ADR-001. */
export const TIEMPOS = {
  maximoAbrirMs: 4000,
  comprobacionAlVolverMs: 3000,
  sinRespuestaMs: 15_000,
  vigilanciaMs: 1000,
  esperaMaximaMs: 5000,
  /** El primer cierre en este rato tras volver a la pantalla se reintenta de inmediato. */
  ventanaTrasVolverMs: 5000,
}

/** Un canal abierto con el hub (un WebSocket en el navegador). */
export interface Channel {
  send(message: MensajeDispositivo): void
  close(): void
}

export interface Manejadores {
  alAbrir(): void
  alMensaje(message: MensajeHub): void
  alCerrar(): void
}

export interface Temporizadores {
  ahora(): number
  setTimeout(trabajo: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  setInterval(trabajo: () => void, ms: number): unknown
  clearInterval(id: unknown): void
}

const temporizadoresGlobales: Temporizadores = {
  ahora: () => Date.now(),
  setTimeout: (t, ms) => setTimeout(t, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (t, ms) => setInterval(t, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
}

export type EstadoConexion = 'connecting' | 'connected' | 'no_response' | 'disconnected'

export interface OpcionesGestor {
  /** Abre un canal nuevo; los manejadores se llaman cuando pasa cada cosa. */
  open(manejadores: Manejadores): Channel
  alConectar(channel: Channel): void
  alDesconectar(): void
  alMensaje(message: MensajeHub): void
  alCambiarEstado?(status: EstadoConexion): void
  temporizadores?: Temporizadores
}

/**
 * Mantiene el canal con el hub: reconecta solo, abandona intentos colgados, descarta canales
 * mudos y, al volver a la pantalla, se pone al día de inmediato (docs/SYNC.md). La pantalla
 * se bloquea seguido y la conexión se pierde siempre (ADR-001): esto es lo normal, no un error.
 */
export class GestorConexion {
  private readonly o: OpcionesGestor
  private readonly t: Temporizadores
  private channel: Channel | null = null
  private opened = false
  private active = false
  private visible = true
  private attempts = 0
  private ultimoMensajeEn = 0
  /** Al volver a la pantalla, el primer reintento sale sin esperar; los siguientes, no. */
  private reintentoInmediato = false
  private volvioEn = 0
  /** Identifica el intento en curso: un canal viejo que avisa tarde se ignora. */
  private intento: object | null = null
  private reintento: unknown = null
  private limiteApertura: unknown = null
  private comprobacion: unknown = null
  private vigilancia: unknown = null

  constructor(options: OpcionesGestor) {
    this.o = options
    this.t = options.temporizadores ?? temporizadoresGlobales
  }

  begin() {
    if (this.active) return
    this.active = true
    this.vigilancia = this.t.setInterval(() => this.vigilar(), TIEMPOS.vigilanciaMs)
    this.connect()
  }

  detener() {
    if (!this.active) return
    this.active = false
    this.t.clearInterval(this.vigilancia)
    this.t.clearTimeout(this.reintento)
    this.t.clearTimeout(this.limiteApertura)
    this.t.clearTimeout(this.comprobacion)
    this.soltar()
    this.patch('disconnected')
  }

  /** La pantalla se ocultó (bloqueo, otra app) o volvió. */
  cambiarVisibilidad(visible: boolean) {
    this.visible = visible
    if (!visible || !this.active) return
    this.reintentoInmediato = true
    this.volvioEn = this.t.ahora()
    // Tras dormir, el vigilante no debe matar la conexión antes de que lleguen mensajes.
    this.ultimoMensajeEn = this.t.ahora()
    if (!this.opened) {
      this.reconectarYa()
      return
    }
    // Parece abierto: comprobar con un ping que responda pronto.
    const channel = this.channel
    channel?.send({ type: 'ping', brand: String(this.t.ahora()) })
    const from = this.ultimoMensajeEn
    this.t.clearTimeout(this.comprobacion)
    this.comprobacion = this.t.setTimeout(() => {
      if (this.channel === channel && this.opened && this.ultimoMensajeEn <= from)
        this.descartar('no_response')
    }, TIEMPOS.comprobacionAlVolverMs)
  }

  private connect() {
    if (!this.active) return
    this.patch('connecting')
    const intento = {}
    this.intento = intento
    const esEste = () => this.intento === intento
    // Si `abrir` avisa algo antes de devolver el canal, se atiende en cuanto lo devuelve.
    let enEspera: (() => void)[] | null = []
    const cuando = (trabajo: () => void) => (enEspera ? enEspera.push(trabajo) : trabajo())
    const channel = this.o.open({
      alAbrir: () =>
        cuando(() => {
          if (!esEste() || this.opened) return
          this.t.clearTimeout(this.limiteApertura)
          this.opened = true
          this.attempts = 0
          this.ultimoMensajeEn = this.t.ahora()
          this.patch('connected')
          this.o.alConectar(channel)
        }),
      alMensaje: (message) =>
        cuando(() => {
          if (!esEste()) return
          this.ultimoMensajeEn = this.t.ahora()
          this.o.alMensaje(message)
        }),
      alCerrar: () =>
        cuando(() => {
          if (esEste()) this.alPerder('disconnected')
        }),
    })
    this.channel = channel
    this.limiteApertura = this.t.setTimeout(() => {
      if (esEste() && !this.opened) this.descartar('disconnected')
    }, TIEMPOS.maximoAbrirMs)
    const avisos = enEspera
    enEspera = null
    for (const trabajo of avisos) trabajo()
  }

  private vigilar() {
    if (!this.visible || !this.opened) return
    if (this.t.ahora() - this.ultimoMensajeEn >= TIEMPOS.sinRespuestaMs)
      this.descartar('no_response')
  }

  /** Abandona el canal actual sin esperar a que el navegador lo cierre y programa otro. */
  private descartar(status: EstadoConexion) {
    this.soltar()
    this.alPerder(status)
  }

  private alPerder(status: EstadoConexion) {
    const estaba = this.opened
    this.opened = false
    this.channel = null
    this.intento = null
    this.t.clearTimeout(this.limiteApertura)
    if (estaba) this.o.alDesconectar()
    this.patch(status)
    if (!this.active) return
    const inmediato =
      this.reintentoInmediato &&
      this.visible &&
      this.t.ahora() - this.volvioEn < TIEMPOS.ventanaTrasVolverMs
    this.reintentoInmediato = false
    this.attempts += 1
    const delay = inmediato ? 0 : Math.min(1000 * this.attempts, TIEMPOS.esperaMaximaMs)
    this.t.clearTimeout(this.reintento)
    this.reintento = this.t.setTimeout(() => this.connect(), delay)
  }

  private reconectarYa() {
    this.t.clearTimeout(this.reintento)
    this.attempts = 0
    this.reintentoInmediato = false
    this.soltar()
    this.connect()
  }

  private soltar() {
    const channel = this.channel
    this.channel = null
    this.intento = null
    if (this.opened) {
      this.opened = false
      this.o.alDesconectar()
    }
    channel?.close()
  }

  private patch(status: EstadoConexion) {
    this.o.alCambiarEstado?.(status)
  }
}
