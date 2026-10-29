import { aggregateOf, newId, otherMethodsReconciliation } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { HubSync } from './hub/hub'
import { SqliteStore } from './hub/store-sqlite'
import { openAccess } from './testing/access'
import type { NetNode } from './testing/network'
import { CrashingStore, eventsOf, item, NOW, type Setup, setup } from './testing/setup'

// The register close with the other methods on the hub (task 1.8): `other_methods_mismatch`, the
// justification for a non-cash method, the correct close with card and Nequi, compatibility with
// 1.7, the hub restart, the simulated network and multi-restaurant.

const SODEXO = newId()
const QR = newId()
const CARD_TERMINAL = newId()
const RULES = {
  multiple: 100,
  mode: 'nearest_half_down',
  methods: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
  customMethods: [SODEXO, QR],
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

type PeriodReport = { method: string; custom_method_id: string | null; reported: number }
type Line = PeriodReport & { expected: number; variance: number }
const res = (method: string, reported: number, own: string | null = null): PeriodReport => ({
  method,
  custom_method_id: own,
  reported,
})
const line = (
  method: string,
  expected: number,
  reported: number,
  own: string | null = null,
): Line => ({
  ...res(method, reported, own),
  expected,
  variance: reported - expected,
})

function environment(options: { threshold?: number } = {}) {
  const m = setup()
  const register = m.network.device('register')
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
  /** On another hub (another restaurant) A's base sequence does not apply: start from 0. */
  const fromHub = (hub: HubSync): Record<string, unknown> =>
    hub === status.hub ? {} : { base_sequence: 0 }
  const send = (node: NetNode, events: Record<string, unknown>[], hub = status.hub) =>
    hub.receiveBatch(connectionOf(m, node), events)
  const one = (node: NetNode, event: Record<string, unknown>, hub = status.hub) =>
    send(node, [event], hub).results[0]

  const openShift = (node: NetNode, base = 100_000, shift = newId()) => {
    expect(
      reason(one(node, raw(node, 'ShiftOpened', shift, { register_id: node.deviceId, base }))),
    ).toBe('confirmed')
    return shift
  }
  const openOrder = (node: NetNode, price = 1_000_000, hub = status.hub) => {
    const order = newId()
    one(
      node,
      raw(
        node,
        'OrderOpened',
        order,
        { channel: 'dine_in', table_id: null, guests: 2 },
        fromHub(hub),
      ),
      hub,
    )
    one(node, raw(node, 'ItemAdded', order, item(price), fromHub(hub)), hub)
    return order
  }
  const base = (shift: string, amount: number, tip: number) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    amount,
    tip,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
  })
  const cashPaymentOf = (shift: string, amount: number, tip = 0) => ({
    ...base(shift, amount, tip),
    method: 'cash',
    tendered: amount + tip,
    change: 0,
  })
  const cardPaymentData = (shift: string, amount: number, tip = 0) => ({
    ...base(shift, amount, tip),
    method: 'card',
    cardTerminal: {
      card_terminal_id: CARD_TERMINAL,
      franchise: null,
      last4: null,
      approval_code: null,
      receipt: null,
      card_type: 'credit',
    },
  })
  const nequiPaymentOf = (shift: string, amount: number, tip = 0) => ({
    ...base(shift, amount, tip),
    method: 'nequi',
  })
  const customPaymentOf = (shift: string, id: string, amount: number, tip = 0) => ({
    ...base(shift, amount, tip),
    method: 'other',
    custom_method_id: id,
  })
  const charge = (node: NetNode, order: string, data: { payment_id: string }, hub = status.hub) => {
    expect(reason(one(node, raw(node, 'PaymentRecorded', order, data, fromHub(hub)), hub))).toBe(
      'confirmed',
    )
    return data.payment_id
  }
  const voidItem = (node: NetNode, order: string, paymentId: string, shift: string) =>
    one(
      node,
      raw(node, 'PaymentVoided', order, { payment_id: paymentId, register_shift_id: shift }),
    )
  const tallyOf = (counted: number) =>
    [
      { value: 1_000, quantity: Math.floor(counted / 1_000) },
      { value: 1, quantity: counted % 1_000 },
    ].filter((c) => c.quantity > 0)
  /** A count of `counted` pesos in cash and the reports for the other methods (if given). */
  const count = (
    node: NetNode,
    shift: string,
    counted: number,
    others?: PeriodReport[],
    hub = status.hub,
  ) => {
    const cashCount = newId()
    const result = one(
      node,
      raw(
        node,
        'CashCountRecorded',
        shift,
        {
          cash_count_id: cashCount,
          tally: tallyOf(counted),
          counted_cash: counted,
          ...(others ? { others } : {}),
        },
        fromHub(hub),
      ),
      hub,
    )
    return { cashCount, result }
  }
  /** The lines the close must carry: the ones the hub computes from the count. */
  const linesOf = (shift: string, cashCount: string, hub = status.hub): Line[] => {
    const reconciliation = hub.reconciliation(shift)
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
  /** Closes with what is asked; without `other_methods` it sends the close the hub computes. */
  const close = (
    node: NetNode,
    shift: string,
    cashCount: string,
    expected: number,
    counted: number,
    options: {
      justification?: string | null
      other_methods?: unknown
      withoutField?: boolean
      hub?: HubSync
    } = {},
  ) => {
    const hub = options.hub ?? status.hub
    const data: Record<string, unknown> = {
      cash_count_id: cashCount,
      expected_cash: expected,
      counted_cash: counted,
      variance: counted - expected,
      justification: options.justification ?? null,
    }
    if (!options.withoutField)
      data.other_methods = options.other_methods ?? linesOf(shift, cashCount, hub)
    return one(node, raw(node, 'ShiftClosed', shift, data, fromHub(hub)), hub)
  }

  return {
    m,
    register,
    ana,
    cfg,
    fromHub,
    status,
    newHub,
    raw,
    send,
    one,
    openShift,
    openOrder,
    cashPaymentOf,
    cardPaymentData,
    nequiPaymentOf,
    customPaymentOf,
    charge,
    voidItem,
    count,
    tallyOf,
    close,
    linesOf,
  }
}

