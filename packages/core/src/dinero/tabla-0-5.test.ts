import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  desglosar,
  esperadoEfectivo,
  LIMITE_PRECIO,
  LIMITE_TOTAL_PEDIDO,
  partesIguales,
  porcentaje,
  propinaSugerida,
  redondear,
  repartir,
  repartirDescuentoPedido,
  repartirPropina,
} from '.'

// Casos de la tabla "Casos de prueba de la tarea 0.5" (docs/DINERO.md) que no cubre dinero.test.ts.

const suma = (valores: readonly number[]) => valores.reduce((a, b) => a + b, 0)

describe('redondeo con valores máximos', () => {
  it('no pierde precisión con BigInt mucho más allá de un entero seguro', () => {
    const grande = 10n ** 40n
    expect(redondear(grande, 1n)).toBe(grande)
    expect(redondear(grande, 3n)).toBe(3_333_333_333_333_333_333_333_333_333_333_333_333_333n)
    expect(redondear(2n * grande, 3n)).toBe(6_666_666_666_666_666_666_666_666_666_666_666_666_667n)
    // Exactamente la mitad sube; un poco menos, no.
    const b = 2n * 10n ** 20n
    expect(redondear(3n * b + 10n ** 20n, b)).toBe(4n)
    expect(redondear(3n * b + 10n ** 20n - 1n, b)).toBe(3n)
  })

  it('con el mayor entero seguro y con el tope de un pedido', () => {
    expect(redondear(BigInt(Number.MAX_SAFE_INTEGER), 2n)).toBe(4_503_599_627_370_496n)
    expect(redondear(BigInt(LIMITE_TOTAL_PEDIDO) * 100n * 10_000n, 10_800n)).toBe(925_925_925_926n)
  })

  it('propiedad: coincide con a / b + (2 × (a mod b) ≥ b ? 1 : 0)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        (a, b) => {
          expect(redondear(a, b)).toBe(a / b + (2n * (a % b) >= b ? 1n : 0n))
        },
      ),
    )
  })
})

describe('desglose fiscal: bordes', () => {
  it.each([
    [200, 1481, 1482],
    [2500, 18_519, 18_518],
    [16_000, 118_519, 118_518],
    [29_900, 221_481, 221_482],
    [34_900, 258_519, 258_518],
    [40_300, 298_519, 298_518],
  ])(
    '$%d al 8 %%: el impuesto difiere exactamente 1 centésima de base × tarifa',
    (neto, impuesto, impuestoDeLaBase) => {
      const d = desglosar(neto, 800)
      expect(d.impuestoCentesimas).toBe(impuesto)
      expect(d.baseCentesimas + d.impuestoCentesimas).toBe(neto * 100)
      // Lo que daría redondear base × 8 %: es el valor que el contador debe validar.
      expect(Number(redondear(BigInt(d.baseCentesimas) * 800n, 10_000n))).toBe(impuestoDeLaBase)
      expect(Math.abs(impuestoDeLaBase - d.impuestoCentesimas)).toBe(1)
    },
  )

  it('precio máximo de una línea y de un pedido, sin salirse de enteros seguros', () => {
    expect(desglosar(LIMITE_PRECIO, 800)).toEqual({
      baseCentesimas: 9_259_259_259,
      impuestoCentesimas: 740_740_741,
    })
    expect(desglosar(LIMITE_TOTAL_PEDIDO, 800)).toEqual({
      baseCentesimas: 925_925_925_926,
      impuestoCentesimas: 74_074_074_074,
    })
    expect(desglosar(LIMITE_TOTAL_PEDIDO, 1900)).toEqual({
      baseCentesimas: 840_336_134_454,
      impuestoCentesimas: 159_663_865_546,
    })
    expect(desglosar(LIMITE_TOTAL_PEDIDO, 0).impuestoCentesimas).toBe(0)
    for (const tarifa of [0, 800, 1900, 10_000]) {
      const d = desglosar(LIMITE_TOTAL_PEDIDO, tarifa)
      expect(Number.isSafeInteger(d.baseCentesimas + d.impuestoCentesimas)).toBe(true)
      expect(d.baseCentesimas + d.impuestoCentesimas).toBe(LIMITE_TOTAL_PEDIDO * 100)
    }
  })
})

describe('descuentos: varios sin cascada y pedido de $0', () => {
  it('dos descuentos del pedido se calculan sobre la misma base, no uno sobre el otro', () => {
    const base = 53_800
    const primero = porcentaje(base, 1000)
    const segundo = porcentaje(base, 1000)
    expect(primero).toBe(5380)
    expect(segundo).toBe(5380)
    // En cascada el segundo sería 4.842 (10 % de lo que queda).
    expect(segundo).not.toBe(porcentaje(base - primero, 1000))

    const lineas = [40_900, 12_900]
    const a = repartirDescuentoPedido(primero, lineas) ?? []
    const restantes = lineas.map((l, i) => l - (a[i] ?? 0))
    const b = repartirDescuentoPedido(segundo, restantes) ?? []
    expect(suma(a) + suma(b)).toBe(10_760)
    expect(lineas.map((l, k) => l - (a[k] ?? 0) - (b[k] ?? 0))).toEqual([32_720, 10_320])
  })

  it('un pedido de $0 acepta descuento de $0 y rechaza cualquier otro', () => {
    expect(porcentaje(0, 10_000)).toBe(0)
    expect(repartirDescuentoPedido(0, [0])).toEqual([0])
    expect(repartirDescuentoPedido(0, [0, 0, 0])).toEqual([0, 0, 0])
    expect(repartirDescuentoPedido(1, [0, 0])).toBeNull()
  })
})

