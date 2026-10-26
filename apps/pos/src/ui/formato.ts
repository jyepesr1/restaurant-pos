// Formatos de pantalla. El dinero siempre llega en pesos enteros (ADR-004).

const pesosCo = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 })

/** 40900 → "$40.900"; -1500 → "-$1.500". Un monto con decimales es un error de programa. */
export function pesos(monto: number): string {
  if (!Number.isSafeInteger(monto)) throw new RangeError(`Monto inválido: ${monto}`)
  return `${monto < 0 ? '-' : ''}$${pesosCo.format(Math.abs(monto))}`
}

/** Minutos transcurridos, para mesas y comandas: "8 min", "1 h 05". */
export function minutos(total: number): string {
  const m = Math.max(0, Math.floor(total))
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/** Lo escrito en un campo de dinero, como pesos enteros: «46.350» → 46350 (hasta 9 cifras). */
export const soloDigitos = (texto: string) => Number(texto.replace(/\D/g, '').slice(0, 9)) || 0

/** Pesos para un campo editable, sin signo: 46350 → «46.350»; 0 → vacío. */
export const conPuntos = (n: number) => (n ? n.toLocaleString('es-CO') : '')
