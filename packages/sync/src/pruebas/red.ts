import { type NewEvent, newId, type OrderEventType } from '@pos/core'
import { AlmacenDispositivoMemoria } from '../dispositivo/almacen'
import { ClienteSync } from '../dispositivo/cliente'
import type { Conexion } from '../hub/hub'
import type { SalaSync } from '../hub/sala'
import type { MensajeDispositivo, MensajeHub } from '../protocolo'

// Red simulada para los escenarios de docs/SYNC.md: varios dispositivos y un hub en memoria,
// con mensajes que se pueden cortar, perder o duplicar, y un hub que se puede caer y volver.

type Regla = {
  direction: 'to_hub' | 'to_device'
  type: string
  action: 'drop' | 'duplicate'
  veces: number
}

/** Copia como si viajara por la red: solo lo que sobrevive a JSON. */
const porLaRed = <T>(m: T): T => JSON.parse(JSON.stringify(m))

export class Nodo {
  readonly name: string
  readonly dispositivoId: string
  readonly userId = newId()
  readonly cliente: ClienteSync
  readonly almacen: AlmacenDispositivoMemoria
  /** Desfase del reloj del dispositivo, en ms. */
  desfaseMs = 0
  aHub: MensajeDispositivo[] = []
  aDispositivo: MensajeHub[] = []
  enlace: { recibir: (crudo: unknown) => void; close: () => void } | null = null
  reglas: Regla[] = []
  private readonly network: RedSimulada

  constructor(
    network: RedSimulada,
    name: string,
    token: string,
    almacen = new AlmacenDispositivoMemoria(),
  ) {
    this.network = network
    this.name = name
    this.dispositivoId = network.tokens.get(token)?.dispositivoId ?? newId()
    this.almacen = almacen
    this.cliente = new ClienteSync({
      almacen,
      token,
      versionApp: 'pruebas',
      ahora: () => this.network.ahora() + this.desfaseMs,
      send: (m) => {
        if (this.enlace) this.aHub.push(porLaRed(m))
      },
    })
  }

  get enLinea() {
    return this.enlace !== null
  }

  async connect() {
    this.enlace = this.network.sala.connect((m) => this.aDispositivo.push(porLaRed(m)))
    await this.cliente.alConectar()
  }

  disconnect() {
    this.enlace?.close()
    this.enlace = null
    this.aHub = []
    this.aDispositivo = []
    this.cliente.alDesconectar()
  }

  /** Crea y registra un evento como lo haría la app del dispositivo. */
  async crear<T extends OrderEventType>(
    orderId: string,
    type: T,
    data: Extract<NewEvent, { type: T }>['data'],
    extras: Partial<NewEvent> = {},
  ): Promise<NewEvent> {
    const time = new Date(this.network.ahora() + this.desfaseMs).toISOString()
    const estimada = this.cliente.horaEstimadaHub()
    const event = {
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: orderId,
      related: [],
      data,
      session_id: null,
      user_id: this.userId,
      device_id: this.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: time,
      hub_estimated_time: estimada,
      base_sequence: await this.cliente.conocido(),
      ...extras,
    } as NewEvent
    const r = await this.cliente.record(event)
    if (!r.ok) throw new Error(`Evento inválido en la prueba: ${r.errors.join('; ')}`)
    return event
  }

  /** La próxima vez que pase un mensaje de ese tipo, se pierde o se duplica. */
  rule(direction: Regla['direction'], type: string, action: Regla['action'], veces = 1) {
    this.reglas.push({ direction, type, action, veces })
  }

  /** Aplica las reglas a un mensaje: cuántas copias se entregan (0, 1 o 2). */
  copias(direction: Regla['direction'], type: string): number {
    const rule = this.reglas.find(
      (r) => r.direction === direction && r.type === type && r.veces > 0,
    )
    if (!rule) return 1
    rule.veces -= 1
    return rule.action === 'drop' ? 0 : 2
  }
}

export class RedSimulada {
  sala: SalaSync
  readonly nodos: Nodo[] = []
  readonly tokens = new Map<string, Conexion>()
  private clock = Date.parse('2026-10-24T20:00:00.000Z')
  /** Se llama si el hub lanza al procesar un mensaje: simula que el proceso del hub se cayó. */
  alCaerHub: (() => SalaSync) | null = null

  constructor(sala: SalaSync) {
    this.sala = sala
  }

  ahora = () => this.clock
  horaIso = () => new Date(this.clock).toISOString()
  advance(ms: number) {
    this.clock += ms
  }

  /** Autenticador para el hub de las pruebas. */
  authenticate = (token: string): Conexion | null => this.tokens.get(token) ?? null

  device(name: string, almacen?: AlmacenDispositivoMemoria): Nodo {
    const token = `token-${name}`
    if (!this.tokens.has(token))
      this.tokens.set(token, { dispositivoId: newId(), type: 'waiter', revocadoEn: null })
    const node = new Nodo(this, name, token, almacen)
    this.nodos.push(node)
    return node
  }

  /** Entrega un mensaje al hub (con las reglas de pérdida y duplicado). Si el hub lanza, se cae. */
  private entregarAlHub(node: Nodo, m: MensajeDispositivo) {
    for (let i = 0; i < node.copias('to_hub', m.type); i++) {
      try {
        node.enlace?.recibir(m)
      } catch {
        this.crashHub()
        return
      }
    }
  }

  private async entregarAlDispositivo(node: Nodo, m: MensajeHub) {
    for (let i = 0; i < node.copias('to_device', m.type); i++) await node.cliente.recibir(m)
  }

  /**
   * Entrega un solo mensaje en vuelo (el primero, o el de la posición `indice`, lo que permite
   * reordenar). Devuelve `false` si no había ninguno.
   */
  async entregarUno(node: Nodo, direction: Regla['direction'], indice = 0): Promise<boolean> {
    if (direction === 'to_hub') {
      if (!node.enlace || node.aHub.length === 0) return false
      const [m] = node.aHub.splice(indice % node.aHub.length, 1)
      this.entregarAlHub(node, m as MensajeDispositivo)
      return true
    }
    if (node.aDispositivo.length === 0) return false
    const [m] = node.aDispositivo.splice(indice % node.aDispositivo.length, 1)
    await this.entregarAlDispositivo(node, m as MensajeHub)
    return true
  }

  /** Entrega mensajes en ambos sentidos hasta que no quede ninguno en vuelo. */
  async settle(maxRondas = 1000) {
    for (let ronda = 0; ronda < maxRondas; ronda++) {
      let hubo = false
      for (const node of this.nodos) {
        while (node.aHub.length > 0 && node.enlace) {
          hubo = true
          this.entregarAlHub(node, node.aHub.shift() as MensajeDispositivo)
        }
        while (node.aDispositivo.length > 0) {
          hubo = true
          await this.entregarAlDispositivo(node, node.aDispositivo.shift() as MensajeHub)
        }
      }
      await Promise.all(this.nodos.map((n) => n.cliente.ready()))
      if (!hubo) return
    }
    throw new Error('La red no se estabilizó')
  }

  /** El proceso del hub se cae: todas las conexiones se cortan y vuelve con lo que guardó. */
  crashHub() {
    for (const node of this.nodos) node.disconnect()
    if (!this.alCaerHub) throw new Error('El hub se cayó y la prueba no dijo cómo levantarlo')
    this.sala = this.alCaerHub()
  }

  async conectarTodos() {
    for (const node of this.nodos) if (!node.enLinea) await node.connect()
    await this.settle()
  }
}
