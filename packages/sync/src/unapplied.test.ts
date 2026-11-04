import {
  aggregateOf,
  alerts,
  newId,
  type OrderEvent,
  report,
  type ShiftReconciliation,
} from '@pos/core'
import { describe, expect, it } from 'vitest'
import { withoutAcceptance } from './device/store'
import { type ConfigHub, HubSync } from './hub/hub'
import { MemoryStore } from './hub/store'
import { SqliteStore } from './hub/store-sqlite'
import { openAccess } from './testing/access'
import type { NetNode } from './testing/network'
import { eventsOf, item, NOW, openOrder, type Setup, seeTheSame, setup } from './testing/setup'

// Money saved as a conflict (task 1.7b, docs/SYNC.md#rechazos-cuarentena-y-conflictos): the hub
// marks what its order does not apply (`unapplied`), the mark travels and survives a restart, and
// the register, the reports and the alerts leave that money apart. An event saved before the mark
// counts exactly as it did.

const DAY = '2026-10-24'
const CONFIG = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const

const connectionOf = (m: Setup, node: NetNode) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`No token for ${node.name}`)
  return connection
}

const cardPayment = (shift: string, amount: number) => ({
  payment_id: newId(),
  check_id: null,
  register_shift_id: shift,
  method: 'card' as const,
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
    approval_code: null,
    receipt: null,
  },
  charge_reference: null,
})

/** Cash with no rounding (a partial payment, or a balance already round). */
const cashPayment = (shift: string, amount: number, tip = 0) => ({
  payment_id: newId(),
  check_id: null,
  register_shift_id: shift,
  method: 'cash' as const,
  amount,
  tip,
  tendered: amount + tip,
  change: 0,
  rounding_adjustment: 0,
  rounding: null,
  cardTerminal: null,
  charge_reference: null,
})

const hubConfig = (m: Setup, extra: Partial<ConfigHub> = {}): ConfigHub => ({
  restaurantId: m.restaurantId,
  timeZone: 'America/Bogota',
  businessDayStart: '06:00',
  access: openAccess,
  instance: 'hub-1',
  clock: m.network.isoTime,
  ...extra,
})

/** The hub saves what the old hub saved: the same event, without the verdict (before 1.7b). */
class OldHubStore extends SqliteStore {
  override saveEvent(e: OrderEvent, fingerprint: string, aggregates: readonly string[]) {
    const { unapplied: _u, ...before } = e
    super.saveEvent(before as OrderEvent, fingerprint, aggregates)
  }
}

/** The day's report and alerts as the hub and the panel compute them. */
function dayOf(hub: HubSync, store: { aggregateEvents(id: string): OrderEvent[] }) {
  const r = report({ ...hub.reportData(DAY, DAY), config: CONFIG })
  const orders = new Map<string, OrderEvent[]>()
  for (const id of [
    ...r.voids.map((v) => v.orderId),
    ...r.cancellations.map((c) => c.orderId),
    ...r.unapplied.map((u) => u.orderId),
  ])
    orders.set(id, store.aggregateEvents(id))
  const list = alerts({
    day: DAY,
    voids: r.voids,
    cancellations: r.cancellations,
    orders,
    registerClosings: [],
    threshold: 1_000,
    unapplied: r.unapplied,
  })
  return { r, list }
}

/**
 * Two registers on one hub, sending straight to it: A charges and closes an order; B, which did not
 * know (`stale`), sends money to it afterwards.
 */
