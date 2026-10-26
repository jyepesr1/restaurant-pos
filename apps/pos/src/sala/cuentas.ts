import {
  allocateTip,
  type CashRoundingMode,
  type ChargedByMethod,
  chargedInCash,
  chargedInShift,
  checkBalance,
  checkPendingTip,
  equalParts,
  itemTotals,
  METHOD_NAME,
  methodName as nombreDelMedio,
  type OrderState,
  orderTip,
  orderTotals,
  type PaymentMethod,
  requirePesos,
  shiftReconciliation,
  splitByItems,
} from '@pos/core'
import type { Catalog, LocalEvent } from '@pos/sync'

// Precuenta, división y cobro (tarea 1.6, docs/DINERO.md): cada monto sale del código de dinero
// de `@pos/core` con las reglas del restaurante que trae la carta. Las pantallas solo muestran lo
// que se calcula aquí.

export type ReglasCobro = NonNullable<Catalog['restaurant']['checkout']>

/** Una opción del cobro: un medio, la tarjeta crédito o débito, o un medio propio. */
export interface OpcionCobro {
  key: string
  name: string
  method: PaymentMethod
  tipoTarjeta: 'credit' | 'debit' | null
  customMethodId: string | null
}

/**
 * Lo que sale al cobrar, en este orden: los medios habilitados (la tarjeta, como crédito y como
 * débito) y después los propios del restaurante (tarea 1.6).
 */
export function opcionesDeCobro(rules: ReglasCobro): OpcionCobro[] {
  const options: OpcionCobro[] = []
  const base = { tipoTarjeta: null, customMethodId: null }
  for (const method of rules.paymentMethods) {
    if (method === 'card') {
      options.push(
        { ...base, key: 'credit', name: 'Tarjeta crédito', method, tipoTarjeta: 'credit' },
        { ...base, key: 'debit', name: 'Tarjeta débito', method, tipoTarjeta: 'debit' },
      )
    } else options.push({ ...base, key: method, name: METHOD_NAME[method], method })
  }
  for (const m of rules.customMethods ?? [])
    options.push({ ...base, key: m.id, name: m.name, method: 'other', customMethodId: m.id })
  return options
}

/** El nombre de un medio en un pago: el propio por su nombre (aunque esté archivado, «Otro»). */
export const methodName = (
  method: PaymentMethod,
  customMethodId: string | null | undefined,
  rules: ReglasCobro | null,
) =>
  nombreDelMedio(method, customMethodId, [
    ...(rules?.customMethods ?? []),
    ...(rules?.archivedCustomMethods ?? []),
  ])

/** «INC 8 %», «IVA 19 %», «Exento» (el mismo nombre que la precuenta impresa). */
export function taxName(type: 'inc' | 'iva' | 'exempt', rate: number): string {
  if (type === 'exempt' || rate === 0) return 'Exento'
  return `${type.toUpperCase()} ${`${rate / 100}`.replace('.', ',')} %`
}

/** Las reglas del cobro del restaurante; un hub de antes de la 1.6 no las manda. */
export const reglasDe = (catalog: Catalog | null): ReglasCobro | null =>
  catalog?.restaurant.checkout ?? null

const configDe = (r: ReglasCobro) => ({
  suggested_tip: r.suggestedTip,
  rounding_mode: r.roundingMode,
})

/** Propina sugerida de `monto` del pedido (el saldo, una cuenta o lo que se cobra ahora). */
export const propinaSugeridaDe = (order: OrderState, amount: number, rules: ReglasCobro) =>
  amount <= 0 ? 0 : orderTip(order, amount, configDe(rules))

/**
 * En efectivo, la propina se sugiere redondeada al múltiplo del efectivo para que se pueda pagar
 * con billetes; el cajero la puede cambiar. Con los demás medios va exacta (DINERO.md).
 */
export const propinaParaEfectivo = (tip: number, rules: ReglasCobro) =>
  chargedInCash(tip, rules.cashRounding, rules.cashRoundingMode)

/**
 * La propina sugerida de un pago de `valor` sobre lo que falta (`disponible`): la propina de lo
 * que falta antes del pago menos la de lo que faltará después. Así los pagos parciales suman la
 * propina entera, sin un peso de más por redondeo (docs/DINERO.md#propina-sugerida).
 */
export function propinaDePago(
  order: OrderState,
  check: { amount: number; suggestedTip: number } | null,
  available: number,
  value: number,
  rules: ReglasCobro,
): number {
  if (value <= 0 || value > available) return 0
  const pending = (balance: number) =>
    check ? checkPendingTip(check, balance) : propinaSugeridaDe(order, balance, rules)
  return Math.max(0, pending(available) - pending(available - value))
}

/**
 * La propina de un pago con otro porcentaje (5 %, 15 %…) en puntos básicos, por la misma regla
 * que la sugerida: sobre la base sin impuestos de lo que se cobra.
 */