/** Float 100.000, card 100.000 + 10.000 tip and Nequi 30.000; cash counted 100.000. */
function withCardAndNequi(threshold = 1000) {
  const e = environment({ threshold })
  const shift = e.openShift(e.register, 100_000)
  const order = e.openOrder(e.register)
  e.charge(e.register, order, e.cardPaymentData(shift, 100_000, 10_000))
  e.charge(e.register, order, e.nequiPaymentOf(shift, 30_000))
  return { ...e, shift, order, EXPECTED_CARD: 110_000, EXPECTED_NEQUI: 30_000 }
}

describe('close with card and Nequi', () => {
  it('the correct close: each method reported equal to what was recorded, is confirmed and saved', () => {
    const t = withCardAndNequi()
    const { cashCount, result } = t.count(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(reason(result)).toBe('confirmed')
    const closeout = t.close(t.register, t.shift, cashCount, 100_000, 100_000)
    expect(reason(closeout)).toBe('confirmed')
    expect(t.status.hub.openShift(t.register.deviceId)).toBeNull()
    const saved = eventsOf(t.m).find((x) => x.type === 'ShiftClosed')
    expect(saved?.type === 'ShiftClosed' && saved.data.other_methods).toEqual([
      line('card', 110_000, 110_000),
      line('nequi', 30_000, 30_000),
    ])
  })

  it('with a variance in one method but justified: it is confirmed and the variance is saved with its sign', () => {
    const t = withCardAndNequi()
    const { cashCount } = t.count(t.register, t.shift, 100_000, [
      res('card', 105_000),
      res('nequi', 31_500),
    ])
    expect(reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000))).toBe(
      'missing_justification',
    )
    expect(
      reason(
        t.close(t.register, t.shift, cashCount, 100_000, 100_000, {
          justification: 'El datáfono se reinició',
        }),
      ),
    ).toBe('confirmed')
    const saved = eventsOf(t.m).find((x) => x.type === 'ShiftClosed')
    expect(saved?.type === 'ShiftClosed' && saved.data.other_methods).toEqual([
      line('card', 110_000, 105_000),
      line('nequi', 30_000, 31_500),
    ])
  })

  it('with a custom method and another reported without payments (a charge that was not recorded)', () => {
    const e = environment()
    const shift = e.openShift(e.register, 0)
    const order = e.openOrder(e.register)
    e.charge(e.register, order, e.customPaymentOf(shift, SODEXO, 20_000))
    const { cashCount } = e.count(e.register, shift, 0, [
      res('other', 20_000, SODEXO),
      res('daviplata', 5_000),
    ])
    expect(e.linesOf(shift, cashCount)).toEqual([
      line('other', 20_000, 20_000, SODEXO),
      line('daviplata', 0, 5_000),
    ])
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('missing_justification')
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, {
          justification: 'Un cobro por Daviplata sin registrar',
        }),
      ),
    ).toBe('confirmed')
  })

  it('the order of the close lines does not matter', () => {
    const t = withCardAndNequi()
    const { cashCount } = t.count(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(
      reason(
        t.close(t.register, t.shift, cashCount, 100_000, 100_000, {
          other_methods: [line('nequi', 30_000, 30_000), line('card', 110_000, 110_000)],
        }),
      ),
    ).toBe('confirmed')
  })

  it('a refund or a void lowers the expected amount: the close must carry the net', () => {
    const t = withCardAndNequi()
    const payment = t.charge(t.register, t.order, t.nequiPaymentOf(t.shift, 10_000))
    t.voidItem(t.register, t.order, payment, t.shift)
    const { cashCount } = t.count(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(t.linesOf(t.shift, cashCount)).toEqual([
      line('card', 110_000, 110_000),
      line('nequi', 30_000, 30_000),
    ])
    expect(reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000))).toBe('confirmed')
  })
})

