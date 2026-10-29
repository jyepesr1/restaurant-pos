import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { cardPaymentData, cashPaymentData, event } from '../testing/factory'
import {
  methodKeyOf,
  otherMethodsReconciliation,
  type ShiftCashCount,
  type ShiftReconciliation,
  shiftReconciliation,
} from './shift'

// Reconciliation of the other methods (task 1.8, docs/DINERO.md#caja): for each non-cash method,
// what was recorded (sale + tip − voids and refunds), what its closeout says, and the variance
// (reported − expected).

type Data<T extends OrderEvent['type']> = Extract<OrderEvent, { type: T }>['data']
type Hub = { received_at?: string | null; hub_estimated_time?: string }

const SODEXO = newId()
const QR = newId()

function newShift(base = 0) {
  const id = newId()
  const shiftEvent = <T extends OrderEvent['type']>(type: T, data: unknown, hub: Hub = {}) =>
    event(id, type, data as never, { aggregate_type: 'register_shift', ...hub } as never)
  return {
    id,
    shiftEvent,
    opening: shiftEvent('ShiftOpened', { register_id: newId(), base }),
    cashCount: (others?: { method: string; custom_method_id: string | null; reported: number }[]) =>
      shiftEvent('CashCountRecorded', {
        cash_count_id: newId(),
        tally: [],
        counted_cash: 0,
        ...(others ? { others } : {}),
      }),
  }
}

const report = (method: string, reported: number, own: string | null = null) => ({
  method,
  custom_method_id: own,
  reported,
})
const pay = (data: Data<'PaymentRecorded'>) => event(newId(), 'PaymentRecorded', data)
const card = (shift: string, amount: number, tip = 0) =>
  cardPaymentData(amount, { register_shift_id: shift, tip })
const nequi = (shift: string, amount: number, tip = 0) =>
  cardPaymentData(amount, { register_shift_id: shift, method: 'nequi', tip, cardTerminal: null })
const own = (shift: string, id: string, amount: number, tip = 0) =>
  cardPaymentData(amount, {
    register_shift_id: shift,
    method: 'other',
    custom_method_id: id,
    tip,
    cardTerminal: null,
  } as never)
const voidItem = (payment: Data<'PaymentRecorded'>, shift: string) =>
  event(
    newId(),
    'PaymentVoided',
    { payment_id: payment.payment_id, register_shift_id: shift },
    { reason: 'Error de caja' },
  )
const issueRefund = (payment: Data<'PaymentRecorded'>, shift: string, sale: number, tip = 0) =>
  event(
    newId(),
    'RefundRecorded',
    {
      payment_id: payment.payment_id,
      refund_id: newId(),
      sale_amount: sale,
      tip_amount: tip,
      method: payment.method,
      register_shift_id: shift,
    },
    { reason: 'Devolución' },
  )

/** The shift reconciliation with its payments and a count with what each method reported. */
function build(
  construct: (t: ReturnType<typeof newShift>) => {
    events: unknown[]
    others?: ReturnType<typeof report>[]
  },
) {
  const t = newShift()
  const { events, others } = construct(t)
  const tally = t.cashCount(others)
  const all = [t.opening, ...events, tally] as never[]
  const reconciliation = shiftReconciliation(all, t.id) as ShiftReconciliation
  const cashCount = reconciliation.cashCounts[0] as ShiftCashCount
  return {
    t,
    reconciliation,
    cashCount,
    others: otherMethodsReconciliation(reconciliation, cashCount),
  }
}

const search = (
  list: ReturnType<typeof otherMethodsReconciliation>,
  method: string,
  customMethodId: string | null = null,
) => list.find((l) => l.method === method && l.customMethodId === customMethodId)

