/** Valores que acepta SQLite como parámetro. */
export type ValorSql = string | number | bigint | null | Uint8Array

export type Fila = Record<string, ValorSql>

export interface Sentencia {
  run(...parametros: ValorSql[]): { changes: number | bigint }
  get(...parametros: ValorSql[]): Fila | undefined
  all(...parametros: ValorSql[]): Fila[]
}

/**
 * Lo mínimo que el sistema necesita de una base SQLite. Lo cumplen `node:sqlite` (hub) y
 * `better-sqlite3`; así el motor se puede cambiar sin tocar las migraciones ni las consultas.
 */
export interface BaseSqlite {
  exec(sql: string): void
  prepare(sql: string): Sentencia
  close(): void
}

/**
 * Ejecuta `trabajo` dentro de una transacción: todo se guarda o nada. `trabajo` debe ser
 * síncrono: con una función async el COMMIT ocurriría antes de que termine.
 */
export function enTransaccion<T>(db: BaseSqlite, trabajo: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const resultado = trabajo()
    if (typeof (resultado as { then?: unknown } | undefined)?.then === 'function') {
      throw new Error('enTransaccion no admite funciones asíncronas')
    }
    db.exec('COMMIT')
    return resultado
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // SQLite ya deshizo la transacción por su cuenta (disco lleno, E/S): lo que importa
      // es el error original.
    }
    throw error
  }
}
