import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  allocate,
  allocateOrderDiscount,
  allocateTip,
  breakDown,
  equalParts,
  expectedCash,
  ORDER_TOTAL_LIMIT,
  PRICE_LIMIT,
  percent,
  roundDiv,
  suggestedTip,
} from './'

// Cases from the "Casos de prueba de la tarea 0.5" table (docs/DINERO.md) not covered by
// money.test.ts.

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)

describe('rounding with maximum values', () => {
  it('loses no precision with BigInt far beyond a safe integer', () => {
    const large = 10n ** 40n
    expect(roundDiv(large, 1n)).toBe(large)
    expect(roundDiv(large, 3n)).toBe(3_333_333_333_333_333_333_333_333_333_333_333_333_333n)
    expect(roundDiv(2n * large, 3n)).toBe(6_666_666_666_666_666_666_666_666_666_666_666_666_667n)
    // Exactly half rounds up; a bit less does not.
    const b = 2n * 10n ** 20n
    expect(roundDiv(3n * b + 10n ** 20n, b)).toBe(4n)
    expect(roundDiv(3n * b + 10n ** 20n - 1n, b)).toBe(3n)
  })

  it('with the largest safe integer and with the order limit', () => {
    expect(roundDiv(BigInt(Number.MAX_SAFE_INTEGER), 2n)).toBe(4_503_599_627_370_496n)
    expect(roundDiv(BigInt(ORDER_TOTAL_LIMIT) * 100n * 10_000n, 10_800n)).toBe(925_925_925_926n)
  })

  it('property: matches a / b + (2 × (a mod b) ≥ b ? 1 : 0)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        (a, b) => {
          expect(roundDiv(a, b)).toBe(a / b + (2n * (a % b) >= b ? 1n : 0n))
        },
      ),
    )
  })
})

describe('tax breakdown: edges', () => {
  it.each([
    [200, 1481, 1482],
    [2500, 18_519, 18_518],
    [16_000, 118_519, 118_518],
    [29_900, 221_481, 221_482],
    [34_900, 258_519, 258_518],
    [40_300, 298_519, 298_518],
  ])(
    '$%d at 8 %%: the tax differs by exactly 1 hundredth from base × rate',
    (net, tax, taxOfBase) => {
      const d = breakDown(net, 800)
      expect(d.taxHundredths).toBe(tax)
      expect(d.baseHundredths + d.taxHundredths).toBe(net * 100)
      // What rounding base × 8 % would give: the value the accountant must validate.
      expect(Number(roundDiv(BigInt(d.baseHundredths) * 800n, 10_000n))).toBe(taxOfBase)
      expect(Math.abs(taxOfBase - d.taxHundredths)).toBe(1)
    },
  )

  it('maximum price of a line and of an order, staying within safe integers', () => {
    expect(breakDown(PRICE_LIMIT, 800)).toEqual({
      baseHundredths: 9_259_259_259,
      taxHundredths: 740_740_741,
    })
    expect(breakDown(ORDER_TOTAL_LIMIT, 800)).toEqual({
      baseHundredths: 925_925_925_926,
      taxHundredths: 74_074_074_074,
    })
    expect(breakDown(ORDER_TOTAL_LIMIT, 1900)).toEqual({
      baseHundredths: 840_336_134_454,
      taxHundredths: 159_663_865_546,
    })
    expect(breakDown(ORDER_TOTAL_LIMIT, 0).taxHundredths).toBe(0)
    for (const rate of [0, 800, 1900, 10_000]) {
      const d = breakDown(ORDER_TOTAL_LIMIT, rate)
      expect(Number.isSafeInteger(d.baseHundredths + d.taxHundredths)).toBe(true)
      expect(d.baseHundredths + d.taxHundredths).toBe(ORDER_TOTAL_LIMIT * 100)
    }
  })
})

describe('discounts: several without cascading and a $0 order', () => {
  it('two order discounts are computed on the same base, not one on top of the other', () => {
    const base = 53_800
    const firstDiscount = percent(base, 1000)
    const secondDiscount = percent(base, 1000)
    expect(firstDiscount).toBe(5380)
    expect(secondDiscount).toBe(5380)
    // Cascading, the second would be 4.842 (10 % of what is left).
    expect(secondDiscount).not.toBe(percent(base - firstDiscount, 1000))

    const lines = [40_900, 12_900]
    const a = allocateOrderDiscount(firstDiscount, lines) ?? []
    const leftover = lines.map((l, i) => l - (a[i] ?? 0))
    const b = allocateOrderDiscount(secondDiscount, leftover) ?? []
    expect(sum(a) + sum(b)).toBe(10_760)
    expect(lines.map((l, k) => l - (a[k] ?? 0) - (b[k] ?? 0))).toEqual([32_720, 10_320])
  })

  it('a $0 order accepts a $0 discount and rejects any other', () => {
    expect(percent(0, 10_000)).toBe(0)
    expect(allocateOrderDiscount(0, [0])).toEqual([0])
    expect(allocateOrderDiscount(0, [0, 0, 0])).toEqual([0, 0, 0])
    expect(allocateOrderDiscount(1, [0, 0])).toBeNull()
  })
})

