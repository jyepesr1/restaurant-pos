// Aritmética exacta para dinero (docs/DINERO.md#principios): todo con enteros, fracciones como
// numerador y denominador BigInt, y un solo redondeo al final.

/** Topes de docs/DINERO.md. */
export const LIMITE_PRECIO = 100_000_000
export const LIMITE_CANTIDAD = 999
export const LIMITE_TOTAL_PEDIDO = 10_000_000_000
export const PUNTOS_BASICOS = 10_000

/** Modo de redondeo de porcentajes y del desglose fiscal (`redondeo_modo` en la configuración). */
export type ModoRedondeo = 'mitad_arriba' | 'mitad_par'

/**
 * Redondea `a / b` (con `a ≥ 0` y `b > 0`) a entero. Por defecto, la mitad hacia arriba;
 * `mitad_par` lleva la mitad al par más cercano.
 */
export function redondear(a: bigint, b: bigint, modo: ModoRedondeo = 'mitad_arriba'): bigint {
  if (a < 0n || b <= 0n) throw new RangeError(`redondear(${a}, ${b}): se esperan a ≥ 0 y b > 0`)
  if (modo === 'mitad_arriba') return (2n * a + b) / (2n * b)
  const cociente = a / b
  const resto2 = 2n * (a % b)
  if (resto2 > b || (resto2 === b && cociente % 2n === 1n)) return cociente + 1n
  return cociente
}

/** Convierte a `number` exigiendo que sea un entero seguro. */
export function aEntero(valor: bigint): number {
  if (valor > BigInt(Number.MAX_SAFE_INTEGER) || valor < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`El valor ${valor} no cabe en un entero seguro`)
  }
  return Number(valor)
}

/** Exige un entero de pesos ≥ 0. */
export function exigirPesos(valor: number, nombre = 'monto'): bigint {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`${nombre} debe ser un entero de pesos ≥ 0 (llegó ${valor})`)
  }
  return BigInt(valor)
}

export interface Fraccion {
  n: bigint
  d: bigint
}

function mcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y > 0n) [x, y] = [y, x % y]
  return x
}

export function sumarFracciones(a: Fraccion, b: Fraccion): Fraccion {
  const n = a.n * b.d + b.n * a.d
  const d = a.d * b.d
  const divisor = mcd(n, d) || 1n
  return { n: n / divisor, d: d / divisor }
}