describe('otherMethodsReconciliation: recorded against reported', () => {
  it('with no payments or reports: there is nothing to reconcile', () => {
    const { others } = build(() => ({ events: [] }))
    expect(others).toEqual([])
  })

  it('card and Nequi that match: variance 0 on each, with the tip included in expected', () => {
    const { others } = build((t) => ({
      events: [
        pay(card(t.id, 100_000, 10_000)),
        pay(card(t.id, 50_000)),
        pay(nequi(t.id, 30_000, 3_000)),
      ],
      others: [report('card', 160_000), report('nequi', 33_000)],
    }))
    expect(search(others, 'card')).toEqual({
      method: 'card',
      customMethodId: null,
      expected: 160_000,
      reported: 160_000,
      variance: 0,
    })
    expect(search(others, 'nequi')).toMatchObject({
      expected: 33_000,
      reported: 33_000,
      variance: 0,
    })
    expect(others).toHaveLength(2)
  })

  it('cash never shows up, even with payments', () => {
    const { others } = build((t) => ({
      events: [pay(cashPaymentData(30_000, { register_shift_id: t.id })), pay(card(t.id, 1_000))],
      others: [report('card', 1_000)],
    }))
    expect(others.map((o) => o.method)).toEqual(['card'])
  })

  it('with payments and no report: something was expected and 0 reported, variance is negative', () => {
    const { others } = build((t) => ({ events: [pay(card(t.id, 80_000, 8_000))] }))
    expect(others).toEqual([
      {
        method: 'card',
        customMethodId: null,
        expected: 88_000,
        reported: 0,
        variance: -88_000,
      },
    ])
  })

  it('a count from 1.7 (without `others`) with digital payments: all shows as not reported', () => {
    const { others } = build((t) => ({
      events: [pay(card(t.id, 5_000)), pay(nequi(t.id, 7_000))],
    }))
    expect(others.map((o) => [o.method, o.reported, o.variance])).toEqual([
      ['card', 0, -5_000],
      ['nequi', 0, -7_000],
    ])
  })

  it('reported without payments: a charge not recorded in the POS, variance is positive', () => {
    const { others } = build(() => ({ events: [], others: [report('nequi', 45_000)] }))
    expect(others).toEqual([
      { method: 'nequi', customMethodId: null, expected: 0, reported: 45_000, variance: 45_000 },
    ])
  })

  it('a method with payments reporting another value: shortage and overage with their sign', () => {
    const { others } = build((t) => ({
      events: [pay(card(t.id, 100_000)), pay(nequi(t.id, 20_000))],
      others: [report('card', 99_000), report('nequi', 25_000)],
    }))
    expect(search(others, 'card')?.variance).toBe(-1_000)
    expect(search(others, 'nequi')?.variance).toBe(5_000)
  })

  it('both at 0 do not show: it reported 0 and there were no payments', () => {
    const { others } = build(() => ({
      events: [],
      others: [report('card', 0), report('nequi', 0), report('other', 0, SODEXO)],
    }))
    expect(others).toEqual([])
  })

  it('both at 0 because of payments voided in the same shift: they do not show', () => {
    const { others } = build((t) => {
      const p = card(t.id, 40_000, 4_000)
      return {
        events: [pay(p), voidItem(p, t.id)],
        others: [report('card', 0)],
      }
    })
    expect(others).toEqual([])
  })

  it('expected 0 but it reported something: it shows (even if the payments were voided)', () => {
    const { others } = build((t) => {
      const p = card(t.id, 40_000)
      return { events: [pay(p), voidItem(p, t.id)], others: [report('card', 40_000)] }
    })
    expect(others).toEqual([
      { method: 'card', customMethodId: null, expected: 0, reported: 40_000, variance: 40_000 },
    ])
  })

  it('a 0 report for a method with payments shows its shortage (not confused with "no report")', () => {
    const { others } = build((t) => ({
      events: [pay(nequi(t.id, 9_000))],
      others: [report('nequi', 0)],
    }))
    expect(others).toEqual([
      { method: 'nequi', customMethodId: null, expected: 9_000, reported: 0, variance: -9_000 },
    ])
  })

  it('a payment from another shift does not count toward expected', () => {
    const { others } = build((t) => ({
      events: [pay(card(t.id, 10_000)), pay(card(newId(), 99_000))],
      others: [report('card', 10_000)],
    }))
    expect(others).toEqual([
      { method: 'card', customMethodId: null, expected: 10_000, reported: 10_000, variance: 0 },
    ])
  })
})

