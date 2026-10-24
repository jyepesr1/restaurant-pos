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
): string {
  const id = nuevoId()
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
