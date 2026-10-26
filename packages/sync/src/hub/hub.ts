import {
  aplicarEvento,
  type CuadreTurno,
  configCompleta,
  cuadreDeOtrosMedios,
  cuadreDeTurno,
  diaOperativo,
  type EstadoPedido,
  type EventoNuevo,
  type EventoPedido,
  nuevoId,
  reconstruir,
  type TipoProblema,
  validarEventoNuevo,
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
  zonaHoraria: string
  inicioDiaOperativo: string
  /** Cambia al reinstalar o restaurar el hub; se guarda fuera de la base (docs/SYNC.md#fallas-y-qué-pasa). */
  instancia: string
  reloj: () => string
  /** Sesiones, permisos y comprobantes de supervisor (docs/SYNC.md#seguridad). */
  acceso: ControlAcceso
  /** Un evento hizo fallar al hub y se rechazó como `error_interno`: para el registro. */
  alErrorInterno?: (error: unknown, eventoId: string) => void
  /**
   * Compara lo que copió un ítem (precio, extras, impuesto) con el catálogo en su
   * `catalogo_version` (docs/DINERO.md#precio-copiado). Sin él, no se revisa.
   */
  precios?: RevisorPrecios
  /**
   * Corre dentro de la transacción del evento, ya guardado: lo que escriba queda o se pierde con
   * él (los trabajos de impresión de las comandas, ADR-015). Recibe cada pedido que toca el
   * evento, antes y después de aplicarlo. Si falla, el evento igual se acepta y el fallo va a
   * `alFalloAlGuardar`: una impresora mal configurada no puede frenar los pedidos.
   */
  alGuardar?: (evento: EventoPedido, pedidos: CambioPedido[]) => void
  alFalloAlGuardar?: (error: unknown, eventoId: string) => void
  /**
   * Las reglas de cobro que tiene hoy el restaurante (tarea 1.6): un pago en efectivo trae su
   * regla de redondeo (docs/DINERO.md#pagos), el medio está habilitado y la tarjeta nombra un
   * datáfono activo. Sin ellas, no se revisan.
   */
  reglasCobro?: () => {
    multiplo: number
    modo: string
    medios: readonly string[]
    /** Los medios propios activos del restaurante. */
    mediosPropios?: readonly string[]
    datafonos: readonly string[]
    /** Desde qué diferencia el cierre de caja pide justificación (tarea 1.7). */
    umbralDiferencia?: number
  }
}

/** Un turno de caja abierto (tareas 1.6 y 1.7): se cierra con `TurnoCerrado`. */
export interface TurnoCaja {
  id: string
  /** El equipo de caja donde se abrió (por ahora cada caja es un equipo). */
  cajaId: string
  base: number
  abiertoEn: string
  usuarioId: string
}

export interface CambioPedido {
  antes: EstadoPedido | null
  despues: EstadoPedido | null
}

/** Devuelve qué no coincide con el catálogo, o `null` si todo coincide. */
export interface RevisorPrecios {
  revisar(evento: EventoNuevo): string | null
}

/** Lo que el hub sabe del dispositivo de una conexión (lo da su token). */
export interface Conexion {
  dispositivoId: string
  tipo: TipoDispositivo
  /** Si el dispositivo fue revocado, cuándo. */
  revocadoEn: string | null
}

export type VeredictoAcceso =
  | { ok: true; autorizadoPorId: string | null; autorizacionId: string | null }
  | { ok: false; motivo: string; cuarentena?: boolean }

/**
 * Quién puede crear cada evento. El hub no confía en el usuario que dice el evento: lo compara
 * con la sesión, que debe ser de ese dispositivo y estar abierta a la hora del evento. El permiso
 * se evalúa con el rol al recibirlo; sin permiso, vale un comprobante de supervisor.
 */
