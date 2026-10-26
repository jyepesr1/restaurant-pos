import { canonicalJson } from '@pos/core'

export { canonicalJson, MAX_DEPTH } from '@pos/core'

/** 64-bit FNV-1a fingerprint of a text. Not cryptographic. */
export function textFingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

/** Fingerprint of a value's canonical content. Throws `RangeError` if it is nested too deeply. */
export function fingerprint(value: unknown): string {
  return textFingerprint(canonicalJson(value))
}

/**
 * Fingerprint of an event for idempotency (docs/SYNC.md#flujo-de-una-acción): detects that the
 * same id arrived with different content. It excludes `base_sequence`, which is not part of what
 * happened but of what the device knew, and which the device lowers to 0 when resending to a
 * restored hub. It also excludes the `signature`, which is not stored with the event: what comes
 * back from the hub does not carry it.
 */
export function eventFingerprint(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fingerprint(raw)
  const { base_sequence: _base, signature: _signature, ...rest } = raw as Record<string, unknown>
  return fingerprint(rest)
}
