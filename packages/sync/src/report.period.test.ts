import { newId, type OrderEvent, report } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  cardPaymentData,
  cashPaymentData,
  event,
  itemCopy,
  SHIFT,
  WAITER,
} from '../../core/src/testing/factory'
import { reportData, savedReconciliation, shiftClose } from './hub/report'
import { MemoryStore } from './hub/store'
import { SqliteStore } from './hub/store-sqlite'
import { enumerate, load } from './testing/histories'
import { sqliteDatabase } from './testing/setup'

// The report period (docs/KPIS.md#período) with hand-built cases, in both stores.
// Each day is a business day: the 23rd is "yesterday", the 24th "today", the 25th "tomorrow".

const CONFIG = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const
const D23 = '2026-10-23'
const D24 = '2026-10-24'
const D25 = '2026-10-25'
const D26 = '2026-10-26'

const applyToBoth = (events: OrderEvent[]) => {
  const memory = new MemoryStore()
  const { db, restaurantId } = sqliteDatabase()
  const sqlite = new SqliteStore(db, restaurantId)
  const list = enumerate(events)
  load(memory, list)
  load(sqlite, list)
  return [memory, sqlite] as const
}

const open = (id: string) =>
  event(id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 })

/** An order for `price` paid in cash and closed on `day`. */
function chargedOrder(price: number, day: string, paymentDay = day) {
  const id = newId()
  const item = itemCopy({ unit_price: price })
  const payment = cashPaymentData(price)
  return {
    id,
    item,
    payment,
    events: [
      open(id),
      event(id, 'ItemAdded', item),
      event(id, 'PaymentRecorded', payment, { business_day: paymentDay }),
      event(id, 'OrderClosed', {}, { business_day: day }),
    ] as OrderEvent[],
  }
}
const reopen = (id: string) => event(id, 'OrderReopened', {}, { reason: 'Se olvidó algo' })

const salesOf = (a: MemoryStore | SqliteStore, from: string, until = from) =>
  report({ ...reportData(a, from, until), config: CONFIG })

const send = (id: string, itemId: string) =>
  event(id, 'ItemsSent', {
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [itemId] }],
  })