export const propinaConPorcentaje = (
  order: OrderState,
  available: number,
  value: number,
  puntos: number,
  rules: ReglasCobro,
) => propinaDePago(order, null, available, value, { ...rules, suggestedTip: puntos })

/** Una línea de la precuenta: lo que sigue en pie, con su neto. */
export interface LineaCuenta {
  id: string
  quantity: number
  name: string
  options: string[]
  net: number
}

export function linesOf(order: OrderState): LineaCuenta[] {
  return Object.values(order.items)
    .filter((i) => i.status !== 'voided' && i.quantity > i.voidedQuantity)
    .sort((a, b) => a.position - b.position)
    .map((i) => ({
      id: i.id,
      quantity: i.quantity - i.voidedQuantity,
      name: i.name,
      options: i.modifiers.map((m) => m.name),
      net: itemTotals(order, i).net,
    }))
}

/** Una cuenta de un pedido dividido, con lo que le falta pagar. */
export interface CuentaVisible {
  id: string
  name: string
  amount: number
  balance: number
  /** La propina fijada al dividir. */
  suggestedTip: number
  /** Lo que falta de esa propina, según lo que falta de la cuenta. */
  propinaPendiente: number
}

/**
 * Lo que queda por cobrar: las cuentas de la división con su saldo y, aparte, lo que no quedó en
 * ninguna cuenta (agregado después de dividir, o lo que no se repartió).
 */
export function porCobrar(order: OrderState): {
  balance: number
  checks: CuentaVisible[]
  unassigned: number
} {
  const { balance } = orderTotals(order)
  if (!order.checks) return { balance, checks: [], unassigned: 0 }
  const checks = order.checks
    .map((c) => ({
      id: c.id,
      name: c.name,
      amount: c.amount,
      balance: Math.max(0, checkBalance(order, c.id) ?? 0),
      suggestedTip: c.suggestedTip,
    }))
    .map((c) => ({ ...c, propinaPendiente: checkPendingTip(c, c.balance) }))
  const inChecks = checks.reduce((a, c) => a + c.balance, 0)
  return { balance, checks, unassigned: Math.max(0, balance - inChecks) }
}

/** Los datos de `CheckSplit`: montos fijos y la propina de cada cuenta. */
export interface CuentaNueva {
  check_id: string
  name: string
  amount: number
  suggested_tip: number
  items: { item_id: string; fraction: { n: number; d: number } }[]
}

/**
 * La propina de cada cuenta: la de lo que se divide, repartida en proporción a lo que paga cada
 * una (DINERO.md#propina-sugerida).
 */
function conPropinas(order: OrderState, amounts: readonly number[], rules: ReglasCobro): number[] {
  const total = amounts.reduce((a, m) => a + m, 0)
  return total === 0
    ? amounts.map(() => 0)
    : allocateTip(propinaSugeridaDe(order, total, rules), amounts)
}

/** El saldo en `personas` partes iguales por mayor residuo (100.000 ÷ 3 = 33.334 + 33.333 + 33.333). */
export function enPartesIguales(
  order: OrderState,
  people: number,
  rules: ReglasCobro,
  newId: () => string,
): CuentaNueva[] {
  const { balance } = orderTotals(order)
  const amounts = equalParts(balance, people)
  const tips = conPropinas(order, amounts, rules)
  return amounts.map((amount, i) => ({
    check_id: newId(),
    name: `Persona ${i + 1}`,
    amount,
    suggested_tip: tips[i] ?? 0,
    items: [],
  }))
}

/**
 * Cada producto a la cuenta que lo paga; uno que tocan varias cuentas se reparte entre ellas en
 * partes iguales. Lo que nadie toma queda sin asignar y se cobra aparte. Solo antes del primer
 * pago: después se divide el saldo en partes iguales (DINERO.md#división-de-la-cuenta).
 */
export function porProductos(
  order: OrderState,
  asignadas: ReadonlyMap<string, readonly number[]>,
  checks: number,
  rules: ReglasCobro,
  newId: () => string,
): { checks: CuentaNueva[]; unassigned: number } {
  const lines = linesOf(order)
  // Un producto que otro equipo anuló mientras se dividía ya no cuenta.
  const currentOnes = new Set(lines.map((l) => l.id))
  const assignments = [...asignadas]
    .filter(([itemId]) => currentOnes.has(itemId))
    .flatMap(([itemId, de]) =>
      de
        .filter((c) => c < checks)
        .map((check, _i, allRows) => ({ check, itemId, fraction: { n: 1, d: allRows.length } })),
    )
  const { amounts, unassigned } = splitByItems(
    lines.map((l) => ({ itemId: l.id, net: l.net })),
    assignments,
    checks,
  )
  const tips = conPropinas(order, amounts, rules)
  return {
    checks: amounts.map((amount, i) => ({
      check_id: newId(),
      name: `Cuenta ${i + 1}`,
      amount,
      suggested_tip: tips[i] ?? 0,
      items: assignments
        .filter((a) => a.check === i)
        .map((a) => ({ item_id: a.itemId, fraction: a.fraction })),
    })),
    unassigned,
  }
}

