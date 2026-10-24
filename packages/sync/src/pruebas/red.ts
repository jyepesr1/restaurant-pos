import { type EventoNuevo, nuevoId, type TipoEventoPedido } from '@pos/core'
import { AlmacenDispositivoMemoria } from '../dispositivo/almacen'
import { ClienteSync } from '../dispositivo/cliente'
import type { Conexion } from '../hub/hub'
import type { SalaSync } from '../hub/sala'
import type { MensajeDispositivo, MensajeHub } from '../protocolo'

// Red simulada para los escenarios de docs/SYNC.md: varios dispositivos y un hub en memoria,
// con mensajes que se pueden cortar, perder o duplicar, y un hub que se puede caer y volver.

type Regla = {
  direccion: 'al_hub' | 'al_dispositivo'
  tipo: string
  accion: 'perder' | 'duplicar'
  veces: number
}

/** Copia como si viajara por la red: solo lo que sobrevive a JSON. */
const porLaRed = <T>(m: T): T => JSON.parse(JSON.stringify(m))

export class Nodo {
  readonly nombre: string
  readonly dispositivoId: string
  readonly usuarioId = nuevoId()
  readonly cliente: ClienteSync
  readonly almacen: AlmacenDispositivoMemoria
  /** Desfase del reloj del dispositivo, en ms. */
  desfaseMs = 0
  aHub: MensajeDispositivo[] = []
  aDispositivo: MensajeHub[] = []
  enlace: { recibir: (crudo: unknown) => void; cerrar: () => void } | null = null
  reglas: Regla[] = []
  private readonly red: RedSimulada

  constructor(
    red: RedSimulada,
    nombre: string,
    token: string,
    almacen = new AlmacenDispositivoMemoria(),
  ) {
    this.red = red
    this.nombre = nombre
    this.dispositivoId = red.tokens.get(token)?.dispositivoId ?? nuevoId()
    this.almacen = almacen
    this.cliente = new ClienteSync({
      almacen,
      token,
      versionApp: 'pruebas',
      ahora: () => this.red.ahora() + this.desfaseMs,
      enviar: (m) => {
        if (this.enlace) this.aHub.push(porLaRed(m))
      },
    })
  }

  get enLinea() {
    return this.enlace !== null
  }

  async conectar() {
    this.enlace = this.red.sala.conectar((m) => this.aDispositivo.push(porLaRed(m)))
    await this.cliente.alConectar()
  }

  desconectar() {
    this.enlace?.cerrar()
    this.enlace = null
    this.aHub = []
    this.aDispositivo = []
    this.cliente.alDesconectar()
  }

  /** Crea y registra un evento como lo haría la app del dispositivo. */
  async crear<T extends TipoEventoPedido>(
    pedidoId: string,
    tipo: T,
    datos: Extract<EventoNuevo, { tipo: T }>['datos'],
    extras: Partial<EventoNuevo> = {},
  ): Promise<EventoNuevo> {
    const hora = new Date(this.red.ahora() + this.desfaseMs).toISOString()
    const estimada = this.cliente.horaEstimadaHub()
    const evento = {
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: pedidoId,
      relacionados: [],
      datos,
      sesion_id: null,
      usuario_id: this.usuarioId,
      dispositivo_id: this.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: hora,
      hora_estimada_hub: estimada,
      secuencia_base: await this.cliente.conocido(),
      ...extras,
    } as EventoNuevo
    const r = await this.cliente.registrar(evento)
    if (!r.ok) throw new Error(`Evento inválido en la prueba: ${r.errores.join('; ')}`)
    return evento
  }

  /** La próxima vez que pase un mensaje de ese tipo, se pierde o se duplica. */
  regla(direccion: Regla['direccion'], tipo: string, accion: Regla['accion'], veces = 1) {
    this.reglas.push({ direccion, tipo, accion, veces })
  }

  /** Aplica las reglas a un mensaje: cuántas copias se entregan (0, 1 o 2). */
  copias(direccion: Regla['direccion'], tipo: string): number {
    const regla = this.reglas.find(
      (r) => r.direccion === direccion && r.tipo === tipo && r.veces > 0,
    )
    if (!regla) return 1
    regla.veces -= 1
    return regla.accion === 'perder' ? 0 : 2
  }
}