describe('other_methods_mismatch', () => {
  function ready() {
    const t = withCardAndNequi()
    const { cashCount } = t.count(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    const closeWith = (other_methods: unknown) =>
      reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000, { other_methods }))
    return { ...t, cashCount, closeWith }
  }

  it('a method is missing: the close does not carry the Nequi', () => {
    expect(ready().closeWith([line('card', 110_000, 110_000)])).toBe('other_methods_mismatch')
  })

  it('everything is missing: an empty list with digital payments', () => {
    expect(ready().closeWith([])).toBe('other_methods_mismatch')
  })

  it('without the `other_methods` field (a 1.7 client) with digital payments', () => {
    const t = withCardAndNequi()
    const { cashCount } = t.count(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(
      reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000, { withoutField: true })),
    ).toBe('other_methods_mismatch')
  })

  it('an extra method: a line with a reported amount the count does not have', () => {
    expect(
      ready().closeWith([
        line('card', 110_000, 110_000),
        line('nequi', 30_000, 30_000),
        line('daviplata', 0, 5_000),
      ]),
    ).toBe('other_methods_mismatch')
  })

  it('an extra method at 0 and 0: the hub does not list it, so the close with it differs', () => {
    expect(
      ready().closeWith([
        line('card', 110_000, 110_000),
        line('nequi', 30_000, 30_000),
        line('daviplata', 0, 0),
      ]),
    ).toBe('other_methods_mismatch')
  })

  // The schema already rejects the repeated line and the custom method without id, before comparing
  // with the hub.
  it('a repeated line: the schema rejects it', () => {
    expect(
      ready().closeWith([
        line('card', 110_000, 110_000),
        line('card', 110_000, 110_000),
        line('nequi', 30_000, 30_000),
      ]),
    ).toMatch(/^schema: .*Un medio aparece dos veces/)
  })

  it('another expected: says $1 less or more than what the hub recorded', () => {
    expect(ready().closeWith([line('card', 109_999, 110_000), line('nequi', 30_000, 30_000)])).toBe(
      'other_methods_mismatch',
    )
    expect(ready().closeWith([line('card', 110_001, 110_000), line('nequi', 30_000, 30_000)])).toBe(
      'other_methods_mismatch',
    )
  })

  it('another reported: says a value other than the count, even if the variance is consistent', () => {
    expect(ready().closeWith([line('card', 110_000, 100_000), line('nequi', 30_000, 30_000)])).toBe(
      'other_methods_mismatch',
    )
    expect(ready().closeWith([line('card', 110_000, 110_000), line('nequi', 30_000, 30_001)])).toBe(
      'other_methods_mismatch',
    )
  })

  it('a line with a miscalculated variance does not get through: the schema rejects it', () => {
    const r = ready().closeWith([
      { ...line('card', 110_000, 110_000), variance: 5 },
      line('nequi', 30_000, 30_000),
    ])
    expect(r).toMatch(/^schema:/)
  })

  it('cash among the other methods: the schema rejects it', () => {
    const r = ready().closeWith([
      line('cash', 0, 0),
      line('card', 110_000, 110_000),
      line('nequi', 30_000, 30_000),
    ])
    expect(r).toMatch(/^schema:/)
  })

  it('one method swapped for another (Nequi stated as Daviplata)', () => {
    expect(
      ready().closeWith([line('card', 110_000, 110_000), line('daviplata', 30_000, 30_000)]),
    ).toBe('other_methods_mismatch')
  })

  it('a custom method with another id: different', () => {
    const e = environment()
    const shift = e.openShift(e.register, 0)
    const order = e.openOrder(e.register)
    e.charge(e.register, order, e.customPaymentOf(shift, SODEXO, 20_000))
    const { cashCount } = e.count(e.register, shift, 0, [res('other', 20_000, SODEXO)])
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, {
          other_methods: [line('other', 20_000, 20_000, QR)],
        }),
      ),
    ).toBe('other_methods_mismatch')
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, {
          other_methods: [line('other', 20_000, 20_000, SODEXO)],
        }),
      ),
    ).toBe('confirmed')
  })

  it('a custom method without id in the close: the schema rejects it', () => {
    const e = environment()
    const shift = e.openShift(e.register, 0)
    const order = e.openOrder(e.register)
    e.charge(e.register, order, e.customPaymentOf(shift, SODEXO, 20_000))
    const { cashCount } = e.count(e.register, shift, 0, [res('other', 20_000, SODEXO)])
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, {
          other_methods: [line('other', 20_000, 20_000, null)],
        }),
      ),
    ).toMatch(/^schema: .*Un medio propio dice cuál es/)
  })

  it('a rejection does not close the shift or leave a trace; with the correct lines it is accepted', () => {
    const t = ready()
    const before = t.m.store.maxSequence()
    expect(t.closeWith([])).toBe('other_methods_mismatch')
    expect(t.m.store.maxSequence()).toBe(before)
    expect(t.status.hub.openShift(t.register.deviceId)?.id).toBe(t.shift)
    expect(t.closeWith(t.linesOf(t.shift, t.cashCount))).toBe('confirmed')
  })

  it('the rejection repeats the same if resent', () => {
    const t = ready()
    const data = {
      cash_count_id: t.cashCount,
      expected_cash: 100_000,
      counted_cash: 100_000,
      variance: 0,
      justification: null,
      other_methods: [],
    }
    const event = t.raw(t.register, 'ShiftClosed', t.shift, data)
    expect(reason(t.one(t.register, event))).toBe('other_methods_mismatch')
    expect(reason(t.one(t.register, event))).toBe('other_methods_mismatch')
  })

  it('the rule order: the cash expected goes before the other methods, and these before the justification', () => {
    const t = withCardAndNequi(0)
    const { cashCount } = t.count(t.register, t.shift, 99_000, [
      res('card', 1),
      res('nequi', 30_000),
    ])
    // Everything wrong at once: the cash expected (1) and the lines (empty), without justification.
    expect(reason(t.close(t.register, t.shift, cashCount, 1, 99_000, { other_methods: [] }))).toBe(
      'expected_mismatch',
    )
    expect(
      reason(t.close(t.register, t.shift, cashCount, 100_000, 99_000, { other_methods: [] })),
    ).toBe('other_methods_mismatch')
    expect(reason(t.close(t.register, t.shift, cashCount, 100_000, 99_000))).toBe(
      'missing_justification',
    )
  })

  it('a digital payment after the count: the count becomes stale, and with a new one it closes', () => {
    const t = withCardAndNequi()
    const { cashCount } = t.count(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    t.charge(t.register, t.order, t.nequiPaymentOf(t.shift, 5_000))
    expect(reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000))).toBe(
      'stale_cash_count',
    )
    const other = t.count(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 35_000),
    ])
    expect(reason(t.close(t.register, t.shift, other.cashCount, 100_000, 100_000))).toBe(
      'confirmed',
    )
  })

  it('with several counts only the last report counts', () => {
    const t = withCardAndNequi()
    const firstCount = t.count(t.register, t.shift, 100_000, [res('card', 1), res('nequi', 1)])
    const latest = t.count(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(reason(t.close(t.register, t.shift, firstCount.cashCount, 100_000, 100_000))).toBe(
      'cash_count_not_latest',
    )
    expect(reason(t.close(t.register, t.shift, latest.cashCount, 100_000, 100_000))).toBe(
      'confirmed',
    )
  })

  it('cash count reports with a broken schema (cash, repeated, custom method without id) are rejected', () => {
    const t = withCardAndNequi()
    const badReports: PeriodReport[][] = [
      [res('cash', 1)],
      [res('card', 1), res('card', 2)],
      [res('other', 1, null)],
      [res('card', 1, SODEXO)],
    ]
    for (const others of badReports)
      expect(reason(t.count(t.register, t.shift, 100_000, others).result)).toMatch(/^schema:/)
  })
})

