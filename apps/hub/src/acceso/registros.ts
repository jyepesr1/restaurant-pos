import { createHash } from 'node:crypto'
import { newId } from '@pos/core'
import type { SqliteDatabase, SqlValue } from '@pos/db'

// Escritura de registros versionados (catálogo y configuración, categoría V): cada cambio toma
// el siguiente valor del contador global del catálogo (docs/SYNC.md#catálogo-y-configuración).

/** Siguiente valor del contador de catálogo del restaurante. */
export function siguienteVersion(db: SqliteDatabase, restaurantId: string): number {
  const row = db
    .prepare(
      `INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)
       ON CONFLICT (restaurant_id, name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(restaurantId)
  return Number(row?.value)
}

/** Tablas del catálogo: cada cambio suyo queda en `catalog_changes` (`CatalogoCambiado`). */
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
export type TablaCatalogo = (typeof CATALOG_TABLES)[number]

const esDelCatalogo = (tableName: string): tableName is TablaCatalogo =>
  (CATALOG_TABLES as readonly string[]).includes(tableName)

const leerFila = (db: SqliteDatabase, tableName: string, restaurantId: string, id: string) =>
  db.prepare(`SELECT * FROM ${tableName} WHERE restaurant_id = ? AND id = ?`).get(restaurantId, id)

/** Deja en el historial cómo quedó el registro (y cómo estaba), en la misma transacción. */
function anotarCambio(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  id: string,
  before: Record<string, unknown> | undefined,
  autor: Autor,
  now: string,
) {
  if (!esDelCatalogo(tableName)) return
  const after = leerFila(db, tableName, restaurantId, id)
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
    autor.userId,
    autor.deviceId,
    now,
  )
}

export interface Autor {
  userId: string | null
  deviceId: string | null
}

export const SISTEMA: Autor = { userId: null, deviceId: null }

/** Inserta un registro versionado con sus columnas comunes. Devuelve su id. */
export function insertVersioned(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  fields: Record<string, SqlValue>,
  autor: Autor,
  now: string,
  id: string = newId(),
): string {
  const row: Record<string, SqlValue> = {
    id,
    restaurant_id: restaurantId,
    created_at: now,
    updated_at: now,
    version: siguienteVersion(db, restaurantId),
    user_id: autor.userId,
    device_id: autor.deviceId,
    active: 1,
    ...fields,
  }
  const columns = Object.keys(row)
  db.prepare(
    `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...Object.values(row))
  anotarCambio(db, tableName, restaurantId, id, undefined, autor, now)
  return id
}

/** Actualiza un registro versionado: sube su versión y deja quién y cuándo. */
export function actualizarVersionado(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  id: string,
  fields: Record<string, SqlValue>,
  autor: Autor,
  now: string,
) {
  const before = leerFila(db, tableName, restaurantId, id)
  const all: Record<string, SqlValue> = {
    ...fields,
    updated_at: now,
    version: siguienteVersion(db, restaurantId),
    user_id: autor.userId,
    device_id: autor.deviceId,
  }
  const assignments = Object.keys(all).map((c) => `${c} = ?`)
  db.prepare(
    `UPDATE ${tableName} SET ${assignments.join(', ')} WHERE restaurant_id = ? AND id = ?`,
  ).run(...Object.values(all), restaurantId, id)
  anotarCambio(db, tableName, restaurantId, id, before, autor, now)
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ID estable para un registro que siempre es "el mismo" (lo que crea el seed): un ULID válido con
 * la marca de tiempo del restaurante y el resto sacado de la clave. El mismo restaurante y la
 * misma clave dan siempre el mismo ID; correr el seed otra vez no duplica nada.
 */
export function idEstable(restaurantId: string, key: string): string {
  const bytes = createHash('sha256').update(`${restaurantId}:${key}`).digest()
  const random = Array.from({ length: 16 }, (_, i) => CROCKFORD[(bytes[i] as number) % 32]).join('')
  return `${restaurantId.slice(0, 10)}${random}`
}

export type Cambio = 'created' | 'updated' | 'equal' | 'respected' | 'archived'

/**
 * Deja el registro versionado `id` con esos campos: lo crea, lo actualiza (y lo reactiva si
 * estaba archivado) o no lo toca si ya está igual. Solo un cambio real sube la versión.
 *
 * Lo que escribió una persona (`user_id` no nulo: el editor del catálogo, la configuración)
 * se respeta: el sistema no lo pisa. Con `soloCrear`, si el registro existe no se toca.
 */
export function guardarVersionado(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  id: string,
  fields: Record<string, SqlValue>,
  autor: Autor,
  now: string,
  options: { soloCrear?: boolean } = {},
): Cambio {
  const current = db
    .prepare(`SELECT * FROM ${tableName} WHERE restaurant_id = ? AND id = ?`)
    .get(restaurantId, id)
  if (!current) {
    insertVersioned(db, tableName, restaurantId, fields, autor, now, id)
    return 'created'
  }
  if (options.soloCrear || current.user_id !== null) return 'respected'
  const deseado = { ...fields, active: 1 }
  if (Object.entries(deseado).every(([column, value]) => current[column] === value)) return 'equal'
  actualizarVersionado(db, tableName, restaurantId, id, deseado, autor, now)
  return 'updated'
}
