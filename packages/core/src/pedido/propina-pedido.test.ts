import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { propinaSugerida, repartirPropina } from '../dinero'
import { nuevoId } from '../id'
import { aplicarTodos, enviarItems, pedidoAbierto } from '../pruebas/ayudas'
import { copiaItem, evento, pagoEfectivo, pagoTarjeta } from '../pruebas/fabrica'
import { propinaDelPedido, totalesPedido } from './totales'

// `propinaDelPedido` contra pedidos armados con eventos reales (tarea 1.6, docs/DINERO.md#propina-
// sugerida): la propina sale de la base sin INC, neta de descuentos y anulaciones, con un solo
// redondeo, y sobre el saldo cuando hay pagos previos.

const CONFIG = { propina_sugerida: 1000, redondeo_modo: 'mitad_arriba' as const }

const conItems = (...items: ReturnType<typeof copiaItem>[]) => {
  const { pedido, estado } = pedidoAbierto()
  return {
    pedido,
    estado: aplicarTodos(
      items.map((i) => evento(pedido, 'ItemAgregado', i)),
      estado,
    ),
  }
}

const descuento = (
  pedido: string,
  alcance: 'item' | 'pedido',
  regla: 'porcentaje' | 'valor',
  valor: number,
  montos: [string, number][],
) =>
  evento(
    pedido,
    'DescuentoAplicado',
    {
      descuento_id: nuevoId(),
      alcance,
      regla,
      valor,
      cantidad_unidades: null,
      montos: montos.map(([item_id, monto]) => ({ item_id, monto })),
    },
    { motivo: 'Prueba' },
  )

describe('propinaDelPedido: los ejemplos de docs/DINERO.md con pedidos reales', () => {
  it.each([
    [100_000, 9_259],
    [16_000, 1_481],
    [2_500, 231],
  ])('un plato de $%i al 8 %% → propina %i', (precio, esperada) => {
    const { estado } = conItems(copiaItem({ precio_unitario: precio }))
    expect(propinaDelPedido(estado, totalesPedido(estado).saldo, CONFIG)).toBe(esperada)
  })

  it('$53.800 con 10 % de descuento (neto 48.420) → 4.483, sobre el neto y no sobre el bruto', () => {
    const plato = copiaItem({ precio_unitario: 53_800 })
    const { pedido, estado } = conItems(plato)
    const final = aplicarTodos(
      [descuento(pedido, 'pedido', 'porcentaje', 1000, [[plato.item_id, 5_380]])],
      estado,
    )
    expect(totalesPedido(final)).toMatchObject({ bruto: 53_800, descuento: 5_380, neto: 48_420 })
    expect(propinaDelPedido(final, 48_420, CONFIG)).toBe(4_483)
    // Sobre el bruto habría dado 4.981: el descuento sí se tiene en cuenta.
    expect(propinaDelPedido(estado, 53_800, CONFIG)).toBe(4_981)
  })

  it('$100.000 al 8 % con $40.000 pagados: la propina del saldo de $60.000 es 5.556 (2.778 + 2.778)', () => {
    const plato = copiaItem({ precio_unitario: 100_000 })
    const { pedido, estado } = conItems(plato)
    const conPago = aplicarTodos([evento(pedido, 'PagoRegistrado', pagoTarjeta(40_000))], estado)
    const saldo = totalesPedido(conPago).saldo
    expect(saldo).toBe(60_000)
    const propina = propinaDelPedido(conPago, saldo, CONFIG)
    expect(propina).toBe(5_556)
    expect(repartirPropina(propina, [30_000, 30_000])).toEqual([2_778, 2_778])
  })

  it('un pago previo con propina propia no cambia la sugerida del saldo', () => {
    const { pedido, estado } = conItems(copiaItem({ precio_unitario: 100_000 }))
    const conPago = aplicarTodos(
      [evento(pedido, 'PagoRegistrado', pagoEfectivo(40_000, { propina: 4_000 }))],
      estado,
    )
    expect(propinaDelPedido(conPago, 60_000, CONFIG)).toBe(5_556)
  })
})

