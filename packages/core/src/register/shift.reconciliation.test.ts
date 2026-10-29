import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { cardPaymentData, cashPaymentData, event } from '../testing/factory'
import { type ChargedByMethod, chargedInShift, DENOMINATIONS, shiftReconciliation } from './shift'

// The shift reconciliation (task 1.7, docs/DINERO.md#caja): voids and refunds in the shift where
// they are recorded, custom methods, several counts and properties. Complements shift.test.ts.

type Data<T extends OrderEvent['type']> = Extract<OrderEvent, { type: T }>['data']
type Hub = { received_at?: string | null; hub_estimated_time?: string }

/** A shift with its opening and movement events, ready to build scenarios. */
function newShift(base = 0, extras: Hub = {}) {
  const id = newId()
  const register = newId()
  const shiftEvent = <T extends OrderEvent['type']>(type: T, data: unknown, hub: Hub = {}) =>
    event(id, type, data as never, { aggregate_type: 'register_shift', ...hub } as never)
  const opening = shiftEvent('ShiftOpened', { register_id: register, base }, extras)
  return {
    id,
    register,
    opening,
    shiftEvent,
    move: (
      type: 'cash_in' | 'cash_out' | 'tip_payout',
      amount: number,
      fields: Partial<Data<'CashMovementRecorded'>> = {},
      hub: Hub = {},
    ) =>
      shiftEvent(
        'CashMovementRecorded',
        {
          movement_id: newId(),
          type,
          amount,
          description: `Mov ${type}`,
          to_whom: type === 'tip_payout' ? 'Equipo' : null,
          days: type === 'tip_payout' ? ['2026-10-25'] : [],
          ...fields,
        },
        hub,
      ),
    cashCount: (tally: { value: number; quantity: number }[], hub: Hub = {}) => {
      const counted = tally.reduce((s, c) => s + c.value * c.quantity, 0)
      return shiftEvent(
        'CashCountRecorded',
        { cash_count_id: newId(), tally, counted_cash: counted },
        hub,
      )
    },
  }
}

const pay = (data: Data<'PaymentRecorded'>) => event(newId(), 'PaymentRecorded', data)
const voidItem = (payment: Data<'PaymentRecorded'>, shiftId: string) =>
  event(
    newId(),
    'PaymentVoided',
    { payment_id: payment.payment_id, register_shift_id: shiftId },
    { reason: 'Error de caja' },
  )
const issueRefund = (payment: Data<'PaymentRecorded'>, shiftId: string, sale: number, tip = 0) =>
  event(
    newId(),
    'RefundRecorded',
    {
      payment_id: payment.payment_id,
      refund_id: newId(),
      sale_amount: sale,
      tip_amount: tip,
      method: payment.method,
      register_shift_id: shiftId,
    },
    { reason: 'Devolución' },
  )
const card = (shift: string, amount: number, tip = 0) =>
  cardPaymentData(amount, { register_shift_id: shift, tip })
const own = (shift: string, customId: string, amount: number, tip = 0) =>
  cardPaymentData(amount, {
    register_shift_id: shift,
    method: 'other',
    custom_method_id: customId,
    tip,
    cardTerminal: null,
  } as never)
const nequi = (shift: string, amount: number, tip = 0) =>
  cardPaymentData(amount, { register_shift_id: shift, method: 'nequi', tip, cardTerminal: null })

