import { sql as initial } from './0001_initial'

export interface Migration {
  version: number
  name: string
  sql: string
  /** For migrations that rebuild tables: foreign keys are turned off while they run. */
  withoutForeignKeys?: boolean
}

// Migrations are TypeScript code with the SQL as text (no .sql files) so they also work where
// there is no file system, like the cloud. A published migration is never edited: changes go in
// a new one (the runner checks it by its hash).
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'initial', sql: initial }]
