import { businessDay, newId } from '@pos/core'
import type { Catalog } from '@pos/sync'
import { currentLocation, inRestaurant, Slug, sha256 } from './cloud'
import { DECOY_VERIFIER, normalizeUsername, passwordMatches } from './password'
import {
  cloudReportData,
  hubsOfLocation,
  MAX_PANEL_DAYS,
  type PeriodReport,
  periodReport,
  type Scope,
  sequenceAt,
  userNames,
} from './reports'
import { readConfig, readSnapshot } from './snapshots'
import type { Sql } from './sql'

// The owner's panel in the cloud (task 1.11c-1, docs/PANEL.md#rutas-del-panel-sesión-por-cookie):
// signing in with the location's username and password, sessions, the day's dashboard and the
// reports. Knows nothing about HTTP (that is `api.ts`).

/** The session cookie. `__Host-`: only over HTTPS, without Domain and with Path=/. */
export const COOKIE_NAME = '__Host-faro_panel'
/** A session dies after 7 days without use… */
export const IDLE_MS = 7 * 24 * 60 * 60 * 1000
/** …or after 30 days anyway. */
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000
/** `last_used_at` is written at most this often (the panel polls every 15 s). */
const TOUCH_MS = 60_000
/** Failures are forgotten after this long without errors (as in the hub). */
const ATTEMPT_WINDOW_MS = 10 * 60_000
/**
 * Cap on the per-username wait. Higher than in the hub (10 s: there one is inside the location),
 * but short: guessing someone's password locks nobody out, not even the owner, for long.
 */
export const MAX_USER_WAIT_MS = 60_000
/** Cap on the per-IP wait: stricter, it is whoever is trying. */
export const MAX_IP_WAIT_MS = 5 * 60_000
/** Attempt rows with no failure in this long are cleared when signing in. */
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000
/** Two errors with no wait (a slipped finger); then 2, 4, 8… s, up to the cap (the hub's). */
export const delayAfter = (failures: number, cap: number) =>
  failures < 3 ? 0 : Math.min(cap, 1000 * 2 ** (failures - 2))

export const REMOTE_ACCESS = 'remote_access'
export const VIEW_REPORTS = 'view_reports'

const DEFAULT_TIME_ZONE = 'America/Bogota'
const DAY_MS = 24 * 60 * 60 * 1000

/** The restaurant's checkout rules, as the register receives them (`Catalog.restaurant.checkout`). */
export type CheckoutRules = NonNullable<Catalog['restaurant']['checkout']>

/** What the panel needs to show the reports as the register does. */
export interface Me {
  user: { id: string; name: string; permissions: string[] }
  restaurant: {
    id: string
    name: string
    slug: string
    /** From the `config` snapshot (America/Bogota if there is none yet). */
    time_zone: string
    /** `catalog.restaurant.brand` (null: Faro). */
    brand: string | null
    /** `catalog.restaurant.checkout`: methods and custom methods with their names (null if none). */
    payment_methods: CheckoutRules | null
  }
}

/** A checked session: who and which restaurant (without the snapshot details of `Me`). */
export interface PanelSession {
  sessionId: string
  locationId: string
  user: Me['user']
  restaurant: { id: string; name: string; slug: string }
}

export type SignInResult =
  | { ok: true; me: Me; cookie: string }
  | { ok: false; reason: 'invalid_credentials'; waitMs: number }
  | { ok: false; reason: 'wait'; waitMs: number }

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string | Date).toISOString()

