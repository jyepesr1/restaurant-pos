import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  brutoLinea,
  cobradoEnEfectivo,
  cortesia,
  cuadraEfectivo,
  desglosar,
  dividirPorItems,
  esperadoEfectivo,
  LIMITE_CANTIDAD,
  LIMITE_PRECIO,
  partesIguales,
  porcentaje,
  propinaSugerida,
  redondear,
  repartir,
  repartirDescuentoPedido,
  repartirPropina,
} from '.'

const pesos = (max = LIMITE_PRECIO) => fc.integer({ min: 0, max })
const sumar = (valores: number[]) => valores.reduce((a, b) => a + b, 0)

describe('redondear', () => {
  it('redondea a la mitad hacia arriba', () => {
    expect(redondear(19425n, 10n)).toBe(1943n)
    expect(redondear(19424n, 10n)).toBe(1942n)
    expect(redondear(0n, 7n)).toBe(0n)
    expect(redondear(5n, 1n)).toBe(5n)
  })

  it('rechaza negativos y divisor 0', () => {
    expect(() => redondear(-1n, 2n)).toThrow(RangeError)
    expect(() => redondear(1n, 0n)).toThrow(RangeError)
  })
})

describe('repartir por mayor residuo', () => {
  it('100.000 entre 3 da 33.334 + 33.333 + 33.333', () => {
    expect(partesIguales(100_000, 3)).toEqual([33_334, 33_333, 33_333])
  })

  it('casos borde', () => {
    expect(partesIguales(500, 1)).toEqual([500])
    expect(partesIguales(0, 4)).toEqual([0, 0, 0, 0])
    expect(partesIguales(2, 3)).toEqual([1, 1, 0])
    expect(repartir(10, [0, 0])).toEqual([5, 5])
    expect(repartir(0, [])).toEqual([])
  })

  it('desempata siempre igual: el primero gana', () => {
    expect(repartir(1, [1, 1, 1])).toEqual([1, 0, 0])
    expect(repartir(1000, [10_000, 10_000, 10_000])).toEqual([334, 333, 333])
  })

  it('rechaza entradas inválidas', () => {
    expect(() => repartir(5, [])).toThrow(RangeError)
    expect(() => repartir(-1, [1])).toThrow(RangeError)
    expect(() => repartir(10, [1.5])).toThrow(RangeError)
    expect(() => partesIguales(10, 0)).toThrow(RangeError)
  })

  it('propiedad: las partes suman el total, son ≥ 0 y difieren de lo exacto en menos de 1', () => {
    fc.assert(
      fc.property(
        pesos(10_000_000_000),
        fc.array(pesos(), { minLength: 1, maxLength: 12 }),
        (total, p) => {
          const partes = repartir(total, p)
          expect(sumar(partes)).toBe(total)
          const suma = sumar(p) || p.length
          partes.forEach((parte, i) => {
            expect(parte).toBeGreaterThanOrEqual(0)
            const exacto = (total * ((suma === p.length && sumar(p) === 0 ? 1 : p[i]) ?? 0)) / suma
            expect(Math.abs(parte - exacto)).toBeLessThan(1 + 1e-6)
          })
        },
      ),
    )
  })
})

describe('línea de pedido', () => {
  it('cantidad × (precio + extras)', () => {
    expect(brutoLinea(2, 12_900)).toBe(25_800)
    expect(brutoLinea(2, 39_900, [3000])).toBe(85_800)
    expect(brutoLinea(1, 40_900, [0])).toBe(40_900)
    expect(brutoLinea(LIMITE_CANTIDAD, LIMITE_PRECIO)).toBe(99_900_000_000)
  })

  it.each([0, -1, 1.5, 1000])('rechaza la cantidad %d', (cantidad) => {
    expect(() => brutoLinea(cantidad, 1000)).toThrow(RangeError)
  })
})

