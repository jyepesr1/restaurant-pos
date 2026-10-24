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
export interface Canal {
  enviar(mensaje: MensajeDispositivo): void
  cerrar(): void
}

export interface Manejadores {
  alAbrir(): void
  alMensaje(mensaje: MensajeHub): void
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

export type EstadoConexion = 'conectando' | 'conectado' | 'sin_respuesta' | 'desconectado'

export interface OpcionesGestor {
  /** Abre un canal nuevo; los manejadores se llaman cuando pasa cada cosa. */
  abrir(manejadores: Manejadores): Canal
  alConectar(canal: Canal): void
  alDesconectar(): void
  alMensaje(mensaje: MensajeHub): void
  alCambiarEstado?(estado: EstadoConexion): void
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
  private canal: Canal | null = null
  private abierto = false
  private activo = false
  private visible = true
  private intentos = 0
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

  constructor(opciones: OpcionesGestor) {
    this.o = opciones
    this.t = opciones.temporizadores ?? temporizadoresGlobales
  }

  iniciar() {
    if (this.activo) return
    this.activo = true
    this.vigilancia = this.t.setInterval(() => this.vigilar(), TIEMPOS.vigilanciaMs)
    this.conectar()
  }

  detener() {
    if (!this.activo) return
    this.activo = false
    this.t.clearInterval(this.vigilancia)
    this.t.clearTimeout(this.reintento)
    this.t.clearTimeout(this.limiteApertura)
    this.t.clearTimeout(this.comprobacion)
    this.soltar()
    this.cambiar('desconectado')
  }

  /** La pantalla se ocultó (bloqueo, otra app) o volvió. */
  cambiarVisibilidad(visible: boolean) {
    this.visible = visible
    if (!visible || !this.activo) return
    this.reintentoInmediato = true
    this.volvioEn = this.t.ahora()
    // Tras dormir, el vigilante no debe matar la conexión antes de que lleguen mensajes.
    this.ultimoMensajeEn = this.t.ahora()
    if (!this.abierto) {
      this.reconectarYa()
      return
    }
    // Parece abierto: comprobar con un ping que responda pronto.
    const canal = this.canal
    canal?.enviar({ tipo: 'ping', marca: String(this.t.ahora()) })
    const desde = this.ultimoMensajeEn
    this.t.clearTimeout(this.comprobacion)
    this.comprobacion = this.t.setTimeout(() => {
      if (this.canal === canal && this.abierto && this.ultimoMensajeEn <= desde)
        this.descartar('sin_respuesta')
    }, TIEMPOS.comprobacionAlVolverMs)
  }

  private conectar() {
    if (!this.activo) return
    this.cambiar('conectando')
    const intento = {}
    this.intento = intento
    const esEste = () => this.intento === intento
    // Si `abrir` avisa algo antes de devolver el canal, se atiende en cuanto lo devuelve.
    let enEspera: (() => void)[] | null = []
    const cuando = (trabajo: () => void) => (enEspera ? enEspera.push(trabajo) : trabajo())
    const canal = this.o.abrir({
      alAbrir: () =>
        cuando(() => {
          if (!esEste() || this.abierto) return
          this.t.clearTimeout(this.limiteApertura)
          this.abierto = true
          this.intentos = 0
          this.ultimoMensajeEn = this.t.ahora()
          this.cambiar('conectado')
          this.o.alConectar(canal)
        }),
      alMensaje: (mensaje) =>
        cuando(() => {
          if (!esEste()) return
          this.ultimoMensajeEn = this.t.ahora()
          this.o.alMensaje(mensaje)
        }),
      alCerrar: () =>
        cuando(() => {
          if (esEste()) this.alPerder('desconectado')
        }),
    })
    this.canal = canal
    this.limiteApertura = this.t.setTimeout(() => {
      if (esEste() && !this.abierto) this.descartar('desconectado')
    }, TIEMPOS.maximoAbrirMs)
    const avisos = enEspera
    enEspera = null
    for (const trabajo of avisos) trabajo()
  }

  private vigilar() {
    if (!this.visible || !this.abierto) return
    if (this.t.ahora() - this.ultimoMensajeEn >= TIEMPOS.sinRespuestaMs)
      this.descartar('sin_respuesta')
  }

  /** Abandona el canal actual sin esperar a que el navegador lo cierre y programa otro. */
  private descartar(estado: EstadoConexion) {
    this.soltar()
    this.alPerder(estado)
  }

  private alPerder(estado: EstadoConexion) {
    const estaba = this.abierto
    this.abierto = false
    this.canal = null
    this.intento = null
    this.t.clearTimeout(this.limiteApertura)
    if (estaba) this.o.alDesconectar()
    this.cambiar(estado)
    if (!this.activo) return
    const inmediato =
      this.reintentoInmediato &&
      this.visible &&
      this.t.ahora() - this.volvioEn < TIEMPOS.ventanaTrasVolverMs
    this.reintentoInmediato = false
    this.intentos += 1
    const espera = inmediato ? 0 : Math.min(1000 * this.intentos, TIEMPOS.esperaMaximaMs)
    this.t.clearTimeout(this.reintento)
    this.reintento = this.t.setTimeout(() => this.conectar(), espera)
  }

  private reconectarYa() {
    this.t.clearTimeout(this.reintento)
    this.intentos = 0
    this.reintentoInmediato = false
    this.soltar()
    this.conectar()
  }

  private soltar() {
    const canal = this.canal
    this.canal = null
    this.intento = null
    if (this.abierto) {
      this.abierto = false
      this.o.alDesconectar()
    }
    canal?.cerrar()
  }

  private cambiar(estado: EstadoConexion) {
    this.o.alCambiarEstado?.(estado)
  }
}
