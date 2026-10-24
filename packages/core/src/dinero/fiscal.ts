import { aEntero, exigirPesos, type ModoRedondeo, PUNTOS_BASICOS, redondear } from './aritmetica'
import { exigirPuntosBasicos } from './descuentos'

export interface Desglose {
  /** Base gravable en centésimas de peso. */
  baseCentesimas: number
  /** Impuesto en centésimas de peso. */
  impuestoCentesimas: number
}

/**
 * Desglose fiscal de una línea neta con impuesto incluido (docs/DINERO.md#desglose-fiscal):
 * base = redondeo(neto × 100 × 10000 / (10000 + tarifa)) e impuesto = neto × 100 − base, así
 * que siempre suman el total exacto. 40.900 al 8 % → 3.787.037 + 302.963.
 */
export function desglosar(neto: number, tarifa: number, modo?: ModoRedondeo): Desglose {
  const totalCentesimas = exigirPesos(neto, 'neto') * 100n
  const base = redondear(
    totalCentesimas * BigInt(PUNTOS_BASICOS),
    BigInt(PUNTOS_BASICOS) + exigirPuntosBasicos(tarifa, 'tarifa'),
    modo,
  )
  return { baseCentesimas: aEntero(base), impuestoCentesimas: aEntero(totalCentesimas - base) }
}