function registers(m: Setup, hub = m.hub()) {
  const a = m.network.device('a')
  const b = m.network.device('b')
  const raw = (
    node: NetNode,
    type: string,
    aggregate: string,
    data: unknown,
    extras: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: aggregateOf(type as never),
    aggregate_id: aggregate,
    related: [],
    data,
    session_id: null,
    user_id: node.userId,
    device_id: node.deviceId,
    authorization_id: null,
    reason: ['PaymentVoided', 'RefundRecorded', 'ItemVoided', 'OrderCanceled'].includes(type)
      ? 'Prueba'
      : null,
    device_time: NOW,
    hub_estimated_time: NOW,
    base_sequence: m.store.maxSequence(),
    ...extras,
  })
  const one = (node: NetNode, event: Record<string, unknown>, target = hub) => {
    const r = target.receiveBatch(connectionOf(m, node), [event])
    return { result: r.results[0], accepted: r.acceptedEvents[0], event }
  }
  const shiftA = newId()
  const shiftB = newId()
  one(a, raw(a, 'ShiftOpened', shiftA, { register_id: a.deviceId, base: 100_000 }))
  one(b, raw(b, 'ShiftOpened', shiftB, { register_id: b.deviceId, base: 100_000 }))
  /** An order with one item sent to the kitchen. */
  const order = (price = 40_900) => {
    const id = newId()
    const it = item(price)
    one(a, raw(a, 'OrderOpened', id, { channel: 'dine_in', table_id: newId(), guests: 2 }))
    one(a, raw(a, 'ItemAdded', id, it))
    one(
      a,
      raw(a, 'ItemsSent', id, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
      }),
    )
    return { id, itemId: it.item_id }
  }
  return { a, b, raw, one, shiftA, shiftB, order }
}

