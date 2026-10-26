import { MIGRACIONES, type Migracion } from './migraciones'
import { type BaseSqlite, enTransaccion } from './sqlite'

const CREAR_REGISTRO = `
  CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL,
    applied_at TEXT NOT NULL
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
  const fila = db.prepare('SELECT max(version) AS version FROM migrations').get()
  return Number(fila?.version ?? 0)
}

function verificarNumeracion(migraciones: readonly Migracion[]) {
  migraciones.forEach((migration, indice) => {
    if (migration.version !== indice + 1) {
      throw new Error(`Las migraciones deben ir numeradas 1, 2, 3…; falla en "${migration.name}"`)
    }
  })
}

function verificarAplicadas(db: BaseSqlite, migraciones: readonly Migracion[]) {
  const aplicadas = db.prepare('SELECT version, name, hash FROM migrations ORDER BY version').all()
  for (const fila of aplicadas) {
    const migration = migraciones[Number(fila.version) - 1]
    if (migration && huellaSql(migration.sql) !== fila.hash) {
      throw new Error(
        `La migración ${fila.version} ("${fila.name}") cambió después de aplicarse. Las migraciones publicadas no se editan: crea una nueva.`,
      )
    }
  }
}

function aplicarUna(db: BaseSqlite, migration: Migracion, ahora: () => string): boolean {
  return enTransaccion(db, () => {
    // Se vuelve a leer dentro de la transacción: otro proceso pudo aplicarla mientras tanto.
    if (versionActual(db) >= migration.version) return false
    db.exec(migration.sql)
    if (migration.sinClavesForaneas) {
      const violaciones = db.prepare('PRAGMA foreign_key_check').all()
      if (violaciones.length > 0) {
        throw new Error(
          `La migración ${migration.version} deja ${violaciones.length} referencias rotas`,
        )
      }
    }
    db.prepare('INSERT INTO migrations (version, name, hash, applied_at) VALUES (?, ?, ?, ?)').run(
      migration.version,
      migration.name,
      huellaSql(migration.sql),
      ahora(),
    )
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

  const current = versionActual(db)
  if (current > migraciones.length) {
    throw new Error(
      `La base está en la versión ${current}, más nueva que esta aplicación (${migraciones.length}). Actualiza el hub.`,
    )
  }
  verificarAplicadas(db, migraciones)

  const aplicadas: number[] = []
  for (const migration of migraciones.slice(current)) {
    // Reconstruir una tabla (el procedimiento de SQLite para cambiarla) exige apagar las claves
    // foráneas, y eso solo funciona fuera de una transacción.
    if (migration.sinClavesForaneas) db.exec('PRAGMA foreign_keys = OFF')
    try {
      if (aplicarUna(db, migration, ahora)) aplicadas.push(migration.version)
    } finally {
      if (migration.sinClavesForaneas) db.exec('PRAGMA foreign_keys = ON')
    }
  }
  return aplicadas
}
