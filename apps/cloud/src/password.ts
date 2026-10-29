import { Buffer } from 'node:buffer'
import { scrypt, timingSafeEqual } from 'node:crypto'

// Checking the panel password against the verifier the hub uploads (ADR-013, amendment of
// 29-oct-2026). The format and the parameters are the hub's (`apps/hub/src/access/secrets.ts`):
// `scrypt$cost$r$p$salt$hash`. The check is copied, not imported: the cloud does not depend on
// the hub. With `node:crypto` (nodejs_compat in Workers).

const scryptOptions = (cost: number) => ({
  N: 2 ** cost,
  r: 8,
  p: 1,
  // scrypt uses 128·N·r bytes; double that leaves headroom without going overboard.
  maxmem: Math.max(32 * 1024 * 1024, 2 * 128 * 2 ** cost * 8),
})

const derive = (password: string, salt: Buffer, length: number, cost: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, length, scryptOptions(cost), (e, key) =>
      e ? reject(e) : resolve(key),
    ),
  )

/** Whether the password produces that verifier, compared in constant time. */
export async function passwordMatches(password: string, saved: string): Promise<boolean> {
  const [schema, cost, r, p, salt, fingerprint] = saved.split('$')
  if (schema !== 'scrypt' || !salt || !fingerprint || r !== '8' || p !== '1') return false
  const n = Number(cost)
  // Up to 2^17 (128 MiB): more would not fit in a Worker's memory.
  if (!Number.isInteger(n) || n < 1 || n > 17) return false
  const expected = Buffer.from(fingerprint, 'base64url')
  const computed = await derive(password, Buffer.from(salt, 'base64url'), expected.length, n)
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

/**
 * A verifier no password matches, with the hub's cost (2^15): when the user does not exist the same
 * hash is computed, so the answer takes the same time.
 */
export const DECOY_VERIFIER =
  'scrypt$15$8$1$ZmFyby1wYW5lbC1yZWxsZW5v$6ZpCqx9yD0mN8QfQ3bS2kV1u7wL4rT5eH0aJ9cX2gYs'

/**
 * The username as the hub stores it: trimmed, lowercase and without accents; only letters, digits,
 * dot, hyphen and underscore, 3 to 40 long. `null` if it is not valid. (Copy of the hub's.)
 */
export function normalizeUsername(user: string): string | null {
  const u = user
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  return /^[a-z0-9._-]{3,40}$/.test(u) ? u : null
}