describe('two registers: B charges an order A already closed (task 1.7b)', () => {
  it('confirmed as not applied, broadcast with the mark, outside the expected cash; the close needs a justification', async () => {
    const m = setup()
    const a = m.network.device('a')
    const b = m.network.device('b')
    const waiter = m.network.device('waiter')
    await m.network.connectAll()
    const shiftA = newId()
    const shiftB = newId()
    const asShift = { aggregate_type: 'register_shift' } as const
    await a.create(shiftA, 'ShiftOpened', { register_id: a.deviceId, base: 100_000 }, asShift)
    await b.create(shiftB, 'ShiftOpened', { register_id: b.deviceId, base: 100_000 }, asShift)
    const order = await openOrder(waiter)
    await waiter.create(order, 'ItemAdded', item(40_900))
    await m.network.settle()

    // B goes offline; meanwhile A charges by card and closes the table.
    b.disconnect()
    await a.create(order, 'PaymentRecorded', cardPayment(shiftA, 40_900))
    await a.create(order, 'OrderClosed', {})
    await m.network.settle()
    // B, which did not know, charges the same table in cash (with a tip) and reconnects.
    const late = await b.create(order, 'PaymentRecorded', cashPayment(shiftB, 40_000, 900))
    await b.connect()
    await m.network.settle()

    const saved = m.store.byId(late.id)?.event
    expect(saved?.unapplied).toBe(true)
    expect(m.hub().conflicts()).toEqual([
      expect.objectContaining({ eventId: late.id, type: 'order_closed' }),
    ])
    // B has it confirmed with the mark, and was told once; nobody else was told.
    const own = await b.store.get(late.id)
    expect(own).toMatchObject({ status: 'confirmed', conflict: 'order_closed' })
    expect(own?.event.unapplied).toBe(true)
    expect(b.unapplied.map((l) => l.event.id)).toEqual([late.id])
    expect(a.unapplied).toEqual([])
    expect(waiter.unapplied).toEqual([])
    // The third device received it with the mark too.
    expect((await waiter.store.get(late.id))?.event.unapplied).toBe(true)
    await seeTheSame(m.hub(), eventsOf(m), [a, b, waiter], [order])
    expect(Object.keys(m.hub().order(order)?.payments ?? {})).toHaveLength(1)

    // B's register: the payment is apart, not in the cash nor in the methods.
    const open = m.hub().reconciliation(shiftB) as ShiftReconciliation
    expect(open.cash).toEqual({
      charged: 0,
      refunds: 0,
      cashIn: 0,
      cashOut: 0,
      tipPayouts: 0,
      expected: 100_000,
    })
    expect(open.byMethod).toEqual([])
    expect(open.unapplied).toEqual([
      {
        eventId: late.id,
        orderId: order,
        type: 'PaymentRecorded',
        method: 'cash',
        customMethodId: null,
        amount: 40_900,
        tip: 900,
        userId: b.userId,
        time: saved?.received_at,
      },
    ])
    expect(m.hub().reconciliation(shiftA)?.unapplied).toEqual([])
    expect(m.hub().reconciliation(shiftA)?.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 40_900, tip: 0, payments: 1 },
    ])

    // After a restart the mark is still there and the reconciliation is the same.
    const restarted = new HubSync(new SqliteStore(m.db, m.restaurantId), hubConfig(m))
    expect(restarted.reconciliation(shiftB)).toEqual(open)
    expect(restarted.order(order)).toEqual(m.hub().order(order))

    // Closing B: without a justification it is rejected; with one, accepted.
    const cashCount = newId()
    await b.create(
      shiftB,
      'CashCountRecorded',
      { cash_count_id: cashCount, tally: [{ value: 1_000, quantity: 100 }], counted_cash: 100_000 },
      asShift,
    )
    const closeData = (justification: string | null) => ({
      cash_count_id: cashCount,
      expected_cash: 100_000,
      counted_cash: 100_000,
      variance: 0,
      justification,
      other_methods: [],
    })
    const bare = await b.create(shiftB, 'ShiftClosed', closeData(null), asShift)
    await m.network.settle()
    expect(await b.store.get(bare.id)).toMatchObject({
      status: 'rejected',
      reason: 'missing_justification',
    })
    const justified = await b.create(
      shiftB,
      'ShiftClosed',
      closeData('Cobré una mesa ya cerrada: devolví el efectivo'),
      asShift,
    )
    await m.network.settle()
    expect((await b.store.get(justified.id))?.status).toBe('confirmed')
    const closed = m.hub().reconciliation(shiftB)
    expect(closed?.unapplied).toEqual(open.unapplied)
    expect(closed?.cash).toEqual(open.cash)
    expect(closed?.closed).toMatchObject({ expected: 100_000, variance: 0 })
    // A closed shift is read from the database: also the same after another restart.
    const again = new HubSync(new SqliteStore(m.db, m.restaurantId), hubConfig(m))
    expect(again.reconciliation(shiftB)).toEqual(closed)
    expect(again.shiftClose(shiftB)?.reconciliation).toEqual(closed)
  })

  it('the hub restored from a backup judges again: the resend carries no mark and the verdict can change', async () => {
    const m = setup({ store: 'memory' })
    const a = m.network.device('a')
    const b = m.network.device('b')
    await m.network.connectAll()
    const shiftA = newId()
    const shiftB = newId()
    const asShift = { aggregate_type: 'register_shift' } as const
    await a.create(shiftA, 'ShiftOpened', { register_id: a.deviceId, base: 100_000 }, asShift)
    await b.create(shiftB, 'ShiftOpened', { register_id: b.deviceId, base: 100_000 }, asShift)
    const order = await openOrder(a)
    await a.create(order, 'ItemAdded', item(40_900))
    await m.network.settle()
    const backup = structuredClone((m.store as MemoryStore).events)

    b.disconnect()
    await a.create(order, 'PaymentRecorded', cardPayment(shiftA, 40_900))
    await a.create(order, 'OrderClosed', {})
    await m.network.settle()
    const late = await b.create(order, 'PaymentRecorded', cashPayment(shiftB, 40_000, 900))
    await b.connect()
    await m.network.settle()
    expect((await b.store.get(late.id))?.event.unapplied).toBe(true)

    // The backup (before A charged) on a reinstalled hub. B reconnects first: its payment now
    // applies, so it is saved without the mark; A's payment no longer fits the balance.
    for (const node of m.network.nodes) node.disconnect()
    const restored = new MemoryStore()
    restored.events = backup
    m.status.instance = 'hub-2'
    m.network.floor = m.createFloor(restored)
    const pushed: unknown[] = []
    const original = m.network.floor.connect.bind(m.network.floor)
    m.network.floor.connect = (send) => {
      const link = original(send)
      return {
        ...link,
        receive: (raw: unknown) => {
          const message = raw as { type?: string; events?: unknown[] }
          if (message.type === 'push') pushed.push(...(message.events ?? []))
          link.receive(raw)
        },
      }
    }
    await b.connect()
    await m.network.settle()
    await a.connect()
    await m.network.settle()

    const resent = pushed.find((e) => (e as { id: string }).id === late.id)
    expect(resent).toBeDefined()
    expect(resent).not.toHaveProperty('unapplied')
    expect(restored.byId(late.id)?.event).not.toHaveProperty('unapplied')
    const own = await b.store.get(late.id)
    expect(own?.status).toBe('confirmed')
    expect(own?.event).not.toHaveProperty('unapplied')
    expect(Object.keys(m.hub().order(order)?.payments ?? {})).toEqual([
      (late.data as { payment_id: string }).payment_id,
    ])
    expect(m.hub().reconciliation(shiftB)?.unapplied).toEqual([])
    expect(m.hub().reconciliation(shiftB)?.cash.charged).toBe(40_900)
    // It was told once, back when it was not applied.
    expect(b.unapplied).toHaveLength(1)
  })
})

