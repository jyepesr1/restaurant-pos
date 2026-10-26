import {
  type ApplicableEvent,
  type NewEvent,
  newId,
  type OrderEvent,
  type OrderState,
  rebuild,
  validateNewEvent,
} from '@pos/core'
import { pedidosDe } from '../hub/hub'
import {
  type CodigoError,
  type MensajeDispositivo,
  type MensajeHub,
  TAMANO_LOTE,
} from '../protocolo'
import { type AlmacenDispositivo, type EventoLocal, sinAceptacion } from './almacen'

export interface OpcionesCliente {
  almacen: AlmacenDispositivo
  /** Envía un mensaje al hub (por el WebSocket). Solo se llama estando conectado. */
  send: (message: MensajeDispositivo) => void
  token: string
  versionApp: string
  /** Reloj del dispositivo, en ms. */
  ahora?: () => number
  /**
   * El hub respondió con un error. Con `token_invalido` o `app_vieja` el cliente deja de enviar y
   * la app debe cerrar el canal y mostrar qué hacer; con `token_revocado` sigue entregando lo
   * pendiente (va a cuarentena) pero ya no recibe nada.
   */
  onHubError?: (code: CodigoError, message: string) => void
  /** Falló el procesamiento de un mensaje del hub (para el registro de diagnóstico). */
  onFailure?: (error: unknown) => void
  /** Algo pudo cambiar en lo guardado (un evento nuevo, uno confirmado…): la pantalla relee. */
  onChange?: () => void
}

/**
 * Lado del dispositivo de la sincronización (docs/SYNC.md#flujo-de-una-acción): guarda cada
 * evento como pendiente, lo envía en lotes (uno a la vez), aplica lo que confirma el hub y se
 * pone al día por su cursor. Los mensajes del hub se procesan en orden, uno por uno.
 *
 * Cada conexión tiene un número (`generacion`): lo que llegó por una conexión que ya se cerró se
 * descarta, y un trabajo que quedó a medias al cortarse no envía nada por la conexión nueva.
 */
export class ClienteSync {
  private readonly almacen: AlmacenDispositivo
  private readonly enviarAlHub: (message: MensajeDispositivo) => void
  private readonly token: string
  private readonly versionApp: string
  private readonly ahora: () => number
  private readonly onHubError: OpcionesCliente['onHubError']
  private readonly onFailure: OpcionesCliente['onFailure']
  private readonly onChange: OpcionesCliente['onChange']

  private connected = false
  private generacion = 0
  private loteEnVuelo: { id: string; events: string[] } | null = null
  private trayendo = false
  /** Un `nuevo` con hueco llegó mientras se traía: al terminar, traer hasta él si falta. */
  private faltaHasta = 0
  private desfaseMs = 0
  private cola: Promise<void> = Promise.resolve()
  private nextPosition = 0

  constructor(o: OpcionesCliente) {
    this.almacen = o.almacen
    this.enviarAlHub = o.send
    this.token = o.token
    this.versionApp = o.versionApp
    this.ahora = o.ahora ?? Date.now
    this.onHubError = o.onHubError
    this.onFailure = o.onFailure
    this.onChange = o.onChange
  }

