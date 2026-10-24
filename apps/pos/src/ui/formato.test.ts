import { describe, expect, it } from 'vitest'
import { minutos, pesos } from './formato'

describe('formatos', () => {
  it('pesos con punto de miles y sin decimales', () => {
    expect(pesos(40_900)).toBe('$40.900')
    expect(pesos(0)).toBe('$0')
    expect(pesos(1_234_567)).toBe('$1.234.567')
    expect(pesos(-1_500)).toBe('-$1.500')
    expect(() => pesos(10.5)).toThrow(RangeError)
  })

  it('minutos y horas', () => {
    expect(minutos(8)).toBe('8 min')
    expect(minutos(65)).toBe('1 h 05')
    expect(minutos(-3)).toBe('0 min')
  })
})