describe('otherMethodsReconciliation: voids and refunds', () => {
  it('a void in this shift subtracts sale and tip from expected', () => {
    const { others } = build((t) => {
      const a = card(t.id, 60_000, 6_000)
      const b = card(t.id, 40_000)
      return {
        events: [pay(a), pay(b), voidItem(a, t.id)],
        others: [report('card', 40_000)],
      }
    })
    expect(search(others, 'card')).toMatchObject({ expected: 40_000, variance: 0 })
  })

  it('a refund subtracts sale and tip, each one separately', () => {
    const { others } = build((t) => {
      const a = card(t.id, 100_000, 10_000)
      return {
        events: [pay(a), issueRefund(a, t.id, 30_000, 3_000)],
        others: [report('card', 77_000)],
      }
    })
    expect(search(others, 'card')).toMatchObject({ expected: 77_000, variance: 0 })
  })

  it('a tip-only refund leaves the sale whole', () => {
    const { others } = build((t) => {
      const a = nequi(t.id, 20_000, 2_000)
      return {
        events: [pay(a), issueRefund(a, t.id, 0, 2_000)],
        others: [report('nequi', 20_000)],
      }
    })
    expect(search(others, 'nequi')).toMatchObject({ expected: 20_000, variance: 0 })
  })

  it('voiding here a payment from an EARLIER shift: expected goes negative and, with no report, an overage', () => {
    const previous = newId()
    const { others } = build((t) => {
      const earlierPayment = card(previous, 25_000, 2_500)
      return { events: [pay(earlierPayment), voidItem(earlierPayment, t.id)] }
    })
    expect(others).toEqual([
      {
        method: 'card',
        customMethodId: null,
        expected: -27_500,
        reported: 0,
        variance: 27_500,
      },
    ])
  })

  it('a refund of an earlier payment, in this shift, subtracts from this shift expected', () => {
    const previous = newId()
    const { others } = build((t) => {
      const earlierPayment = nequi(previous, 25_000)
      return {
        events: [pay(earlierPayment), issueRefund(earlierPayment, t.id, 5_000)],
        others: [report('nequi', 0)],
      }
    })
    expect(search(others, 'nequi')).toMatchObject({
      expected: -5_000,
      reported: 0,
      variance: 5_000,
    })
  })

  it('voids and refunds from another shift do not subtract here', () => {
    const otherShift = newId()
    const { others } = build((t) => {
      const a = card(t.id, 50_000)
      return {
        events: [pay(a), voidItem(a, otherShift), issueRefund(a, otherShift, 10_000)],
        others: [report('card', 50_000)],
      }
    })
    expect(search(others, 'card')).toMatchObject({ expected: 50_000, variance: 0 })
  })

  it('voiding a cash payment does not touch the other methods', () => {
    const { others } = build((t) => {
      const cashPay = cashPaymentData(10_000, { register_shift_id: t.id })
      return {
        events: [pay(cashPay), pay(card(t.id, 5_000)), voidItem(cashPay, t.id)],
        others: [report('card', 5_000)],
      }
    })
    expect(others).toHaveLength(1)
    expect(others[0]).toMatchObject({ method: 'card', expected: 5_000, variance: 0 })
  })
})

describe('otherMethodsReconciliation: a day of only refunds', () => {
  it('negative expected and equally negative reported: it reconciles', () => {
    const previous = newId()
    const { others } = build((t) => {
      const earlierPayment = card(previous, 25_000, 2_500)
      return {
        events: [pay(earlierPayment), voidItem(earlierPayment, t.id)],
        others: [report('card', -27_500)],
      }
    })
    expect(others).toEqual([
      {
        method: 'card',
        customMethodId: null,
        expected: -27_500,
        reported: -27_500,
        variance: 0,
      },
    ])
  })

  it('negative reported without payments: it shows with its negative variance', () => {
    const { others } = build(() => ({ events: [], others: [report('nequi', -4_000)] }))
    expect(others).toEqual([
      { method: 'nequi', customMethodId: null, expected: 0, reported: -4_000, variance: -4_000 },
    ])
  })

  it('expected and reported of opposite sign that cancel out are not a 0 line: it shows', () => {
    const { others } = build((t) => ({
      events: [pay(card(t.id, 5_000))],
      others: [report('card', -5_000)],
    }))
    expect(others).toEqual([
      {
        method: 'card',
        customMethodId: null,
        expected: 5_000,
        reported: -5_000,
        variance: -10_000,
      },
    ])
  })
})

