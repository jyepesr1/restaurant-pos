import { aggregateOf, newId, otherMethodsReconciliation } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { HubSync } from './hub/hub'
import { SqliteStore } from './hub/store-sqlite'
import { PAGE_SIZE } from './protocol'
import { openAccess } from './testing/access'
import type { NetNode } from './testing/network'
import { CrashingStore, eventsOf, item, NOW, type Setup, setup } from './testing/setup'

// Cash movements, cash count and register close on the hub (task 1.7, `registerIssue` and
// `HubSync.reconciliation`): no shift or another register's shift, the four close rejections, what
// happens after closing, restarting with a shift half done, and multi-restaurant.

const SODEXO = newId()
const CARD_TERMINAL = newId()
const RULES = {
  multiple: 100,
  mode: 'nearest_half_down',
  methods: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
  customMethods: [SODEXO],
  cardTerminals: [CARD_TERMINAL],
}

const connectionOf = (m: Setup, node: NetNode) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`No token for ${node.name}`)
  return connection
}

const reason = (r: unknown) => {
  const x = r as { status: string; reason?: string }
  return x.status === 'rejected' ? x.reason : x.status
}

function environment(options: { threshold?: number } = {}) {
  const m = setup()
  const register = m.network.device('register')
  const register2 = m.network.device('register2')
  const ana = m.network.device('ana')
  const cfg = { threshold: options.threshold ?? 1000 }
  const newHub = () =>
    new HubSync(m.store, {
      restaurantId: m.restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      access: openAccess,
      instance: 'hub-1',
      clock: m.network.isoTime,
      checkoutRules: () => ({ ...RULES, varianceThreshold: cfg.threshold }),
    })
  const status = { hub: newHub() }

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
    reason: type === 'PaymentVoided' || type === 'RefundRecorded' ? 'Prueba' : null,
    device_time: NOW,
    hub_estimated_time: NOW,
    base_sequence: m.store.maxSequence(),
    ...extras,
  })
  const send = (node: NetNode, events: Record<string, unknown>[], hub = status.hub) =>
    hub.receiveBatch(connectionOf(m, node), events)
  const one = (node: NetNode, event: Record<string, unknown>, hub = status.hub) =>
    send(node, [event], hub).results[0]

  const openShift = (node: NetNode, base = 100_000, shift = newId()) => {
    const result = one(node, raw(node, 'ShiftOpened', shift, { register_id: node.deviceId, base }))
    expect(reason(result)).toBe('confirmed')
    return shift
  }
  const openOrder = (node: NetNode, price = 40_900) => {
    const order = newId()
    one(node, raw(node, 'OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 }))
    one(node, raw(node, 'ItemAdded', order, item(price)))
    return order
  }
  /** Partial cash (the balance does not reach 0): no rounding adjustment. */
  const cashPaymentOf = (shift: string, amount: number, tip = 0) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method: 'cash',
    amount,
    tip,
    tendered: amount + tip,
    change: 0,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
  })
  const nequiPaymentOf = (shift: string, amount: number, tip = 0) => ({
    ...cashPaymentOf(shift, amount, tip),
    method: 'nequi',
    tendered: null,
    change: null,
  })
  const customPaymentOf = (shift: string, amount: number) => ({
    ...nequiPaymentOf(shift, amount),
    method: 'other',
    custom_method_id: SODEXO,
  })
  const charge = (node: NetNode, order: string, data: { payment_id: string }) => {
    const r = one(node, raw(node, 'PaymentRecorded', order, data))
    expect(reason(r)).toBe('confirmed')
    return data.payment_id
  }
  const movement = (
    node: NetNode,
    shift: string,
    type: 'cash_in' | 'cash_out' | 'tip_payout',
    amount: number,
  ) =>
    one(
      node,
      raw(node, 'CashMovementRecorded', shift, {
        movement_id: newId(),
        type,
        amount,
        description: `Prueba ${type}`,
        to_whom: type === 'tip_payout' ? 'Equipo' : null,
        days: type === 'tip_payout' ? ['2026-10-24'] : [],
      }),
    )
  /** The tally of `counted` pesos: $1.000 bills and, if any is left, $1 coins (any amount). */
  const tallyOf = (counted: number) =>
    [
      { value: 1_000, quantity: Math.floor(counted / 1_000) },
      { value: 1, quantity: counted % 1_000 },
    ].filter((c) => c.quantity > 0)
  /** Records a count that adds up to `counted`. */
  const count = (node: NetNode, shift: string, counted: number) => {
    const cashCount = newId()
    const r = one(
      node,
      raw(node, 'CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally: tallyOf(counted),
        counted_cash: counted,
      }),
    )
    return { cashCount, result: r }
  }
  const closeData = (
    cashCount: string,
    expected: number,
    counted: number,
    justification: string | null = null,
  ) => ({
    cash_count_id: cashCount,
    expected_cash: expected,
    counted_cash: counted,
    variance: counted - expected,
    justification,
  })
  // Since 1.8 the close carries the other methods as the hub computes them from the count.
  const othersOf = (shift: string, cashCount: string) => {
    const reconciliation = status.hub.reconciliation(shift)
    const tally = reconciliation?.cashCounts.find((a) => a.id === cashCount)
    return reconciliation && tally
      ? otherMethodsReconciliation(reconciliation, tally).map((o) => ({
          method: o.method,
          custom_method_id: o.customMethodId,
          expected: o.expected,
          reported: o.reported,
          variance: o.variance,
        }))
      : []
  }
  const close = (
    node: NetNode,
    shift: string,
    cashCount: string,
    expected: number,
    counted: number,
    justification: string | null = null,
  ) =>
    one(
      node,
      raw(node, 'ShiftClosed', shift, {
        ...closeData(cashCount, expected, counted, justification),
        other_methods: othersOf(shift, cashCount),
      }),
    )
  const voidItem = (node: NetNode, order: string, paymentId: string, shift: string) =>
    one(
      node,
      raw(node, 'PaymentVoided', order, { payment_id: paymentId, register_shift_id: shift }),
    )

  return {
    m,
    register,
    register2,
    ana,
    cfg,
    status,
    newHub,
    raw,
    send,
    one,
    openShift,
    openOrder,
    cashPaymentOf,
    nequiPaymentOf,
    customPaymentOf,
    charge,
    movement,
    count,
    tallyOf,
    close,
    voidItem,
    closeData,
  }
}

