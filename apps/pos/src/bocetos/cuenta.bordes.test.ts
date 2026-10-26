import { describe, expect, it } from 'vitest'
import {
  enPartesIguales,
  netoLinea,
  pagoConTarjeta,
  pagoEnEfectivo,
  porItems,
  propinaParaEfectivo,
  propinaSobre,
  propinasDeCuentas,
  recortarAsignaciones,
  saldoDe,
  totalCuenta,
} from './cuenta'

const l = (id: string, quantity: number, unitPrice: number, extras: number[] = []) => ({
  id,
  quantity,
  unitPrice,
  extras,
})

describe('cuenta: total, saldo y propina (bordes)', () => {
  it('el neto de una línea suma los extras: 2 × (39.900 + 3.000) = 85.800', () => {
    expect(netoLinea(l('a', 2, 39_900, [3_000]))).toBe(85_800)
  })

  it('el pedido de ejemplo de la mesa 12 suma 257.500 y su propina es 23.843', () => {
    const mesa12 = [
      l('a', 1, 44_900),
      l('b', 1, 40_900),
      l('c', 1, 27_900),
      l('d', 1, 129_900),
      l('e', 1, 13_900),
    ]
    expect(totalCuenta(mesa12)).toBe(257_500)
    expect(propinaSobre(totalCuenta(mesa12))).toBe(23_843)
  })

  it('la propina usa un solo redondeo: 2.500 → 231 (no 232)', () => {
    expect(propinaSobre(2_500)).toBe(231)
  })

  it('un saldo negativo o cero no deja propina', () => {
    expect(propinaSobre(0)).toBe(0)
    expect(propinaSobre(-1_000)).toBe(0)
  })

  it('totalCuenta rechaza un pedido que pasa del límite', () => {
    expect(() => totalCuenta([l('a', 999, 100_000_000)])).toThrow(RangeError)
  })

  it('saldoDe: varios pagos, y sin pagos es el total', () => {
    expect(saldoDe(257_500, [])).toBe(257_500)
    expect(saldoDe(257_500, [{ amount: 100_000 }, { amount: 57_500 }])).toBe(100_000)
    expect(saldoDe(257_500, [{ amount: 257_500 }])).toBe(0)
  })

  it('propina en efectivo: la mitad exacta va a favor del cliente y 0 sigue en 0', () => {
    expect(propinaParaEfectivo(0)).toBe(0)
    expect(propinaParaEfectivo(49)).toBe(0)
    expect(propinaParaEfectivo(50)).toBe(0)
    expect(propinaParaEfectivo(51)).toBe(100)
    expect(propinaParaEfectivo(100)).toBe(100)
  })
})

describe('cuenta: partes iguales y propinas por cuenta', () => {
  it('una persona paga todo; el saldo 0 reparte ceros', () => {
    expect(enPartesIguales(257_500, 1)).toEqual([257_500])
    expect(enPartesIguales(0, 4)).toEqual([0, 0, 0, 0])
  })

  it('257.500 entre 3: el peso sobrante va a la primera cuenta', () => {
    expect(enPartesIguales(257_500, 3)).toEqual([85_834, 85_833, 85_833])
  })

  it('la propina de las cuentas suma la propina del saldo (23.843 entre 2 → 11.922 + 11.921)', () => {
    const tips = propinasDeCuentas(enPartesIguales(257_500, 2))
    expect(tips).toEqual([11_922, 11_921])
  })

  it('para cualquier número de personas, las propinas suman la del saldo', () => {
    for (let people = 2; people <= 20; people++) {
      const amounts = enPartesIguales(257_500, people)
      const tips = propinasDeCuentas(amounts)
      expect(tips.reduce((a, b) => a + b, 0)).toBe(propinaSobre(257_500))
    }
  })

  it('sin montos que repartir, todas las propinas son 0', () => {
    expect(propinasDeCuentas([0, 0])).toEqual([0, 0])
    expect(propinasDeCuentas([])).toEqual([])
  })
})