describe('methodKeyOf', () => {
  it('tells methods apart and each custom method; a standard one has no id', () => {
    expect(methodKeyOf({ method: 'card', customMethodId: null })).toBe('card:')
    expect(methodKeyOf({ method: 'other', customMethodId: SODEXO })).toBe(`other:${SODEXO}`)
    expect(methodKeyOf({ method: 'other', customMethodId: SODEXO })).not.toBe(
      methodKeyOf({ method: 'other', customMethodId: QR }),
    )
    expect(methodKeyOf({ method: 'nequi', customMethodId: null })).not.toBe(
      methodKeyOf({ method: 'daviplata', customMethodId: null }),
    )
  })
})

describe('otherMethodsReconciliation: custom methods', () => {
  it('each custom method gets its own line, apart from «other» without an id and standard ones', () => {
    const { others } = build((t) => ({
      events: [
        pay(own(t.id, SODEXO, 30_000)),
        pay(own(t.id, QR, 12_000, 1_000)),
        pay(card(t.id, 5_000)),
      ],
      others: [report('other', 30_000, SODEXO), report('other', 13_000, QR), report('card', 4_000)],
    }))
    expect(others).toHaveLength(3)
    expect(search(others, 'other', SODEXO)).toMatchObject({ expected: 30_000, variance: 0 })
    expect(search(others, 'other', QR)).toMatchObject({ expected: 13_000, variance: 0 })
    expect(search(others, 'card')).toMatchObject({ expected: 5_000, variance: -1_000 })
  })

  it('a custom method with payments and no report, and another reported without payments', () => {
    const { others } = build((t) => ({
      events: [pay(own(t.id, SODEXO, 30_000))],
      others: [report('other', 8_000, QR)],
    }))
    expect(search(others, 'other', SODEXO)).toMatchObject({
      expected: 30_000,
      reported: 0,
      variance: -30_000,
    })
    expect(search(others, 'other', QR)).toMatchObject({
      expected: 0,
      reported: 8_000,
      variance: 8_000,
    })
  })

  it('voiding a custom method payment subtracts from that method, not from the others', () => {
    const { others } = build((t) => {
      const a = own(t.id, SODEXO, 30_000)
      return {
        events: [pay(a), pay(own(t.id, QR, 10_000)), voidItem(a, t.id)],
        others: [report('other', 10_000, QR)],
      }
    })
    expect(others).toHaveLength(1)
    expect(search(others, 'other', QR)).toMatchObject({ expected: 10_000, variance: 0 })
  })

  it('refunding a custom method subtracts it from its line', () => {
    const { others } = build((t) => {
      const a = own(t.id, SODEXO, 30_000, 2_000)
      return {
        events: [pay(a), issueRefund(a, t.id, 5_000, 500)],
        others: [report('other', 26_500, SODEXO)],
      }
    })
    expect(search(others, 'other', SODEXO)).toMatchObject({ expected: 26_500, variance: 0 })
  })

  it('an archived custom method (no longer in the rules) with payments still shows', () => {
    // The calculation does not look at the rules: it only sees the shift payments.
    const { others } = build((t) => ({ events: [pay(own(t.id, newId(), 7_000))] }))
    expect(others).toHaveLength(1)
    expect(others[0]?.variance).toBe(-7_000)
  })
})

