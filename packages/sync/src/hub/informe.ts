import {
  type OrderEvent,
  type OrderState,
  type ReportInput,
  rebuild,
  type ShiftReconciliation,
  shiftReconciliation,
} from '@pos/core'
import type { AlmacenHub } from './almacen'

// Lo que el hub junta de la base para los reportes (tarea 1.9, docs/KPIS.md): los pedidos que
// cerraron en el período, los eventos registrados en él y los cierres de caja. El cálculo lo hace
// `informe` de @pos/core; aquí solo se consulta.

/** Lo que cuenta en el día en que se registró (KPIS.md#período). */
const DEL_PERIODO = [
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
  'ItemVoided',
  'OrderCanceled',
  'CashMovementRecorded',
]

/** Un turno cerrado, con su cuadre y quién lo abrió y cerró. */
export interface CierreDeTurno {
  reconciliation: ShiftReconciliation
  /** El día operativo en que se cerró (el del reporte que lo lista). */
  businessDay: string
  /** El día operativo en que se abrió: el de las ventas de su cierre Z. */
  diaApertura: string
  abiertoPor: string
  cerradoPor: string
  eventId: string
}

/** Un cierre de mesa del período: el pedido al cerrar y en su cierre anterior. */
export type CierreDePedido = NonNullable<ReportInput['closings']>[number]

export type DatosInforme = Omit<ReportInput, 'config' | 'closings' | 'closedIds'> & {
  closings: CierreDePedido[]
  cierresDeCaja: CierreDeTurno[]
}

/**
 * Agrega a los eventos los pagos que reversan sus anulaciones y reembolsos, aunque se hayan
 * registrado otro día: sin ellos no se sabe de qué medio sale la plata.
 */
function conPagosOriginales(almacen: AlmacenHub, events: OrderEvent[]): OrderEvent[] {
  const ids = new Set(events.map((e) => e.id))
  const extra: OrderEvent[] = []
  for (const e of events) {
    if (e.type !== 'PaymentVoided' && e.type !== 'RefundRecorded') continue
    const paymentId = e.data.payment_id
    const payment = almacen
      .eventosDeAgregado(e.aggregate_id)
      .find((p) => p.type === 'PaymentRecorded' && p.data.payment_id === paymentId)
    if (payment && !ids.has(payment.id)) {
      ids.add(payment.id)
      extra.push(payment)
    }
  }
  return [...events, ...extra].sort((a, b) => a.sequence - b.sequence)
}

const ordersById = (almacen: AlmacenHub, ids: Iterable<string>): OrderState[] =>
  [...new Set(ids)]
    .map((id) => rebuild(almacen.eventosDeAgregado(id), id))
    .filter((p): p is OrderState => p !== null)

/**
 * El cuadre de un turno con lo guardado en la base (sirve también para uno ya cerrado). `propios`
 * son los eventos del turno si ya se leyeron.
 */
export function cuadreGuardado(
  almacen: AlmacenHub,
  shiftId: string,
  ownOnes: OrderEvent[] = almacen.eventosDeAgregado(shiftId),
): ShiftReconciliation | null {
  const opening = ownOnes.find((e) => e.type === 'ShiftOpened')
  if (!opening) return null
  const events = conPagosOriginales(almacen, [
    ...ownOnes,
    ...almacen.cobrosDeTurno(shiftId, opening.business_day),
  ])
  return shiftReconciliation(events, shiftId)
}

/** El cierre de un turno, si está cerrado. */
export function cierreDeTurno(almacen: AlmacenHub, shiftId: string): CierreDeTurno | null {
  const events = almacen.eventosDeAgregado(shiftId)
  const opening = events.find((e) => e.type === 'ShiftOpened')
  const closeout = events.find((e) => e.type === 'ShiftClosed')
  if (!opening || !closeout) return null
  const reconciliation = cuadreGuardado(almacen, shiftId, events)
  if (!reconciliation?.closed) return null
  return {
    reconciliation,
    businessDay: closeout.business_day,
    diaApertura: opening.business_day,
    abiertoPor: opening.user_id,
    cerradoPor: closeout.user_id,
    eventId: closeout.id,
  }
}

export function datosDeInforme(almacen: AlmacenHub, from: string, until: string): DatosInforme {
  // Los eventos de cada pedido, leídos una vez.
  const fromOrder = new Map<string, OrderEvent[]>()
  const eventosDe = (id: string) => {
    const all = fromOrder.get(id) ?? almacen.eventosDeAgregado(id)
    fromOrder.set(id, all)
    return all
  }
  /** El pedido tal como quedó después del evento de esa secuencia (o justo antes, con `<`). */
  const estadoHasta = (id: string, sequence: number, incluido = true) =>
    rebuild(
      eventosDe(id).filter((x) => (incluido ? x.sequence <= sequence : x.sequence < sequence)),
      id,
    )

  // Cada cierre de mesa del período suma lo que cambió desde su cierre anterior: un pedido
  // reabierto otro día no cambia lo ya reportado (DINERO.md#día-operativo-e-informes).
  const closings: CierreDePedido[] = []
  for (const c of almacen.eventosDelPeriodo(['OrderClosed'], from, until)) {
    const after = estadoHasta(c.aggregate_id, c.sequence)
    if (!after) continue
    const previous = eventosDe(c.aggregate_id)
      .filter((x) => x.type === 'OrderClosed' && x.aggregate_id === c.aggregate_id)
      .filter((x) => x.sequence < c.sequence)
      .at(-1)
    closings.push({
      before: previous ? estadoHasta(c.aggregate_id, previous.sequence) : null,
      after,
    })
  }
  const events = conPagosOriginales(almacen, almacen.eventosDelPeriodo(DEL_PERIODO, from, until))
  const related = ordersById(
    almacen,
    events
      .filter((e) => e.type === 'ItemVoided' || e.type === 'OrderCanceled')
      .map((e) => e.aggregate_id),
  )
  // El pedido justo antes de cada anulación: el ítem pudo irse después a otra mesa.
  const onVoid = new Map<string, OrderState>()
  for (const e of events) {
    if (e.type !== 'ItemVoided') continue
    const before = estadoHasta(e.aggregate_id, e.sequence, false)
    if (before) onVoid.set(e.id, before)
  }
  return {
    from,
    until,
    closings,
    related,
    onVoid,
    events,
    cierresDeCaja: almacen
      .eventosDelPeriodo(['ShiftClosed'], from, until)
      .map((e) => cierreDeTurno(almacen, e.aggregate_id))
      .filter((c): c is CierreDeTurno => c !== null),
  }
}
