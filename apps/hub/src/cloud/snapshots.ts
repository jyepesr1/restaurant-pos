import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { SqliteDatabase } from '@pos/db'
import { fingerprint } from '@pos/sync'
import { z } from 'zod'
import { readCatalog } from '../catalog'
import { configOf } from '../reports/z-report'
import { timeZoneOf } from '../startup'
import { REQUEST_TIMEOUT_MS } from './uploader'

// Read-only snapshots for the owner's panel (task 1.11c, docs/PANEL.md#instantáneas): until the
// cloud has the menu, the configuration and the staff (task 1.11b), the hub uploads a copy of each
// when it changes. Each one goes up only if its fingerprint differs from the last one the cloud
// accepted, kept in `cloud-snapshots.json` next to `cloud-link.json`.
//
// `remote_users` carries the scrypt hash of each password (ADR-013, amendment of 29-oct-2026): its
// content never goes to the log, not even in an error.

/**
 * In upload order: `remote_users` first, because it is the one that takes access away (a person
 * archived, a permission removed, a password changed).
 */
export const SNAPSHOT_KINDS = ['remote_users', 'roles', 'people', 'config', 'catalog'] as const
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number]
export type Snapshots = Record<SnapshotKind, unknown>

export const SNAPSHOTS_FILE = 'cloud-snapshots.json'
/** What the cloud takes per snapshot; anything bigger is not even sent. */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
/**
 * A routine check (each time the upload is left up to date) is done at most this often: the
 * changes that matter already ask for one right away.
 */
export const ROUTINE_EVERY_MS = 30_000
/** A cloud that does not know the route yet (404, another version) is asked again after this. */
export const REFUSED_RETRY_MS = 5 * 60 * 1000
/**
 * Waits for a kind after each passing failure in a row (no answer, 5xx, 408, 429); the last one
 * repeats. A `Retry-After` from the cloud is respected if it asks for longer.
 */
export const SNAPSHOT_RETRY_DELAYS_MS = [5000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000]
/** A `Retry-After` longer than this is taken as this. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000

/** `Retry-After` in milliseconds (seconds or an HTTP date), or null if it does not come. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  if (!Number.isFinite(ms)) return null
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms))
}

/** Everything the panel needs from the hub, as it is now. */
export function readSnapshots(db: SqliteDatabase, restaurantId: string): Snapshots {
  // All people, archived ones and kitchen screens included: the reports show old names.
  const people = db
    .prepare('SELECT id, name, role_id, active FROM users WHERE restaurant_id = ? ORDER BY id')
    .all(restaurantId)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      role_id: String(f.role_id),
      active: f.active === 1,
    }))
  const permissionsOf = new Map<string, string[]>()
  for (const f of db
    .prepare(
      `SELECT role_id, permission FROM role_permissions
       WHERE restaurant_id = ? AND active = 1 ORDER BY role_id, permission`,
    )
    .all(restaurantId)) {
    const list = permissionsOf.get(String(f.role_id)) ?? []
    list.push(String(f.permission))
    permissionsOf.set(String(f.role_id), list)
  }
  const roles = db
    .prepare('SELECT id, name, active FROM roles WHERE restaurant_id = ? ORDER BY id')
    .all(restaurantId)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      permissions: permissionsOf.get(String(f.id)) ?? [],
      active: f.active === 1,
    }))
  // Only active people with username and password whose active role can enter from outside.
  const remoteUsers = db
    .prepare(
      `SELECT u.id, u.name, u.role_id, c.username, c.password_hash
       FROM users u
       JOIN user_credentials c ON c.user_id = u.id AND c.current = 1
       JOIN roles r ON r.id = u.role_id AND r.active = 1
       WHERE u.restaurant_id = ? AND u.active = 1
         AND c.username IS NOT NULL AND c.password_hash IS NOT NULL
       ORDER BY u.id`,
    )
    .all(restaurantId)
    .map((f) => ({
      user_id: String(f.id),
      username: String(f.username),
      name: String(f.name),
      verifier: String(f.password_hash),
      permissions: permissionsOf.get(String(f.role_id)) ?? [],
    }))
    .filter((u) => u.permissions.includes('remote_access'))
  return {
    catalog: readCatalog(db, restaurantId),
    config: { config: configOf({ db, restaurantId }), time_zone: timeZoneOf(db, restaurantId) },
    people,
    roles,
    remote_users: remoteUsers,
  }
}

