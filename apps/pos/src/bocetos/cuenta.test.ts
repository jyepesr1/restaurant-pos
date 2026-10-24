import { cuadraEfectivo } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  enPartesIguales,
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

const l = (id: string, cantidad: number, precioUnitario: number, extras: number[] = []) => ({
  id,
  cantidad,
  precioUnitario,
  extras,
})

describe('total, saldo y propina (con @pos/core)', () => {
  it('total con cantidades y extras; saldo después de pagos', () => {
    expect(totalCuenta([])).toBe(0)
    expect(totalCuenta([l('a', 2, 30_000, [2_000]), l('b', 1, 40_000)])).toBe(104_000)
    expect(saldoDe(100_000, [{ monto: 40_000 }])).toBe(60_000)
  })

  it('propina sobre la base sin INC, como en DINERO.md', () => {
    expect(propinaSobre(100_000)).toBe(9_259)
    expect(propinaSobre(16_000)).toBe(1_481)
    expect(propinaSobre(257_500)).toBe(23_843)
    expect(propinaSobre(0)).toBe(0)
  })

  it('en efectivo la propina se sugiere redondeada a $100, la mitad a favor del cliente', () => {
    expect(propinaParaEfectivo(23_843)).toBe(23_800)
    expect(propinaParaEfectivo(9_259)).toBe(9_300)
    expect(propinaParaEfectivo(9_250)).toBe(9_200)
  })
})

describe('división', () => {
  it('partes iguales del saldo por mayor residuo', () => {
    expect(enPartesIguales(100_000, 3)).toEqual([33_334, 33_333, 33_333])
  })

  it('con pagos previos se divide el saldo y la propina de cada cuenta sale de él (DINERO.md)', () => {
    const montos = enPartesIguales(saldoDe(100_000, [{ monto: 40_000 }]), 2)
    expect(montos).toEqual([30_000, 30_000])
    expect(propinasDeCuentas(montos)).toEqual([2_778, 2_778])
  })

  it('por ítems, con uno compartido entre dos y lo no tomado en "sin asignar"', () => {
    const lineas = [l('pizza', 1, 44_900), l('vino', 1, 129_900), l('te', 1, 13_900)]
    const r = porItems(
      lineas,
      new Map([
        ['pizza', [0]],
        ['vino', [0, 1]],
      ]),
      2,
    )
    expect(r.montos).toEqual([44_900 + 64_950, 64_950])
    expect(r.sinAsignar).toBe(13_900)
  })

  it('un ítem entre tres reparte el residuo: 44.900 → 14.967 + 14.967 + 14.966', () => {
    const r = porItems([l('pizza', 1, 44_900)], new Map([['pizza', [0, 1, 2]]]), 3)
    expect(r.montos).toEqual([14_967, 14_967, 14_966])
  })

  it('quitar una cuenta devuelve a "sin asignar" lo suyo, sin romper la división', () => {
    const asignadas = new Map([
      ['pizza', [0, 2]],
      ['vino', [2]],
    ])
    const recortadas = recortarAsignaciones(asignadas, 2)
    expect([...recortadas]).toEqual([['pizza', [0]]])
    const r = porItems([l('pizza', 1, 44_900), l('vino', 1, 129_900)], recortadas, 2)
    expect(r).toEqual({ montos: [44_900, 0], sinAsignar: 129_900 })
  })

  it('las cuentas más lo no asignado suman siempre el total', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 200_000 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 3 }), { maxLength: 8 }),
        (precios, cuentas, quien) => {
          const lineas = precios.map((p, i) => l(`i${i}`, 1, p))
          const asignadas = new Map<string, number[]>()
          quien.forEach((de, i) => {
            const validas = [...new Set(de.filter((c) => c < cuentas))]
            if (i < lineas.length && validas.length > 0) asignadas.set(`i${i}`, validas)
          })
          const r = porItems(lineas, asignadas, cuentas)
          const suma = r.montos.reduce((s, m) => s + m, 0) + r.sinAsignar
          expect(suma).toBe(totalCuenta(lineas))
        },
      ),
    )
  })
})

describe('pagos', () => {
  const efectivo = (saldo: number, monto: number, propina: number, recibido: number) =>
    pagoEnEfectivo({ saldo, monto, propina, recibido })

  it('el pago que deja el saldo en 0 se redondea a $100, como en DINERO.md', () => {
    expect(efectivo(36_810, 36_810, 0, 40_000)).toMatchObject({
      cobrado: 36_800,
      ajuste: -10,
      cambio: 3_200,
    })
    expect(efectivo(36_850, 36_850, 0, 40_000)).toMatchObject({ cobrado: 36_800, ajuste: -50 })
    expect(efectivo(36_851, 36_851, 0, 40_000)).toMatchObject({
      cobrado: 36_900,
      ajuste: 49,
      cambio: 3_100,
    })
    expect(efectivo(36_860, 36_860, 0, 50_000)).toMatchObject({ cambio: 13_100 })
    expect(efectivo(36_800, 36_800, 0, 36_800)).toMatchObject({ ajuste: 0, cambio: 0, falta: 0 })
  })

  it('un saldo de $30 o $50 se cobra en $0', () => {
    expect(efectivo(30, 30, 0, 0)).toMatchObject({ cobrado: 0, ajuste: -30, falta: 0 })
    expect(efectivo(50, 50, 0, 0)).toMatchObject({ cobrado: 0, ajuste: -50 })
  })

  it('un abono (no deja el saldo en 0) no se redondea', () => {
    expect(efectivo(257_500, 100_050, 0, 100_050)).toMatchObject({ cobrado: 100_050, ajuste: 0 })
  })

  it('con propina: lo que falta y el cambio cuentan la propina', () => {
    expect(efectivo(36_800, 36_800, 3_400, 40_000)).toMatchObject({
      aEntregar: 40_200,
      cambio: 0,
      falta: 200,
    })
    expect(efectivo(257_500, 257_500, 23_800, 300_000)).toMatchObject({
      aEntregar: 281_300,
      cambio: 18_700,
    })
  })

  it('rechaza montos fuera del saldo, negativos o con decimales', () => {
    expect(() => efectivo(10_000, 0, 0, 10_000)).toThrow(RangeError)
    expect(() => efectivo(10_000, 10_001, 0, 20_000)).toThrow(RangeError)
    expect(() => efectivo(10_000, 10_000, -500, 10_000)).toThrow()
    expect(() => efectivo(10_000, 10_000, 0, 10_000.5)).toThrow()
    expect(() => pagoConTarjeta({ saldo: 10_000, monto: 10_000, propina: 0.5 })).toThrow()
  })

  it('en datáfono se aprueba venta + propina', () => {
    expect(pagoConTarjeta({ saldo: 257_500, monto: 128_750, propina: 11_922 })).toEqual({
      aprobado: 140_672,
    })
  })

  it('siempre cuadra: recibido = monto + ajuste + propina + cambio', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (saldo, parte, propina, extra) => {
          const monto = Math.max(1, Math.floor((saldo * parte) / 100))
          const base = efectivo(saldo, monto, propina, 0)
          const recibido = base.aEntregar + extra
          const r = efectivo(saldo, monto, propina, recibido)
          expect(r.falta).toBe(0)
          expect(
            cuadraEfectivo({
              monto,
              ajusteRedondeo: r.ajuste,
              propina,
              recibido,
              cambio: r.cambio,
            }),
          ).toBe(true)
        },
      ),
    )
  })
})