describe('otherMethodsReconciliation: order and purity', () => {
  it('first methods with payments (in the order they were charged), then the report-only ones', () => {
    const { others } = build((t) => ({
      events: [pay(nequi(t.id, 1_000)), pay(card(t.id, 2_000))],
      others: [report('daviplata', 3_000), report('card', 2_000)],
    }))
    expect(others.map((o) => o.method)).toEqual(['nequi', 'card', 'daviplata'])
  })

  it('does not change the reconciliation or the count it receives', () => {
    const { reconciliation, cashCount } = build((t) => ({
      events: [pay(card(t.id, 2_000))],
      others: [report('card', 1_000)],
    }))
    const before = JSON.stringify([reconciliation, cashCount])
    otherMethodsReconciliation(reconciliation, cashCount)
    expect(JSON.stringify([reconciliation, cashCount])).toBe(before)
  })

  it('repeating it gives the same result', () => {
    const { reconciliation, cashCount, others } = build((t) => ({
      events: [pay(card(t.id, 2_000)), pay(nequi(t.id, 500))],
      others: [report('card', 1_000)],
    }))
    expect(otherMethodsReconciliation(reconciliation, cashCount)).toEqual(others)
  })

  it('with a cash count whose `others` repeats a method (schema should prevent it): last report wins', () => {
    const t = newShift()
    const { reconciliation } = build(() => ({ events: [] }))
    const cashCount: ShiftCashCount = {
      id: newId(),
      tally: [],
      counted: 0,
      others: [
        { method: 'card', customMethodId: null, reported: 1_000 },
        { method: 'card', customMethodId: null, reported: 2_000 },
      ],
      time: '',
    }
    expect(t.id).toBeTruthy()
    expect(otherMethodsReconciliation(reconciliation, cashCount)).toEqual([
      { method: 'card', customMethodId: null, expected: 0, reported: 2_000, variance: 2_000 },
    ])
  })
})

