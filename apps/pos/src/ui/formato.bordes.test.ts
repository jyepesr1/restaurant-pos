import { describe, expect, it } from 'vitest'
import { minutos, pesos } from './formato'

describe('formatos: bordes', () => {
  it('pesos con cuatro cifras lleva punto de miles ($1.000, no $1000)', () => {
    expect(pesos(1_000)).toBe('$1.000')
    expect(pesos(9_999)).toBe('$9.999')
    expect(pesos(999)).toBe('$999')
    expect(pesos(100_000_000)).toBe('$100.000.000')
  })

  it('pesos de cero negativo se ve como $0', () => {
    expect(pesos(-0)).toBe('$0')
  })

  it('pesos rechaza lo que no es un entero seguro', () => {
    expect(() => pesos(Number.NaN)).toThrow(RangeError)
    expect(() => pesos(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => pesos(2 ** 53)).toThrow(RangeError)
    expect(() => pesos(0.5)).toThrow(RangeError)
    expect(pesos(Number.MAX_SAFE_INTEGER)).toBe('$9.007.199.254.740.991')
  })

  it('minutos: límites de la hora y fracciones', () => {
    expect(minutos(0)).toBe('0 min')
    expect(minutos(59)).toBe('59 min')
    expect(minutos(60)).toBe('1 h 00')
    expect(minutos(125)).toBe('2 h 05')
    expect(minutos(59.9)).toBe('59 min')
    expect(minutos(61.7)).toBe('1 h 01')
    expect(minutos(600)).toBe('10 h 00')
  })
})
