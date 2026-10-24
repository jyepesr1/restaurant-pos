import { precioConExtras } from '../dinero/linea'
import type { EstadoPedido, ItemPedido } from './estado'

/** Precio de una unidad del ítem con sus modificadores. */
export function precioUnidad(item: ItemPedido): number {
  return precioConExtras(
    item.precioUnitario,
    item.modificadores.map((m) => m.precioExtra),
  )
}

export function descuentoDeItem(estado: EstadoPedido, itemId: string): number {
  return Object.values(estado.descuentos).reduce((a, d) => a + (d.montos[itemId] ?? 0), 0)
}

export interface TotalesItem {
  bruto: number
  anulado: number
  descuento: number
  neto: number
}

/** bruto − anulado − descuentos = neto (docs/DINERO.md#línea-de-pedido). */
export function totalesItem(estado: EstadoPedido, item: ItemPedido): TotalesItem {
  const unidad = precioUnidad(item)
  const bruto = item.cantidad * unidad
  const anulado = item.cantidadAnulada * unidad
  const descuento = descuentoDeItem(estado, item.id)
  return { bruto, anulado, descuento, neto: bruto - anulado - descuento }
}

export interface TotalesPedido extends TotalesItem {
  /** Σ de lo pagado en pagos vigentes, menos lo reembolsado de la venta. */
  pagado: number
  saldo: number
  propinas: number
  ajustes: number
}

export function totalesPedido(estado: EstadoPedido): TotalesPedido {
  const t = { bruto: 0, anulado: 0, descuento: 0, neto: 0 }
  for (const item of Object.values(estado.items)) {
    const ti = totalesItem(estado, item)
    t.bruto += ti.bruto
    t.anulado += ti.anulado
    t.descuento += ti.descuento
    t.neto += ti.neto
  }
  let pagado = 0
  let propinas = 0
  let ajustes = 0
  for (const pago of Object.values(estado.pagos)) {
    if (pago.anulado) continue
    pagado += pago.monto - pago.reembolsadoVenta
    propinas += pago.propina - pago.reembolsadoPropina
    ajustes += pago.ajusteRedondeo
  }
  return { ...t, pagado, saldo: t.neto - pagado, propinas, ajustes }
}

/** Saldo de una cuenta dividida, o del pedido entero si `cuentaId` es null. */
export function saldoCuenta(estado: EstadoPedido, cuentaId: string | null): number | null {
  if (cuentaId === null) return totalesPedido(estado).saldo
  const cuenta = estado.cuentas?.find((c) => c.id === cuentaId)
  if (!cuenta) return null
  const pagado = Object.values(estado.pagos)
    .filter((p) => !p.anulado && p.cuentaId === cuentaId)
    .reduce((a, p) => a + p.monto - p.reembolsadoVenta, 0)
  return cuenta.monto - pagado
}

/** Pagos que todavía cuentan: no anulados y con algo de lo cobrado sin reembolsar. */
export function tienePagosVigentes(estado: EstadoPedido): boolean {
  return Object.values(estado.pagos).some(
    (p) =>
      !p.anulado &&
      p.monto + p.ajusteRedondeo + p.propina - p.reembolsadoVenta - p.reembolsadoPropina > 0,
  )
}