describe('descuentos', () => {
  it('porcentaje con un solo redondeo', () => {
    expect(porcentaje(12_950, 1500)).toBe(1943)
    expect(porcentaje(40_900, 1000)).toBe(4090)
    expect(porcentaje(0, 1000)).toBe(0)
    expect(porcentaje(40_900, 10_000)).toBe(40_900)
  })

  it.each([-1, 10_001, 7.5])('rechaza el porcentaje %d', (bp) => {
    expect(() => porcentaje(1000, bp)).toThrow(RangeError)
  })

  it('cortesía de 1 de 3 cervezas', () => {
    expect(cortesia(1, 14_900)).toBe(14_900)
    expect(cortesia(2, 39_900, [3000])).toBe(85_800)
  })

  it('$5.000 al pedido entre 40.900 y 12.900 → 3.801 + 1.199', () => {
    expect(repartirDescuentoPedido(5000, [40_900, 12_900])).toEqual([3801, 1199])
  })

  it('10 % al pedido sobre cerveza en cortesía y pizza: todo a la pizza', () => {
    // La cerveza ya quedó en 0 por su cortesía; el 10 % se calcula sobre el neto 40.900.
    const descuento = porcentaje(0 + 40_900, 1000)
    expect(repartirDescuentoPedido(descuento, [0, 40_900])).toEqual([0, 4090])
  })

  it('dos descuentos que suman el 100 % con residuos empatados no dejan negativos', () => {
    const lineas = [12_900, 12_950, 12_950]
    const base = sumar(lineas)
    const primero = repartirDescuentoPedido(porcentaje(base, 500), lineas) ?? []
    const restantes = lineas.map((l, i) => l - (primero[i] ?? 0))
    const segundo = repartirDescuentoPedido(porcentaje(base, 9500), restantes) ?? []

    expect(restantes.map((r, i) => r - (segundo[i] ?? 0))).toEqual([0, 0, 0])
  })

  it('un descuento mayor que lo que queda se rechaza', () => {
    expect(repartirDescuentoPedido(50_000, [40_900])).toBeNull()
    expect(repartirDescuentoPedido(0, [0, 0])).toEqual([0, 0])
    expect(repartirDescuentoPedido(1, [0])).toBeNull()
  })

  it('propiedad: el reparto suma el descuento y ninguna línea queda negativa', () => {
    fc.assert(
      fc.property(
        fc.array(pesos(), { minLength: 1, maxLength: 10 }),
        fc.nat(),
        (lineas, semilla) => {
          const total = sumar(lineas)
          const descuento = total === 0 ? 0 : semilla % (total + 1)
          const partes = repartirDescuentoPedido(descuento, lineas) ?? []
          expect(sumar(partes)).toBe(descuento)
          for (const [i, parte] of partes.entries()) {
            expect(parte).toBeLessThanOrEqual(lineas[i] ?? 0)
          }
        },
      ),
    )
  })
})

describe('desglose fiscal', () => {
  it.each([
    [40_900, 800, 3_787_037, 302_963],
    [25_800, 800, 2_388_889, 191_111],
    [16_000, 800, 1_481_481, 118_519],
    [0, 800, 0, 0],
    [40_900, 0, 4_090_000, 0],
    [119_000, 1900, 10_000_000, 1_900_000],
  ])('%d al %d bp → base %d + impuesto %d', (neto, tarifa, base, impuesto) => {
    expect(desglosar(neto, tarifa)).toEqual({ baseCentesimas: base, impuestoCentesimas: impuesto })
  })

  it('precios donde el impuesto difiere en 1 centésima de base × tarifa (pendiente de validar)', () => {
    for (const precio of [200, 2500, 16_000, 29_900, 34_900, 40_300]) {
      const { baseCentesimas, impuestoCentesimas } = desglosar(precio, 800)
      expect(Math.abs(impuestoCentesimas - (baseCentesimas * 800) / 10_000)).toBeLessThanOrEqual(1)
    }
  })

  it('propiedad: base + impuesto = neto × 100 y la base no pasa del total', () => {
    fc.assert(
      fc.property(pesos(10_000_000_000), fc.integer({ min: 0, max: 10_000 }), (neto, tarifa) => {
        const { baseCentesimas, impuestoCentesimas } = desglosar(neto, tarifa)
        expect(baseCentesimas + impuestoCentesimas).toBe(neto * 100)
        expect(impuestoCentesimas).toBeGreaterThanOrEqual(0)
      }),
    )
  })
})

