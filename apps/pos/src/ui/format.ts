// Screen formats. Money always arrives in whole pesos (ADR-004).

const copFormat = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 })

/** 40900 → "$40.900"; -1500 → "-$1.500". An amount with decimals is a programming error. */
export function pesos(amount: number): string {
  if (!Number.isSafeInteger(amount)) throw new RangeError(`Monto inválido: ${amount}`)
  return `${amount < 0 ? '-' : ''}$${copFormat.format(Math.abs(amount))}`
}

/** Elapsed minutes, for tables and tickets: "8 min", "1 h 05". */
export function minutes(total: number): string {
  const m = Math.max(0, Math.floor(total))
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/** What was typed in a money field, as whole pesos: «46.350» → 46350 (up to 9 digits). */
export const digitsOnly = (text: string) => Number(text.replace(/\D/g, '').slice(0, 9)) || 0

/** Pesos for an editable field, without sign: 46350 → «46.350»; 0 → empty. */
export const withDots = (n: number) => (n ? n.toLocaleString('es-CO') : '')
