import Dexie, { type EntityTable } from 'dexie'

export type EventType = 'load' | 'hidden' | 'visible' | 'ws-open' | 'ws-closed'

export interface DiagnosticEvent {
  /** Autoincrement: gives the real logging order even when two events share a millisecond. */
  id?: number
  /** Milliseconds since epoch by the device clock. */
  time: number
  type: EventType
  detail?: Record<string, unknown>
}

const RETENTION_DAYS = 7

// The diagnostics' own database: it can be deleted without touching POS data.
const db = new Dexie('pos-diagnostics') as Dexie & {
  events: EntityTable<DiagnosticEvent, 'id'>
  tests: EntityTable<{ id?: number; value: string }, 'id'>
}
db.version(1).stores({ events: '++id, time', tests: '++id' })

/** Saves an event. If storage fails (private mode, blocked) it is ignored. */
export async function recordEvent(
  type: EventType,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.events.add({ time: Date.now(), type, ...(detail ? { detail } : {}) })
  } catch {
    // Diagnostics must keep working even if it cannot save.
  }
}

/** All events in logging order; empty if storage does not work. */
export async function readEvents(): Promise<DiagnosticEvent[]> {
  try {
    return await db.events.toArray()
  } catch {
    return []
  }
}

export async function deleteEvents(): Promise<void> {
  try {
    await db.events.clear()
  } catch {
    // Without storage there is nothing to delete.
  }
}

/** Deletes events older than a week so the log does not grow without limit. */
export async function purgeOldEvents(): Promise<void> {
  try {
    const limit = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    await db.events.where('time').below(limit).delete()
  } catch {
    // Same as above: the purge is optional.
  }
}

/** Writes and reads a test record (in its own table) to confirm IndexedDB works. */
export async function testIndexedDb(): Promise<boolean> {
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
