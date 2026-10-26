import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { canonicalJson } from '../canonical'
import type { NewEvent } from '../events/order'

// Event signatures and fingerprints for supervisor approvals (ADR-008). Pure JavaScript SHA-256:
// over HTTP (ADR-001) the browser does not offer `crypto.subtle`. The same code runs on the
// phone and on the hub.

/** Without the signature or what the device may adjust later (`base_sequence`). */
function content(event: NewEvent, without: readonly string[]): string {
  const copy: Record<string, unknown> = { ...event }
  for (const field of ['signature', 'base_sequence', ...without]) delete copy[field]
  return canonicalJson(copy)
}

/**
 * Event signature with the secret of the session that creates it. The device computes it when it
 * creates the event and forgets the secret when the session ends: someone else's `session_id`
 * cannot sign.
 */
export function signEvent(event: NewEvent, sessionSecret: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(sessionSecret), utf8ToBytes(content(event, []))))
}

/**
 * Fingerprint of the event a supervisor authorizes: the approval is valid only for that content.
 * It excludes `authorization_id`, which is added after the approval is received.
 */
export function authorizableFingerprint(event: NewEvent): string {
  return bytesToHex(sha256(utf8ToBytes(content(event, ['authorization_id']))))
}

/** Compares two strings without stopping at the first difference (leaks nothing via timing). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let variance = 0
  for (let i = 0; i < a.length; i++) variance |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return variance === 0
}
