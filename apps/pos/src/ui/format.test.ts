import { describe, expect, it } from 'vitest'
import { minutes, pesos } from './format'

describe('formats', () => {
  it('pesos with thousands dot and no decimals', () => {
    expect(pesos(40_900)).toBe('$40.900')
    expect(pesos(0)).toBe('$0')
    expect(pesos(1_234_567)).toBe('$1.234.567')
    expect(pesos(-1_500)).toBe('-$1.500')
    expect(() => pesos(10.5)).toThrow(RangeError)
  })

  it('minutes and hours', () => {
    expect(minutes(8)).toBe('8 min')
    expect(minutes(65)).toBe('1 h 05')
    expect(minutes(-3)).toBe('0 min')
  })
})