describe('movement, cash count and close: shift and register', () => {
  const three = (e: ReturnType<typeof environment>, node: NetNode, shift: string) => ({
    movement: e.movement(node, shift, 'cash_in', 1_000),
    cashCount: e.count(node, shift, 1_000).result,
    closeout: e.close(node, shift, newId(), 1_000, 1_000),
  })

  it('no shift (made-up id): all three are rejected with no_shift and leave no trace', () => {
    const e = environment()
    const before = e.m.store.maxSequence()
    const r = three(e, e.register, newId())
    expect(reason(r.movement)).toBe('no_shift')
    expect(reason(r.cashCount)).toBe('no_shift')
    expect(reason(r.closeout)).toBe('no_shift')
    expect(e.m.store.maxSequence()).toBe(before)
  })

  it('an order id is not a shift either: no_shift', () => {
    const e = environment()
    e.openShift(e.register)
    const order = e.openOrder(e.register)
    expect(reason(e.movement(e.register, order, 'cash_in', 1_000))).toBe('no_shift')
  })

  it('the shift of ANOTHER register: other_register_shift in all three, and the shift stays intact', () => {
    const e = environment()
    const shift = e.openShift(e.register, 50_000)
    e.openShift(e.register2, 7_000)
    const before = e.m.store.maxSequence()
    const r = three(e, e.register2, shift)
    expect(reason(r.movement)).toBe('other_register_shift')
    expect(reason(r.cashCount)).toBe('other_register_shift')
    expect(reason(r.closeout)).toBe('other_register_shift')
    expect(e.m.store.maxSequence()).toBe(before)
    expect(e.status.hub.openShift(e.register.deviceId)?.id).toBe(shift)
    expect(e.status.hub.reconciliation(shift)?.cash.expected).toBe(50_000)
  })

  it('a device without its own shift (the waiter) cannot move cash in or close the register shift either', () => {
    const e = environment()
    const shift = e.openShift(e.register)
    const r = three(e, e.ana, shift)
    expect(Object.values(r).map(reason)).toEqual([
      'other_register_shift',
      'other_register_shift',
      'other_register_shift',
    ])
  })

  it('the rejection repeats the same if the same event is resent', () => {
    const e = environment()
    const shift = e.openShift(e.register)
    const mov = e.raw(e.register2, 'CashMovementRecorded', shift, {
      movement_id: newId(),
      type: 'cash_in',
      amount: 5,
      description: 'x',
      to_whom: null,
      days: [],
    })
    const a = e.one(e.register2, mov)
    const b = e.one(e.register2, mov)
    expect(reason(a)).toBe('other_register_shift')
    expect(b).toEqual(a)
  })

  it('movements and cash counts of the own shift are accepted and the reconciliation reflects them', () => {
    const e = environment()
    const shift = e.openShift(e.register, 100_000)
    expect(reason(e.movement(e.register, shift, 'cash_in', 20_000))).toBe('confirmed')
    expect(reason(e.movement(e.register, shift, 'cash_out', 5_000))).toBe('confirmed')
    expect(reason(e.movement(e.register, shift, 'tip_payout', 3_000))).toBe('confirmed')
    const firstOne = e.count(e.register, shift, 110_000)
    const secondOne = e.count(e.register, shift, 112_000)
    expect(reason(firstOne.result)).toBe('confirmed')
    expect(reason(secondOne.result)).toBe('confirmed')
    const c = e.status.hub.reconciliation(shift)
    expect(c?.cash).toMatchObject({
      cashIn: 20_000,
      cashOut: 5_000,
      tipPayouts: 3_000,
      expected: 112_000,
    })
    expect(c?.cashCounts.map((a) => a.counted)).toEqual([110_000, 112_000])
    expect(c?.movements.map((x) => x.type)).toEqual(['cash_in', 'cash_out', 'tip_payout'])
  })

  it('the reconciliation time comes from the hub, not from the device clock', () => {
    const e = environment()
    e.register.offsetMs = -3 * 60 * 60 * 1000
    const shift = e.openShift(e.register)
    e.movement(e.register, shift, 'cash_in', 1_000)
    const saved = eventsOf(e.m).find((x) => x.type === 'CashMovementRecorded')
    const c = e.status.hub.reconciliation(shift)
    expect(c?.movements[0]?.time).toBe(saved?.received_at)
    expect(c?.openedAt).toBe(eventsOf(e.m)[0]?.received_at)
  })

  it('a movement with a broken schema (output with to_whom) is rejected before touching the shift', () => {
    const e = environment()
    const shift = e.openShift(e.register)
    const r = e.one(
      e.register,
      e.raw(e.register, 'CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'cash_out',
        amount: 100,
        description: 'x',
        to_whom: 'Ana',
        days: [],
      }),
    )
    expect(reason(r)).toMatch(/^schema:/)
    expect(e.status.hub.reconciliation(shift)?.movements).toEqual([])
  })

  it('reconciliation of a shift that does not exist or is already closed: null', () => {
    const e = environment()
    expect(e.status.hub.reconciliation(newId())).toBeNull()
  })
})