describe('propina: división por monto libre', () => {
  it('se reparte en proporción al monto de cada cuenta y suma la propina del saldo', () => {
    const propina = propinaSugerida([{ neto: 100_000, tarifa: 800 }], 1000)
    expect(propina).toBe(9259)
    const partes = repartirPropina(propina, [70_000, 30_000])
    expect(partes).toEqual([6481, 2778])
    expect(suma(partes)).toBe(propina)
  })

  it('cuentas con monto 0 reciben 0 y, si todas son 0, se reparte en partes iguales', () => {
    expect(repartirPropina(1000, [100_000, 0])).toEqual([1000, 0])
    expect(repartirPropina(1001, [0, 0])).toEqual([501, 500])
  })
})

describe('división de la cuenta: reparto de montos', () => {
  it('un comensal se queda con todo', () => {
    expect(partesIguales(87_650, 1)).toEqual([87_650])
  })

  it('ítem compartido 1/3: el neto de la botella se reparte por mayor residuo', () => {
    expect(repartir(40_900, [1, 1, 1])).toEqual([13_634, 13_633, 13_633])
    // Una cuenta con 1/3 y otra con 2/3.
    expect(repartir(40_900, [1, 2])).toEqual([13_633, 27_267])
  })

  it('varios compartidos: cada cuenta suma sus partes y el total de las cuentas es el del pedido', () => {
    const botella = 40_900 // entre 3
    const picada = 38_500 // entre 2 de las 3
    const propios = [12_900, 0, 14_900]
    const deBotella = repartir(botella, [1, 1, 1])
    const dePicada = repartir(picada, [1, 1, 0])
    const cuentas = propios.map((p, i) => p + (deBotella[i] ?? 0) + (dePicada[i] ?? 0))
    expect(cuentas).toEqual([12_900 + 13_634 + 19_250, 13_633 + 19_250, 14_900 + 13_633])
    expect(suma(cuentas)).toBe(suma(propios) + botella + picada)
  })

  it('propiedad: la suma de las cuentas es el total, con ítems compartidos o no', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            neto: fc.integer({ min: 0, max: LIMITE_PRECIO }),
            fracciones: fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 2, maxLength: 5 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (items) => {
          const comensales = 5
          const cuentas = Array<number>(comensales).fill(0)
          for (const { neto, fracciones } of items) {
            const partes = repartir(neto, fracciones)
            partes.forEach((parte, i) => {
              cuentas[i] = (cuentas[i] ?? 0) + parte
            })
          }
          expect(suma(cuentas)).toBe(suma(items.map((i) => i.neto)))
          for (const c of cuentas) expect(c).toBeGreaterThanOrEqual(0)
        },
      ),
    )
  })
})

describe('caja: reversas', () => {
  it('la reversa de un pago anulado en efectivo es lo que se cobró: monto + ajuste + propina', () => {
    const pago = { monto: 36_810, ajusteRedondeo: -10, propina: 3000 }
    const cobrado = pago.monto + pago.ajusteRedondeo + pago.propina
    const movimientos = {
      base: 200_000,
      pagos: [pago],
      entradas: [],
      salidas: [],
      pagosPropinas: [],
      retirosParciales: [],
    }
    expect(esperadoEfectivo({ ...movimientos, devoluciones: [] })).toBe(239_800)
    // Anulado en el mismo turno: el cajón queda como al abrir.
    expect(esperadoEfectivo({ ...movimientos, devoluciones: [cobrado] })).toBe(200_000)
    // Un reembolso parcial de venta y otro de propina restan lo que salió del cajón.
    expect(esperadoEfectivo({ ...movimientos, devoluciones: [10_000, 1000] })).toBe(228_800)
  })

  it('la anulación de un turno anterior no aparece en el pago de este turno', () => {
    // El pago quedó en el turno 1; la reversa se registra en el turno 2 y resta solo allí.
    const turno1 = esperadoEfectivo({
      base: 100_000,
      pagos: [{ monto: 50_000, ajusteRedondeo: 0, propina: 0 }],
      devoluciones: [],
      entradas: [],
      salidas: [],
      pagosPropinas: [],
      retirosParciales: [],
    })
    const turno2 = esperadoEfectivo({
      base: turno1,
      pagos: [],
      devoluciones: [50_000],
      entradas: [],
      salidas: [],
      pagosPropinas: [],
      retirosParciales: [],
    })
    expect([turno1, turno2]).toEqual([150_000, 100_000])
  })
})
