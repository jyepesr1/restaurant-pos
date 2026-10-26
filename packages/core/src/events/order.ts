import { z } from 'zod'
import { addFractions, PRICE_LIMIT } from '../money/arithmetic'
import {
  BasisPoints,
  Channel,
  Course,
  Day,
  IsoTime,
  ItemFraction,
  LocalizedText,
  PaymentMethod,
  Pesos,
  Price,
  Quantity,
  SignedPesos,
  TaxType,
  Ulid,
} from './common'

// Order events, version 1 (docs/MODELO_DATOS.md#eventos-del-pedido-versión-1). All objects are
// strict: an extra field is rejected instead of silently dropped, so what is stored is exactly
// what arrived.

const Modifier = z.strictObject({
  modifier_id: Ulid,
  name: LocalizedText,
  extra_price: Price,
})

const itemCopyFields = {
  item_id: Ulid,
  product_id: Ulid,
  variant_id: Ulid.nullable(),
  name: LocalizedText,
  unit_price: Price,
  tax_type: TaxType,
  rate: BasisPoints,
  quantity: Quantity,
  guest: z.int().min(1).max(99).nullable(),
  course: Course.nullable(),
  modifiers: z.array(Modifier).max(30),
  notes: z.string().max(500).nullable(),
}

type CopyFields = {
  tax_type: string
  rate: number
  unit_price: number
  modifiers: { extra_price: number }[]
}

/** Exempt with no rate, and the full unit (price + extras) within the price limit. */
function validateCopy(item: CopyFields, ctx: z.RefinementCtx) {
  if (item.tax_type === 'exempt' && item.rate !== 0) {
    ctx.addIssue({ code: 'custom', path: ['rate'], message: 'Un ítem exento no lleva tarifa' })
  }
  const perUnit = item.unit_price + item.modifiers.reduce((a, m) => a + m.extra_price, 0)
  if (perUnit > PRICE_LIMIT) {
    ctx.addIssue({ code: 'custom', message: `El precio con extras pasa de ${PRICE_LIMIT}` })
  }
}

/** Copy of an item: what travels when it is moved or when orders are merged. */
export const ItemCopy = z.strictObject(itemCopyFields).superRefine(validateCopy)
export type ItemCopy = z.infer<typeof ItemCopy>

/** Moved item: besides the copy, its status, what was voided and who added it. */
const MovedItem = z
  .strictObject({
    item: ItemCopy,
    status: z.enum(['held', 'pending', 'sent', 'in_preparation', 'ready', 'served']),
    voided_quantity: z.int().min(0),
    added_by: Ulid,
  })
  .refine((m) => m.voided_quantity < m.item.quantity, 'No se mueve un ítem anulado por completo')

const ItemIds = z.array(Ulid).min(1).max(200)
const EmptyState = z.strictObject({})

const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length