describe('the hub keeps the verdict its own', () => {
  it('withoutAcceptance drops the mark with the other hub fields', () => {
    const m = setup()
    const { a, b, raw, one, shiftA, shiftB, order } = registers(m)
    const o = order()
    const stale = m.store.maxSequence()
    one(a, raw(a, 'PaymentRecorded', o.id, cardPayment(shiftA, 40_900)))
    one(a, raw(a, 'OrderClosed', o.id, {}))
    const late = one(
      b,
      raw(b, 'PaymentRecorded', o.id, cashPayment(shiftB, 1_000), { base_sequence: stale }),
    )
    expect(late.accepted?.unapplied).toBe(true)
    const fresh = withoutAcceptance(late.accepted as OrderEvent)
    expect(fresh).not.toHaveProperty('unapplied')
    expect(fresh).not.toHaveProperty('sequence')
    expect(fresh).toEqual(late.event)
  })

  it('a mark sent by a device is dropped: the same event is recognized, a new one is judged by the hub', () => {
    const m = setup()
    const { b, raw, one, order } = registers(m)
    const o = order()
    // A brand new event that applies, sent with a mark (an app cached from before): saved without
    // it, and it changes the order.
    const withMark = raw(b, 'GuestsChanged', o.id, { guests: 5 }, { unapplied: true })
    const r = one(b, withMark)
    expect(r.result).toMatchObject({ status: 'confirmed' })
    expect(r.result && 'acceptance' in r.result ? r.result.acceptance : null).not.toHaveProperty(
      'unapplied',
    )
    expect(m.store.byId(withMark.id as string)?.event).not.toHaveProperty('unapplied')
    expect(m.hub().order(o.id)?.guests).toBe(5)
    // Resending it with the mark is the same event (same fingerprint), not a duplicate id.
    expect(one(b, withMark).result).toEqual(r.result)
  })

  it('a resend of an event saved as not applied, with its mark, gets the same answer', () => {
    const m = setup()
    const { a, b, raw, one, shiftA, shiftB, order } = registers(m)
    const o = order()
    const stale = m.store.maxSequence()
    one(a, raw(a, 'PaymentRecorded', o.id, cardPayment(shiftA, 40_900)))
    one(a, raw(a, 'OrderClosed', o.id, {}))
    const sent = raw(b, 'PaymentRecorded', o.id, cashPayment(shiftB, 1_000), {
      base_sequence: stale,
    })
    const first = one(b, sent)
    expect(first.result).toMatchObject({
      status: 'confirmed',
      conflict: 'order_closed',
      acceptance: { unapplied: true },
    })
    const max = m.store.maxSequence()
    expect(one(b, { ...sent, unapplied: true }).result).toEqual(first.result)
    expect(one(b, sent).result).toEqual(first.result)
    expect(m.store.maxSequence()).toBe(max)
  })
})

