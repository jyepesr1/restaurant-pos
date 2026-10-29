import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  allocate,
  allocateOrderDiscount,
  allocateTip,
  breakDown,
  cashBalances,
  chargedInCash,
  comp,
  equalParts,
  expectedCash,
  lineGross,
  PRICE_LIMIT,
  percent,
  QUANTITY_LIMIT,
  roundDiv,
  splitByItems,
  suggestedTip,
} from './'

const pesos = (max = PRICE_LIMIT) => fc.integer({ min: 0, max })
const add = (values: number[]) => values.reduce((a, b) => a + b, 0)

describe('round', () => {
  it('rounds half up', () => {
    expect(roundDiv(19425n, 10n)).toBe(1943n)
    expect(roundDiv(19424n, 10n)).toBe(1942n)
    expect(roundDiv(0n, 7n)).toBe(0n)
    expect(roundDiv(5n, 1n)).toBe(5n)
  })

  it('rejects negatives and a 0 divisor', () => {
    expect(() => roundDiv(-1n, 2n)).toThrow(RangeError)
    expect(() => roundDiv(1n, 0n)).toThrow(RangeError)
  })
})

describe('allocate by largest remainder', () => {
  it('100.000 split by 3 gives 33.334 + 33.333 + 33.333', () => {
    expect(equalParts(100_000, 3)).toEqual([33_334, 33_333, 33_333])
  })

  it('edge cases', () => {
    expect(equalParts(500, 1)).toEqual([500])
    expect(equalParts(0, 4)).toEqual([0, 0, 0, 0])
    expect(equalParts(2, 3)).toEqual([1, 1, 0])
    expect(allocate(10, [0, 0])).toEqual([5, 5])
    expect(allocate(0, [])).toEqual([])
  })

  it('always breaks ties the same way: the first one wins', () => {
    expect(allocate(1, [1, 1, 1])).toEqual([1, 0, 0])
    expect(allocate(1000, [10_000, 10_000, 10_000])).toEqual([334, 333, 333])
  })

  it('rejects invalid inputs', () => {
    expect(() => allocate(5, [])).toThrow(RangeError)
    expect(() => allocate(-1, [1])).toThrow(RangeError)
    expect(() => allocate(10, [1.5])).toThrow(RangeError)
    expect(() => equalParts(10, 0)).toThrow(RangeError)
  })

  it('property: the parts add up to the total, are ≥ 0 and are within 1 of the exact value', () => {
    fc.assert(
      fc.property(
        pesos(10_000_000_000),
        fc.array(pesos(), { minLength: 1, maxLength: 12 }),
        (total, p) => {
          const parts = allocate(total, p)
          expect(add(parts)).toBe(total)
          const sum = add(p) || p.length
          parts.forEach((share, i) => {
            expect(share).toBeGreaterThanOrEqual(0)
            const exactCount = (total * ((sum === p.length && add(p) === 0 ? 1 : p[i]) ?? 0)) / sum
            expect(Math.abs(share - exactCount)).toBeLessThan(1 + 1e-6)
          })
        },
      ),
    )
  })
})

describe('order line', () => {
  it('quantity × (price + extras)', () => {
    expect(lineGross(2, 12_900)).toBe(25_800)
    expect(lineGross(2, 39_900, [3000])).toBe(85_800)
    expect(lineGross(1, 40_900, [0])).toBe(40_900)
    expect(lineGross(QUANTITY_LIMIT, PRICE_LIMIT)).toBe(99_900_000_000)
  })

  it.each([0, -1, 1.5, 1000])('rejects quantity %d', (quantity) => {
    expect(() => lineGross(quantity, 1000)).toThrow(RangeError)
  })
})

describe('discounts', () => {
  it('percentage with a single rounding', () => {
    expect(percent(12_950, 1500)).toBe(1943)
    expect(percent(40_900, 1000)).toBe(4090)
    expect(percent(0, 1000)).toBe(0)
    expect(percent(40_900, 10_000)).toBe(40_900)
  })

  it.each([-1, 10_001, 7.5])('rejects percentage %d', (bp) => {
    expect(() => percent(1000, bp)).toThrow(RangeError)
  })

  it('comp of 1 of 3 beers', () => {
    expect(comp(1, 14_900)).toBe(14_900)
    expect(comp(2, 39_900, [3000])).toBe(85_800)
  })

  it('$5.000 off the order between 40.900 and 12.900 → 3.801 + 1.199', () => {
    expect(allocateOrderDiscount(5000, [40_900, 12_900])).toEqual([3801, 1199])
  })

  it('10 % off the order over a comped beer and a pizza: all to the pizza', () => {
    // The beer is already at 0 from its comp; the 10 % is computed on the 40.900 net.
    const discount = percent(0 + 40_900, 1000)
    expect(allocateOrderDiscount(discount, [0, 40_900])).toEqual([0, 4090])
  })

  it('two discounts adding up to 100 % with tied remainders leave no negatives', () => {
    const lines = [12_900, 12_950, 12_950]
    const base = add(lines)
    const firstAllocation = allocateOrderDiscount(percent(base, 500), lines) ?? []
    const leftover = lines.map((l, i) => l - (firstAllocation[i] ?? 0))
    const secondAllocation = allocateOrderDiscount(percent(base, 9500), leftover) ?? []

    expect(leftover.map((r, i) => r - (secondAllocation[i] ?? 0))).toEqual([0, 0, 0])
  })

  it('a discount greater than what is left is rejected', () => {
    expect(allocateOrderDiscount(50_000, [40_900])).toBeNull()
    expect(allocateOrderDiscount(0, [0, 0])).toEqual([0, 0])
    expect(allocateOrderDiscount(1, [0])).toBeNull()
  })

  it('property: the allocation adds up to the discount and no line goes negative', () => {
    fc.assert(
      fc.property(
        fc.array(pesos(), { minLength: 1, maxLength: 10 }),
        fc.nat(),
        (lines, seedValue) => {
          const total = add(lines)
          const discount = total === 0 ? 0 : seedValue % (total + 1)
          const parts = allocateOrderDiscount(discount, lines) ?? []
          expect(add(parts)).toBe(discount)
          for (const [i, share] of parts.entries()) {
            expect(share).toBeLessThanOrEqual(lines[i] ?? 0)
          }
        },
      ),
    )
  })
})