export interface ControlAcceso {
  /** `pedido`: el estado del pedido antes del evento (algunos permisos dependen de él). */
  verificar(conexion: Conexion, evento: EventoNuevo, pedido: EstadoPedido | null): VeredictoAcceso
  /** El evento se guardó: corre en la misma transacción (usa el comprobante y la sesión). */
  registrarUso(evento: EventoNuevo, veredicto: Extract<VeredictoAcceso, { ok: true }>): void
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
const CONFLICTOS: Partial<Record<TipoProblema, TipoConflicto>> = {
  item_inexistente: 'item_inexistente',
  item_ya_enviado: 'item_ya_enviado',
  estado_item_invalido: 'item_ya_enviado',
  item_ya_anulado: 'item_ya_anulado',
  // Quitar más de lo que queda: otro dispositivo ya quitó parte.
  cantidad_invalida: 'item_ya_anulado',
  pedido_cerrado: 'pedido_cerrado',
}

/**
 * Si un pedido abierto ocupa esa mesa: la suya o una unida a él (tarea 1.5). Uno que pasó todos
 * sus productos a otra mesa, o al que se le anularon todos, ya no la ocupa; uno recién abierto, o
 * al que el mesero le quitó lo que aún no enviaba, sí.
 */
const ocupa = (p: EstadoPedido, mesaId: string) =>
  p.estado === 'abierto' &&
  (p.mesaId === mesaId || p.mesasUnidas.includes(mesaId)) &&
  (Object.values(p.items).some((i) => i.estado !== 'anulado') ||
    (Object.keys(p.items).length === 0 && !p.vaciadoAlMover))

/**
 * Las mesas que un evento hace ocupar a un pedido que antes no las ocupaba: al abrirlo, al
 * cambiarse o al unir, pero también al reabrir una cuenta o al agregar a un pedido vaciado.
 */
function mesasQueToma(antes: EstadoPedido | null, despues: EstadoPedido | null): string[] {
  if (!despues || despues.mesaId === null) return []
  return [despues.mesaId, ...despues.mesasUnidas].filter(
    (m) => ocupa(despues, m) && !(antes && ocupa(antes, m)),
  )
}

/** Cambiarse o unirse a una mesa ocupada exige estar al día: se hace con conexión. */
const TOMA_CON_CONEXION = new Set(['PedidoMovidoDeMesa', 'MesasUnidas'])

/** El umbral de justificación del cierre si no llega el del restaurante (el de fábrica). */
const UMBRAL_DIFERENCIA_CAJA = configCompleta().umbral_diferencia_caja

/** Mover y unir exigen conexión con el hub: nunca son conflicto. */
const SIEMPRE_EN_LINEA = new Set(['ItemsMovidos', 'PedidosUnidos'])

/** Pedidos que toca un evento: su agregado, los relacionados y los que el hub puso en `afecta`. */
export const pedidosDe = (e: {
  agregado_id: string
  relacionados: readonly string[]
  afecta?: readonly string[]
}) => [...new Set([e.agregado_id, ...e.relacionados, ...(e.afecta ?? [])])]

/**
 * Pedidos que nombra un evento que puede venir malformado (un rechazo por formato no debe
 * tumbar el lote ni el hub).
 */
function agregadosDeCrudo(crudo: unknown): string[] {
  if (typeof crudo !== 'object' || crudo === null) return []
  const { agregado_id, relacionados } = crudo as { agregado_id?: unknown; relacionados?: unknown }
  return [
    ...(typeof agregado_id === 'string' ? [agregado_id] : []),
    ...(Array.isArray(relacionados)
      ? relacionados.filter((r): r is string => typeof r === 'string')
      : []),
  ]
}

/** Lo que el hub necesita de un evento antes de validarlo: su id, su huella y si es tratable. */
interface Identificado {
  id: string
  huella: string
  /** Lo que se guarda en el rechazo (JSON válido). */
  contenido: string
  /** Si está demasiado grande o anidado para siquiera validarlo. */
  problema: string | null
}

function identificar(crudo: unknown): Identificado {
  const posible = (crudo as { id?: unknown } | null)?.id
  const id = typeof posible === 'string' && posible.length <= 100 ? posible : ''
  let contenido: string
  try {
    contenido = JSON.stringify(crudo) ?? 'null'
  } catch {
    return { id, huella: 'sin-huella', contenido: '"omitido"', problema: 'demasiado_anidado' }
  }
  if (contenido.length > MAX_CONTENIDO)
    return { id, huella: 'sin-huella', contenido: '"omitido"', problema: 'demasiado_grande' }
  try {
    return { id, huella: huellaEvento(crudo), contenido, problema: null }
  } catch {
    return { id, huella: 'sin-huella', contenido: '"omitido"', problema: 'demasiado_anidado' }
  }
}

/** Otros dispositivos no reciben la sesión de quien creó el evento. */
const paraDispositivo = (evento: EventoPedido, dispositivoId: string | null): EventoPedido =>
  evento.dispositivo_id === dispositivoId || evento.sesion_id === null
    ? evento
    : { ...evento, sesion_id: null }

/**
 * El hub de sincronización: autoridad del salón. Valida, numera y guarda cada evento. Mantiene en
 * memoria la proyección de los pedidos abiertos (se reconstruye desde los eventos al arrancar);
 * la de un pedido cerrado se reconstruye de la base cuando hace falta.
 */
export class HubSync {
  /** Solo pedidos abiertos: los cerrados se reconstruyen de la base. */
  private readonly pedidos = new Map<string, EstadoPedido>()
  /** Turnos de caja abiertos, por su id. */
  private readonly turnos = new Map<string, TurnoCaja>()
  /** Los eventos de cada turno abierto: su apertura, pagos, movimientos y conteos. */
  private readonly eventosDeTurno = new Map<string, EventoPedido[]>()
  private readonly almacen: AlmacenHub
  private readonly config: ConfigHub

