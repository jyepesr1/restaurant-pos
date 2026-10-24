import { type LineaCuenta, saldoDe, totalCuenta } from './cuenta'
import type { ItemPedido, Mesa } from './datos'

// Lo que varias pantallas calculan igual sobre una mesa: nombres, totales y tiempos.

/** Una comanda pasa a "atención" a los 10 minutos y a "demora" a los 20 (KDS y plano). */
export const MINUTOS_ATENCION = 10
export const MINUTOS_DEMORA = 20

export const nombreItem = (i: ItemPedido) =>
  [i.producto.nombre, i.variante && `(${i.variante.toLowerCase()})`].filter(Boolean).join(' ')

/** Los ítems que cuentan: los anulados quedan a la vista, pero no se cobran. */
export const vigentes = (mesa: Mesa) => mesa.items.filter((i) => !i.anulado)

export const lineaDe = (i: ItemPedido): LineaCuenta => ({
  id: i.id,
  cantidad: i.cantidad,
  precioUnitario: i.precioUnitario,
  extras: i.opciones.map((o) => o.precioExtra),
})

export const totalMesa = (mesa: Mesa) => totalCuenta(vigentes(mesa).map(lineaDe))
export const saldoMesa = (mesa: Mesa) => saldoDe(totalMesa(mesa), mesa.pagos)

/** Minutos entre `desde` y `ahora`. */
export const minutosDesde = (desde: number | null, ahora: number) =>
  desde === null ? 0 : Math.max(0, Math.floor((ahora - desde) / 60_000))

/** Lo enviado que cocina o barra aún no entrega. */
export const enPreparacion = (mesa: Mesa) =>
  vigentes(mesa).filter((i) => i.enviadoEn !== null && !i.despachado)

/** Minutos de la comanda más vieja que sigue en preparación (0 si no hay). */
export function esperaMasLarga(mesa: Mesa, ahora: number): number {
  const pendientes = enPreparacion(mesa)
  if (pendientes.length === 0) return 0
  return minutosDesde(Math.min(...pendientes.map((i) => i.enviadoEn as number)), ahora)
}