describe('tax breakdown', () => {
  it.each([
    [40_900, 800, 3_787_037, 302_963],
    [25_800, 800, 2_388_889, 191_111],
    [16_000, 800, 1_481_481, 118_519],
    [0, 800, 0, 0],
    [40_900, 0, 4_090_000, 0],
    [119_000, 1900, 10_000_000, 1_900_000],
  ])('%d at %d bp → base %d + tax %d', (net, rate, base, tax) => {
    expect(breakDown(net, rate)).toEqual({ baseHundredths: base, taxHundredths: tax })
  })

  it('prices where the tax differs by 1 hundredth from base × rate (pending validation)', () => {
    for (const price of [200, 2500, 16_000, 29_900, 34_900, 40_300]) {
      const { baseHundredths, taxHundredths } = breakDown(price, 800)
      expect(Math.abs(taxHundredths - (baseHundredths * 800) / 10_000)).toBeLessThanOrEqual(1)
    }
  })

  it('property: base + tax = net × 100 and the base does not exceed the total', () => {
    fc.assert(
      fc.property(pesos(10_000_000_000), fc.integer({ min: 0, max: 10_000 }), (net, rate) => {
        const { baseHundredths, taxHundredths } = breakDown(net, rate)
        expect(baseHundredths + taxHundredths).toBe(net * 100)
        expect(taxHundredths).toBeGreaterThanOrEqual(0)
      }),
    )
  })
})

describe('suggested tip', () => {
  it.each([
    [100_000, 9259],
    [16_000, 1481],
    [2500, 231],
    [48_420, 4483],
  ])('10 %% of %d at 8 %% → %d', (net, tip) => {
    expect(suggestedTip([{ net, rate: 800 }], 1000)).toBe(tip)
  })

  it('with mixed rates it adds the exact bases before rounding', () => {
    // 40.900 at 8 % (base 37.870,37) + 8.900 exempt (base 8.900) → 10 % of 46.770,37 = 4.677
    expect(
      suggestedTip(
        [
          { net: 40_900, rate: 800 },
          { net: 8900, rate: 0 },
        ],
        1000,
      ),
    ).toBe(4677)
  })

  it('rate 0 and no lines give 0', () => {
    expect(suggestedTip([{ net: 100_000, rate: 800 }], 0)).toBe(0)
    expect(suggestedTip([], 1000)).toBe(0)
  })

  it('the allocation across checks adds up to the tip on the split balance', () => {
    const tip = suggestedTip([{ net: 60_000, rate: 800 }], 1000)
    expect(tip).toBe(5556)
    expect(allocateTip(tip, [30_000, 30_000])).toEqual([2778, 2778])
  })
})

describe('cash', () => {
  it.each([
    [36_810, 36_800],
    [36_850, 36_800],
    [36_851, 36_900],
    [36_860, 36_900],
    [36_800, 36_800],
    [50, 0],
    [30, 0],
    [51, 100],
  ])('balance %d is charged %d', (balance, charged) => {
    expect(chargedInCash(balance, 100)).toBe(charged)
  })

  it('other modes and multiple 1', () => {
    expect(chargedInCash(36_850, 100, 'nearest_half_up')).toBe(36_900)
    expect(chargedInCash(36_899, 100, 'down')).toBe(36_800)
    expect(chargedInCash(36_801, 100, 'up')).toBe(36_900)
    expect(chargedInCash(36_810, 1)).toBe(36_810)
  })

  it('property: the adjustment never exceeds half a multiple', () => {
    fc.assert(
      fc.property(pesos(), (balance) => {
        const adjustment = chargedInCash(balance, 100) - balance
        expect(adjustment).toBeGreaterThanOrEqual(-50)
        expect(adjustment).toBeLessThanOrEqual(49)
      }),
    )
  })

  it('identity tendered = amount + adjustment + tip + change', () => {
    expect(
      cashBalances({
        amount: 36_810,
        roundingAdjustment: -10,
        tip: 0,
        tendered: 40_000,
        change: 3200,
      }),
    ).toBe(true)
    expect(
      cashBalances({
        amount: 36_860,
        roundingAdjustment: 40,
        tip: 0,
        tendered: 50_000,
        change: 13_100,
      }),
    ).toBe(true)
    expect(
      cashBalances({
        amount: 36_810,
        roundingAdjustment: 0,
        tip: 0,
        tendered: 40_000,
        change: 3200,
      }),
    ).toBe(false)
    expect(
      cashBalances({ amount: 100, roundingAdjustment: 0, tip: 0, tendered: 50, change: -50 }),
    ).toBe(false)
  })
})