  constructor(almacen: AlmacenHub, config: ConfigHub) {
    this.almacen = almacen
    this.config = config
    this.reconstruirProyecciones()
  }

  /** Si la mesa tiene un pedido abierto, suyo o de un grupo unido (no se archiva en el plano). */
  tienePedidoAbierto(mesaId: string): boolean {
    for (const p of this.pedidos.values()) if (ocupa(p, mesaId)) return true
    return false
  }

  /** El turno abierto de una caja, si tiene. */
  turnoAbierto(cajaId: string): TurnoCaja | null {
    for (const t of this.turnos.values()) if (t.cajaId === cajaId) return t
    return null
  }

  /** Proyección actual de un pedido. */
  pedido(id: string): EstadoPedido | null {
    return this.pedidos.get(id) ?? reconstruir(this.almacen.eventosDeAgregado(id), id)
  }

  bienvenida(): Extract<MensajeHub, { tipo: 'bienvenido' }> {
    return {
      tipo: 'bienvenido',
      hub_instancia: this.config.instancia,
      secuencia_max: this.almacen.maxSecuencia(),
      hora_hub: this.config.reloj(),
    }
  }

  /** Eventos después de `desde`, por páginas, con `hasta` aunque la vista filtre alguno. */
  traer(
    desde: number,
    tipo: TipoDispositivo,
    dispositivoId: string | null = null,
  ): Extract<MensajeHub, { tipo: 'eventos' }> {
    const pagina = this.almacen.eventosDesde(desde, TAMANO_PAGINA)
    return {
      tipo: 'eventos',
      eventos: pagina.filter((e) => this.ve(tipo, e)).map((e) => paraDispositivo(e, dispositivoId)),
      hasta: pagina.at(-1)?.secuencia ?? desde,
      hay_mas: pagina.length === TAMANO_PAGINA,
    }
  }

  /**
   * Qué eventos ve cada tipo de dispositivo. Por ahora solo hay eventos de pedido y los ven
   * todos; la caja y la auditoría se filtrarán cuando existan (Fase 1).
   */
  ve(_tipo: TipoDispositivo, _evento: EventoPedido): boolean {
    return true
  }

  /**
   * Mensaje `nuevo` para difundir un evento aceptado. `hasta_anterior` supone que el dispositivo
   * ve todos los eventos; cuando `ve` filtre (Fase 1) tendrá que ser por dispositivo.
   */
  nuevo(
    evento: EventoPedido,
    dispositivoId: string | null = null,
  ): Extract<MensajeHub, { tipo: 'nuevo' }> {
    return {
      tipo: 'nuevo',
      evento: paraDispositivo(evento, dispositivoId),
      hasta_anterior: evento.secuencia - 1,
      hasta: evento.secuencia,
    }
  }

