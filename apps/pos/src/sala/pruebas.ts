import { type ApplicableEvent, type NewEvent, newId, type OrderEventType } from '@pos/core'
import type { Catalogo, EstadoLocal, EventoLocal } from '@pos/sync'

// Utilidades de las pruebas de la sala: eventos locales y un catálogo mínimo, sin red ni base.

export const TIME = '2026-10-24T15:00:00.000Z'

let position = 0
let sequence = 0

/** Un evento local. Con `estado: 'confirmado'` lleva los campos del hub y su secuencia. */
export function local<T extends OrderEventType>(
  type: T,
  orderId: string,
  data: Extract<NewEvent, { type: T }>['data'],
  status: EstadoLocal = 'confirmed',
  extras: Partial<NewEvent> = {},
): EventoLocal {
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

export const datosItem = (fields: Record<string, unknown> = {}) => ({
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

/** Catálogo mínimo: Cocina y Barra, una categoría de cada una y otra sin estación. */
export function catalogoDePrueba(fields: Partial<Catalogo> = {}): Catalogo {
  return {
    version: 4,
    restaurant: { name: 'Prueba', sesionInactividadMin: 30 },
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
 * Numera de nuevo la secuencia de los confirmados según su posición: las pruebas arman los
 * eventos en cualquier orden, pero el hub los numera en el orden en que los acepta.
 */
export function inOrder(locales: readonly EventoLocal[]): EventoLocal[] {
  let n = 0
  return locales.map((l) =>
    l.status === 'confirmed' ? { ...l, event: { ...l.event, sequence: ++n } } : l,
  )
}
