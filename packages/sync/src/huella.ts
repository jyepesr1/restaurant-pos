/** Más anidado que esto no es un evento: se rechaza sin recorrerlo (evita agotar la pila). */
export const PROFUNDIDAD_MAXIMA = 32

/** JSON con las claves ordenadas: el mismo contenido da siempre el mismo texto. */
export function jsonCanonico(valor: unknown, profundidad = 0): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor) ?? 'null'
  if (profundidad >= PROFUNDIDAD_MAXIMA) throw new RangeError('Contenido demasiado anidado')
  if (Array.isArray(valor))
    return `[${valor.map((v) => jsonCanonico(v, profundidad + 1)).join(',')}]`
  const entradas = Object.entries(valor as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonCanonico(v, profundidad + 1)}`).join(',')}}`
}

/** Huella FNV-1a de 64 bits de un texto. No es criptográfica. */
export function huellaTexto(texto: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(texto)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

/** Huella del contenido canónico de un valor. Lanza `RangeError` si está demasiado anidado. */
export function huella(valor: unknown): string {
  return huellaTexto(jsonCanonico(valor))
}

/**
 * Huella de un evento para la idempotencia (docs/SYNC.md#flujo-de-una-acción): detecta que llegó
 * un mismo id con contenido distinto. No incluye `secuencia_base`, que no es parte de lo que
 * pasó sino de lo que el dispositivo sabía, y que el dispositivo baja a 0 al reenviar a un hub
 * restaurado.
 */
export function huellaEvento(crudo: unknown): string {
  if (typeof crudo !== 'object' || crudo === null || Array.isArray(crudo)) return huella(crudo)
  const { secuencia_base: _base, ...resto } = crudo as Record<string, unknown>
  return huella(resto)
}
