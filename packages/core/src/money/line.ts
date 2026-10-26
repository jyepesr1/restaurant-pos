import { QUANTITY_LIMIT, requirePesos, toInteger } from './arithmetic'

export function requireQuantity(quantity: number): bigint {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > QUANTITY_LIMIT) {
    throw new RangeError(
      `La cantidad debe ser un entero de 1 a ${QUANTITY_LIMIT} (llegó ${quantity})`,
    )
  }
  return BigInt(quantity)
}

/** Price of one unit with its modifiers: unit_price + Σ extra_price. */
export function priceWithExtras(unitPrice: number, extras: readonly number[] = []): number {
  const sum = extras.reduce((acc, extra, i) => acc + requirePesos(extra, `extra ${i}`), 0n)
  return toInteger(requirePesos(unitPrice, 'unit_price') + sum)
}

/** line_gross = quantity × (unit_price + Σ extra_price). */
export function lineGross(
  quantity: number,
  unitPrice: number,
  extras: readonly number[] = [],
): number {
  return toInteger(requireQuantity(quantity) * BigInt(priceWithExtras(unitPrice, extras)))
}