  /**
   * Procesa un lote: un evento por transacción, en orden. Si uno se rechaza, los siguientes del
   * mismo pedido en el lote también (dependen de él). Devuelve el resultado de cada uno y los
   * aceptados, para difundirlos.
   */
  recibirLote(
    conexion: Conexion,
    eventos: readonly unknown[],
  ): { resultados: ResultadoEvento[]; aceptados: EventoPedido[] } {
    const rechazados = new Set<string>()
    const resultados: ResultadoEvento[] = []
    const aceptados: EventoPedido[] = []
    for (const crudo of eventos) {
      const datos = identificar(crudo)
      let procesado: { resultado: ResultadoEvento; aceptado: EventoPedido | null }
      try {
        procesado = this.almacen.transaccion(() =>
          this.procesar(conexion, crudo, datos, rechazados),
        )
      } catch (error) {
        // Si tampoco se puede guardar el rechazo, el almacén está caído: que el hub se reinicie
        // (lanza). Si se puede, el problema es de este evento: rechazarlo evita que tumbe al hub
        // cada vez que el dispositivo lo reenvíe.
        procesado = this.almacen.transaccion(() =>
          this.rechazar(conexion, datos, 'error_interno', this.config.reloj()),
        )
        this.config.alErrorInterno?.(error, datos.id)
      }
      const { resultado, aceptado } = procesado
      resultados.push(resultado)
      if (aceptado) {
        aceptados.push(aceptado)
        this.aplicarAProyecciones(aceptado)
      }
      if (resultado.estado === 'rechazado') {
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
    const todos = new Map<string, EstadoPedido>()
    let desde = 0
    for (;;) {
      const pagina = this.almacen.eventosDesde(desde, TAMANO_PAGINA)
      for (const evento of pagina) {
        this.aplicarATurnos(evento)
        if (evento.agregado_tipo !== 'pedido') continue
        for (const id of pedidosDe(evento)) {
          const r = aplicarEvento(todos.get(id) ?? null, evento)
          if (r.estado) todos.set(id, r.estado)
        }
      }
      if (pagina.length < TAMANO_PAGINA) break
      desde = pagina.at(-1)?.secuencia ?? desde
    }
    for (const [id, pedido] of todos) if (pedido.estado === 'abierto') this.pedidos.set(id, pedido)
  }

  /**
   * Lleva los turnos abiertos y los eventos de cada uno (tarea 1.7): con ellos se calcula el cuadre
   * al cerrar. Un cierre saca el turno; un pago ya no puede caer en él.
   */
  private aplicarATurnos(evento: EventoPedido) {
    const agregar = (turnoId: string, ...eventos: EventoPedido[]) =>
      this.eventosDeTurno.get(turnoId)?.push(...eventos)
    switch (evento.tipo) {
      case 'TurnoAbierto':
        this.turnos.set(evento.agregado_id, {
          id: evento.agregado_id,
          cajaId: evento.datos.caja_id,
          base: evento.datos.base,
          abiertoEn: evento.recibido_en,
          usuarioId: evento.usuario_id,
        })
        this.eventosDeTurno.set(evento.agregado_id, [evento])
        break
      case 'PagoRegistrado':
        agregar(evento.datos.turno_caja_id, evento)
        break
      case 'PagoAnulado':
      case 'ReembolsoRegistrado': {
        // La anulación o el reembolso cae en el turno donde se registra: ahí hace falta el pago
        // que reversa (su medio), aunque se haya cobrado en otro turno.
        const pago = this.almacen
          .eventosDeAgregado(evento.agregado_id)
          .find((e) => e.tipo === 'PagoRegistrado' && e.datos.pago_id === evento.datos.pago_id)
        const lista = this.eventosDeTurno.get(evento.datos.turno_caja_id)
        if (pago && lista && !lista.some((e) => e.id === pago.id))
          agregar(evento.datos.turno_caja_id, pago)
        agregar(evento.datos.turno_caja_id, evento)
        break
      }
      case 'MovimientoCajaRegistrado':
      case 'ArqueoRegistrado':
        agregar(evento.agregado_id, evento)
        break
      case 'TurnoCerrado':
        this.turnos.delete(evento.agregado_id)
        this.eventosDeTurno.delete(evento.agregado_id)
        break
    }
  }

  /**
   * El cuadre de un turno (lo cobrado, los movimientos y el efectivo esperado): el abierto, de
   * memoria; el cerrado, de la base.
   */
  cuadre(turnoId: string): CuadreTurno | null {
    const abierto = this.eventosDeTurno.get(turnoId)
    return abierto ? cuadreDeTurno(abierto, turnoId) : cuadreGuardado(this.almacen, turnoId)
  }

  /** Lo que necesita el informe de un período de días operativos (tarea 1.9). */
  datosDeInforme(desde: string, hasta: string): DatosInforme {
    return datosDeInforme(this.almacen, desde, hasta)
  }

  /** El cierre de un turno ya cerrado, para reimprimir su cierre Z. */
  cierreDeTurno(turnoId: string): CierreDeTurno | null {
    return cierreDeTurno(this.almacen, turnoId)
  }

  /**
   * Reglas de la caja que no dependen del pedido (tarea 1.6): una caja abre un solo turno a la
   * vez, y cada pago, anulación o reembolso cae en un turno abierto de la caja que lo registra.
   * Un pago usa un medio habilitado, un datáfono activo y la regla de redondeo del restaurante.
   */
  private problemaDeCaja(evento: EventoNuevo): string | null {
    if (evento.tipo === 'TurnoAbierto') {
      if (evento.datos.caja_id !== evento.dispositivo_id) return 'caja_distinta'
      if (
        this.turnos.has(evento.agregado_id) ||
        this.almacen.eventosDeAgregado(evento.agregado_id).length > 0
      )
        return 'turno_ya_existe'
      if (this.turnoAbierto(evento.datos.caja_id)) return 'turno_ya_abierto'
      return null
    }
    if (
      evento.tipo === 'MovimientoCajaRegistrado' ||
      evento.tipo === 'ArqueoRegistrado' ||
      evento.tipo === 'TurnoCerrado'
    ) {
      const turno = this.turnos.get(evento.agregado_id)
      if (!turno) return 'sin_turno'
      if (turno.cajaId !== evento.dispositivo_id) return 'turno_de_otra_caja'
      if (evento.tipo !== 'TurnoCerrado') return null
      // El cierre debe cuadrar con lo que registró el hub: el conteo existe y es el mismo, lo
      // esperado es lo que da el cuadre, y una diferencia grande trae justificación.
      const cuadre = this.cuadre(turno.id)
      const arqueo = cuadre?.arqueos.find((a) => a.id === evento.datos.arqueo_id)
      if (!cuadre || !arqueo) return 'arqueo_inexistente'
      // Con el último conteo, y hecho después del último movimiento de dinero del turno.
      if (cuadre.arqueos.at(-1)?.id !== arqueo.id) return 'arqueo_no_es_el_ultimo'
      const eventos = this.eventosDeTurno.get(turno.id) ?? []
      const posicion = (tipos: readonly string[]) =>
        eventos.findLastIndex((e) => tipos.includes(e.tipo))
      if (
        posicion([
          'PagoRegistrado',
          'PagoAnulado',
          'ReembolsoRegistrado',
          'MovimientoCajaRegistrado',
        ]) > posicion(['ArqueoRegistrado'])
      )
        return 'arqueo_desactualizado'
      if (arqueo.contado !== evento.datos.contado_efectivo) return 'contado_distinto'
      if (cuadre.efectivo.esperado !== evento.datos.esperado_efectivo) return 'esperado_distinto'
      // Los demás medios (tarea 1.8): cada uno con lo que registró el hub y lo que dijo su cierre
      // en el conteo, ni más ni menos.
      const comoTexto = (l: {
        medio: string
        medioPropioId: string | null
        esperado: number
        reportado: number
      }) => `${l.medio}:${l.medioPropioId ?? ''}:${l.esperado}:${l.reportado}`
      const otros = cuadreDeOtrosMedios(cuadre, arqueo)
      const delEvento = (evento.datos.otros_medios ?? []).map((o) => ({
        medio: o.medio,
        medioPropioId: o.medio_propio_id,
        esperado: o.esperado,
        reportado: o.reportado,
      }))
      if (otros.map(comoTexto).sort().join('|') !== delEvento.map(comoTexto).sort().join('|'))
        return 'otros_medios_distintos'
      const umbral = this.config.reglasCobro?.().umbralDiferencia ?? UMBRAL_DIFERENCIA_CAJA
      const grande = (d: number) => Math.abs(d) >= Math.max(1, umbral)
      if (
        (grande(evento.datos.diferencia) || otros.some((o) => grande(o.diferencia))) &&
        !evento.datos.justificacion
      )
        return 'falta_justificacion'
      return null
    }
    if (
      evento.tipo !== 'PagoRegistrado' &&
      evento.tipo !== 'PagoAnulado' &&
      evento.tipo !== 'ReembolsoRegistrado'
    )
      return null
    const turno = this.turnos.get(evento.datos.turno_caja_id)
    if (!turno) return 'sin_turno'
    if (turno.cajaId !== evento.dispositivo_id) return 'turno_de_otra_caja'
    if (evento.tipo === 'PagoRegistrado' && this.config.reglasCobro) {
      const reglas = this.config.reglasCobro()
      const { redondeo, medio, datafono, medio_propio_id } = evento.datos
      if (
        medio === 'otro'
          ? !medio_propio_id || !(reglas.mediosPropios ?? []).includes(medio_propio_id)
          : !reglas.medios.includes(medio)
      )
        return 'medio_no_habilitado'
      if (datafono && !reglas.datafonos.includes(datafono.datafono_id))
        return 'datafono_desconocido'
      if (redondeo && (redondeo.multiplo !== reglas.multiplo || redondeo.modo !== reglas.modo))
        return 'redondeo_distinto'
    }
    return null
  }

  private aplicarAProyecciones(evento: EventoPedido) {
    this.aplicarATurnos(evento)
    if (evento.agregado_tipo !== 'pedido') return
    for (const id of pedidosDe(evento)) {
      const r = aplicarEvento(this.pedido(id), evento)
      if (r.estado?.estado === 'abierto') this.pedidos.set(id, r.estado)
      else this.pedidos.delete(id)
    }
  }

  private procesar(
    conexion: Conexion,
    crudo: unknown,
    datos: Identificado,
    rechazadosEnLote: ReadonlySet<string>,
  ): { resultado: ResultadoEvento; aceptado: EventoPedido | null } {
    const recibidoEn = this.config.reloj()
    const { id, huella: contenido } = datos
    if (datos.problema)
      return this.rechazar(conexion, datos, `esquema: ${datos.problema}`, recibidoEn)

    // 1. Idempotencia: el mismo id con el mismo contenido recibe la misma respuesta.
    const previo = this.almacen.rechazo(this.claveRechazo(datos), contenido)
    if (previo)
      return { resultado: { id, estado: 'rechazado', motivo: previo.motivo }, aceptado: null }
    const guardado = id ? this.almacen.porId(id) : undefined
    if (guardado) {
      if (guardado.huella === contenido)
        return { resultado: this.confirmado(guardado.evento), aceptado: null }
      return this.rechazar(conexion, datos, 'id_repetido', recibidoEn)
    }

    // 2. Formato.
    const validacion = validarEventoNuevo(crudo)
    if (!validacion.ok)
      return this.rechazar(conexion, datos, `esquema: ${validacion.errores[0]}`, recibidoEn)
    const evento = validacion.evento

    // 3. Dispositivo.
    if (evento.dispositivo_id !== conexion.dispositivoId) {
      return this.rechazar(conexion, datos, 'dispositivo_distinto', recibidoEn)
    }
    if (conexion.revocadoEn) {
      // Lo hecho antes de revocarlo lo revisa el gerente; lo de después no vale.
      const antes = Date.parse(evento.hora_estimada_hub) < Date.parse(conexion.revocadoEn)
      return antes
        ? this.aCuarentena(conexion, datos, 'dispositivo_revocado', recibidoEn)
        : this.rechazar(conexion, datos, 'dispositivo_revocado', recibidoEn)
    }

    // 3b. Sesión y permiso. Una sesión que el hub no conoce (p. ej. tras restaurarlo) va a
    // cuarentena: el evento pudo ser legítimo.
    // Un evento de producto no tiene pedido: no hace falta reconstruir nada para juzgarlo.
    const pedidoPrevio = evento.agregado_tipo === 'pedido' ? this.pedido(evento.agregado_id) : null
    const acceso = this.config.acceso.verificar(conexion, evento, pedidoPrevio)
    if (!acceso.ok) {
      return acceso.cuarentena
        ? this.aCuarentena(conexion, datos, acceso.motivo, recibidoEn)
        : this.rechazar(conexion, datos, acceso.motivo, recibidoEn)
    }

    // 4. Dependencias dentro del lote y secuencia base.
    const agregados = pedidosDe(evento)
    if (agregados.some((a) => rechazadosEnLote.has(a))) {
      return this.rechazar(conexion, datos, 'depende_de_rechazado', recibidoEn)
    }
    const max = this.almacen.maxSecuencia()
    if (evento.secuencia_base > max) {
      return this.rechazar(conexion, datos, 'secuencia_base_invalida', recibidoEn)
    }

    // 5. Lo que agrega el hub.
    const dia = diaOperativo(
      this.horaParaDia(evento.hora_estimada_hub, recibidoEn),
      this.config.zonaHoraria,
      this.config.inicioDiaOperativo,
    )
    const candidato = {
      ...evento,
      secuencia: max + 1,
      recibido_en: recibidoEn,
      dia_operativo: dia,
      asignaciones: this.asignaciones(evento, dia),
      afecta: [],
      autorizado_por_id: acceso.autorizadoPorId,
    } as EventoPedido

    // 5b. Caja: turno abierto y redondeo del restaurante.
    const deCaja = this.problemaDeCaja(evento)
    if (deCaja) return this.rechazar(conexion, datos, deCaja, recibidoEn)

    // 6. Aplicar a cada pedido y decidir. Un evento de producto (agotado) no toca pedidos.
    const esDePedido = evento.agregado_tipo === 'pedido'
    const antes = esDePedido ? agregados.map((pedidoId) => this.pedido(pedidoId)) : []
    const resultados = antes.map((pedido) => aplicarEvento(pedido, candidato))
    const problema = resultados.find(
      (r) => r.problema && r.problema.tipo !== 'items_omitidos',
    )?.problema
    // Al día: no hay nada de otros dispositivos en esos pedidos que no conociera.
    const alDia =
      this.almacen.ultimaSecuenciaDe(agregados, conexion.dispositivoId) <= evento.secuencia_base

    let conflicto: { tipo: TipoConflicto; descripcion: string; agregadoId: string } | null = null
    if (problema) {
      const tipo = CONFLICTOS[problema.tipo]
      if (!tipo || alDia || SIEMPRE_EN_LINEA.has(evento.tipo)) {
        return this.rechazar(conexion, datos, problema.tipo, recibidoEn)
      }
      conflicto = { tipo, descripcion: problema.descripcion, agregadoId: evento.agregado_id }
    }
    const mesa = problema
      ? null
      : this.mesaOcupada(
          evento,
          agregados,
          antes.flatMap((pedido, i) => mesasQueToma(pedido, resultados[i]?.estado ?? null)),
        )
    if (mesa === 'rechazar') return this.rechazar(conexion, datos, 'mesa_ocupada', recibidoEn)
    // Un precio que no cuadra con el catálogo se acepta (el ítem ya se pidió, quizá sin
    // conexión) y la caja lo revisa (docs/SYNC.md#rechazos-cuarentena-y-conflictos). Un evento
    // guarda un solo conflicto: si además hay dos pedidos en la mesa, va en la misma descripción.
    const diferencia =
      !problema && evento.tipo === 'ItemAgregado' ? this.config.precios?.revisar(evento) : null
    if (mesa)
      conflicto = diferencia
        ? { ...mesa, descripcion: `${mesa.descripcion}. Revisa también el precio: ${diferencia}` }
        : mesa
    else if (diferencia)
      conflicto = {
        tipo: 'precio_distinto',
        descripcion: diferencia,
        agregadoId: evento.agregado_id,
      }

    // 7. Guardar.
    this.almacen.guardarEvento(candidato, contenido, agregados)
    this.config.acceso.registrarUso(evento, acceso)
    if (conflicto) {
      this.almacen.guardarConflicto({
        id: nuevoId(),
        eventoId: id,
        detectadoEn: recibidoEn,
        ...conflicto,
      })
    }
    if (this.config.alGuardar) {
      try {
        this.config.alGuardar(
          candidato,
          antes.map((pedido, i) => ({ antes: pedido, despues: resultados[i]?.estado ?? null })),
        )
      } catch (error) {
        this.config.alFalloAlGuardar?.(error, id)
      }
    }
    return { resultado: this.confirmado(candidato), aceptado: candidato }
  }

  /**
   * Dos pedidos abiertos en la misma mesa: si el dispositivo ya conocía el otro, se rechaza; si
   * no lo conocía (estaba sin conexión), se aceptan los dos y se avisa en caja.
   */
  private mesaOcupada(
    evento: EventoNuevo,
    agregados: readonly string[],
    mesas: readonly string[],
  ): { tipo: TipoConflicto; descripcion: string; agregadoId: string } | 'rechazar' | null {
    if (mesas.length === 0) return null
    let otro: EstadoPedido | undefined
    for (const p of this.pedidos.values())
      if (!agregados.includes(p.id) && mesas.some((m) => ocupa(p, m))) {
        otro = p
        break
      }
    if (!otro) return null
    if (TOMA_CON_CONEXION.has(evento.tipo) || SIEMPRE_EN_LINEA.has(evento.tipo)) return 'rechazar'
    const loConocia =
      this.almacen.ultimaSecuenciaDe([otro.id], evento.dispositivo_id) <= evento.secuencia_base
    if (loConocia) return 'rechazar'
    return {
      tipo: 'mesa_duplicada',
      descripcion: 'Dos pedidos abiertos en la misma mesa: únelos en caja',
      agregadoId: evento.agregado_id,
    }
  }

  /**
   * Números que da el hub: el del pedido del día al abrirlo, y uno por comanda al enviar, seguidos
   * en el día operativo (ADR-006 y ADR-015).
   */
  private asignaciones(evento: EventoNuevo, dia: string): EventoPedido['asignaciones'] {
    if (evento.tipo === 'PedidoAbierto')
      return { numero_dia: this.almacen.aperturasDelDia(dia) + 1 }
    if (evento.tipo === 'ItemsEnviados') {
      // Solo las comandas que de verdad mandan algo a cocina: lo que ya envió otro equipo no gasta
      // número, y la cocina no ve saltos (#1, #3).
      const antes = this.pedido(evento.agregado_id)
      const conAlgo = evento.datos.comandas.filter((c) =>
        c.item_ids.some((id) => antes?.items[id]?.estado === 'pendiente'),
      )
      const base = this.almacen.comandasDelDia(dia)
      return {
        numeros_comanda: Object.fromEntries(conAlgo.map((c, i) => [c.comanda_id, base + i + 1])),
      }
    }
    return {}
  }

  /** La hora del dispositivo corregida vale si cae en una ventana razonable; si no, la del hub. */
  private horaParaDia(horaEstimada: string, recibidoEn: string): string {
    const diferencia = Date.parse(recibidoEn) - Date.parse(horaEstimada)
    return diferencia <= ANTES_MAX_MS && diferencia >= -DESPUES_MAX_MS ? horaEstimada : recibidoEn
  }

  private confirmado(evento: EventoPedido): ResultadoEvento {
    const { secuencia, recibido_en, dia_operativo, asignaciones, afecta, autorizado_por_id } =
      evento
    return {
      id: evento.id,
      estado: 'confirmado',
      aceptacion: {
        secuencia,
        recibido_en,
        dia_operativo,
        asignaciones,
        afecta,
        autorizado_por_id,
      },
      conflicto: this.almacen.conflictoDe(evento.id)?.tipo ?? null,
    }
  }

  /** La hora la pone el dispositivo: por eso la cuarentena tiene tope por dispositivo. */
  private aCuarentena(
    conexion: Conexion,
    datos: Identificado,
    motivo: string,
    recibidoEn: string,
  ): { resultado: ResultadoEvento; aceptado: null } {
    if (this.almacen.cuarentenasDe(conexion.dispositivoId) >= MAX_CUARENTENA)
      return this.rechazar(conexion, datos, motivo, recibidoEn)
    this.almacen.guardarCuarentena({
      eventoId: datos.id,
      dispositivoId: conexion.dispositivoId,
      motivo,
      contenido: datos.contenido,
      recibidoEn,
    })
    return { resultado: { id: datos.id, estado: 'cuarentena' }, aceptado: null }
  }

  /** Un evento sin id se identifica por su huella. */
  private claveRechazo(datos: Identificado) {
    return datos.id || `sin-id-${datos.huella}`
  }

  private rechazar(
    conexion: Conexion,
    datos: Identificado,
    motivo: string,
    recibidoEn: string,
  ): { resultado: ResultadoEvento; aceptado: null } {
    this.almacen.guardarRechazo({
      eventoId: this.claveRechazo(datos),
      huella: datos.huella,
      dispositivoId: conexion.dispositivoId,
      motivo,
      contenido: datos.contenido,
      recibidoEn,
    })
    return { resultado: { id: datos.id, estado: 'rechazado', motivo }, aceptado: null }
  }
}
