import { canonicalJson } from '@pos/core'

export { canonicalJson, MAX_DEPTH } from '@pos/core'

/** Huella FNV-1a de 64 bits de un texto. No es criptográfica. */
export function huellaTexto(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

/** Huella del contenido canónico de un valor. Lanza `RangeError` si está demasiado anidado. */
export function fingerprint(value: unknown): string {
  return huellaTexto(canonicalJson(value))
}

/**
 * Huella de un evento para la idempotencia (docs/SYNC.md#flujo-de-una-acción): detecta que llegó
 * un mismo id con contenido distinto. No incluye `base_sequence`, que no es parte de lo que
 * pasó sino de lo que el dispositivo sabía, y que el dispositivo baja a 0 al reenviar a un hub
 * restaurado. Tampoco la `firma`, que no se guarda con el evento: lo que vuelve del hub no la
 * trae.
 */
export function huellaEvento(crudo: unknown): string {
  if (typeof crudo !== 'object' || crudo === null || Array.isArray(crudo)) return fingerprint(crudo)
  const { base_sequence: _base, signature: _firma, ...rest } = crudo as Record<string, unknown>
  return fingerprint(rest)
}