describe('shiftReconciliation: the basics', () => {
  it('opening only: expected = base, with no charges, movements or counts', () => {
    const t = newShift(150_000)
    const c = shiftReconciliation([t.opening], t.id)
    expect(c).toMatchObject({
      shiftId: t.id,
      registerId: t.register,
      base: 150_000,
      byMethod: [],
      movements: [],
      cashCounts: [],
      closed: null,
      cash: {
        charged: 0,
        refunds: 0,
        cashIn: 0,
        cashOut: 0,
        tipPayouts: 0,
        expected: 150_000,
      },
    })
  })

  it('a $0 base is valid', () => {
    const t = newShift(0)
    expect(shiftReconciliation([t.opening], t.id)?.cash.expected).toBe(0)
  })

  it('a shift other than the requested one has no reconciliation, even with other shifts', () => {
    const t = newShift(10)
    expect(shiftReconciliation([t.opening], newId())).toBeNull()
  })

  it('with the close but no opening, no reconciliation', () => {
    const t = newShift(10)
    const closeout = t.shiftEvent('ShiftClosed', {
      cash_count_id: newId(),
      expected_cash: 10,
      counted_cash: 10,
      variance: 0,
      justification: null,
    })
    expect(shiftReconciliation([closeout], t.id)).toBeNull()
  })

  it('cash counts amount + adjustment + tip, not the tendered amount or the change', () => {
    const t = newShift(0)
    const p = cashPaymentData(36_810, {
      rounding_adjustment: -10,
      tip: 3_000,
      change: 5_000,
      register_shift_id: t.id,
    })
    // tendered = 36.810 − 10 + 3.000 + 5.000 = 44.800; the drawer keeps 39.800.
    expect(p.tendered).toBe(44_800)
    const c = shiftReconciliation([t.opening, pay(p)], t.id)
    expect(c?.cash.charged).toBe(39_800)
    expect(c?.cash.expected).toBe(39_800)
  })

  it('a card tip does not go into the drawer but does count in charged per method', () => {
    const t = newShift(10_000)
    const c = shiftReconciliation([t.opening, pay(card(t.id, 40_000, 4_000))], t.id)
    expect(c?.cash.expected).toBe(10_000)
    expect(c?.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 40_000, tip: 4_000, payments: 1 },
    ])
  })

  it('a payment from another shift (another register) is not included', () => {
    const t = newShift(0)
    const c = shiftReconciliation(
      [t.opening, pay(cashPaymentData(9_000, { register_shift_id: newId() }))],
      t.id,
    )
    expect(c?.cash.expected).toBe(0)
    expect(c?.byMethod).toEqual([])
  })

  it('each movement, with its description, recipient and hub time', () => {
    const t = newShift(0)
    const c = shiftReconciliation(
      [
        t.opening,
        t.move(
          'cash_in',
          5_000,
          { description: 'Cambio' },
          { received_at: '2026-10-26T15:00:00Z' },
        ),
        t.move(
          'cash_out',
          2_000,
          { description: 'Hielo' },
          { received_at: '2026-10-26T16:00:00Z' },
        ),
        t.move(
          'tip_payout',
          1_000,
          { description: 'Propinas', to_whom: 'Ana' },
          { received_at: null, hub_estimated_time: '2026-10-26T17:00:00Z' },
        ),
      ],
      t.id,
    )
    expect(c?.movements.map((m) => [m.type, m.amount, m.description, m.toWhom, m.time])).toEqual([
      ['cash_in', 5_000, 'Cambio', null, '2026-10-26T15:00:00Z'],
      ['cash_out', 2_000, 'Hielo', null, '2026-10-26T16:00:00Z'],
      ['tip_payout', 1_000, 'Propinas', 'Ana', '2026-10-26T17:00:00Z'],
    ])
    expect(c?.cash).toMatchObject({
      cashIn: 5_000,
      cashOut: 2_000,
      tipPayouts: 1_000,
      expected: 2_000,
    })
  })

  it('movements from another shift do not count', () => {
    const a = newShift(100)
    const b = newShift(200)
    const all = [a.opening, b.opening, a.move('cash_in', 50), b.move('cash_out', 70)]
    expect(shiftReconciliation(all, a.id)?.cash.expected).toBe(150)
    expect(shiftReconciliation(all, b.id)?.cash.expected).toBe(130)
    expect(shiftReconciliation(all, a.id)?.base).toBe(100)
  })

  it('cash out and tip payouts can leave expected negative (shown as is)', () => {
    const t = newShift(1_000)
    const c = shiftReconciliation([t.opening, t.move('cash_out', 5_000)], t.id)
    expect(c?.cash.expected).toBe(-4_000)
  })

  it('shift payments count even if they come before the opening in the list', () => {
    const t = newShift(1_000)
    const p = cashPaymentData(20_000, { register_shift_id: t.id })
    expect(shiftReconciliation([pay(p), t.opening], t.id)?.cash.expected).toBe(21_000)
  })
})

