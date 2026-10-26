import {
  type CuadreTurno,
  cuadreDeTurno,
  type EntradaInforme,
  type EstadoPedido,
  type EventoPedido,
  reconstruir,
} from '@pos/core'
import type { AlmacenHub } from './almacen'

// Lo que el hub junta de la base para los reportes (tarea 1.9, docs/KPIS.md): los pedidos que
// cerraron en el período, los eventos registrados en él y los cierres de caja. El cálculo lo hace
// `informe` de @pos/core; aquí solo se consulta.

/** Lo que cuenta en el día en que se registró (KPIS.md#período). */
const DEL_PERIODO = [
  'PagoRegistrado',
  'PagoAnulado',
  'ReembolsoRegistrado',
  'ItemAnulado',
  'PedidoCancelado',
  'MovimientoCajaRegistrado',
]

/** Un turno cerrado, con su cuadre y quién lo abrió y cerró. */
export interface CierreDeTurno {
  cuadre: CuadreTurno
  /** El día operativo en que se cerró (el del reporte que lo lista). */
  diaOperativo: string
  /** El día operativo en que se abrió: el de las ventas de su cierre Z. */
  diaApertura: string
  abiertoPor: string
  cerradoPor: string
  eventoId: string
}

/** Un cierre de mesa del período: el pedido al cerrar y en su cierre anterior. */
export type CierreDePedido = NonNullable<EntradaInforme['cierres']>[number]

export type DatosInforme = Omit<EntradaInforme, 'config' | 'cierres' | 'cerrados'> & {
  cierres: CierreDePedido[]
  cierresDeCaja: CierreDeTurno[]
}

/**
 * Agrega a los eventos los pagos que reversan sus anulaciones y reembolsos, aunque se hayan
 * registrado otro día: sin ellos no se sabe de qué medio sale la plata.
 */
function conPagosOriginales(almacen: AlmacenHub, eventos: EventoPedido[]): EventoPedido[] {
  const ids = new Set(eventos.map((e) => e.id))
  const extra: EventoPedido[] = []
  for (const e of eventos) {
    if (e.tipo !== 'PagoAnulado' && e.tipo !== 'ReembolsoRegistrado') continue
    const pagoId = e.datos.pago_id
    const pago = almacen
      .eventosDeAgregado(e.agregado_id)
      .find((p) => p.tipo === 'PagoRegistrado' && p.datos.pago_id === pagoId)
    if (pago && !ids.has(pago.id)) {
      ids.add(pago.id)
      extra.push(pago)
    }
  }
  return [...eventos, ...extra].sort((a, b) => a.secuencia - b.secuencia)
}

const pedidosPorId = (almacen: AlmacenHub, ids: Iterable<string>): EstadoPedido[] =>
  [...new Set(ids)]
    .map((id) => reconstruir(almacen.eventosDeAgregado(id), id))
    .filter((p): p is EstadoPedido => p !== null)

/**
 * El cuadre de un turno con lo guardado en la base (sirve también para uno ya cerrado). `propios`
 * son los eventos del turno si ya se leyeron.
 */
export function cuadreGuardado(
  almacen: AlmacenHub,
  turnoId: string,
  propios: EventoPedido[] = almacen.eventosDeAgregado(turnoId),
): CuadreTurno | null {
  const apertura = propios.find((e) => e.tipo === 'TurnoAbierto')
  if (!apertura) return null
  const eventos = conPagosOriginales(almacen, [
    ...propios,
    ...almacen.cobrosDeTurno(turnoId, apertura.dia_operativo),
  ])
  return cuadreDeTurno(eventos, turnoId)
}

/** El cierre de un turno, si está cerrado. */
export function cierreDeTurno(almacen: AlmacenHub, turnoId: string): CierreDeTurno | null {
  const eventos = almacen.eventosDeAgregado(turnoId)
  const apertura = eventos.find((e) => e.tipo === 'TurnoAbierto')
  const cierre = eventos.find((e) => e.tipo === 'TurnoCerrado')
  if (!apertura || !cierre) return null
  const cuadre = cuadreGuardado(almacen, turnoId, eventos)
  if (!cuadre?.cerrado) return null
  return {
    cuadre,
    diaOperativo: cierre.dia_operativo,
    diaApertura: apertura.dia_operativo,
    abiertoPor: apertura.usuario_id,
    cerradoPor: cierre.usuario_id,
    eventoId: cierre.id,
  }
}

export function datosDeInforme(almacen: AlmacenHub, desde: string, hasta: string): DatosInforme {
  // Los eventos de cada pedido, leídos una vez.
  const delPedido = new Map<string, EventoPedido[]>()
  const eventosDe = (id: string) => {
    const todos = delPedido.get(id) ?? almacen.eventosDeAgregado(id)
    delPedido.set(id, todos)
    return todos
  }
  /** El pedido tal como quedó después del evento de esa secuencia (o justo antes, con `<`). */
  const estadoHasta = (id: string, secuencia: number, incluido = true) =>
    reconstruir(
      eventosDe(id).filter((x) => (incluido ? x.secuencia <= secuencia : x.secuencia < secuencia)),
      id,
    )

  // Cada cierre de mesa del período suma lo que cambió desde su cierre anterior: un pedido
  // reabierto otro día no cambia lo ya reportado (DINERO.md#día-operativo-e-informes).
  const cierres: CierreDePedido[] = []
  for (const c of almacen.eventosDelPeriodo(['PedidoCerrado'], desde, hasta)) {
    const despues = estadoHasta(c.agregado_id, c.secuencia)
    if (!despues) continue
    const anterior = eventosDe(c.agregado_id)
      .filter((x) => x.tipo === 'PedidoCerrado' && x.agregado_id === c.agregado_id)
      .filter((x) => x.secuencia < c.secuencia)
      .at(-1)
    cierres.push({
      antes: anterior ? estadoHasta(c.agregado_id, anterior.secuencia) : null,
      despues,
    })
  }
  const eventos = conPagosOriginales(almacen, almacen.eventosDelPeriodo(DEL_PERIODO, desde, hasta))
  const relacionados = pedidosPorId(
    almacen,
    eventos
      .filter((e) => e.tipo === 'ItemAnulado' || e.tipo === 'PedidoCancelado')
      .map((e) => e.agregado_id),
  )
  // El pedido justo antes de cada anulación: el ítem pudo irse después a otra mesa.
  const alAnular = new Map<string, EstadoPedido>()
  for (const e of eventos) {
    if (e.tipo !== 'ItemAnulado') continue
    const antes = estadoHasta(e.agregado_id, e.secuencia, false)
    if (antes) alAnular.set(e.id, antes)
  }
  return {
    desde,
    hasta,
    cierres,
    relacionados,
    alAnular,
    eventos,
    cierresDeCaja: almacen
      .eventosDelPeriodo(['TurnoCerrado'], desde, hasta)
      .map((e) => cierreDeTurno(almacen, e.agregado_id))
      .filter((c): c is CierreDeTurno => c !== null),
  }
}
