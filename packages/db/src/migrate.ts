import { MIGRATIONS, type Migration } from './migrations'
import { inTransaction, type SqliteDatabase } from './sqlite'

const CREATE_REGISTRY = `
  CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT
`

/** 64-bit FNV-1a hash of the SQL: detects whether someone edited an already applied migration. */
export function sqlFingerprint(sql: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(sql)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

export function currentVersion(db: SqliteDatabase): number {
  db.exec(CREATE_REGISTRY)
  const row = db.prepare('SELECT max(version) AS version FROM migrations').get()
  return Number(row?.version ?? 0)
}

function verifyNumbering(migrations: readonly Migration[]) {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migrations must be numbered 1, 2, 3…: "${migration.name}" is out of order`)
    }
  })
}

function verifyApplied(db: SqliteDatabase, migrations: readonly Migration[]) {
  const appliedMigrations = db
    .prepare('SELECT version, name, hash FROM migrations ORDER BY version')
    .all()
  for (const row of appliedMigrations) {
    const migration = migrations[Number(row.version) - 1]
    if (migration && sqlFingerprint(migration.sql) !== row.hash) {
      throw new Error(
        `Migration ${row.version} ("${row.name}") changed after it was applied. Published migrations are not edited: create a new one.`,
      )
    }
  }
}

function applyOne(db: SqliteDatabase, migration: Migration, now: () => string): boolean {
  return inTransaction(db, () => {
    // Read again inside the transaction: another process may have applied it meanwhile.
    if (currentVersion(db) >= migration.version) return false
    db.exec(migration.sql)
    if (migration.withoutForeignKeys) {
      const violations = db.prepare('PRAGMA foreign_key_check').all()
      if (violations.length > 0) {
        throw new Error(
          `Migration ${migration.version} leaves ${violations.length} broken references`,
        )
      }
    }
    db.prepare('INSERT INTO migrations (version, name, hash, applied_at) VALUES (?, ?, ?, ?)').run(
      migration.version,
      migration.name,
      sqlFingerprint(migration.sql),
      now(),
    )
    return true
  })
}

/**
 * Brings the database to the latest version. Each migration runs in its own transaction: if
 * one fails, the database stays at the previous version. Returns the applied versions.
 */
export function applyMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): number[] {
  verifyNumbering(migrations)

  const current = currentVersion(db)
  if (current > migrations.length) {
    throw new Error(
      `The database is at version ${current}, newer than this app (${migrations.length}). Update the hub.`,
    )
  }
  verifyApplied(db, migrations)

  const appliedMigrations: number[] = []
  for (const migration of migrations.slice(current)) {
    // Rebuilding a table (SQLite's procedure to change one) requires turning foreign keys off,
    // and that only works outside a transaction.
    if (migration.withoutForeignKeys) db.exec('PRAGMA foreign_keys = OFF')
    try {
      if (applyOne(db, migration, now)) appliedMigrations.push(migration.version)
    } finally {
      if (migration.withoutForeignKeys) db.exec('PRAGMA foreign_keys = ON')
    }
  }
  return appliedMigrations
}