describe('period: reopened orders (what was already reported for a day does not change)', () => {
  /** Closed on the 24th with $30.000; reopened, adds $10.000 and closes again on the 25th. */
  function withAddition() {
    const x = chargedOrder(30_000, D24)
    const extra = itemCopy({ unit_price: 10_000, name: 'Postre' })
    const extraPayment = cashPaymentData(10_000)
    const events = [
      ...x.events,
      reopen(x.id),
      event(x.id, 'ItemAdded', extra),
      event(x.id, 'PaymentRecorded', extraPayment, { business_day: D25 }),
      event(x.id, 'OrderClosed', {}, { business_day: D25 }),
    ]
    return { x, extra, events }
  }

  it('closed on the 24th and closed again on the 25th: the 25th adds only the difference', () => {
    const { events } = withAddition()
    for (const a of applyToBoth(events)) {
      expect(salesOf(a, D24).sales).toMatchObject({
        net: 30_000,
        gross: 30_000,
        checks: 1,
        guests: 2,
      })
      // The 25th adds what is new, but it is not another check nor more guests.
      expect(salesOf(a, D25).sales).toMatchObject({
        net: 10_000,
        gross: 10_000,
        checks: 0,
        guests: 0,
      })
      expect(salesOf(a, D25).byProduct).toEqual([
        expect.objectContaining({ name: 'Postre', units: 1, net: 10_000 }),
      ])
      expect(salesOf(a, D23).sales.net).toBe(0)
      expect(salesOf(a, D26).sales.net).toBe(0)
      // Both days together are the final order, a single check.
      expect(salesOf(a, D24, D25).sales).toMatchObject({
        net: 40_000,
        checks: 1,
        guests: 2,
      })
    }
  })

  it('closed, reopened and closed again with no changes: the second close adds zero', () => {
    const x = chargedOrder(12_000, D24)
    const events = [
      ...x.events,
      reopen(x.id),
      event(x.id, 'OrderClosed', {}, { business_day: D25 }),
    ]
    for (const a of applyToBoth(events)) {
      expect(salesOf(a, D24).sales.net).toBe(12_000)
      expect(salesOf(a, D25).sales).toMatchObject({
        net: 0,
        gross: 0,
        checks: 0,
        guests: 0,
      })
      expect(salesOf(a, D25).byProduct).toEqual([])
      expect(reportData(a, D25, D25).closings).toHaveLength(1)
    }
  })

  it('reopened and still open keeps counting on the day of its previous close, with what it had', () => {
    const x = chargedOrder(30_000, D24)
    const extra = itemCopy({ unit_price: 5_000 })
    // It is reopened on the 25th and something is added that is not yet paid or closed.
    const events = [...x.events, reopen(x.id), event(x.id, 'ItemAdded', extra)]
    for (const a of applyToBoth(events)) {
      expect(salesOf(a, D24).sales).toMatchObject({ net: 30_000, checks: 1 })
      expect(salesOf(a, D25).sales).toMatchObject({ net: 0, checks: 0 })
      expect(salesOf(a, D23, D26).sales.net).toBe(30_000)
    }
  })

  it('on reopen a product is voided and refunded: the second day subtracts, and nothing on the first changes', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 20_000, quantity: 2, name: 'Cerveza' })
    const payment = cashPaymentData(40_000)
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      send(id, item.item_id),
      event(id, 'PaymentRecorded', payment, { business_day: D24 }),
      event(id, 'OrderClosed', {}, { business_day: D24 }),
      reopen(id),
      event(
        id,
        'RefundRecorded',
        {
          payment_id: payment.payment_id,
          refund_id: newId(),
          sale_amount: 20_000,
          tip_amount: 0,
          method: 'cash',
          register_shift_id: SHIFT,
        },
        { reason: 'Error', business_day: D25 },
      ),
      event(
        id,
        'ItemVoided',
        { item_id: item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        { reason: 'Error', business_day: D25 },
      ),
      event(id, 'OrderClosed', {}, { business_day: D25 }),
    ]
    for (const a of applyToBoth(events)) {
      expect(salesOf(a, D24).sales).toMatchObject({ net: 40_000, gross: 40_000, voided: 0 })
      const d25 = salesOf(a, D25)
      expect(d25.sales).toMatchObject({ net: -20_000, gross: 0, voided: 20_000, checks: 0 })
      expect(d25.byProduct).toEqual([expect.objectContaining({ units: -1, net: -20_000 })])
      expect(d25.byMethod).toEqual([expect.objectContaining({ method: 'cash', sale: -20_000 })])
      expect(salesOf(a, D24, D25).sales.net).toBe(20_000)
    }
  })

  it('a discount removed on reopen shows in the second close with a negative amount', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 10_000 })
    const discount = newId()
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      event(
        id,
        'DiscountApplied',
        {
          discount_id: discount,
          scope: 'item',
          rule: 'value',
          value: 2_000,
          unit_count: null,
          amounts: [{ item_id: item.item_id, amount: 2_000 }],
        },
        { reason: 'Cliente frecuente' },
      ),
      event(id, 'PaymentRecorded', cashPaymentData(8_000)),
      event(id, 'OrderClosed', {}, { business_day: D24 }),
      reopen(id),
      event(id, 'DiscountRemoved', { discount_id: discount }, { reason: 'Se canceló' }),
      event(id, 'PaymentRecorded', cashPaymentData(2_000), { business_day: D25 }),
      event(id, 'OrderClosed', {}, { business_day: D25 }),
    ]
    for (const a of applyToBoth(events)) {
      expect(salesOf(a, D24).discounts).toEqual([expect.objectContaining({ amount: 2_000 })])
      expect(salesOf(a, D24).sales).toMatchObject({ net: 8_000, discounts: 2_000 })
      expect(salesOf(a, D25).discounts).toEqual([expect.objectContaining({ amount: -2_000 })])
      expect(salesOf(a, D25).sales).toMatchObject({ net: 2_000, discounts: -2_000 })
    }
  })

  it('reopened, with the payment voided and canceled: the 24th does not change and the cancellation counts on the 25th', () => {
    const x = chargedOrder(20_000, D24)
    const paymentVoid = event(
      x.id,
      'PaymentVoided',
      { payment_id: x.payment.payment_id, register_shift_id: SHIFT },
      { reason: 'm', business_day: D25 },
    )
    const events = [
      ...x.events,
      reopen(x.id),
      paymentVoid,
      event(x.id, 'OrderCanceled', {}, { reason: 'Se fueron', business_day: D25 }),
    ]
    for (const a of applyToBoth(events)) {
      expect(salesOf(a, D24).sales).toMatchObject({ net: 20_000, checks: 1 })
      const r = salesOf(a, D25)
      expect(r.sales.net).toBe(0)
      expect(r.byMethod).toEqual([expect.objectContaining({ sale: -20_000 })])
      expect(r.cancellations).toEqual([
        expect.objectContaining({ orderId: x.id, reason: 'Se fueron' }),
      ])
    }
  })

  it('each close carries the order at close and as it was at the previous one (null for the first)', () => {
    const { x, events } = withAddition()
    for (const a of applyToBoth(events)) {
      const [firstClosing] = reportData(a, D24, D24).closings
      expect(firstClosing?.before).toBeNull()
      expect(firstClosing?.after.id).toBe(x.id)
      const [secondClosing] = reportData(a, D25, D25).closings
      expect(Object.keys(secondClosing?.before?.items ?? {})).toHaveLength(1)
      expect(Object.keys(secondClosing?.after.items ?? {})).toHaveLength(2)
      // A period spanning both brings both, in order.
      expect(reportData(a, D24, D25).closings.map((c) => c.before === null)).toEqual([true, false])
    }
  })

  it('the close on the 25th of a new table is a check, even if another one closed on the 24th', () => {
    const a1 = chargedOrder(10_000, D24)
    const b1 = chargedOrder(15_000, D25)
    for (const a of applyToBoth([...a1.events, ...b1.events])) {
      expect(salesOf(a, D24).sales.checks).toBe(1)
      expect(salesOf(a, D25).sales).toMatchObject({ checks: 1, net: 15_000 })
    }
  })
})

