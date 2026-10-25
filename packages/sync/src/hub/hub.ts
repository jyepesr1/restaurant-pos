import {
  aplicarEvento,
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
  private readonly almacen: AlmacenHub
  private readonly config: ConfigHub

  constructor(almacen: AlmacenHub, config: ConfigHub) {
    this.almacen = almacen
    this.config = config
    this.reconstruirProyecciones()
  }

  /** Si la mesa tiene un pedido abierto (para no archivarla en el editor del plano). */
  tienePedidoAbierto(mesaId: string): boolean {
    for (const p of this.pedidos.values())
      if (p.estado === 'abierto' && p.mesaId === mesaId) return true
    return false
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

  private aplicarAProyecciones(evento: EventoPedido) {
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
    const acceso = this.config.acceso.verificar(conexion, evento, this.pedido(evento.agregado_id))
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
      asignaciones:
        evento.tipo === 'PedidoAbierto'
          ? { numero_dia: this.almacen.aperturasDelDia(dia) + 1 }
          : {},
      afecta: [],
      autorizado_por_id: acceso.autorizadoPorId,
    } as EventoPedido

    // 6. Aplicar a cada pedido y decidir.
    const resultados = agregados.map((pedidoId) => aplicarEvento(this.pedido(pedidoId), candidato))
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
    } else if (evento.tipo === 'PedidoAbierto' && evento.datos.mesa_id) {
      const mesa = this.mesaOcupada(evento)
      if (mesa === 'rechazar') return this.rechazar(conexion, datos, 'mesa_ocupada', recibidoEn)
      conflicto = mesa
    } else if (evento.tipo === 'ItemAgregado') {
      // Un precio que no cuadra con el catálogo se acepta (el ítem ya se pidió, quizá sin
      // conexión) y la caja lo revisa (docs/SYNC.md#rechazos-cuarentena-y-conflictos).
      const diferencia = this.config.precios?.revisar(evento)
      if (diferencia)
        conflicto = {
          tipo: 'precio_distinto',
          descripcion: diferencia,
          agregadoId: evento.agregado_id,
        }
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
    return { resultado: this.confirmado(candidato), aceptado: candidato }
  }

  /**
   * Dos pedidos abiertos en la misma mesa: si el dispositivo ya conocía el otro, se rechaza; si
   * no lo conocía (estaba sin conexión), se aceptan los dos y se avisa en caja.
   */
  private mesaOcupada(
    evento: Extract<EventoNuevo, { tipo: 'PedidoAbierto' }>,
  ): { tipo: TipoConflicto; descripcion: string; agregadoId: string } | 'rechazar' | null {
    const otro = [...this.pedidos.values()].find(
      (p) => p.estado === 'abierto' && p.mesaId === evento.datos.mesa_id,
    )
    if (!otro) return null
    const loConocia =
      this.almacen.ultimaSecuenciaDe([otro.id], evento.dispositivo_id) <= evento.secuencia_base
    if (loConocia) return 'rechazar'
    return {
      tipo: 'mesa_duplicada',
      descripcion: 'Dos pedidos abiertos en la misma mesa: únelos en caja',
      agregadoId: evento.agregado_id,
    }
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