const Saved = z.object({
  hub_id: z.string(),
  accepted: z.record(z.string(), z.string()),
})

/** The fingerprints the cloud accepted, for that hub id (a new registration starts empty). */
export function readAccepted(dataDir: string, hubId: string): Record<string, string> {
  const route = join(dataDir, SNAPSHOTS_FILE)
  if (!existsSync(route)) return {}
  try {
    const saved = Saved.parse(JSON.parse(readFileSync(route, 'utf8')))
    // Damaged or from another registration: everything goes up again, which does no harm.
    return saved.hub_id === hubId ? saved.accepted : {}
  } catch {
    return {}
  }
}

/** Saves it whole or not at all, like `cloud-link.json`. */
export function saveAccepted(dataDir: string, hubId: string, accepted: Record<string, string>) {
  const route = join(dataDir, SNAPSHOTS_FILE)
  const temporary = `${route}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeSync(fd, `${JSON.stringify({ hub_id: hubId, accepted })}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, route)
}

export interface SnapshotUploaderOptions {
  /** The cloud's address, without the trailing slash. */
  url: string
  /** null if this PC is not connected to the cloud (or was revoked): nothing goes up. */
  credential: () => string | null
  /** This hub's id in the cloud: the accepted fingerprints belong to it. */
  hubId: () => string | null
  build: () => Snapshots
  dataDir: string
  /** The cloud refused one (400, 413…): goes to the hub's log, without its content. */
  onFailure?: (error: unknown) => void
  fetch?: typeof fetch
  /** Milliseconds, for the waits. */
  now?: () => number
  requestTimeoutMs?: number
  routineEveryMs?: number
  refusedRetryMs?: number
  retryDelaysMs?: readonly number[]
  maxBytes?: number
}

const encoder = new TextEncoder()

/**
 * Uploads the snapshots that changed (`PUT /v1/snapshots/:kind`). Never two checks at the same
 * time: a check asked while one is running is done right after it.
 */
export class SnapshotUploader {
  private readonly o: SnapshotUploaderOptions
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private running: Promise<void> | null = null
  private again: { force: boolean } | null = null
  private stopped = false
  private inFlight: AbortController | null = null
  /** When the last check that built the snapshots was done, and whether everything went up. */
  private lastCheck = Number.NEGATIVE_INFINITY
  private complete = false
  /** What the cloud refused, by kind: not sent again until it changes (or, if `until`, then). */
  private readonly refused = new Map<SnapshotKind, { fingerprint: string; until: number | null }>()
  /** Kinds that failed for a passing reason: not sent again before `until`, whatever changes. */
  private readonly waiting = new Map<SnapshotKind, { failures: number; until: number }>()

  constructor(options: SnapshotUploaderOptions) {
    this.o = options
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = options.now ?? Date.now
  }

  /**
   * Checks whether something changed and uploads it. `force`: something changed for sure (menu,
   * staff, configuration, a new registration); otherwise it is a routine check, at most every
   * `routineEveryMs` once everything went up.
   */
  check(options: { force?: boolean } = {}) {
    if (this.stopped) return
    const force = options.force ?? false
    if (this.running) {
      this.again = { force: force || (this.again?.force ?? false) }
      return
    }
    this.running = this.run(force)
  }

  stop() {
    this.stopped = true
    this.inFlight?.abort()
  }

  /** Resolves once the check in progress (and the one queued after it) finishes. */
  async idle() {
    while (this.running) await this.running
  }

  private async run(first: boolean) {
    let force = first
    try {
      // After whatever asked for it: if it was inside a transaction, it is committed by now.
      await Promise.resolve()
      for (;;) {
        try {
          await this.attempt(force)
        } catch (error) {
          // The database or the disk, not the internet: logged, and tried again next time.
          this.complete = false
          this.o.onFailure?.(error)
        }
        const next = this.again
        this.again = null
        if (!next || this.stopped) break
        force = next.force
      }
    } finally {
      this.running = null
    }
  }

