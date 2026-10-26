import { aEntero, type ModoRedondeo, redondear } from '../dinero/aritmetica'
import { desglosar } from '../dinero/fiscal'
import { precioConExtras } from '../dinero/linea'
import { propinaSobreMonto } from '../dinero/propina'
import { repartir } from '../dinero/reparto'
import type { TipoImpuesto } from '../eventos/comun'
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

/**
 * Propina sugerida de `monto` de este pedido (el saldo, o la parte que se divide o se cobra):
 * sobre la base sin impuesto, neta de descuentos y anulaciones (docs/DINERO.md#propina-sugerida).
 */
export function propinaDelPedido(
  estado: EstadoPedido,
  monto: number,
  config: { propina_sugerida: number; redondeo_modo: ModoRedondeo },
): number {
  const lineas = Object.values(estado.items)
    .map((item) => ({ neto: totalesItem(estado, item).neto, tarifa: item.tarifa }))
    .filter((l) => l.neto > 0)
  return propinaSobreMonto(lineas, monto, config.propina_sugerida, config.redondeo_modo)
}

/**
 * Lo que falta de la propina de una cuenta dividida cuando le quedan `saldo` pesos: la propina
 * fijada al dividir, repartida por mayor residuo entre lo pagado y lo que falta. Así los pagos
 * parciales de una cuenta suman exactamente su propina (docs/DINERO.md#propina-sugerida).
 */
export function propinaPendienteDeCuenta(
  cuenta: { monto: number; propinaSugerida: number },
  saldo: number,
): number {
  if (saldo <= 0) return 0
  if (saldo >= cuenta.monto) return cuenta.propinaSugerida
  return repartir(cuenta.propinaSugerida, [cuenta.monto - saldo, saldo])[1] ?? 0
}

/** El impuesto de un grupo de líneas con el mismo tipo y tarifa, en pesos. */
export interface ImpuestoDiscriminado {
  tipo: TipoImpuesto
  /** Puntos básicos: 800 = 8 %. */
  tarifa: number
  /** Neto del grupo sin el impuesto. */
  base: number
  impuesto: number
}

/**
 * El impuesto discriminado del pedido, por tipo y tarifa, para la precuenta (tarea 1.6): el mismo
 * desglose por línea del documento DIAN (docs/DINERO.md#desglose-fiscal), con el impuesto de cada
 * grupo redondeado a pesos y la base como el resto, así base + impuesto da el neto exacto. Es
 * informativo: el documento DIAN lleva los decimales — (validar) con el contador.
 */
export function impuestosDelPedido(
  estado: EstadoPedido,
  modo?: ModoRedondeo,
): ImpuestoDiscriminado[] {
  const grupos = new Map<
    string,
    { tipo: TipoImpuesto; tarifa: number; neto: number; centesimas: number }
  >()
  for (const item of Object.values(estado.items)) {
    const { neto } = totalesItem(estado, item)
    if (neto <= 0) continue
    const tarifa = item.impuestoTipo === 'exento' ? 0 : item.tarifa
    const clave = `${item.impuestoTipo}:${tarifa}`
    const g = grupos.get(clave) ?? { tipo: item.impuestoTipo, tarifa, neto: 0, centesimas: 0 }
    g.neto += neto
    g.centesimas += desglosar(neto, tarifa, modo).impuestoCentesimas
    grupos.set(clave, g)
  }
  return [...grupos.values()]
    .sort((a, b) => b.neto - a.neto)
    .map((g) => {
      const impuesto = aEntero(redondear(BigInt(g.centesimas), 100n, modo))
      return { tipo: g.tipo, tarifa: g.tarifa, base: g.neto - impuesto, impuesto }
    })
}
