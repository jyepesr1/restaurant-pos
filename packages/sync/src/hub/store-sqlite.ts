import type { OrderEvent } from '@pos/core'
import { inTransaction, type Row, type SqliteDatabase } from '@pos/db'
import {
  CHARGE_TYPES,
  type Conflict,
  type ConflictType,
  type HubStore,
  type Quarantine,
  type Rejection,
} from './store'

const text = (v: unknown) => (v === null || v === undefined ? null : String(v))

function toEvent(f: Row): OrderEvent {
  return {
    id: String(f.id),
    type: String(f.type),
    schema_version: Number(f.schema_version),
    aggregate_type: String(f.aggregate_type),
    aggregate_id: String(f.aggregate_id),
    related: JSON.parse(String(f.related)),
    data: JSON.parse(String(f.data)),
    session_id: text(f.session_id),
    user_id: String(f.user_id),
    device_id: String(f.device_id),
    authorization_id: text(f.authorization_id),
    reason: text(f.reason),
    device_time: String(f.device_time),
    hub_estimated_time: String(f.hub_estimated_time),
    base_sequence: Number(f.base_sequence),
    sequence: Number(f.sequence),
    received_at: String(f.received_at),
    business_day: String(f.business_day),
    assignments: JSON.parse(String(f.assignments)),
    affects: JSON.parse(String(f.affects)),
    authorized_by_id: text(f.authorized_by_id),
  } as OrderEvent
}

/** Hub store over the `@pos/db` tables (events, event_aggregates, rejected_events, conflicts). */
export class SqliteStore implements HubStore {
  private readonly db: SqliteDatabase
  private readonly restaurantId: string

  constructor(db: SqliteDatabase, restaurantId: string) {
    this.db = db
    this.restaurantId = restaurantId
  }

  transaction<T>(job: () => T): T {
    return inTransaction(this.db, job)
  }

  maxSequence(): number {
    const row = this.db
      .prepare('SELECT max(sequence) AS m FROM events WHERE restaurant_id = ?')
      .get(this.restaurantId)
    return Number(row?.m ?? 0)
  }

  byId(id: string) {
    const row = this.db
      .prepare('SELECT * FROM events WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, id)
    return row ? { event: toEvent(row), fingerprint: String(row.content_hash) } : undefined
  }

  rejection(eventId: string, fingerprint: string): Rejection | undefined {
    const f = this.db
      .prepare(
        'SELECT * FROM rejected_events WHERE restaurant_id = ? AND event_id = ? AND content_hash = ?',
      )
      .get(this.restaurantId, eventId, fingerprint)
    if (!f) return undefined
    return {
      eventId: String(f.event_id),
      fingerprint: String(f.content_hash),
      deviceId: String(f.device_id),
      reason: String(f.reason),
      content: String(f.content),
      receivedAt: String(f.received_at),
    }
  }

  conflictOf(eventId: string): Conflict | undefined {
    const f = this.db
      .prepare('SELECT * FROM conflicts WHERE restaurant_id = ? AND event_id = ?')
      .get(this.restaurantId, eventId)
    return f ? this.toConflict(f) : undefined
  }

  lastSequenceOf(aggregates: readonly string[], except?: string): number {
    if (aggregates.length === 0) return 0
    const list = aggregates.map(() => '?').join(', ')
    const row =
      except === undefined
        ? this.db
            .prepare(
              `SELECT max(sequence) AS m FROM event_aggregates
               WHERE restaurant_id = ? AND aggregate_id IN (${list})`,
            )
            .get(this.restaurantId, ...aggregates)
        : this.db
            .prepare(
              `SELECT max(a.sequence) AS m FROM event_aggregates a
               JOIN events e ON e.restaurant_id = a.restaurant_id AND e.id = a.event_id
               WHERE a.restaurant_id = ? AND a.aggregate_id IN (${list}) AND e.device_id <> ?`,
            )
            .get(this.restaurantId, ...aggregates, except)
    return Number(row?.m ?? 0)
  }

  aggregateEvents(aggregateId: string): OrderEvent[] {
    return this.db
      .prepare(
        `SELECT e.* FROM event_aggregates a
         JOIN events e ON e.restaurant_id = a.restaurant_id AND e.id = a.event_id
         WHERE a.restaurant_id = ? AND a.aggregate_id = ? ORDER BY a.sequence`,
      )
      .all(this.restaurantId, aggregateId)
      .map(toEvent)
  }

  quarantinesOf(deviceId: string): number {
    const row = this.db
      .prepare(
        'SELECT count(*) AS n FROM quarantined_events WHERE restaurant_id = ? AND device_id = ?',
      )
      .get(this.restaurantId, deviceId)
    return Number(row?.n ?? 0)
  }

  dayOpenings(day: string): number {
    const row = this.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE restaurant_id = ? AND type = 'OrderOpened' AND business_day = ?",
      )
      .get(this.restaurantId, day)
    return Number(row?.n ?? 0)
  }

