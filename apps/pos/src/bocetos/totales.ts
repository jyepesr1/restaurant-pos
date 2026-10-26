import { type LineaCuenta, saldoDe, totalCuenta } from './cuenta'
import type { Mesa, OrderItem } from './datos'

// Lo que varias pantallas calculan igual sobre una mesa: nombres, totales y tiempos.

/** Una comanda pasa a "atención" a los 10 minutos y a "demora" a los 20 (KDS y plano). */
export const MINUTOS_ATENCION = 10
export const MINUTOS_DEMORA = 20

export const nombreItem = (i: OrderItem) =>
  [i.product.name, i.variant && `(${i.variant.toLowerCase()})`].filter(Boolean).join(' ')

/** Los ítems que cuentan: los anulados quedan a la vista, pero no se cobran. */
export const currentOnes = (table: Mesa) => table.items.filter((i) => !i.voided)

export const lineaDe = (i: OrderItem): LineaCuenta => ({
  id: i.id,
  quantity: i.quantity,
  unitPrice: i.unitPrice,
  extras: i.options.map((o) => o.extraPrice),
})

export const totalMesa = (table: Mesa) => totalCuenta(currentOnes(table).map(lineaDe))
export const saldoMesa = (table: Mesa) => saldoDe(totalMesa(table), table.payments)

/** Minutos entre `desde` y `ahora`. */
export const minutosDesde = (from: number | null, now: number) =>
  from === null ? 0 : Math.max(0, Math.floor((now - from) / 60_000))

/** Lo enviado que cocina o barra aún no entrega. */
export const enPreparacion = (table: Mesa) =>
  currentOnes(table).filter((i) => i.enviadoEn !== null && !i.despachado)

/** Minutos de la comanda más vieja que sigue en preparación (0 si no hay). */
export function esperaMasLarga(table: Mesa, now: number): number {
  const pendingList = enPreparacion(table)
  if (pendingList.length === 0) return 0
  return minutosDesde(Math.min(...pendingList.map((i) => i.enviadoEn as number)), now)
}
