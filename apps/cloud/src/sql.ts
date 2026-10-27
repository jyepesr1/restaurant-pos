// The cloud database as the code sees it (ADR-016): parameterized queries and transactions.
// In production the Postgres connector (Neon) implements it; in tests, PGlite (embedded
// Postgres). That way the cloud logic does not depend on how it connects.

export type Row = Record<string, unknown>

export interface Sql {
  /** A query with positional parameters ($1, $2…). SQL is never built from user text. */
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>
  /** A multi-statement script without parameters (the migrations). */
  execute(script: string): Promise<void>
  /** Runs the job in a transaction: if it throws, nothing is kept. */
  transaction<T>(job: (sql: Sql) => Promise<T>): Promise<T>
}
