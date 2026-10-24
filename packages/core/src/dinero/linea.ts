import { aEntero, exigirPesos, LIMITE_CANTIDAD } from './aritmetica'

export function exigirCantidad(cantidad: number): bigint {
  if (!Number.isSafeInteger(cantidad) || cantidad < 1 || cantidad > LIMITE_CANTIDAD) {
    throw new RangeError(
      `La cantidad debe ser un entero de 1 a ${LIMITE_CANTIDAD} (llegó ${cantidad})`,
    )
  }
  return BigInt(cantidad)
}

/** Precio de una unidad con sus modificadores: precio_unitario + Σ precio_extra. */
export function precioConExtras(precioUnitario: number, extras: readonly number[] = []): number {
  const suma = extras.reduce((acc, extra, i) => acc + exigirPesos(extra, `extra ${i}`), 0n)
  return aEntero(exigirPesos(precioUnitario, 'precio_unitario') + suma)
}

/** bruto_linea = cantidad × (precio_unitario + Σ precio_extra). */
export function brutoLinea(
  cantidad: number,
  precioUnitario: number,
  extras: readonly number[] = [],
): number {
  return aEntero(exigirCantidad(cantidad) * BigInt(precioConExtras(precioUnitario, extras)))
}
