import type { OrderEvent } from '@pos/core'
import { type BaseSqlite, enTransaccion, type Fila } from '@pos/db'
import {
  type AlmacenHub,
  type Conflicto,
  type Cuarentena,
  type Rechazo,
  TIPOS_COBRO,
  type TipoConflicto,
} from './almacen'

const text = (v: unknown) => (v === null || v === undefined ? null : String(v))

function aEvento(f: Fila): OrderEvent {
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

/** Almacén del hub sobre las tablas de `@pos/db` (evento, event_aggregates, rechazos, conflictos). */
export class AlmacenSqlite implements AlmacenHub {
  private readonly db: BaseSqlite
  private readonly restauranteId: string

  constructor(db: BaseSqlite, restauranteId: string) {
    this.db = db
    this.restauranteId = restauranteId
  }

  transaccion<T>(trabajo: () => T): T {
    return enTransaccion(this.db, trabajo)
  }

  maxSecuencia(): number {
    const row = this.db
      .prepare('SELECT max(sequence) AS m FROM events WHERE restaurant_id = ?')
      .get(this.restauranteId)
    return Number(row?.m ?? 0)
  }

  porId(id: string) {
    const row = this.db
      .prepare('SELECT * FROM events WHERE restaurant_id = ? AND id = ?')
      .get(this.restauranteId, id)
    return row ? { event: aEvento(row), fingerprint: String(row.content_hash) } : undefined
  }

  rechazo(eventId: string, fingerprint: string): Rechazo | undefined {
    const f = this.db
      .prepare(
        'SELECT * FROM rejected_events WHERE restaurant_id = ? AND event_id = ? AND content_hash = ?',
      )
      .get(this.restauranteId, eventId, fingerprint)
    if (!f) return undefined
    return {
      eventId: String(f.event_id),
      fingerprint: String(f.content_hash),
      dispositivoId: String(f.device_id),
      reason: String(f.reason),
      content: String(f.content),
      recibidoEn: String(f.received_at),
    }
  }

  conflictoDe(eventId: string): Conflicto | undefined {
    const f = this.db
      .prepare('SELECT * FROM conflicts WHERE restaurant_id = ? AND event_id = ?')
      .get(this.restauranteId, eventId)
    return f ? this.aConflicto(f) : undefined
  }

  ultimaSecuenciaDe(agregados: readonly string[], excepto?: string): number {
    if (agregados.length === 0) return 0
    const list = agregados.map(() => '?').join(', ')
    const row =
      excepto === undefined
        ? this.db
            .prepare(
              `SELECT max(sequence) AS m FROM event_aggregates
               WHERE restaurant_id = ? AND aggregate_id IN (${list})`,
            )
            .get(this.restauranteId, ...agregados)
        : this.db
            .prepare(
              `SELECT max(a.sequence) AS m FROM event_aggregates a
               JOIN events e ON e.restaurant_id = a.restaurant_id AND e.id = a.event_id
               WHERE a.restaurant_id = ? AND a.aggregate_id IN (${list}) AND e.device_id <> ?`,
            )
            .get(this.restauranteId, ...agregados, excepto)
    return Number(row?.m ?? 0)
  }

  eventosDeAgregado(agregadoId: string): OrderEvent[] {
    return this.db
      .prepare(
        `SELECT e.* FROM event_aggregates a
         JOIN events e ON e.restaurant_id = a.restaurant_id AND e.id = a.event_id
         WHERE a.restaurant_id = ? AND a.aggregate_id = ? ORDER BY a.sequence`,
      )
      .all(this.restauranteId, agregadoId)
      .map(aEvento)
  }

  cuarentenasDe(dispositivoId: string): number {
    const row = this.db
      .prepare(
        'SELECT count(*) AS n FROM quarantined_events WHERE restaurant_id = ? AND device_id = ?',
      )
      .get(this.restauranteId, dispositivoId)
    return Number(row?.n ?? 0)
  }

  aperturasDelDia(day: string): number {
    const row = this.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE restaurant_id = ? AND type = 'OrderOpened' AND business_day = ?",
      )
      .get(this.restauranteId, day)
    return Number(row?.n ?? 0)
  }

  comandasDelDia(day: string): number {
    const row = this.db
      .prepare(
        `SELECT coalesce(sum((SELECT count(*) FROM json_each(assignments, '$.ticket_numbers'))), 0) AS n
         FROM events WHERE restaurant_id = ? AND type = 'ItemsSent' AND business_day = ?`,
      )
      .get(this.restauranteId, day)
    return Number(row?.n ?? 0)
  }

  eventosDelPeriodo(types: readonly string[], from: string, until: string): OrderEvent[] {
    if (types.length === 0) return []
    // Usa el índice events_by_type_and_day (migración 0006).
    return this.db
      .prepare(
        `SELECT * FROM events WHERE restaurant_id = ? AND type IN (${types.map(() => '?').join(', ')})
           AND business_day BETWEEN ? AND ? ORDER BY sequence`,
      )
      .all(this.restauranteId, ...types, from, until)
      .map(aEvento)
  }

  cobrosDeTurno(shiftId: string, from: string): OrderEvent[] {
    // El índice events_by_type_and_day acota por tipo y día; el turno se compara después.
    return this.db
      .prepare(
        `SELECT * FROM events WHERE restaurant_id = ? AND type IN (${TIPOS_COBRO.map(() => '?').join(', ')})
           AND business_day >= ? AND json_extract(data, '$.register_shift_id') = ? ORDER BY sequence`,
      )
      .all(this.restauranteId, ...TIPOS_COBRO, from, shiftId)
      .map(aEvento)
  }

  eventosDesde(from: number, limite: number): OrderEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM events WHERE restaurant_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
      )
      .all(this.restauranteId, from, limite)
      .map(aEvento)
  }

  saveEvent(e: OrderEvent, fingerprint: string, agregados: readonly string[]) {
    this.db
      .prepare(
        `INSERT INTO events (restaurant_id, id, type, schema_version, aggregate_type, aggregate_id,
           related, data, session_id, user_id, device_id, authorization_id, authorized_by_id,
           reason, device_time, hub_estimated_time, base_sequence, sequence, received_at,
           business_day, assignments, affects, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.restauranteId,
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
    const indice = this.db.prepare(
      'INSERT INTO event_aggregates (restaurant_id, aggregate_id, sequence, event_id) VALUES (?, ?, ?, ?)',
    )
    for (const aggregate of agregados) indice.run(this.restauranteId, aggregate, e.sequence, e.id)
  }

  guardarRechazo(r: Rechazo) {
    // Sin fila no salta el disparador `sin_reemplazo`: un rechazo repetido no hace nada.
    this.db
      .prepare(
        `INSERT INTO rejected_events (restaurant_id, event_id, device_id, reason, content, content_hash, received_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM rejected_events
           WHERE restaurant_id = ? AND event_id = ? AND content_hash = ?)`,
      )
      .run(
        this.restauranteId,
        r.eventId,
        r.dispositivoId,
        r.reason,
        r.content,
        r.fingerprint,
        r.recibidoEn,
        this.restauranteId,
        r.eventId,
        r.fingerprint,
      )
  }

  guardarCuarentena(c: Cuarentena) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO quarantined_events (restaurant_id, event_id, device_id, reason, content, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.restauranteId, c.eventId, c.dispositivoId, c.reason, c.content, c.recibidoEn)
  }

  guardarConflicto(c: Conflicto) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conflicts (id, restaurant_id, type, event_id, aggregate_id, description, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, this.restauranteId, c.type, c.eventId, c.agregadoId, c.description, c.detectadoEn)
  }

  conflictos(): Conflicto[] {
    return this.db
      .prepare('SELECT * FROM conflicts WHERE restaurant_id = ? ORDER BY detected_at, event_id')
      .all(this.restauranteId)
      .map((f) => this.aConflicto(f))
  }

  private aConflicto(f: Fila): Conflicto {
    return {
      id: String(f.id),
      type: String(f.type) as TipoConflicto,
      eventId: String(f.event_id),
      agregadoId: String(f.aggregate_id),
      description: String(f.description),
      detectadoEn: String(f.detected_at),
    }
  }
}
