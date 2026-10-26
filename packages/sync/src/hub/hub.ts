import {
  applyEvent,
  businessDay,
  fullConfig,
  type IssueType,
  type NewEvent,
  newId,
  type OrderEvent,
  type OrderState,
  otherMethodsReconciliation,
  rebuild,
  type ShiftReconciliation,
  shiftReconciliation,
  validateNewEvent,
} from '@pos/core'
import { huellaEvento } from '../huella'
import {
  type MensajeHub,
  type ResultadoEvento,
  TAMANO_PAGINA,
  type TipoDispositivo,
} from '../protocolo'
import type { AlmacenHub, TipoConflicto } from './almacen'
import {
  type CierreDeTurno,
  cierreDeTurno,
  cuadreGuardado,
  type DatosInforme,
  datosDeInforme,
} from './informe'

export interface ConfigHub {
  restauranteId: string
  timeZone: string
  inicioDiaOperativo: string
  /** Cambia al reinstalar o restaurar el hub; se guarda fuera de la base (docs/SYNC.md#fallas-y-qué-pasa). */
  instancia: string
  clock: () => string
  /** Sesiones, permisos y comprobantes de supervisor (docs/SYNC.md#seguridad). */
  access: ControlAcceso
  /** Un evento hizo fallar al hub y se rechazó como `error_interno`: para el registro. */
  alErrorInterno?: (error: unknown, eventId: string) => void
  /**
   * Compara lo que copió un ítem (precio, extras, impuesto) con el catálogo en su
   * `catalog_version` (docs/DINERO.md#precio-copiado). Sin él, no se revisa.
   */
  prices?: RevisorPrecios
  /**
   * Corre dentro de la transacción del evento, ya guardado: lo que escriba queda o se pierde con
   * él (los trabajos de impresión de las comandas, ADR-015). Recibe cada pedido que toca el
   * evento, antes y después de aplicarlo. Si falla, el evento igual se acepta y el fallo va a
   * `onSaveFailure`: una impresora mal configurada no puede frenar los pedidos.
   */
  onSave?: (event: OrderEvent, orders: CambioPedido[]) => void
  onSaveFailure?: (error: unknown, eventId: string) => void
  /**
   * Las reglas de cobro que tiene hoy el restaurante (tarea 1.6): un pago en efectivo trae su
   * regla de redondeo (docs/DINERO.md#pagos), el medio está habilitado y la tarjeta nombra un
   * datáfono activo. Sin ellas, no se revisan.
   */
  reglasCobro?: () => {
    multiple: number
    mode: string
    medios: readonly string[]
    /** Los medios propios activos del restaurante. */
    mediosPropios?: readonly string[]
    cardTerminals: readonly string[]
    /** Desde qué diferencia el cierre de caja pide justificación (tarea 1.7). */
    umbralDiferencia?: number
  }
}

/** Un turno de caja abierto (tareas 1.6 y 1.7): se cierra con `ShiftClosed`. */
export interface TurnoCaja {
  id: string
  /** El equipo de caja donde se abrió (por ahora cada caja es un equipo). */
  registerId: string
  base: number
  openedAt: string
  userId: string
}

export interface CambioPedido {
  before: OrderState | null
  after: OrderState | null
}

/** Devuelve qué no coincide con el catálogo, o `null` si todo coincide. */
export interface RevisorPrecios {
  revisar(event: NewEvent): string | null
}

/** Lo que el hub sabe del dispositivo de una conexión (lo da su token). */
export interface Conexion {
  dispositivoId: string
  type: TipoDispositivo
  /** Si el dispositivo fue revocado, cuándo. */
  revocadoEn: string | null
}

export type VeredictoAcceso =
  | { ok: true; authorizedById: string | null; autorizacionId: string | null }
  | { ok: false; reason: string; quarantine?: boolean }

/**
 * Quién puede crear cada evento. El hub no confía en el usuario que dice el evento: lo compara
 * con la sesión, que debe ser de ese dispositivo y estar abierta a la hora del evento. El permiso
 * se evalúa con el rol al recibirlo; sin permiso, vale un comprobante de supervisor.
 */
