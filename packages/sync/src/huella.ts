import { jsonCanonico } from '@pos/core'

export { jsonCanonico, PROFUNDIDAD_MAXIMA } from '@pos/core'

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
 * restaurado. Tampoco la `firma`, que no se guarda con el evento: lo que vuelve del hub no la
 * trae.
 */
export function huellaEvento(crudo: unknown): string {
  if (typeof crudo !== 'object' || crudo === null || Array.isArray(crudo)) return huella(crudo)
  const { secuencia_base: _base, firma: _firma, ...resto } = crudo as Record<string, unknown>
  return huella(resto)
}