describe('register close: the four rules and the correct close', () => {
  /** Base 100.000, a 30.000 cash charge with a 2.000 tip and a count of 132.000. */
  function shiftCharged(threshold = 1000) {
    const e = environment({ threshold })
    const shift = e.openShift(e.register, 100_000)
    const order = e.openOrder(e.register)
    e.charge(e.register, order, e.cashPaymentOf(shift, 30_000, 2_000))
    return { ...e, shift, order, expected: 132_000 }
  }

  it('cash_count_not_found: closes without having counted', () => {
    const t = shiftCharged()
    expect(reason(t.close(t.register, t.shift, newId(), t.expected, t.expected))).toBe(
      'cash_count_not_found',
    )
    expect(t.status.hub.openShift(t.register.deviceId)).not.toBeNull()
  })

  it('cash_count_not_found: the count belongs to another shift (another register)', () => {
    const t = shiftCharged()
    const shift2 = t.openShift(t.register2, 0)
    const outsider = t.count(t.register2, shift2, 132_000)
    expect(reason(outsider.result)).toBe('confirmed')
    expect(reason(t.close(t.register, t.shift, outsider.cashCount, t.expected, 132_000))).toBe(
      'cash_count_not_found',
    )
  })

  it('cash_count_not_found: the cash count id belongs to a movement', () => {
    const t = shiftCharged()
    const mov = t.raw(t.register, 'CashMovementRecorded', t.shift, {
      movement_id: newId(),
      type: 'cash_in',
      amount: 1_000,
      description: 'x',
      to_whom: null,
      days: [],
    })
    t.one(t.register, mov)
    const id = (mov.data as { movement_id: string }).movement_id
    expect(reason(t.close(t.register, t.shift, id, 133_000, 1_000))).toBe('cash_count_not_found')
  })

  it('counted_mismatch: the close states a different counted amount than the cash count (even if the variance is consistent)', () => {
    const t = shiftCharged()
    const { cashCount } = t.count(t.register, t.shift, 132_000)
    expect(reason(t.close(t.register, t.shift, cashCount, t.expected, 131_000, 'Faltó'))).toBe(
      'counted_mismatch',
    )
    expect(reason(t.close(t.register, t.shift, cashCount, t.expected, 133_000, 'Sobró'))).toBe(
      'counted_mismatch',
    )
  })

  it('expected_mismatch: the close states a different expected amount than the hub', () => {
    const t = shiftCharged()
    const { cashCount } = t.count(t.register, t.shift, 132_000)
    // An old expected amount (without the tip) and a made-up one.
    expect(reason(t.close(t.register, t.shift, cashCount, 130_000, 132_000, 'x'))).toBe(
      'expected_mismatch',
    )
    expect(reason(t.close(t.register, t.shift, cashCount, 0, 132_000, 'x'))).toBe(
      'expected_mismatch',
    )
  })

  describe('stale_cash_count: there was money after the last count', () => {
    it('a movement (entry, output or tip payout) after counting', () => {
      for (const type of ['cash_in', 'cash_out', 'tip_payout'] as const) {
        const t = shiftCharged()
        const { cashCount } = t.count(t.register, t.shift, 132_000)
        t.movement(t.register, t.shift, type, 1_000)
        const newExpected = type === 'cash_in' ? 133_000 : 131_000
        expect(
          reason(t.close(t.register, t.shift, cashCount, newExpected, 132_000, 'x')),
          type,
        ).toBe('stale_cash_count')
        expect(t.status.hub.openShift(t.register.deviceId), type).not.toBeNull()
      }
    })

    it('a payment, even with another method, after counting', () => {
      const t = shiftCharged()
      const { cashCount } = t.count(t.register, t.shift, 132_000)
      t.charge(t.register, t.order, t.nequiPaymentOf(t.shift, 500))
      expect(reason(t.close(t.register, t.shift, cashCount, 132_000, 132_000))).toBe(
        'stale_cash_count',
      )
    })

    it('a void and a refund after counting', () => {
      const t = shiftCharged()
      const other = t.charge(t.register, t.order, t.nequiPaymentOf(t.shift, 500))
      const { cashCount } = t.count(t.register, t.shift, 132_000)
      t.voidItem(t.register, t.order, other, t.shift)
      expect(reason(t.close(t.register, t.shift, cashCount, 132_000, 132_000))).toBe(
        'stale_cash_count',
      )
      const t2 = shiftCharged()
      const payment = t2.charge(t2.register, t2.order, t2.nequiPaymentOf(t2.shift, 500))
      const a2 = t2.count(t2.register, t2.shift, 132_000)
      const r = t2.one(
        t2.register,
        t2.raw(t2.register, 'RefundRecorded', t2.order, {
          payment_id: payment,
          refund_id: newId(),
          sale_amount: 100,
          tip_amount: 0,
          method: 'nequi',
          register_shift_id: t2.shift,
        }),
      )
      expect(reason(r)).toBe('confirmed')
      expect(reason(t2.close(t2.register, t2.shift, a2.cashCount, 132_000, 132_000))).toBe(
        'stale_cash_count',
      )
    })

    it('voiding a payment from a previous shift after counting also makes the count stale', () => {
      const e = environment()
      const t1 = e.openShift(e.register, 0)
      const order = e.openOrder(e.register)
      const payment = e.charge(e.register, order, e.cashPaymentOf(t1, 10_000))
      const a1 = e.count(e.register, t1, 10_000)
      e.close(e.register, t1, a1.cashCount, 10_000, 10_000)
      const t2 = e.openShift(e.register, 50_000)
      const { cashCount } = e.count(e.register, t2, 50_000)
      e.voidItem(e.register, order, payment, t2)
      expect(reason(e.close(e.register, t2, cashCount, 40_000, 50_000, 'x'))).toBe(
        'stale_cash_count',
      )
    })

    it('counting again fixes it: the new count is the latest and the expected amount is the new one', () => {
      const t = shiftCharged()
      const oldOne = t.count(t.register, t.shift, 132_000)
      t.movement(t.register, t.shift, 'cash_out', 12_000)
      const fresh = t.count(t.register, t.shift, 120_000)
      expect(reason(t.close(t.register, t.shift, oldOne.cashCount, 120_000, 132_000, 'x'))).toBe(
        'cash_count_not_latest',
      )
      expect(reason(t.close(t.register, t.shift, fresh.cashCount, 120_000, 120_000))).toBe(
        'confirmed',
      )
    })

    it('a rejected movement (from another register) or a payment on the shift of another register does not make it stale', () => {
      const t = shiftCharged()
      t.openShift(t.register2, 0)
      const { cashCount } = t.count(t.register, t.shift, 132_000)
      expect(reason(t.movement(t.register2, t.shift, 'cash_in', 1_000))).toBe(
        'other_register_shift',
      )
      const anotherOrder = t.openOrder(t.register2)
      t.charge(
        t.register2,
        anotherOrder,
        t.nequiPaymentOf(t.status.hub.openShift(t.register2.deviceId)?.id ?? '', 500),
      )
      expect(reason(t.close(t.register, t.shift, cashCount, 132_000, 132_000))).toBe('confirmed')
    })

    it('after restarting the hub, the count is still stale', () => {
      const t = shiftCharged()
      const { cashCount } = t.count(t.register, t.shift, 132_000)
      t.movement(t.register, t.shift, 'cash_in', 1_000)
      t.status.hub = t.newHub()
      expect(reason(t.close(t.register, t.shift, cashCount, 133_000, 132_000, 'x'))).toBe(
        'stale_cash_count',
      )
    })
  })

  describe('cash_count_not_latest', () => {
    it('closing with the first of two counts is rejected; with the latest it is accepted', () => {
      const t = shiftCharged()
      const a1 = t.count(t.register, t.shift, 130_000)
      const a2 = t.count(t.register, t.shift, 132_000)
      expect(reason(t.close(t.register, t.shift, a1.cashCount, t.expected, 130_000, 'Faltó'))).toBe(
        'cash_count_not_latest',
      )
      expect(t.status.hub.openShift(t.register.deviceId)).not.toBeNull()
      expect(reason(t.close(t.register, t.shift, a2.cashCount, t.expected, 132_000))).toBe(
        'confirmed',
      )
    })

    it('with three counts only the third is valid', () => {
      const t = shiftCharged()
      const a = [130_000, 131_000, 132_000].map((c) => t.count(t.register, t.shift, c).cashCount)
      expect(reason(t.close(t.register, t.shift, a[0] ?? '', t.expected, 130_000, 'x'))).toBe(
        'cash_count_not_latest',
      )
      expect(reason(t.close(t.register, t.shift, a[1] ?? '', t.expected, 131_000, 'x'))).toBe(
        'cash_count_not_latest',
      )
      expect(reason(t.close(t.register, t.shift, a[2] ?? '', t.expected, 132_000))).toBe(
        'confirmed',
      )
    })

    it('a repeated count with the same counted amount does not fool it: the id is compared, not the amount', () => {
      const t = shiftCharged()
      const a1 = t.count(t.register, t.shift, 132_000)
      t.count(t.register, t.shift, 132_000)
      expect(reason(t.close(t.register, t.shift, a1.cashCount, t.expected, 132_000))).toBe(
        'cash_count_not_latest',
      )
    })
  })

  it('the order of the rules: not found, not latest, stale, counted, expected, justification', () => {
    const t = shiftCharged(0)
    const a1 = t.count(t.register, t.shift, 131_000)
    const a2 = t.count(t.register, t.shift, 132_000)
    // Everything wrong at once, and no justification.
    expect(reason(t.close(t.register, t.shift, newId(), 1, 2))).toBe('cash_count_not_found')
    expect(reason(t.close(t.register, t.shift, a1.cashCount, 1, 2))).toBe('cash_count_not_latest')
    t.movement(t.register, t.shift, 'cash_in', 1_000)
    expect(reason(t.close(t.register, t.shift, a2.cashCount, 1, 2))).toBe('stale_cash_count')
    const a3 = t.count(t.register, t.shift, 133_000)
    expect(reason(t.close(t.register, t.shift, a3.cashCount, 1, 2))).toBe('counted_mismatch')
    expect(reason(t.close(t.register, t.shift, a3.cashCount, 1, 133_000))).toBe('expected_mismatch')
    expect(reason(t.close(t.register, t.shift, a3.cashCount, 133_000, 133_000))).toBe('confirmed')
  })

  describe('missing_justification', () => {
    /** A shift with base 100.000, no charges; counts `counted` and closes with `justification`. */
    function closesWith(threshold: number, counted: number, justification: string | null) {
      const e = environment({ threshold })
      const shift = e.openShift(e.register, 100_000)
      const { cashCount } = e.count(e.register, shift, counted)
      return reason(e.close(e.register, shift, cashCount, 100_000, counted, justification))
    }

    it('threshold 0: any variance asks for a justification; no variance, no', () => {
      expect(closesWith(0, 100_000, null)).toBe('confirmed')
      expect(closesWith(0, 99_999, null)).toBe('missing_justification')
      expect(closesWith(0, 100_001, null)).toBe('missing_justification')
      expect(closesWith(0, 99_000, null)).toBe('missing_justification')
      expect(closesWith(0, 101_000, null)).toBe('missing_justification')
      expect(closesWith(0, 99_000, 'Falta un billete')).toBe('confirmed')
    })

    it('threshold 1.000: below it closes as is; from 1.000 (short or over) it asks for a justification', () => {
      expect(closesWith(1000, 100_000, null)).toBe('confirmed')
      expect(closesWith(1000, 99_999, null)).toBe('confirmed')
      expect(closesWith(1000, 100_001, null)).toBe('confirmed')
      expect(closesWith(1000, 99_001, null)).toBe('confirmed')
      expect(closesWith(1000, 100_999, null)).toBe('confirmed')
      expect(closesWith(1000, 99_000, null)).toBe('missing_justification')
      expect(closesWith(1000, 101_000, null)).toBe('missing_justification')
      expect(closesWith(1000, 98_999, null)).toBe('missing_justification')
      expect(closesWith(1000, 99_000, null)).toBe('missing_justification')
      expect(closesWith(1000, 101_000, null)).toBe('missing_justification')
      expect(closesWith(1000, 98_000, null)).toBe('missing_justification')
      expect(closesWith(1000, 99_000, 'Propina de la mesa 4')).toBe('confirmed')
    })

    it('threshold 2.000: a variance of 1.000 asks for no justification; 2.000 does (the edge is inclusive)', () => {
      expect(closesWith(2000, 99_000, null)).toBe('confirmed')
      expect(closesWith(2000, 101_000, null)).toBe('confirmed')
      expect(closesWith(2000, 98_000, null)).toBe('missing_justification')
      expect(closesWith(2000, 102_000, null)).toBe('missing_justification')
    })

    it('a justification that is present is accepted even if it was not needed', () => {
      expect(closesWith(1000, 100_000, 'Todo bien')).toBe('confirmed')
    })

    it('an empty or whitespace-only justification does not get through: the schema rejects it', () => {
      for (const j of ['', '   ']) expect(closesWith(0, 99_000, j)).toMatch(/^schema:/)
    })

    it('the threshold that applies is the current one at close: if the admin changes it with the hub running', () => {
      const e = environment({ threshold: 5_000 })
      const shift = e.openShift(e.register, 100_000)
      const { cashCount } = e.count(e.register, shift, 99_000)
      e.cfg.threshold = 1_000
      expect(reason(e.close(e.register, shift, cashCount, 100_000, 99_000))).toBe(
        'missing_justification',
      )
      e.cfg.threshold = 5_000
      expect(reason(e.close(e.register, shift, cashCount, 100_000, 99_000))).toBe('confirmed')
    })

    it('a hub without checkout rules uses the default threshold ($1.000)', () => {
      const e = environment()
      const withoutRules = e.m.hub()
      const shift = newId()
      const connection = connectionOf(e.m, e.register)
      withoutRules.receiveBatch(connection, [
        e.raw(e.register, 'ShiftOpened', shift, {
          register_id: e.register.deviceId,
          base: 10_000,
        }),
      ])
      const tryAction = (counted: number, justification: string | null = null) => {
        const cashCount = newId()
        withoutRules.receiveBatch(connection, [
          e.raw(e.register, 'CashCountRecorded', shift, {
            cash_count_id: cashCount,
            tally: e.tallyOf(counted),
            counted_cash: counted,
          }),
        ])
        return reason(
          withoutRules.receiveBatch(connection, [
            e.raw(
              e.register,
              'ShiftClosed',
              shift,
              e.closeData(cashCount, 10_000, counted, justification),
            ),
          ]).results[0],
        )
      }
      expect(tryAction(9_000)).toBe('missing_justification')
      expect(tryAction(9_001)).toBe('confirmed')
    })
  })

  it('the correct close: it is confirmed, the shift is no longer open and the reconciliation is closed', () => {
    const t = shiftCharged()
    const { cashCount } = t.count(t.register, t.shift, t.expected)
    const r = t.close(t.register, t.shift, cashCount, t.expected, t.expected)
    expect(reason(r)).toBe('confirmed')
    expect(t.status.hub.openShift(t.register.deviceId)).toBeNull()
    expect(t.status.hub.reconciliation(t.shift)?.closed).not.toBeNull()
    const closeout = eventsOf(t.m).find((x) => x.type === 'ShiftClosed')
    expect(closeout?.aggregate_id).toBe(t.shift)
    expect(closeout?.data).toMatchObject({ expected_cash: 132_000, variance: 0 })
  })

  it('with several counts, each one is saved', () => {
    const t = shiftCharged()
    t.count(t.register, t.shift, 130_000)
    t.count(t.register, t.shift, 132_000)
    expect(t.status.hub.reconciliation(t.shift)?.cashCounts.map((a) => a.counted)).toEqual([
      130_000, 132_000,
    ])
    expect(eventsOf(t.m).filter((x) => x.type === 'CashCountRecorded')).toHaveLength(2)
  })

  it('a shortage with the variance and the justification is saved as is', () => {
    const t = shiftCharged(0)
    const { cashCount } = t.count(t.register, t.shift, 130_000)
    expect(
      reason(t.close(t.register, t.shift, cashCount, t.expected, 130_000, 'Falta un vale')),
    ).toBe('confirmed')
    const closeout = eventsOf(t.m).find((x) => x.type === 'ShiftClosed')
    expect(closeout?.data).toMatchObject({ variance: -2_000, justification: 'Falta un vale' })
  })

  it('resending the same confirmed close is idempotent; a second close with another id, no_shift', () => {
    const t = shiftCharged()
    const { cashCount } = t.count(t.register, t.shift, t.expected)
    const closeout = t.raw(
      t.register,
      'ShiftClosed',
      t.shift,
      t.closeData(cashCount, t.expected, t.expected),
    )
    const a = t.one(t.register, closeout)
    const b = t.one(t.register, closeout)
    expect(reason(a)).toBe('confirmed')
    expect(reason(b)).toBe('confirmed')
    expect(eventsOf(t.m).filter((x) => x.type === 'ShiftClosed')).toHaveLength(1)
    expect(reason(t.close(t.register, t.shift, cashCount, t.expected, t.expected))).toBe('no_shift')
  })

  it('a rejected close is rejected the same when resent; with the corrected expected amount and another id it is accepted', () => {
    const t = shiftCharged()
    const { cashCount } = t.count(t.register, t.shift, t.expected)
    const oldOne = t.raw(
      t.register,
      'ShiftClosed',
      t.shift,
      t.closeData(cashCount, 130_000, 132_000, 'x'),
    )
    expect(reason(t.one(t.register, oldOne))).toBe('expected_mismatch')
    expect(reason(t.one(t.register, oldOne))).toBe('expected_mismatch')
    expect(reason(t.close(t.register, t.shift, cashCount, t.expected, t.expected))).toBe(
      'confirmed',
    )
  })

  it('in a batch: the close before its cash count is rejected and what follows for the shift depends on it (depends_on_rejected)', () => {
    const e = environment()
    const shift = e.openShift(e.register, 10_000)
    const cashCount = newId()
    const r = e.send(e.register, [
      e.raw(e.register, 'ShiftClosed', shift, e.closeData(cashCount, 10_000, 10_000)),
      e.raw(e.register, 'CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: 10 }],
        counted_cash: 10_000,
      }),
    ])
    expect(r.results.map(reason)).toEqual(['cash_count_not_found', 'depends_on_rejected'])
    expect(e.status.hub.openShift(e.register.deviceId)).not.toBeNull()
  })

  it('in a batch: cash count and close in order are confirmed together', () => {
    const e = environment()
    const shift = e.openShift(e.register, 10_000)
    const cashCount = newId()
    const r = e.send(e.register, [
      e.raw(e.register, 'CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: 10 }],
        counted_cash: 10_000,
      }),
      e.raw(e.register, 'ShiftClosed', shift, e.closeData(cashCount, 10_000, 10_000)),
    ])
    expect(r.results.map(reason)).toEqual(['confirmed', 'confirmed'])
    expect(e.status.hub.openShift(e.register.deviceId)).toBeNull()
  })

  it('the close does not touch the other open shifts', () => {
    const t = shiftCharged()
    const other = t.openShift(t.register2, 5_000)
    const { cashCount } = t.count(t.register, t.shift, t.expected)
    t.close(t.register, t.shift, cashCount, t.expected, t.expected)
    expect(t.status.hub.openShift(t.register2.deviceId)?.id).toBe(other)
    expect(t.status.hub.reconciliation(other)?.cash.expected).toBe(5_000)
  })
})