export interface ControlAcceso {
  /** `pedido`: el estado del pedido antes del evento (algunos permisos dependen de él). */
  verify(connection: Conexion, event: NewEvent, order: OrderState | null): VeredictoAcceso
  /** El evento se guardó: corre en la misma transacción (usa el comprobante y la sesión). */
  registrarUso(event: NewEvent, veredicto: Extract<VeredictoAcceso, { ok: true }>): void
}

/** Ventana en que se acepta la hora estimada del dispositivo para el día operativo. */
const ANTES_MAX_MS = 12 * 60 * 60 * 1000
const DESPUES_MAX_MS = 60 * 1000

/** Un evento real ocupa unos cientos de bytes; más que esto es un error o un abuso. */
const MAX_CONTENIDO = 64 * 1024
/** Eventos en cuarentena por dispositivo: más que esto se rechaza. */
const MAX_CUARENTENA = 500

/**
 * Problemas del reductor que, si el dispositivo no estaba al día, son un conflicto (se acepta y
 * se avisa en caja) y no un rechazo (docs/SYNC.md#rechazos-cuarentena-y-conflictos).
 */
const CONFLICTOS: Partial<Record<IssueType, TipoConflicto>> = {
  item_not_found: 'item_not_found',
  item_already_sent: 'item_already_sent',
  invalid_item_status: 'item_already_sent',
  item_already_voided: 'item_already_voided',
  // Quitar más de lo que queda: otro dispositivo ya quitó parte.
  invalid_quantity: 'item_already_voided',
  order_closed: 'order_closed',
}

/**
 * Si un pedido abierto ocupa esa mesa: la suya o una unida a él (tarea 1.5). Uno que pasó todos
 * sus productos a otra mesa, o al que se le anularon todos, ya no la ocupa; uno recién abierto, o
 * al que el mesero le quitó lo que aún no enviaba, sí.
 */
const ocupa = (p: OrderState, tableId: string) =>
  p.status === 'open' &&
  (p.tableId === tableId || p.mergedTables.includes(tableId)) &&
  (Object.values(p.items).some((i) => i.status !== 'voided') ||
    (Object.keys(p.items).length === 0 && !p.emptiedOnMove))

/**
 * Las mesas que un evento hace ocupar a un pedido que antes no las ocupaba: al abrirlo, al
 * cambiarse o al unir, pero también al reabrir una cuenta o al agregar a un pedido vaciado.
 */
function mesasQueToma(before: OrderState | null, after: OrderState | null): string[] {
  if (!after || after.tableId === null) return []
  return [after.tableId, ...after.mergedTables].filter(
    (m) => ocupa(after, m) && !(before && ocupa(before, m)),
  )
}

/** Cambiarse o unirse a una mesa ocupada exige estar al día: se hace con conexión. */
const TOMA_CON_CONEXION = new Set(['OrderMovedTable', 'TablesMerged'])

/** El umbral de justificación del cierre si no llega el del restaurante (el de fábrica). */
const UMBRAL_DIFERENCIA_CAJA = fullConfig().register_variance_threshold

/** Mover y unir exigen conexión con el hub: nunca son conflicto. */
const SIEMPRE_EN_LINEA = new Set(['ItemsMoved', 'OrdersMerged'])

/** Pedidos que toca un evento: su agregado, los relacionados y los que el hub puso en `afecta`. */
export const pedidosDe = (e: {
  aggregate_id: string
  related: readonly string[]
  affects?: readonly string[]
}) => [...new Set([e.aggregate_id, ...e.related, ...(e.affects ?? [])])]

/**
 * Pedidos que nombra un evento que puede venir malformado (un rechazo por formato no debe
 * tumbar el lote ni el hub).
 */
function agregadosDeCrudo(crudo: unknown): string[] {
  if (typeof crudo !== 'object' || crudo === null) return []
  const { aggregate_id, related } = crudo as { aggregate_id?: unknown; related?: unknown }
  return [
    ...(typeof aggregate_id === 'string' ? [aggregate_id] : []),
    ...(Array.isArray(related) ? related.filter((r): r is string => typeof r === 'string') : []),
  ]
}

/** Lo que el hub necesita de un evento antes de validarlo: su id, su huella y si es tratable. */
interface Identificado {
  id: string
  fingerprint: string
  /** Lo que se guarda en el rechazo (JSON válido). */
  content: string
  /** Si está demasiado grande o anidado para siquiera validarlo. */
  issue: string | null
}

