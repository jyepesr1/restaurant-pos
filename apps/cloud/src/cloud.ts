import { eventFingerprint } from '@pos/sync'
import { z } from 'zod'
import type { Sql } from './sql'

// The cloud logic (task 1.10, ADR-016): restaurants, hub registration with a single-use code and
// receiving the events each hub uploads, without duplicates. It knows nothing about HTTP (that is
// `api.ts`) or how it connects to Postgres (`sql.ts`).

/** How many events fit in a batch. The hub uploads several at a time to catch up quickly. */
export const MAX_EVENTS_PER_BATCH = 500
/** An event bigger than this is not a POS event (the hub limits what it accepts). */
export const MAX_EVENT_BYTES = 64 * 1024
/** How long a registration code lasts. */
export const CODE_TTL_MS = 24 * 60 * 60 * 1000

const validYear = (t: string) => {
  const year = Number(t.slice(0, 4))
  return year >= 2000 && year <= 2999
}
/** "Z" or an offset of up to 14 hours (the largest that exists). */
const validOffset = (t: string) => {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(t)
  return !m || Number(m[2]) * 60 + Number(m[3]) <= 14 * 60
}

const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

/**
 * The minimum the cloud requires of an event: the envelope with what the hub set. The data is not
 * checked here: the hub already accepted it, and the cloud does not reject what the hub accepted
 * (ADR-016).
 */
const EventUploaded = z.looseObject({
  id: Ulid,
  type: z.string().min(1).max(60),
  aggregate_type: z.string().min(1).max(30),
  aggregate_id: Ulid,
  sequence: z.int().min(1),
  // Reasonable dates for a POS: Postgres does not accept year 0 or impossible hour offsets.
  received_at: z.iso.datetime({ offset: true }).refine((t) => validYear(t) && validOffset(t)),
  business_day: z.iso.date().refine(validYear),
  data: z.record(z.string(), z.unknown()),
})

export const Registration = z.strictObject({
  code: z.string().min(1).max(40),
  /** The hub's restaurant: a code from another restaurant is refused without using it up. */
  restaurant_id: Ulid,
  hub_id: Ulid,
  location_id: Ulid,
  name: z.string().trim().min(1).max(60),
  instance: z.string().min(1).max(100),
})
export type Registration = z.infer<typeof Registration>

export const NewRestaurant = z.strictObject({
  id: Ulid,
  name: z.string().trim().min(1).max(120),
})

/** What happened to each event in a batch. */
export type EventResult =
  | { id: string; status: 'saved' | 'already_stored' }
  /** The id already existed with other content: the stored one stays, the new one is for review. */
  | { id: string; status: 'divergent' }
  | { id: string | null; status: 'invalid'; reason: string }

export interface AuthenticatedHub {
  id: string
  restaurantId: string
  locationId: string
}

/**
 * Postgres does not store the null character or half a Unicode surrogate pair in `jsonb`: such a
 * text would make the whole batch fail. Values and keys are checked.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const NUL = String.fromCharCode(0)
const isInvalid = (text: string) => text.includes(NUL) || LONE_SURROGATE.test(text)
export function isValidText(value: unknown): boolean {
  // No recursion: deeply nested data does not exhaust the stack.
  const pendingList: unknown[] = [value]
  while (pendingList.length > 0) {
    const v = pendingList.pop()
    if (typeof v === 'string') {
      if (isInvalid(v)) return false
    } else if (Array.isArray(v)) pendingList.push(...v)
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (isInvalid(k)) return false
        pendingList.push(x)
      }
  }
  return true
}

/** A Postgres error for a value it rejects (class 22: dates, texts, numbers out of range). */
const isDataError = (e: unknown) => String((e as { code?: unknown })?.code ?? '').startsWith('22')

// ── Credentials ────────────────────────────────────────────────────────

/** SHA-256 in hexadecimal (Web Crypto: the same in Workers and in Node). */
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const randomBytes = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes))

