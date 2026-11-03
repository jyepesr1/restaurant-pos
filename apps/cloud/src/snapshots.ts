import { RestaurantConfig } from '@pos/core'
import { z } from 'zod'
import { type AuthenticatedHub, inRestaurant, isValidText } from './cloud'
import type { Sql } from './sql'

// The hub's read-only snapshots (task 1.11c-1, docs/PANEL.md#instantáneas-put-v1snapshotskind):
// the catalog, the config, the people, the roles and who can sign in to the panel. They live in
// the hub until task 1.11b; the cloud keeps only the last of each kind, per restaurant and
// location.

/** A snapshot is at most this big (the catalog of a large restaurant fits with room to spare). */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The same verifier the hub stores (`scrypt$cost$r$p$salt$hash`, apps/hub/src/access/secrets.ts). */
export const Verifier = z
  .string()
  .max(300)
  .regex(/^scrypt\$\d{1,2}\$8\$1\$[A-Za-z0-9_-]{16,64}\$[A-Za-z0-9_-]{16,128}$/)

const Permissions = z.array(z.string().min(1).max(60)).max(200)

/**
 * What each kind carries. Unknown fields are dropped (`z.object`), so nothing the hub did not mean
 * to share (a PIN, say) is stored by mistake.
 */
export const SNAPSHOT_CONTENT = {
  /** `readCatalog()` of the hub (`/api/catalog`), with its `version`. */
  catalog: z.record(z.string(), z.unknown()),
  // The same schema the reports read it with: a config the cloud could not read is refused here,
  // where the hub sees it, and not later when computing a report.
  config: z.object({
    config: RestaurantConfig,
    time_zone: z.string().min(1).max(60).refine(validTimeZone),
  }),
  // Also the kitchen screens' technical users and their hidden role (ADR-015).
  people: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        name: z.string().max(120),
        role_id: z.string().max(40).nullable(),
        active: z.boolean(),
      }),
    )
    .max(10_000),
  roles: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        name: z.string().max(120),
        permissions: Permissions,
        active: z.boolean(),
      }),
    )
    .max(1_000),
  remote_users: z
    .array(
      z.object({
        user_id: Ulid,
        username: z.string().regex(/^[a-z0-9._-]{3,40}$/),
        name: z.string().max(120),
        verifier: Verifier,
        permissions: Permissions,
      }),
    )
    .max(1_000)
    .refine((list) => new Set(list.map((u) => u.username)).size === list.length)
    .refine((list) => new Set(list.map((u) => u.user_id)).size === list.length),
} as const

export type SnapshotKind = keyof typeof SNAPSHOT_CONTENT
export const SNAPSHOT_KINDS = Object.keys(SNAPSHOT_CONTENT) as SnapshotKind[]
export const isSnapshotKind = (k: string): k is SnapshotKind => Object.hasOwn(SNAPSHOT_CONTENT, k)

export type ConfigSnapshot = z.infer<(typeof SNAPSHOT_CONTENT)['config']>
export type PeopleSnapshot = z.infer<(typeof SNAPSHOT_CONTENT)['people']>

const Body = z.strictObject({
  fingerprint: z.string().min(1).max(128),
  content: z.unknown(),
})

/**
 * Saves a snapshot from the hub. `remote_users` replaces the table of who can sign in, in the same
 * transaction; its stored snapshot keeps only how many there are (the verifiers live only in
 * `remote_users`). The same fingerprint as the stored one does nothing.
 */