function identificar(crudo: unknown): Identificado {
  const posible = (crudo as { id?: unknown } | null)?.id
  const id = typeof posible === 'string' && posible.length <= 100 ? posible : ''
  let content: string
  try {
    content = JSON.stringify(crudo) ?? 'null'
  } catch {
    return { id, fingerprint: 'no-fingerprint', content: '"omitido"', issue: 'too_deeply_nested' }
  }
  if (content.length > MAX_CONTENIDO)
    return { id, fingerprint: 'no-fingerprint', content: '"omitido"', issue: 'too_large' }
  try {
    return { id, fingerprint: huellaEvento(crudo), content, issue: null }
  } catch {
    return { id, fingerprint: 'no-fingerprint', content: '"omitido"', issue: 'too_deeply_nested' }
  }
}

/** Otros dispositivos no reciben la sesión de quien creó el evento. */
const paraDispositivo = (event: OrderEvent, dispositivoId: string | null): OrderEvent =>
  event.device_id === dispositivoId || event.session_id === null
    ? event
    : { ...event, session_id: null }

/**
 * El hub de sincronización: autoridad del salón. Valida, numera y guarda cada evento. Mantiene en
 * memoria la proyección de los pedidos abiertos (se reconstruye desde los eventos al arrancar);
 * la de un pedido cerrado se reconstruye de la base cuando hace falta.
 */
export class HubSync {
  /** Solo pedidos abiertos: los cerrados se reconstruyen de la base. */
  private readonly orders = new Map<string, OrderState>()
  /** Turnos de caja abiertos, por su id. */
  private readonly shifts = new Map<string, TurnoCaja>()
  /** Los eventos de cada turno abierto: su apertura, pagos, movimientos y conteos. */
  private readonly eventosDeTurno = new Map<string, OrderEvent[]>()
  private readonly almacen: AlmacenHub
  private readonly config: ConfigHub

  constructor(almacen: AlmacenHub, config: ConfigHub) {
    this.almacen = almacen
    this.config = config
    this.reconstruirProyecciones()
  }

  /** Si la mesa tiene un pedido abierto, suyo o de un grupo unido (no se archiva en el plano). */
  tienePedidoAbierto(tableId: string): boolean {
    for (const p of this.orders.values()) if (ocupa(p, tableId)) return true
    return false
  }

  /** El turno abierto de una caja, si tiene. */
  turnoAbierto(registerId: string): TurnoCaja | null {
    for (const t of this.shifts.values()) if (t.registerId === registerId) return t
    return null
  }

  /** Proyección actual de un pedido. */
  order(id: string): OrderState | null {
    return this.orders.get(id) ?? rebuild(this.almacen.eventosDeAgregado(id), id)
  }

  bienvenida(): Extract<MensajeHub, { type: 'welcome' }> {
    return {
      type: 'welcome',
      hub_instancia: this.config.instancia,
      secuencia_max: this.almacen.maxSecuencia(),
      hora_hub: this.config.clock(),
    }
  }

  /** Eventos después de `desde`, por páginas, con `hasta` aunque la vista filtre alguno. */
  pull(
    from: number,
    type: TipoDispositivo,
    dispositivoId: string | null = null,
  ): Extract<MensajeHub, { type: 'events' }> {
    const pagina = this.almacen.eventosDesde(from, TAMANO_PAGINA)
    return {
      type: 'events',
      events: pagina.filter((e) => this.ve(type, e)).map((e) => paraDispositivo(e, dispositivoId)),
      until: pagina.at(-1)?.sequence ?? from,
      hay_mas: pagina.length === TAMANO_PAGINA,
    }
  }

  /**
   * Qué eventos ve cada tipo de dispositivo. Por ahora solo hay eventos de pedido y los ven
   * todos; la caja y la auditoría se filtrarán cuando existan (Fase 1).
   */
  ve(_tipo: TipoDispositivo, _evento: OrderEvent): boolean {
    return true
  }