describe('after the close', () => {
  function closed() {
    const e = environment()
    const shift = e.openShift(e.register, 100_000)
    const order = e.openOrder(e.register)
    const payment = e.charge(e.register, order, e.cashPaymentOf(shift, 10_000))
    const { cashCount } = e.count(e.register, shift, 110_000)
    expect(reason(e.close(e.register, shift, cashCount, 110_000, 110_000))).toBe('confirmed')
    return { ...e, shift, order, payment }
  }

  it('a payment, a void and a refund on that shift are rejected with no_shift', () => {
    const c = closed()
    const before = c.m.store.maxSequence()
    const payment = c.one(
      c.register,
      c.raw(c.register, 'PaymentRecorded', c.order, c.cashPaymentOf(c.shift, 5_000)),
    )
    expect(reason(payment)).toBe('no_shift')
    expect(reason(c.voidItem(c.register, c.order, c.payment, c.shift))).toBe('no_shift')
    const refund = c.one(
      c.register,
      c.raw(c.register, 'RefundRecorded', c.order, {
        payment_id: c.payment,
        refund_id: newId(),
        sale_amount: 1_000,
        tip_amount: 0,
        method: 'cash',
        register_shift_id: c.shift,
      }),
    )
    expect(reason(refund)).toBe('no_shift')
    expect(c.m.store.maxSequence()).toBe(before)
    expect(Object.keys(c.status.hub.order(c.order)?.payments ?? {})).toHaveLength(1)
  })

  it('a movement, another cash count and another close on the closed shift: no_shift', () => {
    const c = closed()
    expect(reason(c.movement(c.register, c.shift, 'cash_in', 1_000))).toBe('no_shift')
    expect(reason(c.count(c.register, c.shift, 1_000).result)).toBe('no_shift')
    expect(reason(c.close(c.register, c.shift, newId(), 0, 0))).toBe('no_shift')
  })

  it('the closed shift id cannot be reopened (shift_already_exists)', () => {
    const c = closed()
    const r = c.one(
      c.register,
      c.raw(c.register, 'ShiftOpened', c.shift, {
        register_id: c.register.deviceId,
        base: 1,
      }),
    )
    expect(reason(r)).toBe('shift_already_exists')
  })

  it('the same register opens another shift, with its own base, and the new reconciliation inherits nothing', () => {
    const c = closed()
    const fresh = c.openShift(c.register, 30_000)
    expect(fresh).not.toBe(c.shift)
    expect(c.status.hub.openShift(c.register.deviceId)).toMatchObject({
      id: fresh,
      base: 30_000,
    })
    expect(c.status.hub.reconciliation(fresh)?.cash).toMatchObject({
      charged: 0,
      cashIn: 0,
      expected: 30_000,
    })
    expect(c.status.hub.reconciliation(fresh)?.byMethod).toEqual([])
  })

  it('on the new shift charging works normally and the close reconciles only with its own', () => {
    const c = closed()
    const fresh = c.openShift(c.register, 30_000)
    c.charge(c.register, c.order, c.cashPaymentOf(fresh, 8_000, 500))
    // The previous shift's amount (110.000) does not count: the expected is 30.000 + 8.500.
    expect(c.status.hub.reconciliation(fresh)?.cash.expected).toBe(38_500)
    const { cashCount } = c.count(c.register, fresh, 38_500)
    expect(reason(c.close(c.register, fresh, cashCount, 38_500, 38_500))).toBe('confirmed')
    expect(c.status.hub.openShift(c.register.deviceId)).toBeNull()
  })
})