export async function saveSnapshot(
  sql: Sql,
  hub: AuthenticatedHub,
  kind: SnapshotKind,
  body: unknown,
  now: Date,
): Promise<'saved' | 'unchanged' | 'revoked' | { invalid: string }> {
  const parsedBody = Body.safeParse(body)
  if (!parsedBody.success || !isValidText(parsedBody.data))
    return { invalid: 'Instantánea con formato inesperado' }
  // The config is kept as the hub sent it (not with the defaults filled in): only checked.
  const content = SNAPSHOT_CONTENT[kind].safeParse(parsedBody.data.content)
  if (!content.success)
    return {
      invalid:
        kind === 'config'
          ? `La configuración del restaurante no se puede leer (${fieldsOf(content.error)})`
          : 'Instantánea con formato inesperado',
    }
  const stored =
    kind === 'config'
      ? {
          config: (parsedBody.data.content as { config: unknown }).config,
          time_zone: (content.data as ConfigSnapshot).time_zone,
        }
      : content.data
  const { fingerprint } = parsedBody.data
  return inRestaurant(sql, hub.restaurantId, async (tx) => {
    // The hub may have been revoked after it authenticated: checked again here, with its row
    // locked, so a revocation in progress (which empties remote_users) goes first or after, never
    // in between.
    const [active] = await tx.query(
      'SELECT 1 FROM hubs WHERE id = $1 AND revoked_at IS NULL FOR SHARE',
      [hub.id],
    )
    if (!active) return 'revoked'
    const [current] = await tx.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM snapshots
       WHERE restaurant_id = $1 AND location_id = $2 AND kind = $3 FOR UPDATE`,
      [hub.restaurantId, hub.locationId, kind],
    )
    if (current?.fingerprint === fingerprint) {
      // The same content: only who sent it and when (a re-registered PC leaves its new hub_id).
      await tx.query(
        `UPDATE snapshots SET hub_id = $4, uploaded_at = $5
         WHERE restaurant_id = $1 AND location_id = $2 AND kind = $3`,
        [hub.restaurantId, hub.locationId, kind, hub.id, now.toISOString()],
      )
      return 'unchanged'
    }
    const users =
      kind === 'remote_users'
        ? (content.data as z.infer<typeof SNAPSHOT_CONTENT.remote_users>)
        : null
    // The upsert locks the row: two uploads of the same kind at once go one after the other.
    await tx.query(
      `INSERT INTO snapshots (restaurant_id, location_id, kind, fingerprint, content, hub_id, uploaded_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (restaurant_id, location_id, kind) DO UPDATE
       SET fingerprint = EXCLUDED.fingerprint, content = EXCLUDED.content,
           hub_id = EXCLUDED.hub_id, uploaded_at = EXCLUDED.uploaded_at`,
      [
        hub.restaurantId,
        hub.locationId,
        kind,
        fingerprint,
        JSON.stringify(users ? { users: users.length } : stored),
        hub.id,
        now.toISOString(),
      ],
    )
    if (users) {
      await tx.query('DELETE FROM remote_users WHERE restaurant_id = $1 AND location_id = $2', [
        hub.restaurantId,
        hub.locationId,
      ])
      if (users.length > 0)
        await tx.query(
          `INSERT INTO remote_users (restaurant_id, location_id, user_id, username, name, verifier, permissions)
           SELECT $1, $2, x.user_id, x.username, x.name, x.verifier,
                  ARRAY(SELECT jsonb_array_elements_text(x.permissions))
           FROM jsonb_to_recordset($3::jsonb) AS x(
             user_id text, username text, name text, verifier text, permissions jsonb)`,
          [hub.restaurantId, hub.locationId, JSON.stringify(users)],
        )
    }
    return 'saved'
  })
}

/** The last snapshot of a kind for a location, or null. */
export async function readSnapshot<K extends Exclude<SnapshotKind, 'remote_users'>>(
  tx: Sql,
  restaurantId: string,
  locationId: string,
  kind: K,
): Promise<z.infer<(typeof SNAPSHOT_CONTENT)[K]> | null> {
  const [row] = await tx.query<{ content: unknown }>(
    'SELECT content FROM snapshots WHERE restaurant_id = $1 AND location_id = $2 AND kind = $3',
    [restaurantId, locationId, kind],
  )
  if (!row) return null
  const r = SNAPSHOT_CONTENT[kind].safeParse(row.content)
  return r.success ? (r.data as z.infer<(typeof SNAPSHOT_CONTENT)[K]>) : null
}

/** The fields a Zod error names, for the message («sales_by_waiter, otra_clave»). */
function fieldsOf(error: z.ZodError): string {
  const fields = error.issues.flatMap((i) => {
    const keys = (i as { keys?: string[] }).keys
    const path = i.path.filter((p) => p !== 'config').map(String)
    return keys?.length ? keys : [path.join('.') || 'config']
  })
  return [...new Set(fields)].join(', ')
}

const DEFAULT_TIME_ZONE = 'America/Bogota'

/**
 * The location's config and time zone for reports. It was checked on upload; if it still cannot
 * be read (a field the code no longer knows, say), only that field takes its default, and the log
 * says so. Without a snapshot: the defaults and Bogotá.
 */
export async function readConfig(
  tx: Sql,
  restaurantId: string,
  locationId: string,
): Promise<{ config: RestaurantConfig; timeZone: string }> {
  const [row] = await tx.query<{ content: { config?: unknown; time_zone?: unknown } | null }>(
    "SELECT content FROM snapshots WHERE restaurant_id = $1 AND location_id = $2 AND kind = 'config'",
    [restaurantId, locationId],
  )
  const tz = row?.content?.time_zone
  const timeZone = typeof tz === 'string' && validTimeZone(tz) ? tz : DEFAULT_TIME_ZONE
  if (row && timeZone !== tz)
    console.warn('Unreadable time zone in the configuration; using America/Bogota', {
      restaurantId,
    })
  return { config: configFrom(row?.content?.config, restaurantId), timeZone }
}

/** The config with its defaults; a field that cannot be read takes its default (and is logged). */
export function configFrom(partial: unknown, restaurantId = ''): RestaurantConfig {
  let candidate: Record<string, unknown> =
    partial && typeof partial === 'object' && !Array.isArray(partial)
      ? { ...(partial as Record<string, unknown>) }
      : {}
  for (let attempt = 0; attempt < 50; attempt++) {
    const r = RestaurantConfig.safeParse(candidate)
    if (r.success) return r.data
    const bad = new Set<string>()
    for (const issue of r.error.issues) {
      const keys = (issue as { keys?: string[] }).keys
      if (keys?.length) for (const k of keys) bad.add(k)
      else if (issue.path[0] !== undefined) bad.add(String(issue.path[0]))
    }
    console.warn('Unreadable configuration in the cloud: those fields take their default value', {
      restaurantId,
      fields: [...bad],
    })
    if (bad.size === 0) break
    candidate = Object.fromEntries(Object.entries(candidate).filter(([k]) => !bad.has(k)))
  }
  return RestaurantConfig.parse({})
}