  /**
   * Mensaje `nuevo` para difundir un evento aceptado. `hasta_anterior` supone que el dispositivo
   * ve todos los eventos; cuando `ve` filtre (Fase 1) tendrá que ser por dispositivo.
   */
  fresh(
    event: OrderEvent,
    dispositivoId: string | null = null,
  ): Extract<MensajeHub, { type: 'new' }> {
    return {
      type: 'new',
      event: paraDispositivo(event, dispositivoId),
      hasta_anterior: event.sequence - 1,
      until: event.sequence,
    }
  }

  /**
   * Procesa un lote: un evento por transacción, en orden. Si uno se rechaza, los siguientes del
   * mismo pedido en el lote también (dependen de él). Devuelve el resultado de cada uno y los
   * aceptados, para difundirlos.
   */
  recibirLote(
    connection: Conexion,
    events: readonly unknown[],
  ): { resultados: ResultadoEvento[]; aceptados: OrderEvent[] } {
    const rechazados = new Set<string>()
    const resultados: ResultadoEvento[] = []
    const aceptados: OrderEvent[] = []
    for (const crudo of events) {
      const data = identificar(crudo)
      let procesado: { result: ResultadoEvento; accepted: OrderEvent | null }
      try {
        procesado = this.almacen.transaccion(() =>
          this.procesar(connection, crudo, data, rechazados),
        )
      } catch (error) {
        // Si tampoco se puede guardar el rechazo, el almacén está caído: que el hub se reinicie
        // (lanza). Si se puede, el problema es de este evento: rechazarlo evita que tumbe al hub
        // cada vez que el dispositivo lo reenvíe.
        procesado = this.almacen.transaccion(() =>
          this.reject(connection, data, 'internal_error', this.config.clock()),
        )
        this.config.alErrorInterno?.(error, data.id)
      }
      const { result, accepted } = procesado
      resultados.push(result)
      if (accepted) {
        aceptados.push(accepted)
        this.aplicarAProyecciones(accepted)
      }
      if (result.status === 'rejected') {
        for (const id of agregadosDeCrudo(crudo)) rechazados.add(id)
      }
    }
    return { resultados, aceptados }
  }

  conflictos() {
    return this.almacen.conflictos()
  }

  // ── Internos ─────────────────────────────────────────────────────────

  /**
   * Repasa todos los eventos y se queda con los pedidos abiertos. Con años de datos esto se
   * vuelve lento: en la Fase 1 las proyecciones se guardan en la base.
   */
  private reconstruirProyecciones() {
    const all = new Map<string, OrderState>()
    let from = 0
    for (;;) {
      const pagina = this.almacen.eventosDesde(from, TAMANO_PAGINA)
      for (const event of pagina) {
        this.aplicarATurnos(event)
        if (event.aggregate_type !== 'order') continue
        for (const id of pedidosDe(event)) {
          const r = applyEvent(all.get(id) ?? null, event)
          if (r.status) all.set(id, r.status)
        }
      }
      if (pagina.length < TAMANO_PAGINA) break
      from = pagina.at(-1)?.sequence ?? from
    }
    for (const [id, order] of all) if (order.status === 'open') this.orders.set(id, order)
  }

  /**
   * Lleva los turnos abiertos y los eventos de cada uno (tarea 1.7): con ellos se calcula el cuadre
   * al cerrar. Un cierre saca el turno; un pago ya no puede caer en él.
   */
  private aplicarATurnos(event: OrderEvent) {
    const add = (shiftId: string, ...events: OrderEvent[]) =>
      this.eventosDeTurno.get(shiftId)?.push(...events)
    switch (event.type) {
      case 'ShiftOpened':
        this.shifts.set(event.aggregate_id, {
          id: event.aggregate_id,
          registerId: event.data.register_id,
          base: event.data.base,
          openedAt: event.received_at,
          userId: event.user_id,
        })
        this.eventosDeTurno.set(event.aggregate_id, [event])
        break
      case 'PaymentRecorded':
        add(event.data.register_shift_id, event)
        break
      case 'PaymentVoided':
      case 'RefundRecorded': {
        // La anulación o el reembolso cae en el turno donde se registra: ahí hace falta el pago
        // que reversa (su medio), aunque se haya cobrado en otro turno.
        const payment = this.almacen
          .eventosDeAgregado(event.aggregate_id)
          .find((e) => e.type === 'PaymentRecorded' && e.data.payment_id === event.data.payment_id)
        const list = this.eventosDeTurno.get(event.data.register_shift_id)
        if (payment && list && !list.some((e) => e.id === payment.id))
          add(event.data.register_shift_id, payment)
        add(event.data.register_shift_id, event)
        break
      }
      case 'CashMovementRecorded':
      case 'CashCountRecorded':
        add(event.aggregate_id, event)
        break
      case 'ShiftClosed':
        this.shifts.delete(event.aggregate_id)
        this.eventosDeTurno.delete(event.aggregate_id)
        break
    }
  }

