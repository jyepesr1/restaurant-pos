import type { OrderEvent } from '@pos/core'

/** Conflict types the `conflicts` table accepts (docs/MODELO_DATOS.md). */
export type ConflictType =
  | 'duplicate_table'
  | 'table_locked'
  | 'item_not_found'
  | 'item_already_sent'
  | 'item_already_voided'
  | 'item_moved'
  | 'order_closed'
  | 'price_mismatch'

export interface Conflict {
  id: string
  type: ConflictType
  eventId: string
  aggregateId: string
  description: string
  detectedAt: string
}

export interface Rejection {
  eventId: string
  fingerprint: string
  deviceId: string
  reason: string
  content: string
  receivedAt: string
}

export interface Quarantine {
  eventId: string
  deviceId: string
  reason: string
  content: string
  receivedAt: string
}

/**
 * What the hub needs to store (docs/SYNC.md). Synchronous: the hub uses `node:sqlite`, which is,
 * so a transaction cannot interleave with another message.
 */
/** The events that move money in a register shift (they carry `register_shift_id`). */
export const CHARGE_TYPES: readonly string[] = [
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
]

export interface HubStore {
  transaction<T>(job: () => T): T
  maxSequence(): number
  byId(id: string): { event: OrderEvent; fingerprint: string } | undefined
  rejection(eventId: string, fingerprint: string): Rejection | undefined
  conflictOf(eventId: string): Conflict | undefined
  /**
   * Highest sequence among the events that touch any of those aggregates (0 if none). With
   * `except`, not counting that device's: it always knows its own.
   */
  lastSequenceOf(aggregates: readonly string[], except?: string): number
  /** Events that touch an aggregate, in sequence order. */
  aggregateEvents(aggregateId: string): OrderEvent[]
  /** How many events from that device are in quarantine. */
  quarantinesOf(deviceId: string): number
  /** How many orders were opened in the business day: gives the order number of the day. */
  dayOpenings(day: string): number
  /** How many tickets were numbered in the business day: gives the next one's number. */
  ticketsOfDay(day: string): number
  eventsSince(from: number, limit: number): OrderEvent[]
  /** Events of those types with business day from `from` to `until` (inclusive), by sequence. */
  periodEvents(types: readonly string[], from: string, until: string): OrderEvent[]
  /**
   * Payments, payment voids and refunds recorded in a register shift, by sequence. `from` is the
   * business day it was opened: it bounds the search (a shift receives no charges from before).
   */
  shiftCharges(shiftId: string, from: string): OrderEvent[]
  saveEvent(event: OrderEvent, fingerprint: string, aggregates: readonly string[]): void
  /** If there is already a rejection with that id and fingerprint, does nothing. */
  saveRejection(rejection: Rejection): void
  saveQuarantine(quarantine: Quarantine): void
  saveConflict(conflict: Conflict): void
  conflicts(): Conflict[]
}

/** In-memory store for tests. `fail` lets you simulate a crash at a given point. */
export class MemoryStore implements HubStore {
  events: { event: OrderEvent; fingerprint: string; aggregates: readonly string[] }[] = []
  rejections: Rejection[] = []
  quarantines: Quarantine[] = []
  conflictList: Conflict[] = []
  /** Called before committing each transaction; if it throws, nothing from it is kept. */
  fail: (() => void) | null = null

  transaction<T>(job: () => T): T {
    const copy = {
      events: [...this.events],
      rejections: [...this.rejections],
      quarantines: [...this.quarantines],
      conflicts: [...this.conflictList],
    }
    try {
      const result = job()
      this.fail?.()
      return result
    } catch (error) {
      this.events = copy.events
      this.rejections = copy.rejections
      this.quarantines = copy.quarantines
      this.conflictList = copy.conflicts
      throw error
    }
  }

  maxSequence(): number {
    return this.events.at(-1)?.event.sequence ?? 0
  }

  byId(id: string) {
    return this.events.find((e) => e.event.id === id)
  }

  rejection(eventId: string, fingerprint: string) {
    return this.rejections.find((r) => r.eventId === eventId && r.fingerprint === fingerprint)
  }

  conflictOf(eventId: string) {
    return this.conflictList.find((c) => c.eventId === eventId)
  }

  lastSequenceOf(aggregates: readonly string[], except?: string): number {
    return this.events
      .filter((e) => e.aggregates.some((a) => aggregates.includes(a)))
      .filter((e) => e.event.device_id !== except)
      .reduce((max, e) => Math.max(max, e.event.sequence), 0)
  }

  aggregateEvents(aggregateId: string): OrderEvent[] {
    return this.events.filter((e) => e.aggregates.includes(aggregateId)).map((e) => e.event)
  }

  quarantinesOf(deviceId: string): number {
    return this.quarantines.filter((c) => c.deviceId === deviceId).length
  }

  dayOpenings(day: string): number {
    return this.events.filter((e) => e.event.type === 'OrderOpened' && e.event.business_day === day)
      .length
  }

  ticketsOfDay(day: string): number {
    return this.events
      .map((e) => e.event)
      .filter((e) => e.type === 'ItemsSent' && e.business_day === day)
      .reduce((n, e) => n + Object.keys(e.assignments.ticket_numbers ?? {}).length, 0)
  }

  periodEvents(types: readonly string[], from: string, until: string): OrderEvent[] {
    return this.events
      .map((e) => e.event)
      .filter((e) => types.includes(e.type) && e.business_day >= from && e.business_day <= until)
      .sort((a, b) => a.sequence - b.sequence)
  }

  shiftCharges(shiftId: string, from: string): OrderEvent[] {
    return this.events
      .map((e) => e.event)
      .filter(
        (e) =>
          CHARGE_TYPES.includes(e.type) &&
          e.business_day >= from &&
          (e.data as { register_shift_id?: string }).register_shift_id === shiftId,
      )
      .sort((a, b) => a.sequence - b.sequence)
  }

  eventsSince(from: number, limit: number): OrderEvent[] {
    return this.events
      .filter((e) => e.event.sequence > from)
      .slice(0, limit)
      .map((e) => e.event)
  }

  saveEvent(event: OrderEvent, fingerprint: string, aggregates: readonly string[]) {
    this.events.push({ event, fingerprint, aggregates })
  }

  saveRejection(rejection: Rejection) {
    if (!this.rejection(rejection.eventId, rejection.fingerprint)) this.rejections.push(rejection)
  }

  saveQuarantine(quarantine: Quarantine) {
    if (!this.quarantines.some((c) => c.eventId === quarantine.eventId))
      this.quarantines.push(quarantine)
  }

  saveConflict(conflict: Conflict) {
    if (!this.conflictOf(conflict.eventId)) this.conflictList.push(conflict)
  }

  conflicts(): Conflict[] {
    return [...this.conflictList]
  }
}
