import { describe, expect, it } from 'vitest'
import { validateNewEvent } from '../events/order'
import { newId } from '../id'
import { ORDER_TOTAL_LIMIT } from '../money'
import { TIME } from '../testing/factory'

// The closes of the other methods in the register events (task 1.8): `CashCountRecorded.others`
// (what the card terminal and the apps say, entered with the count) and `ShiftClosed.other_methods`
// (what was recorded, what was reported and the signed variance).

const envelope = (type: string, data: unknown) => ({
  id: newId(),
  type,
  schema_version: 1,
  aggregate_type: 'register_shift',
  aggregate_id: newId(),
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
})
const ok = (e: unknown) => validateNewEvent(e).ok
const errors = (e: unknown) => {
  const r = validateNewEvent(e)
  return r.ok ? [] : r.errors
}

const cashCount = (fields: Record<string, unknown> = {}) => ({
  cash_count_id: newId(),
  tally: [{ value: 20_000, quantity: 3 }],
  counted_cash: 60_000,
  ...fields,
})
const closeout = (fields: Record<string, unknown> = {}) => ({
  cash_count_id: newId(),
  expected_cash: 100_000,
  counted_cash: 100_000,
  variance: 0,
  justification: null,
  ...fields,
})
const report = (method: string, reported: number, own: string | null = null) => ({
  method,
  custom_method_id: own,
  reported,
})
const line = (method: string, expected: number, reported: number, own: string | null = null) => ({
  method,
  custom_method_id: own,
  expected,
  reported,
  variance: reported - expected,
})
const withOthers = (others: unknown) => envelope('CashCountRecorded', cashCount({ others }))
const withMethods = (other_methods: unknown) => envelope('ShiftClosed', closeout({ other_methods }))

describe('CashCountRecorded.others: schema', () => {
  it('is optional: a count from 1.7, without the field, is still valid', () => {
    expect(ok(envelope('CashCountRecorded', cashCount()))).toBe(true)
  })

  it('an empty list is valid', () => {
    expect(ok(withOthers([]))).toBe(true)
  })

  it('accepts the card and an app with its close', () => {
    expect(ok(withOthers([report('card', 250_000), report('nequi', 80_000)]))).toBe(true)
  })

  it.each(['card', 'nequi', 'daviplata', 'breb', 'transfer', 'voucher'])(
    'every non-cash method is valid: %s',
    (method) => {
      expect(ok(withOthers([report(method, 1_000)]))).toBe(true)
    },
  )

  it('cash does not go here: it is counted with bills and coins', () => {
    expect(ok(withOthers([report('cash', 1_000)]))).toBe(false)
    expect(ok(withOthers([report('card', 1_000), report('cash', 0)]))).toBe(false)
  })

  it('a method that does not exist is rejected', () => {
    expect(ok(withOthers([report('paypal', 1_000)]))).toBe(false)
  })

  it('a method cannot repeat', () => {
    expect(ok(withOthers([report('card', 1_000), report('card', 2_000)]))).toBe(false)
    expect(ok(withOthers([report('nequi', 0), report('nequi', 0)]))).toBe(false)
    expect(errors(withOthers([report('card', 1), report('card', 1)])).join()).toContain(
      'Un medio aparece dos veces',
    )
  })

  it('different methods do not count as repeated', () => {
    expect(ok(withOthers([report('card', 1), report('nequi', 1), report('daviplata', 1)]))).toBe(
      true,
    )
  })

  describe('the custom method says which one it is, and only that one', () => {
    const sodexo = newId()
    const qr = newId()

    it('"other" with its id is valid', () => {
      expect(ok(withOthers([report('other', 30_000, sodexo)]))).toBe(true)
    })

    it('"other" without an id is rejected', () => {
      expect(ok(withOthers([report('other', 30_000, null)]))).toBe(false)
    })

    it('a method that is not "other" with an id is rejected', () => {
      expect(ok(withOthers([report('card', 30_000, sodexo)]))).toBe(false)
      expect(ok(withOthers([report('nequi', 30_000, sodexo)]))).toBe(false)
    })

    it('two different custom methods are valid; the same one twice is not', () => {
      expect(ok(withOthers([report('other', 1, sodexo), report('other', 2, qr)]))).toBe(true)
      expect(ok(withOthers([report('other', 1, sodexo), report('other', 2, sodexo)]))).toBe(false)
    })

    it('a custom method and a standard one together are valid', () => {
      expect(ok(withOthers([report('other', 1, sodexo), report('card', 2)]))).toBe(true)
    })

    it('the custom method id must be a ULID', () => {
      expect(ok(withOthers([report('other', 1, 'sodexo')]))).toBe(false)
      expect(ok(withOthers([report('other', 1, '')]))).toBe(false)
    })
  })

  it('reported goes from −limit to +limit (a day of only refunds closes negative); a fraction or past the limit is rejected', () => {
    expect(ok(withOthers([report('card', 0)]))).toBe(true)
    expect(ok(withOthers([report('card', ORDER_TOTAL_LIMIT)]))).toBe(true)
    expect(ok(withOthers([report('card', -1)]))).toBe(true)
    expect(ok(withOthers([report('card', -ORDER_TOTAL_LIMIT)]))).toBe(true)
    expect(ok(withOthers([report('card', -ORDER_TOTAL_LIMIT - 1)]))).toBe(false)
    expect(ok(withOthers([report('card', -1.5)]))).toBe(false)
    expect(ok(withOthers([report('card', 1.5)]))).toBe(false)
    expect(ok(withOthers([report('card', ORDER_TOTAL_LIMIT + 1)]))).toBe(false)
    expect(ok(withOthers([report('card', Number.NaN)]))).toBe(false)
    expect(ok(withOthers([{ ...report('card', 1), reported: '1000' }]))).toBe(false)
  })

  it('up to 30 methods; 31 is rejected', () => {
    const ownOnes = (n: number) => Array.from({ length: n }, () => report('other', 1, newId()))
    const standard = ['card', 'nequi', 'daviplata', 'breb', 'transfer', 'voucher'].map((m) =>
      report(m, 1),
    )
    expect(ok(withOthers([...standard, ...ownOnes(24)]))).toBe(true)
    expect(ok(withOthers([...standard, ...ownOnes(25)]))).toBe(false)
  })

  it('strict schema: an extra field in a method is rejected', () => {
    expect(ok(withOthers([{ ...report('card', 1), expected: 1 }]))).toBe(false)
  })

  it('missing custom_method_id: rejected (it is nullable, not optional)', () => {
    expect(ok(withOthers([{ method: 'card', reported: 1 }]))).toBe(false)
  })

  it('not a list: rejected', () => {
    expect(ok(withOthers(null))).toBe(false)
    expect(ok(withOthers({ method: 'card', reported: 1 }))).toBe(false)
  })

  it('the cash count still requires its exact sum even with other methods', () => {
    expect(
      ok(
        envelope(
          'CashCountRecorded',
          cashCount({ counted_cash: 59_999, others: [report('card', 1)] }),
        ),
      ),
    ).toBe(false)
  })
})

