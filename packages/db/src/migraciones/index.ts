import { sql as inicial } from './0001_inicial'

export interface Migracion {
  version: number
  nombre: string
  sql: string
  /** Para migraciones que reconstruyen tablas: se apagan las claves foráneas mientras corren. */
  sinClavesForaneas?: boolean
}

// Las migraciones son código TypeScript con el SQL en texto (no archivos .sql) para que
// también funcionen donde no hay sistema de archivos, como la nube. Nunca se edita una
// migración ya publicada: los cambios van en una nueva (el runner lo comprueba por su huella).
export const MIGRACIONES: readonly Migracion[] = [{ version: 1, nombre: 'inicial', sql: inicial }]
