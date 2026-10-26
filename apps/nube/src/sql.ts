// La base de la nube vista desde el código (ADR-016): consultas con parámetros y transacciones.
// En producción la implementa el conector de Postgres (Neon); en las pruebas, PGlite (Postgres
// embebido). Así la lógica de la nube no depende de con qué se conecte.

export type Fila = Record<string, unknown>

export interface Sql {
  /** Una consulta con parámetros posicionales ($1, $2…). Nunca se arma SQL con texto del usuario. */
  query<T extends Fila = Fila>(texto: string, parametros?: readonly unknown[]): Promise<T[]>
  /** Un guion de varias sentencias sin parámetros (las migraciones). */
  ejecutar(guion: string): Promise<void>
  /** Corre el trabajo en una transacción: si lanza, no queda nada. */
  transaccion<T>(trabajo: (sql: Sql) => Promise<T>): Promise<T>
}