describe('shiftReconciliation: voids', () => {
  it('voiding in this shift a payment from this shift: cash goes back to the base', () => {
    const t = newShift(50_000)
    const p = cashPaymentData(20_000, {
      register_shift_id: t.id,
      tip: 2_000,
      rounding_adjustment: -40,
    })
    const c = shiftReconciliation([t.opening, pay(p), voidItem(p, t.id)], t.id)
    expect(c?.cash).toMatchObject({ charged: 21_960, refunds: 21_960, expected: 50_000 })
    expect(c?.byMethod).toEqual([])
  })

  it('voiding here a payment from an EARLIER shift subtracts from this drawer; the original is not counted here', () => {
    const oldOne = newShift(0)
    const today = newShift(100_000)
    const p = cashPaymentData(30_000, {
      register_shift_id: oldOne.id,
      tip: 3_000,
      rounding_adjustment: -20,
    })
    const events = [oldOne.opening, today.opening, pay(p), voidItem(p, today.id)]
    const c = shiftReconciliation(events, today.id)
    expect(c?.cash).toMatchObject({ charged: 0, refunds: 32_980, expected: 67_020 })
    expect(c?.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: -29_980, tip: -3_000, payments: -1 },
    ])
    // The earlier shift still sees its full charge: the void lands in the shift that records it.
    const v = shiftReconciliation(events, oldOne.id)
    expect(v?.cash).toMatchObject({ charged: 32_980, refunds: 0, expected: 32_980 })
    expect(v?.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 29_980, tip: 3_000, payments: 1 },
    ])
  })

  it('voiding a card payment does not touch cash and leaves card at zero (not shown)', () => {
    const t = newShift(10_000)
    const cardPay = card(t.id, 40_000, 4_000)
    const cashPay = cashPaymentData(5_000, { register_shift_id: t.id })
    const c = shiftReconciliation(
      [t.opening, pay(cardPay), pay(cashPay), voidItem(cardPay, t.id)],
      t.id,
    )
    expect(c?.cash).toMatchObject({ refunds: 0, expected: 15_000 })
    expect(c?.byMethod.map((m) => m.method)).toEqual(['cash'])
  })

  it('voiding a card payment from an earlier shift gives negative card amounts', () => {
    const oldOne = newShift(0)
    const today = newShift(0)
    const cardPay = card(oldOne.id, 40_000, 4_000)
    const c = shiftReconciliation(
      [oldOne.opening, today.opening, pay(cardPay), voidItem(cardPay, today.id)],
      today.id,
    )
    expect(c?.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: -40_000, tip: -4_000, payments: -1 },
    ])
    expect(c?.cash.expected).toBe(0)
  })

  it('a void of a payment not among the events is ignored without throwing', () => {
    const t = newShift(5_000)
    const ghost = cashPaymentData(1_000, { register_shift_id: t.id })
    const c = shiftReconciliation([t.opening, voidItem(ghost, t.id)], t.id)
    expect(c?.cash.expected).toBe(5_000)
    expect(c?.byMethod).toEqual([])
  })

  it('a void recorded in another shift does not subtract from this one', () => {
    const t = newShift(0)
    const p = cashPaymentData(8_000, { register_shift_id: t.id })
    const c = shiftReconciliation([t.opening, pay(p), voidItem(p, newId())], t.id)
    expect(c?.cash).toMatchObject({ charged: 8_000, refunds: 0, expected: 8_000 })
  })
})