describe('period: payments, voids and refunds', () => {
  it('a void today of a payment from yesterday subtracts today and not yesterday, with the original payment method', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 25_000 })
    const payment = cardPaymentData(25_000, { tip: 2_000 })
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      event(id, 'PaymentRecorded', payment, { business_day: D23 }),
      event(
        id,
        'PaymentVoided',
        { payment_id: payment.payment_id, register_shift_id: SHIFT },
        { reason: 'm', business_day: D24 },
      ),
    ]
    for (const a of applyToBoth(events)) {
      const today = report({ ...reportData(a, D24, D24), config: CONFIG })
      expect(today.byMethod).toEqual([
        { method: 'card', customMethodId: null, sale: -25_000, tip: -2_000, payments: -1 },
      ])
      const yesterday = report({ ...reportData(a, D23, D23), config: CONFIG })
      expect(yesterday.byMethod).toEqual([
        { method: 'card', customMethodId: null, sale: 25_000, tip: 2_000, payments: 1 },
      ])
      // Both days together offset each other: nothing is left.
      expect(report({ ...reportData(a, D23, D24), config: CONFIG }).byMethod).toEqual([])
      // A separate day sees neither the payment nor the void.
      expect(reportData(a, D25, D25).events).toEqual([])
    }
  })

  it('a partial refund of a payment from another day subtracts on that day and its original payment is not counted twice', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 40_000 })
    const payment = cashPaymentData(40_000, { tip: 4_000 })
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      event(id, 'PaymentRecorded', payment, { business_day: D23 }),
      event(
        id,
        'RefundRecorded',
        {
          payment_id: payment.payment_id,
          refund_id: newId(),
          sale_amount: 10_000,
          tip_amount: 1_000,
          method: 'cash',
          register_shift_id: SHIFT,
        },
        { reason: 'm', business_day: D25 },
      ),
    ]
    for (const a of applyToBoth(events)) {
      const d = reportData(a, D25, D25)
      expect(d.events.map((e) => e.type)).toEqual(['PaymentRecorded', 'RefundRecorded'])
      const r = report({ ...d, config: CONFIG })
      expect(r.byMethod).toEqual([
        { method: 'cash', customMethodId: null, sale: -10_000, tip: -1_000, payments: 0 },
      ])
      expect(r.tipPool.tips).toBe(-1_000)
    }
  })

  it('a payment on a table that closes another day counts by method on the payment day and in sales on the close day', () => {
    const x = chargedOrder(50_000, D25, D24)
    for (const a of applyToBoth(x.events)) {
      const d24 = report({ ...reportData(a, D24, D24), config: CONFIG })
      const d25 = report({ ...reportData(a, D25, D25), config: CONFIG })
      expect(d24.sales.net).toBe(0)
      expect(d24.byMethod).toEqual([expect.objectContaining({ method: 'cash', sale: 50_000 })])
      expect(d25.sales.net).toBe(50_000)
      expect(d25.byMethod).toEqual([])
    }
  })

  it('a period without events gives a report of zeros', () => {
    for (const a of applyToBoth([])) {
      const r = report({ ...reportData(a, D24, D24), config: CONFIG })
      expect(r.sales).toMatchObject({ net: 0, checks: 0, averageTicket: 0 })
      expect(r.byMethod).toEqual([])
      expect(reportData(a, D24, D24).registerClosings).toEqual([])
    }
  })
})