  /**
   * Persistir antes de mostrar: el evento queda guardado como pendiente y se envía si se puede.
   * Registrar dos veces el mismo id no hace nada.
   */
  async record(event: NewEvent): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const validation = validateNewEvent(event)
    if (!validation.ok) return validation
    await this.enEspera(async () => {
      if (await this.almacen.obtener(validation.event.id)) return
      // Si el cursor bajó entre que se creó el evento y ahora (hub restaurado), no prometer al
      // hub más de lo que se conoce.
      const { until } = await this.almacen.cursor()
      const base_sequence = Math.min(validation.event.base_sequence, until)
      await this.almacen.guardar([
        {
          event: { ...validation.event, base_sequence },
          status: 'pending',
          own: true,
          position: await this.position(),
        },
      ])
      await this.enviarLote(this.generacion)
    })
    return { ok: true }
  }

  /** Secuencia que conoce este dispositivo: va como `base_sequence` de los eventos nuevos. */
  async conocido(): Promise<number> {
    return (await this.almacen.cursor()).until
  }

  /** Hora del hub estimada con el desfase aprendido al conectar (`hub_estimated_time`). */
  horaEstimadaHub(horaDispositivoMs = this.ahora()): string {
    return new Date(horaDispositivoMs + this.desfaseMs).toISOString()
  }

  /** Carga lo guardado (el desfase del reloj). Conviene llamarlo al abrir la app. */
  begin(): Promise<void> {
    return this.enEspera(async () => {
      this.desfaseMs = (await this.almacen.cursor()).desfaseMs ?? this.desfaseMs
    })
  }

  alConectar(): Promise<void> {
    const generacion = this.nuevaGeneracion()
    this.connected = true
    return this.enEspera(async () => {
      const cursor = await this.almacen.cursor()
      if (generacion !== this.generacion) return
      this.send({
        type: 'hello',
        token: this.token,
        hub_instancia: cursor.instancia,
        until: cursor.until,
        version_app: this.versionApp,
      })
    })
  }

  alDesconectar(): void {
    this.nuevaGeneracion()
    this.connected = false
  }

  /** Procesa un mensaje del hub, en orden con los demás. No rechaza: los fallos van a `onFailure`. */
  recibir(message: MensajeHub): Promise<void> {
    const generacion = this.generacion
    // Un latido o un pong no cambian nada guardado: la pantalla no tiene por qué releer.
    const escribe = !['heartbeat', 'pong', 'catalog', 'printers'].includes(message.type)
    return this.enEspera(async () => {
      if (generacion === this.generacion) await this.procesar(message, generacion)
    }, escribe).catch((error) => this.onFailure?.(error))
  }

  /** Estado de un pedido: confirmados por secuencia y, encima, los propios pendientes. */
  async order(id: string): Promise<OrderState | null> {
    const currentOnes = (await this.almacen.dePedido(id)).filter(
      (l) => l.status === 'confirmed' || l.status === 'pending',
    )
    return rebuild(
      currentOnes.map((l) => l.event),
      id,
    )
  }

  async pendingList(): Promise<number> {
    return (await this.almacen.ownPending()).length
  }

  async locales(): Promise<EventoLocal[]> {
    return this.almacen.listAll()
  }

  /** Espera a que se procesen los mensajes en curso. */
  async ready(): Promise<void> {
    await this.cola
  }

  // ── Internos ─────────────────────────────────────────────────────────

  /**
   * Encola un trabajo. La cola sigue aunque uno falle; el fallo le llega a quien lo encoló. Al
   * terminar avisa `onChange`, salvo que el trabajo no pueda haber cambiado nada guardado.
   */
  private enEspera(trabajo: () => Promise<void>, avisar = true): Promise<void> {
    const result = this.cola.then(trabajo).finally(() => {
      if (avisar) this.onChange?.()
    })
    this.cola = result.catch(() => {})
    return result
  }

  private nuevaGeneracion() {
    this.generacion += 1
    this.loteEnVuelo = null
    this.trayendo = false
    this.faltaHasta = 0
    return this.generacion
  }

  private async position(): Promise<number> {
    if (this.nextPosition === 0) {
      const all = await this.almacen.listAll()
      this.nextPosition = (all.at(-1)?.position ?? 0) + 1
    }
    return this.nextPosition++
  }

  private send(message: MensajeDispositivo) {
    if (this.connected) this.enviarAlHub(message)
  }

  private async procesar(m: MensajeHub, generacion: number): Promise<void> {
    switch (m.type) {
      case 'welcome': {
        const cursor = await this.almacen.cursor()
        const restaurado =
          (cursor.instancia !== null && cursor.instancia !== m.hub_instancia) ||
          cursor.until > m.secuencia_max
        if (restaurado) await this.reenviarTodo()
        const desfase = Date.parse(m.hora_hub) - this.ahora()
        if (Number.isFinite(desfase)) this.desfaseMs = desfase
        const fresh = {
          instancia: m.hub_instancia,
          until: restaurado ? 0 : cursor.until,
          desfaseMs: this.desfaseMs,
        }
        await this.almacen.guardarCursor(fresh)
        if (generacion !== this.generacion) return
        this.pull(fresh.until)
        await this.enviarLote(generacion)
        return
      }

      case 'events': {
        await this.incorporar(m.events, generacion)
        const cursor = await this.almacen.cursor()
        const until = Math.max(cursor.until, m.until)
        await this.almacen.guardarCursor({ ...cursor, until })
        if (generacion !== this.generacion) return
        this.trayendo = false
        if (m.hay_mas || this.faltaHasta > until) this.pull(until)
        return
      }

      case 'new': {
        const cursor = await this.almacen.cursor()
        if (m.until <= cursor.until) return
        if (m.hasta_anterior !== cursor.until) {
          // Hueco: falta algo entre el cursor y este evento. No avanzar; traer lo que falta.
          this.faltaHasta = Math.max(this.faltaHasta, m.until)
          this.pull(cursor.until)
          return
        }
        await this.incorporar([m.event], generacion)
        await this.almacen.guardarCursor({ ...cursor, until: m.until })
        return
      }

      case 'result': {
        if (!this.loteEnVuelo || this.loteEnVuelo.id !== m.lote_id) return
        const rechazados: string[] = []
        for (const r of m.resultados) {
          const local = await this.almacen.obtener(r.id)
          if (!local) continue
          if (r.status === 'confirmed') {
            await this.almacen.guardar([
              {
                ...local,
                status: 'confirmed',
                event: { ...local.event, ...r.aceptacion },
                conflict: r.conflict,
              },
            ])
            continue
          }
          // Lo que el hub ya confirmó (llegó por `eventos` o `nuevo`) no se deshace.
          if (local.status === 'confirmed') continue
          if (r.status === 'rejected') {
            await this.almacen.guardar([{ ...local, status: 'rejected', reason: r.reason }])
            rechazados.push(r.id)
          } else {
            await this.almacen.guardar([{ ...local, status: 'quarantine' }])
          }
        }
        if (rechazados.length > 0) await this.rechazarDependientes(rechazados)
        if (generacion !== this.generacion) return
        this.loteEnVuelo = null
        await this.enviarLote(generacion)
        return
      }

      case 'error':
        if (m.code === 'invalid_token' || m.code === 'outdated_app') this.alDesconectar()
        this.onHubError?.(m.code, m.message)
        return

      // Los atiende la app (el catálogo se pide por HTTP); aquí no cambian nada guardado.
      case 'pong':
      case 'heartbeat':
      case 'catalog':
      case 'printers':
        return
    }
  }

  /**
   * Guarda eventos confirmados del hub. La copia del hub manda: reemplaza la propia (pendiente o
   * ya confirmada, que puede diferir en `base_sequence` tras un reenvío a un hub restaurado).
   */
  private async incorporar(events: readonly OrderEvent[], generacion: number) {
    const nuevos: EventoLocal[] = []
    for (const event of events) {
      const local = await this.almacen.obtener(event.id)
      nuevos.push(
        local
          ? { ...local, event: { ...local.event, ...event }, status: 'confirmed' }
          : { event, status: 'confirmed', own: false, position: await this.position() },
      )
    }
    await this.almacen.guardar(nuevos)
    // Si se perdió la respuesta del lote pero sus eventos ya volvieron confirmados, seguir.
    const batch = this.loteEnVuelo
    if (batch && generacion === this.generacion) {
      const enVuelo = await Promise.all(batch.events.map((id) => this.almacen.obtener(id)))
      if (this.loteEnVuelo === batch && enVuelo.every((l) => l?.status === 'confirmed')) {
        this.loteEnVuelo = null
        await this.enviarLote(generacion)
      }
    }
  }

  /**
   * Un rechazo arrastra a los pendientes propios que tocan los mismos pedidos: dependen de él
   * (docs/SYNC.md#rechazos-cuarentena-y-conflictos).
   */
  private async rechazarDependientes(rechazados: readonly string[]) {
    const all = await this.almacen.listAll()
    const afectados = new Set(
      all.filter((l) => rechazados.includes(l.event.id)).flatMap((l) => pedidosDe(l.event)),
    )
    const dependientes = all.filter(
      (l) => l.own && l.status === 'pending' && pedidosDe(l.event).some((p) => afectados.has(p)),
    )
    await this.almacen.guardar(
      dependientes.map((l) => ({
        ...l,
        status: 'rejected' as const,
        reason: 'depends_on_rejected',
      })),
    )
  }

  /**
   * El hub se restauró de un respaldo o se reinstaló: se reenvían todos los eventos propios y se
   * olvida lo ajeno, que volverá con el cursor en 0. El hub restaurado no conoce lo que había,
   * así que el dispositivo no estaba "al día": `base_sequence` baja a 0. La huella del hub no
   * la incluye, así que lo que el respaldo ya tenía se reconoce como el mismo evento.
   */
  private async reenviarTodo() {
    const all = await this.almacen.listAll()
    await this.almacen.erase(all.filter((l) => !l.own).map((l) => l.event.id))
    await this.almacen.guardar(
      all
        .filter((l) => l.own && (l.status === 'confirmed' || l.status === 'pending'))
        .map((l) => ({
          ...l,
          status: 'pending' as const,
          event: { ...sinAceptacion(l.event), base_sequence: 0 },
        })),
    )
  }

  private pull(from: number) {
    if (this.trayendo) return
    this.trayendo = true
    this.send({ type: 'pull', from })
  }

  private async enviarLote(generacion: number) {
    if (!this.connected || this.loteEnVuelo || generacion !== this.generacion) return
    const pendingList = await this.almacen.ownPending(TAMANO_LOTE)
    // Mientras se leía pudo cortarse la conexión, o salir otro lote.
    if (!this.connected || this.loteEnVuelo || generacion !== this.generacion) return
    if (pendingList.length === 0) return
    this.loteEnVuelo = { id: newId(), events: pendingList.map((l) => l.event.id) }
    this.send({
      type: 'push',
      lote_id: this.loteEnVuelo.id,
      events: pendingList.map((l) => sinAceptacion(l.event as ApplicableEvent)),
    })
  }
}