  ticketsOfDay(day: string): number {
    const row = this.db
      .prepare(
        `SELECT coalesce(sum((SELECT count(*) FROM json_each(assignments, '$.ticket_numbers'))), 0) AS n
         FROM events WHERE restaurant_id = ? AND type = 'ItemsSent' AND business_day = ?`,
      )
      .get(this.restaurantId, day)
    return Number(row?.n ?? 0)
  }

  periodEvents(types: readonly string[], from: string, until: string): OrderEvent[] {
    if (types.length === 0) return []
    // Uses the events_by_type_and_day index (migration 0006).
    return this.db
      .prepare(
        `SELECT * FROM events WHERE restaurant_id = ? AND type IN (${types.map(() => '?').join(', ')})
           AND business_day BETWEEN ? AND ? ORDER BY sequence`,
      )
      .all(this.restaurantId, ...types, from, until)
      .map(toEvent)
  }

  shiftCharges(shiftId: string, from: string): OrderEvent[] {
    // The events_by_type_and_day index narrows by type and day; the shift is compared afterwards.
    return this.db
      .prepare(
        `SELECT * FROM events WHERE restaurant_id = ? AND type IN (${CHARGE_TYPES.map(() => '?').join(', ')})
           AND business_day >= ? AND json_extract(data, '$.register_shift_id') = ? ORDER BY sequence`,
      )
      .all(this.restaurantId, ...CHARGE_TYPES, from, shiftId)
      .map(toEvent)
  }

  eventsSince(from: number, limit: number): OrderEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM events WHERE restaurant_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
      )
      .all(this.restaurantId, from, limit)
      .map(toEvent)
  }

  saveEvent(e: OrderEvent, fingerprint: string, aggregates: readonly string[]) {
    this.db
      .prepare(
        `INSERT INTO events (restaurant_id, id, type, schema_version, aggregate_type, aggregate_id,
           related, data, session_id, user_id, device_id, authorization_id, authorized_by_id,
           reason, device_time, hub_estimated_time, base_sequence, sequence, received_at,
           business_day, assignments, affects, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.restaurantId,
        e.id,
        e.type,
        e.schema_version,
        e.aggregate_type,
        e.aggregate_id,
        JSON.stringify(e.related),
        JSON.stringify(e.data),
        e.session_id,
        e.user_id,
        e.device_id,
        e.authorization_id,
        e.authorized_by_id,
        e.reason,
        e.device_time,
        e.hub_estimated_time,
        e.base_sequence,
        e.sequence,
        e.received_at,
        e.business_day,
        JSON.stringify(e.assignments),
        JSON.stringify(e.affects),
        fingerprint,
      )
    const index = this.db.prepare(
      'INSERT INTO event_aggregates (restaurant_id, aggregate_id, sequence, event_id) VALUES (?, ?, ?, ?)',
    )
    for (const aggregate of aggregates) index.run(this.restaurantId, aggregate, e.sequence, e.id)
  }

  saveRejection(r: Rejection) {
    // With no row the `_no_replace` trigger does not fire: a repeated rejection does nothing.
    this.db
      .prepare(
        `INSERT INTO rejected_events (restaurant_id, event_id, device_id, reason, content, content_hash, received_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM rejected_events
           WHERE restaurant_id = ? AND event_id = ? AND content_hash = ?)`,
      )
      .run(
        this.restaurantId,
        r.eventId,
        r.deviceId,
        r.reason,
        r.content,
        r.fingerprint,
        r.receivedAt,
        this.restaurantId,
        r.eventId,
        r.fingerprint,
      )
  }

  saveQuarantine(c: Quarantine) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO quarantined_events (restaurant_id, event_id, device_id, reason, content, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.restaurantId, c.eventId, c.deviceId, c.reason, c.content, c.receivedAt)
  }

  saveConflict(c: Conflict) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conflicts (id, restaurant_id, type, event_id, aggregate_id, description, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, this.restaurantId, c.type, c.eventId, c.aggregateId, c.description, c.detectedAt)
  }

  conflicts(): Conflict[] {
    return this.db
      .prepare('SELECT * FROM conflicts WHERE restaurant_id = ? ORDER BY detected_at, event_id')
      .all(this.restaurantId)
      .map((f) => this.toConflict(f))
  }

  private toConflict(f: Row): Conflict {
    return {
      id: String(f.id),
      type: String(f.type) as ConflictType,
      eventId: String(f.event_id),
      aggregateId: String(f.aggregate_id),
      description: String(f.description),
      detectedAt: String(f.detected_at),
    }
  }
}
