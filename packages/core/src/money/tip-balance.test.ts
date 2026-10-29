import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { allocateTip, suggestedTip, tipOnAmount } from './tip'

// Tip on part of the order (docs/DINERO.md#propina-sugerida): the balance after earlier payments
// or what is split into checks.

const at8 = (net: number) => ({ net, rate: 800 })

describe('tipOnAmount', () => {
  it('with the whole order it is the usual suggested tip', () => {
    expect(tipOnAmount([at8(100_000)], 100_000, 1000)).toBe(9_259)
    expect(tipOnAmount([at8(16_000)], 16_000, 1000)).toBe(1_481)
    expect(tipOnAmount([at8(2_500)], 2_500, 1000)).toBe(231)
  })

  it('$100.000 at 8 % with $40.000 paid: $60.000 balance suggests 5.556 (2.778 + 2.778)', () => {
    const tip = tipOnAmount([at8(100_000)], 60_000, 1000)
    expect(tip).toBe(5_556)
    expect(allocateTip(tip, [30_000, 30_000])).toEqual([2_778, 2_778])
  })

  it('with different rates, each line contributes its pre-tax base', () => {
    // 50.000 at 8 % (base 46.296,30) + 50.000 exempt (base 50.000) = 96.296,30 → 10 % = 9.630.
    const lines = [at8(50_000), { net: 50_000, rate: 0 }]
    expect(tipOnAmount(lines, 100_000, 1000)).toBe(9_630)
    expect(tipOnAmount(lines, 50_000, 1000)).toBe(4_815)
  })

  it('an amount of 0 suggests 0, and one greater than the net is an error', () => {
    expect(tipOnAmount([at8(10_000)], 0, 1000)).toBe(0)
    expect(() => tipOnAmount([at8(10_000)], 10_001, 1000)).toThrow(RangeError)
    expect(() => tipOnAmount([at8(10_000)], 1.5, 1000)).toThrow()
  })

  it('with no suggested tip in the restaurant, 0', () => {
    expect(tipOnAmount([at8(100_000)], 60_000, 0)).toBe(0)
  })

  it('property: with the whole net it matches suggestedTip, and grows with the amount', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            net: fc.integer({ min: 0, max: 5_000_000 }),
            rate: fc.integer({ min: 0, max: 1900 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 1000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (lines, tipRate, f) => {
          const net = lines.reduce((a, l) => a + l.net, 0)
          expect(tipOnAmount(lines, net, tipRate)).toBe(suggestedTip(lines, tipRate))
          const share = Math.floor(net * f)
          const tip = tipOnAmount(lines, share, tipRate)
          expect(tip).toBeGreaterThanOrEqual(0)
          expect(tip).toBeLessThanOrEqual(suggestedTip(lines, tipRate))
        },
      ),
    )
  })
})
