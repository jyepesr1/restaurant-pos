import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { propinaSobreMonto, propinaSugerida, repartirPropina } from './propina'

// Propina de una parte del pedido (docs/DINERO.md#propina-sugerida): el saldo tras pagos previos o
// lo que se divide en cuentas.

const al8 = (neto: number) => ({ neto, tarifa: 800 })

describe('propinaSobreMonto', () => {
  it('con todo el pedido es la propina sugerida de siempre', () => {
    expect(propinaSobreMonto([al8(100_000)], 100_000, 1000)).toBe(9_259)
    expect(propinaSobreMonto([al8(16_000)], 16_000, 1000)).toBe(1_481)
    expect(propinaSobreMonto([al8(2_500)], 2_500, 1000)).toBe(231)
  })

  it('$100.000 al 8 % con $40.000 pagados: el saldo de $60.000 sugiere 5.556 (2.778 + 2.778)', () => {
    const propina = propinaSobreMonto([al8(100_000)], 60_000, 1000)
    expect(propina).toBe(5_556)
    expect(repartirPropina(propina, [30_000, 30_000])).toEqual([2_778, 2_778])
  })

  it('con tarifas distintas, cada línea aporta su base sin impuesto', () => {
    // 50.000 al 8 % (base 46.296,30) + 50.000 exento (base 50.000) = 96.296,30 → 10 % = 9.630.
    const lineas = [al8(50_000), { neto: 50_000, tarifa: 0 }]
    expect(propinaSobreMonto(lineas, 100_000, 1000)).toBe(9_630)
    expect(propinaSobreMonto(lineas, 50_000, 1000)).toBe(4_815)
  })

  it('un monto de 0 sugiere 0, y uno mayor que el neto es un error', () => {
    expect(propinaSobreMonto([al8(10_000)], 0, 1000)).toBe(0)
    expect(() => propinaSobreMonto([al8(10_000)], 10_001, 1000)).toThrow(RangeError)
    expect(() => propinaSobreMonto([al8(10_000)], 1.5, 1000)).toThrow()
  })

  it('sin propina sugerida en el restaurante, 0', () => {
    expect(propinaSobreMonto([al8(100_000)], 60_000, 0)).toBe(0)
  })

  it('propiedad: con todo el neto coincide con propinaSugerida, y crece con el monto', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            neto: fc.integer({ min: 0, max: 5_000_000 }),
            tarifa: fc.integer({ min: 0, max: 1900 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 1000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (lineas, tasa, f) => {
          const neto = lineas.reduce((a, l) => a + l.neto, 0)
          expect(propinaSobreMonto(lineas, neto, tasa)).toBe(propinaSugerida(lineas, tasa))
          const parte = Math.floor(neto * f)
          const propina = propinaSobreMonto(lineas, parte, tasa)
          expect(propina).toBeGreaterThanOrEqual(0)
          expect(propina).toBeLessThanOrEqual(propinaSugerida(lineas, tasa))
        },
      ),
    )
  })
})