/** A real YYYY-MM-DD date that Postgres accepts (it has no year 0000). */
export const isDay = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d.startsWith('0000')) return false
  const t = Date.parse(`${d}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d)
}
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const daysBetween = (from: string, until: string) =>
  Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1

/** A wall-clock time in a zone, as if it were UTC (milliseconds). */
function wallClock(t: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>
  return (
    Date.UTC(
      parts.year as number,
      (parts.month as number) - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) +
    (((t % 1000) + 1000) % 1000)
  )
}

/**
 * The same local time of the restaurant `days` days earlier, as an instant: with daylight saving
 * time in between it is not `now − days × 24 h`. A local time that does not exist (the hour the
 * clocks jump) falls just after the jump.
 */
export function sameLocalTimeDaysAgo(now: Date, timeZone: string, days: number): string {
  const target = wallClock(now.getTime(), timeZone) - days * DAY_MS
  let t = target - (wallClock(target, timeZone) - target)
  for (let i = 0; i < 2; i++) t = target - (wallClock(t, timeZone) - t)
  return new Date(t).toISOString()
}

const randomSecret = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

const COOKIE_VALUE = /^([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{43})$/

export class Panel {
  private readonly sql: Sql
  private readonly clock: () => Date

  constructor(sql: Sql, clock: () => Date = () => new Date()) {
    this.sql = sql
    this.clock = clock
  }

  // ── Signing in ──

  /**
   * Checks the username and password against the location's `remote_users`, with the same answer
   * for a user that does not exist, a wrong password or a person without remote_access.
   *
   * Each attempt is charged BEFORE the hash is computed, per user (wait up to 60 s) and per IP (up
   * to 5 min), under a row lock: attempts in parallel queue up and, from the third, wait. Signing
   * in well clears the count. A restaurant that does not exist or a malformed username are refused
   * without a hash: the slug is in the panel's address and the username's form is public, and that
   * way no scrypt is spent without being charged.
   */
  async signIn(entry: {
    restaurant: string
    username: string
    password: string
    ip: string | null
  }): Promise<SignInResult> {
    const slug = entry.restaurant.trim().toLowerCase()
    const username = normalizeUsername(entry.username)
    const restaurant = Slug.safeParse(slug).success ? await this.restaurantBySlug(slug) : null
    if (!restaurant || !username) return { ok: false, reason: 'invalid_credentials', waitMs: 0 }
    const keys = [`user:${username}`, ...(entry.ip ? [`ip:${entry.ip.slice(0, 100)}`] : [])].sort()
    const now = this.clock()
    const attempt = await inRestaurant(this.sql, restaurant.id, async (tx) => {
      const charged = await this.charge(tx, restaurant.id, keys, now)
      if (charged.blockedMs > 0) return { blockedMs: charged.blockedMs, waitMs: 0, user: null }
      const locationId = await currentLocation(tx, restaurant.id)
      const [user] = locationId
        ? await tx.query<{
            user_id: string
            name: string
            verifier: string
            permissions: string[]
          }>(
            `SELECT user_id, name, verifier, permissions FROM remote_users
             WHERE restaurant_id = $1 AND location_id = $2 AND username = $3`,
            [restaurant.id, locationId, username],
          )
        : []
      return { blockedMs: 0, waitMs: charged.waitMs, user: user ?? null }
    })
    if (attempt.blockedMs > 0) return { ok: false, reason: 'wait', waitMs: attempt.blockedMs }
    const user = attempt.user
    // The hash is computed outside the transaction: it does not hold a connection for 30-50 ms.
    const matches = await passwordMatches(entry.password, user?.verifier ?? DECOY_VERIFIER)
    // Without remote_access it is the same failure (and it stays charged): a good password is not
    // revealed.
    if (!user || !matches || !user.permissions.includes(REMOTE_ACCESS))
      return { ok: false, reason: 'invalid_credentials', waitMs: attempt.waitMs }
    const sessionId = newId()
    const secret = randomSecret()
    const me = await inRestaurant(this.sql, restaurant.id, async (tx) => {
      await tx.query(
        `UPDATE panel_attempts SET failures = 0, blocked_until = $3
         WHERE restaurant_id = $1 AND key = ANY($2::text[])`,
        [restaurant.id, keys, now.toISOString()],
      )
      await tx.query(
        `INSERT INTO panel_sessions (id, restaurant_id, user_id, secret_hash, verifier_fingerprint,
                                     created_at, last_used_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
        [
          sessionId,
          restaurant.id,
          user.user_id,
          await sha256(secret),
          await sha256(user.verifier),
          now.toISOString(),
          new Date(now.getTime() + SESSION_MS).toISOString(),
        ],
      )
      const locationId = await currentLocation(tx, restaurant.id)
      return {
        user: { id: user.user_id, name: user.name, permissions: [...user.permissions] },
        restaurant: await this.restaurantInfo(tx, restaurant, locationId),
      }
    })
    return { ok: true, cookie: `${sessionId}.${secret}`, me }
  }

  /**
   * Charges an attempt to each key, locking its row (parallel attempts go one after the other). If
   * one is still waiting, nothing is charged and it says how long (`blockedMs`). Otherwise it
   * returns the wait this attempt leaves if it fails (`waitMs`).
   */
  private async charge(tx: Sql, restaurantId: string, keys: string[], now: Date) {
    const nowIso = now.toISOString()
    await tx.query(
      `DELETE FROM panel_attempts
       WHERE restaurant_id = $1 AND last_failure_at < $2 AND blocked_until < $3`,
      [restaurantId, new Date(now.getTime() - ATTEMPT_RETENTION_MS).toISOString(), nowIso],
    )
    await tx.query(
      `INSERT INTO panel_attempts (restaurant_id, key, failures, last_failure_at, blocked_until)
       SELECT $1, k, 0, $3, $3 FROM unnest($2::text[]) AS k
       ON CONFLICT (restaurant_id, key) DO NOTHING`,
      [restaurantId, keys, nowIso],
    )
    const rows = await tx.query<{
      key: string
      failures: number
      last_failure_at: unknown
      blocked_until: unknown
    }>(
      `SELECT key, failures, last_failure_at, blocked_until FROM panel_attempts
       WHERE restaurant_id = $1 AND key = ANY($2::text[]) ORDER BY key FOR UPDATE`,
      [restaurantId, keys],
    )
    const time = (v: unknown) => new Date(v as string).getTime()
    const blockedMs = Math.max(0, ...rows.map((r) => time(r.blocked_until) - now.getTime()))
    if (blockedMs > 0) return { blockedMs, waitMs: 0 }
    let waitMs = 0
    for (const r of rows) {
      const recent = r.failures > 0 && now.getTime() - time(r.last_failure_at) < ATTEMPT_WINDOW_MS
      const failures = recent ? r.failures + 1 : 1
      const delay = delayAfter(
        failures,
        r.key.startsWith('user:') ? MAX_USER_WAIT_MS : MAX_IP_WAIT_MS,
      )
      await tx.query(
        `UPDATE panel_attempts SET failures = $3, last_failure_at = $4, blocked_until = $5
         WHERE restaurant_id = $1 AND key = $2`,
        [restaurantId, r.key, failures, nowIso, new Date(now.getTime() + delay).toISOString()],
      )
      waitMs = Math.max(waitMs, delay)
    }
    return { blockedMs: 0, waitMs }
  }

  /** The session's `Me`: who it is and the restaurant with its time zone, brand and methods. */
  me(s: PanelSession): Promise<Me> {
    return inRestaurant(this.sql, s.restaurant.id, async (tx) => ({
      user: s.user,
      restaurant: await this.restaurantInfo(tx, s.restaurant, s.locationId),
    }))
  }

  /** Only the catalog fields it needs are read (the catalog can weigh up to 2 MB). */
  private async restaurantInfo(
    tx: Sql,
    restaurant: { id: string; name: string; slug: string },
    locationId: string | null,
  ): Promise<Me['restaurant']> {
    const [catalog] = locationId
      ? await tx.query<{ brand: unknown; checkout: unknown }>(
          `SELECT content #> '{restaurant,brand}' AS brand, content #> '{restaurant,checkout}' AS checkout
           FROM snapshots WHERE restaurant_id = $1 AND location_id = $2 AND kind = 'catalog'`,
          [restaurant.id, locationId],
        )
      : []
    const config = locationId ? await readConfig(tx, restaurant.id, locationId) : null
    const checkout = catalog?.checkout
    return {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
      time_zone: config?.timeZone ?? DEFAULT_TIME_ZONE,
      brand: typeof catalog?.brand === 'string' ? catalog.brand : null,
      payment_methods:
        checkout && typeof checkout === 'object' && !Array.isArray(checkout)
          ? (checkout as CheckoutRules)
          : null,
    }
  }

  private async restaurantBySlug(slug: string) {
    const [row] = await this.sql.query<{ id: string; name: string; slug: string }>(
      'SELECT id, name, slug FROM restaurants WHERE slug = $1',
      [slug],
    )
    return row ?? null
  }

  // ── Sessions ──

  /**
   * The session of a cookie, checked on every request against `remote_users`: if the person lost
   * the permission, was archived or changed the password (another verifier), the session dies.
   */
  async session(cookie: string | null): Promise<PanelSession | null> {
    const m = cookie ? COOKIE_VALUE.exec(cookie) : null
    if (!m) return null
    const [, sessionId, secret] = m as unknown as [string, string, string]
    const [owner] = await this.sql.query<{ r: string | null }>(
      'SELECT panel_session_restaurant($1) AS r',
      [sessionId],
    )
    const restaurantId = owner?.r
    if (!restaurantId) return null
    const now = this.clock()
    const secretHash = await sha256(secret)
    return inRestaurant(this.sql, restaurantId, async (tx) => {
      const [s] = await tx.query<{
        user_id: string
        secret_hash: string
        verifier_fingerprint: string
        last_used_at: unknown
        expires_at: unknown
        revoked_at: unknown
      }>(
        `SELECT user_id, secret_hash, verifier_fingerprint, last_used_at, expires_at, revoked_at
         FROM panel_sessions WHERE id = $1`,
        [sessionId],
      )
      if (!s || s.secret_hash !== secretHash || s.revoked_at !== null) return null
      const lastUsed = new Date(s.last_used_at as string).getTime()
      if (new Date(s.expires_at as string).getTime() <= now.getTime()) return null
      if (now.getTime() - lastUsed >= IDLE_MS) return null
      const locationId = await currentLocation(tx, restaurantId)
      const [user] = locationId
        ? await tx.query<{ name: string; verifier: string; permissions: string[] }>(
            `SELECT name, verifier, permissions FROM remote_users
             WHERE restaurant_id = $1 AND location_id = $2 AND user_id = $3`,
            [restaurantId, locationId, s.user_id],
          )
        : []
      if (
        !locationId ||
        !user ||
        (await sha256(user.verifier)) !== s.verifier_fingerprint ||
        !user.permissions.includes(REMOTE_ACCESS)
      ) {
        await tx.query('UPDATE panel_sessions SET revoked_at = $2 WHERE id = $1', [
          sessionId,
          now.toISOString(),
        ])
        return null
      }
      if (now.getTime() - lastUsed >= TOUCH_MS)
        await tx.query('UPDATE panel_sessions SET last_used_at = $2 WHERE id = $1', [
          sessionId,
          now.toISOString(),
        ])
      const [restaurant] = await tx.query<{ id: string; name: string; slug: string }>(
        'SELECT id, name, slug FROM restaurants WHERE id = $1',
        [restaurantId],
      )
      if (!restaurant) return null
      return {
        sessionId,
        locationId,
        restaurant,
        user: { id: s.user_id, name: user.name, permissions: [...user.permissions] },
      }
    })
  }

  /** Ends the cookie's session, if it has one. */
  async signOut(cookie: string | null): Promise<void> {
    const session = await this.session(cookie)
    if (!session) return
    await inRestaurant(this.sql, session.restaurant.id, (tx) =>
      tx.query('UPDATE panel_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [
        session.sessionId,
        this.clock().toISOString(),
      ]),
    )
  }

  // ── Reports ──

  /** The location's config, time zone, names and hubs, read once per request. */
  private async context(tx: Sql, s: PanelSession) {
    const [{ config, timeZone }, people, hubIds] = [
      await readConfig(tx, s.restaurant.id, s.locationId),
      await readSnapshot(tx, s.restaurant.id, s.locationId, 'people'),
      await hubsOfLocation(tx, s.restaurant.id, s.locationId),
    ]
    const names = new Map((people ?? []).map((p) => [p.id, p.name]))
    const now = this.clock()
    const today = businessDay(now.toISOString(), timeZone, config.business_day_start)
    return { config, timeZone, names, hubIds, now, today }
  }

  /**
   * The report of a period, with the same shape as the hub's `/api/reports` (without a printer).
   * Without dates, today's business day.
   */
  async report(
    s: PanelSession,
    from?: string,
    until?: string,
  ): Promise<PeriodReport | { error: string }> {
    if ((from !== undefined && !isDay(from)) || (until !== undefined && !isDay(until)))
      return { error: 'Fecha inválida' }
    return inRestaurant(this.sql, s.restaurant.id, async (tx) => {
      const c = await this.context(tx, s)
      const start = from ?? c.today
      const end = until ?? start
      if (start > end) return { error: 'La fecha inicial va antes de la final' }
      if (daysBetween(start, end) > MAX_PANEL_DAYS)
        return { error: `Elige un período de ${MAX_PANEL_DAYS} días o menos` }
      const scope: Scope = { restaurantId: s.restaurant.id, hubIds: c.hubIds }
      const { data } = await cloudReportData(tx, scope, start, end)
      return periodReport(data, c.config, c.names, c.today)
    })
  }

  /**
   * The day's dashboard: today's report so far, the same weekday of the previous week up to the
   * same time and complete, and how the location is doing (last call, last event, what is left to
   * upload).
   */
  async summary(s: PanelSession) {
    return inRestaurant(this.sql, s.restaurant.id, async (tx) => {
      const c = await this.context(tx, s)
      const scope: Scope = { restaurantId: s.restaurant.id, hubIds: c.hubIds }
      const day = addDays(c.today, -7)
      const today = await cloudReportData(tx, scope, c.today, c.today)
      // Last week's day is loaded once; «up to this time» is the same events up to the sequence
      // the hub had at the same local time seven days ago.
      const full = await cloudReportData(tx, scope, day, day)
      const weekAgo = sameLocalTimeDaysAgo(c.now, c.timeZone, 7)
      const cut = await sequenceAt(tx, s.restaurant.id, c.hubIds, weekAgo)
      const untilNow = await cloudReportData(tx, { ...scope, upTo: cut }, day, day, {
        store: full.store.upTo(cut),
      })
      const reports = [today, untilNow, full].map((r) =>
        periodReport(r.data, c.config, c.names, c.today),
      )
      const [now, lastWeekUntilNow, lastWeekFull] = reports as [
        PeriodReport,
        PeriodReport,
        PeriodReport,
      ]
      return {
        server_now: c.now.toISOString(),
        today: c.today,
        report: now.report,
        last_week: {
          day,
          report_until_now: lastWeekUntilNow.report,
          report_full: lastWeekFull.report,
        },
        users: userNames(
          c.names,
          reports.flatMap((r) => Object.keys(r.users)),
        ),
        local: await this.local(tx, s),
      }
    })
  }

  /** Since when there is no news from the location and how much is left to upload. */
  private async local(tx: Sql, s: PanelSession) {
    const [hub] = await tx.query<{
      last_seen_at: unknown
      hub_max_sequence: unknown
      contiguous_sequence: unknown
    }>(
      `SELECT last_seen_at, hub_max_sequence, contiguous_sequence FROM hubs
       WHERE restaurant_id = $1 AND location_id = $2
       ORDER BY last_seen_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [s.restaurant.id, s.locationId],
    )
    const [last] = await tx.query<{ received_at: unknown }>(
      `SELECT max(x.received_at) AS received_at FROM hubs h
       CROSS JOIN LATERAL (
         SELECT e.received_at FROM events e
         WHERE e.restaurant_id = h.restaurant_id AND e.hub_id = h.id
         ORDER BY e.hub_sequence DESC LIMIT 1
       ) x
       WHERE h.restaurant_id = $1 AND h.location_id = $2`,
      [s.restaurant.id, s.locationId],
    )
    const max = hub?.hub_max_sequence
    return {
      last_seen_at: iso(hub?.last_seen_at),
      last_event_at: iso(last?.received_at),
      pending:
        max === null || max === undefined
          ? null
          : Math.max(0, Number(max) - Number(hub?.contiguous_sequence ?? 0)),
    }
  }
}