const dataByType = {
  OrderOpened: z.strictObject({
    channel: Channel,
    table_id: Ulid.nullable(),
    guests: z.int().min(0).max(200),
  }),
  RescueOrderCreated: z.strictObject({
    original_order_id: Ulid,
    channel: Channel,
    table_id: Ulid.nullable(),
    waiter_id: Ulid,
  }),
  WaiterAssigned: z.strictObject({ waiter_id: Ulid }),
  GuestsChanged: z.strictObject({ guests: z.int().min(0).max(200) }),
  /** Note for the whole order («alérgico al maní», «cumpleaños»); `null` removes it. */
  OrderNoteChanged: z.strictObject({ notes: z.string().max(500).nullable() }),
  ItemAdded: z
    .strictObject({
      ...itemCopyFields,
      catalog_version: z.int().min(0),
      price_channel_id: Ulid.nullable(),
    })
    .superRefine(validateCopy),
  ItemChanged: z
    .strictObject({
      item_id: Ulid,
      quantity: Quantity.optional(),
      guest: z.int().min(1).max(99).nullable().optional(),
      course: Course.nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
    })
    .refine(
      (d) => Object.entries(d).some(([field, value]) => field !== 'item_id' && value !== undefined),
      'Debe cambiar al menos un campo',
    ),
  ItemRemoved: z.strictObject({ item_id: Ulid }),
  ItemsSent: z.strictObject({
    tickets: z
      .array(z.strictObject({ ticket_id: Ulid, station_id: Ulid, item_ids: ItemIds }))
      .min(1),
  }),
  ItemModifiedAfterSend: z
    .strictObject({
      item_id: Ulid,
      ticket_id: Ulid,
      notes: z.string().max(500).nullable().optional(),
      modifiers: z.array(Modifier).max(30).optional(),
    })
    .refine(
      (d) => d.notes !== undefined || d.modifiers !== undefined,
      'Debe cambiar notas o modificadores',
    ),
  TicketReprinted: z.strictObject({ ticket_id: Ulid }),
  CourseHeld: z.strictObject({ course: Course }),
  CourseFired: z.strictObject({ course: Course }),
  ItemInPreparation: z.strictObject({ item_ids: ItemIds }),
  ItemReady: z.strictObject({ item_ids: ItemIds }),
  ItemServed: z.strictObject({ item_ids: ItemIds }),
  ItemReturnedToQueue: z.strictObject({ item_ids: ItemIds }),
  ItemVoided: z.strictObject({
    item_id: Ulid,
    quantity: Quantity,
    already_prepared: z.boolean(),
    ticket_id: Ulid.nullable(),
  }),
  ItemsMoved: z.strictObject({
    target_order_id: Ulid,
    items: z
      .array(MovedItem)
      .min(1)
      .max(200)
      .refine((items) => uniqueIds(items.map((m) => m.item.item_id)), 'Ítems repetidos'),
  }),
  OrderMovedTable: z.strictObject({ target_table_id: Ulid }),
  /**
   * A large party takes more tables with the same order (task 1.5): the tables added to its own.
   * `TablesSeparated` releases them.
   */
  TablesMerged: z.strictObject({
    table_ids: z.array(Ulid).min(1).max(10).refine(uniqueIds, 'Mesas repetidas'),
  }),
  TablesSeparated: z.strictObject({
    table_ids: z.array(Ulid).min(1).max(10).refine(uniqueIds, 'Mesas repetidas'),
  }),
  OrdersMerged: z.strictObject({
    source_order_id: Ulid,
    items: z
      .array(MovedItem)
      .max(200)
      .refine((items) => uniqueIds(items.map((m) => m.item.item_id)), 'Ítems repetidos'),
  }),
  DiscountApplied: z
    .strictObject({
      discount_id: Ulid,
      scope: z.enum(['item', 'order']),
      rule: z.enum(['percent', 'value', 'comp']),
      value: Pesos,
      unit_count: Quantity.nullable(),
      amounts: z
        .array(z.strictObject({ item_id: Ulid, amount: Pesos }))
        .min(1)
        .max(200),
    })
    .superRefine((d, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
      if (!uniqueIds(d.amounts.map((m) => m.item_id))) issue('Un ítem aparece dos veces en montos')
      if (d.scope === 'item' && d.amounts.length !== 1)
        issue('Un descuento de ítem va en una sola línea')
      if (d.rule === 'value' && d.amounts.reduce((a, m) => a + m.amount, 0) !== d.value) {
        issue('En un descuento por valor, los montos deben sumar el valor')
      }
      if (d.rule === 'percent' && d.value > 10_000)
        issue('El porcentaje va en puntos básicos (máx. 10.000)')
      if (d.rule === 'comp' && (d.unit_count === null || d.scope !== 'item')) {
        issue('Una cortesía es de un ítem e indica cuántas unidades')
      }
      if (d.rule !== 'comp' && d.unit_count !== null) issue('Solo la cortesía indica unidades')
    }),
  DiscountRemoved: z.strictObject({ discount_id: Ulid }),
  PreBillPrinted: z.strictObject({
    check_id: Ulid.nullable(),
    subtotal: Pesos,
    suggested_tip: Pesos,
  }),
  CheckSplit: z.strictObject({
    checks: z
      .array(
        z.strictObject({
          check_id: Ulid,
          name: LocalizedText,
          amount: Pesos,
          suggested_tip: Pesos,
          items: z.array(z.strictObject({ item_id: Ulid, fraction: ItemFraction })).max(200),
        }),
      )
      .min(2)
      .max(50)
      .superRefine((checks, ctx) => {
        if (!uniqueIds(checks.map((c) => c.check_id))) {
          ctx.addIssue({ code: 'custom', message: 'Hay cuentas repetidas' })
        }
        const byItem = new Map<string, { n: bigint; d: bigint }>()
        for (const { item_id, fraction } of checks.flatMap((c) => c.items)) {
          const sum = addFractions(byItem.get(item_id) ?? { n: 0n, d: 1n }, {
            n: BigInt(fraction.n),
            d: BigInt(fraction.d),
          })
          byItem.set(item_id, sum)
          if (sum.n > sum.d)
            ctx.addIssue({ code: 'custom', message: `Las fracciones de ${item_id} pasan de 1` })
        }
      }),
  }),
  SplitUndone: EmptyState,
  PaymentRecorded: z
    .strictObject({
      payment_id: Ulid,
      check_id: Ulid.nullable(),
      register_shift_id: Ulid,
      method: PaymentMethod,
      amount: Pesos.min(1),
      tip: Pesos,
      tendered: Pesos.nullable(),
      change: Pesos.nullable(),
      rounding_adjustment: SignedPesos,
      // Cash rounding rule used to compute the adjustment; the hub takes it from the restaurant
      // config and the reducer checks the adjustment against it.
      rounding: z
        .strictObject({
          multiple: z.int().min(1).max(10_000),
          mode: z.enum(['nearest_half_down', 'nearest_half_up', 'down', 'up']),
        })
        .nullable(),
      cardTerminal: z
        .strictObject({
          card_terminal_id: Ulid,
          franchise: LocalizedText.nullable(),
          last4: z
            .string()
            .regex(/^\d{4}$/)
            .nullable(),
          // The owner asked to record cards with just the amount (26-oct-2026): the approval
          // number is optional; the 1.8 reconciliation matches by amount, card terminal and time.
          approval_code: LocalizedText.nullable(),
          receipt: LocalizedText.nullable(),
          // Credit or debit, as the cashier picks it (task 1.6). Older payments do not have it.
          card_type: z.enum(['credit', 'debit']).nullable().optional(),
        })
        .nullable(),
      charge_reference: z.string().max(100).nullable(),
      /** With `method: 'other'`, which of the restaurant's custom methods (task 1.6). */
      custom_method_id: Ulid.nullable().optional(),
    })
    .superRefine((p, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
      if (p.method === 'cash') {
        if (p.tendered === null || p.change === null) issue('En efectivo van recibido y cambio')
        else if (p.tendered !== p.amount + p.rounding_adjustment + p.tip + p.change) {
          issue('recibido ≠ monto + ajuste + propina + cambio')
        }
      } else if (
        p.tendered !== null ||
        p.change !== null ||
        p.rounding_adjustment !== 0 ||
        p.rounding !== null
      ) {
        issue('Solo el efectivo lleva recibido, cambio y redondeo')
      }
      if (
        p.rounding_adjustment !== 0 &&
        (p.rounding === null || Math.abs(p.rounding_adjustment) >= p.rounding.multiple)
      ) {
        issue('El ajuste de redondeo debe ser menor que el múltiplo de redondeo')
      }
      if (p.amount + p.rounding_adjustment < 0) issue('Lo cobrado no puede ser negativo')
      if (p.method === 'card' && p.cardTerminal === null)
        issue('Un pago con tarjeta indica el datáfono')
      if ((p.method === 'other') !== Boolean(p.custom_method_id))
        issue('Un medio propio dice cuál es, y solo ese medio lo dice')
    }),
  PaymentVoided: z.strictObject({ payment_id: Ulid, register_shift_id: Ulid }),
  RefundRecorded: z
    .strictObject({
      payment_id: Ulid,
      refund_id: Ulid,
      sale_amount: Pesos,
      tip_amount: Pesos,
      method: PaymentMethod,
      register_shift_id: Ulid,
    })
    .refine((r) => r.sale_amount + r.tip_amount > 0, 'El reembolso debe ser mayor que 0'),
  OrderClosed: EmptyState,
  OrderReopened: EmptyState,
  OrderCanceled: EmptyState,
  // Sold out (86) and back: they belong to the product, not the order (aggregate `product`). They
  // go in the same sequence so they reach everyone instantly, including whoever was offline
  // (docs/MODELO_DATOS.md#eventos-de-mesa-producto-y-caja). No variant: the whole product.
  ProductSoldOut: z.strictObject({ product_id: Ulid, variant_id: Ulid.nullable() }),
  ProductAvailable: z.strictObject({ product_id: Ulid, variant_id: Ulid.nullable() }),
  // Open the register with the cash float (task 1.6). The aggregate is the shift; `register_id` is,
  // for now, the register device where it is opened.
  ShiftOpened: z.strictObject({ register_id: Ulid, base: Pesos }),
  // Cash going into or out of the drawer during the shift (task 1.7), with its reason. A tip
  // payout says who received them and which days of the pool they come from (docs/DINERO.md).
  CashMovementRecorded: z
    .strictObject({
      movement_id: Ulid,
      type: z.enum(['entry', 'output', 'tip_payout']),
      amount: Pesos.min(1),
      description: LocalizedText,
      to_whom: LocalizedText.nullable(),
      days: z.array(Day).max(31),
    })
    .superRefine((m, ctx) => {
      if ((m.type === 'tip_payout') !== (m.to_whom !== null))
        ctx.addIssue({ code: 'custom', message: 'Solo el pago de propinas dice a quién' })
      if ((m.type === 'tip_payout') !== m.days.length > 0)
        ctx.addIssue({ code: 'custom', message: 'El pago de propinas dice de qué días sale' })
    }),
  // The cash count at close (blind cash count): bills and coins by value. Every count is kept,
  // even if it is counted again.
  CashCountRecorded: z
    .strictObject({
      cash_count_id: Ulid,
      tally: z
        .array(z.strictObject({ value: Pesos.min(1), quantity: z.int().min(0).max(100_000) }))
        .max(30),
      counted_cash: Pesos,
      // What the closing reports of the other methods say (task 1.8): the card terminal's and
      // what reached each app, also entered without seeing what was recorded. Older counts do not
      // have it.
      others: z
        .array(
          z.strictObject({
            method: PaymentMethod.exclude(['cash']),
            custom_method_id: Ulid.nullable(),
            // Signed: a day with only refunds on a method closes negative.
            reported: SignedPesos,
          }),
        )
        .max(30)
        .optional(),
    })
    .refine(
      (a) => a.tally.reduce((s, c) => s + c.value * c.quantity, 0) === a.counted_cash,
      'El total contado no coincide con el conteo',
    )
    .refine((a) => {
      const keys = (a.others ?? []).map((o) => `${o.method}:${o.custom_method_id ?? ''}`)
      return new Set(keys).size === keys.length
    }, 'Un medio aparece dos veces')
    .refine(
      (a) =>
        (a.others ?? []).every((o) => (o.method === 'other') === (o.custom_method_id !== null)),
      'Un medio propio dice cuál es, y solo ese medio lo dice',
    ),
  // Close the register with the last count: expected, counted and the variance (signed:
  // negative is a shortage). From the restaurant's threshold on, with a justification.
  ShiftClosed: z
    .strictObject({
      cash_count_id: Ulid,
      expected_cash: SignedPesos,
      counted_cash: Pesos,
      variance: SignedPesos,
      justification: LocalizedText.nullable(),
      // For each non-cash method (task 1.8): what was recorded (sale + tip), what its closing
      // report says and the variance, signed.
      other_methods: z
        .array(
          z.strictObject({
            method: PaymentMethod.exclude(['cash']),
            custom_method_id: Ulid.nullable(),
            expected: SignedPesos,
            // Signed: a day with only refunds on a method closes negative.
            reported: SignedPesos,
            variance: SignedPesos,
          }),
        )
        .max(30)
        .optional(),
    })
    .refine(
      (t) => t.variance === t.counted_cash - t.expected_cash,
      'La diferencia es lo contado menos lo esperado',
    )
    .refine(
      (t) => (t.other_methods ?? []).every((o) => o.variance === o.reported - o.expected),
      'La diferencia de cada medio es lo reportado menos lo esperado',
    )
    .refine((t) => {
      const keys = (t.other_methods ?? []).map((o) => `${o.method}:${o.custom_method_id ?? ''}`)
      return new Set(keys).size === keys.length
    }, 'Un medio aparece dos veces')
    .refine(
      (t) =>
        (t.other_methods ?? []).every(
          (o) => (o.method === 'other') === (o.custom_method_id !== null),
        ),
      'Un medio propio dice cuál es, y solo ese medio lo dice',
    ),
} as const

