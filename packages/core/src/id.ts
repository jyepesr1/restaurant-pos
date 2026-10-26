import { monotonicFactory } from 'ulidx'

// Monotonic: two IDs created in the same millisecond on this device
// keep their creation order.
const generate = monotonicFactory()

// Canonical form only (uppercase, Crockford base32, first character 0-7):
// the same ID written in lowercase would be a different key and break idempotency.
const CANONICAL_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/** ULID generated on the device; works offline and without collisions. */
export function newId(): string {
  return generate()
}

export function isValidId(value: string): boolean {
  return CANONICAL_ULID.test(value)
}