  private async attempt(force: boolean) {
    const credential = this.o.credential()
    const hubId = this.o.hubId()
    if (!credential || !hubId) return
    const now = this.now()
    const routineEvery = this.o.routineEveryMs ?? ROUTINE_EVERY_MS
    if (!force) {
      if (this.complete && now - this.lastCheck < routineEvery) return
      // Something is waiting after a failure: before its time nothing could go up anyway.
      if (!this.complete && this.waiting.size > 0 && now < this.nextRetry()) return
    }
    this.lastCheck = now
    this.complete = false
    const snapshots = this.o.build()
    const accepted = readAccepted(this.o.dataDir, hubId)
    let pending = false
    for (const kind of SNAPSHOT_KINDS) {
      if (this.stopped) return
      const wait = this.waiting.get(kind)
      if (wait && this.now() < wait.until) {
        pending = true
        continue
      }
      const content = snapshots[kind]
      const print = fingerprint(content)
      if (accepted[kind] === print) {
        this.refused.delete(kind)
        this.waiting.delete(kind)
        continue
      }
      const refused = this.refused.get(kind)
      if (refused?.fingerprint === print && (refused.until === null || this.now() < refused.until))
        continue
      const body = JSON.stringify({ fingerprint: print, content })
      const bytes = encoder.encode(body).length
      if (bytes > (this.o.maxBytes ?? MAX_SNAPSHOT_BYTES)) {
        this.refuse(kind, print, null, `pesa ${bytes} bytes`)
        continue
      }
      const { status, retryAfter } = await this.put(credential, kind, body)
      // No internet, or the cloud failed or asks to wait: this kind waits, growing, and the
      // others are still tried.
      if (status === null || status >= 500 || status === 408 || status === 429) {
        const failures = (wait?.failures ?? 0) + 1
        const delays = this.o.retryDelaysMs ?? SNAPSHOT_RETRY_DELAYS_MS
        const delay = delays[Math.min(failures, delays.length) - 1] ?? 5 * 60_000
        this.waiting.set(kind, {
          failures,
          until: this.now() + Math.max(delay, retryAfter ?? 0),
        })
        pending = true
        continue
      }
      // The credential is no longer valid: the upload of events already says «revoked».
      if (status === 401) return
      this.waiting.delete(kind)
      if (status >= 200 && status < 300) {
        accepted[kind] = print
        saveAccepted(this.o.dataDir, hubId, accepted)
        this.refused.delete(kind)
        continue
      }
      // A bad format or too big does not fix itself: only once the content changes. Anything else
      // (a cloud that does not know the route yet) is asked again in a while.
      const permanent = status === 400 || status === 413
      this.refuse(
        kind,
        print,
        permanent ? null : this.now() + (this.o.refusedRetryMs ?? REFUSED_RETRY_MS),
        `respondió ${status}`,
      )
    }
    this.complete = !pending
  }

  /** When the first kind that is waiting after a failure can be tried again. */
  private nextRetry() {
    return Math.min(...[...this.waiting.values()].map((w) => w.until))
  }

  /** Marks it as refused; it is logged only the first time for that content. */
  private refuse(kind: SnapshotKind, print: string, until: number | null, detail: string) {
    const before = this.refused.get(kind)
    this.refused.set(kind, { fingerprint: print, until })
    if (before?.fingerprint === print) return
    // Only the kind and the reason: never the content (it may carry password hashes).
    this.o.onFailure?.(
      new Error(
        `La nube no aceptó la instantánea «${kind}» (${detail}); se vuelve a intentar cuando cambie`,
      ),
    )
  }

  /** The answer's status (null if the cloud did not answer) and the wait it asks for. */
  private async put(
    credential: string,
    kind: SnapshotKind,
    body: string,
  ): Promise<{ status: number | null; retryAfter: number | null }> {
    const controller = new AbortController()
    this.inFlight = controller
    try {
      const r = await this.fetch(`${this.o.url}/v1/snapshots/${kind}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(this.o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
        ]),
      })
      // The body is not needed; it is read so the connection is released.
      await r.arrayBuffer().catch(() => undefined)
      return {
        status: r.status,
        retryAfter: retryAfterMs(r.headers.get('retry-after'), this.now()),
      }
    } catch {
      return { status: null, retryAfter: null }
    } finally {
      if (this.inFlight === controller) this.inFlight = null
    }
  }
}