export type OrderEventType = keyof typeof dataByType
export const ORDER_EVENT_TYPES = Object.keys(dataByType) as OrderEventType[]

/** The events whose aggregate is a product, not an order. */
export const PRODUCT_EVENT_TYPES: readonly OrderEventType[] = ['ProductSoldOut', 'ProductAvailable']
/** The events whose aggregate is a register shift. */
export const SHIFT_EVENT_TYPES: readonly OrderEventType[] = [
  'ShiftOpened',
  'CashMovementRecorded',
  'CashCountRecorded',
  'ShiftClosed',
]
export type AggregateType = 'order' | 'product' | 'register_shift'
/** Which aggregate each event type belongs to. */
export const aggregateOf = (type: OrderEventType): AggregateType =>
  PRODUCT_EVENT_TYPES.includes(type)
    ? 'product'
    : SHIFT_EVENT_TYPES.includes(type)
      ? 'register_shift'
      : 'order'

/** Events that require a reason in the envelope. */
export const TYPES_WITH_REASON: readonly OrderEventType[] = [
  'ItemVoided',
  'DiscountApplied',
  'DiscountRemoved',
  'PaymentVoided',
  'RefundRecorded',
  'OrderReopened',
  'OrderCanceled',
]

/** Envelope fields set by whoever creates the event (docs/SYNC.md#sobre-del-evento). */
const envelope = {
  id: Ulid,
  schema_version: z.literal(1),
  aggregate_type: z.enum(['order', 'product', 'register_shift']),
  aggregate_id: Ulid,
  related: z.array(Ulid).max(20),
  session_id: Ulid.nullable(),
  user_id: Ulid,
  device_id: Ulid,
  authorization_id: Ulid.nullable(),
  reason: LocalizedText.nullable(),
  device_time: IsoTime,
  hub_estimated_time: IsoTime,
  base_sequence: z.int().min(0),
  /**
   * HMAC of the event with the session secret (`signEvent`): proves it was created by whoever
   * had the session open. It only travels to the hub; it is not stored with the event.
   */
  signature: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
}

