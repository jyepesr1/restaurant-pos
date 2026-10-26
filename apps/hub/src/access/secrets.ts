import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// PIN, tokens and the hub key (ADR-008). None of this leaves the hub or is stored in plain text.

/** The owner's call: 4 digits, one tap less. Pairing and the wait make up for it. */
export const PIN_DIGITS = 4

/** Not all the same nor consecutive (0000, 1234, 9876): those are the first anyone would try. */
export function isTrivialPin(pin: string): boolean {
  const d = [...pin].map(Number)
  const steps = d.slice(1).map((x, i) => x - (d[i] as number))
  return steps.every((p) => p === 0) || steps.every((p) => p === 1) || steps.every((p) => p === -1)
}

/** Random PIN from the cryptographic generator; the admin does not pick it. */
export function generatePin(random: (max: number) => number = (max) => randomInt(max)): string {
  for (;;) {
    const pin = String(random(10 ** PIN_DIGITS)).padStart(PIN_DIGITS, '0')
    if (!isTrivialPin(pin)) return pin
  }
}

export const isWellFormedPin = (pin: unknown): pin is string =>
  typeof pin === 'string' && new RegExp(`^\\d{${PIN_DIGITS}}$`).test(pin)

/** PIN hash: HMAC-SHA256 with the hub key. Without the key, the hash is useless. */
export const pinHash = (key: Buffer, restaurantId: string, pin: string) =>
  createHmac('sha256', key).update(`${restaurantId}:${pin}`).digest('hex')

/** Device token: 256 random bits. */
export const newSecret = () => randomBytes(32).toString('base64url')

/**
 * A session's secret: derived from the hub key, so the hub can check event signatures without
 * storing the secret. Without the key, nobody can compute it.
 */
export const sessionSecretFor = (key: Buffer, restaurantId: string, sessionId: string) =>
  createHmac('sha256', key).update(`session:${restaurantId}:${sessionId}`).digest('base64url')

/** SHA-256 is enough: a random 256-bit secret cannot be brute-forced. */
export const secretHash = (secret: string) => createHash('sha256').update(secret).digest('hex')

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// ── Username and password (ADR-013) ───────────────────────────────────

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 200

/**
 * scrypt cost (N = 2^cost). 15 takes about 50 ms on a register PC: it slows down anyone who has
 * the database and tries passwords, without making sign-in feel slow. Tests use less.
 */
export const PASSWORD_COST = 15

/** Length is counted as stored (NFC): «ñ» is one letter even if it arrives as n + tilde. */
export const isValidPassword = (c: string) => {
  const n = c.normalize('NFC').length
  return n >= PASSWORD_MIN_LENGTH && n <= PASSWORD_MAX_LENGTH
}

/**
 * The username as stored: trimmed, lowercase and without accents («María» is «maria»); only
 * letters, digits, dot, hyphen and underscore, 3 to 40 long. `null` if it is not valid.
 */
export function normalizeUsername(user: string): string | null {
  const u = user
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  return /^[a-z0-9._-]{3,40}$/.test(u) ? u : null
}

/** Slow salted hash: `scrypt$cost$r$p$salt$hash`, everything needed to check it. */
export function passwordHash(password: string, cost = PASSWORD_COST): string {
  const salt = randomBytes(16)
  const fingerprint = scryptSync(password.normalize('NFC'), salt, 32, scryptOptions(cost))
  return ['scrypt', cost, 8, 1, salt.toString('base64url'), fingerprint.toString('base64url')].join(
    '$',
  )
}

/** Whether the password produces that hash, compared in constant time. */
export function passwordMatches(password: string, saved: string): boolean {
  const [schema, cost, r, p, salt, fingerprint] = saved.split('$')
  if (schema !== 'scrypt' || !salt || !fingerprint || r !== '8' || p !== '1') return false
  const n = Number(cost)
  if (!Number.isInteger(n) || n < 1 || n > 20) return false
  const expected = Buffer.from(fingerprint, 'base64url')
  const computed = scryptSync(
    password.normalize('NFC'),
    Buffer.from(salt, 'base64url'),
    expected.length,
    scryptOptions(n),
  )
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

const scryptOptions = (cost: number) => ({
  N: 2 ** cost,
  r: 8,
  p: 1,
  // scrypt uses 128·N·r bytes; double that leaves headroom without going overboard.
  maxmem: Math.max(32 * 1024 * 1024, 2 * 128 * 2 ** cost * 8),
})

/** No look-alike letters: the admin's first password is copied from the window. */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Three groups of four (`k7mp-x9rt-4hwa`): about 59 bits, easy to copy by hand. */
export function generatePassword(): string {
  const group = () =>
    Array.from({ length: 4 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('')
  return [group(), group(), group()].join('-')
}

/** No look-alike letters (0/O, 1/I/L): the code can be read aloud if the QR does not scan. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function newPairingCode(): string {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
}

export const KEY_FILE = 'pin-key'

/**
 * Reads the HMAC key from the data folder or creates it (readable only by the hub's user). It
 * goes in the backup along with the database: without it, no saved PIN works.
 */
export function loadKey(dataDir: string): {
  key: Buffer
  newOne: boolean
  /** Since when this key exists: earlier sessions were signed with another one. */
  createdAt: string
} {
  const route = join(dataDir, KEY_FILE)
  if (existsSync(route)) {
    const key = readFileSync(route)
    if (key.length !== 32) throw new Error(`La clave de los PIN (${route}) está dañada.`)
    return { key, newOne: false, createdAt: statSync(route).mtime.toISOString() }
  }
  const key = randomBytes(32)
  writeFileSync(route, key, { mode: 0o600, flag: 'wx' })
  return { key, newOne: true, createdAt: statSync(route).mtime.toISOString() }
}
