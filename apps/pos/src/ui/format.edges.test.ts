import { describe, expect, it } from 'vitest'
import { minutes, pesos } from './format'

describe('formats: edges', () => {
  it('pesos with four digits get a thousands dot ($1.000, not $1000)', () => {
    expect(pesos(1_000)).toBe('$1.000')
    expect(pesos(9_999)).toBe('$9.999')
    expect(pesos(999)).toBe('$999')
    expect(pesos(100_000_000)).toBe('$100.000.000')
  })

  it('negative zero pesos shows as $0', () => {
    expect(pesos(-0)).toBe('$0')
  })

  it('pesos rejects anything that is not a safe integer', () => {
    expect(() => pesos(Number.NaN)).toThrow(RangeError)
    expect(() => pesos(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => pesos(2 ** 53)).toThrow(RangeError)
    expect(() => pesos(0.5)).toThrow(RangeError)
    expect(pesos(Number.MAX_SAFE_INTEGER)).toBe('$9.007.199.254.740.991')
  })

  it('minutes: hour boundaries and fractions', () => {
    expect(minutes(0)).toBe('0 min')
    expect(minutes(59)).toBe('59 min')
    expect(minutes(60)).toBe('1 h 00')
    expect(minutes(125)).toBe('2 h 05')
    expect(minutes(59.9)).toBe('59 min')
    expect(minutes(61.7)).toBe('1 h 01')
    expect(minutes(600)).toBe('10 h 00')
  })
})