/** Fields the hub adds when it accepts the event. */
export const Acceptance = z.strictObject({
  sequence: z.int().min(1),
  received_at: IsoTime,
  business_day: Day,
  assignments: z.strictObject({
    day_number: z.int().min(1).optional(),
    /** Daily number of each ticket in a send, by `ticket_id` (ADR-015). */
    ticket_numbers: z.record(Ulid, z.int().min(1)).optional(),
  }),
  affects: z.array(Ulid).max(20),
  authorized_by_id: Ulid.nullable(),
})

function variant<T extends OrderEventType>(type: T) {
  return z.strictObject({ ...envelope, type: z.literal(type), data: dataByType[type] })
}

const variants = ORDER_EVENT_TYPES.map(variant) as [
  ReturnType<typeof variant>,
  ...ReturnType<typeof variant>[],
]

/** The other order of an event that touches two: target when moving, source when merging. */
function anotherOrder(event: { type: string; data: unknown }): string | null {
  const data = event.data as { target_order_id?: string; source_order_id?: string }
  if (event.type === 'ItemsMoved') return data.target_order_id ?? null
  if (event.type === 'OrdersMerged') return data.source_order_id ?? null
  return null
}

export const NewOrderEvent = z.discriminatedUnion('type', variants).superRefine((event, ctx) => {
  if (event.aggregate_type !== aggregateOf(event.type)) {
    ctx.addIssue({
      code: 'custom',
      path: ['aggregate_type'],
      message: `${event.type} es de un ${aggregateOf(event.type)}`,
    })
  }
  if (event.type === 'ProductSoldOut' || event.type === 'ProductAvailable') {
    if (event.aggregate_id !== (event.data as { product_id: string }).product_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['aggregate_id'],
        message: 'El agregado es el producto que se agota',
      })
    }
    // If it named an order, the hub would count it as an event of that order.
    if (event.related.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['related'],
        message: 'Un evento de producto no toca pedidos',
      })
    }
  }
  // A register shift does not touch orders either: if it named one, it would end up in its
  // history.
  if (SHIFT_EVENT_TYPES.includes(event.type) && event.related.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['related'],
      message: 'Un evento de caja no toca pedidos',
    })
  }
  if (TYPES_WITH_REASON.includes(event.type) && !event.reason) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: `${event.type} exige un motivo` })
  }
  const other = anotherOrder(event)
  if (other !== null && (other === event.aggregate_id || !event.related.includes(other))) {
    ctx.addIssue({
      code: 'custom',
      path: ['related'],
      message: 'El otro pedido debe ser distinto y figurar en relacionados',
    })
  }
})

