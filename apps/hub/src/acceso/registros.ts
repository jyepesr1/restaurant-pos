import { createHash } from 'node:crypto'
import { newId } from '@pos/core'
import type { BaseSqlite, ValorSql } from '@pos/db'

// Escritura de registros versionados (catálogo y configuración, categoría V): cada cambio toma
// el siguiente valor del contador global del catálogo (docs/SYNC.md#catálogo-y-configuración).

/** Siguiente valor del contador de catálogo del restaurante. */
export function siguienteVersion(db: BaseSqlite, restauranteId: string): number {
  const fila = db
    .prepare(
      `INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)
       ON CONFLICT (restaurant_id, name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(restauranteId)
  return Number(fila?.value)
}

/** Tablas del catálogo: cada cambio suyo queda en `catalog_changes` (`CatalogoCambiado`). */
export const TABLAS_CATALOGO = [
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
export type TablaCatalogo = (typeof TABLAS_CATALOGO)[number]

const esDelCatalogo = (tabla: string): tabla is TablaCatalogo =>
  (TABLAS_CATALOGO as readonly string[]).includes(tabla)

const leerFila = (db: BaseSqlite, tabla: string, restauranteId: string, id: string) =>
  db.prepare(`SELECT * FROM ${tabla} WHERE restaurant_id = ? AND id = ?`).get(restauranteId, id)

/** Deja en el historial cómo quedó el registro (y cómo estaba), en la misma transacción. */
function anotarCambio(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  id: string,
  before: Record<string, unknown> | undefined,
  autor: Autor,
  ahora: string,
) {
  if (!esDelCatalogo(tabla)) return
  const after = leerFila(db, tabla, restauranteId, id)
  if (!after) return
  db.prepare(
    `INSERT INTO catalog_changes
       (restaurant_id, version, entity, record_id, before, after, user_id, device_id, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    restauranteId,
    Number(after.version),
    tabla,
    id,
    before ? JSON.stringify(before) : null,
    JSON.stringify(after),
    autor.userId,
    autor.dispositivoId,
    ahora,
  )
}

export interface Autor {
  userId: string | null
  dispositivoId: string | null
}

export const SISTEMA: Autor = { userId: null, dispositivoId: null }

/** Inserta un registro versionado con sus columnas comunes. Devuelve su id. */
export function insertarVersionado(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  fields: Record<string, ValorSql>,
  autor: Autor,
  ahora: string,
  id: string = newId(),
): string {
  const fila: Record<string, ValorSql> = {
    id,
    restaurant_id: restauranteId,
    created_at: ahora,
    updated_at: ahora,
    version: siguienteVersion(db, restauranteId),
    user_id: autor.userId,
    device_id: autor.dispositivoId,
    active: 1,
    ...fields,
  }
  const columnas = Object.keys(fila)
  db.prepare(
    `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
  ).run(...Object.values(fila))
  anotarCambio(db, tabla, restauranteId, id, undefined, autor, ahora)
  return id
}

/** Actualiza un registro versionado: sube su versión y deja quién y cuándo. */
export function actualizarVersionado(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  id: string,
  fields: Record<string, ValorSql>,
  autor: Autor,
  ahora: string,
) {
  const before = leerFila(db, tabla, restauranteId, id)
  const all: Record<string, ValorSql> = {
    ...fields,
    updated_at: ahora,
    version: siguienteVersion(db, restauranteId),
    user_id: autor.userId,
    device_id: autor.dispositivoId,
  }
  const assignments = Object.keys(all).map((c) => `${c} = ?`)
  db.prepare(
    `UPDATE ${tabla} SET ${assignments.join(', ')} WHERE restaurant_id = ? AND id = ?`,
  ).run(...Object.values(all), restauranteId, id)
  anotarCambio(db, tabla, restauranteId, id, before, autor, ahora)
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ID estable para un registro que siempre es "el mismo" (lo que crea el seed): un ULID válido con
 * la marca de tiempo del restaurante y el resto sacado de la clave. El mismo restaurante y la
 * misma clave dan siempre el mismo ID; correr el seed otra vez no duplica nada.
 */
export function idEstable(restauranteId: string, key: string): string {
  const bytes = createHash('sha256').update(`${restauranteId}:${key}`).digest()
  const random = Array.from({ length: 16 }, (_, i) => CROCKFORD[(bytes[i] as number) % 32]).join('')
  return `${restauranteId.slice(0, 10)}${random}`
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
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  id: string,
  fields: Record<string, ValorSql>,
  autor: Autor,
  ahora: string,
  options: { soloCrear?: boolean } = {},
): Cambio {
  const current = db
    .prepare(`SELECT * FROM ${tabla} WHERE restaurant_id = ? AND id = ?`)
    .get(restauranteId, id)
  if (!current) {
    insertarVersionado(db, tabla, restauranteId, fields, autor, ahora, id)
    return 'created'
  }
  if (options.soloCrear || current.user_id !== null) return 'respected'
  const deseado = { ...fields, active: 1 }
  if (Object.entries(deseado).every(([columna, value]) => current[columna] === value))
    return 'equal'
  actualizarVersionado(db, tabla, restauranteId, id, deseado, autor, ahora)
  return 'updated'
}
