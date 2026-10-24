import { aEntero, exigirPesos, type ModoRedondeo, PUNTOS_BASICOS, redondear } from './aritmetica'
import { exigirCantidad, precioConExtras } from './linea'
import { repartir } from './reparto'

export function exigirPuntosBasicos(bp: number, nombre = 'porcentaje'): bigint {
  if (!Number.isSafeInteger(bp) || bp < 0 || bp > PUNTOS_BASICOS) {
    throw new RangeError(
      `${nombre} debe estar entre 0 y ${PUNTOS_BASICOS} puntos básicos (llegó ${bp})`,
    )
  }
  return BigInt(bp)
}

/** Porcentaje (en puntos básicos) de una base, redondeado una vez: 15 % de 12.950 = 1.943. */
export function porcentaje(base: number, bp: number, modo?: ModoRedondeo): number {
  return aEntero(
    redondear(exigirPesos(base, 'base') * exigirPuntosBasicos(bp), BigInt(PUNTOS_BASICOS), modo),
  )
}

/** Cortesía de `unidades` de una línea: unidades × (precio_unitario + Σ extras). */
export function cortesia(
  unidades: number,
  precioUnitario: number,
  extras: readonly number[] = [],
): number {
  return aEntero(exigirCantidad(unidades) * BigInt(precioConExtras(precioUnitario, extras)))
}

/**
 * Reparte un descuento del pedido entre las líneas, en proporción a lo que le queda a cada una
 * después de los descuentos ya aplicados. Devuelve `null` si el descuento supera lo que queda
 * (ninguna línea puede quedar negativa).
 */
export function repartirDescuentoPedido(
  descuento: number,
  restantes: readonly number[],
): number[] | null {
  const total = restantes.reduce((a, r, i) => a + exigirPesos(r, `restante ${i}`), 0n)
  if (exigirPesos(descuento, 'descuento') > total) return null
  if (total === 0n) return restantes.map(() => 0)
  return repartir(descuento, restantes)
}