describe('voiding, on this shift, the payment of a previous shift', () => {
  /** Shift 1 with a 30.000 payment (+2.000 tip) already closed; shift 2 open with base 100.000. */
  function twoShifts() {
    const e = environment()
    const t1 = e.openShift(e.register, 0)
    const order = e.openOrder(e.register)
    const payment = e.charge(e.register, order, e.cashPaymentOf(t1, 30_000, 2_000))
    const { cashCount } = e.count(e.register, t1, 32_000)
    expect(reason(e.close(e.register, t1, cashCount, 32_000, 32_000))).toBe('confirmed')
    const t2 = e.openShift(e.register, 100_000)
    return { ...e, t1, t2, order, payment }
  }

  it('the void lands in shift 2: it returns what was charged (amount + tip) and the expected drops', () => {
    const d = twoShifts()
    expect(reason(d.voidItem(d.register, d.order, d.payment, d.t2))).toBe('confirmed')
    const c = d.status.hub.reconciliation(d.t2)
    expect(c?.cash).toMatchObject({ charged: 0, refunds: 32_000, expected: 68_000 })
    expect(c?.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: -30_000, tip: -2_000, payments: -1 },
    ])
  })

  it('the close of shift 2 must carry that expected amount: with the one from before voiding, expected_mismatch', () => {
    const d = twoShifts()
    d.voidItem(d.register, d.order, d.payment, d.t2)
    const { cashCount } = d.count(d.register, d.t2, 68_000)
    expect(reason(d.close(d.register, d.t2, cashCount, 100_000, 68_000, 'x'))).toBe(
      'expected_mismatch',
    )
    expect(reason(d.close(d.register, d.t2, cashCount, 68_000, 68_000))).toBe('confirmed')
  })

  it('with other shift 2 movements everything adds up: base + entry + charge − reversal − output', () => {
    const d = twoShifts()
    d.movement(d.register, d.t2, 'cash_in', 5_000)
    d.charge(d.register, d.order, d.cashPaymentOf(d.t2, 10_000))
    d.voidItem(d.register, d.order, d.payment, d.t2)
    d.movement(d.register, d.t2, 'cash_out', 1_000)
    expect(d.status.hub.reconciliation(d.t2)?.cash.expected).toBe(
      100_000 + 5_000 + 10_000 - 32_000 - 1_000,
    )
  })

  it('voiding a payment of ANOTHER register on this shift is other_register_shift only if the shift is not of this register', () => {
    const d = twoShifts()
    const otherShift2 = d.openShift(d.register2, 0)
    // Register 2 voids, on its own shift, a payment that register 1 charged on its already closed
    // shift 1.
    expect(reason(d.voidItem(d.register2, d.order, d.payment, otherShift2))).toBe('confirmed')
    expect(d.status.hub.reconciliation(otherShift2)?.cash).toMatchObject({ refunds: 32_000 })
    // Register 1 cannot void it on register 2's shift.
    expect(reason(d.voidItem(d.register, d.order, newId(), otherShift2))).toBe(
      'other_register_shift',
    )
  })

  it('a cash refund on shift 2 of a shift 1 payment is subtracted from the shift 2 drawer', () => {
    const d = twoShifts()
    const r = d.one(
      d.register,
      d.raw(d.register, 'RefundRecorded', d.order, {
        payment_id: d.payment,
        refund_id: newId(),
        sale_amount: 4_000,
        tip_amount: 500,
        method: 'cash',
        register_shift_id: d.t2,
      }),
    )
    expect(reason(r)).toBe('confirmed')
    expect(d.status.hub.reconciliation(d.t2)?.cash).toMatchObject({
      refunds: 4_500,
      expected: 95_500,
    })
  })

  // The refund brings the original payment into the shift (like the void), so the custom method is
  // not lost.
  it('a refund of a custom-method payment from another shift lands in the line of that custom method', () => {
    const e = environment()
    const t1 = e.openShift(e.register, 0)
    const order = e.openOrder(e.register)
    const payment = e.charge(e.register, order, e.customPaymentOf(t1, 20_000))
    const { cashCount } = e.count(e.register, t1, 0)
    // Sodexo was not reported in the count (1.8): the close flags it and asks for a justification.
    e.close(e.register, t1, cashCount, 0, 0, 'Sodexo sin reporte')
    const t2 = e.openShift(e.register, 0)
    const r = e.one(
      e.register,
      e.raw(e.register, 'RefundRecorded', order, {
        payment_id: payment,
        refund_id: newId(),
        sale_amount: 5_000,
        tip_amount: 0,
        method: 'other',
        register_shift_id: t2,
      }),
    )
    expect(reason(r)).toBe('confirmed')
    expect(e.status.hub.reconciliation(t2)?.byMethod).toEqual([
      { method: 'other', customMethodId: SODEXO, sale: -5_000, tip: 0, payments: 0 },
    ])
  })
})

