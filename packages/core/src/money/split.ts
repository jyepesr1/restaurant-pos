import { allocate } from './allocation'
import { requirePesos } from './arithmetic'

export interface SplittableLine {
  itemId: string
  /** Net of the line in pesos. */
  net: number
}

export interface Assignment {
  /** Index of the check (0, 1, 2…). */
  check: number
  itemId: string
  /** Share of the item that check pays: 1/3 of a bottle → { n: 1, d: 3 }. */
  fraction: { n: number; d: number }
}

export interface SplitResult {
  /** Amount of each check, in index order. */
  amounts: number[]
  /** What no check took. */
  unassigned: number
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * Splits by items (docs/DINERO.md#división-de-la-cuenta): each item is allocated by largest
 * remainder among the checks that take it, by their fraction; the part not taken goes to
 * "unassigned". The fractions of one item cannot add up to more than 1.
 */
export function splitByItems(
  lines: readonly SplittableLine[],
  assignments: readonly Assignment[],
  checks: number,
): SplitResult {
  if (!Number.isSafeInteger(checks) || checks < 1) {
    throw new RangeError(`Debe haber al menos una cuenta (llegó ${checks})`)
  }
  const amounts = Array.from({ length: checks }, () => 0)
  let unassigned = 0
  const knownItemIds = new Set(lines.map((l) => l.itemId))
  for (const a of assignments) {
    if (!knownItemIds.has(a.itemId))
      throw new RangeError(`El ítem ${a.itemId} no está en el pedido`)
    if (a.check < 0 || a.check >= checks) throw new RangeError(`No existe la cuenta ${a.check}`)
  }

  for (const { itemId, net } of lines) {
    requirePesos(net, 'net')
    const ownShares = assignments.filter((a) => a.itemId === itemId)
    if (ownShares.length === 0) {
      unassigned += net
      continue
    }
    // Bring all fractions to a common denominator to allocate in integers.
    const common = ownShares.reduce((d, a) => (d / gcd(d, a.fraction.d)) * a.fraction.d, 1)
    const pesos = ownShares.map((a) => (a.fraction.n * common) / a.fraction.d)
    const taken = pesos.reduce((x, y) => x + y, 0)
    if (taken > common) throw new RangeError(`Las fracciones del ítem ${itemId} suman más de 1`)

    const parts = allocate(net, [...pesos, common - taken])
    ownShares.forEach((a, i) => {
      amounts[a.check] = (amounts[a.check] ?? 0) + (parts[i] ?? 0)
    })
    unassigned += parts.at(-1) ?? 0
  }
  return { amounts, unassigned }
}