describe('register', () => {
  it('expected cash in the DINERO.md example: 219.800', () => {
    expect(
      expectedCash({
        base: 200_000,
        payments: [{ amount: 36_810, roundingAdjustment: -10, tip: 3000 }],
        refunds: [],
        cashIn: [],
        cashOut: [],
        tipPayouts: [20_000],
        partialWithdrawals: [],
      }),
    ).toBe(219_800)
  })

  it('subtracts refunds, cash out and withdrawals and adds cash in', () => {
    expect(
      expectedCash({
        base: 100_000,
        payments: [{ amount: 50_000, roundingAdjustment: 0, tip: 5000 }],
        refunds: [10_000],
        cashIn: [20_000],
        cashOut: [5000],
        tipPayouts: [],
        partialWithdrawals: [50_000],
      }),
    ).toBe(110_000)
  })
})

describe('rounding mode', () => {
  it('half_even takes the half to the nearest even number', () => {
    expect(roundDiv(25n, 10n, 'half_even')).toBe(2n)
    expect(roundDiv(35n, 10n, 'half_even')).toBe(4n)
    expect(roundDiv(26n, 10n, 'half_even')).toBe(3n)
    expect(roundDiv(24n, 10n, 'half_even')).toBe(2n)
    expect(percent(12_950, 1500, 'half_even')).toBe(1942)
    expect(percent(12_950, 1500)).toBe(1943)
  })
})

describe('split by items', () => {
  const lines = [
    { itemId: 'pizza', net: 40_900 },
    { itemId: 'botella', net: 100_000 },
    { itemId: 'dessert', net: 24_900 },
  ]

  it('each pays their own, the bottle is shared in thirds and the dessert stays unassigned', () => {
    const oneThird = { n: 1, d: 3 }
    const r = splitByItems(
      lines,
      [
        { check: 0, itemId: 'pizza', fraction: { n: 1, d: 1 } },
        { check: 0, itemId: 'botella', fraction: oneThird },
        { check: 1, itemId: 'botella', fraction: oneThird },
        { check: 2, itemId: 'botella', fraction: oneThird },
      ],
      3,
    )

    expect(r).toEqual({ amounts: [74_234, 33_333, 33_333], unassigned: 24_900 })
  })

  it('a fraction taken halfway leaves the rest unassigned', () => {
    const r = splitByItems(
      [{ itemId: 'botella', net: 100_000 }],
      [{ check: 0, itemId: 'botella', fraction: { n: 1, d: 2 } }],
      1,
    )
    expect(r).toEqual({ amounts: [50_000], unassigned: 50_000 })
  })

  it('rejects fractions over 1, items from elsewhere and checks that do not exist', () => {
    expect(() =>
      splitByItems(
        lines,
        [
          { check: 0, itemId: 'pizza', fraction: { n: 2, d: 3 } },
          { check: 1, itemId: 'pizza', fraction: { n: 2, d: 3 } },
        ],
        2,
      ),
    ).toThrow(/más de 1/)
    expect(() =>
      splitByItems(lines, [{ check: 0, itemId: 'other', fraction: { n: 1, d: 1 } }], 1),
    ).toThrow(/no está/)
    expect(() =>
      splitByItems(lines, [{ check: 5, itemId: 'pizza', fraction: { n: 1, d: 1 } }], 2),
    ).toThrow(/cuenta/)
    expect(() => splitByItems(lines, [], 0)).toThrow(/al menos una/)
  })

  it('property: the checks plus the unassigned part add up to the total', () => {
    fc.assert(
      fc.property(
        fc.array(pesos(), { minLength: 1, maxLength: 6 }),
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.integer({ min: 1, max: 4 })), { maxLength: 12 }),
        (nets, rawAssignments) => {
          const items = nets.map((net, i) => ({ itemId: `i${i}`, net }))
          // At most 1/4 per assignment and 4 per item: they never exceed 1.
          const seenItems = new Map<string, number>()
          const assignments = rawAssignments.flatMap(([c, i, parts]) => {
            const itemId = `i${i % items.length}`
            const used = seenItems.get(itemId) ?? 0
            if (used >= 4) return []
            seenItems.set(itemId, used + 1)
            return [{ check: c % 3, itemId, fraction: { n: 1, d: 4 * parts } }]
          })
          const r = splitByItems(items, assignments, 3)
          expect(add(r.amounts) + r.unassigned).toBe(add(nets))
        },
      ),
    )
  })
})
