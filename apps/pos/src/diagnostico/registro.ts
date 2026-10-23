import Dexie, { type EntityTable } from 'dexie'

export type TipoEvento = 'carga' | 'oculta' | 'visible' | 'ws-abierto' | 'ws-cerrado'

export interface EventoDiagnostico {
  /** Autoincremental: da el orden real de registro aunque dos eventos compartan milisegundo. */
  id?: number
  /** Milisegundos desde epoch según el reloj del dispositivo. */
  hora: number
  tipo: TipoEvento
  detalle?: Record<string, unknown>
}

const DIAS_RETENCION = 7

// Base propia del diagnóstico: se puede borrar sin tocar datos del POS.
const db = new Dexie('pos-diagnostico') as Dexie & {
  eventos: EntityTable<EventoDiagnostico, 'id'>
  pruebas: EntityTable<{ id?: number; valor: string }, 'id'>
}
db.version(1).stores({ eventos: '++id, hora', pruebas: '++id' })

/** Guarda un evento. Si el almacenamiento falla (modo privado, bloqueado) se ignora. */
export async function registrarEvento(
  tipo: TipoEvento,
  detalle?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.eventos.add({ hora: Date.now(), tipo, ...(detalle ? { detalle } : {}) })
  } catch {
    // El diagnóstico debe seguir funcionando aunque no pueda guardar.
  }
}

/** Todos los eventos en orden de registro; vacío si el almacenamiento no funciona. */
export async function leerEventos(): Promise<EventoDiagnostico[]> {
  try {
    return await db.eventos.toArray()
  } catch {
    return []
  }
}

export async function borrarEventos(): Promise<void> {
  try {
    await db.eventos.clear()
  } catch {
    // Sin almacenamiento no hay nada que borrar.
  }
}

/** Borra eventos de más de una semana para que el registro no crezca sin límite. */
export async function purgarEventosAntiguos(): Promise<void> {
  try {
    const limite = Date.now() - DIAS_RETENCION * 24 * 60 * 60 * 1000
    await db.eventos.where('hora').below(limite).delete()
  } catch {
    // Igual que arriba: la purga es opcional.
  }
}

/** Escribe y lee un registro de prueba (en su propia tabla) para confirmar que IndexedDB funciona. */
export async function probarIndexedDb(): Promise<boolean> {
  try {
    const valor = String(Math.random())
    const id = await db.pruebas.add({ valor })
    const leido = await db.pruebas.get(id)
    await db.pruebas.delete(id)
    return leido?.valor === valor
  } catch {
    return false
  }
}