  /**
   * El cuadre de un turno (lo cobrado, los movimientos y el efectivo esperado): el abierto, de
   * memoria; el cerrado, de la base.
   */
  reconciliation(shiftId: string): ShiftReconciliation | null {
    const opened = this.eventosDeTurno.get(shiftId)
    return opened ? shiftReconciliation(opened, shiftId) : cuadreGuardado(this.almacen, shiftId)
  }

  /** Lo que necesita el informe de un período de días operativos (tarea 1.9). */
  datosDeInforme(from: string, until: string): DatosInforme {
    return datosDeInforme(this.almacen, from, until)
  }

  /** El cierre de un turno ya cerrado, para reimprimir su cierre Z. */
  cierreDeTurno(shiftId: string): CierreDeTurno | null {
    return cierreDeTurno(this.almacen, shiftId)
  }

  /**
   * Reglas de la caja que no dependen del pedido (tarea 1.6): una caja abre un solo turno a la
   * vez, y cada pago, anulación o reembolso cae en un turno abierto de la caja que lo registra.
   * Un pago usa un medio habilitado, un datáfono activo y la regla de redondeo del restaurante.
   */
  private problemaDeCaja(event: NewEvent): string | null {
    if (event.type === 'ShiftOpened') {
      if (event.data.register_id !== event.device_id) return 'register_mismatch'
      if (
        this.shifts.has(event.aggregate_id) ||
        this.almacen.eventosDeAgregado(event.aggregate_id).length > 0
      )
        return 'shift_already_exists'
      if (this.turnoAbierto(event.data.register_id)) return 'shift_already_open'
      return null
    }
    if (
      event.type === 'CashMovementRecorded' ||
      event.type === 'CashCountRecorded' ||
      event.type === 'ShiftClosed'
    ) {
      const shift = this.shifts.get(event.aggregate_id)
      if (!shift) return 'no_shift'
      if (shift.registerId !== event.device_id) return 'other_register_shift'
      if (event.type !== 'ShiftClosed') return null
      // El cierre debe cuadrar con lo que registró el hub: el conteo existe y es el mismo, lo
      // esperado es lo que da el cuadre, y una diferencia grande trae justificación.
      const reconciliation = this.reconciliation(shift.id)
      const cashCount = reconciliation?.cashCounts.find((a) => a.id === event.data.cash_count_id)
      if (!reconciliation || !cashCount) return 'cash_count_not_found'
      // Con el último conteo, y hecho después del último movimiento de dinero del turno.
      if (reconciliation.cashCounts.at(-1)?.id !== cashCount.id) return 'cash_count_not_latest'
      const events = this.eventosDeTurno.get(shift.id) ?? []
      const posicion = (types: readonly string[]) =>
        events.findLastIndex((e) => types.includes(e.type))
      if (
        posicion(['PaymentRecorded', 'PaymentVoided', 'RefundRecorded', 'CashMovementRecorded']) >
        posicion(['CashCountRecorded'])
      )
        return 'stale_cash_count'
      if (cashCount.counted !== event.data.counted_cash) return 'counted_mismatch'
      if (reconciliation.cash.expected !== event.data.expected_cash) return 'expected_mismatch'
      // Los demás medios (tarea 1.8): cada uno con lo que registró el hub y lo que dijo su cierre
      // en el conteo, ni más ni menos.
      const comoTexto = (l: {
        method: string
        customMethodId: string | null
        expected: number
        reported: number
      }) => `${l.method}:${l.customMethodId ?? ''}:${l.expected}:${l.reported}`
      const others = otherMethodsReconciliation(reconciliation, cashCount)
      const delEvento = (event.data.other_methods ?? []).map((o) => ({
        method: o.method,
        customMethodId: o.custom_method_id,
        expected: o.expected,
        reported: o.reported,
      }))
      if (others.map(comoTexto).sort().join('|') !== delEvento.map(comoTexto).sort().join('|'))
        return 'other_methods_mismatch'
      const umbral = this.config.reglasCobro?.().umbralDiferencia ?? UMBRAL_DIFERENCIA_CAJA
      const large = (d: number) => Math.abs(d) >= Math.max(1, umbral)
      if (
        (large(event.data.variance) || others.some((o) => large(o.variance))) &&
        !event.data.justification
      )
        return 'missing_justification'
      return null
    }
    if (
      event.type !== 'PaymentRecorded' &&
      event.type !== 'PaymentVoided' &&
      event.type !== 'RefundRecorded'
    )
      return null
    const shift = this.shifts.get(event.data.register_shift_id)
    if (!shift) return 'no_shift'
    if (shift.registerId !== event.device_id) return 'other_register_shift'
    if (event.type === 'PaymentRecorded' && this.config.reglasCobro) {
      const reglas = this.config.reglasCobro()
      const { rounding, method, cardTerminal, custom_method_id } = event.data
      if (
        method === 'other'
          ? !custom_method_id || !(reglas.mediosPropios ?? []).includes(custom_method_id)
          : !reglas.medios.includes(method)
      )
        return 'method_not_enabled'
      if (cardTerminal && !reglas.cardTerminals.includes(cardTerminal.card_terminal_id))
        return 'unknown_card_terminal'
      if (rounding && (rounding.multiple !== reglas.multiple || rounding.mode !== reglas.mode))
        return 'rounding_mismatch'
    }
    return null
  }

