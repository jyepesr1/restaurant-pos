import { type Alert, alertPeople, alertTables, businessDay, newId } from '@pos/core'
import type { Catalog, ReportData } from '@pos/sync'
import { ALERT_DAYS, dayAlerts, tableNames } from './alerts'
import { currentLocation, inRestaurant, Slug, sha256 } from './cloud'
import {
  LIVE_WINDOW_DAYS,
  type LiveFloor,
  liveOrders,
  namedOn,
  openSummary,
  readPlan,
  ticketJson,
} from './live'
import { roomOf } from './live-protocol'
import { DECOY_VERIFIER, normalizeUsername, passwordMatches } from './password'
import { type OpenRegister, registersNow } from './register'
import {
  cloudReportData,
  locationScopes,
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
  /** When the session dies anyway (`expires_at`, ISO): the live socket closes then (docs/PANEL.md). */
  expiresAt: string
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

/** Since when there is no news from the location and what is still to come (`Panel.local`). */
export interface LocalState {
  last_seen_at: string | null
  last_event_at: string | null
  pending: number | null
}

/** `GET /v1/panel/register`. */
export interface RegisterAnswer {
  server_now: string
  today: string
  as_of: string | null
  local: LocalState
  /** From how many pesos a variance needs a justification (`register_variance_threshold`). */
  threshold: number
  open: OpenRegister[]
  closed: PeriodReport['closings']
  users: Record<string, string>
}

/** `GET /v1/panel/alerts`. */
export interface AlertsAnswer {
  server_now: string
  today: string
  /** The business day of the alerts. */
  day: string
  as_of: string | null
  local: LocalState
  threshold: number
  /** From the newest to the oldest. */
  alerts: Alert[]
  users: Record<string, string>
  /** The names of the tables the alerts name, by id. */
  tables: Record<string, string>
}

/**
 * Last week's day for the dashboard once it is complete in the cloud: it cannot change any more, so
 * it is kept a while in the isolate (a Worker's memory is per isolate and may be lost at any moment:
 * it is only a shortcut). Few entries (each one is a day's report data, about 1 MB at the pilot's
 * volume) and short-lived.
 */
class LastWeekCache {
  private readonly entries = new Map<string, { at: number; value: ReportData }>()
  static readonly TTL_MS = 10 * 60_000
  static readonly MAX = 12
  get(key: string, now: number): ReportData | undefined {
    const hit = this.entries.get(key)
    if (!hit || now - hit.at >= LastWeekCache.TTL_MS) return undefined
    return hit.value
  }
  set(key: string, value: ReportData, now: number) {
    this.entries.delete(key)
    this.entries.set(key, { at: now, value })
    while (this.entries.size > LastWeekCache.MAX) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
  clear() {
    this.entries.clear()
  }
}

const lastWeekCache = new LastWeekCache()

/** For the tests: forget the days kept in this isolate. */
export const clearLastWeekCache = () => lastWeekCache.clear()

export interface PanelOptions {
  /**
   * A session was revoked while being checked (the person lost remote_access, changed the password
   * or is gone): its live sockets must close. `rooms` are those it may have sockets in.
   */
  onSessionRevoked?: (ended: { sessionId: string; rooms: string[] }) => void
}

export class Panel {
  private readonly sql: Sql
  private readonly clock: () => Date
  private readonly options: PanelOptions

  constructor(sql: Sql, clock: () => Date = () => new Date(), options: PanelOptions = {}) {
    this.sql = sql
    this.clock = clock
    this.options = options
  }

  /** A read of the panel: one snapshot of the database for the whole answer, and no writes. */
  private read<T>(s: PanelSession, job: (tx: Sql) => Promise<T>): Promise<T> {
    return inRestaurant(this.sql, s.restaurant.id, job, { readOnly: true })
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
      return { blockedMs: 0, waitMs: charged.waitMs, user: user ?? null, locationId }
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
      // The location where the person was found: the session stays there (point 14).
      return {
        user: { id: user.user_id, name: user.name, permissions: [...user.permissions] },
        restaurant: await this.restaurantInfo(tx, restaurant, attempt.locationId),
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
    return this.read(s, async (tx) => ({
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
   * the permission, was archived or changed the password (another verifier), the session dies, and
   * its live sockets close (`onSessionRevoked`).
   *
   * Its location is the one of the remote user it signed in as: the row whose verifier is the one
   * the session remembers (each verifier has its own random salt). It is not recomputed from «the
   * hub that called last»: a call from another location of the restaurant does not move it.
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
    const checked = await inRestaurant(
      this.sql,
      restaurantId,
      async (tx): Promise<PanelSession | { revokedIn: string[] } | null> => {
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
        const rows = await tx.query<{
          location_id: string
          name: string
          verifier: string
          permissions: string[]
        }>(
          `SELECT location_id, name, verifier, permissions FROM remote_users
         WHERE restaurant_id = $1 AND user_id = $2 ORDER BY location_id`,
          [restaurantId, s.user_id],
        )
        let user: (typeof rows)[number] | undefined
        for (const row of rows)
          if ((await sha256(row.verifier)) === s.verifier_fingerprint) {
            user = row
            break
          }
        if (!user?.permissions.includes(REMOTE_ACCESS)) {
          await tx.query('UPDATE panel_sessions SET revoked_at = $2 WHERE id = $1', [
            sessionId,
            now.toISOString(),
          ])
          // Its sockets may be in any of the restaurant's locations (the row is gone).
          const locations = await tx.query<{ location_id: string }>(
            'SELECT DISTINCT location_id FROM hubs WHERE restaurant_id = $1',
            [restaurantId],
          )
          return { revokedIn: locations.map((l) => roomOf(restaurantId, l.location_id)) }
        }
        const locationId = user.location_id
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
          expiresAt: new Date(s.expires_at as string).toISOString(),
          locationId,
          restaurant,
          user: { id: s.user_id, name: user.name, permissions: [...user.permissions] },
        }
      },
    )
    if (checked && !('sessionId' in checked)) {
      // After the commit: the revocation is already stored when the sockets close.
      this.options.onSessionRevoked?.({ sessionId, rooms: checked.revokedIn })
      return null
    }
    return checked
  }

  /** Ends the cookie's session, if it has one, and says which one it was (null if none). */
  async signOut(cookie: string | null): Promise<PanelSession | null> {
    const session = await this.session(cookie)
    if (!session) return null
    await inRestaurant(this.sql, session.restaurant.id, (tx) =>
      tx.query('UPDATE panel_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [
        session.sessionId,
        this.clock().toISOString(),
      ]),
    )
    return session
  }

  // ── Reports ──

  /**
   * The location's config, time zone, names and scopes, read once per request: `scope` is every
   * hub (reports and alerts: history), `live` only what an active hub stands behind (D1: the floor,
   * the kitchen, the open registers and «Mesas abiertas»).
   */
  private async context(tx: Sql, s: PanelSession) {
    const [{ config, timeZone }, people, scopes] = [
      await readConfig(tx, s.restaurant.id, s.locationId),
      await readSnapshot(tx, s.restaurant.id, s.locationId, 'people'),
      await locationScopes(tx, s.restaurant.id, s.locationId),
    ]
    const names = new Map((people ?? []).map((p) => [p.id, p.name]))
    const now = this.clock()
    const today = businessDay(now.toISOString(), timeZone, config.business_day_start)
    return { config, timeZone, names, scope: scopes.all, live: scopes.live, now, today }
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
    return this.read(s, async (tx) => {
      const c = await this.context(tx, s)
      const start = from ?? c.today
      const end = until ?? start
      if (start > end) return { error: 'La fecha inicial va antes de la final' }
      if (daysBetween(start, end) > MAX_PANEL_DAYS)
        return { error: `Elige un período de ${MAX_PANEL_DAYS} días o menos` }
      const { data } = await cloudReportData(tx, c.scope, start, end)
      return periodReport(data, c.config, c.names, c.today)
    })
  }

  /**
   * The day's dashboard: today's report so far, the same weekday of the previous week up to the
   * same time and complete, how the location is doing (last call, last event, what is left to
   * upload), what is open right now and how many alerts today has. Last week's day is read once and
   * kept while it cannot change (`lastWeek`).
   */
  async summary(s: PanelSession) {
    return this.read(s, async (tx) => {
      const c = await this.context(tx, s)
      const day = addDays(c.today, -7)
      const today = await cloudReportData(tx, c.scope, c.today, c.today)
      const lastWeek = await this.lastWeek(tx, c.scope, s.locationId, day, c.now, c.timeZone)
      const [now, lastWeekUntilNow, lastWeekFull] = [
        today.data,
        lastWeek.untilNow,
        lastWeek.full,
      ].map((data) => periodReport(data, c.config, c.names, c.today)) as [
        PeriodReport,
        PeriodReport,
        PeriodReport,
      ]
      const live = await liveOrders(tx, c.live, addDays(c.today, -LIVE_WINDOW_DAYS))
      // «Alertas de hoy»: over today's report, already loaded and computed.
      const todayAlerts = await dayAlerts(tx, c.scope, c.today, c.config, {
        ...today,
        report: now.report,
      })
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
          [now, lastWeekUntilNow, lastWeekFull].flatMap((r) => Object.keys(r.users)),
        ),
        local: await this.local(tx, s),
        /** «Mesas abiertas»: what is open right now and not yet in the sales (D2). */
        open: openSummary(live.orders, live.closedNet),
        /** How many alerts today has (task 1.11c-2, `GET /v1/panel/alerts`). */
        alerts: todayAlerts.alerts.length,
      }
    })
  }

  /**
   * Last week's day, complete and up to the same local time as now. «Up to this time» is the same
   * events up to the sequence the hub had at that time seven days ago (`cut`).
   *
   * A day's report depends only on the location's events up to the last one of that day (`last`):
   * the later ones are other days' (a later refund counts on its own day). Once the cloud has every
   * event up to `last` (some hub uploaded with no gaps past it), the day can no longer change: it is
   * kept (`lastWeekCache`) by its `last`, and «up to this time» by min(cut, last). An event of that
   * day that arrives late (an offline device) moves `last` and it is computed again
   * (review 1.11c-2, point 7: the same numbers, read less often).
   */
  private async lastWeek(
    tx: Sql,
    scope: Scope,
    locationId: string,
    day: string,
    now: Date,
    timeZone: string,
  ): Promise<{ full: ReportData; untilNow: ReportData }> {
    const cut = await sequenceAt(
      tx,
      scope.restaurantId,
      scope.hubIds,
      sameLocalTimeDaysAgo(now, timeZone, 7),
    )
    const [mark] = await tx.query<{ last: string | number | null; contiguous: unknown }>(
      `SELECT (SELECT max(e.hub_sequence) FROM events e
               WHERE e.restaurant_id = $1 AND e.hub_id = ANY($2::text[]) AND e.business_day = $3::date
              ) AS last,
              (SELECT max(h.contiguous_sequence) FROM hubs h
               WHERE h.restaurant_id = $1 AND h.id = ANY($2::text[])) AS contiguous`,
      [scope.restaurantId, scope.hubIds, day],
    )
    const last = Number(mark?.last ?? 0)
    const complete = last > 0 && Number(mark?.contiguous ?? 0) >= last
    const base = [scope.restaurantId, locationId, [...scope.hubIds].sort().join(','), day, last]
    const fullKey = [...base, 'full'].join('|')
    const cutKey = [...base, Math.min(cut, last)].join('|')
    const at = now.getTime()
    let full = complete ? lastWeekCache.get(fullKey, at) : undefined
    let untilNow = complete ? lastWeekCache.get(cutKey, at) : undefined
    if (full && untilNow) return { full, untilNow }
    if (!full) {
      const loaded = await cloudReportData(tx, scope, day, day)
      full = loaded.data
      untilNow ??= (
        await cloudReportData(tx, { ...scope, upTo: cut }, day, day, {
          store: loaded.store.upTo(cut),
        })
      ).data
    } else {
      untilNow = (await cloudReportData(tx, { ...scope, upTo: cut }, day, day)).data
    }
    if (complete) {
      lastWeekCache.set(fullKey, full, at)
      lastWeekCache.set(cutKey, untilNow, at)
    }
    return { full, untilNow }
  }

  /**
   * The floor and the kitchen right now (task 1.11c-2, `GET /v1/panel/floor`): the open orders and
   * the kitchen cards, with the floor plan only if the panel does not have that version yet
   * (`knownPlan`).
   */
  async floor(s: PanelSession, knownPlan: string | null): Promise<LiveFloor> {
    return this.read(s, async (tx) => {
      const c = await this.context(tx, s)
      const live = await liveOrders(tx, c.live, addDays(c.today, -LIVE_WINDOW_DAYS))
      const plan = await readPlan(tx, s.restaurant.id, s.locationId, knownPlan)
      return {
        server_now: c.now.toISOString(),
        today: c.today,
        as_of: live.asOf,
        local: await this.local(tx, s),
        plan_version: plan.version,
        plan: plan.plan,
        timers: plan.timers,
        orders: live.orders.map((p) => p.status),
        tickets: live.tickets.map(ticketJson),
        users: userNames(c.names, namedOn(live.orders)),
      }
    })
  }

  /**
   * The registers (task 1.11c-2, `GET /v1/panel/register`): the open ones with what they should
   * have, as the hub computes it, and those closed today, with the variance threshold (today's
   * value, D3).
   */
  async register(s: PanelSession): Promise<RegisterAnswer> {
    return this.read(s, async (tx) => {
      const c = await this.context(tx, s)
      const r = await registersNow(
        tx,
        { open: c.live, closed: c.scope },
        addDays(c.today, -LIVE_WINDOW_DAYS),
        c.today,
      )
      return {
        server_now: c.now.toISOString(),
        today: c.today,
        as_of: r.asOf,
        local: await this.local(tx, s),
        threshold: c.config.register_variance_threshold,
        open: r.open,
        closed: r.closed,
        users: userNames(c.names, [
          ...r.open.map((o) => o.opened_by),
          ...r.closed.flatMap((x) => [x.openedBy, x.closedBy]),
        ]),
      }
    })
  }

  /**
   * The alerts of a business day (task 1.11c-2, `GET /v1/panel/alerts`): today without a day; at
   * most ALERT_DAYS days back. The variance threshold is today's value, also for an older close
   * (D3).
   */
  async alerts(s: PanelSession, day?: string): Promise<AlertsAnswer | { error: string }> {
    if (day !== undefined && !isDay(day)) return { error: 'Fecha inválida' }
    return this.read(s, async (tx) => {
      const c = await this.context(tx, s)
      const wanted = day ?? c.today
      if (wanted > c.today) return { error: 'Ese día todavía no ha llegado' }
      if (wanted < addDays(c.today, -ALERT_DAYS))
        return { error: `Las alertas se ven hasta ${ALERT_DAYS} días atrás` }
      const r = await dayAlerts(tx, c.scope, wanted, c.config)
      return {
        server_now: c.now.toISOString(),
        today: c.today,
        day: wanted,
        as_of: r.asOf,
        local: await this.local(tx, s),
        threshold: c.config.register_variance_threshold,
        alerts: r.alerts,
        users: userNames(c.names, alertPeople(r.alerts)),
        tables: await tableNames(tx, s.restaurant.id, s.locationId, alertTables(r.alerts)),
      }
    })
  }

  /** Since when there is no news from the location and how much is left to upload. */
  async local(tx: Sql, s: PanelSession): Promise<LocalState> {
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