describe('hub restart with a shift half done', () => {
  /** Shift 1 closed; shift 2 with a charge, entry, output, void of the shift 1 payment, a count. */
  function halfway() {
    const e = environment()
    const t1 = e.openShift(e.register, 0)
    const order = e.openOrder(e.register)
    const payment1 = e.charge(e.register, order, e.cashPaymentOf(t1, 30_000, 2_000))
    const a1 = e.count(e.register, t1, 32_000)
    e.close(e.register, t1, a1.cashCount, 32_000, 32_000)
    const t2 = e.openShift(e.register, 100_000)
    e.movement(e.register, t2, 'cash_in', 5_000)
    e.charge(e.register, order, e.cashPaymentOf(t2, 10_000))
    e.charge(e.register, order, e.nequiPaymentOf(t2, 800, 100))
    e.voidItem(e.register, order, payment1, t2)
    e.movement(e.register, t2, 'cash_out', 1_000)
    e.count(e.register, t2, 82_000)
    return { ...e, t1, t2, order, payment1 }
  }
  const EXPECTED = 100_000 + 5_000 + 10_000 - 32_000 - 1_000

  it('the reconciliation is rebuilt identically: what was charged, the returns, the movements and the counts', () => {
    const a = halfway()
    const before = a.status.hub.reconciliation(a.t2)
    expect(before?.cash.expected).toBe(EXPECTED)
    const restarted = a.newHub()
    expect(restarted.reconciliation(a.t2)).toEqual(before)
    expect(restarted.openShift(a.register.deviceId)?.id).toBe(a.t2)
    // The closed shift does not reappear.
    expect(restarted.reconciliation(a.t1)?.closed).not.toBeNull()
  })

  it('after the restart the close is accepted with the rebuilt expected amount and rejected with another', () => {
    const a = halfway()
    a.status.hub = a.newHub()
    const cashCount = a.status.hub.reconciliation(a.t2)?.cashCounts[0]?.id ?? ''
    expect(reason(a.close(a.register, a.t2, cashCount, EXPECTED + 1_000, 82_000, 'x'))).toBe(
      'expected_mismatch',
    )
    expect(reason(a.close(a.register, a.t2, cashCount, EXPECTED, 82_000))).toBe('confirmed')
  })

  it('a closed shift stays closed after the restart: nothing can be added to it and the register opens another', () => {
    const a = halfway()
    const cashCount = a.status.hub.reconciliation(a.t2)?.cashCounts[0]?.id ?? ''
    a.close(a.register, a.t2, cashCount, EXPECTED, 82_000)
    a.status.hub = a.newHub()
    expect(a.status.hub.openShift(a.register.deviceId)).toBeNull()
    expect(a.status.hub.reconciliation(a.t2)?.closed).not.toBeNull()
    expect(reason(a.movement(a.register, a.t2, 'cash_in', 1_000))).toBe('no_shift')
    expect(reason(a.count(a.register, a.t2, 1_000).result)).toBe('no_shift')
    const next = a.openShift(a.register, 5_000)
    expect(a.status.hub.reconciliation(next)?.cash.expected).toBe(5_000)
  })

  it('rejected counts or movements do not reappear after the restart', () => {
    const a = halfway()
    a.movement(a.register2, a.t2, 'cash_in', 99_000) // from another register: rejected
    a.close(a.register, a.t2, newId(), 0, 0) // no count: rejected
    const restarted = a.newHub()
    expect(restarted.reconciliation(a.t2)?.cash.cashIn).toBe(5_000)
    expect(restarted.reconciliation(a.t2)?.cash.expected).toBe(EXPECTED)
  })

  it('with more than a page of events in between, the shift is rebuilt in full', () => {
    const e = environment()
    const shift = e.openShift(e.register, 1_000)
    const order = e.openOrder(e.register, 1_000_000)
    e.charge(e.register, order, e.cashPaymentOf(shift, 20_000))
    // More than a page of order events unrelated to the shift, in a single batch.
    const padding: Record<string, unknown>[] = []
    for (let i = 0; i < PAGE_SIZE + 20; i++) {
      const p = newId()
      padding.push(
        e.raw(e.ana, 'OrderOpened', p, { channel: 'dine_in', table_id: null, guests: 1 }),
      )
    }
    for (let i = 0; i < padding.length; i += 100) e.send(e.ana, padding.slice(i, i + 100))
    e.movement(e.register, shift, 'cash_in', 2_000)
    e.status.hub = e.newHub()
    expect(eventsOf(e.m).length).toBeGreaterThan(PAGE_SIZE)
    expect(e.status.hub.reconciliation(shift)?.cash).toMatchObject({
      charged: 20_000,
      cashIn: 2_000,
      expected: 23_000,
    })
  })

  it('the hub crashes while saving the close: on return it is still half done, and the resent close is accepted once', () => {
    const e = environment()
    const shift = e.openShift(e.register, 10_000)
    const { cashCount } = e.count(e.register, shift, 10_000)
    const closeout = e.raw(e.register, 'ShiftClosed', shift, e.closeData(cashCount, 10_000, 10_000))
    const store = e.m.store as CrashingStore
    store.crashAt = 1
    expect(() => e.one(e.register, closeout)).toThrow('down')
    expect(store.down).toBe(true)
    store.down = false
    e.status.hub = e.newHub()
    expect(e.status.hub.openShift(e.register.deviceId)?.id).toBe(shift)
    expect(eventsOf(e.m).filter((x) => x.type === 'ShiftClosed')).toHaveLength(0)
    expect(reason(e.one(e.register, closeout))).toBe('confirmed')
    expect(reason(e.one(e.register, closeout))).toBe('confirmed')
    expect(eventsOf(e.m).filter((x) => x.type === 'ShiftClosed')).toHaveLength(1)
  })
})

