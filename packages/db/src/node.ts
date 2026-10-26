import { DatabaseSync } from 'node:sqlite'
import type { BaseSqlite } from './sqlite'

export interface OpcionesApertura {
  /**
   * Toma la base en exclusiva mientras el proceso viva: un segundo hub sobre la misma carpeta
   * de datos no puede abrirla. Se usa en el hub, no en pruebas.
   */
  exclusiva?: boolean
  /** Cuánto esperar si la base está ocupada antes de fallar. */
  esperaMs?: number
}

export class BaseOcupadaError extends Error {
  constructor() {
    super('Otro hub ya está usando esta base de datos. Cierra el otro antes de abrir este.')
  }
}

/**
 * Abre la base del hub con `node:sqlite` (incluido en Node, sin módulos nativos que compilar
 * en Windows). Solo para Node: la nube usará el SQLite de su propia plataforma.
 * Una sola conexión por proceso: `node:sqlite` es síncrono y una espera bloquea el hub.
 */
export function abrirBase(
  ruta: string,
  { exclusiva = false, esperaMs = 5000 }: OpcionesApertura = {},
): BaseSqlite {
  const db = new DatabaseSync(ruta)
  try {
    // busy_timeout primero: pasar a WAL necesita un bloqueo y debe poder esperar.
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(esperaMs)}`)
    if (exclusiva) db.exec('PRAGMA locking_mode = EXCLUSIVE')

    const mode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode
    if (ruta !== ':memory:' && mode !== 'wal') {
      throw new Error(`No se pudo activar el modo WAL (quedó en "${String(mode)}")`)
    }
    // FULL: sin UPS, un corte de luz no debe perder la última transacción confirmada (ADR-003).
    // recursive_triggers: refuerzo para que un REPLACE dispare los bloqueos de borrado.
    db.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA recursive_triggers = ON;
    `)
    // En modo exclusivo el bloqueo se toma con la primera escritura: hacerla ya.
    if (exclusiva) db.exec('BEGIN IMMEDIATE; COMMIT;')
  } catch (error) {
    db.close()
    if (error instanceof Error && /database is locked/i.test(error.message)) {
      throw new BaseOcupadaError()
    }
    throw error
  }
  return db
}
