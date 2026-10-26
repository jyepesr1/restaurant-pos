import { type AcceptanceData, type ApplicableEvent, affectsOrder, type NewEvent } from '@pos/core'

export type LocalState = 'pending' | 'confirmed' | 'rejected' | 'quarantine'

export interface LocalEvent {
  /** The event as it was created; with the hub's fields once it is confirmed. */
  event: ApplicableEvent
  status: LocalState
  /** Created by this device (only those are sent). */
  own: boolean
  /** Recording order on this device: gives the order of the pending ones. */
  position: number
  reason?: string
  /** The hub accepted it as a conflict (shows up at the register). */
  conflict?: string | null
}

export interface Cursor {
  /** Hub instance it synced with; if it changes, the hub was restored. */
  instance: string | null
  /** Last contiguous sequence received. */
  until: number
  /** How far ahead the hub's clock is of this device's clock, in ms. */
  offsetMs?: number
}

/**
 * Local store of the device (IndexedDB in the browser, docs/SYNC.md). Asynchronous like
 * IndexedDB; each method is atomic.
 */
export interface DeviceStore {
  save(locals: readonly LocalEvent[]): Promise<void>
  get(id: string): Promise<LocalEvent | undefined>
  /** All events, in local recording order. */
  listAll(): Promise<LocalEvent[]>
  /** Own pending events, in local recording order (in IndexedDB, by index). */
  ownPending(limit?: number): Promise<LocalEvent[]>
  /** Those that touch that order (in IndexedDB, by index). */
  ofOrder(orderId: string): Promise<LocalEvent[]>
  erase(ids: readonly string[]): Promise<void>
  cursor(): Promise<Cursor>
  saveCursor(cursor: Cursor): Promise<void>
}

export class MemoryDeviceStore implements DeviceStore {
  private readonly events = new Map<string, LocalEvent>()
  private currentCursor: Cursor = { instance: null, until: 0 }

  async save(locals: readonly LocalEvent[]) {
    for (const local of locals) this.events.set(local.event.id, structuredClone(local))
  }

  async get(id: string) {
    const local = this.events.get(id)
    return local ? structuredClone(local) : undefined
  }

  async listAll() {
    return [...this.events.values()]
      .sort((a, b) => a.position - b.position)
      .map((l) => structuredClone(l))
  }

  async ownPending(limit = Number.POSITIVE_INFINITY) {
    return (await this.listAll()).filter((l) => l.own && l.status === 'pending').slice(0, limit)
  }

  async ofOrder(orderId: string) {
    return (await this.listAll()).filter((l) => affectsOrder(l.event, orderId))
  }

  async erase(ids: readonly string[]) {
    for (const id of ids) this.events.delete(id)
  }

  async cursor() {
    return { ...this.currentCursor }
  }

  async saveCursor(cursor: Cursor) {
    this.currentCursor = { ...cursor }
  }
}

/** The event without the hub's fields: what gets resent. */
export function withoutAcceptance(event: ApplicableEvent): NewEvent {
  const {
    sequence: _s,
    received_at: _r,
    business_day: _d,
    assignments: _a,
    affects: _f,
    authorized_by_id: _p,
    ...fresh
  } = event as ApplicableEvent & Partial<AcceptanceData>
  return fresh as NewEvent
}
