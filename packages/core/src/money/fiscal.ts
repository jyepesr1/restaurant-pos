import { BASIS_POINTS, type RoundingMode, requirePesos, roundDiv, toInteger } from './arithmetic'
import { requireBasisPoints } from './discounts'

export interface Breakdown {
  /** Taxable base in hundredths of a peso. */
  baseHundredths: number
  /** Tax in hundredths of a peso. */
  taxHundredths: number
}

/**
 * Tax breakdown of a tax-inclusive net line (docs/DINERO.md#desglose-fiscal):
 * base = round(net × 100 × 10000 / (10000 + rate)) and tax = net × 100 − base, so
 * they always add up to the exact total. 40,900 at 8% → 3,787,037 + 302,963.
 */
export function breakDown(net: number, rate: number, mode?: RoundingMode): Breakdown {
  const totalHundredths = requirePesos(net, 'net') * 100n
  const base = roundDiv(
    totalHundredths * BigInt(BASIS_POINTS),
    BigInt(BASIS_POINTS) + requireBasisPoints(rate, 'rate'),
    mode,
  )
  return { baseHundredths: toInteger(base), taxHundredths: toInteger(totalHundredths - base) }
}