/** A hub credential: 32 random bytes in base64url. Shown once; its fingerprint is stored. */
export function newCredential(): string {
  return btoa(String.fromCharCode(...randomBytes(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

/** No characters that get confused when read aloud (0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** "K7PM-QX2R-9DHT": 12 characters to type by hand when installing the register PC. */
export function newCode(): string {
  const letters = [...randomBytes(12)].map((b) => ALPHABET[b % ALPHABET.length]).join('')
  return `${letters.slice(0, 4)}-${letters.slice(4, 8)}-${letters.slice(8)}`
}

/** The code however the person types it: without spaces or dashes and in uppercase. */
export const normalizeCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase()

// ── Operations ─────────────────────────────────────────────────────────

export class Cloud {
  private readonly sql: Sql
  private readonly clock: () => Date

  constructor(sql: Sql, clock: () => Date = () => new Date()) {
    this.sql = sql
    this.clock = clock
  }

  /**
   * Runs the job inside a single-restaurant transaction: the database's row-level security only
   * lets it see and write that restaurant's events, even if a query forgets to filter.
   */
  private inRestaurant<T>(restaurantId: string, job: (tx: Sql) => Promise<T>): Promise<T> {
    return this.sql.transaction(async (tx) => {
      await tx.query("SELECT set_config('faro.restaurant_id', $1, true)", [restaurantId])
      await tx.query('SET LOCAL ROLE faro_data')
      return job(tx)
    })
  }

  /** Creates the restaurant if it does not exist (with the same id it has in its hub). */
  async createRestaurant(
    data: z.infer<typeof NewRestaurant>,
  ): Promise<'created' | 'already_existed'> {
    const rows = await this.sql.query(
      'INSERT INTO restaurants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
      [data.id, data.name],
    )
    return rows.length > 0 ? 'created' : 'already_existed'
  }

  /** A code to register one of the restaurant's hubs; null if the restaurant does not exist. */
  async createCode(restaurantId: string): Promise<{ code: string; expiresAt: string } | null> {
    const [exists] = await this.sql.query('SELECT 1 FROM restaurants WHERE id = $1', [restaurantId])
    if (!exists) return null
    const code = newCode()
    const expiresAt = new Date(this.clock().getTime() + CODE_TTL_MS).toISOString()
    await this.sql.query(
      'INSERT INTO registration_codes (fingerprint, restaurant_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [await sha256(normalizeCode(code)), restaurantId, this.clock().toISOString(), expiresAt],
    )
    return { code, expiresAt }
  }

  /**
   * Registers a hub with its code and returns its credential. The code expires after 24 hours and
   * belongs to a single hub: if the response was lost (the Wi-Fi dropped), the same hub can repeat
   * the registration with the same code until it expires and gets a new credential (the previous
   * one stops working). Another hub with a used code, or the same hub with another code, is not
   * registered. A code from another restaurant is refused and stays unused: the hub would end up
   * uploading its events to the wrong restaurant.
   */
  async registerHub(
    data: Registration,
  ): Promise<
    | { ok: true; credential: string; restaurantId: string }
    | { ok: false; reason: 'invalid_code' | 'other_restaurant' | 'hub_already_registered' }
  > {
    const fingerprint = await sha256(normalizeCode(data.code))
    const credential = newCredential()
    const credentialHash = await sha256(credential)
    const now = this.clock().toISOString()
    try {
      return await this.sql.transaction(async (tx) => {
        // FOR UPDATE: two concurrent registrations with the same code do not both use it.
        const [code] = await tx.query<{ restaurant_id: string; hub_id: string | null }>(
          `SELECT restaurant_id, hub_id FROM registration_codes
           WHERE fingerprint = $1 AND expires_at > $2 FOR UPDATE`,
          [fingerprint, now],
        )
        if (!code) return { ok: false, reason: 'invalid_code' } as const
        if (code.restaurant_id !== data.restaurant_id)
          return { ok: false, reason: 'other_restaurant' } as const
        if (code.hub_id !== null) {
          // Already used: only the same hub can repeat it, and only if it was not revoked.
          if (code.hub_id !== data.hub_id) return { ok: false, reason: 'invalid_code' } as const
          const duplicate = await tx.query(
            `UPDATE hubs SET credential_hash = $2
             WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
            [data.hub_id, credentialHash],
          )
          if (duplicate.length === 0) return { ok: false, reason: 'invalid_code' } as const
          return { ok: true, credential, restaurantId: code.restaurant_id } as const
        }
        const [already] = await tx.query('SELECT 1 FROM hubs WHERE id = $1', [data.hub_id])
        if (already) return { ok: false, reason: 'hub_already_registered' } as const
        await tx.query(
          `INSERT INTO hubs (id, restaurant_id, location_id, name, instance, credential_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            data.hub_id,
            code.restaurant_id,
            data.location_id,
            data.name,
            data.instance,
            credentialHash,
            now,
          ],
        )
        await tx.query(
          'UPDATE registration_codes SET used_at = $2, hub_id = $3 WHERE fingerprint = $1',
          [fingerprint, now, data.hub_id],
        )
        return { ok: true, credential, restaurantId: code.restaurant_id } as const
      })
    } catch (e) {
      // Two concurrent registrations of the same hub with different codes: the second hits the key.
      if ((e as { code?: string }).code === '23505')
        return { ok: false, reason: 'hub_already_registered' }
      throw e
    }
  }

  /** The hub that owns a credential, if it exists and is not revoked. */
  async authenticate(credential: string): Promise<AuthenticatedHub | null> {
    if (!credential || credential.length > 200) return null
    const [hub] = await this.sql.query<{ id: string; restaurant_id: string; location_id: string }>(
      'SELECT id, restaurant_id, location_id FROM hubs WHERE credential_hash = $1 AND revoked_at IS NULL',
      [await sha256(credential)],
    )
    return hub ? { id: hub.id, restaurantId: hub.restaurant_id, locationId: hub.location_id } : null
  }

  /** Revokes a hub: its credential stops working. */
  async revokeHub(hubId: string): Promise<boolean> {
    const rows = await this.sql.query(
      'UPDATE hubs SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id',
      [hubId, this.clock().toISOString()],
    )
    return rows.length > 0
  }

  /**
   * Saves a batch of the hub's events in one transaction. An event already stored (same id and
   * content) is not duplicated; one already stored with other content does not overwrite the
   * stored one and goes to `divergent_events`. Returns each one's result, in arrival order.
   */
  async receiveEvents(hub: AuthenticatedHub, rawList: readonly unknown[]): Promise<EventResult[]> {
    const results: EventResult[] = []
    type ValidEntry = {
      index: number
      id: string
      fingerprint: string
      row: Record<string, unknown>
    }
    const validEntries: ValidEntry[] = []
    /** The same id again in the batch: compared with whatever ends up stored. */
    const duplicatesInBatch: ValidEntry[] = []
    const seenSet = new Set<string>()
    rawList.forEach((raw, index) => {
      const r = EventUploaded.safeParse(raw)
      // The id is only returned if it looks like an id (the hub does not get arbitrary text back).
      const rawId = (raw as { id?: unknown } | null)?.id
      const id = typeof rawId === 'string' && rawId.length <= 26 ? rawId : null
      if (!r.success) {
        results[index] = { id, status: 'invalid', reason: 'format' }
        return
      }
      // The fingerprint also limits nesting: that way what follows does not walk bottomless data.
      let fingerprint: string
      try {
        fingerprint = eventFingerprint(r.data)
      } catch {
        results[index] = { id: r.data.id, status: 'invalid', reason: 'too_deeply_nested' }
        return
      }
      if (!isValidText(r.data)) {
        results[index] = { id: r.data.id, status: 'invalid', reason: 'invalid_character' }
        return
      }
      const content = JSON.stringify(r.data)
      if (new TextEncoder().encode(content).length > MAX_EVENT_BYTES) {
        results[index] = { id: r.data.id, status: 'invalid', reason: 'too_large' }
        return
      }
      const valid: ValidEntry = {
        index,
        id: r.data.id,
        fingerprint,
        row: {
          id: r.data.id,
          type: r.data.type,
          aggregate_type: r.data.aggregate_type,
          aggregate_id: r.data.aggregate_id,
          hub_sequence: r.data.sequence,
          business_day: r.data.business_day,
          received_at: r.data.received_at,
          content: r.data,
          fingerprint,
        },
      }
      if (seenSet.has(r.data.id)) duplicatesInBatch.push(valid)
      else {
        seenSet.add(r.data.id)
        validEntries.push(valid)
      }
    })
    if (validEntries.length === 0) return results

    return this.inRestaurant(hub.restaurantId, async (tx) => {
      const insert = (rows: ValidEntry[]) =>
        tx.query<{ id: string }>(
          `INSERT INTO events (restaurant_id, id, hub_id, type, aggregate_type, aggregate_id,
                               hub_sequence, business_day, received_at, content, fingerprint)
           SELECT $1, x.id, $2, x.type, x.aggregate_type, x.aggregate_id,
                  x.hub_sequence, x.business_day, x.received_at, x.content, x.fingerprint
           FROM jsonb_to_recordset($3::jsonb) AS x(
             id text, type text, aggregate_type text, aggregate_id text, hub_sequence bigint,
             business_day date, received_at timestamptz, content jsonb, fingerprint text)
           ON CONFLICT (restaurant_id, id) DO NOTHING
           RETURNING id`,
          [hub.restaurantId, hub.id, JSON.stringify(rows.map((v) => v.row))],
        )
      // A single statement for the whole batch. If the database rejects a value (a date Postgres
      // does not accept, for example), they are tried one by one: the bad one is invalid and the
      // rest go in. Otherwise the hub would retry forever a batch that never goes through.
      let toSave = validEntries
      let savedList: { id: string }[]
      await tx.query('SAVEPOINT batch')
      try {
        savedList = await insert(validEntries)
        await tx.query('RELEASE SAVEPOINT batch')
      } catch (e) {
        if (!isDataError(e)) throw e
        await tx.query('ROLLBACK TO SAVEPOINT batch')
        savedList = []
        toSave = []
        for (const v of validEntries) {
          await tx.query('SAVEPOINT single')
          try {
            savedList.push(...(await insert([v])))
            await tx.query('RELEASE SAVEPOINT single')
            toSave.push(v)
          } catch (e2) {
            if (!isDataError(e2)) throw e2
            await tx.query('ROLLBACK TO SAVEPOINT single')
            results[v.index] = { id: v.id, status: 'invalid', reason: 'rejected_by_database' }
          }
        }
      }

      const newer = new Set(savedList.map((g) => g.id))
      // What ended up stored for each id: the new one from this batch or the earlier one.
      const saved = new Map<string, string>()
      for (const v of toSave) if (newer.has(v.id)) saved.set(v.id, v.fingerprint)
      const toQuery = [
        ...new Set(
          [...toSave, ...duplicatesInBatch].map((v) => v.id).filter((id) => !saved.has(id)),
        ),
      ]
      if (toQuery.length > 0) {
        const rows = await tx.query<{ id: string; fingerprint: string }>(
          'SELECT id, fingerprint FROM events WHERE restaurant_id = $1 AND id = ANY($2::text[])',
          [hub.restaurantId, toQuery],
        )
        for (const f of rows) saved.set(f.id, f.fingerprint)
      }
      const inBatch = duplicatesInBatch.filter((v) => saved.has(v.id))
      const altered = [...toSave.filter((v) => !newer.has(v.id)), ...inBatch].filter(
        (v) => saved.get(v.id) !== v.fingerprint,
      )
      if (altered.length > 0)
        await tx.query(
          `INSERT INTO divergent_events (restaurant_id, event_id, hub_id, content, fingerprint)
           SELECT $1, x.id, $2, x.content, x.fingerprint
           FROM jsonb_to_recordset($3::jsonb) AS x(id text, content jsonb, fingerprint text)
           ON CONFLICT (restaurant_id, event_id, fingerprint) DO NOTHING`,
          [hub.restaurantId, hub.id, JSON.stringify(altered.map((d) => d.row))],
        )
      for (const v of [...toSave, ...duplicatesInBatch]) {
        if (!saved.has(v.id)) {
          // A repeat in the batch of one the database rejected: it shares the same fate.
          results[v.index] = { id: v.id, status: 'invalid', reason: 'rejected_by_database' }
          continue
        }
        const isNew = newer.has(v.id) && !duplicatesInBatch.includes(v)
        results[v.index] = {
          id: v.id,
          status: isNew
            ? 'saved'
            : saved.get(v.id) === v.fingerprint
              ? 'already_stored'
              : 'divergent',
        }
      }
      // What is stored with no gaps from sequence 1: the hub continues from there (`lastSequence`).
      // Besides the events this hub saved, what it just sent and was already stored with the same
      // content counts: a hub registered again after a revocation, or a new PC (task 1.12),
      // resends events that the previous registration already uploaded. A divergent one does not
      // count: its sequence is not the stored event's, so it would hide a gap.
      const received = [...toSave, ...duplicatesInBatch]
        .filter(
          (v) =>
            results[v.index]?.status === 'saved' || results[v.index]?.status === 'already_stored',
        )
        .map((v) => Number(v.row.hub_sequence))
      await tx.query(
        `UPDATE hubs SET contiguous_sequence = (
           SELECT coalesce(max(s.q), hubs.contiguous_sequence) FROM (
             SELECT q, row_number() OVER (ORDER BY q) AS n
             FROM (SELECT DISTINCT q FROM (
                     SELECT hub_sequence AS q FROM events WHERE restaurant_id = $1 AND hub_id = $2
                     UNION SELECT unnest($3::bigint[])
                   ) u WHERE q > hubs.contiguous_sequence) d
           ) s WHERE s.q = hubs.contiguous_sequence + s.n)
         WHERE id = $2`,
        [hub.restaurantId, hub.id, received],
      )
      return results
    })
  }

  /**
   * Up to which hub sequence everything is in the cloud, with no gaps from 1: it keeps uploading
   * from there. If an event could not be saved (invalid), it stays there and the hub must report
   * it.
   */
  async lastSequence(hub: AuthenticatedHub): Promise<number> {
    const [row] = await this.sql.query<{ s: string | number }>(
      'SELECT contiguous_sequence AS s FROM hubs WHERE id = $1',
      [hub.id],
    )
    return Number(row?.s ?? 0)
  }
}