describe('shiftReconciliation: refunds', () => {
  it('a cash refund subtracts sale and tip from the drawer, without counting as a payment', () => {
    const t = newShift(0)
    const p = cashPaymentData(50_000, { register_shift_id: t.id, tip: 5_000 })
    const c = shiftReconciliation([t.opening, pay(p), issueRefund(p, t.id, 10_000, 1_000)], t.id)
    expect(c?.cash).toMatchObject({ charged: 55_000, refunds: 11_000, expected: 44_000 })
    expect(c?.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 40_000, tip: 4_000, payments: 1 },
    ])
  })

  it('a refund of a tip alone (sale 0) also subtracts', () => {
    const t = newShift(0)
    const p = cashPaymentData(20_000, { register_shift_id: t.id, tip: 2_000 })
    const c = shiftReconciliation([t.opening, pay(p), issueRefund(p, t.id, 0, 2_000)], t.id)
    expect(c?.cash.expected).toBe(20_000)
  })

  it('several refunds of the same payment add up', () => {
    const t = newShift(0)
    const p = cashPaymentData(30_000, { register_shift_id: t.id })
    const c = shiftReconciliation(
      [t.opening, pay(p), issueRefund(p, t.id, 5_000), issueRefund(p, t.id, 7_000)],
      t.id,
    )
    expect(c?.cash).toMatchObject({ refunds: 12_000, expected: 18_000 })
  })

  it('refunding in this shift a payment from an earlier shift subtracts from this drawer', () => {
    const oldOne = newShift(0)
    const today = newShift(80_000)
    const p = cashPaymentData(25_000, { register_shift_id: oldOne.id })
    const events = [oldOne.opening, today.opening, pay(p), issueRefund(p, today.id, 5_000)]
    expect(shiftReconciliation(events, today.id)?.cash).toMatchObject({
      charged: 0,
      refunds: 5_000,
      expected: 75_000,
    })
    expect(shiftReconciliation(events, oldOne.id)?.cash.expected).toBe(25_000)
  })

  it('a card refund does not touch cash and subtracts from what was charged by card', () => {
    const t = newShift(1_000)
    const cardPay = card(t.id, 40_000, 4_000)
    const c = shiftReconciliation(
      [t.opening, pay(cardPay), issueRefund(cardPay, t.id, 15_000, 500)],
      t.id,
    )
    expect(c?.cash.expected).toBe(1_000)
    expect(c?.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 25_000, tip: 3_500, payments: 1 },
    ])
  })

  it('a refund recorded in another shift does not subtract from this one', () => {
    const t = newShift(0)
    const p = cashPaymentData(9_000, { register_shift_id: t.id })
    const c = shiftReconciliation([t.opening, pay(p), issueRefund(p, newId(), 3_000)], t.id)
    expect(c?.cash.expected).toBe(9_000)
  })

  it('a void and a refund in the same shift on different payments: each subtracts its own', () => {
    const t = newShift(0)
    const a = cashPaymentData(10_000, { register_shift_id: t.id, tip: 1_000 })
    const b = cashPaymentData(20_000, { register_shift_id: t.id })
    const c = shiftReconciliation(
      [t.opening, pay(a), pay(b), voidItem(a, t.id), issueRefund(b, t.id, 4_000)],
      t.id,
    )
    expect(c?.cash).toMatchObject({ charged: 31_000, refunds: 15_000, expected: 16_000 })
  })
})