describe('propina sugerida', () => {
  it.each([
    [100_000, 9259],
    [16_000, 1481],
    [2500, 231],
    [48_420, 4483],
  ])('10 %% de %d al 8 %% → %d', (neto, propina) => {
    expect(propinaSugerida([{ neto, tarifa: 800 }], 1000)).toBe(propina)
  })

  it('con tarifas mezcladas suma las bases exactas antes de redondear', () => {
    // 40.900 al 8 % (base 37.870,37) + 8.900 exento (base 8.900) → 10 % de 46.770,37 = 4.677
    expect(
      propinaSugerida(
        [
          { neto: 40_900, tarifa: 800 },
          { neto: 8900, tarifa: 0 },
        ],
        1000,
      ),
    ).toBe(4677)
  })

  it('tasa 0 y sin líneas dan 0', () => {
    expect(propinaSugerida([{ neto: 100_000, tarifa: 800 }], 0)).toBe(0)
    expect(propinaSugerida([], 1000)).toBe(0)
  })

  it('el reparto entre cuentas suma la propina del saldo dividido', () => {
    const propina = propinaSugerida([{ neto: 60_000, tarifa: 800 }], 1000)
    expect(propina).toBe(5556)
    expect(repartirPropina(propina, [30_000, 30_000])).toEqual([2778, 2778])
  })
})

describe('efectivo', () => {
  it.each([
    [36_810, 36_800],
    [36_850, 36_800],
    [36_851, 36_900],
    [36_860, 36_900],
    [36_800, 36_800],
    [50, 0],
    [30, 0],
    [51, 100],
  ])('saldo %d se cobra %d', (saldo, cobrado) => {
    expect(cobradoEnEfectivo(saldo, 100)).toBe(cobrado)
  })

  it('otros modos y múltiplo 1', () => {
    expect(cobradoEnEfectivo(36_850, 100, 'cercano_mitad_arriba')).toBe(36_900)
    expect(cobradoEnEfectivo(36_899, 100, 'abajo')).toBe(36_800)
    expect(cobradoEnEfectivo(36_801, 100, 'arriba')).toBe(36_900)
    expect(cobradoEnEfectivo(36_810, 1)).toBe(36_810)
  })

  it('propiedad: el ajuste nunca pasa de medio múltiplo', () => {
    fc.assert(
      fc.property(pesos(), (saldo) => {
        const ajuste = cobradoEnEfectivo(saldo, 100) - saldo
        expect(ajuste).toBeGreaterThanOrEqual(-50)
        expect(ajuste).toBeLessThanOrEqual(49)
      }),
    )
  })

  it('identidad recibido = monto + ajuste + propina + cambio', () => {
    expect(
      cuadraEfectivo({
        monto: 36_810,
        ajusteRedondeo: -10,
        propina: 0,
        recibido: 40_000,
        cambio: 3200,
      }),
    ).toBe(true)
    expect(
      cuadraEfectivo({
        monto: 36_860,
        ajusteRedondeo: 40,
        propina: 0,
        recibido: 50_000,
        cambio: 13_100,
      }),
    ).toBe(true)
    expect(
      cuadraEfectivo({
        monto: 36_810,
        ajusteRedondeo: 0,
        propina: 0,
        recibido: 40_000,
        cambio: 3200,
      }),
    ).toBe(false)
    expect(
      cuadraEfectivo({ monto: 100, ajusteRedondeo: 0, propina: 0, recibido: 50, cambio: -50 }),
    ).toBe(false)
  })
})

describe('caja', () => {
  it('esperado del ejemplo de DINERO.md: 219.800', () => {
    expect(
      esperadoEfectivo({
        base: 200_000,
        pagos: [{ monto: 36_810, ajusteRedondeo: -10, propina: 3000 }],
        devoluciones: [],
        entradas: [],
        salidas: [],
        pagosPropinas: [20_000],
        retirosParciales: [],
      }),
    ).toBe(219_800)
  })

  it('resta devoluciones, salidas y retiros y suma entradas', () => {
    expect(
      esperadoEfectivo({
        base: 100_000,
        pagos: [{ monto: 50_000, ajusteRedondeo: 0, propina: 5000 }],
        devoluciones: [10_000],
        entradas: [20_000],
        salidas: [5000],
        pagosPropinas: [],
        retirosParciales: [50_000],
      }),
    ).toBe(110_000)
  })
})

