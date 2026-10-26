import { esperadoEfectivo } from '../dinero/caja'
import type { MedioPago } from '../eventos/comun'
import type { EventoAplicable } from '../eventos/pedido'

// El cuadre de un turno de caja (tareas 1.6 y 1.7, docs/DINERO.md#caja): lo cobrado por medio de
// pago, los movimientos de efectivo, los conteos y el efectivo que debería haber. Lo calculan
// igual el hub (para aceptar el cierre) y la caja (para mostrarlo), a partir de los eventos.
// Una anulación o un reembolso cae en el turno en que se registra, no en el del pago.

export interface CobradoPorMedio {
  medio: MedioPago
  medioPropioId: string | null
  /** Venta con su redondeo, menos anulaciones y reembolsos registrados en el turno. */
  venta: number
  propina: number
  pagos: number
}

export interface MovimientoTurno {
  id: string
  tipo: 'entrada' | 'salida' | 'pago_propinas'
  monto: number
  descripcion: string
  aQuien: string | null
  hora: string
}

/** El nombre de cada medio en pantalla, en el papel y en los reportes. Los propios van por su nombre. */
export const NOMBRE_MEDIO: Record<MedioPago, string> = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  nequi: 'Nequi',
  daviplata: 'Daviplata',
  breb: 'Bre-B',
  transferencia: 'Transferencia',
  bono: 'Bono',
  otro: 'Otro',
}

/** El nombre de un medio en un pago: el propio por su nombre, aunque esté archivado. */
export function nombreDeMedio(
  medio: MedioPago,
  medioPropioId: string | null | undefined,
  propios: readonly { id: string; nombre: string }[],
): string {
  return medio === 'otro'
    ? (propios.find((m) => m.id === medioPropioId)?.nombre ?? NOMBRE_MEDIO.otro)
    : NOMBRE_MEDIO[medio]
}

/** Un medio que no es efectivo: se cuadra con su propio cierre (tarea 1.8). */
export type MedioNoEfectivo = Exclude<MedioPago, 'efectivo'>

/** La clave de un medio en el cuadre: el medio y, si es propio, cuál. */
export const claveDeMedio = (m: { medio: MedioPago; medioPropioId: string | null }) =>
  `${m.medio}:${m.medioPropioId ?? ''}`

/** Lo que dice el cierre de un medio que no es efectivo (el datáfono, una app). */
export interface ReporteMedio {
  medio: MedioNoEfectivo
  medioPropioId: string | null
  reportado: number
}

/** Un medio que no es efectivo en el cierre: lo registrado y lo que dice su cierre. */
export interface CuadreMedio extends ReporteMedio {
  esperado: number
  diferencia: number
}

export interface ArqueoTurno {
  id: string
  conteo: { valor: number; cantidad: number }[]
  contado: number
  /** Los cierres de los demás medios, escritos con el conteo (tarea 1.8). */
  otros: ReporteMedio[]
  hora: string
}

export interface CuadreTurno {
  turnoId: string
  cajaId: string
  base: number
  abiertoEn: string
  porMedio: CobradoPorMedio[]
  movimientos: MovimientoTurno[]
  arqueos: ArqueoTurno[]
  efectivo: {
    /** Lo cobrado en efectivo: monto, redondeo y propina. */
    cobrado: number
    /** Reversas de pagos en efectivo anulados y reembolsos en efectivo del turno. */
    devoluciones: number
    entradas: number
    salidas: number
    pagosPropinas: number
    esperado: number
  }
  cerrado: {
    esperado: number
    contado: number
    diferencia: number
    justificacion: string | null
    otrosMedios: CuadreMedio[]
    hora: string
  } | null
}

const horaDe = (e: EventoAplicable) => e.recibido_en ?? e.hora_estimada_hub

interface PagoDelTurno {
  medio: MedioPago
  medioPropioId: string | null
  monto: number
  ajuste: number
  propina: number
}

/** Los pagos que nombran los eventos, por su id (para reversar una anulación). */
function pagosPorId(eventos: readonly EventoAplicable[]): Map<string, PagoDelTurno> {
  const pagos = new Map<string, PagoDelTurno>()
  for (const e of eventos)
    if (e.tipo === 'PagoRegistrado')
      pagos.set(e.datos.pago_id, {
        medio: e.datos.medio,
        medioPropioId: e.datos.medio_propio_id ?? null,
        monto: e.datos.monto,
        ajuste: e.datos.ajuste_redondeo,
        propina: e.datos.propina,
      })
  return pagos
}

