import {
  type EstadoPedido,
  type EventoAplicable,
  type EventoNuevo,
  type EventoPedido,
  nuevoId,
  reconstruir,
  validarEventoNuevo,
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
  enviar: (mensaje: MensajeDispositivo) => void
  token: string
  versionApp: string
  /** Reloj del dispositivo, en ms. */
  ahora?: () => number
  /**
   * El hub respondió con un error. Con `token_invalido` o `app_vieja` el cliente deja de enviar y
   * la app debe cerrar el canal y mostrar qué hacer; con `token_revocado` sigue entregando lo
   * pendiente (va a cuarentena) pero ya no recibe nada.
   */
  alErrorHub?: (codigo: CodigoError, mensaje: string) => void
  /** Falló el procesamiento de un mensaje del hub (para el registro de diagnóstico). */
  alFallo?: (error: unknown) => void
  /** Algo pudo cambiar en lo guardado (un evento nuevo, uno confirmado…): la pantalla relee. */
  alCambiar?: () => void
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
  private readonly enviarAlHub: (mensaje: MensajeDispositivo) => void
  private readonly token: string
  private readonly versionApp: string
  private readonly ahora: () => number
  private readonly alErrorHub: OpcionesCliente['alErrorHub']
  private readonly alFallo: OpcionesCliente['alFallo']
  private readonly alCambiar: OpcionesCliente['alCambiar']

  private conectado = false
  private generacion = 0
  private loteEnVuelo: { id: string; eventos: string[] } | null = null
  private trayendo = false
  /** Un `nuevo` con hueco llegó mientras se traía: al terminar, traer hasta él si falta. */
  private faltaHasta = 0
  private desfaseMs = 0
  private cola: Promise<void> = Promise.resolve()
  private siguienteOrden = 0

  constructor(o: OpcionesCliente) {
    this.almacen = o.almacen
    this.enviarAlHub = o.enviar
    this.token = o.token
    this.versionApp = o.versionApp
    this.ahora = o.ahora ?? Date.now
    this.alErrorHub = o.alErrorHub
    this.alFallo = o.alFallo
    this.alCambiar = o.alCambiar
  }

  /**
   * Persistir antes de mostrar: el evento queda guardado como pendiente y se envía si se puede.
   * Registrar dos veces el mismo id no hace nada.
   */
  async registrar(evento: EventoNuevo): Promise<{ ok: true } | { ok: false; errores: string[] }> {
    const validacion = validarEventoNuevo(evento)
    if (!validacion.ok) return validacion
    await this.enEspera(async () => {
      if (await this.almacen.obtener(validacion.evento.id)) return
      // Si el cursor bajó entre que se creó el evento y ahora (hub restaurado), no prometer al
      // hub más de lo que se conoce.
      const { hasta } = await this.almacen.cursor()
      const secuencia_base = Math.min(validacion.evento.secuencia_base, hasta)
      await this.almacen.guardar([
        {
          evento: { ...validacion.evento, secuencia_base },
          estado: 'pendiente',
          propio: true,
          orden: await this.orden(),
        },
      ])
      await this.enviarLote(this.generacion)
    })
    return { ok: true }
  }

  /** Secuencia que conoce este dispositivo: va como `secuencia_base` de los eventos nuevos. */
  async conocido(): Promise<number> {
    return (await this.almacen.cursor()).hasta
  }

  /** Hora del hub estimada con el desfase aprendido al conectar (`hora_estimada_hub`). */
  horaEstimadaHub(horaDispositivoMs = this.ahora()): string {
    return new Date(horaDispositivoMs + this.desfaseMs).toISOString()
  }

  /** Carga lo guardado (el desfase del reloj). Conviene llamarlo al abrir la app. */
  iniciar(): Promise<void> {
    return this.enEspera(async () => {
      this.desfaseMs = (await this.almacen.cursor()).desfaseMs ?? this.desfaseMs
    })
  }

  alConectar(): Promise<void> {
    const generacion = this.nuevaGeneracion()
    this.conectado = true
    return this.enEspera(async () => {
      const cursor = await this.almacen.cursor()
      if (generacion !== this.generacion) return
      this.enviar({
        tipo: 'hola',
        token: this.token,
        hub_instancia: cursor.instancia,
        hasta: cursor.hasta,
        version_app: this.versionApp,
      })
    })
  }

  alDesconectar(): void {
    this.nuevaGeneracion()
    this.conectado = false
  }

  /** Procesa un mensaje del hub, en orden con los demás. No rechaza: los fallos van a `alFallo`. */
  recibir(mensaje: MensajeHub): Promise<void> {
    const generacion = this.generacion
    // Un latido o un pong no cambian nada guardado: la pantalla no tiene por qué releer.
    const escribe = mensaje.tipo !== 'latido' && mensaje.tipo !== 'pong'
    return this.enEspera(async () => {
      if (generacion === this.generacion) await this.procesar(mensaje, generacion)
    }, escribe).catch((error) => this.alFallo?.(error))
  }

  /** Estado de un pedido: confirmados por secuencia y, encima, los propios pendientes. */
  async pedido(id: string): Promise<EstadoPedido | null> {
    const vigentes = (await this.almacen.dePedido(id)).filter(
      (l) => l.estado === 'confirmado' || l.estado === 'pendiente',
    )
    return reconstruir(
      vigentes.map((l) => l.evento),
      id,
    )
  }

  async pendientes(): Promise<number> {
    return (await this.almacen.pendientesPropios()).length
  }

  async locales(): Promise<EventoLocal[]> {
    return this.almacen.listar()
  }

  /** Espera a que se procesen los mensajes en curso. */
  async listo(): Promise<void> {
    await this.cola
  }

  // ── Internos ─────────────────────────────────────────────────────────

  /**
   * Encola un trabajo. La cola sigue aunque uno falle; el fallo le llega a quien lo encoló. Al
   * terminar avisa `alCambiar`, salvo que el trabajo no pueda haber cambiado nada guardado.
   */
  private enEspera(trabajo: () => Promise<void>, avisar = true): Promise<void> {
    const resultado = this.cola.then(trabajo).finally(() => {
      if (avisar) this.alCambiar?.()
    })
    this.cola = resultado.catch(() => {})
    return resultado
  }

  private nuevaGeneracion() {
    this.generacion += 1
    this.loteEnVuelo = null
    this.trayendo = false
    this.faltaHasta = 0
    return this.generacion
  }

  private async orden(): Promise<number> {
    if (this.siguienteOrden === 0) {
      const todos = await this.almacen.listar()
      this.siguienteOrden = (todos.at(-1)?.orden ?? 0) + 1
    }
    return this.siguienteOrden++
  }

  private enviar(mensaje: MensajeDispositivo) {
    if (this.conectado) this.enviarAlHub(mensaje)
  }

  private async procesar(m: MensajeHub, generacion: number): Promise<void> {
    switch (m.tipo) {
      case 'bienvenido': {
        const cursor = await this.almacen.cursor()
        const restaurado =
          (cursor.instancia !== null && cursor.instancia !== m.hub_instancia) ||
          cursor.hasta > m.secuencia_max
        if (restaurado) await this.reenviarTodo()
        const desfase = Date.parse(m.hora_hub) - this.ahora()
        if (Number.isFinite(desfase)) this.desfaseMs = desfase
        const nuevo = {
          instancia: m.hub_instancia,
          hasta: restaurado ? 0 : cursor.hasta,
          desfaseMs: this.desfaseMs,
        }
        await this.almacen.guardarCursor(nuevo)
        if (generacion !== this.generacion) return
        this.traer(nuevo.hasta)
        await this.enviarLote(generacion)
        return
      }

      case 'eventos': {
        await this.incorporar(m.eventos, generacion)
        const cursor = await this.almacen.cursor()
        const hasta = Math.max(cursor.hasta, m.hasta)
        await this.almacen.guardarCursor({ ...cursor, hasta })
        if (generacion !== this.generacion) return
        this.trayendo = false
        if (m.hay_mas || this.faltaHasta > hasta) this.traer(hasta)
        return
      }

      case 'nuevo': {
        const cursor = await this.almacen.cursor()
        if (m.hasta <= cursor.hasta) return
        if (m.hasta_anterior !== cursor.hasta) {
          // Hueco: falta algo entre el cursor y este evento. No avanzar; traer lo que falta.
          this.faltaHasta = Math.max(this.faltaHasta, m.hasta)
          this.traer(cursor.hasta)
          return
        }
        await this.incorporar([m.evento], generacion)
        await this.almacen.guardarCursor({ ...cursor, hasta: m.hasta })
        return
      }

      case 'resultado': {
        if (!this.loteEnVuelo || this.loteEnVuelo.id !== m.lote_id) return
        const rechazados: string[] = []
        for (const r of m.resultados) {
          const local = await this.almacen.obtener(r.id)
          if (!local) continue
          if (r.estado === 'confirmado') {
            await this.almacen.guardar([
              {
                ...local,
                estado: 'confirmado',
                evento: { ...local.evento, ...r.aceptacion },
                conflicto: r.conflicto,
              },
            ])
            continue
          }
          // Lo que el hub ya confirmó (llegó por `eventos` o `nuevo`) no se deshace.
          if (local.estado === 'confirmado') continue
          if (r.estado === 'rechazado') {
            await this.almacen.guardar([{ ...local, estado: 'rechazado', motivo: r.motivo }])
            rechazados.push(r.id)
          } else {
            await this.almacen.guardar([{ ...local, estado: 'cuarentena' }])
          }
        }
        if (rechazados.length > 0) await this.rechazarDependientes(rechazados)
        if (generacion !== this.generacion) return
        this.loteEnVuelo = null
        await this.enviarLote(generacion)
        return
      }

      case 'error':
        if (m.codigo === 'token_invalido' || m.codigo === 'app_vieja') this.alDesconectar()
        this.alErrorHub?.(m.codigo, m.mensaje)
        return

      case 'pong':
      case 'latido':
        return
    }
  }

  /**
   * Guarda eventos confirmados del hub. La copia del hub manda: reemplaza la propia (pendiente o
   * ya confirmada, que puede diferir en `secuencia_base` tras un reenvío a un hub restaurado).
   */
  private async incorporar(eventos: readonly EventoPedido[], generacion: number) {
    const nuevos: EventoLocal[] = []
    for (const evento of eventos) {
      const local = await this.almacen.obtener(evento.id)
      nuevos.push(
        local
          ? { ...local, evento: { ...local.evento, ...evento }, estado: 'confirmado' }
          : { evento, estado: 'confirmado', propio: false, orden: await this.orden() },
      )
    }
    await this.almacen.guardar(nuevos)
    // Si se perdió la respuesta del lote pero sus eventos ya volvieron confirmados, seguir.
    const lote = this.loteEnVuelo
    if (lote && generacion === this.generacion) {
      const enVuelo = await Promise.all(lote.eventos.map((id) => this.almacen.obtener(id)))
      if (this.loteEnVuelo === lote && enVuelo.every((l) => l?.estado === 'confirmado')) {
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
    const todos = await this.almacen.listar()
    const afectados = new Set(
      todos.filter((l) => rechazados.includes(l.evento.id)).flatMap((l) => pedidosDe(l.evento)),
    )
    const dependientes = todos.filter(
      (l) =>
        l.propio && l.estado === 'pendiente' && pedidosDe(l.evento).some((p) => afectados.has(p)),
    )
    await this.almacen.guardar(
      dependientes.map((l) => ({
        ...l,
        estado: 'rechazado' as const,
        motivo: 'depende_de_rechazado',
      })),
    )
  }

  /**
   * El hub se restauró de un respaldo o se reinstaló: se reenvían todos los eventos propios y se
   * olvida lo ajeno, que volverá con el cursor en 0. El hub restaurado no conoce lo que había,
   * así que el dispositivo no estaba "al día": `secuencia_base` baja a 0. La huella del hub no
   * la incluye, así que lo que el respaldo ya tenía se reconoce como el mismo evento.
   */
  private async reenviarTodo() {
    const todos = await this.almacen.listar()
    await this.almacen.borrar(todos.filter((l) => !l.propio).map((l) => l.evento.id))
    await this.almacen.guardar(
      todos
        .filter((l) => l.propio && (l.estado === 'confirmado' || l.estado === 'pendiente'))
        .map((l) => ({
          ...l,
          estado: 'pendiente' as const,
          evento: { ...sinAceptacion(l.evento), secuencia_base: 0 },
        })),
    )
  }

  private traer(desde: number) {
    if (this.trayendo) return
    this.trayendo = true
    this.enviar({ tipo: 'traer', desde })
  }

  private async enviarLote(generacion: number) {
    if (!this.conectado || this.loteEnVuelo || generacion !== this.generacion) return
    const pendientes = await this.almacen.pendientesPropios(TAMANO_LOTE)
    // Mientras se leía pudo cortarse la conexión, o salir otro lote.
    if (!this.conectado || this.loteEnVuelo || generacion !== this.generacion) return
    if (pendientes.length === 0) return
    this.loteEnVuelo = { id: nuevoId(), eventos: pendientes.map((l) => l.evento.id) }
    this.enviar({
      tipo: 'empujar',
      lote_id: this.loteEnVuelo.id,
      eventos: pendientes.map((l) => sinAceptacion(l.evento as EventoAplicable)),
    })
  }
}