describe.each(['sqlite', 'memory'] as const)('money in conflict, store %s', (kind) => {
  it('a card payment, a voided payment and a refund on a closed order: apart, with method and sign', () => {
    const m = setup({ store: kind })
    const { a, b, raw, one, shiftA, shiftB, order } = registers(m)
    const o = order()
    const stale = m.store.maxSequence()
    const paid = cardPayment(shiftA, 40_900)
    one(a, raw(a, 'PaymentRecorded', o.id, paid))
    one(a, raw(a, 'OrderClosed', o.id, {}))
    const old = { base_sequence: stale }
    const late = [
      one(b, raw(b, 'PaymentRecorded', o.id, cardPayment(shiftB, 10_000), old)),
      one(
        b,
        raw(
          b,
          'PaymentVoided',
          o.id,
          { payment_id: paid.payment_id, register_shift_id: shiftB },
          old,
        ),
      ),
      one(
        b,
        raw(
          b,
          'RefundRecorded',
          o.id,
          {
            payment_id: paid.payment_id,
            refund_id: newId(),
            sale_amount: 1_000,
            tip_amount: 0,
            method: 'card',
            register_shift_id: shiftB,
          },
          old,
        ),
      ),
    ]
    for (const l of late) {
      expect(l.result).toMatchObject({
        status: 'confirmed',
        conflict: 'order_closed',
        acceptance: { unapplied: true },
      })
      expect(m.store.byId(l.event.id as string)?.event.unapplied).toBe(true)
    }
    const ids = late.map((l) => l.event.id)

    const rB = m.hub().reconciliation(shiftB) as ShiftReconciliation
    expect(rB.byMethod).toEqual([])
    expect(rB.cash.expected).toBe(100_000)
    expect(rB.unapplied.map((u) => [u.eventId, u.type, u.method, u.amount, u.tip])).toEqual([
      [ids[0], 'PaymentRecorded', 'card', 10_000, 0],
      [ids[1], 'PaymentVoided', 'card', -40_900, 0],
      [ids[2], 'RefundRecorded', 'card', -1_000, 0],
    ])
    expect(m.hub().reconciliation(shiftA)?.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 40_900, tip: 0, payments: 1 },
    ])
    expect(m.hub().order(o.id)?.payments[paid.payment_id]).toMatchObject({
      voided: false,
      refundedSale: 0,
    })

    // The day's report and the owner's alerts: the money apart, one alert each, no void alert.
    const { r, list } = dayOf(m.hub(), m.store)
    expect(r.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 40_900, tip: 0, payments: 1 },
    ])
    expect(r.unapplied.map((u) => u.eventId)).toEqual(ids)
    expect(list.map((x) => x.type)).toEqual(Array(3).fill('unapplied_money'))
    expect(
      list
        .map((x) => (x.type === 'unapplied_money' ? [x.id, x.kind, x.value, x.method] : null))
        .sort(),
    ).toEqual(
      [
        [ids[0], 'PaymentRecorded', 10_000, 'card'],
        [ids[1], 'PaymentVoided', -40_900, 'card'],
        [ids[2], 'RefundRecorded', -1_000, 'card'],
      ].sort(),
    )
  })

  it('a cash payment and a cash void in conflict do not move the expected cash', () => {
    const m = setup({ store: kind })
    const { a, b, raw, one, shiftA, shiftB, order } = registers(m)
    const o = order(41_000)
    const stale = m.store.maxSequence()
    const paid = cashPayment(shiftA, 41_000, 2_000)
    one(a, raw(a, 'PaymentRecorded', o.id, paid))
    one(a, raw(a, 'OrderClosed', o.id, {}))
    const old = { base_sequence: stale }
    const charged = one(b, raw(b, 'PaymentRecorded', o.id, cashPayment(shiftB, 5_000, 500), old))
    const voided = one(
      b,
      raw(
        b,
        'PaymentVoided',
        o.id,
        { payment_id: paid.payment_id, register_shift_id: shiftB },
        old,
      ),
    )
    const rB = m.hub().reconciliation(shiftB) as ShiftReconciliation
    expect(rB.cash).toMatchObject({ charged: 0, refunds: 0, expected: 100_000 })
    expect(rB.unapplied).toMatchObject([
      { eventId: charged.event.id, method: 'cash', amount: 5_500, tip: 500 },
      { eventId: voided.event.id, method: 'cash', amount: -43_000, tip: -2_000 },
    ])
    expect(m.hub().reconciliation(shiftA)?.cash).toMatchObject({
      charged: 43_000,
      refunds: 0,
      expected: 143_000,
    })
    const { r } = dayOf(m.hub(), m.store)
    expect(r.tipPool.tips).toBe(2_000)
  })

  it('a cash payment with a −$50 rounding and a $4.000 tip is apart in full, and so is its void from another shift', () => {
    const m = setup({ store: kind })
    const { a, b, raw, one, shiftA, shiftB, order } = registers(m)
    const o = order(44_950)
    const stale = m.store.maxSequence()
    const rounded = (shift: string) => ({
      ...cashPayment(shift, 44_950, 4_000),
      rounding_adjustment: -50,
      rounding: { multiple: 100, mode: 'down' as const },
      tendered: 50_000,
      change: 1_100,
    })
    const paid = rounded(shiftA)
    expect(one(a, raw(a, 'PaymentRecorded', o.id, paid)).result).toMatchObject({
      status: 'confirmed',
    })
    one(a, raw(a, 'OrderClosed', o.id, {}))
    const before = [shiftA, shiftB].map((s) => m.hub().reconciliation(s)?.cash)
    expect(before[0]).toMatchObject({ charged: 48_900, refunds: 0, expected: 148_900 })

    const old = { base_sequence: stale }
    const charged = one(b, raw(b, 'PaymentRecorded', o.id, rounded(shiftB), old))
    const voided = one(
      b,
      raw(
        b,
        'PaymentVoided',
        o.id,
        { payment_id: paid.payment_id, register_shift_id: shiftB },
        old,
      ),
    )
    for (const l of [charged, voided])
      expect(l.result).toMatchObject({ conflict: 'order_closed', acceptance: { unapplied: true } })

    // Charged with the adjustment and the tip: +$48.900; its void, recorded in B: −$48.900.
    const rB = m.hub().reconciliation(shiftB) as ShiftReconciliation
    expect(rB.unapplied).toMatchObject([
      { eventId: charged.event.id, type: 'PaymentRecorded', method: 'cash', amount: 48_900 },
      { eventId: voided.event.id, type: 'PaymentVoided', method: 'cash', amount: -48_900 },
    ])
    expect(rB.unapplied.map((u) => u.tip)).toEqual([4_000, -4_000])
    expect(m.hub().reconciliation(shiftA)?.unapplied).toEqual([])
    // Neither shift's expected cash moved.
    expect([shiftA, shiftB].map((s) => m.hub().reconciliation(s)?.cash)).toEqual(before)
    const { r } = dayOf(m.hub(), m.store)
    expect(r.unapplied.map((u) => u.amount)).toEqual([48_900, -48_900])
    expect(r.tipPool.tips).toBe(4_000)
  })

  it('a count made before money the hub did not apply is still current: the close with a justification is accepted', () => {
    const m = setup({ store: kind })
    const { a, b, raw, one, shiftA, shiftB, order } = registers(m)
    const o = order()
    const stale = m.store.maxSequence()
    const paid = cashPayment(shiftA, 40_900)
    one(a, raw(a, 'PaymentRecorded', o.id, paid))
    one(a, raw(a, 'OrderClosed', o.id, {}))
    const cashCount = newId()
    one(
      b,
      raw(b, 'CashCountRecorded', shiftB, {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: 100 }],
        counted_cash: 100_000,
      }),
    )
    // After the count: a cash payment and the void of A's payment (which brings that payment into
    // B's shift), both saved without applying.
    const old = { base_sequence: stale }
    const late = [
      one(b, raw(b, 'PaymentRecorded', o.id, cashPayment(shiftB, 5_000), old)),
      one(
        b,
        raw(
          b,
          'PaymentVoided',
          o.id,
          { payment_id: paid.payment_id, register_shift_id: shiftB },
          old,
        ),
      ),
    ]
    for (const l of late) expect(l.accepted?.unapplied).toBe(true)
    const close = (justification: string | null) =>
      one(
        b,
        raw(b, 'ShiftClosed', shiftB, {
          cash_count_id: cashCount,
          expected_cash: 100_000,
          counted_cash: 100_000,
          variance: 0,
          justification,
          other_methods: [],
        }),
      ).result
    expect(close(null)).toMatchObject({ status: 'rejected', reason: 'missing_justification' })
    expect(close('Cobré una mesa ya cerrada: devolví el efectivo')).toMatchObject({
      status: 'confirmed',
    })
  })

  it('a second void of the same item and a cancellation or close of a closed order count once', () => {
    const m = setup({ store: kind })
    const { a, b, raw, one, shiftA, order } = registers(m)
    const voidOf = (node: NetNode, o: { id: string; itemId: string }, extras = {}) =>
      raw(
        node,
        'ItemVoided',
        o.id,
        { item_id: o.itemId, quantity: 1, already_prepared: false, ticket_id: null },
        extras,
      )
    const first = order(12_000)
    const stale = m.store.maxSequence()
    const applied = one(a, voidOf(a, first))
    const twice = one(b, voidOf(b, first, { base_sequence: stale }))
    expect(twice.result).toMatchObject({ conflict: 'item_already_voided' })
    expect(twice.accepted?.unapplied).toBe(true)

    const second = order(40_900)
    const before = m.store.maxSequence()
    one(a, raw(a, 'PaymentRecorded', second.id, cardPayment(shiftA, 40_900)))
    one(a, raw(a, 'OrderClosed', second.id, {}))
    const canceled = one(b, raw(b, 'OrderCanceled', second.id, {}, { base_sequence: before }))
    const closedAgain = one(b, raw(b, 'OrderClosed', second.id, {}, { base_sequence: before }))
    for (const l of [canceled, closedAgain]) {
      expect(l.result).toMatchObject({ conflict: 'order_closed', acceptance: { unapplied: true } })
    }

    const data = m.hub().reportData(DAY, DAY)
    expect(data.closings).toHaveLength(1)
    const { r, list } = dayOf(m.hub(), m.store)
    expect(r.voids.map((v) => v.eventId)).toEqual([applied.event.id])
    expect(r.cancellations).toEqual([])
    expect(r.sales).toMatchObject({ net: 40_900, checks: 1, guests: 2 })
    // Product voids and cancellations are not money: no alert of their own.
    expect(r.unapplied).toEqual([])
    expect(list.map((x) => x.id)).toEqual([applied.event.id])
  })

  it('a duplicate table and a price that does not match the catalog are applied: no mark, they count', () => {
    const m = setup({ store: kind })
    const hub = new HubSync(
      m.store,
      hubConfig(m, {
        prices: {
          review: (e) =>
            e.type === 'ItemAdded' && e.data.unit_price === 1 ? 'No coincide con la carta' : null,
        },
      }),
    )
    const { a, b, raw, one, shiftB } = registers(m, hub)
    const table = newId()
    const stale = m.store.maxSequence()
    const first = newId()
    one(a, raw(a, 'OrderOpened', first, { channel: 'dine_in', table_id: table, guests: 2 }))
    const other = newId()
    const duplicate = one(
      b,
      raw(
        b,
        'OrderOpened',
        other,
        { channel: 'dine_in', table_id: table, guests: 2 },
        { base_sequence: stale },
      ),
    )
    expect(duplicate.result).toMatchObject({ conflict: 'duplicate_table' })
    expect(duplicate.accepted).not.toHaveProperty('unapplied')
    const cheap = one(b, raw(b, 'ItemAdded', other, item(1)))
    expect(cheap.result).toMatchObject({ conflict: 'price_mismatch' })
    expect(cheap.accepted).not.toHaveProperty('unapplied')
    one(b, raw(b, 'PaymentRecorded', other, cashPayment(shiftB, 1)))
    one(b, raw(b, 'OrderClosed', other, {}))
    const { r } = dayOf(hub, m.store)
    expect(r.sales.net).toBe(1)
    expect(hub.reconciliation(shiftB)?.cash.charged).toBe(1)
    expect(r.unapplied).toEqual([])
  })
})