export class RedSimulada {
  sala: SalaSync
  readonly nodos: Nodo[] = []
  readonly tokens = new Map<string, Conexion>()
  private reloj = Date.parse('2026-10-24T20:00:00.000Z')
  /** Se llama si el hub lanza al procesar un mensaje: simula que el proceso del hub se cayó. */
  alCaerHub: (() => SalaSync) | null = null

  constructor(sala: SalaSync) {
    this.sala = sala
  }

  ahora = () => this.reloj
  horaIso = () => new Date(this.reloj).toISOString()
  avanzar(ms: number) {
    this.reloj += ms
  }

  /** Autenticador para el hub de las pruebas. */
  autenticar = (token: string): Conexion | null => this.tokens.get(token) ?? null

  dispositivo(nombre: string, almacen?: AlmacenDispositivoMemoria): Nodo {
    const token = `token-${nombre}`
    if (!this.tokens.has(token))
      this.tokens.set(token, { dispositivoId: nuevoId(), tipo: 'mesero', revocadoEn: null })
    const nodo = new Nodo(this, nombre, token, almacen)
    this.nodos.push(nodo)
    return nodo
  }

  /** Entrega un mensaje al hub (con las reglas de pérdida y duplicado). Si el hub lanza, se cae. */
  private entregarAlHub(nodo: Nodo, m: MensajeDispositivo) {
    for (let i = 0; i < nodo.copias('al_hub', m.tipo); i++) {
      try {
        nodo.enlace?.recibir(m)
      } catch {
        this.caerHub()
        return
      }
    }
  }

  private async entregarAlDispositivo(nodo: Nodo, m: MensajeHub) {
    for (let i = 0; i < nodo.copias('al_dispositivo', m.tipo); i++) await nodo.cliente.recibir(m)
  }

  /**
   * Entrega un solo mensaje en vuelo (el primero, o el de la posición `indice`, lo que permite
   * reordenar). Devuelve `false` si no había ninguno.
   */
  async entregarUno(nodo: Nodo, direccion: Regla['direccion'], indice = 0): Promise<boolean> {
    if (direccion === 'al_hub') {
      if (!nodo.enlace || nodo.aHub.length === 0) return false
      const [m] = nodo.aHub.splice(indice % nodo.aHub.length, 1)
      this.entregarAlHub(nodo, m as MensajeDispositivo)
      return true
    }
    if (nodo.aDispositivo.length === 0) return false
    const [m] = nodo.aDispositivo.splice(indice % nodo.aDispositivo.length, 1)
    await this.entregarAlDispositivo(nodo, m as MensajeHub)
    return true
  }

  /** Entrega mensajes en ambos sentidos hasta que no quede ninguno en vuelo. */
  async estabilizar(maxRondas = 1000) {
    for (let ronda = 0; ronda < maxRondas; ronda++) {
      let hubo = false
      for (const nodo of this.nodos) {
        while (nodo.aHub.length > 0 && nodo.enlace) {
          hubo = true
          this.entregarAlHub(nodo, nodo.aHub.shift() as MensajeDispositivo)
        }
        while (nodo.aDispositivo.length > 0) {
          hubo = true
          await this.entregarAlDispositivo(nodo, nodo.aDispositivo.shift() as MensajeHub)
        }
      }
      await Promise.all(this.nodos.map((n) => n.cliente.listo()))
      if (!hubo) return
    }
    throw new Error('La red no se estabilizó')
  }

  /** El proceso del hub se cae: todas las conexiones se cortan y vuelve con lo que guardó. */
  caerHub() {
    for (const nodo of this.nodos) nodo.desconectar()
    if (!this.alCaerHub) throw new Error('El hub se cayó y la prueba no dijo cómo levantarlo')
    this.sala = this.alCaerHub()
  }

  async conectarTodos() {
    for (const nodo of this.nodos) if (!nodo.enLinea) await nodo.conectar()
    await this.estabilizar()
  }
}
