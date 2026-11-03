import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { rebuild, unappliedEvents } from '../order/apply'
import type { ShiftReconciliation } from '../register/shift'
import { cardPaymentData, cashPaymentData, event, itemCopy, SHIFT } from '../testing/factory'
import {
  type Alert,
  type AlertClosing,
  type AlertsInput,
  alertPeople,
  alerts,
  alertTables,
} from './alerts'
import { report } from './report'

// The owner's alerts (task 1.11c-2, docs/PANEL.md#alertas): voids and cancellations from the
// report, discounts, voided payments, refunds, reopened orders and register variances.

const DAY = '2026-10-24'
const ANA = newId()
const CARLOS = newId()
const LUIS = newId()
const TABLE = newId()
const QR = newId()
const CONFIG = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const

/** «HH:MM» of the day, as the hub's reception time. */
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`

/** An order on a table with one item sent to the kitchen, opened by Ana. */
function order(fields: { table?: string | null; price?: number; name?: string } = {}) {
  const id = newId()
  const item = itemCopy({ unit_price: fields.price ?? 40_900, name: fields.name ?? 'Pinsa' })
  const events: OrderEvent[] = [
    event(
      id,
      'OrderOpened',
      {
        channel: fields.table === null ? 'takeout' : 'dine_in',
        table_id: fields.table === null ? null : (fields.table ?? TABLE),
        guests: 2,
      },
      { user_id: ANA, assignments: { day_number: 12 } },
    ),
    event(id, 'ItemAdded', item, { user_id: ANA }),
    event(id, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [item.item_id] }],
    }),
  ]
  const record = <E extends OrderEvent>(e: E) => {
    events.push(e)
    return e
  }
  return { id, item, events, record }
}

const input = (over: Partial<AlertsInput> = {}): AlertsInput => ({
  day: DAY,
  voids: [],
  cancellations: [],
  orders: new Map(),
  registerClosings: [],
  threshold: 1_000,
  ...over,
})

const ordersOf = (...list: { id: string; events: OrderEvent[] }[]) =>
  new Map(list.map((o) => [o.id, o.events]))

function closing(closed: NonNullable<ShiftReconciliation['closed']> | null): AlertClosing {
  return {
    eventId: newId(),
    openedBy: ANA,
    closedBy: LUIS,
    reconciliation: {
      shiftId: SHIFT,
      registerId: newId(),
      base: 100_000,
      openedAt: at('12:00'),
      byMethod: [],
      movements: [],
      cashCounts: [],
      cash: { charged: 0, refunds: 0, cashIn: 0, cashOut: 0, tipPayouts: 0, expected: 100_000 },
      closed,
    },
  }
}

describe('alerts: voids and cancellations come from the report', () => {
  it('a voided item and a canceled order, with the table, who, who authorized and why', () => {
    const a = order()
    a.record(
      event(
        a.id,
        'ItemVoided',
        { item_id: a.item.item_id, quantity: 1, already_prepared: true, ticket_id: null },
        {
          user_id: ANA,
          authorized_by_id: CARLOS,
          reason: 'Se quemó',
          received_at: at('20:10'),
        },
      ),
    )
    const b = order({ table: null, price: 12_000, name: 'Limonada' })
    b.record(
      event(
        b.id,
        'OrderCanceled',
        {},
        { user_id: LUIS, reason: 'El cliente se fue', received_at: at('20:20') },
      ),
    )
    const r = report({
      from: DAY,
      until: DAY,
      related: [a, b].map((o) => rebuild(o.events, o.id)).filter((p) => p !== null),
      events: [...a.events, ...b.events],
      config: CONFIG,
    })
    const list = alerts(
      input({ voids: r.voids, cancellations: r.cancellations, orders: ordersOf(a, b) }),
    )
    expect(list).toEqual([
      {
        type: 'order_canceled',
        id: b.events.at(-1)?.id,
        time: at('20:20'),
        order: { id: b.id, number: 12, tableId: null, channel: 'takeout' },
        userId: LUIS,
        authorizedById: null,
        reason: 'El cliente se fue',
        value: 12_000,
      },
      {
        type: 'item_voided',
        id: a.events.at(-1)?.id,
        time: at('20:10'),
        order: { id: a.id, number: 12, tableId: TABLE, channel: 'dine_in' },
        userId: ANA,
        authorizedById: CARLOS,
        reason: 'Se quemó',
        value: 40_900,
        name: 'Pinsa',
        units: 1,
        alreadyPrepared: true,
      },
    ])
  })

  it('without the order’s events it keeps the report’s number, without a table', () => {
    const voided = {
      eventId: newId(),
      orderId: newId(),
      orderNumber: 7,
      name: 'Pinsa',
      units: 2,
      value: 81_800,
      reason: 'Error',
      alreadyPrepared: false,
      userId: ANA,
      authorizedById: null,
      time: at('19:00'),
    }
    const [alert] = alerts(input({ voids: [voided] }))
    expect(alert?.order).toEqual({
      id: voided.orderId,
      number: 7,
      tableId: null,
      channel: null,
    })
  })

  it('the table is the one the order had at that moment, not the one it moved to later', () => {
    const a = order()
    const voided = a.record(
      event(
        a.id,
        'ItemVoided',
        { item_id: a.item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        { reason: 'Error' },
      ),
    )
    const other = newId()
    a.record(event(a.id, 'OrderMovedTable', { target_table_id: other }))
    const r = report({
      from: DAY,
      until: DAY,
      related: [rebuild(a.events, a.id)].filter((p) => p !== null),
      events: a.events,
      config: CONFIG,
    })
    const [alert] = alerts(input({ voids: r.voids, orders: ordersOf(a) }))
    expect(alert?.id).toBe(voided.id)
    expect(alert?.order?.tableId).toBe(TABLE)
  })
})

describe('alerts: discounts', () => {
  it('a courtesy with its product and units, and a percentage removed later', () => {
    const a = order()
    const comp = a.record(
      event(
        a.id,
        'DiscountApplied',
        {
          discount_id: newId(),
          scope: 'item',
          rule: 'comp',
          value: 0,
          unit_count: 1,
          amounts: [{ item_id: a.item.item_id, amount: 40_900 }],
        },
        {
          user_id: ANA,
          authorized_by_id: CARLOS,
          reason: 'Cliente frecuente',
          received_at: at('20:00'),
        },
      ),
    )
    const b = order({ price: 50_000, name: 'Lasaña' })
    const percent = b.record(
      event(
        b.id,
        'DiscountApplied',
        {
          discount_id: newId(),
          scope: 'order',
          rule: 'percent',
          value: 1_000,
          unit_count: null,
          amounts: [{ item_id: b.item.item_id, amount: 5_000 }],
        },
        { user_id: LUIS, reason: 'Demora', received_at: at('20:05') },
      ),
    )
    b.record(
      event(
        b.id,
        'DiscountRemoved',
        { discount_id: percent.data.discount_id },
        { user_id: CARLOS, reason: 'No aplicaba', received_at: at('20:30') },
      ),
    )
    const list = alerts(input({ orders: ordersOf(a, b) }))
    expect(list.map((x) => x.id)).toEqual([percent.id, comp.id])
    expect(list[0]).toEqual({
      type: 'discount',
      id: percent.id,
      time: at('20:05'),
      order: { id: b.id, number: 12, tableId: TABLE, channel: 'dine_in' },
      userId: LUIS,
      authorizedById: null,
      reason: 'Demora',
      value: 5_000,
      rule: 'percent',
      scope: 'order',
      basisPoints: 1_000,
      units: null,
      items: ['Lasaña'],
      removedAt: at('20:30'),
      removedBy: CARLOS,
    })
    expect(list[1]).toMatchObject({
      type: 'discount',
      value: 40_900,
      rule: 'comp',
      basisPoints: null,
      units: 1,
      items: ['Pinsa'],
      authorizedById: CARLOS,
      removedAt: null,
      removedBy: null,
    })
    expect(alertPeople(list).sort()).toEqual([ANA, CARLOS, CARLOS, LUIS].sort())
    expect(alertTables(list)).toEqual([TABLE, TABLE])
  })

  it('a discount on a product that is not among the order’s events at hand says «Producto»', () => {
    // With the whole order the reducer would not apply it (item_not_found: saved as a conflict);
    // here only the discount is at hand, so it is not judged and its product is unknown.
    const a = { id: newId(), events: [] as OrderEvent[] }
    const ghost = newId()
    a.events.push(
      event(
        a.id,
        'DiscountApplied',
        {
          discount_id: newId(),
          scope: 'item',
          rule: 'value',
          value: 3_000,
          unit_count: null,
          amounts: [{ item_id: ghost, amount: 3_000 }],
        },
        { reason: 'Prueba' },
      ),
    )
    const [alert] = alerts(input({ orders: ordersOf(a) }))
    expect(alert).toMatchObject({ type: 'discount', value: 3_000, items: ['Producto'] })
  })
})

describe('alerts: voided payments, refunds and reopened orders', () => {
  it('each one with its method and what it was worth', () => {
    const a = order()
    const cash = a.record(
      event(a.id, 'PaymentRecorded', cashPaymentData(40_900, { tip: 4_000 }), {
        received_at: at('19:00'),
      }),
    )
    const voided = a.record(
      event(
        a.id,
        'PaymentVoided',
        { payment_id: cash.data.payment_id, register_shift_id: SHIFT },
        { user_id: LUIS, reason: 'Cobro duplicado', received_at: at('19:10') },
      ),
    )
    const card = a.record(
      event(
        a.id,
        'PaymentRecorded',
        cardPaymentData(40_900, { method: 'other', cardTerminal: null, custom_method_id: QR }),
        { received_at: at('19:20') },
      ),
    )
    a.record(event(a.id, 'OrderClosed', {}, { received_at: at('19:30') }))
    // A refund needs the order open (the reducer refuses it on a closed one): it is reopened first.
    const reopened = a.record(
      event(
        a.id,
        'OrderReopened',
        {},
        { user_id: CARLOS, reason: 'Plato frío', received_at: at('19:40') },
      ),
    )
    const refund = a.record(
      event(
        a.id,
        'RefundRecorded',
        {
          payment_id: card.data.payment_id,
          refund_id: newId(),
          sale_amount: 10_000,
          tip_amount: 0,
          method: 'other',
          register_shift_id: SHIFT,
        },
        { user_id: LUIS, authorized_by_id: CARLOS, reason: 'Plato frío', received_at: at('19:50') },
      ),
    )
    const list = alerts(input({ orders: ordersOf(a) }))
    expect(list.map((x) => x.type)).toEqual(['refund', 'order_reopened', 'payment_voided'])
    expect(list[1]).toEqual({
      type: 'order_reopened',
      id: reopened.id,
      time: at('19:40'),
      order: { id: a.id, number: 12, tableId: TABLE, channel: 'dine_in' },
      userId: CARLOS,
      authorizedById: null,
      reason: 'Plato frío',
      value: 40_900,
    })
    expect(list[0]).toMatchObject({
      type: 'refund',
      id: refund.id,
      value: 10_000,
      tip: 0,
      method: 'other',
      customMethodId: QR,
      authorizedById: CARLOS,
    })
    // A voided payment returns everything: sale, rounding and tip, and says how much was tip.
    expect(list[2]).toEqual({
      type: 'payment_voided',
      id: voided.id,
      time: at('19:10'),
      order: { id: a.id, number: 12, tableId: TABLE, channel: 'dine_in' },
      userId: LUIS,
      authorizedById: null,
      value: 44_900,
      tip: 4_000,
      roundingAdjustment: 0,
      method: 'cash',
      customMethodId: null,
      reason: 'Cobro duplicado',
    })
  })

  it('a voided cash payment with its rounding: value = sale + rounding + tip, each part apart', () => {
    const a = order({ price: 40_950 })
    const cash = a.record(
      event(
        a.id,
        'PaymentRecorded',
        cashPaymentData(40_950, {
          tip: 2_000,
          rounding_adjustment: 50,
          rounding: { multiple: 100, mode: 'nearest_half_up' },
        }),
      ),
    )
    a.record(
      event(
        a.id,
        'PaymentVoided',
        { payment_id: cash.data.payment_id, register_shift_id: SHIFT },
        { reason: 'Error' },
      ),
    )
    const [alert] = alerts(input({ orders: ordersOf(a) }))
    expect(alert).toMatchObject({
      type: 'payment_voided',
      value: 43_000,
      tip: 2_000,
      roundingAdjustment: 50,
    })
  })

  it('a voided payment whose payment is not at hand has no value, tip or method (null, not 0)', () => {
    // Only the void is at hand (not the order's opening nor its payment): it cannot be judged, so
    // it stays, but what it was worth is unknown.
    const id = newId()
    const voided = event(
      id,
      'PaymentVoided',
      { payment_id: newId(), register_shift_id: SHIFT },
      { reason: 'Error' },
    )
    const [alert] = alerts(input({ orders: new Map([[id, [voided]]]) }))
    expect(alert).toMatchObject({
      type: 'payment_voided',
      value: null,
      tip: null,
      roundingAdjustment: null,
      method: null,
    })
  })

  it('a reopening without the order’s previous events has no value (null, not 0)', () => {
    const id = newId()
    const reopened = event(id, 'OrderReopened', {}, { reason: 'Faltó cobrar' })
    const [alert] = alerts(input({ orders: new Map([[id, [reopened]]]) }))
    expect(alert).toMatchObject({
      type: 'order_reopened',
      value: null,
      order: { id, number: null, tableId: null, channel: null },
    })
  })

  it('only events of that day, each once and from its own order', () => {
    const a = order()
    const b = order()
    const yesterday = a.record(
      event(a.id, 'OrderReopened', {}, { reason: 'Ayer', business_day: '2026-10-23' }),
    )
    // An event of B that also appears among A's (as a move would).
    const discount = b.record(
      event(
        b.id,
        'DiscountApplied',
        {
          discount_id: newId(),
          scope: 'item',
          rule: 'value',
          value: 1_000,
          unit_count: null,
          amounts: [{ item_id: b.item.item_id, amount: 1_000 }],
        },
        { reason: 'Hoy' },
      ),
    )
    const list = alerts(
      input({
        orders: new Map([
          [a.id, [...a.events, discount]],
          [b.id, b.events],
        ]),
      }),
    )
    expect(list.map((x) => x.id)).toEqual([discount.id])
    expect(list.map((x) => x.id)).not.toContain(yesterday.id)
  })
})

describe('alerts: register variances', () => {
  const closed = {
    expected: 500_000,
    counted: 495_000,
    variance: -5_000,
    justification: 'Faltó cambio',
    otherMethods: [
      {
        method: 'card' as const,
        customMethodId: null,
        expected: 300_000,
        reported: 300_500,
        variance: 500,
      },
      {
        method: 'nequi' as const,
        customMethodId: null,
        expected: 80_000,
        reported: 78_000,
        variance: -2_000,
      },
      {
        method: 'other' as const,
        customMethodId: QR,
        expected: 10_000,
        reported: 12_000,
        variance: 2_000,
      },
    ],
    time: at('23:00'),
  }

  it('cash and each other method from the threshold up, with the justification', () => {
    const c = closing(closed)
    const list = alerts(input({ registerClosings: [c] }))
    // The card's 500 is below the threshold of 1.000: not an alert.
    expect(list.map((x) => x.id).sort()).toEqual(
      [`${c.eventId}:cash`, `${c.eventId}:nequi:`, `${c.eventId}:other:${QR}`].sort(),
    )
    const cash = list.find((x) => x.id === `${c.eventId}:cash`)
    expect(cash).toEqual({
      type: 'register_variance',
      id: `${c.eventId}:cash`,
      time: at('23:00'),
      order: null,
      userId: LUIS,
      authorizedById: null,
      reason: 'Faltó cambio',
      value: -5_000,
      shiftId: SHIFT,
      method: 'cash',
      customMethodId: null,
      expected: 500_000,
      counted: 495_000,
      openedBy: ANA,
    })
    expect(list.find((x) => x.id.endsWith(`:other:${QR}`))).toMatchObject({
      method: 'other',
      customMethodId: QR,
      expected: 10_000,
      counted: 12_000,
      value: 2_000,
    })
    expect(alertPeople(list)).toEqual([LUIS, ANA, LUIS, ANA, LUIS, ANA])
    expect(alertTables(list)).toEqual([])
  })

  it('with a threshold of 0 any variance counts; a register that squares is never an alert', () => {
    const squares = closing({ ...closed, variance: 0, otherMethods: [] })
    const card = closing({ ...closed, variance: 0 })
    const list = alerts(input({ registerClosings: [squares, card], threshold: 0 }))
    expect(list.map((x) => x.id).sort()).toEqual(
      [`${card.eventId}:card:`, `${card.eventId}:nequi:`, `${card.eventId}:other:${QR}`].sort(),
    )
    // A shift without its close (it should not reach here) gives nothing.
    expect(alerts(input({ registerClosings: [closing(null)] }))).toEqual([])
  })
})

describe('alerts: order', () => {
  it('newest first; at the same time, by id from the highest', () => {
    const same = at('21:00')
    const entries = [newId(), newId(), newId()].map((eventId, i) => ({
      eventId,
      orderId: newId(),
      orderNumber: null,
      name: 'Pinsa',
      units: 1,
      value: 1,
      reason: null,
      alreadyPrepared: false,
      userId: ANA,
      authorizedById: null,
      time: i === 0 ? at('20:00') : same,
    }))
    const list: Alert[] = alerts(input({ voids: [...entries, entries[1] as (typeof entries)[0]] }))
    const ids = entries.map((e) => e.eventId)
    expect(list.map((x) => x.id)).toEqual([ids[2], ids[1], ids[1], ids[0]])
  })
})

describe('alerts: events saved as a conflict do not count', () => {
  // The hub saves, without applying, what an out-of-date device sent to an order already closed or
  // about an item already voided (docs/SYNC.md#rechazos-cuarentena-y-conflictos). It changed
  // nothing, so it is not an alert, a void or a payment either (docs/KPIS.md).
  it('a discount, a payment void and a refund after the close, and a second void of the same item', () => {
    const a = order()
    const card = a.record(event(a.id, 'PaymentRecorded', cardPaymentData(40_900)))
    a.record(event(a.id, 'OrderClosed', {}))
    const late = [
      event(
        a.id,
        'DiscountApplied',
        {
          discount_id: newId(),
          scope: 'order',
          rule: 'value',
          value: 5_000,
          unit_count: null,
          amounts: [{ item_id: a.item.item_id, amount: 5_000 }],
        },
        { reason: 'Tarde' },
      ),
      event(
        a.id,
        'PaymentVoided',
        { payment_id: card.data.payment_id, register_shift_id: SHIFT },
        { reason: 'Tarde' },
      ),
      event(
        a.id,
        'RefundRecorded',
        {
          payment_id: card.data.payment_id,
          refund_id: newId(),
          sale_amount: 1_000,
          tip_amount: 0,
          method: 'card',
          register_shift_id: SHIFT,
        },
        { reason: 'Tarde' },
      ),
    ]
    for (const e of late) a.record(e)
    const b = order()
    const voidOf = (quantity: number) =>
      event(
        b.id,
        'ItemVoided',
        { item_id: b.item.item_id, quantity, already_prepared: false, ticket_id: null },
        { reason: 'Otro mesero ya lo anuló' },
      )
    const first = b.record(voidOf(1))
    const twice = b.record(voidOf(1))
    expect(unappliedEvents([...a.events, ...b.events])).toEqual(
      new Set([...late.map((e) => e.id), twice.id]),
    )
    // The report is given every event, as the hub's `reportData` gathers them: it still lists the
    // second void (a task of its own); the alerts leave it out by themselves.
    const r = report({
      from: DAY,
      until: DAY,
      related: [a, b].map((o) => rebuild(o.events, o.id)).filter((p) => p !== null),
      events: [...a.events, ...b.events],
      config: CONFIG,
    })
    expect(r.voids.map((v) => v.eventId)).toContain(twice.id)
    const list = alerts(
      input({ voids: r.voids, cancellations: r.cancellations, orders: ordersOf(a, b) }),
    )
    expect(list.map((x) => x.id)).toEqual([first.id])
  })

  it('a cancellation saved as a conflict (the order was already closed) is not an alert', () => {
    const a = order()
    a.record(event(a.id, 'PaymentRecorded', cardPaymentData(40_900)))
    a.record(event(a.id, 'OrderClosed', {}))
    const late = a.record(event(a.id, 'OrderCanceled', {}, { reason: 'Tarde' }))
    expect(unappliedEvents(a.events)).toEqual(new Set([late.id]))
    const cancellation = {
      eventId: late.id,
      orderId: a.id,
      orderNumber: 12,
      value: 40_900,
      reason: 'Tarde',
      userId: ANA,
      authorizedById: null,
      time: at('21:00'),
    }
    expect(alerts(input({ cancellations: [cancellation], orders: ordersOf(a) }))).toEqual([])
    // Without the order's events it cannot be judged: it stays (never hide money).
    expect(alerts(input({ cancellations: [cancellation] })).map((x) => x.id)).toEqual([late.id])
  })

  it('a discount removal saved as a conflict does not mark the discount as removed', () => {
    const a = order()
    const applied = a.record(
      event(
        a.id,
        'DiscountApplied',
        {
          discount_id: newId(),
          scope: 'order',
          rule: 'value',
          value: 5_000,
          unit_count: null,
          amounts: [{ item_id: a.item.item_id, amount: 5_000 }],
        },
        { reason: 'Demora' },
      ),
    )
    a.record(event(a.id, 'PaymentRecorded', cardPaymentData(35_900)))
    a.record(event(a.id, 'OrderClosed', {}))
    a.record(
      event(
        a.id,
        'DiscountRemoved',
        { discount_id: applied.data.discount_id },
        { reason: 'Tarde' },
      ),
    )
    const [alert] = alerts(input({ orders: ordersOf(a) }))
    expect(alert).toMatchObject({ id: applied.id, removedAt: null, removedBy: null })
  })

  it('an order whose opening is not at hand is not judged: its events stay', () => {
    const id = newId()
    const reopened = event(id, 'OrderReopened', {}, { reason: 'Faltó cobrar' })
    expect(unappliedEvents([reopened])).toEqual(new Set())
    expect(alerts(input({ orders: new Map([[id, [reopened]]]) })).map((x) => x.id)).toEqual([
      reopened.id,
    ])
  })
})

describe('alerts: the variance threshold is the current one (D3)', () => {
  it('the same close is an alert or not depending on the threshold passed now, not the one at close', () => {
    // Closed with a variance of 5.000 when the threshold was 10.000 (no justification needed);
    // the owner then lowers it to 2.000: the panel uses today's value, so it is an alert now.
    const c = closing({
      expected: 100_000,
      counted: 95_000,
      variance: -5_000,
      justification: null,
      otherMethods: [],
      time: at('23:00'),
    })
    expect(alerts(input({ registerClosings: [c], threshold: 10_000 }))).toEqual([])
    expect(alerts(input({ registerClosings: [c], threshold: 2_000 })).map((x) => x.value)).toEqual([
      -5_000,
    ])
  })
})