describe('missing_justification for a non-cash method', () => {
  /** Counts with `reported` on the card (expected 10.000) and closes with `justification`. */
  function closesWith(threshold: number, reported: number, justification: string | null = null) {
    const e = environment({ threshold })
    const shift = e.openShift(e.register, 0)
    e.charge(e.register, e.openOrder(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.count(e.register, shift, 0, [res('card', reported)])
    return reason(e.close(e.register, shift, cashCount, 0, 0, { justification }))
  }

  it('threshold 1.000: below it closes; from 1.000 short or over it asks for justification', () => {
    expect(closesWith(1000, 10_000)).toBe('confirmed')
    expect(closesWith(1000, 9_999)).toBe('confirmed')
    expect(closesWith(1000, 10_001)).toBe('confirmed')
    expect(closesWith(1000, 9_001)).toBe('confirmed')
    expect(closesWith(1000, 10_999)).toBe('confirmed')
    expect(closesWith(1000, 9_000)).toBe('missing_justification')
    expect(closesWith(1000, 11_000)).toBe('missing_justification')
    expect(closesWith(1000, 8_999)).toBe('missing_justification')
    expect(closesWith(1000, 11_001)).toBe('missing_justification')
    expect(closesWith(1000, 0)).toBe('missing_justification')
  })

  it('with justification it is accepted even if the variance is large', () => {
    expect(closesWith(1000, 0, 'No llegó el cierre del datáfono')).toBe('confirmed')
    expect(closesWith(1000, 20_000, 'Cobros de otro turno')).toBe('confirmed')
  })

  it('threshold 0: any $1 variance asks for justification; with no variance, no', () => {
    expect(closesWith(0, 10_000)).toBe('confirmed')
    expect(closesWith(0, 9_999)).toBe('missing_justification')
    expect(closesWith(0, 10_001)).toBe('missing_justification')
  })

  it('threshold 2.000: the edge is inclusive', () => {
    expect(closesWith(2000, 8_001)).toBe('confirmed')
    expect(closesWith(2000, 12_000)).toBe('missing_justification')
    expect(closesWith(2000, 8_000)).toBe('missing_justification')
    expect(closesWith(2000, 11_999)).toBe('confirmed')
  })

  it('cash balances and card does not: justification is still asked for', () => {
    expect(closesWith(1000, 5_000)).toBe('missing_justification')
  })

  it('card balances and cash is slightly off: below the threshold it is not asked for', () => {
    const e = environment()
    const shift = e.openShift(e.register, 10_000)
    e.charge(e.register, e.openOrder(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.count(e.register, shift, 9_500, [res('card', 10_000)])
    expect(reason(e.close(e.register, shift, cashCount, 10_000, 9_500))).toBe('confirmed')
  })

  it('each method is measured separately: two $600 variances (cash and card) with threshold 1.000 do not ask for justification', () => {
    const e = environment()
    const shift = e.openShift(e.register, 10_000)
    e.charge(e.register, e.openOrder(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.count(e.register, shift, 9_400, [res('card', 9_400)])
    expect(reason(e.close(e.register, shift, cashCount, 10_000, 9_400))).toBe('confirmed')
  })

  it('one of several methods with a large variance is enough; an overage on a method reported without payments too', () => {
    const e = environment()
    const shift = e.openShift(e.register, 0)
    e.charge(e.register, e.openOrder(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.count(e.register, shift, 0, [res('card', 10_000), res('breb', 1_000)])
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('missing_justification')
    const two = e.count(e.register, shift, 0, [res('card', 10_000), res('breb', 999)])
    expect(reason(e.close(e.register, shift, two.cashCount, 0, 0))).toBe('confirmed')
  })

  it('a negative expected (a payment from a previous shift was voided) and nothing reported: the variance is the overage', () => {
    const e = environment()
    const t1 = e.openShift(e.register, 0)
    const order = e.openOrder(e.register)
    const payment = e.charge(e.register, order, e.cardPaymentData(t1, 5_000))
    const a1 = e.count(e.register, t1, 0, [res('card', 5_000)])
    expect(reason(e.close(e.register, t1, a1.cashCount, 0, 0))).toBe('confirmed')
    const t2 = e.openShift(e.register, 0)
    e.voidItem(e.register, order, payment, t2)
    const a2 = e.count(e.register, t2, 0, [])
    expect(e.linesOf(t2, a2.cashCount)).toEqual([line('card', -5_000, 0)])
    expect(reason(e.close(e.register, t2, a2.cashCount, 0, 0))).toBe('missing_justification')
    expect(
      reason(e.close(e.register, t2, a2.cashCount, 0, 0, { justification: 'Devolución de ayer' })),
    ).toBe('confirmed')
  })

  it('a day of only refunds: the close states the net as negative and balances without justification', () => {
    const e = environment()
    const t1 = e.openShift(e.register, 0)
    const order = e.openOrder(e.register)
    const payment = e.charge(e.register, order, e.cardPaymentData(t1, 5_000))
    const a1 = e.count(e.register, t1, 0, [res('card', 5_000)])
    expect(reason(e.close(e.register, t1, a1.cashCount, 0, 0))).toBe('confirmed')
    const t2 = e.openShift(e.register, 0)
    e.voidItem(e.register, order, payment, t2)
    const a2 = e.count(e.register, t2, 0, [res('card', -5_000)])
    expect(e.linesOf(t2, a2.cashCount)).toEqual([line('card', -5_000, -5_000)])
    expect(reason(e.close(e.register, t2, a2.cashCount, 0, 0))).toBe('confirmed')
    const saved = eventsOf(e.m)
      .filter((x) => x.type === 'ShiftClosed')
      .at(-1)
    expect(saved?.type === 'ShiftClosed' && saved.data.other_methods).toEqual([
      line('card', -5_000, -5_000),
    ])
  })

  it('reporting a negative when the expected is positive is a large variance', () => {
    expect(closesWith(1000, -1)).toBe('missing_justification')
  })

  it('the threshold that applies is the current one at close', () => {
    const e = environment({ threshold: 5_000 })
    const shift = e.openShift(e.register, 0)
    e.charge(e.register, e.openOrder(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.count(e.register, shift, 0, [res('card', 8_000)])
    e.cfg.threshold = 1_000
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('missing_justification')
    e.cfg.threshold = 5_000
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('confirmed')
  })

  it('a hub without checkout rules uses the default threshold ($1.000) for the other methods too', () => {
    const e = environment()
    const withoutRules = e.m.hub()
    const connection = connectionOf(e.m, e.register)
    const shift = newId()
    withoutRules.receiveBatch(connection, [
      e.raw(e.register, 'ShiftOpened', shift, { register_id: e.register.deviceId, base: 0 }),
    ])
    const order = newId()
    withoutRules.receiveBatch(connection, [
      e.raw(e.register, 'OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 1 }),
      e.raw(e.register, 'ItemAdded', order, item(100_000)),
    ])
    expect(
      reason(
        withoutRules.receiveBatch(connection, [
          e.raw(e.register, 'PaymentRecorded', order, e.nequiPaymentOf(shift, 10_000)),
        ]).results[0],
      ),
    ).toBe('confirmed')
    const tryAction = (reported: number) => {
      const cashCount = newId()
      withoutRules.receiveBatch(connection, [
        e.raw(e.register, 'CashCountRecorded', shift, {
          cash_count_id: cashCount,
          tally: [],
          counted_cash: 0,
          others: [res('nequi', reported)],
        }),
      ])
      return reason(
        withoutRules.receiveBatch(connection, [
          e.raw(e.register, 'ShiftClosed', shift, {
            cash_count_id: cashCount,
            expected_cash: 0,
            counted_cash: 0,
            variance: 0,
            justification: null,
            other_methods: [line('nequi', 10_000, reported)],
          }),
        ]).results[0],
      )
    }
    expect(tryAction(9_000)).toBe('missing_justification')
    expect(tryAction(9_001)).toBe('confirmed')
  })
})

describe('compatibility with 1.7: no digital payments', () => {
  it('a cash-only shift closes without the `other_methods` field and with the count without `others`', () => {
    const e = environment()
    const shift = e.openShift(e.register, 100_000)
    e.charge(e.register, e.openOrder(e.register), e.cashPaymentOf(shift, 30_000, 2_000))
    const { cashCount, result } = e.count(e.register, shift, 132_000)
    expect(reason(result)).toBe('confirmed')
    expect(
      reason(e.close(e.register, shift, cashCount, 132_000, 132_000, { withoutField: true })),
    ).toBe('confirmed')
    const saved = eventsOf(e.m).find((x) => x.type === 'ShiftClosed')
    expect(saved?.type === 'ShiftClosed' && saved.data.other_methods).toBeUndefined()
  })

  it('a shift without any payment, with `other_methods: []` or without the field', () => {
    for (const withoutField of [true, false]) {
      const e = environment()
      const shift = e.openShift(e.register, 5_000)
      const { cashCount } = e.count(e.register, shift, 5_000)
      expect(reason(e.close(e.register, shift, cashCount, 5_000, 5_000, { withoutField }))).toBe(
        'confirmed',
      )
    }
  })

  it('a count with 0 reports for methods without payments closes without the field (all-zero is omitted)', () => {
    const e = environment()
    const shift = e.openShift(e.register, 0)
    const { cashCount } = e.count(e.register, shift, 0, [
      res('card', 0),
      res('nequi', 0),
      res('other', 0, SODEXO),
    ])
    expect(reason(e.close(e.register, shift, cashCount, 0, 0, { withoutField: true }))).toBe(
      'confirmed',
    )
  })

  it('a shift with digital payments fully voided (net 0) closes without `other_methods`', () => {
    const e = environment()
    const shift = e.openShift(e.register, 0)
    const order = e.openOrder(e.register)
    const payment = e.charge(e.register, order, e.nequiPaymentOf(shift, 8_000, 800))
    e.voidItem(e.register, order, payment, shift)
    const { cashCount } = e.count(e.register, shift, 0)
    expect(reason(e.close(e.register, shift, cashCount, 0, 0, { withoutField: true }))).toBe(
      'confirmed',
    )
  })

  it('a shift with digital payments and a 1.7 count (without `others`) cannot close without saying so: the variance is the total', () => {
    const e = environment()
    const shift = e.openShift(e.register, 0)
    e.charge(e.register, e.openOrder(e.register), e.nequiPaymentOf(shift, 8_000))
    const { cashCount } = e.count(e.register, shift, 0)
    expect(reason(e.close(e.register, shift, cashCount, 0, 0, { withoutField: true }))).toBe(
      'other_methods_mismatch',
    )
    expect(e.linesOf(shift, cashCount)).toEqual([line('nequi', 8_000, 0)])
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('missing_justification')
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, { justification: 'Sin cierre de la app' }),
      ),
    ).toBe('confirmed')
  })
})

describe('hub restart with card and Nequi midway', () => {
  function halfway() {
    const e = environment()
    const shift = e.openShift(e.register, 100_000)
    const order = e.openOrder(e.register)
    e.charge(e.register, order, e.cardPaymentData(shift, 100_000, 10_000))
    e.charge(e.register, order, e.nequiPaymentOf(shift, 30_000))
    e.charge(e.register, order, e.customPaymentOf(shift, SODEXO, 20_000))
    const { cashCount } = e.count(e.register, shift, 100_000, [
      res('card', 108_000),
      res('nequi', 30_000),
      res('other', 20_000, SODEXO),
    ])
    return { ...e, shift, order, cashCount }
  }

  it('the count keeps what was reported per method', () => {
    const t = halfway()
    const before = t.status.hub.reconciliation(t.shift)
    const after = t.newHub().reconciliation(t.shift)
    expect(after).toEqual(before)
    expect(after?.cashCounts[0]?.others).toEqual([
      { method: 'card', customMethodId: null, reported: 108_000 },
      { method: 'nequi', customMethodId: null, reported: 30_000 },
      { method: 'other', customMethodId: SODEXO, reported: 20_000 },
    ])
  })

  it('after the restart, the close with the rebuilt lines is accepted and with others it is rejected', () => {
    const t = halfway()
    const restarted = t.newHub()
    const lines = t.linesOf(t.shift, t.cashCount, restarted)
    expect(lines).toEqual([
      line('card', 110_000, 108_000),
      line('nequi', 30_000, 30_000),
      line('other', 20_000, 20_000, SODEXO),
    ])
    expect(
      reason(
        t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, {
          hub: restarted,
          other_methods: lines.slice(1),
        }),
      ),
    ).toBe('other_methods_mismatch')
    expect(
      reason(
        t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, {
          hub: restarted,
          other_methods: lines,
        }),
      ),
    ).toBe('missing_justification')
    expect(
      reason(
        t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, {
          hub: restarted,
          other_methods: lines,
          justification: 'Propinas del cierre',
        }),
      ),
    ).toBe('confirmed')
    expect(restarted.openShift(t.register.deviceId)).toBeNull()
  })

  it('a shift closed with other methods stays closed after the restart', () => {
    const t = halfway()
    t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, {
      justification: 'Propinas del cierre',
    })
    const restarted = t.newHub()
    expect(restarted.openShift(t.register.deviceId)).toBeNull()
    expect(restarted.reconciliation(t.shift)?.closed).not.toBeNull()
    expect(
      reason(
        t.one(
          t.register,
          t.raw(t.register, 'CashCountRecorded', t.shift, {
            cash_count_id: newId(),
            tally: [],
            counted_cash: 0,
            others: [],
          }),
          restarted,
        ),
      ),
    ).toBe('no_shift')
  })

  it('a digital payment after the count still makes the count stale after the restart', () => {
    const t = halfway()
    t.charge(t.register, t.order, t.nequiPaymentOf(t.shift, 1_000))
    const restarted = t.newHub()
    expect(
      reason(t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, { hub: restarted })),
    ).toBe('stale_cash_count')
  })
})

describe('multi-restaurant: the other methods belong to each restaurant', () => {
  function two(thresholdB = 0) {
    const e = environment()
    const otherId = newId()
    e.m.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otherId, otherId, NOW, NOW)
    const hubB = new HubSync(new SqliteStore(e.m.db, otherId), {
      restaurantId: otherId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      access: openAccess,
      instance: 'hub-b',
      clock: e.m.network.isoTime,
      checkoutRules: () => ({ ...RULES, varianceThreshold: thresholdB }),
    })
    return { ...e, hubB }
  }
  const inB = (d: ReturnType<typeof two>, type: string, aggregate: string, data: unknown) =>
    reason(
      d.one(d.register, d.raw(d.register, type, aggregate, data, { base_sequence: 0 }), d.hubB),
    )

  it('A digital payments do not count in B: the same B shift closes without `other_methods`', () => {
    const d = two()
    const shiftA = d.openShift(d.register, 0)
    d.charge(d.register, d.openOrder(d.register), d.cardPaymentData(shiftA, 50_000))
    const shiftB = newId()
    expect(inB(d, 'ShiftOpened', shiftB, { register_id: d.register.deviceId, base: 0 })).toBe(
      'confirmed',
    )
    const cashCountB = newId()
    expect(
      inB(d, 'CashCountRecorded', shiftB, {
        cash_count_id: cashCountB,
        tally: [],
        counted_cash: 0,
        others: [],
      }),
    ).toBe('confirmed')
    expect(
      inB(d, 'ShiftClosed', shiftB, {
        cash_count_id: cashCountB,
        expected_cash: 0,
        counted_cash: 0,
        variance: 0,
        justification: null,
        other_methods: [],
      }),
    ).toBe('confirmed')
    // A's shift stays open and its card, expected.
    expect(d.status.hub.openShift(d.register.deviceId)?.id).toBe(shiftA)
    expect(d.status.hub.reconciliation(shiftA)?.byMethod).toMatchObject([
      { method: 'card', sale: 50_000 },
    ])
  })

  it('the close of A with its lines does not work in B (no_shift) and each balances with its own', () => {
    const d = two(1000)
    const shiftA = d.openShift(d.register, 0)
    d.charge(d.register, d.openOrder(d.register), d.cardPaymentData(shiftA, 50_000))
    const a = d.count(d.register, shiftA, 0, [res('card', 50_000)])
    expect(
      inB(d, 'ShiftClosed', shiftA, {
        cash_count_id: a.cashCount,
        expected_cash: 0,
        counted_cash: 0,
        variance: 0,
        justification: null,
        other_methods: d.linesOf(shiftA, a.cashCount),
      }),
    ).toBe('no_shift')

    const shiftB = newId()
    inB(d, 'ShiftOpened', shiftB, { register_id: d.register.deviceId, base: 0 })
    const orderB = d.openOrder(d.register, 1_000_000, d.hubB)
    d.charge(d.register, orderB, d.nequiPaymentOf(shiftB, 7_000), d.hubB)
    const cashCountB = newId()
    inB(d, 'CashCountRecorded', shiftB, {
      cash_count_id: cashCountB,
      tally: [],
      counted_cash: 0,
      others: [res('nequi', 7_000)],
    })
    expect(d.linesOf(shiftB, cashCountB, d.hubB)).toEqual([line('nequi', 7_000, 7_000)])
    expect(reason(d.close(d.register, shiftA, a.cashCount, 0, 0))).toBe('confirmed')
    expect(d.status.hub.openShift(d.register.deviceId)).toBeNull()
    // B's stays open until it is closed with its own.
    expect(d.hubB.openShift(d.register.deviceId)?.id).toBe(shiftB)
    expect(reason(d.close(d.register, shiftB, cashCountB, 0, 0, { hub: d.hubB }))).toBe('confirmed')
  })

  it('the threshold is per restaurant: a $500 card variance closes in A (1.000) and not in B (0)', () => {
    const d = two(0)
    const shiftA = d.openShift(d.register, 0)
    d.charge(d.register, d.openOrder(d.register), d.cardPaymentData(shiftA, 10_000))
    const a = d.count(d.register, shiftA, 0, [res('card', 9_500)])
    expect(reason(d.close(d.register, shiftA, a.cashCount, 0, 0))).toBe('confirmed')

    const shiftB = newId()
    inB(d, 'ShiftOpened', shiftB, { register_id: d.register.deviceId, base: 0 })
    const orderB = d.openOrder(d.register, 1_000_000, d.hubB)
    d.charge(d.register, orderB, d.cardPaymentData(shiftB, 10_000), d.hubB)
    const b = d.count(d.register, shiftB, 0, [res('card', 9_500)], d.hubB)
    expect(reason(d.close(d.register, shiftB, b.cashCount, 0, 0, { hub: d.hubB }))).toBe(
      'missing_justification',
    )
  })
})

describe('with the simulated network: the register closes with card and Nequi offline', () => {
  /** The register charges, counts with the reports and closes, all saved on the device. */
  async function registerCloses(
    register: NetNode,
    m: Setup,
    options: { reportedCard?: number } = {},
  ) {
    const shift = newId()
    const order = newId()
    const cashCount = newId()
    const registerShift = { aggregate_type: 'register_shift' } as never
    const payment = (method: 'card' | 'nequi', amount: number, tip = 0) => ({
      payment_id: newId(),
      check_id: null,
      register_shift_id: shift,
      method,
      amount,
      tip,
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: null,
      charge_reference: null,
    })
    await register.create(
      shift,
      'ShiftOpened',
      { register_id: register.deviceId, base: 10_000 },
      registerShift,
    )
    await register.create(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 })
    await register.create(order, 'ItemAdded', item(1_000_000))
    await register.create(order, 'PaymentRecorded', payment('nequi', 30_000, 3_000))
    const reported = options.reportedCard ?? 33_000
    await register.create(
      shift,
      'CashCountRecorded',
      {
        cash_count_id: cashCount,
        tally: [{ value: 10_000, quantity: 1 }],
        counted_cash: 10_000,
        others: [{ method: 'nequi', custom_method_id: null, reported }],
      },
      registerShift,
    )
    await register.create(
      shift,
      'ShiftClosed',
      {
        cash_count_id: cashCount,
        expected_cash: 10_000,
        counted_cash: 10_000,
        variance: 0,
        justification: reported === 33_000 ? null : 'No cuadró Nequi',
        other_methods: [
          {
            method: 'nequi',
            custom_method_id: null,
            expected: 33_000,
            reported,
            variance: reported - 33_000,
          },
        ],
      },
      registerShift,
    )
    expect(m).toBeDefined()
    return shift
  }
  const types = (m: Setup) => eventsOf(m).map((x) => x.type)
  const SIX = [
    'ShiftOpened',
    'OrderOpened',
    'ItemAdded',
    'PaymentRecorded',
    'CashCountRecorded',
    'ShiftClosed',
  ]

  it('all offline: on reconnect they are confirmed in order and the shift ends up closed', async () => {
    const m = setup()
    const register = m.network.device('register')
    await registerCloses(register, m)
    expect(await register.client.pendingList()).toBe(6)
    await m.network.connectAll()
    expect(types(m)).toEqual(SIX)
    expect(m.hub().openShift(register.deviceId)).toBeNull()
    expect(await register.client.pendingList()).toBe(0)
  })

  it('a batch duplicated by the network does not repeat the close', async () => {
    const m = setup()
    const register = m.network.device('register')
    await m.network.connectAll()
    register.rule('to_hub', 'push', 'duplicate', 6)
    await registerCloses(register, m)
    await m.network.settle()
    expect(types(m)).toEqual(SIX)
  })

  it('the hub goes down right when saving the close: the shift comes back open and the close arrives only once', async () => {
    const m = setup()
    const register = m.network.device('register')
    await m.network.connectAll()
    if (m.store instanceof CrashingStore) m.store.crashAt = 6
    await registerCloses(register, m)
    await m.network.settle()
    await m.network.connectAll()
    await m.network.settle()
    expect(types(m).filter((x) => x === 'ShiftClosed')).toHaveLength(1)
    expect(m.hub().openShift(register.deviceId)).toBeNull()
  })

  it('the hub goes down when saving the count with the reports: on return, the cash count and the close complete', async () => {
    const m = setup()
    const register = m.network.device('register')
    await m.network.connectAll()
    if (m.store instanceof CrashingStore) m.store.crashAt = 5
    await registerCloses(register, m)
    await m.network.settle()
    await m.network.connectAll()
    await m.network.settle()
    expect(types(m)).toEqual(SIX)
  })

  it('with the register clock 3 hours behind or a day ahead the close is still accepted', async () => {
    for (const offset of [-3 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]) {
      const m = setup()
      const register = m.network.device('register')
      register.offsetMs = offset
      await m.network.connectAll()
      await registerCloses(register, m)
      await m.network.settle()
      expect(types(m)).toEqual(SIX)
      expect(m.hub().openShift(register.deviceId)).toBeNull()
    }
  })

  it('a close with a different report and justification, offline, is accepted on reconnect', async () => {
    const m = setup()
    const register = m.network.device('register')
    await registerCloses(register, m, { reportedCard: 20_000 })
    await m.network.connectAll()
    expect(types(m)).toEqual(SIX)
  })
})
