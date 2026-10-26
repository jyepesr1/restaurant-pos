import { createHash } from 'node:crypto'
import { newId } from '@pos/core'
import type { SqliteDatabase, SqlValue } from '@pos/db'

// Writing versioned records (catalog and configuration, category V): each change takes the
// next value of the global catalog counter (docs/SYNC.md#catálogo-y-configuración).

/** Next value of the restaurant's catalog counter. */
export function nextVersion(db: SqliteDatabase, restaurantId: string): number {
  const row = db
    .prepare(
      `INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)
       ON CONFLICT (restaurant_id, name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(restaurantId)
  return Number(row?.value)
}

/** Catalog tables: each change to them is recorded in `catalog_changes` (`CatalogChanged`). */
export const CATALOG_TABLES = [
  'taxes',
  'stations',
  'categories',
  'products',
  'variants',
  'modifier_groups',
  'product_modifier_groups',
  'modifiers',
  'product_stations',
] as const
export type CatalogTable = (typeof CATALOG_TABLES)[number]

const isCatalogTable = (tableName: string): tableName is CatalogTable =>
  (CATALOG_TABLES as readonly string[]).includes(tableName)

const readRow = (db: SqliteDatabase, tableName: string, restaurantId: string, id: string) =>
  db.prepare(`SELECT * FROM ${tableName} WHERE restaurant_id = ? AND id = ?`).get(restaurantId, id)

/** Records in the history how the record ended up (and how it was), in the same transaction. */
function recordChange(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  id: string,
  before: Record<string, unknown> | undefined,
  author: Author,
  now: string,
) {
  if (!isCatalogTable(tableName)) return
  const after = readRow(db, tableName, restaurantId, id)
  if (!after) return
  db.prepare(
    `INSERT INTO catalog_changes
       (restaurant_id, version, entity, record_id, before, after, user_id, device_id, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    restaurantId,
    Number(after.version),
    tableName,
    id,
    before ? JSON.stringify(before) : null,
    JSON.stringify(after),
    author.userId,
    author.deviceId,
    now,
  )
}

export interface Author {
  userId: string | null
  deviceId: string | null
}

export const SYSTEM: Author = { userId: null, deviceId: null }

/** Inserts a versioned record with its common columns. Returns its id. */
export function insertVersioned(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  fields: Record<string, SqlValue>,
  author: Author,
  now: string,
  id: string = newId(),
): string {
  const row: Record<string, SqlValue> = {
    id,
    restaurant_id: restaurantId,
    created_at: now,
    updated_at: now,
    version: nextVersion(db, restaurantId),
    user_id: author.userId,
    device_id: author.deviceId,
    active: 1,
    ...fields,
  }
  const columns = Object.keys(row)
  db.prepare(
    `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...Object.values(row))
  recordChange(db, tableName, restaurantId, id, undefined, author, now)
  return id
}

/** Updates a versioned record: bumps its version and records who and when. */
export function updateVersioned(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  id: string,
  fields: Record<string, SqlValue>,
  author: Author,
  now: string,
) {
  const before = readRow(db, tableName, restaurantId, id)
  const all: Record<string, SqlValue> = {
    ...fields,
    updated_at: now,
    version: nextVersion(db, restaurantId),
    user_id: author.userId,
    device_id: author.deviceId,
  }
  const assignments = Object.keys(all).map((c) => `${c} = ?`)
  db.prepare(
    `UPDATE ${tableName} SET ${assignments.join(', ')} WHERE restaurant_id = ? AND id = ?`,
  ).run(...Object.values(all), restaurantId, id)
  recordChange(db, tableName, restaurantId, id, before, author, now)
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Stable ID for a record that is always "the same" (what the seed creates): a valid ULID with
 * the restaurant's timestamp and the rest derived from the key. The same restaurant and the
 * same key always give the same ID; running the seed again duplicates nothing.
 */
export function stableId(restaurantId: string, key: string): string {
  const bytes = createHash('sha256').update(`${restaurantId}:${key}`).digest()
  const random = Array.from({ length: 16 }, (_, i) => CROCKFORD[(bytes[i] as number) % 32]).join('')
  return `${restaurantId.slice(0, 10)}${random}`
}

export type Change = 'created' | 'updated' | 'equal' | 'respected' | 'archived'

/**
 * Leaves the versioned record `id` with those fields: creates it, updates it (and reactivates it
 * if it was archived) or leaves it alone if it is already equal. Only a real change bumps the
 * version.
 *
 * What a person wrote (non-null `user_id`: the catalog editor, the configuration) is respected:
 * the system does not overwrite it. With `createOnly`, an existing record is left untouched.
 */
export function saveVersioned(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  id: string,
  fields: Record<string, SqlValue>,
  author: Author,
  now: string,
  options: { createOnly?: boolean } = {},
): Change {
  const current = db
    .prepare(`SELECT * FROM ${tableName} WHERE restaurant_id = ? AND id = ?`)
    .get(restaurantId, id)
  if (!current) {
    insertVersioned(db, tableName, restaurantId, fields, author, now, id)
    return 'created'
  }
  if (options.createOnly || current.user_id !== null) return 'respected'
  const desired = { ...fields, active: 1 }
  if (Object.entries(desired).every(([column, value]) => current[column] === value)) return 'equal'
  updateVersioned(db, tableName, restaurantId, id, desired, author, now)
  return 'updated'
}
