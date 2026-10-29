import { type OrderEvent, type OrderEventType, validateNewEvent } from '../events/order'
import { newId } from '../id'

// Event factory for tests: every event goes through the real schema, so a test never uses an
// event the hub would reject for its format.

export const TIME = '2026-10-24T20:00:00.000Z'
export const WAITER = newId()
export const DEVICE = newId()
export const SHIFT = newId()

let sequence = 0

type Data<T extends OrderEventType> = Extract<OrderEvent, { type: T }>['data']

const HUB_FIELDS = [
  'sequence',
  'received_at',
  'business_day',
  'assignments',
  'affects',
  'authorized_by_id',
]

/** When moving or merging, an item's copy does not carry the catalog fields of ItemAdded. */
function clearMoved(data: unknown): unknown {
  const d = data as { items?: { item: Record<string, unknown> }[] }
  if (!Array.isArray(d.items)) return data
  return {
    ...d,
    items: d.items.map((m) => {
      const { catalog_version: _c, price_channel_id: _p, ...item } = m.item
      return { ...m, item }
    }),
  }
}

export function event<T extends OrderEventType>(
  orderId: string,
  type: T,
  data: Data<T>,
  extras: Partial<OrderEvent> = {},
): Extract<OrderEvent, { type: T }> {
  const hubFields = Object.fromEntries(
    Object.entries(extras).filter(([k]) => HUB_FIELDS.includes(k)),
  )
  const envelopeFields = Object.fromEntries(
    Object.entries(extras).filter(([k]) => !HUB_FIELDS.includes(k)),
  )
  const other =
    (data as { target_order_id?: string; source_order_id?: string }).target_order_id ??
    (data as { source_order_id?: string }).source_order_id
  const fresh = {
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: orderId,
    // Move and merge name the other order in `related` (the schema requires it).
    related: other && other !== orderId ? [other] : [],
    data: clearMoved(data),
    session_id: null,
    user_id: WAITER,
    device_id: DEVICE,
    authorization_id: null,
    reason: null,
    device_time: TIME,
    hub_estimated_time: TIME,
    base_sequence: 0,
    ...envelopeFields,
  }
  const validation = validateNewEvent(fresh)
  if (!validation.ok) throw new Error(`Invalid test event: ${validation.errors.join('; ')}`)
  sequence += 1
  return {
    ...fresh,
    sequence: sequence,
    received_at: TIME,
    business_day: '2026-10-24',
    assignments: {},
    affects: [],
    authorized_by_id: null,
    ...hubFields,
  } as unknown as Extract<OrderEvent, { type: T }>
}

/**
 * The same event with a new id and sequence: to reapply an already created event to a state
 * that moved forward (the reducer ignores already applied sequences).
 */
export function again<E extends OrderEvent>(e: E): E {
  sequence += 1
  return { ...e, id: newId(), sequence }
}

/**
 * The event with the next sequence, keeping its id: test helpers use it to apply events in the
 * order they are listed, even if they were created in another order. If the event already has a
 * sequence greater than the state's, it is left as is.
 */
export function inOrder<E extends OrderEvent>(e: E, lastSequence: number): E {
  if (e.sequence > lastSequence) return e
  sequence = Math.max(sequence, lastSequence) + 1
  return { ...e, sequence }
}

export function itemCopy(fields: Partial<Data<'ItemAdded'>> = {}): Data<'ItemAdded'> {
  return {
    item_id: newId(),
    product_id: newId(),
    variant_id: null,
    name: 'Garden Margarita',
    unit_price: 40_900,
    tax_type: 'inc',
    rate: 800,
    quantity: 1,
    guest: null,
    course: null,
    modifiers: [],
    notes: null,
    catalog_version: 1,
    price_channel_id: null,
    ...fields,
  }
}

export function cashPaymentData(
  amount: number,
  fields: Partial<Data<'PaymentRecorded'>> = {},
): Data<'PaymentRecorded'> {
  const adjustment = fields.rounding_adjustment ?? 0
  const tip = fields.tip ?? 0
  const change = fields.change ?? 0
  return {
    payment_id: newId(),
    check_id: null,
    register_shift_id: SHIFT,
    method: 'cash',
    amount,
    tip,
    tendered: amount + adjustment + tip + change,
    change,
    rounding_adjustment: adjustment,
    rounding: adjustment === 0 ? null : { multiple: 100, mode: 'nearest_half_down' },
    cardTerminal: null,
    charge_reference: null,
    ...fields,
  }
}

export function cardPaymentData(
  amount: number,
  fields: Partial<Data<'PaymentRecorded'>> = {},
): Data<'PaymentRecorded'> {
  return {
    payment_id: newId(),
    check_id: null,
    register_shift_id: SHIFT,
    method: 'card',
    amount,
    tip: 0,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: {
      card_terminal_id: newId(),
      franchise: 'Visa',
      last4: '4242',
      approval_code: '123456',
      receipt: null,
    },
    charge_reference: null,
    ...fields,
  }
}