describe('multi-restaurant: the reconciliation belongs to each restaurant', () => {
  function two() {
    const e = environment()
    const otherId = newId()
    e.m.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otherId, otherId, NOW, NOW)
    const newHubB = () =>
      new HubSync(new SqliteStore(e.m.db, otherId), {
        restaurantId: otherId,
        timeZone: 'America/Bogota',
        businessDayStart: '06:00',
        access: openAccess,
        instance: 'hub-b',
        clock: e.m.network.isoTime,
        checkoutRules: () => ({ ...RULES, varianceThreshold: 0 }),
      })
    return { ...e, otherId, hubB: newHubB(), newHubB }
  }

  it('the movement, cash count and close of the shift of A do not exist in B (no_shift)', () => {
    const d = two()
    const shift = d.openShift(d.register, 50_000)
    const inB = (type: string, data: unknown) =>
      reason(
        d.send(d.register, [d.raw(d.register, type, shift, data, { base_sequence: 0 })], d.hubB)
          .results[0],
      )
    expect(
      inB('CashMovementRecorded', {
        movement_id: newId(),
        type: 'cash_in',
        amount: 1_000,
        description: 'x',
        to_whom: null,
        days: [],
      }),
    ).toBe('no_shift')
    expect(inB('CashCountRecorded', { cash_count_id: newId(), tally: [], counted_cash: 0 })).toBe(
      'no_shift',
    )
    expect(inB('ShiftClosed', d.closeData(newId(), 0, 0))).toBe('no_shift')
    expect(d.hubB.reconciliation(shift)).toBeNull()
    expect(d.status.hub.reconciliation(shift)?.cash.expected).toBe(50_000)
  })

  it('each restaurant has its own shift and reconciliation even with the same register and closes in one', () => {
    const d = two()
    const shiftA = d.openShift(d.register, 10_000)
    const shiftB = newId()
    const rB = d.send(
      d.register,
      [
        d.raw(
          d.register,
          'ShiftOpened',
          shiftB,
          { register_id: d.register.deviceId, base: 20_000 },
          { base_sequence: 0 },
        ),
        d.raw(
          d.register,
          'CashMovementRecorded',
          shiftB,
          {
            movement_id: newId(),
            type: 'cash_in',
            amount: 3_000,
            description: 'x',
            to_whom: null,
            days: [],
          },
          { base_sequence: 0 },
        ),
      ],
      d.hubB,
    )
    expect(rB.results.map(reason)).toEqual(['confirmed', 'confirmed'])
    d.movement(d.register, shiftA, 'cash_out', 4_000)
    expect(d.status.hub.reconciliation(shiftA)?.cash.expected).toBe(6_000)
    expect(d.hubB.reconciliation(shiftB)?.cash.expected).toBe(23_000)

    // Closing A's does not close B's.
    const { cashCount } = d.count(d.register, shiftA, 6_000)
    expect(reason(d.close(d.register, shiftA, cashCount, 6_000, 6_000))).toBe('confirmed')
    expect(d.status.hub.openShift(d.register.deviceId)).toBeNull()
    expect(d.hubB.openShift(d.register.deviceId)?.id).toBe(shiftB)

    // Restarting each hub rebuilds only its own.
    expect(d.newHub().openShift(d.register.deviceId)).toBeNull()
    const restartedB = d.newHubB()
    expect(restartedB.reconciliation(shiftB)?.cash).toMatchObject({
      cashIn: 3_000,
      expected: 23_000,
    })
    expect(restartedB.reconciliation(shiftA)).toBeNull()
  })

  it('the threshold belongs to each restaurant: a $500 shortage closes as is only in A (threshold 1.000), not in B (threshold 0)', () => {
    const d = two()
    const inB = (event: Record<string, unknown>) =>
      reason(d.send(d.register, [event], d.hubB).results[0])
    const shiftB = newId()
    expect(
      inB(
        d.raw(
          d.register,
          'ShiftOpened',
          shiftB,
          { register_id: d.register.deviceId, base: 10_000 },
          { base_sequence: 0 },
        ),
      ),
    ).toBe('confirmed')
    const cashCountB = newId()
    inB(
      d.raw(
        d.register,
        'CashCountRecorded',
        shiftB,
        { cash_count_id: cashCountB, tally: d.tallyOf(9_500), counted_cash: 9_500 },
        { base_sequence: 0 },
      ),
    )
    expect(
      inB(
        d.raw(d.register, 'ShiftClosed', shiftB, d.closeData(cashCountB, 10_000, 9_500), {
          base_sequence: 0,
        }),
      ),
    ).toBe('missing_justification')

    const shiftA = d.openShift(d.register, 10_000)
    const { cashCount } = d.count(d.register, shiftA, 9_500)
    expect(reason(d.close(d.register, shiftA, cashCount, 10_000, 9_500))).toBe('confirmed')
  })
})

