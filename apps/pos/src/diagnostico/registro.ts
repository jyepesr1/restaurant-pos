import Dexie, { type EntityTable } from 'dexie'

export type TipoEvento = 'load' | 'hidden' | 'visible' | 'ws-open' | 'ws-closed'

export interface EventoDiagnostico {
  /** Autoincremental: da el orden real de registro aunque dos eventos compartan milisegundo. */
  id?: number
  /** Milisegundos desde epoch según el reloj del dispositivo. */
  time: number
  type: TipoEvento
  detalle?: Record<string, unknown>
}

const DIAS_RETENCION = 7

// Base propia del diagnóstico: se puede borrar sin tocar datos del POS.
const db = new Dexie('pos-diagnostics') as Dexie & {
  events: EntityTable<EventoDiagnostico, 'id'>
  tests: EntityTable<{ id?: number; value: string }, 'id'>
}
db.version(1).stores({ events: '++id, time', tests: '++id' })

/** Guarda un evento. Si el almacenamiento falla (modo privado, bloqueado) se ignora. */
export async function registrarEvento(
  type: TipoEvento,
  detalle?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.events.add({ time: Date.now(), type, ...(detalle ? { detalle } : {}) })
  } catch {
    // El diagnóstico debe seguir funcionando aunque no pueda guardar.
  }
}

/** Todos los eventos en orden de registro; vacío si el almacenamiento no funciona. */
export async function leerEventos(): Promise<EventoDiagnostico[]> {
  try {
    return await db.events.toArray()
  } catch {
    return []
  }
}

export async function borrarEventos(): Promise<void> {
  try {
    await db.events.clear()
  } catch {
    // Sin almacenamiento no hay nada que borrar.
  }
}

/** Borra eventos de más de una semana para que el registro no crezca sin límite. */
export async function purgarEventosAntiguos(): Promise<void> {
  try {
    const limite = Date.now() - DIAS_RETENCION * 24 * 60 * 60 * 1000
    await db.events.where('time').below(limite).delete()
  } catch {
    // Igual que arriba: la purga es opcional.
  }
}

/** Escribe y lee un registro de prueba (en su propia tabla) para confirmar que IndexedDB funciona. */
export async function probarIndexedDb(): Promise<boolean> {
  try {
    const value = String(Math.random())
    const id = await db.tests.add({ value })
    const readResult = await db.tests.get(id)
    await db.tests.delete(id)
    return readResult?.value === value
  } catch {
    return false
  }
}
