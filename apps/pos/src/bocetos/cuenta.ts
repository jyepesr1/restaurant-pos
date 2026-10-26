import {
  allocateTip,
  chargedInCash,
  equalParts,
  fullConfig,
  lineGross,
  ORDER_TOTAL_LIMIT,
  requirePesos,
  splitByItems,
  suggestedTip,
} from '@pos/core'

// Cálculos de la cuenta para los bocetos, con el código de dinero real de `@pos/core`
// (docs/DINERO.md): las pantallas solo muestran lo que sale de aquí.

/** La configuración del piloto (Restaurante.config con sus valores por defecto). */
export const CONFIG = fullConfig()

/**
 * Tarifa del INC de todos los productos del piloto, en puntos básicos — (validar) con el
 * contador. En la Fase 1 cada ítem lleva la copia de la tarifa de su `Impuesto`.
 */
export const TARIFA_INC = 800

export interface LineaCuenta {
  id: string
  quantity: number
  unitPrice: number
  extras: readonly number[]
}

export const netoLinea = (l: LineaCuenta) => lineGross(l.quantity, l.unitPrice, l.extras)

export function totalCuenta(lines: readonly LineaCuenta[]): number {
  const total = lines.reduce((sum, l) => sum + netoLinea(l), 0)
  if (total > ORDER_TOTAL_LIMIT) throw new RangeError('El pedido pasa del límite')
  return total
}

/** Lo que falta por pagar: el total menos lo que cancelan los pagos hechos. */
export const saldoDe = (total: number, payments: readonly { amount: number }[]) =>
  total - payments.reduce((s, p) => s + p.amount, 0)

/**
 * Propina sugerida sobre la base sin INC del saldo que se va a pagar (DINERO.md#propina-sugerida).
 * Con una sola tarifa en el pedido, la base del saldo es la del total menos lo pagado.
 */
export const propinaSobre = (balance: number) =>
  balance <= 0
    ? 0
    : suggestedTip([{ net: balance, rate: TARIFA_INC }], CONFIG.suggested_tip, CONFIG.rounding_mode)

/**
 * En efectivo la propina se sugiere redondeada al múltiplo del efectivo ($100, la mitad a favor del
 * cliente) para que se pueda pagar con billetes; el cajero la puede cambiar (decisión del dueño,
 * 24-oct-2026). Con tarjeta queda exacta. La propina no es venta: no toca el documento DIAN.
 */
export const propinaParaEfectivo = (tip: number) =>
  chargedInCash(tip, CONFIG.cash_rounding, CONFIG.cash_rounding_mode)

export const enPartesIguales = (balance: number, people: number) => equalParts(balance, people)

/** Cada ítem a una cuenta; un ítem que toman varias, en partes iguales entre ellas. */
export function porItems(
  lines: readonly LineaCuenta[],
  asignadas: ReadonlyMap<string, readonly number[]>,
  checks: number,
) {
  return splitByItems(
    lines.map((l) => ({ itemId: l.id, net: netoLinea(l) })),
    [...asignadas].flatMap(([itemId, deCuentas]) =>
      deCuentas.map((check) => ({ check, itemId, fraction: { n: 1, d: deCuentas.length } })),
    ),
    checks,
  )
}

/** La propina de cada cuenta: la del saldo dividido, en proporción a lo que paga cada una. */
export const propinasDeCuentas = (amounts: readonly number[]) => {
  const total = amounts.reduce((s, m) => s + m, 0)
  return total === 0 ? amounts.map(() => 0) : allocateTip(propinaSobre(total), amounts)
}

// Al quitar cuentas, lo asignado a las que ya no existen vuelve a «sin asignar»: la misma regla de la
// app de operación.
export { recortarAsignaciones } from '../sala/cuentas'

export interface PagoEnEfectivo {
  /** Lo que se cobra por la venta: el monto, redondeado solo si deja el saldo en 0. */
  charged: number
  adjustment: number
  /** Venta + propina: lo que el cliente debe entregar como mínimo. */
  aEntregar: number
  change: number
  /** Lo que falta si lo recibido no alcanza (0 si alcanza). */
  missing: number
}

/**
 * Un pago en efectivo (DINERO.md#pagos): `recibido = monto + rounding_adjustment + propina + cambio`.
 * El redondeo a $100 va solo en el pago que deja el saldo en 0.
 */
export function pagoEnEfectivo(p: {
  balance: number
  amount: number
  tip: number
  tendered: number
}): PagoEnEfectivo {
  for (const [name, value] of Object.entries(p)) requirePesos(value, name)
  if (p.amount <= 0 || p.amount > p.balance)
    throw new RangeError(`El monto debe ser mayor que 0 y no pasar del saldo (${p.balance})`)
  const charged =
    p.amount === p.balance
      ? chargedInCash(p.balance, CONFIG.cash_rounding, CONFIG.cash_rounding_mode)
      : p.amount
  const aEntregar = charged + p.tip
  const sobra = p.tendered - aEntregar
  return {
    charged,
    adjustment: charged - p.amount,
    aEntregar,
    change: Math.max(0, sobra),
    missing: Math.max(0, -sobra),
  }
}

/** Con datáfono, `monto + propina` es lo que debe aprobar (DINERO.md#pagos). */
export function pagoConTarjeta(p: { balance: number; amount: number; tip: number }) {
  requirePesos(p.tip, 'tip')
  if (p.amount <= 0 || p.amount > p.balance)
    throw new RangeError(`El monto debe ser mayor que 0 y no pasar del saldo (${p.balance})`)
  return { aprobado: p.amount + p.tip }
}