describe('shiftReconciliation: custom methods and several methods', () => {
  const SODEXO = newId()
  const QR = newId()

  it('each custom and each standard method gets its own row, without mixing with cash', () => {
    const t = newShift(5_000)
    const c = shiftReconciliation(
      [
        t.opening,
        pay(own(t.id, SODEXO, 10_000, 500)),
        pay(own(t.id, QR, 8_000)),
        pay(own(t.id, SODEXO, 2_000)),
        pay(nequi(t.id, 7_000, 700)),
        pay(cashPaymentData(1_000, { register_shift_id: t.id })),
      ],
      t.id,
    )
    expect(c?.byMethod).toEqual([
      { method: 'other', customMethodId: SODEXO, sale: 12_000, tip: 500, payments: 2 },
      { method: 'other', customMethodId: QR, sale: 8_000, tip: 0, payments: 1 },
      { method: 'nequi', customMethodId: null, sale: 7_000, tip: 700, payments: 1 },
      { method: 'cash', customMethodId: null, sale: 1_000, tip: 0, payments: 1 },
    ])
    expect(c?.cash.expected).toBe(6_000)
  })

  it('voiding a custom method payment (even from another shift) subtracts from that method', () => {
    const oldOne = newShift(0)
    const today = newShift(0)
    const p = own(oldOne.id, SODEXO, 10_000, 1_000)
    const c = shiftReconciliation(
      [oldOne.opening, today.opening, pay(p), voidItem(p, today.id)],
      today.id,
    )
    expect(c?.byMethod).toEqual([
      { method: 'other', customMethodId: SODEXO, sale: -10_000, tip: -1_000, payments: -1 },
    ])
  })

  it('refunding a custom method stays in the same row as the payment', () => {
    const t = newShift(0)
    const p = own(t.id, QR, 10_000)
    const c = shiftReconciliation([t.opening, pay(p), issueRefund(p, t.id, 3_000)], t.id)
    expect(c?.byMethod).toEqual([
      { method: 'other', customMethodId: QR, sale: 7_000, tip: 0, payments: 1 },
    ])
  })

  it('chargedInShift without movements: [] and does not count payments from other shifts', () => {
    const t = newShift(0)
    expect(chargedInShift([], t.id)).toEqual([])
    expect(chargedInShift([pay(nequi(newId(), 100))], t.id)).toEqual([])
  })

  it('a method ending at 0 (payment and void) is not shown, but one with sale and tip is', () => {
    const t = newShift(0)
    const tipOnly = nequi(t.id, 100, 300)
    const c = chargedInShift([pay(tipOnly)], t.id)
    expect(c).toEqual([{ method: 'nequi', customMethodId: null, sale: 100, tip: 300, payments: 1 }])
    const pair = nequi(t.id, 100)
    expect(chargedInShift([pay(pair), voidItem(pair, t.id)], t.id)).toEqual([])
  })
})

describe('shiftReconciliation: counts and close', () => {
  it('several counts are all kept, in order, without changing expected', () => {
    const t = newShift(50_000)
    const a1 = t.cashCount([{ value: 20_000, quantity: 2 }], {
      received_at: '2026-10-26T20:00:00Z',
    })
    const a2 = t.cashCount(
      [
        { value: 20_000, quantity: 2 },
        { value: 10_000, quantity: 1 },
      ],
      { received_at: '2026-10-26T20:05:00Z' },
    )
    const c = shiftReconciliation([t.opening, a1, a2], t.id)
    expect(c?.cashCounts.map((a) => [a.id, a.counted, a.time])).toEqual([
      [a1.data.cash_count_id, 40_000, '2026-10-26T20:00:00Z'],
      [a2.data.cash_count_id, 50_000, '2026-10-26T20:05:00Z'],
    ])
    expect(c?.cashCounts[1]?.tally).toEqual([
      { value: 20_000, quantity: 2 },
      { value: 10_000, quantity: 1 },
    ])
    expect(c?.cash.expected).toBe(50_000)
    expect(c?.closed).toBeNull()
  })

  it('counts from another shift do not appear', () => {
    const a = newShift(0)
    const b = newShift(0)
    const c = shiftReconciliation(
      [a.opening, b.opening, b.cashCount([{ value: 1_000, quantity: 1 }])],
      a.id,
    )
    expect(c?.cashCounts).toEqual([])
  })

  it('the close is stored with expected, counted, variance, justification and time', () => {
    const t = newShift(10_000)
    const cc = t.cashCount([{ value: 5_000, quantity: 1 }])
    const closeout = t.shiftEvent(
      'ShiftClosed',
      {
        cash_count_id: cc.data.cash_count_id,
        expected_cash: 10_000,
        counted_cash: 5_000,
        variance: -5_000,
        justification: 'Faltó un vale',
      },
      { received_at: '2026-10-26T21:00:00Z' },
    )
    const c = shiftReconciliation([t.opening, cc, closeout], t.id)
    expect(c?.closed).toEqual({
      expected: 10_000,
      counted: 5_000,
      variance: -5_000,
      justification: 'Faltó un vale',
      otherMethods: [],
      time: '2026-10-26T21:00:00Z',
    })
  })

  it('the close of another shift does not close this one', () => {
    const a = newShift(0)
    const b = newShift(0)
    const closeoutB = b.shiftEvent('ShiftClosed', {
      cash_count_id: newId(),
      expected_cash: 0,
      counted_cash: 0,
      variance: 0,
      justification: null,
    })
    expect(shiftReconciliation([a.opening, b.opening, closeoutB], a.id)?.closed).toBeNull()
    expect(shiftReconciliation([a.opening, b.opening, closeoutB], b.id)?.closed).not.toBeNull()
  })
})