  private aplicarAProyecciones(event: OrderEvent) {
    this.aplicarATurnos(event)
    if (event.aggregate_type !== 'order') return
    for (const id of pedidosDe(event)) {
      const r = applyEvent(this.order(id), event)
      if (r.status?.status === 'open') this.orders.set(id, r.status)
      else this.orders.delete(id)
    }
  }

  private procesar(
    connection: Conexion,
    crudo: unknown,
    data: Identificado,
    rechazadosEnLote: ReadonlySet<string>,
  ): { result: ResultadoEvento; accepted: OrderEvent | null } {
    const recibidoEn = this.config.clock()
    const { id, fingerprint: content } = data
    if (data.issue) return this.reject(connection, data, `esquema: ${data.issue}`, recibidoEn)

    // 1. Idempotencia: el mismo id con el mismo contenido recibe la misma respuesta.
    const previous = this.almacen.rechazo(this.claveRechazo(data), content)
    if (previous)
      return { result: { id, status: 'rejected', reason: previous.reason }, accepted: null }
    const saved = id ? this.almacen.porId(id) : undefined
    if (saved) {
      if (saved.fingerprint === content)
        return { result: this.confirmed(saved.event), accepted: null }
      return this.reject(connection, data, 'duplicate_id', recibidoEn)
    }

    // 2. Formato.
    const validation = validateNewEvent(crudo)
    if (!validation.ok)
      return this.reject(connection, data, `esquema: ${validation.errors[0]}`, recibidoEn)
    const event = validation.event

    // 3. Dispositivo.
    if (event.device_id !== connection.dispositivoId) {
      return this.reject(connection, data, 'device_mismatch', recibidoEn)
    }
    if (connection.revocadoEn) {
      // Lo hecho antes de revocarlo lo revisa el gerente; lo de después no vale.
      const before = Date.parse(event.hub_estimated_time) < Date.parse(connection.revocadoEn)
      return before
        ? this.aCuarentena(connection, data, 'revoked_device', recibidoEn)
        : this.reject(connection, data, 'revoked_device', recibidoEn)
    }

    // 3b. Sesión y permiso. Una sesión que el hub no conoce (p. ej. tras restaurarlo) va a
    // cuarentena: el evento pudo ser legítimo.
    // Un evento de producto no tiene pedido: no hace falta reconstruir nada para juzgarlo.
    const pedidoPrevio = event.aggregate_type === 'order' ? this.order(event.aggregate_id) : null
    const access = this.config.access.verify(connection, event, pedidoPrevio)
    if (!access.ok) {
      return access.quarantine
        ? this.aCuarentena(connection, data, access.reason, recibidoEn)
        : this.reject(connection, data, access.reason, recibidoEn)
    }

    // 4. Dependencias dentro del lote y secuencia base.
    const agregados = pedidosDe(event)
    if (agregados.some((a) => rechazadosEnLote.has(a))) {
      return this.reject(connection, data, 'depends_on_rejected', recibidoEn)
    }
    const max = this.almacen.maxSecuencia()
    if (event.base_sequence > max) {
      return this.reject(connection, data, 'invalid_base_sequence', recibidoEn)
    }

    // 5. Lo que agrega el hub.
    const day = businessDay(
      this.horaParaDia(event.hub_estimated_time, recibidoEn),
      this.config.timeZone,
      this.config.inicioDiaOperativo,
    )
    const candidato = {
      ...event,
      sequence: max + 1,
      received_at: recibidoEn,
      business_day: day,
      assignments: this.assignments(event, day),
      affects: [],
      authorized_by_id: access.authorizedById,
    } as OrderEvent

    // 5b. Caja: turno abierto y redondeo del restaurante.
    const deCaja = this.problemaDeCaja(event)
    if (deCaja) return this.reject(connection, data, deCaja, recibidoEn)

    // 6. Aplicar a cada pedido y decidir. Un evento de producto (agotado) no toca pedidos.
    const esDePedido = event.aggregate_type === 'order'
    const before = esDePedido ? agregados.map((orderId) => this.order(orderId)) : []
    const resultados = before.map((order) => applyEvent(order, candidato))
    const issue = resultados.find((r) => r.issue && r.issue.type !== 'items_omitted')?.issue
    // Al día: no hay nada de otros dispositivos en esos pedidos que no conociera.
    const alDia =
      this.almacen.ultimaSecuenciaDe(agregados, connection.dispositivoId) <= event.base_sequence

    let conflict: { type: TipoConflicto; description: string; agregadoId: string } | null = null
    if (issue) {
      const type = CONFLICTOS[issue.type]
      if (!type || alDia || SIEMPRE_EN_LINEA.has(event.type)) {
        return this.reject(connection, data, issue.type, recibidoEn)
      }
      conflict = { type, description: issue.description, agregadoId: event.aggregate_id }
    }
    const table = issue
      ? null
      : this.mesaOcupada(
          event,
          agregados,
          before.flatMap((order, i) => mesasQueToma(order, resultados[i]?.status ?? null)),
        )
    if (table === 'reject') return this.reject(connection, data, 'table_occupied', recibidoEn)
    // Un precio que no cuadra con el catálogo se acepta (el ítem ya se pidió, quizá sin
    // conexión) y la caja lo revisa (docs/SYNC.md#rechazos-cuarentena-y-conflictos). Un evento
    // guarda un solo conflicto: si además hay dos pedidos en la mesa, va en la misma descripción.
    const variance =
      !issue && event.type === 'ItemAdded' ? this.config.prices?.revisar(event) : null
    if (table)
      conflict = variance
        ? { ...table, description: `${table.description}. Revisa también el precio: ${variance}` }
        : table
    else if (variance)
      conflict = {
        type: 'price_mismatch',
        description: variance,
        agregadoId: event.aggregate_id,
      }

    // 7. Guardar.
    this.almacen.saveEvent(candidato, content, agregados)
    this.config.access.registrarUso(event, access)
    if (conflict) {
      this.almacen.guardarConflicto({
        id: newId(),
        eventId: id,
        detectadoEn: recibidoEn,
        ...conflict,
      })
    }
    if (this.config.onSave) {
      try {
        this.config.onSave(
          candidato,
          before.map((order, i) => ({ before: order, after: resultados[i]?.status ?? null })),
        )
      } catch (error) {
        this.config.onSaveFailure?.(error, id)
      }
    }
    return { result: this.confirmed(candidato), accepted: candidato }
  }