describe('modo de redondeo', () => {
  it('mitad_par lleva la mitad al par más cercano', () => {
    expect(redondear(25n, 10n, 'mitad_par')).toBe(2n)
    expect(redondear(35n, 10n, 'mitad_par')).toBe(4n)
    expect(redondear(26n, 10n, 'mitad_par')).toBe(3n)
    expect(redondear(24n, 10n, 'mitad_par')).toBe(2n)
    expect(porcentaje(12_950, 1500, 'mitad_par')).toBe(1942)
    expect(porcentaje(12_950, 1500)).toBe(1943)
  })
})

describe('dividir por ítems', () => {
  const lineas = [
    { itemId: 'pizza', neto: 40_900 },
    { itemId: 'botella', neto: 100_000 },
    { itemId: 'postre', neto: 24_900 },
  ]

  it('cada uno paga lo suyo, la botella se comparte en tercios y el postre queda sin asignar', () => {
    const tercio = { n: 1, d: 3 }
    const r = dividirPorItems(
      lineas,
      [
        { cuenta: 0, itemId: 'pizza', fraccion: { n: 1, d: 1 } },
        { cuenta: 0, itemId: 'botella', fraccion: tercio },
        { cuenta: 1, itemId: 'botella', fraccion: tercio },
        { cuenta: 2, itemId: 'botella', fraccion: tercio },
      ],
      3,
    )

    expect(r).toEqual({ montos: [74_234, 33_333, 33_333], sinAsignar: 24_900 })
  })

  it('una fracción tomada a medias deja el resto sin asignar', () => {
    const r = dividirPorItems(
      [{ itemId: 'botella', neto: 100_000 }],
      [{ cuenta: 0, itemId: 'botella', fraccion: { n: 1, d: 2 } }],
      1,
    )
    expect(r).toEqual({ montos: [50_000], sinAsignar: 50_000 })
  })

  it('rechaza fracciones que pasan de 1, ítems ajenos y cuentas que no existen', () => {
    expect(() =>
      dividirPorItems(
        lineas,
        [
          { cuenta: 0, itemId: 'pizza', fraccion: { n: 2, d: 3 } },
          { cuenta: 1, itemId: 'pizza', fraccion: { n: 2, d: 3 } },
        ],
        2,
      ),
    ).toThrow(/más de 1/)
    expect(() =>
      dividirPorItems(lineas, [{ cuenta: 0, itemId: 'otro', fraccion: { n: 1, d: 1 } }], 1),
    ).toThrow(/no está/)
    expect(() =>
      dividirPorItems(lineas, [{ cuenta: 5, itemId: 'pizza', fraccion: { n: 1, d: 1 } }], 2),
    ).toThrow(/cuenta/)
    expect(() => dividirPorItems(lineas, [], 0)).toThrow(/al menos una/)
  })

  it('propiedad: las cuentas más lo no asignado suman el total', () => {
    fc.assert(
      fc.property(
        fc.array(pesos(), { minLength: 1, maxLength: 6 }),
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.integer({ min: 1, max: 4 })), { maxLength: 12 }),
        (netos, crudas) => {
          const items = netos.map((neto, i) => ({ itemId: `i${i}`, neto }))
          // Como mucho 1/4 por asignación y 4 por ítem: nunca pasan de 1.
          const vistas = new Map<string, number>()
          const asignaciones = crudas.flatMap(([c, i, partes]) => {
            const itemId = `i${i % items.length}`
            const usadas = vistas.get(itemId) ?? 0
            if (usadas >= 4) return []
            vistas.set(itemId, usadas + 1)
            return [{ cuenta: c % 3, itemId, fraccion: { n: 1, d: 4 * partes } }]
          })
          const r = dividirPorItems(items, asignaciones, 3)
          expect(sumar(r.montos) + r.sinAsignar).toBe(sumar(netos))
        },
      ),
    )
  })
})
