import {
  brutoLinea,
  cobradoEnEfectivo,
  configCompleta,
  dividirPorItems,
  exigirPesos,
  LIMITE_TOTAL_PEDIDO,
  partesIguales,
  propinaSugerida,
  repartirPropina,
} from '@pos/core'

// Cálculos de la cuenta para los bocetos, con el código de dinero real de `@pos/core`
// (docs/DINERO.md): las pantallas solo muestran lo que sale de aquí.

/** La configuración del piloto (Restaurante.config con sus valores por defecto). */
export const CONFIG = configCompleta()

/**
 * Tarifa del INC de todos los productos del piloto, en puntos básicos — (validar) con el
 * contador. En la Fase 1 cada ítem lleva la copia de la tarifa de su `Impuesto`.
 */
export const TARIFA_INC = 800

export interface LineaCuenta {
  id: string
  cantidad: number
  precioUnitario: number
  extras: readonly number[]
}

export const netoLinea = (l: LineaCuenta) => brutoLinea(l.cantidad, l.precioUnitario, l.extras)

export function totalCuenta(lineas: readonly LineaCuenta[]): number {
  const total = lineas.reduce((suma, l) => suma + netoLinea(l), 0)
  if (total > LIMITE_TOTAL_PEDIDO) throw new RangeError('El pedido pasa del límite')
  return total
}

/** Lo que falta por pagar: el total menos lo que cancelan los pagos hechos. */
export const saldoDe = (total: number, pagos: readonly { monto: number }[]) =>
  total - pagos.reduce((s, p) => s + p.monto, 0)

/**
 * Propina sugerida sobre la base sin INC del saldo que se va a pagar (DINERO.md#propina-sugerida).
 * Con una sola tarifa en el pedido, la base del saldo es la del total menos lo pagado.
 */
export const propinaSobre = (saldo: number) =>
  saldo <= 0
    ? 0
    : propinaSugerida(
        [{ neto: saldo, tarifa: TARIFA_INC }],
        CONFIG.propina_sugerida,
        CONFIG.redondeo_modo,
      )

/**
 * En efectivo la propina se sugiere redondeada al múltiplo del efectivo ($100, la mitad a favor del
 * cliente) para que se pueda pagar con billetes; el cajero la puede cambiar (decisión del dueño,
 * 24-oct-2026). Con tarjeta queda exacta. La propina no es venta: no toca el documento DIAN.
 */
export const propinaParaEfectivo = (propina: number) =>
  cobradoEnEfectivo(propina, CONFIG.redondeo_efectivo, CONFIG.redondeo_efectivo_modo)

export const enPartesIguales = (saldo: number, personas: number) => partesIguales(saldo, personas)

/** Cada ítem a una cuenta; un ítem que toman varias, en partes iguales entre ellas. */
export function porItems(
  lineas: readonly LineaCuenta[],
  asignadas: ReadonlyMap<string, readonly number[]>,
  cuentas: number,
) {
  return dividirPorItems(
    lineas.map((l) => ({ itemId: l.id, neto: netoLinea(l) })),
    [...asignadas].flatMap(([itemId, deCuentas]) =>
      deCuentas.map((cuenta) => ({ cuenta, itemId, fraccion: { n: 1, d: deCuentas.length } })),
    ),
    cuentas,
  )
}

/** La propina de cada cuenta: la del saldo dividido, en proporción a lo que paga cada una. */
export const propinasDeCuentas = (montos: readonly number[]) => {
  const total = montos.reduce((s, m) => s + m, 0)
  return total === 0 ? montos.map(() => 0) : repartirPropina(propinaSobre(total), montos)
}

/** Al quitar cuentas, lo asignado a las que ya no existen vuelve a "sin asignar". */
export function recortarAsignaciones(
  asignadas: ReadonlyMap<string, readonly number[]>,
  cuentas: number,
): Map<string, number[]> {
  const nuevas = new Map<string, number[]>()
  for (const [item, de] of asignadas) {
    const quedan = de.filter((c) => c < cuentas)
    if (quedan.length > 0) nuevas.set(item, quedan)
  }
  return nuevas
}

export interface PagoEnEfectivo {
  /** Lo que se cobra por la venta: el monto, redondeado solo si deja el saldo en 0. */
  cobrado: number
  ajuste: number
  /** Venta + propina: lo que el cliente debe entregar como mínimo. */
  aEntregar: number
  cambio: number
  /** Lo que falta si lo recibido no alcanza (0 si alcanza). */
  falta: number
}

/**
 * Un pago en efectivo (DINERO.md#pagos): `recibido = monto + ajuste_redondeo + propina + cambio`.
 * El redondeo a $100 va solo en el pago que deja el saldo en 0.
 */
export function pagoEnEfectivo(p: {
  saldo: number
  monto: number
  propina: number
  recibido: number
}): PagoEnEfectivo {
  for (const [nombre, valor] of Object.entries(p)) exigirPesos(valor, nombre)
  if (p.monto <= 0 || p.monto > p.saldo)
    throw new RangeError(`El monto debe ser mayor que 0 y no pasar del saldo (${p.saldo})`)
  const cobrado =
    p.monto === p.saldo
      ? cobradoEnEfectivo(p.saldo, CONFIG.redondeo_efectivo, CONFIG.redondeo_efectivo_modo)
      : p.monto
  const aEntregar = cobrado + p.propina
  const sobra = p.recibido - aEntregar
  return {
    cobrado,
    ajuste: cobrado - p.monto,
    aEntregar,
    cambio: Math.max(0, sobra),
    falta: Math.max(0, -sobra),
  }
}

/** Con datáfono, `monto + propina` es lo que debe aprobar (DINERO.md#pagos). */
export function pagoConTarjeta(p: { saldo: number; monto: number; propina: number }) {
  exigirPesos(p.propina, 'propina')
  if (p.monto <= 0 || p.monto > p.saldo)
    throw new RangeError(`El monto debe ser mayor que 0 y no pasar del saldo (${p.saldo})`)
  return { aprobado: p.monto + p.propina }
}