  /**
   * Dos pedidos abiertos en la misma mesa: si el dispositivo ya conocía el otro, se rechaza; si
   * no lo conocía (estaba sin conexión), se aceptan los dos y se avisa en caja.
   */
  private mesaOcupada(
    event: NewEvent,
    agregados: readonly string[],
    tables: readonly string[],
  ): { type: TipoConflicto; description: string; agregadoId: string } | 'reject' | null {
    if (tables.length === 0) return null
    let other: OrderState | undefined
    for (const p of this.orders.values())
      if (!agregados.includes(p.id) && tables.some((m) => ocupa(p, m))) {
        other = p
        break
      }
    if (!other) return null
    if (TOMA_CON_CONEXION.has(event.type) || SIEMPRE_EN_LINEA.has(event.type)) return 'reject'
    const loConocia =
      this.almacen.ultimaSecuenciaDe([other.id], event.device_id) <= event.base_sequence
    if (loConocia) return 'reject'
    return {
      type: 'duplicate_table',
      description: 'Dos pedidos abiertos en la misma mesa: únelos en caja',
      agregadoId: event.aggregate_id,
    }
  }

  /**
   * Números que da el hub: el del pedido del día al abrirlo, y uno por comanda al enviar, seguidos
   * en el día operativo (ADR-006 y ADR-015).
   */
  private assignments(event: NewEvent, day: string): OrderEvent['assignments'] {
    if (event.type === 'OrderOpened') return { day_number: this.almacen.aperturasDelDia(day) + 1 }
    if (event.type === 'ItemsSent') {
      // Solo las comandas que de verdad mandan algo a cocina: lo que ya envió otro equipo no gasta
      // número, y la cocina no ve saltos (#1, #3).
      const before = this.order(event.aggregate_id)
      const conAlgo = event.data.tickets.filter((c) =>
        c.item_ids.some((id) => before?.items[id]?.status === 'pending'),
      )
      const base = this.almacen.comandasDelDia(day)
      return {
        ticket_numbers: Object.fromEntries(conAlgo.map((c, i) => [c.ticket_id, base + i + 1])),
      }
    }
    return {}
  }