describe('ShiftClosed.other_methods: schema', () => {
  it('is optional: a close from 1.7, without the field, is still valid', () => {
    expect(ok(envelope('ShiftClosed', closeout()))).toBe(true)
  })

  it('an empty list is valid', () => {
    expect(ok(withMethods([]))).toBe(true)
  })

  it('accepts shortage, overage and exact match per method', () => {
    expect(
      ok(
        withMethods([
          line('card', 250_000, 250_000),
          line('nequi', 80_000, 70_000),
          line('daviplata', 10_000, 15_000),
        ]),
      ),
    ).toBe(true)
  })

  it('the variance is reported − expected, signed: a flipped sign or one extra peso is rejected', () => {
    const wrong = (d: number) => withMethods([{ ...line('nequi', 80_000, 70_000), variance: d }])
    expect(ok(wrong(-10_000))).toBe(true)
    expect(ok(wrong(10_000))).toBe(false)
    expect(ok(wrong(-9_999))).toBe(false)
    expect(ok(wrong(0))).toBe(false)
    expect(errors(wrong(10_000)).join()).toContain('lo reportado menos lo esperado')
  })

  it('a single bad line spoils the close even if the others are fine', () => {
    expect(
      ok(withMethods([line('card', 1_000, 1_000), { ...line('nequi', 1_000, 0), variance: 0 }])),
    ).toBe(false)
  })

  it('expected can be negative (a payment from an earlier shift was voided in this one)', () => {
    expect(ok(withMethods([line('card', -5_000, 0)]))).toBe(true)
    expect(ok(withMethods([line('card', -5_000, 2_000)]))).toBe(true)
  })

  it('reported can be negative (only refunds) but not fractional; expected is not fractional either', () => {
    expect(ok(withMethods([line('card', 1_000, -1)]))).toBe(true)
    expect(ok(withMethods([line('card', -5_000, -5_000)]))).toBe(true)
    expect(ok(withMethods([line('card', 1_000, -ORDER_TOTAL_LIMIT - 1)]))).toBe(false)
    expect(ok(withMethods([line('card', 1_000, 0.5)]))).toBe(false)
    expect(ok(withMethods([line('card', 1_000.5, 1_000)]))).toBe(false)
  })

  it('cash does not go among the other methods', () => {
    expect(ok(withMethods([line('cash', 1_000, 1_000)]))).toBe(false)
  })

  it('limit bounds: expected goes from −limit to +limit; one more is rejected', () => {
    expect(ok(withMethods([line('card', ORDER_TOTAL_LIMIT, ORDER_TOTAL_LIMIT)]))).toBe(true)
    expect(ok(withMethods([line('card', -ORDER_TOTAL_LIMIT, 0)]))).toBe(true)
    expect(ok(withMethods([line('card', ORDER_TOTAL_LIMIT + 1, ORDER_TOTAL_LIMIT)]))).toBe(false)
    expect(ok(withMethods([line('card', -ORDER_TOTAL_LIMIT - 1, 0)]))).toBe(false)
    // The variance exceeds the limit even though expected and reported are valid.
    expect(ok(withMethods([line('card', -ORDER_TOTAL_LIMIT, ORDER_TOTAL_LIMIT)]))).toBe(false)
  })

  it('a custom method carries its id (ULID) or null', () => {
    const sodexo = newId()
    expect(ok(withMethods([line('other', 5_000, 5_000, sodexo)]))).toBe(true)
    expect(ok(withMethods([line('other', 5_000, 5_000, 'sodexo')]))).toBe(false)
  })

  it('a missing or extra field: rejected', () => {
    const { variance: _d, ...withoutVariance } = line('card', 1, 1)
    expect(ok(withMethods([withoutVariance]))).toBe(false)
    expect(ok(withMethods([{ ...line('card', 1, 1), extra: true }]))).toBe(false)
  })

  it('up to 30 lines', () => {
    const ownOnes = (n: number) => Array.from({ length: n }, () => line('other', 1, 1, newId()))
    expect(ok(withMethods(ownOnes(30)))).toBe(true)
    expect(ok(withMethods(ownOnes(31)))).toBe(false)
  })

  it('cash still requires its exact variance even with other methods', () => {
    expect(
      ok(envelope('ShiftClosed', closeout({ variance: 5, other_methods: [line('card', 1, 1)] }))),
    ).toBe(false)
  })
})
