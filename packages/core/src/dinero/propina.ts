import {
  aEntero,
  exigirPesos,
  type Fraccion,
  type ModoRedondeo,
  PUNTOS_BASICOS,
  redondear,
  sumarFracciones,
} from './aritmetica'
import { exigirPuntosBasicos } from './descuentos'
import { repartir } from './reparto'

export interface LineaParaPropina {
  /** Neto de la línea en pesos, con impuesto incluido y descuentos ya restados. */
  neto: number
  /** Tarifa del impuesto de la línea en puntos básicos. */
  tarifa: number
}

/**
 * Propina sugerida sobre la base sin impuesto, neta de descuentos, con un solo redondeo
 * (docs/DINERO.md#propina-sugerida). $100.000 al 8 % con 10 % → 9.259; $16.000 → 1.481.
 */
export function propinaSugerida(
  lineas: readonly LineaParaPropina[],
  tasa: number,
  modo?: ModoRedondeo,
): number {
  const bp = exigirPuntosBasicos(tasa, 'tasa de propina')
  const base = lineas.reduce<Fraccion>(
    (acumulado, { neto, tarifa }) =>
      sumarFracciones(acumulado, {
        n: exigirPesos(neto, 'neto') * BigInt(PUNTOS_BASICOS),
        d: BigInt(PUNTOS_BASICOS) + exigirPuntosBasicos(tarifa, 'tarifa'),
      }),
    { n: 0n, d: 1n },
  )
  return aEntero(redondear(base.n * bp, base.d * BigInt(PUNTOS_BASICOS), modo))
}

/** Reparte la propina entre cuentas en proporción al monto de cada una. */
export function repartirPropina(propina: number, montosCuentas: readonly number[]): number[] {
  return repartir(propina, montosCuentas)
}