type DataOf<T extends OrderEventType> = z.infer<(typeof dataByType)[T]>
type NewEnvelope = z.infer<z.ZodObject<typeof envelope>>

/** Event as a device creates it, before the hub accepts it. */
export type NewEvent<T extends OrderEventType = OrderEventType> = {
  [K in T]: NewEnvelope & { type: K; data: DataOf<K> }
}[T]

export type AcceptanceData = z.infer<typeof Acceptance>

/** Event accepted by the hub: with sequence and the other hub fields. */
export type OrderEvent<T extends OrderEventType = OrderEventType> = NewEvent<T> & AcceptanceData

/**
 * What the reducer accepts: an accepted event or one of its own still pending confirmation,
 * which the device projects before the hub replies (docs/SYNC.md#orden-y-estado-local).
 */
export type ApplicableEvent<T extends OrderEventType = OrderEventType> = NewEvent<T> &
  Partial<AcceptanceData>

export type ValidationResult = { ok: true; event: NewEvent } | { ok: false; errors: string[] }

/** Validates a new event against its schema. Does not throw: returns the errors in Spanish. */
export function validateNewEvent(entry: unknown): ValidationResult {
  const result = NewOrderEvent.safeParse(entry)
  if (result.success) return { ok: true, event: result.data as NewEvent }
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.') || 'evento'}: ${i.message}`),
  }
}