describe('with the simulated network: the register closes offline, the hub shuts down and duplicates arrive', () => {
  /** The register opens a shift, moves cash, counts and closes; each event is saved on device. */
  async function registerCloses(register: NetNode, base = 100_000) {
    const shift = newId()
    const cashCount = newId()
    const registerShift = { aggregate_type: 'register_shift' } as never
    await register.create(
      shift,
      'ShiftOpened',
      { register_id: register.deviceId, base },
      registerShift,
    )
    await register.create(
      shift,
      'CashMovementRecorded',
      {
        movement_id: newId(),
        type: 'cash_in',
        amount: 20_000,
        description: 'Cambio',
        to_whom: null,
        days: [],
      },
      registerShift,
    )
    await register.create(
      shift,
      'CashCountRecorded',
      { cash_count_id: cashCount, tally: [{ value: 20_000, quantity: 6 }], counted_cash: 120_000 },
      registerShift,
    )
    await register.create(
      shift,
      'ShiftClosed',
      {
        cash_count_id: cashCount,
        expected_cash: base + 20_000,
        counted_cash: 120_000,
        variance: 120_000 - (base + 20_000),
        justification: 'Se pagó un domicilio',
      },
      registerShift,
    )
    return shift
  }
  const types = (m: Setup) => eventsOf(m).map((x) => x.type)
  const FOUR = ['ShiftOpened', 'CashMovementRecorded', 'CashCountRecorded', 'ShiftClosed']

  it('all offline: on reconnect the four are confirmed in order and the shift ends up closed', async () => {
    const m = setup()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    const shift = await registerCloses(register)
    expect(await register.client.pendingList()).toBe(4)
    await m.network.connectAll()
    expect(types(m)).toEqual(FOUR)
    expect(m.hub().openShift(register.deviceId)).toBeNull()
    expect(m.hub().reconciliation(shift)?.closed).not.toBeNull()
    expect(await register.client.pendingList()).toBe(0)
    expect((await ana.client.locals()).map((l) => l.event.type)).toEqual(FOUR)
  })

  it('a batch duplicated by the network does not repeat movements or closes', async () => {
    const m = setup()
    const register = m.network.device('register')
    await m.network.connectAll()
    register.rule('to_hub', 'push', 'duplicate', 4)
    await registerCloses(register)
    await m.network.settle()
    expect(types(m)).toEqual(FOUR)
    expect(await register.client.pendingList()).toBe(0)
  })

  it('the hub shuts down right while saving the count: on return, the cash count and close complete without duplicates', async () => {
    const m = setup()
    const register = m.network.device('register')
    await m.network.connectAll()
    if (m.store instanceof CrashingStore) m.store.crashAt = 3
    const shift = await registerCloses(register)
    await m.network.settle()
    await m.network.connectAll()
    await m.network.settle()
    expect(types(m)).toEqual(FOUR)
    expect(m.hub().openShift(register.deviceId)).toBeNull()
    expect(eventsOf(m).every((x) => x.aggregate_id === shift)).toBe(true)
  })

  it('the hub shuts down right while saving the close: the shift comes back open and the close arrives only once', async () => {
    const m = setup()
    const register = m.network.device('register')
    await m.network.connectAll()
    if (m.store instanceof CrashingStore) m.store.crashAt = 4
    await registerCloses(register)
    await m.network.settle()
    await m.network.connectAll()
    await m.network.settle()
    expect(types(m).filter((x) => x === 'ShiftClosed')).toHaveLength(1)
    expect(m.hub().openShift(register.deviceId)).toBeNull()
  })

  it('with the register clock 3 hours behind the close is still accepted', async () => {
    const m = setup()
    const register = m.network.device('register')
    register.offsetMs = -3 * 60 * 60 * 1000
    await m.network.connectAll()
    await registerCloses(register)
    await m.network.settle()
    expect(types(m)).toEqual(FOUR)
  })

  it('with the clock one day ahead, too', async () => {
    const m = setup()
    const register = m.network.device('register')
    register.offsetMs = 24 * 60 * 60 * 1000
    await m.network.connectAll()
    await registerCloses(register)
    await m.network.settle()
    expect(types(m)).toEqual(FOUR)
    expect(m.hub().openShift(register.deviceId)).toBeNull()
  })
})

describe('hub report (task 1.9): reportData and shiftClose', () => {
  const DAY = '2026-10-24'

  it('gathers the closed orders, the payments of the day and the shift close with its reconciliation', () => {
    const e = environment()
    const shift = e.openShift(e.register, 50_000)
    const closed = e.openOrder(e.register, 30_000)
    e.charge(e.register, closed, e.cashPaymentOf(shift, 30_000, 3_000))
    expect(reason(e.one(e.register, e.raw(e.register, 'OrderClosed', closed, {})))).toBe(
      'confirmed',
    )
    // A partial payment from a table still open: counts by method, not in sales.
    const opened = e.openOrder(e.register, 20_000)
    const partialPayment = e.charge(e.register, opened, e.nequiPaymentOf(shift, 5_000))
    e.voidItem(e.register, opened, partialPayment, shift)
    e.movement(e.register, shift, 'tip_payout', 1_000)
    const { cashCount } = e.count(e.register, shift, 82_000)
    expect(reason(e.close(e.register, shift, cashCount, 82_000, 82_000))).toBe('confirmed')

    const data = e.status.hub.reportData(DAY, DAY)
    expect(data.closings?.map((c) => [c.before, c.after.id])).toEqual([[null, closed]])
    // The Nequi payment was voided the same day: it shows up with its void.
    expect(data.events.map((x) => x.type)).toEqual([
      'PaymentRecorded',
      'PaymentRecorded',
      'PaymentVoided',
      'CashMovementRecorded',
    ])
    expect(data.registerClosings).toHaveLength(1)
    expect(data.registerClosings[0]).toMatchObject({
      businessDay: DAY,
      openedBy: e.register.userId,
      closedBy: e.register.userId,
    })
    expect(data.registerClosings[0]?.reconciliation.closed).toMatchObject({
      expected: 82_000,
      variance: 0,
    })
    // Once closed, the reconciliation comes from the database and matches what the register saw at
    // close.
    expect(e.status.hub.reconciliation(shift)?.cash.expected).toBe(82_000)
    expect(e.status.hub.reportData('2026-10-25', '2026-10-25')).toMatchObject({
      closings: [],
      events: [],
      registerClosings: [],
    })
  })

  it('a void from today brings the original payment from another day, and a restart gives the same', () => {
    const e = environment()
    const shift = e.openShift(e.register)
    const order = e.openOrder(e.register, 30_000)
    const payment = e.charge(e.register, order, e.nequiPaymentOf(shift, 10_000))
    // On the next business day (after 6:00 a.m.).
    e.m.network.advance(24 * 60 * 60 * 1000)
    e.voidItem(e.register, order, payment, shift)
    const today = e.status.hub.reportData('2026-10-25', '2026-10-25')
    expect(today.events.map((x) => `${x.type}:${x.business_day}`)).toEqual([
      `PaymentRecorded:${DAY}`,
      'PaymentVoided:2026-10-25',
    ])
    expect(e.newHub().reportData('2026-10-25', '2026-10-25')).toEqual(today)
    expect(e.status.hub.shiftClose(shift)).toBeNull()
  })
})
