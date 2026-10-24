import { aEntero, exigirPesos } from './aritmetica'

/**
 * Reparte `total` en partes proporcionales a `pesos` por mayor residuo: las partes suman
 * exactamente el total. Los empates se resuelven por orden (la primera parte gana). Si todos
 * los pesos son 0, reparte en partes iguales.
 */
export function repartir(total: number, pesos: readonly number[]): number[] {
  const t = exigirPesos(total, 'total')
  if (pesos.length === 0) {
    if (t === 0n) return []
    throw new RangeError('No se puede repartir un total entre cero partes')
  }
  const p = pesos.map((peso, i) => exigirPesos(peso, `peso ${i}`))
  const suma = p.reduce((a, b) => a + b, 0n)
  const ponderados = suma === 0n ? p.map(() => 1n) : p
  const sumaPonderada = suma === 0n ? BigInt(p.length) : suma

  const partes = ponderados.map((peso) => (t * peso) / sumaPonderada)
  const residuos = ponderados.map((peso, i) => ({
    i,
    residuo: t * peso - (partes[i] ?? 0n) * sumaPonderada,
  }))
  let faltante = t - partes.reduce((a, b) => a + b, 0n)

  residuos.sort((a, b) => (b.residuo > a.residuo ? 1 : b.residuo < a.residuo ? -1 : a.i - b.i))
  for (const { i } of residuos) {
    if (faltante === 0n) break
    partes[i] = (partes[i] ?? 0n) + 1n
    faltante -= 1n
  }
  return partes.map(aEntero)
}

/** Parte `total` en `n` partes iguales por mayor residuo: 100.000 ÷ 3 = 33.334 + 33.333 + 33.333. */
export function partesIguales(total: number, n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 1)
    throw new RangeError(`n debe ser un entero ≥ 1 (llegó ${n})`)
  return repartir(
    total,
    Array.from({ length: n }, () => 1),
  )
}