/**
 * Lo cobrado en un turno por medio de pago: venta (con su redondeo) y propina, menos lo anulado
 * y reembolsado en ese turno. Los medios que quedan en 0 no salen.
 */
export function cobradoDelTurno(
  eventos: readonly EventoAplicable[],
  turnoId: string,
): CobradoPorMedio[] {
  return cobradoSegun(eventos, (e) => e.datos.turno_caja_id === turnoId)
}

/** Los eventos que mueven lo cobrado por medio. */
type EventoDeCobro = Extract<
  EventoAplicable,
  { tipo: 'PagoRegistrado' | 'PagoAnulado' | 'ReembolsoRegistrado' }
>

/**
 * Lo cobrado por medio de pago con los eventos de cobro que `cuenta` acepta (los de un turno, los
 * de unos días): cada pago suma; cada anulación o reembolso resta del medio de su pago. Los pagos
 * que reversan pueden venir entre los eventos aunque no cuenten (son de otro turno o día).
 */
export function cobradoSegun(
  eventos: readonly EventoAplicable[],
  cuenta: (e: EventoDeCobro) => boolean,
): CobradoPorMedio[] {
  const pagos = pagosPorId(eventos)
  const porMedio = new Map<string, CobradoPorMedio>()
  const sumar = (
    p: Pick<PagoDelTurno, 'medio' | 'medioPropioId'>,
    venta: number,
    propina: number,
    n: number,
  ) => {
    const clave = claveDeMedio(p)
    const m = porMedio.get(clave) ?? {
      medio: p.medio,
      medioPropioId: p.medioPropioId,
      venta: 0,
      propina: 0,
      pagos: 0,
    }
    m.venta += venta
    m.propina += propina
    m.pagos += n
    porMedio.set(clave, m)
  }
  for (const e of eventos) {
    if (
      (e.tipo !== 'PagoRegistrado' &&
        e.tipo !== 'PagoAnulado' &&
        e.tipo !== 'ReembolsoRegistrado') ||
      !cuenta(e)
    )
      continue
    if (e.tipo === 'PagoRegistrado') {
      const d = e.datos
      sumar(
        { medio: d.medio, medioPropioId: d.medio_propio_id ?? null },
        d.monto + d.ajuste_redondeo,
        d.propina,
        1,
      )
    } else if (e.tipo === 'PagoAnulado') {
      const pago = pagos.get(e.datos.pago_id)
      if (pago) sumar(pago, -(pago.monto + pago.ajuste), -pago.propina, -1)
    } else {
      const pago = pagos.get(e.datos.pago_id)
      sumar(
        { medio: e.datos.medio, medioPropioId: pago?.medioPropioId ?? null },
        -e.datos.monto_venta,
        -e.datos.monto_propina,
        0,
      )
    }
  }
  return [...porMedio.values()].filter((m) => m.pagos !== 0 || m.venta !== 0 || m.propina !== 0)
}

/**
 * El cuadre del turno a partir de los eventos que lo tocan (en el orden en que se aplicaron).
 * Sin su `TurnoAbierto`, null.
 */
