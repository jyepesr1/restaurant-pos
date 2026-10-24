import { createHash } from 'node:crypto'
import { nuevoId } from '@pos/core'
import type { BaseSqlite, ValorSql } from '@pos/db'

// Escritura de registros versionados (catálogo y configuración, categoría V): cada cambio toma
// el siguiente valor del contador global del catálogo (docs/SYNC.md#catálogo-y-configuración).

/** Siguiente valor del contador de catálogo del restaurante. */
export function siguienteVersion(db: BaseSqlite, restauranteId: string): number {
  const fila = db
    .prepare(
      `INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)
       ON CONFLICT (restaurante_id, nombre) DO UPDATE SET valor = valor + 1
       RETURNING valor`,
    )
    .get(restauranteId)
  return Number(fila?.valor)
}

export interface Autor {
  usuarioId: string | null
  dispositivoId: string | null
}

export const SISTEMA: Autor = { usuarioId: null, dispositivoId: null }

/** Inserta un registro versionado con sus columnas comunes. Devuelve su id. */
export function insertarVersionado(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  campos: Record<string, ValorSql>,
  autor: Autor,
  ahora: string,
  id: string = nuevoId(),
): string {
  const fila: Record<string, ValorSql> = {
    id,
    restaurante_id: restauranteId,
    creado_en: ahora,
    actualizado_en: ahora,
    version: siguienteVersion(db, restauranteId),
    usuario_id: autor.usuarioId,
    dispositivo_id: autor.dispositivoId,
    activo: 1,
    ...campos,
  }
  const columnas = Object.keys(fila)
  db.prepare(
    `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
  ).run(...Object.values(fila))
  return id
}

/** Actualiza un registro versionado: sube su versión y deja quién y cuándo. */
export function actualizarVersionado(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  id: string,
  campos: Record<string, ValorSql>,
  autor: Autor,
  ahora: string,
) {
  const todos: Record<string, ValorSql> = {
    ...campos,
    actualizado_en: ahora,
    version: siguienteVersion(db, restauranteId),
    usuario_id: autor.usuarioId,
    dispositivo_id: autor.dispositivoId,
  }
  const asignaciones = Object.keys(todos).map((c) => `${c} = ?`)
  db.prepare(
    `UPDATE ${tabla} SET ${asignaciones.join(', ')} WHERE restaurante_id = ? AND id = ?`,
  ).run(...Object.values(todos), restauranteId, id)
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ID estable para un registro que siempre es "el mismo" (lo que crea el seed): un ULID válido con
 * la marca de tiempo del restaurante y el resto sacado de la clave. El mismo restaurante y la
 * misma clave dan siempre el mismo ID; correr el seed otra vez no duplica nada.
 */
export function idEstable(restauranteId: string, clave: string): string {
  const bytes = createHash('sha256').update(`${restauranteId}:${clave}`).digest()
  const azar = Array.from({ length: 16 }, (_, i) => CROCKFORD[(bytes[i] as number) % 32]).join('')
  return `${restauranteId.slice(0, 10)}${azar}`
}

export type Cambio = 'creado' | 'actualizado' | 'igual' | 'respetado' | 'archivado'

/**
 * Deja el registro versionado `id` con esos campos: lo crea, lo actualiza (y lo reactiva si
 * estaba archivado) o no lo toca si ya está igual. Solo un cambio real sube la versión.
 *
 * Lo que escribió una persona (`usuario_id` no nulo: el editor del catálogo, la configuración)
 * se respeta: el sistema no lo pisa. Con `soloCrear`, si el registro existe no se toca.
 */
export function guardarVersionado(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  id: string,
  campos: Record<string, ValorSql>,
  autor: Autor,
  ahora: string,
  opciones: { soloCrear?: boolean } = {},
): Cambio {
  const actual = db
    .prepare(`SELECT * FROM ${tabla} WHERE restaurante_id = ? AND id = ?`)
    .get(restauranteId, id)
  if (!actual) {
    insertarVersionado(db, tabla, restauranteId, campos, autor, ahora, id)
    return 'creado'
  }
  if (opciones.soloCrear || actual.usuario_id !== null) return 'respetado'
  const deseado = { ...campos, activo: 1 }
  if (Object.entries(deseado).every(([columna, valor]) => actual[columna] === valor)) return 'igual'
  actualizarVersionado(db, tabla, restauranteId, id, deseado, autor, ahora)
  return 'actualizado'
}
