import { aEntero, exigirPesos } from './aritmetica'

export type ModoRedondeoEfectivo =
  | 'cercano_mitad_abajo'
  | 'cercano_mitad_arriba'
  | 'abajo'
  | 'arriba'

/**
 * Lo que se cobra en efectivo por un saldo, redondeado al múltiplo `m`
 * (docs/DINERO.md#pagos). Con el modo por defecto, la mitad va a favor del cliente:
 * 36.810 → 36.800; 36.850 → 36.800; 36.851 → 36.900; 50 → 0.
 */
export function cobradoEnEfectivo(
  saldo: number,
  multiplo: number,
  modo: ModoRedondeoEfectivo = 'cercano_mitad_abajo',
): number {
  const s = exigirPesos(saldo, 'saldo')
  const m = exigirPesos(multiplo, 'múltiplo')
  if (m <= 1n) return aEntero(s)
  switch (modo) {
    case 'cercano_mitad_abajo':
      return aEntero(m * ((2n * s + m - 1n) / (2n * m)))
    case 'cercano_mitad_arriba':
      return aEntero(m * ((2n * s + m) / (2n * m)))
    case 'abajo':
      return aEntero(m * (s / m))
    case 'arriba':
      return aEntero(m * ((s + m - 1n) / m))
  }
}

export interface PagoEfectivo {
  monto: number
  ajusteRedondeo: number
  propina: number
  recibido: number
  cambio: number
}

/** recibido = monto + ajuste_redondeo + propina + cambio, con cambio ≥ 0. */
export function cuadraEfectivo({
  monto,
  ajusteRedondeo,
  propina,
  recibido,
  cambio,
}: PagoEfectivo): boolean {
  return cambio >= 0 && recibido === monto + ajusteRedondeo + propina + cambio
}