export function cuadreDeTurno(
  eventos: readonly EventoAplicable[],
  turnoId: string,
): CuadreTurno | null {
  const apertura = eventos.find((e) => e.tipo === 'TurnoAbierto' && e.agregado_id === turnoId)
  if (apertura?.tipo !== 'TurnoAbierto') return null
  const pagos = pagosPorId(eventos)
  const efectivo = { cobrado: 0, devoluciones: 0, entradas: 0, salidas: 0, pagosPropinas: 0 }
  const movimientos: MovimientoTurno[] = []
  const arqueos: ArqueoTurno[] = []
  let cerrado: CuadreTurno['cerrado'] = null

  for (const e of eventos) {
    switch (e.tipo) {
      case 'PagoRegistrado':
        if (e.datos.turno_caja_id === turnoId && e.datos.medio === 'efectivo')
          efectivo.cobrado += e.datos.monto + e.datos.ajuste_redondeo + e.datos.propina
        break
      case 'PagoAnulado': {
        const pago = pagos.get(e.datos.pago_id)
        if (e.datos.turno_caja_id === turnoId && pago?.medio === 'efectivo')
          efectivo.devoluciones += pago.monto + pago.ajuste + pago.propina
        break
      }
      case 'ReembolsoRegistrado':
        if (e.datos.turno_caja_id === turnoId && e.datos.medio === 'efectivo')
          efectivo.devoluciones += e.datos.monto_venta + e.datos.monto_propina
        break
      case 'MovimientoCajaRegistrado': {
        if (e.agregado_id !== turnoId) break
        const d = e.datos
        if (d.tipo === 'entrada') efectivo.entradas += d.monto
        else if (d.tipo === 'salida') efectivo.salidas += d.monto
        else efectivo.pagosPropinas += d.monto
        movimientos.push({
          id: d.movimiento_id,
          tipo: d.tipo,
          monto: d.monto,
          descripcion: d.descripcion,
          aQuien: d.a_quien,
          hora: horaDe(e),
        })
        break
      }
      case 'ArqueoRegistrado':
        if (e.agregado_id === turnoId)
          arqueos.push({
            id: e.datos.arqueo_id,
            conteo: e.datos.conteo,
            contado: e.datos.contado_efectivo,
            otros: (e.datos.otros ?? []).map((o) => ({
              medio: o.medio,
              medioPropioId: o.medio_propio_id,
              reportado: o.reportado,
            })),
            hora: horaDe(e),
          })
        break
      case 'TurnoCerrado':
        if (e.agregado_id === turnoId)
          cerrado = {
            esperado: e.datos.esperado_efectivo,
            contado: e.datos.contado_efectivo,
            diferencia: e.datos.diferencia,
            justificacion: e.datos.justificacion,
            otrosMedios: (e.datos.otros_medios ?? []).map((o) => ({
              medio: o.medio,
              medioPropioId: o.medio_propio_id,
              esperado: o.esperado,
              reportado: o.reportado,
              diferencia: o.diferencia,
            })),
            hora: horaDe(e),
          }
        break
    }
  }

  const base = apertura.datos.base
  return {
    turnoId,
    cajaId: apertura.datos.caja_id,
    base,
    abiertoEn: horaDe(apertura),
    porMedio: cobradoDelTurno(eventos, turnoId),
    movimientos,
    arqueos,
    efectivo: {
      ...efectivo,
      esperado: esperadoEfectivo({
        base,
        pagos: [{ monto: efectivo.cobrado, ajusteRedondeo: 0, propina: 0 }],
        devoluciones: [efectivo.devoluciones],
        entradas: [efectivo.entradas],
        salidas: [efectivo.salidas],
        pagosPropinas: [efectivo.pagosPropinas],
        retirosParciales: [],
      }),
    },
    cerrado,
  }
}

/** Billetes y monedas de Colombia, de mayor a menor, para el arqueo. */
export const DENOMINACIONES: readonly { valor: number; tipo: 'billete' | 'moneda' }[] = [
  { valor: 100_000, tipo: 'billete' },
  { valor: 50_000, tipo: 'billete' },
  { valor: 20_000, tipo: 'billete' },
  { valor: 10_000, tipo: 'billete' },
  { valor: 5_000, tipo: 'billete' },
  { valor: 2_000, tipo: 'billete' },
  { valor: 1_000, tipo: 'billete' },
  { valor: 1_000, tipo: 'moneda' },
  { valor: 500, tipo: 'moneda' },
  { valor: 200, tipo: 'moneda' },
  { valor: 100, tipo: 'moneda' },
  { valor: 50, tipo: 'moneda' },
]

/**
 * El cuadre de los demás medios con un conteo (tarea 1.8): por cada medio con algo registrado o
 * reportado, lo registrado (venta + propina, lo que aprueba el datáfono o llega a la app), lo que
 * dice su cierre y la diferencia (reportado − esperado).
 */
export function cuadreDeOtrosMedios(cuadre: CuadreTurno, arqueo: ArqueoTurno): CuadreMedio[] {
  const clave = claveDeMedio
  const lineas = new Map<string, CuadreMedio>()
  for (const m of cuadre.porMedio)
    if (m.medio !== 'efectivo')
      lineas.set(clave(m), {
        medio: m.medio,
        medioPropioId: m.medioPropioId,
        esperado: m.venta + m.propina,
        reportado: 0,
        diferencia: 0,
      })
  for (const o of arqueo.otros) {
    const actual = lineas.get(clave(o)) ?? { ...o, esperado: 0, reportado: 0, diferencia: 0 }
    lineas.set(clave(o), { ...actual, reportado: o.reportado })
  }
  return [...lineas.values()]
    .map((l) => ({ ...l, diferencia: l.reportado - l.esperado }))
    .filter((l) => l.esperado !== 0 || l.reportado !== 0)
}