describe('tip: split by custom amount', () => {
  it('is allocated by each check amount and adds up to the tip on the balance', () => {
    const tip = suggestedTip([{ net: 100_000, rate: 800 }], 1000)
    expect(tip).toBe(9259)
    const parts = allocateTip(tip, [70_000, 30_000])
    expect(parts).toEqual([6481, 2778])
    expect(sum(parts)).toBe(tip)
  })

  it('checks with amount 0 get 0 and, if all are 0, it is split equally', () => {
    expect(allocateTip(1000, [100_000, 0])).toEqual([1000, 0])
    expect(allocateTip(1001, [0, 0])).toEqual([501, 500])
  })
})

describe('check split: allocation of amounts', () => {
  it('one guest takes everything', () => {
    expect(equalParts(87_650, 1)).toEqual([87_650])
  })

  it('shared item 1/3: the bottle net is allocated by largest remainder', () => {
    expect(allocate(40_900, [1, 1, 1])).toEqual([13_634, 13_633, 13_633])
    // One check with 1/3 and another with 2/3.
    expect(allocate(40_900, [1, 2])).toEqual([13_633, 27_267])
  })

  it('several shared: each check adds its shares and the checks total the order', () => {
    const bottle = 40_900 // among 3
    const picada = 38_500 // among 2 of the 3
    const ownItems = [12_900, 0, 14_900]
    const fromBottle = allocate(bottle, [1, 1, 1])
    const fromPicada = allocate(picada, [1, 1, 0])
    const checks = ownItems.map((p, i) => p + (fromBottle[i] ?? 0) + (fromPicada[i] ?? 0))
    expect(checks).toEqual([12_900 + 13_634 + 19_250, 13_633 + 19_250, 14_900 + 13_633])
    expect(sum(checks)).toBe(sum(ownItems) + bottle + picada)
  })

  it('property: the checks add up to the total, with or without shared items', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            net: fc.integer({ min: 0, max: PRICE_LIMIT }),
            fractions: fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 2, maxLength: 5 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (items) => {
          const guests = 5
          const checks = Array<number>(guests).fill(0)
          for (const { net, fractions } of items) {
            const parts = allocate(net, fractions)
            parts.forEach((share, i) => {
              checks[i] = (checks[i] ?? 0) + share
            })
          }
          expect(sum(checks)).toBe(sum(items.map((i) => i.net)))
          for (const c of checks) expect(c).toBeGreaterThanOrEqual(0)
        },
      ),
    )
  })
})

describe('register: reversals', () => {
  it('the reversal of a voided cash payment is what was charged: amount + adjustment + tip', () => {
    const payment = { amount: 36_810, roundingAdjustment: -10, tip: 3000 }
    const charged = payment.amount + payment.roundingAdjustment + payment.tip
    const movements = {
      base: 200_000,
      payments: [payment],
      cashIn: [],
      cashOut: [],
      tipPayouts: [],
      partialWithdrawals: [],
    }
    expect(expectedCash({ ...movements, refunds: [] })).toBe(239_800)
    // Voided in the same shift: the drawer is back to how it opened.
    expect(expectedCash({ ...movements, refunds: [charged] })).toBe(200_000)
    // A partial sale refund and a tip refund subtract what left the drawer.
    expect(expectedCash({ ...movements, refunds: [10_000, 1000] })).toBe(228_800)
  })

  it('the void from an earlier shift does not show in this shift payment', () => {
    // The payment stayed in shift 1; the reversal is recorded in shift 2 and subtracts only there.
    const shift1 = expectedCash({
      base: 100_000,
      payments: [{ amount: 50_000, roundingAdjustment: 0, tip: 0 }],
      refunds: [],
      cashIn: [],
      cashOut: [],
      tipPayouts: [],
      partialWithdrawals: [],
    })
    const shift2 = expectedCash({
      base: shift1,
      payments: [],
      refunds: [50_000],
      cashIn: [],
      cashOut: [],
      tipPayouts: [],
      partialWithdrawals: [],
    })
    expect([shift1, shift2]).toEqual([150_000, 100_000])
  })
})