  /** La hora del dispositivo corregida vale si cae en una ventana razonable; si no, la del hub. */
  private horaParaDia(horaEstimada: string, recibidoEn: string): string {
    const variance = Date.parse(recibidoEn) - Date.parse(horaEstimada)
    return variance <= ANTES_MAX_MS && variance >= -DESPUES_MAX_MS ? horaEstimada : recibidoEn
  }

  private confirmed(event: OrderEvent): ResultadoEvento {
    const { sequence, received_at, business_day, assignments, affects, authorized_by_id } = event
    return {
      id: event.id,
      status: 'confirmed',
      aceptacion: {
        sequence,
        received_at,
        business_day,
        assignments,
        affects,
        authorized_by_id,
      },
      conflict: this.almacen.conflictoDe(event.id)?.type ?? null,
    }
  }

  /** La hora la pone el dispositivo: por eso la cuarentena tiene tope por dispositivo. */
  private aCuarentena(
    connection: Conexion,
    data: Identificado,
    reason: string,
    recibidoEn: string,
  ): { result: ResultadoEvento; accepted: null } {
    if (this.almacen.cuarentenasDe(connection.dispositivoId) >= MAX_CUARENTENA)
      return this.reject(connection, data, reason, recibidoEn)
    this.almacen.guardarCuarentena({
      eventId: data.id,
      dispositivoId: connection.dispositivoId,
      reason,
      content: data.content,
      recibidoEn,
    })
    return { result: { id: data.id, status: 'quarantine' }, accepted: null }
  }

  /** Un evento sin id se identifica por su huella. */
  private claveRechazo(data: Identificado) {
    return data.id || `no-id-${data.fingerprint}`
  }

  private reject(
    connection: Conexion,
    data: Identificado,
    reason: string,
    recibidoEn: string,
  ): { result: ResultadoEvento; accepted: null } {
    this.almacen.guardarRechazo({
      eventId: this.claveRechazo(data),
      fingerprint: data.fingerprint,
      dispositivoId: connection.dispositivoId,
      reason,
      content: data.content,
      recibidoEn,
    })
    return { result: { id: data.id, status: 'rejected', reason }, accepted: null }
  }
}