describe('period: shifts that span days', () => {
  /** A shift opened on the 24th, closed on the 25th, with a payment per day and one from the 23rd. */
  function shift() {
    const t = newId()
    const c = (type: string, data: unknown, day: string) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'register_shift',
      aggregate_id: t,
      related: [],
      data,
      session_id: null,
      user_id: WAITER,
      device_id: newId(),
      authorization_id: null,
      reason: null,
      device_time: '2026-10-24T20:00:00.000Z',
      hub_estimated_time: '2026-10-24T20:00:00.000Z',
      base_sequence: 0,
      received_at: '2026-10-24T20:00:00.000Z',
      business_day: day,
      assignments: {},
      affects: [],
      authorized_by_id: null,
      sequence: 0,
    })
    const cashCount = newId()
    const a = chargedOrder(10_000, D24)
    const b = chargedOrder(20_000, D25)
    const pa = { ...a.payment, register_shift_id: t }
    const pb = { ...b.payment, register_shift_id: t }
    const events = [
      c('ShiftOpened', { register_id: newId(), base: 50_000 }, D24),
      event(a.id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
      event(a.id, 'ItemAdded', a.item),
      event(a.id, 'PaymentRecorded', pa, { business_day: D24 }),
      event(a.id, 'OrderClosed', {}, { business_day: D24 }),
      event(b.id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
      event(b.id, 'ItemAdded', b.item),
      event(b.id, 'PaymentRecorded', pb, { business_day: D25 }),
      event(b.id, 'OrderClosed', {}, { business_day: D25 }),
      c(
        'CashCountRecorded',
        { cash_count_id: cashCount, tally: [{ value: 1_000, quantity: 80 }], counted_cash: 80_000 },
        D25,
      ),
      c(
        'ShiftClosed',
        {
          cash_count_id: cashCount,
          expected_cash: 80_000,
          counted_cash: 80_000,
          variance: 0,
          justification: null,
          other_methods: [],
        },
        D25,
      ),
    ] as unknown as OrderEvent[]
    return { t, events }
  }

  it('the close is listed on the day it closes and knows the day it opened', () => {
    const { t, events } = shift()
    for (const a of applyToBoth(events)) {
      expect(reportData(a, D24, D24).registerClosings).toEqual([])
      const [closeout] = reportData(a, D25, D25).registerClosings
      expect(closeout).toMatchObject({ businessDay: D25, openingDay: D24 })
      expect(closeout?.reconciliation.cash).toMatchObject({ charged: 30_000, expected: 80_000 })
      expect(shiftClose(a, t)?.openingDay).toBe(D24)
      expect(reportData(a, D24, D25).registerClosings).toHaveLength(1)
    }
  })

  it('the reconciliation counts the charges from both days of the shift', () => {
    const { t, events } = shift()
    for (const a of applyToBoth(events)) {
      expect(savedReconciliation(a, t)?.cash.charged).toBe(30_000)
      expect(a.shiftCharges(t, D24)).toHaveLength(2)
      // Charges before the opening are not part of this shift.
      expect(a.shiftCharges(t, D25)).toHaveLength(1)
      expect(a.shiftCharges(t, D26)).toHaveLength(0)
    }
  })
})