describe('an event saved before the mark counts exactly as before', () => {
  it('a payment on a closed order saved by the previous hub: in the cash and the methods, no alert of its own', () => {
    const m = setup()
    const old = new HubSync(new OldHubStore(m.db, m.restaurantId), hubConfig(m))
    const { a, b, raw, one, shiftA, shiftB, order } = registers(m, old)
    const o = order()
    const stale = m.store.maxSequence()
    one(a, raw(a, 'PaymentRecorded', o.id, cardPayment(shiftA, 40_900)))
    one(a, raw(a, 'OrderClosed', o.id, {}))
    const late = one(
      b,
      raw(b, 'PaymentRecorded', o.id, cashPayment(shiftB, 40_000, 900), { base_sequence: stale }),
    )
    expect(late.result).toMatchObject({ conflict: 'order_closed' })
    // Read back from the database it has no mark: as every event from before 1.7b.
    const saved = m.store.byId(late.event.id as string)?.event
    expect(saved).not.toHaveProperty('unapplied')

    const hub = new HubSync(new SqliteStore(m.db, m.restaurantId), hubConfig(m))
    const rB = hub.reconciliation(shiftB) as ShiftReconciliation
    expect(rB.cash).toMatchObject({ charged: 40_900, expected: 140_900 })
    expect(rB.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 40_000, tip: 900, payments: 1 },
    ])
    expect(rB.unapplied).toEqual([])
    const { r, list } = dayOf(hub, m.store)
    expect(r.unapplied).toEqual([])
    expect(r.tipPool.tips).toBe(900)
    expect(list).toEqual([])
  })
})
