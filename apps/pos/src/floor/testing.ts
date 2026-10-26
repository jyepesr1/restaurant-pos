import { type ApplicableEvent, type NewEvent, newId, type OrderEventType } from '@pos/core'
import type { Catalog, LocalEvent, LocalState } from '@pos/sync'

// Helpers for the floor tests: local events and a minimal catalog, with no network or database.

export const TIME = '2026-10-24T15:00:00.000Z'

let position = 0
let sequence = 0

/** A local event. With `status: 'confirmed'` it carries the hub fields and its sequence. */
export function local<T extends OrderEventType>(
  type: T,
  orderId: string,
  data: Extract<NewEvent, { type: T }>['data'],
  status: LocalState = 'confirmed',
  extras: Partial<NewEvent> = {},
): LocalEvent {
  const base = {
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: orderId,
    related: [],
    data,
    session_id: null,
    user_id: newId(),
    device_id: newId(),
    authorization_id: null,
    reason: null,
    device_time: TIME,
    hub_estimated_time: TIME,
    base_sequence: 0,
    ...extras,
  }
  const accepted =
    status === 'confirmed'
      ? {
          sequence: ++sequence,
          received_at: TIME,
          business_day: '2026-10-24',
          assignments: type === 'OrderOpened' ? { day_number: 1 } : {},
          affects: [],
          authorized_by_id: null,
        }
      : {}
  return {
    event: { ...base, ...accepted } as ApplicableEvent,
    status,
    own: true,
    position: ++position,
  }
}

export const itemData = (fields: Record<string, unknown> = {}) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Limonada',
  unit_price: 9_900,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 1,
  price_channel_id: null,
  ...fields,
})

export const opening = { channel: 'dine_in' as const, table_id: null, guests: 2 }

/** Minimal catalog: Cocina and Barra, one category for each and another with no station. */
export function testCatalog(fields: Partial<Catalog> = {}): Catalog {
  return {
    version: 4,
    restaurant: { name: 'Prueba', sessionIdleMin: 30 },
    zones: [],
    tables: [],
    elements: [],
    staff: [],
    stations: [
      { id: 'E-COCINA', name: 'Cocina' },
      { id: 'E-BARRA', name: 'Barra' },
    ],
    categories: [],
    ...fields,
  }
}

/**
 * Renumbers the sequence of the confirmed ones by their position: the tests build the
 * events in any order, but the hub numbers them in the order it accepts them.
 */
export function inOrder(locals: readonly LocalEvent[]): LocalEvent[] {
  let n = 0
  return locals.map((l) =>
    l.status === 'confirmed' ? { ...l, event: { ...l.event, sequence: ++n } } : l,
  )
}