/** Al quitar cuentas, lo de las que ya no existen vuelve a «sin asignar». */
export function recortarAsignaciones(
  asignadas: ReadonlyMap<string, readonly number[]>,
  checks: number,
): Map<string, number[]> {
  const newOnes = new Map<string, number[]>()
  for (const [item, de] of asignadas) {
    const quedan = de.filter((c) => c < checks)
    if (quedan.length > 0) newOnes.set(item, quedan)
  }
  return newOnes
}

export interface CalculoEfectivo {
  /** Lo que se cobra por la venta: el monto, redondeado solo si deja el saldo en 0. */
  charged: number
  adjustment: number
  /** Venta + propina: lo mínimo que entrega el cliente. */
  aEntregar: number
  change: number
  /** Lo que falta si lo recibido no alcanza (0 si alcanza). */
  missing: number
  /** La regla de redondeo que va en el evento, solo en el pago que deja el saldo en 0. */
  rounding: { multiple: number; mode: CashRoundingMode } | null
}

/**
 * Un pago en efectivo (DINERO.md#pagos): `recibido = monto + rounding_adjustment + propina + cambio`.
 * El redondeo va solo en el pago que deja el saldo en 0 (`saldo` es el disponible de la cuenta).
 */
export function pagoEnEfectivo(
  p: { balance: number; amount: number; tip: number; tendered: number },
  rules: ReglasCobro,
): CalculoEfectivo {
  for (const [name, value] of Object.entries(p)) requirePesos(value, name)
  if (p.amount <= 0 || p.amount > p.balance)
    throw new RangeError(`El monto debe ser mayor que 0 y no pasar del saldo (${p.balance})`)
  const closes = p.amount === p.balance
  const charged = closes
    ? chargedInCash(p.balance, rules.cashRounding, rules.cashRoundingMode)
    : p.amount
  const aEntregar = charged + p.tip
  const sobra = p.tendered - aEntregar
  return {
    charged,
    adjustment: charged - p.amount,
    aEntregar,
    change: Math.max(0, sobra),
    missing: Math.max(0, -sobra),
    rounding:
      closes && charged !== p.amount
        ? { multiple: rules.cashRounding, mode: rules.cashRoundingMode }
        : null,
  }
}

/** El turno abierto de una caja (tarea 1.6): el último `ShiftOpened` vigente de ese equipo. */
export interface TurnoVisible {
  id: string
  base: number
  openedAt: string
  /** Aún no lo confirma el hub. */
  porConfirmar: boolean
}

export function turnoDeCaja(
  locals: readonly LocalEvent[],
  registerId: string,
): TurnoVisible | null {
  // Un turno con su cierre confirmado ya no está abierto (tarea 1.7); uno pendiente sigue abierto
  // hasta que el hub lo acepte, por si lo rechaza.
  const closedIds = new Set(
    locals
      .filter((l) => l.event.type === 'ShiftClosed' && l.status === 'confirmed')
      .map((l) => l.event.aggregate_id),
  )
  let shift: TurnoVisible | null = null
  for (const l of locals) {
    if (closedIds.has(l.event.aggregate_id)) continue
    const e = l.event
    if (e.type !== 'ShiftOpened' || e.data.register_id !== registerId) continue
    if (l.status !== 'confirmed' && l.status !== 'pending') continue
    const candidate = {
      id: e.aggregate_id,
      base: e.data.base,
      openedAt: e.received_at ?? e.hub_estimated_time,
      porConfirmar: l.status === 'pending',
    }
    if (!shift || candidate.openedAt > shift.openedAt) shift = candidate
  }
  return shift
}

/** Lo cobrado en un turno, por medio de pago (el cálculo es de `@pos/core`, igual al del hub). */
export interface ResumenTurno {
  byMethod: ChargedByMethod[]
  payments: number
}

export function resumenTurno(locals: readonly LocalEvent[], shiftId: string): ResumenTurno {
  const byMethod = chargedInShift(vigentesDe(locals), shiftId)
  return { byMethod, payments: byMethod.reduce((a, m) => a + m.payments, 0) }
}

/** El cuadre del turno con lo guardado aquí (confirmado y pendiente). */
export const cuadreDeCaja = (locals: readonly LocalEvent[], shiftId: string) =>
  shiftReconciliation(vigentesDe(locals), shiftId)

const vigentesDe = (locals: readonly LocalEvent[]) =>
  locals.filter((l) => l.status === 'confirmed' || l.status === 'pending').map((l) => l.event)
