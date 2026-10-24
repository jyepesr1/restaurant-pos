import { exigirPesos } from './aritmetica'
import { repartir } from './reparto'

export interface LineaParaDividir {
  itemId: string
  /** Neto de la línea en pesos. */
  neto: number
}

export interface Asignacion {
  /** Índice de la cuenta (0, 1, 2…). */
  cuenta: number
  itemId: string
  /** Parte del ítem que paga esa cuenta: 1/3 de botella → { n: 1, d: 3 }. */
  fraccion: { n: number; d: number }
}

export interface ResultadoDivision {
  /** Monto de cada cuenta, en el orden de los índices. */
  montos: number[]
  /** Lo que ninguna cuenta tomó. */
  sinAsignar: number
}

const mcd = (a: number, b: number): number => (b === 0 ? a : mcd(b, a % b))

/**
 * Divide por ítems (docs/DINERO.md#división-de-la-cuenta): cada ítem se reparte por mayor
 * residuo entre las cuentas que lo toman, según su fracción; la parte no tomada va a
 * "sin asignar". Las fracciones de un mismo ítem no pueden sumar más de 1.
 */
export function dividirPorItems(
  lineas: readonly LineaParaDividir[],
  asignaciones: readonly Asignacion[],
  cuentas: number,
): ResultadoDivision {
  if (!Number.isSafeInteger(cuentas) || cuentas < 1) {
    throw new RangeError(`Debe haber al menos una cuenta (llegó ${cuentas})`)
  }
  const montos = Array.from({ length: cuentas }, () => 0)
  let sinAsignar = 0
  const conocidos = new Set(lineas.map((l) => l.itemId))
  for (const a of asignaciones) {
    if (!conocidos.has(a.itemId)) throw new RangeError(`El ítem ${a.itemId} no está en el pedido`)
    if (a.cuenta < 0 || a.cuenta >= cuentas) throw new RangeError(`No existe la cuenta ${a.cuenta}`)
  }

  for (const { itemId, neto } of lineas) {
    exigirPesos(neto, 'neto')
    const propias = asignaciones.filter((a) => a.itemId === itemId)
    if (propias.length === 0) {
      sinAsignar += neto
      continue
    }
    // Llevar todas las fracciones a un denominador común para repartir por enteros.
    const comun = propias.reduce((d, a) => (d / mcd(d, a.fraccion.d)) * a.fraccion.d, 1)
    const pesos = propias.map((a) => (a.fraccion.n * comun) / a.fraccion.d)
    const tomado = pesos.reduce((x, y) => x + y, 0)
    if (tomado > comun) throw new RangeError(`Las fracciones del ítem ${itemId} suman más de 1`)

    const partes = repartir(neto, [...pesos, comun - tomado])
    propias.forEach((a, i) => {
      montos[a.cuenta] = (montos[a.cuenta] ?? 0) + (partes[i] ?? 0)
    })
    sinAsignar += partes.at(-1) ?? 0
  }
  return { montos, sinAsignar }
}