describe('propinaDelPedido: descuentos, anulaciones, extras y tarifas', () => {
  it('con tarifas distintas, cada línea aporta su base sin impuesto (8 %, exento y 19 %)', () => {
    const { estado } = conItems(
      copiaItem({ precio_unitario: 50_000, tarifa: 800 }),
      copiaItem({ precio_unitario: 50_000, tarifa: 0, impuesto_tipo: 'exento' }),
      copiaItem({ precio_unitario: 11_900, tarifa: 1900, impuesto_tipo: 'iva' }),
    )
    // 46.296,2963 + 50.000 + 10.000 = 106.296,2963 → 10 % = 10.629,63 → 10.630.
    expect(propinaDelPedido(estado, 111_900, CONFIG)).toBe(10_630)
  })

  it('un descuento de ítem baja la propina de ese ítem', () => {
    const cerveza = copiaItem({ precio_unitario: 14_900, cantidad: 3 })
    const pizza = copiaItem({ precio_unitario: 40_000 })
    const { pedido, estado } = conItems(cerveza, pizza)
    const final = aplicarTodos(
      [descuento(pedido, 'item', 'valor', 14_900, [[cerveza.item_id, 14_900]])],
      estado,
    )
    const neto = totalesPedido(final).neto
    expect(neto).toBe(44_700 + 40_000 - 14_900)
    // (29.800 + 40.000) / 1,08 = 64.629,6296 → 6.463.
    expect(propinaDelPedido(final, neto, CONFIG)).toBe(6_463)
  })

  it('una cortesía total deja la línea fuera de la propina sin romper la cuenta', () => {
    const trago = copiaItem({ precio_unitario: 20_000 })
    const comida = copiaItem({ precio_unitario: 30_000 })
    const { pedido, estado } = conItems(trago, comida)
    const final = aplicarTodos(
      [descuento(pedido, 'item', 'porcentaje', 10_000, [[trago.item_id, 20_000]])],
      estado,
    )
    expect(totalesPedido(final).neto).toBe(30_000)
    expect(propinaDelPedido(final, 30_000, CONFIG)).toBe(2_778)
  })

  it('un ítem anulado no cuenta; uno anulado en parte, solo las unidades que quedan', () => {
    const cervezas = copiaItem({ precio_unitario: 14_900, cantidad: 3 })
    const plato = copiaItem({ precio_unitario: 40_900 })
    const { pedido, estado } = conItems(cervezas, plato)
    const enviado = aplicarTodos([enviarItems(pedido, [cervezas.item_id, plato.item_id])], estado)
    const anulacion = (item_id: string, cantidad: number) =>
      evento(
        pedido,
        'ItemAnulado',
        { item_id, cantidad, ya_preparado: false, comanda_id: null },
        { motivo: 'Cliente cambió' },
      )

    const parcial = aplicarTodos([anulacion(cervezas.item_id, 1)], enviado)
    // (29.800 + 40.900) / 1,08 = 65.462,96 → 6.546.
    expect(propinaDelPedido(parcial, totalesPedido(parcial).neto, CONFIG)).toBe(6_546)

    const sinPlato = aplicarTodos([anulacion(plato.item_id, 1)], parcial)
    // 29.800 / 1,08 = 27.592,59 → 2.759.
    expect(totalesPedido(sinPlato).neto).toBe(29_800)
    expect(propinaDelPedido(sinPlato, 29_800, CONFIG)).toBe(2_759)
  })

  it('con todo anulado no queda base: propina 0 para $0 y error para un monto mayor', () => {
    const plato = copiaItem({ precio_unitario: 40_900 })
    const { pedido, estado } = conItems(plato)
    const anulado = aplicarTodos(
      [
        enviarItems(pedido, [plato.item_id]),
        evento(
          pedido,
          'ItemAnulado',
          { item_id: plato.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
          { motivo: 'Error' },
        ),
      ],
      estado,
    )
    expect(propinaDelPedido(anulado, 0, CONFIG)).toBe(0)
    expect(() => propinaDelPedido(anulado, 1, CONFIG)).toThrow(RangeError)
  })

  it('un pedido sin ítems tampoco tiene propina', () => {
    const { estado } = pedidoAbierto()
    expect(propinaDelPedido(estado, 0, CONFIG)).toBe(0)
  })

  it('los extras de un modificador entran en la base (precio de la unidad con extras)', () => {
    const plato = copiaItem({
      precio_unitario: 38_000,
      cantidad: 2,
      modificadores: [{ modificador_id: nuevoId(), nombre: 'Queso extra', precio_extra: 2_900 }],
    })
    const { estado } = conItems(plato)
    expect(totalesPedido(estado).neto).toBe(81_800)
    // 81.800 / 1,08 = 75.740,74 → 7.574.
    expect(propinaDelPedido(estado, 81_800, CONFIG)).toBe(7_574)
  })

  it('un solo redondeo para todo el pedido: dos líneas no suman sus propinas redondeadas', () => {
    const { estado } = conItems(
      copiaItem({ precio_unitario: 16_000 }),
      copiaItem({ precio_unitario: 16_000 }),
    )
    // Cada una sola daría 1.481 (suma 2.962); junta, 32.000 / 1,08 × 10 % = 2.962,96 → 2.963.
    expect(propinaDelPedido(estado, 32_000, CONFIG)).toBe(2_963)
  })

  it('tasa 0: sin propina sugerida', () => {
    const { estado } = conItems(copiaItem({ precio_unitario: 100_000 }))
    expect(propinaDelPedido(estado, 100_000, { ...CONFIG, propina_sugerida: 0 })).toBe(0)
  })

  it('el modo de redondeo de la configuración decide el empate exacto de medio peso', () => {
    // 5 pesos exentos al 10 % = 0,5 exacto.
    const { estado } = conItems(
      copiaItem({ precio_unitario: 5, tarifa: 0, impuesto_tipo: 'exento' }),
    )
    expect(propinaDelPedido(estado, 5, { ...CONFIG, redondeo_modo: 'mitad_arriba' })).toBe(1)
    expect(propinaDelPedido(estado, 5, { ...CONFIG, redondeo_modo: 'mitad_par' })).toBe(0)
  })

  it('un monto mayor que el neto vigente es un error, no una propina inflada', () => {
    const { estado } = conItems(copiaItem({ precio_unitario: 10_000 }))
    expect(() => propinaDelPedido(estado, 10_001, CONFIG)).toThrow(RangeError)
  })
})

describe('propinaDelPedido: propiedades', () => {
  it('con todo el neto coincide con propinaSugerida de las líneas, y es monótona en el monto', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            precio: fc.integer({ min: 0, max: 500_000 }),
            cantidad: fc.integer({ min: 1, max: 9 }),
            tarifa: fc.constantFrom(0, 800, 1900),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 1000 }),
        (filas, fraccion, tasa) => {
          const { estado } = conItems(
            ...filas.map((f) =>
              copiaItem({
                precio_unitario: f.precio,
                cantidad: f.cantidad,
                tarifa: f.tarifa,
                impuesto_tipo: f.tarifa === 0 ? 'exento' : f.tarifa === 800 ? 'inc' : 'iva',
              }),
            ),
          )
          const neto = totalesPedido(estado).neto
          const config = { propina_sugerida: tasa, redondeo_modo: 'mitad_arriba' as const }
          const total = propinaDelPedido(estado, neto, config)
          expect(total).toBe(
            propinaSugerida(
              filas.map((f) => ({ neto: f.precio * f.cantidad, tarifa: f.tarifa })),
              tasa,
            ),
          )
          const parte = Math.floor(neto * fraccion)
          const propinaParte = propinaDelPedido(estado, parte, config)
          expect(propinaParte).toBeGreaterThanOrEqual(0)
          expect(propinaParte).toBeLessThanOrEqual(total)
          // La propina del resto + la de la parte difieren de la total en a lo sumo 1 peso
          // (cada una lleva su propio redondeo).
          const resto = propinaDelPedido(estado, neto - parte, config)
          expect(Math.abs(propinaParte + resto - total)).toBeLessThanOrEqual(1)
        },
      ),
    )
  })
})

describe('ItemAgregado limpia la última precuenta', () => {
  it('después de pedir la precuenta, agregar un producto la deja en null (ya no vale)', () => {
    const { pedido, estado } = conItems(copiaItem({ precio_unitario: 10_000 }))
    const conPrecuenta = aplicarTodos(
      [
        evento(pedido, 'PrecuentaImpresa', {
          cuenta_id: null,
          subtotal: 10_000,
          propina_sugerida: 926,
        }),
      ],
      estado,
    )
    expect(conPrecuenta.ultimaPrecuenta).toMatchObject({ subtotal: 10_000, propinaSugerida: 926 })
    const despues = aplicarTodos([evento(pedido, 'ItemAgregado', copiaItem())], conPrecuenta)
    expect(despues.ultimaPrecuenta).toBeNull()
  })
})