describe('otherMethodsReconciliation: properties', () => {
  type PaymentGen = {
    method: 'card' | 'nequi' | 'daviplata' | 'own' | 'cash'
    amount: number
    tip: number
    action: 'nothing' | 'void' | 'issueRefund' | 'void_earlier'
    sale: number
  }
  const paymentGen = fc.record<PaymentGen>({
    method: fc.constantFrom('card', 'nequi', 'daviplata', 'own', 'cash'),
    amount: fc.integer({ min: 1, max: 500_000 }),
    tip: fc.integer({ min: 0, max: 50_000 }),
    action: fc.constantFrom('nothing', 'void', 'issueRefund', 'void_earlier'),
    sale: fc.integer({ min: 1, max: 500_000 }),
  })
  const reportsGen = fc.record({
    card: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    nequi: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    daviplata: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    own: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    qr: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
  })

  function scenario(payments: PaymentGen[], res: Record<string, number | undefined>) {
    const t = newShift()
    const previous = newId()
    const events: unknown[] = []
    for (const p of payments) {
      const base =
        p.method === 'cash'
          ? cashPaymentData(p.amount, { register_shift_id: t.id, tip: p.tip })
          : p.method === 'own'
            ? own(t.id, SODEXO, p.amount, p.tip)
            : p.method === 'nequi'
              ? nequi(t.id, p.amount, p.tip)
              : p.method === 'daviplata'
                ? { ...nequi(t.id, p.amount, p.tip), method: 'daviplata' as const }
                : card(t.id, p.amount, p.tip)
      if (p.action === 'void_earlier') {
        const earlierPayment = { ...base, register_shift_id: previous }
        events.push(pay(earlierPayment), voidItem(earlierPayment, t.id))
        continue
      }
      events.push(pay(base))
      if (p.action === 'void') events.push(voidItem(base, t.id))
      if (p.action === 'issueRefund')
        events.push(issueRefund(base, t.id, Math.min(p.sale, p.amount), 0))
    }
    const others = [
      res.card !== undefined && report('card', res.card),
      res.nequi !== undefined && report('nequi', res.nequi),
      res.daviplata !== undefined && report('daviplata', res.daviplata),
      res.own !== undefined && report('other', res.own, SODEXO),
      res.qr !== undefined && report('other', res.qr, QR),
    ].filter(Boolean) as ReturnType<typeof report>[]
    const cashCount = t.cashCount(others)
    const reconciliation = shiftReconciliation(
      [t.opening, ...events, cashCount] as never[],
      t.id,
    ) as ShiftReconciliation
    return { reconciliation, cashCount: reconciliation.cashCounts[0] as ShiftCashCount, others }
  }

  it('the sum of the variances equals reported minus expected (of the lines shown)', () => {
    fc.assert(
      fc.property(fc.array(paymentGen, { maxLength: 12 }), reportsGen, (payments, res) => {
        const { reconciliation, cashCount } = scenario(payments, res)
        const lines = otherMethodsReconciliation(reconciliation, cashCount)
        const dif = lines.reduce((s, l) => s + l.variance, 0)
        const reported = lines.reduce((s, l) => s + l.reported, 0)
        const expected = lines.reduce((s, l) => s + l.expected, 0)
        expect(dif).toBe(reported - expected)
        // And each line is reported − expected.
        for (const l of lines) expect(l.variance).toBe(l.reported - l.expected)
      }),
    )
  })

  it('reported across lines is what was reported, and expected is what the other methods recorded', () => {
    fc.assert(
      fc.property(fc.array(paymentGen, { maxLength: 12 }), reportsGen, (payments, res) => {
        const { reconciliation, cashCount } = scenario(payments, res)
        const lines = otherMethodsReconciliation(reconciliation, cashCount)
        const reported = cashCount.others.reduce((s, o) => s + o.reported, 0)
        const expected = reconciliation.byMethod
          .filter((m) => m.method !== 'cash')
          .reduce((s, m) => s + m.sale + m.tip, 0)
        expect(lines.reduce((s, l) => s + l.reported, 0)).toBe(reported)
        expect(lines.reduce((s, l) => s + l.expected, 0)).toBe(expected)
      }),
    )
  })

  it('no line has expected 0 with reported 0; cash never appears; no repeated keys', () => {
    fc.assert(
      fc.property(fc.array(paymentGen, { maxLength: 12 }), reportsGen, (payments, res) => {
        const { reconciliation, cashCount } = scenario(payments, res)
        const lines = otherMethodsReconciliation(reconciliation, cashCount)
        expect(lines.every((l) => l.expected !== 0 || l.reported !== 0)).toBe(true)
        expect(lines.every((l) => (l.method as string) !== 'cash')).toBe(true)
        const keys = lines.map((l) => `${l.method}:${l.customMethodId ?? ''}`)
        expect(new Set(keys).size).toBe(keys.length)
      }),
    )
  })

  it('reporting exactly the expected leaves every variance at 0', () => {
    fc.assert(
      fc.property(fc.array(paymentGen, { maxLength: 12 }), (payments) => {
        const { reconciliation } = scenario(payments, {})
        const exactCount: ShiftCashCount = {
          id: newId(),
          tally: [],
          counted: 0,
          others: reconciliation.byMethod.flatMap((m) =>
            m.method === 'cash'
              ? []
              : [
                  {
                    method: m.method,
                    customMethodId: m.customMethodId,
                    reported: m.sale + m.tip,
                  },
                ],
          ),
          time: '',
        }
        const lines = otherMethodsReconciliation(reconciliation, exactCount)
        for (const l of lines) expect(l.variance).toBe(0)
      }),
    )
  })

  it('the order of the payments does not change the variances', () => {
    fc.assert(
      fc.property(
        fc.array(
          paymentGen.filter((p) => p.action === 'nothing'),
          { maxLength: 10 },
        ),
        reportsGen,
        (payments, res) => {
          const a = scenario(payments, res)
          const b = scenario([...payments].reverse(), res)
          const norm = (x: ReturnType<typeof scenario>) =>
            otherMethodsReconciliation(x.reconciliation, x.cashCount)
              .map((l) => `${l.method}:${l.customMethodId ?? ''}:${l.expected}:${l.reported}`)
              .sort()
          expect(norm(a)).toEqual(norm(b))
        },
      ),
    )
  })
})