describe('cuenta: por ítems (bordes)', () => {
  it('sin ninguna asignación todo queda sin asignar', () => {
    const r = porItems([l('a', 1, 10_000)], new Map(), 2)
    expect(r).toEqual({ amounts: [0, 0], unassigned: 10_000 })
  })

  it('el vino compartido por dos cuentas de la mesa 12 deja 137.750 y 119.750', () => {
    const lines = [
      l('quattro', 1, 44_900),
      l('tagliata', 1, 40_900),
      l('patatine', 1, 27_900),
      l('vino', 1, 129_900),
      l('te', 1, 13_900),
    ]
    const r = porItems(
      lines,
      new Map([
        ['quattro', [0]],
        ['patatine', [0]],
        ['tagliata', [1]],
        ['te', [1]],
        ['vino', [0, 1]],
      ]),
      2,
    )
    expect(r).toEqual({ amounts: [137_750, 119_750], unassigned: 0 })
  })

  it('una asignación a una cuenta que no existe se rechaza en el cálculo (por eso se recorta antes)', () => {
    expect(() => porItems([l('a', 1, 1_000)], new Map([['a', [2]]]), 2)).toThrow(RangeError)
  })

  it('recortar no toca lo que sigue siendo válido ni muta el mapa original', () => {
    const original = new Map([['a', [0, 1]]])
    expect([...recortarAsignaciones(original, 2)]).toEqual([['a', [0, 1]]])
    recortarAsignaciones(original, 1)
    expect(original.get('a')).toEqual([0, 1])
  })

  it('recortar a una cuenta deja solo la primera y quita ítems que quedan sin dueño', () => {
    const r = recortarAsignaciones(
      new Map([
        ['a', [0, 1]],
        ['b', [1]],
      ]),
      1,
    )
    expect([...r]).toEqual([['a', [0]]])
  })
})

describe('cuenta: pagos (bordes)', () => {
  it('el abono no se redondea y el pago final sí: 128.750 + 128.750 → se cobra 128.700', () => {
    const abono = pagoEnEfectivo({ balance: 257_500, amount: 128_750, tip: 11_900, tendered: 0 })
    expect(abono).toMatchObject({ charged: 128_750, adjustment: 0, aEntregar: 140_650 })
    const final = pagoEnEfectivo({ balance: 128_750, amount: 128_750, tip: 11_900, tendered: 0 })
    expect(final).toMatchObject({ charged: 128_700, adjustment: -50, aEntregar: 140_600 })
  })

  it('el mismo monto con saldo mayor nunca se redondea aunque termine en 50', () => {
    expect(
      pagoEnEfectivo({ balance: 100_000, amount: 36_850, tip: 0, tendered: 36_850 }).adjustment,
    ).toBe(0)
  })

  it('recibido 0 sin propina y monto > 0 falta todo lo cobrado', () => {
    expect(pagoEnEfectivo({ balance: 10_000, amount: 10_000, tip: 0, tendered: 0 })).toMatchObject({
      aEntregar: 10_000,
      missing: 10_000,
      change: 0,
    })
  })

  it('el cambio puede pasar a propina y entonces la cuenta vuelve a cuadrar sin cambio', () => {
    const before = pagoEnEfectivo({
      balance: 257_500,
      amount: 257_500,
      tip: 23_800,
      tendered: 300_000,
    })
    expect(before.change).toBe(18_700)
    const after = pagoEnEfectivo({
      balance: 257_500,
      amount: 257_500,
      tip: 23_800 + before.change,
      tendered: 300_000,
    })
    expect(after).toMatchObject({ change: 0, missing: 0, aEntregar: 300_000 })
  })

  it('tarjeta: venta + propina; rechaza monto 0 o mayor al saldo y propina negativa', () => {
    expect(pagoConTarjeta({ balance: 100, amount: 100, tip: 0 })).toEqual({ aprobado: 100 })
    expect(() => pagoConTarjeta({ balance: 100, amount: 0, tip: 0 })).toThrow(RangeError)
    expect(() => pagoConTarjeta({ balance: 100, amount: 101, tip: 0 })).toThrow(RangeError)
    expect(() => pagoConTarjeta({ balance: 100, amount: 100, tip: -1 })).toThrow()
  })
})
