export interface MovimientosEfectivoTurno {
  base: number
  /** Pagos en efectivo del turno: monto, ajuste de redondeo y propina. */
  pagos: readonly { monto: number; ajusteRedondeo: number; propina: number }[]
  /** Reversas de pagos anulados y reembolsos en efectivo registrados en el turno. */
  devoluciones: readonly number[]
  entradas: readonly number[]
  salidas: readonly number[]
  pagosPropinas: readonly number[]
  retirosParciales: readonly number[]
}

const sumar = (valores: readonly number[]) => valores.reduce((a, b) => a + b, 0)

/**
 * Efectivo que debería haber en el cajón (docs/DINERO.md#caja):
 * base + Σ (monto + ajuste + propina) − devoluciones + entradas − salidas − pago_propinas − retiros.
 */
export function esperadoEfectivo(m: MovimientosEfectivoTurno): number {
  const cobrado = sumar(m.pagos.map((p) => p.monto + p.ajusteRedondeo + p.propina))
  return (
    m.base +
    cobrado -
    sumar(m.devoluciones) +
    sumar(m.entradas) -
    sumar(m.salidas) -
    sumar(m.pagosPropinas) -
    sumar(m.retirosParciales)
  )
}