describe('shiftReconciliation: `others` of the cash count and `otherMethods` of the close', () => {
  it('a cash count without `others` (from 1.7) ends with `others: []`', () => {
    const t = newShift()
    const c = shiftReconciliation([t.opening, t.cashCount()] as never[], t.id)
    expect(c?.cashCounts[0]?.others).toEqual([])
  })

  it('the cash count stores what each method reported, with its custom method, in order', () => {
    const t = newShift()
    const c = shiftReconciliation(
      [
        t.opening,
        t.cashCount([report('card', 250_000), report('nequi', 0), report('other', 30_000, SODEXO)]),
      ] as never[],
      t.id,
    )
    expect(c?.cashCounts[0]?.others).toEqual([
      { method: 'card', customMethodId: null, reported: 250_000 },
      { method: 'nequi', customMethodId: null, reported: 0 },
      { method: 'other', customMethodId: SODEXO, reported: 30_000 },
    ])
  })

  it('several counts: each one with its own reports', () => {
    const t = newShift()
    const c = shiftReconciliation(
      [
        t.opening,
        t.cashCount([report('card', 1_000)]),
        t.cashCount([report('card', 2_000), report('nequi', 3_000)]),
      ] as never[],
      t.id,
    )
    expect(c?.cashCounts.map((a) => a.others.map((o) => o.reported))).toEqual([
      [1_000],
      [2_000, 3_000],
    ])
  })

  it('a count from another shift does not bring its reports here', () => {
    const a = newShift()
    const b = newShift()
    const c = shiftReconciliation(
      [a.opening, b.opening, b.cashCount([report('card', 9_000)])] as never[],
      a.id,
    )
    expect(c?.cashCounts).toEqual([])
  })

  it('the close stores the other methods with their expected, reported and signed variance', () => {
    const t = newShift(10_000)
    const cashCount = t.cashCount()
    const closeout = t.shiftEvent(
      'ShiftClosed',
      {
        cash_count_id: cashCount.data.cash_count_id,
        expected_cash: 10_000,
        counted_cash: 0,
        variance: -10_000,
        justification: 'Se pagó un domicilio',
        other_methods: [
          {
            method: 'card',
            custom_method_id: null,
            expected: 100_000,
            reported: 98_000,
            variance: -2_000,
          },
          {
            method: 'other',
            custom_method_id: SODEXO,
            expected: 0,
            reported: 5_000,
            variance: 5_000,
          },
        ],
      },
      { received_at: '2026-10-26T21:00:00Z' },
    )
    const c = shiftReconciliation([t.opening, cashCount, closeout] as never[], t.id)
    expect(c?.closed?.otherMethods).toEqual([
      {
        method: 'card',
        customMethodId: null,
        expected: 100_000,
        reported: 98_000,
        variance: -2_000,
      },
      { method: 'other', customMethodId: SODEXO, expected: 0, reported: 5_000, variance: 5_000 },
    ])
    expect(c?.closed?.time).toBe('2026-10-26T21:00:00Z')
  })

  it('a close from 1.7, without `other_methods`, ends with `otherMethods: []`', () => {
    const t = newShift(0)
    const cashCount = t.cashCount()
    const closeout = t.shiftEvent('ShiftClosed', {
      cash_count_id: cashCount.data.cash_count_id,
      expected_cash: 0,
      counted_cash: 0,
      variance: 0,
      justification: null,
    })
    expect(
      shiftReconciliation([t.opening, cashCount, closeout] as never[], t.id)?.closed?.otherMethods,
    ).toEqual([])
  })

  it('the close of another shift does not leave its methods in this one', () => {
    const a = newShift()
    const b = newShift()
    const closeoutB = b.shiftEvent('ShiftClosed', {
      cash_count_id: newId(),
      expected_cash: 0,
      counted_cash: 0,
      variance: 0,
      justification: null,
      other_methods: [
        { method: 'card', custom_method_id: null, expected: 1, reported: 1, variance: 0 },
      ],
    })
    expect(
      shiftReconciliation([a.opening, b.opening, closeoutB] as never[], a.id)?.closed,
    ).toBeNull()
  })

  it('the cash count reports do not change expected cash or what was charged per method', () => {
    const t = newShift(50_000)
    const without = shiftReconciliation(
      [t.opening, pay(card(t.id, 1_000)), t.cashCount()] as never[],
      t.id,
    )
    const withIt = shiftReconciliation(
      [t.opening, pay(card(t.id, 1_000)), t.cashCount([report('card', 9_999)])] as never[],
      t.id,
    )
    expect(withIt?.cash).toEqual(without?.cash)
    expect(withIt?.byMethod).toEqual(without?.byMethod)
  })
})