describe('shiftReconciliation: properties', () => {
  type PaymentGen = {
    method: 'cash' | 'card' | 'nequi'
    amount: number
    adjustment: number
    tip: number
    thisOne: boolean
  }

  type Op =
    | { k: 'void'; i: number; thisOne: boolean }
    | { k: 'refund'; i: number; thisOne: boolean; sale: number; tip: number }
    | { k: 'mov'; type: 'cash_in' | 'cash_out' | 'tip_payout'; amount: number }

  const arbPayment: fc.Arbitrary<PaymentGen> = fc.record({
    method: fc.constantFrom('cash', 'card', 'nequi'),
    amount: fc.integer({ min: 100, max: 500_000 }),
    adjustment: fc.integer({ min: -49, max: 50 }),
    tip: fc.integer({ min: 0, max: 50_000 }),
    thisOne: fc.boolean(),
  })
  const arbOp: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ k: fc.constant('void' as const), i: fc.nat(20), thisOne: fc.boolean() }),
    fc.record({
      k: fc.constant('refund' as const),
      i: fc.nat(20),
      thisOne: fc.boolean(),
      sale: fc.integer({ min: 1, max: 10_000 }),
      tip: fc.integer({ min: 0, max: 1_000 }),
    }),
    fc.record({
      k: fc.constant('mov' as const),
      type: fc.constantFrom('cash_in', 'cash_out', 'tip_payout'),
      amount: fc.integer({ min: 1, max: 100_000 }),
    }),
  )

  /** Builds the events and, alongside, expected computed by hand with the DINERO.md formula. */
  function build(base: number, payments: PaymentGen[], ops: Op[]) {
    const t = newShift(base)
    const other = newId()
    const events: OrderEvent[] = [t.opening]
    const data: Data<'PaymentRecorded'>[] = []
    let expected = base
    const byMethod = new Map<string, { sale: number; tip: number; payments: number }>()
    const add = (method: string, sale: number, tip: number, n: number) => {
      const m = byMethod.get(method) ?? { sale: 0, tip: 0, payments: 0 }
      m.sale += sale
      m.tip += tip
      m.payments += n
      byMethod.set(method, m)
    }
    for (const p of payments) {
      const shift = p.thisOne ? t.id : other
      const d =
        p.method === 'cash'
          ? cashPaymentData(p.amount, {
              rounding_adjustment: p.adjustment,
              tip: p.tip,
              register_shift_id: shift,
            })
          : p.method === 'card'
            ? card(shift, p.amount, p.tip)
            : nequi(shift, p.amount, p.tip)
      data.push(d)
      events.push(pay(d))
      if (p.thisOne) {
        const sale = p.method === 'cash' ? p.amount + p.adjustment : p.amount
        add(p.method, sale, p.tip, 1)
        if (p.method === 'cash') expected += p.amount + p.adjustment + p.tip
      }
    }
    for (const op of ops) {
      if (op.k === 'mov') {
        events.push(t.move(op.type, op.amount))
        expected += op.type === 'cash_in' ? op.amount : -op.amount
        continue
      }
      const d = data[op.i % data.length] as Data<'PaymentRecorded'>
      const p = payments[op.i % data.length] as PaymentGen
      const shift = op.thisOne ? t.id : other
      if (op.k === 'void') {
        events.push(voidItem(d, shift))
        if (!op.thisOne) continue
        const sale = p.method === 'cash' ? p.amount + p.adjustment : p.amount
        add(p.method, -sale, -p.tip, -1)
        if (p.method === 'cash') expected -= p.amount + p.adjustment + p.tip
      } else {
        events.push(issueRefund(d, shift, op.sale, op.tip))
        if (!op.thisOne) continue
        add(p.method, -op.sale, -op.tip, 0)
        if (p.method === 'cash') expected -= op.sale + op.tip
      }
    }
    return { t, events, expected, byMethod }
  }
  fc.sample(arbPayment, 1)[0] as ReturnType<typeof arbPayment.generate> extends never
    ? never
    : { method: string; amount: number; adjustment: number; tip: number; thisOne: boolean }

  const normal = (list: ChargedByMethod[]) =>
    list.map((m) => `${m.method}|${m.customMethodId}|${m.sale}|${m.tip}|${m.payments}`).sort()

  it('expected equals the DINERO.md formula and each method adds up its own', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(arbPayment, { minLength: 1, maxLength: 6 }),
        fc.array(arbOp, { maxLength: 10 }),
        (base, payments, ops) => {
          const { t, events, expected, byMethod } = build(base, payments, ops)
          const c = shiftReconciliation(events, t.id)
          expect(c?.cash.expected).toBe(expected)
          const desired = [...byMethod.entries()]
            .filter(([, m]) => m.sale !== 0 || m.tip !== 0 || m.payments !== 0)
            .map(([method, m]) => `${method}|null|${m.sale}|${m.tip}|${m.payments}`)
            .sort()
          expect(normal(c?.byMethod ?? [])).toEqual(desired)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('the order of the events does not change the totals', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(arbPayment, { minLength: 1, maxLength: 6 }),
        fc.array(arbOp, { maxLength: 10 }),
        fc.infiniteStream(fc.integer()),
        (base, payments, ops, random) => {
          const { t, events } = build(base, payments, ops)
          const keys = random.take(events.length)
          const shuffledEvents = [...events]
            .map((e, i) => ({ e, k: keys.next().value ?? i }))
            .sort((x, y) => x.k - y.k)
            .map((x) => x.e)
          const a = shiftReconciliation(events, t.id)
          const b = shiftReconciliation(shuffledEvents, t.id)
          expect(b?.cash).toEqual(a?.cash)
          expect(normal(b?.byMethod ?? [])).toEqual(normal(a?.byMethod ?? []))
          expect(b?.base).toBe(a?.base)
          expect([...(b?.movements ?? [])].map((m) => m.id).sort()).toEqual(
            [...(a?.movements ?? [])].map((m) => m.id).sort(),
          )
        },
      ),
      { numRuns: 200 },
    )
  })

  it('repeating the calculation gives the same result (no hidden state) and keeps the input', () => {
    fc.assert(
      fc.property(fc.array(arbPayment, { minLength: 1, maxLength: 4 }), (payments) => {
        const { t, events } = build(1_000, payments, [])
        const copy = JSON.stringify(events)
        expect(shiftReconciliation(events, t.id)).toEqual(shiftReconciliation(events, t.id))
        expect(JSON.stringify(events)).toBe(copy)
      }),
      { numRuns: 50 },
    )
  })
})

describe('DENOMINATIONS', () => {
  it('includes both the $1.000 bill and coin, and no value repeats with the same type', () => {
    const thousands = DENOMINATIONS.filter((d) => d.value === 1_000)
    expect(thousands.map((d) => d.type).sort()).toEqual(['bill', 'coin'])
    const keys = DENOMINATIONS.map((d) => `${d.value}|${d.type}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('from largest to smallest, from $100.000 to $50', () => {
    const values = DENOMINATIONS.map((d) => d.value)
    expect(values).toEqual([...values].sort((a, b) => b - a))
    expect(values[0]).toBe(100_000)
    expect(values.at(-1)).toBe(50)
  })

  it('$1.000 bill and coin together in the cash count add up to one row of value 1.000', () => {
    const t = newShift(0)
    // The screen combines bill and coin of the same value: 3 bills + 2 coins = 5 × 1.000.
    const a = t.cashCount([{ value: 1_000, quantity: 5 }])
    expect(shiftReconciliation([t.opening, a], t.id)?.cashCounts[0]?.counted).toBe(5_000)
  })
})