describe('period: item voids that are later merged or moved to another table', () => {
  const voidItem = (id: string, itemId: string, quantity: number) =>
    event(
      id,
      'ItemVoided',
      { item_id: itemId, quantity, already_prepared: true, ticket_id: null },
      { reason: 'Se cayó' },
    )

  it('after merging the tables the void keeps its product and its value, end to end', () => {
    const source = newId()
    const target = newId()
    const item = itemCopy({ unit_price: 12_000, quantity: 3, name: 'Limonada' })
    const events = [
      open(source),
      open(target),
      event(source, 'ItemAdded', item),
      send(source, item.item_id),
      voidItem(source, item.item_id, 2),
      event(
        target,
        'OrdersMerged',
        {
          source_order_id: source,
          items: [{ item, status: 'sent', voided_quantity: 2, added_by: WAITER }],
        },
        { related: [source] },
      ),
    ]
    for (const a of applyToBoth(events)) {
      const r = report({ ...reportData(a, D24, D24), config: CONFIG })
      expect(r.voids).toEqual([
        expect.objectContaining({ name: 'Limonada', units: 2, value: 24_000 }),
      ])
    }
  })

  it('after moving the item to another table the void keeps its product and its value', () => {
    const source = newId()
    const target = newId()
    const item = itemCopy({ unit_price: 9_000, quantity: 2, name: 'Cerveza' })
    const events = [
      open(source),
      open(target),
      event(source, 'ItemAdded', item),
      send(source, item.item_id),
      voidItem(source, item.item_id, 1),
      event(
        source,
        'ItemsMoved',
        {
          target_order_id: target,
          items: [{ item, status: 'sent', voided_quantity: 1, added_by: WAITER }],
        },
        { related: [target] },
      ),
    ]
    for (const a of applyToBoth(events)) {
      const r = report({ ...reportData(a, D24, D24), config: CONFIG })
      expect(r.voids).toEqual([
        expect.objectContaining({ name: 'Cerveza', units: 1, value: 9_000, orderId: source }),
      ])
    }
  })

  it('two voids of the same item each with the price it had, and one from another order does not mix in', () => {
    const id = newId()
    const other = newId()
    const item = itemCopy({ unit_price: 5_000, quantity: 4 })
    const otherItem = itemCopy({ unit_price: 7_000, quantity: 1, name: 'Otra cosa' })
    const events = [
      open(id),
      open(other),
      event(id, 'ItemAdded', item),
      event(other, 'ItemAdded', otherItem),
      send(id, item.item_id),
      send(other, otherItem.item_id),
      voidItem(id, item.item_id, 1),
      voidItem(other, otherItem.item_id, 1),
      voidItem(id, item.item_id, 2),
    ]
    for (const a of applyToBoth(events)) {
      const r = report({ ...reportData(a, D24, D24), config: CONFIG })
      expect(r.voids.map((x) => [x.orderId === id, x.units, x.value])).toEqual([
        [true, 1, 5_000],
        [false, 1, 7_000],
        [true, 2, 10_000],
      ])
    }
  })
})
