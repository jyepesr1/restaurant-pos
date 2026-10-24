import { MIGRACIONES, type Migracion } from './migraciones'
import { type BaseSqlite, enTransaccion } from './sqlite'

const CREAR_REGISTRO = `
  CREATE TABLE IF NOT EXISTS migracion (
    version INTEGER NOT NULL PRIMARY KEY,
    nombre TEXT NOT NULL,
    hash TEXT NOT NULL,
    aplicada_en TEXT NOT NULL
  ) STRICT
`

/** Huella FNV-1a de 64 bits del SQL: detecta si alguien editó una migración ya aplicada. */
export function huellaSql(sql: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(sql)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

export function versionActual(db: BaseSqlite): number {
  db.exec(CREAR_REGISTRO)
  const fila = db.prepare('SELECT max(version) AS version FROM migracion').get()
  return Number(fila?.version ?? 0)
}

function verificarNumeracion(migraciones: readonly Migracion[]) {
  migraciones.forEach((migracion, indice) => {
    if (migracion.version !== indice + 1) {
      throw new Error(`Las migraciones deben ir numeradas 1, 2, 3…; falla en "${migracion.nombre}"`)
    }
  })
}

function verificarAplicadas(db: BaseSqlite, migraciones: readonly Migracion[]) {
  const aplicadas = db.prepare('SELECT version, nombre, hash FROM migracion ORDER BY version').all()
  for (const fila of aplicadas) {
    const migracion = migraciones[Number(fila.version) - 1]
    if (migracion && huellaSql(migracion.sql) !== fila.hash) {
      throw new Error(
        `La migración ${fila.version} ("${fila.nombre}") cambió después de aplicarse. Las migraciones publicadas no se editan: crea una nueva.`,
      )
    }
  }
}

function aplicarUna(db: BaseSqlite, migracion: Migracion, ahora: () => string): boolean {
  return enTransaccion(db, () => {
    // Se vuelve a leer dentro de la transacción: otro proceso pudo aplicarla mientras tanto.
    if (versionActual(db) >= migracion.version) return false
    db.exec(migracion.sql)
    if (migracion.sinClavesForaneas) {
      const violaciones = db.prepare('PRAGMA foreign_key_check').all()
      if (violaciones.length > 0) {
        throw new Error(
          `La migración ${migracion.version} deja ${violaciones.length} referencias rotas`,
        )
      }
    }
    db.prepare(
      'INSERT INTO migracion (version, nombre, hash, aplicada_en) VALUES (?, ?, ?, ?)',
    ).run(migracion.version, migracion.nombre, huellaSql(migracion.sql), ahora())
    return true
  })
}

/**
 * Lleva la base a la última versión. Cada migración corre en su propia transacción: si una
 * falla, la base queda en la versión anterior. Devuelve las versiones aplicadas.
 */
export function aplicarMigraciones(
  db: BaseSqlite,
  migraciones: readonly Migracion[] = MIGRACIONES,
  ahora: () => string = () => new Date().toISOString(),
): number[] {
  verificarNumeracion(migraciones)

  const actual = versionActual(db)
  if (actual > migraciones.length) {
    throw new Error(
      `La base está en la versión ${actual}, más nueva que esta aplicación (${migraciones.length}). Actualiza el hub.`,
    )
  }
  verificarAplicadas(db, migraciones)

  const aplicadas: number[] = []
  for (const migracion of migraciones.slice(actual)) {
    // Reconstruir una tabla (el procedimiento de SQLite para cambiarla) exige apagar las claves
    // foráneas, y eso solo funciona fuera de una transacción.
    if (migracion.sinClavesForaneas) db.exec('PRAGMA foreign_keys = OFF')
    try {
      if (aplicarUna(db, migracion, ahora)) aplicadas.push(migracion.version)
    } finally {
      if (migracion.sinClavesForaneas) db.exec('PRAGMA foreign_keys = ON')
    }
  }
  return aplicadas
}
