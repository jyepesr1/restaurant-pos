import { describe, expect, it } from 'vitest'
import {
  cobradoEnEfectivo,
  partesIguales,
  porcentaje,
  propinaSugerida,
  repartir,
  repartirDescuentoPedido,
} from '../dinero'
import { type EventoPedido, TIPOS_EVENTO_PEDIDO } from '../eventos/pedido'
import { nuevoId } from '../id'
import { aplicarTodos, enviarItems, pedidoAbierto, problemaDe } from '../pruebas/ayudas'
import {
  copiaItem,
  deNuevo,
  evento,
  MESERO,
  pagoEfectivo,
  pagoTarjeta,
  TURNO,
} from '../pruebas/fabrica'
import { aplicarEvento } from './aplicar'
import type { EstadoPedido } from './estado'
import { saldoCuenta, totalesItem, totalesPedido } from './totales'

// Casos de la tabla de la tarea 0.5 (docs/DINERO.md) que no cubren aplicar.test.ts ni
// guardas.test.ts: pagos, efectivo, división, descuentos, informes y proyección.

const MOTIVO = { motivo: 'Motivo de prueba' }

function descuentoEvento(
  pedido: string,
  alcance: 'item' | 'pedido',
  regla: 'porcentaje' | 'valor' | 'cortesia',
  valor: number,
  montos: [string, number][],
  unidades: number | null = null,
) {
  return evento(
    pedido,
    'DescuentoAplicado',
    {
      descuento_id: nuevoId(),
      alcance,
      regla,
      valor,
      cantidad_unidades: unidades,
      montos: montos.map(([item_id, monto]) => ({ item_id, monto })),
    },
    MOTIVO,
  )
}

const cuentasDe = (montos: number[], propinas: number[] = []) =>
  montos.map((monto, i) => ({
    cuenta_id: nuevoId(),
    nombre: `Cuenta ${i + 1}`,
    monto,
    propina_sugerida: propinas[i] ?? 0,
    items: [],
  }))

describe('pagos', () => {
  it('pago mixto: tarjeta y luego efectivo redondeado; solo el último lleva ajuste', () => {
    const { pedido, estado } = pedidoAbierto()
    const item = copiaItem({ precio_unitario: 100_000 })
    const conTarjeta = aplicarTodos(
      [evento(pedido, 'ItemAgregado', item), evento(pedido, 'PagoRegistrado', pagoTarjeta(63_190))],
      estado,
    )
    const saldo = totalesPedido(conTarjeta).saldo
    expect(saldo).toBe(36_810)
    expect(cobradoEnEfectivo(saldo, 100) - saldo).toBe(-10)

    const cerrado = aplicarTodos(
      [
        evento(
          pedido,
          'PagoRegistrado',
          pagoEfectivo(saldo, { ajuste_redondeo: -10, cambio: 3200 }),
        ),
        evento(pedido, 'PedidoCerrado', {}),
      ],
      conTarjeta,
    )
    expect(cerrado.estado).toBe('cerrado')
    expect(totalesPedido(cerrado)).toMatchObject({ pagado: 100_000, saldo: 0, ajustes: -10 })
    // Σ cobrado = Σ monto + Σ ajuste: 99.990 en total.
    const cobrado = Object.values(cerrado.pagos).reduce((a, p) => a + p.monto + p.ajusteRedondeo, 0)
    expect(cobrado).toBe(99_990)
  })

  it('saldo de $30 y de $50 tras pagar con tarjeta: se cobra $0 con ajuste negativo y cierra', () => {
    for (const resto of [30, 50]) {
      const { pedido, estado } = pedidoAbierto()
      const listo = aplicarTodos(
        [
          evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 40_000 + resto })),
          evento(pedido, 'PagoRegistrado', pagoTarjeta(40_000)),
          evento(pedido, 'PagoRegistrado', pagoEfectivo(resto, { ajuste_redondeo: -resto })),
          evento(pedido, 'PedidoCerrado', {}),
        ],
        estado,
      )
      expect(listo.estado).toBe('cerrado')
      expect(totalesPedido(listo)).toMatchObject({ saldo: 0, ajustes: -resto })
    }
  })

  it('saldo múltiplo de 100: sin ajuste', () => {
    const { pedido, estado } = pedidoAbierto()
    const pagado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 36_800 })),
        evento(pedido, 'PagoRegistrado', pagoEfectivo(36_800)),
      ],
      estado,
    )
    expect(totalesPedido(pagado)).toMatchObject({ saldo: 0, ajustes: 0 })
    expect(Object.values(pagado.pagos)[0]?.ajusteRedondeo).toBe(0)
  })

  it('el cambio que el cliente deja se registra como propina', () => {
    const { pedido, estado } = pedidoAbierto()
    const conItem = aplicarTodos(
      [evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 36_810 }))],
      estado,
    )
    // Da $40.000 por $36.810 (se cobran 36.800): los $3.200 de vuelto quedan de propina.
    const conPropina = pagoEfectivo(36_810, { ajuste_redondeo: -10, propina: 3200, cambio: 0 })
    expect(conPropina.recibido).toBe(40_000)
    const final = aplicarTodos([evento(pedido, 'PagoRegistrado', conPropina)], conItem)
    expect(totalesPedido(final)).toMatchObject({ saldo: 0, propinas: 3200, ajustes: -10 })

    const conCambio = aplicarTodos(
      [
        evento(
          pedido,
          'PagoRegistrado',
          pagoEfectivo(36_810, { ajuste_redondeo: -10, cambio: 3200 }),
        ),
      ],
      conItem,
    )
    expect(totalesPedido(conCambio)).toMatchObject({ saldo: 0, propinas: 0 })
  })

  it('una anulación en otro turno deja el pago en su turno original y devuelve el saldo', () => {
    const { pedido, estado } = pedidoAbierto()
    const pago = pagoTarjeta(40_900)
    const otroTurno = nuevoId()
    const pagado = aplicarTodos(
      [evento(pedido, 'ItemAgregado', copiaItem()), evento(pedido, 'PagoRegistrado', pago)],
      estado,
    )
    const anulado = aplicarTodos(
      [evento(pedido, 'PagoAnulado', { pago_id: pago.pago_id, turno_caja_id: otroTurno }, MOTIVO)],
      pagado,
    )
    expect(anulado.pagos[pago.pago_id]).toMatchObject({ turnoCajaId: TURNO, anulado: true })
    expect(totalesPedido(anulado)).toMatchObject({
      pagado: 0,
      saldo: 40_900,
      propinas: 0,
      ajustes: 0,
    })
  })

  it('un pago anulado no cuenta para el ajuste ni deja cerrar', () => {
    const { pedido, estado } = pedidoAbierto()
    const pago = pagoEfectivo(36_810, { ajuste_redondeo: -10, cambio: 3200 })
    const anulado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 36_810 })),
        evento(pedido, 'PagoRegistrado', pago),
        evento(pedido, 'PagoAnulado', { pago_id: pago.pago_id, turno_caja_id: TURNO }, MOTIVO),
      ],
      estado,
    )
    expect(totalesPedido(anulado)).toMatchObject({ ajustes: 0, saldo: 36_810 })
    expect(problemaDe(anulado, evento(pedido, 'PedidoCerrado', {}))).toBe('saldo_pendiente')
  })

  describe('reembolsos', () => {
    function conPago(medio: 'tarjeta' | 'efectivo') {
      const { pedido, estado } = pedidoAbierto()
      const pago =
        medio === 'tarjeta'
          ? pagoTarjeta(20_000, { propina: 2000 })
          : pagoEfectivo(36_850, { ajuste_redondeo: -50, propina: 1000 })
      const final = aplicarTodos(
        [
          evento(
            pedido,
            'ItemAgregado',
            copiaItem({ precio_unitario: medio === 'tarjeta' ? 20_000 : 36_850 }),
          ),
          evento(pedido, 'PagoRegistrado', pago),
        ],
        estado,
      )
      const reembolsar = (venta: number, propina: number) =>
        evento(
          pedido,
          'ReembolsoRegistrado',
          {
            pago_id: pago.pago_id,
            reembolso_id: nuevoId(),
            monto_venta: venta,
            monto_propina: propina,
            medio,
            turno_caja_id: nuevoId(),
          },
          MOTIVO,
        )
      return { pedido, estado: final, pago, reembolsar }
    }

    it('parcial y acumulado, partido en venta y propina, sin pasar de lo pagado', () => {
      const { estado, pago, reembolsar } = conPago('tarjeta')
      const primero = aplicarTodos([reembolsar(5000, 500)], estado)
      expect(primero.pagos[pago.pago_id]).toMatchObject({
        reembolsadoVenta: 5000,
        reembolsadoPropina: 500,
      })
      expect(totalesPedido(primero)).toMatchObject({ pagado: 15_000, propinas: 1500, saldo: 5000 })

      // Segundo reembolso: venta y propina por separado cuentan contra su propio tope.
      expect(problemaDe(primero, reembolsar(15_001, 0))).toBe('reembolso_excede')
      expect(problemaDe(primero, reembolsar(0, 1501))).toBe('reembolso_excede')
      const segundo = aplicarTodos([reembolsar(15_000, 1500)], primero)
      expect(totalesPedido(segundo)).toMatchObject({ pagado: 0, propinas: 0, saldo: 20_000 })
      expect(problemaDe(segundo, reembolsar(1, 0))).toBe('reembolso_excede')
      expect(problemaDe(segundo, reembolsar(0, 1))).toBe('reembolso_excede')
    })

    it('un reembolso de solo propina no toca la venta', () => {
      const { estado, reembolsar } = conPago('tarjeta')
      const final = aplicarTodos([reembolsar(0, 2000)], estado)
      expect(totalesPedido(final)).toMatchObject({ pagado: 20_000, propinas: 0, saldo: 0 })
    })

    it('en efectivo con ajuste negativo el total devuelto no pasa de lo cobrado', () => {
      // Cobrado = 36.850 − 50 + 1.000 de propina = 37.800.
      const { estado, reembolsar } = conPago('efectivo')
      expect(problemaDe(estado, reembolsar(36_850, 1000))).toBe('reembolso_excede')
      const parcial = aplicarTodos([reembolsar(36_000, 0)], estado)
      // Quedan 1.800 por devolver (37.800 − 36.000).
      expect(problemaDe(parcial, reembolsar(801, 1000))).toBe('reembolso_excede')
      // Devolver toda la venta cobrada (36.800) dejaría el ajuste suelto: se pide anular.
      expect(problemaDe(parcial, reembolsar(800, 1000))).toBe('usar_anulacion')
      expect(problemaDe(parcial, reembolsar(750, 1000))).toBeUndefined()
    })

    it('un pago totalmente reembolsado deja cancelar el pedido', () => {
      const { pedido, estado, reembolsar } = conPago('tarjeta')
      const devuelto = aplicarTodos([reembolsar(20_000, 2000)], estado)
      expect(aplicarTodos([evento(pedido, 'PedidoCancelado', {}, MOTIVO)], devuelto).estado).toBe(
        'cancelado',
      )
    })
  })
})

describe('división de la cuenta', () => {
  it('no admite una sola cuenta (el esquema pide al menos dos)', () => {
    const { pedido } = pedidoAbierto()
    expect(partesIguales(87_650, 1)).toEqual([87_650])
    expect(() => evento(pedido, 'CuentaDividida', { cuentas: cuentasDe([87_650]) })).toThrow(
      /Evento de prueba inválido/,
    )
  })

  it('por ítems: cada cuenta lleva sus platos y al pagarlas todas el pedido cierra', () => {
    const { pedido, estado } = pedidoAbierto()
    const pizza = copiaItem()
    const pasta = copiaItem({ precio_unitario: 12_900 })
    const [ana, luis] = cuentasDe([40_900, 12_900])
    if (!ana || !luis) throw new Error('faltan cuentas')
    const dividido = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', pizza),
        evento(pedido, 'ItemAgregado', pasta),
        evento(pedido, 'CuentaDividida', {
          cuentas: [
            { ...ana, items: [{ item_id: pizza.item_id, fraccion: { n: 1, d: 1 } }] },
            { ...luis, items: [{ item_id: pasta.item_id, fraccion: { n: 1, d: 1 } }] },
          ],
        }),
      ],
      estado,
    )
    expect(dividido.cuentas?.map((c) => c.monto)).toEqual([40_900, 12_900])
    const cerrado = aplicarTodos(
      [
        evento(pedido, 'PagoRegistrado', pagoTarjeta(40_900, { cuenta_id: ana.cuenta_id })),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(12_900, { cuenta_id: luis.cuenta_id })),
        evento(pedido, 'PedidoCerrado', {}),
      ],
      dividido,
    )
    expect(cerrado.estado).toBe('cerrado')
  })

  it('ítem compartido 1/3 y varios compartidos: las cuentas suman el total del pedido', () => {
    const { pedido, estado } = pedidoAbierto()
    const botella = copiaItem({ precio_unitario: 40_900 })
    const picada = copiaItem({ precio_unitario: 38_500 })
    const propio = copiaItem({ precio_unitario: 12_900 })
    const deBotella = repartir(40_900, [1, 1, 1])
    const dePicada = repartir(38_500, [1, 1, 0])
    const montos = [12_900, 0, 0].map((p, i) => p + (deBotella[i] ?? 0) + (dePicada[i] ?? 0))
    const cuentas = cuentasDe(montos).map((c, i) => ({
      ...c,
      items: [
        { item_id: botella.item_id, fraccion: { n: 1, d: 3 } },
        ...(i < 2 ? [{ item_id: picada.item_id, fraccion: { n: 1, d: 2 } }] : []),
        ...(i === 0 ? [{ item_id: propio.item_id, fraccion: { n: 1, d: 1 } }] : []),
      ],
    }))
    const dividido = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', botella),
        evento(pedido, 'ItemAgregado', picada),
        evento(pedido, 'ItemAgregado', propio),
        evento(pedido, 'CuentaDividida', { cuentas }),
      ],
      estado,
    )
    expect(dividido.cuentas?.reduce((a, c) => a + c.monto, 0)).toBe(totalesPedido(dividido).neto)
    expect(dividido.cuentas?.map((c) => c.monto)).toEqual([
      12_900 + 13_634 + 19_250,
      13_633 + 19_250,
      13_633,
    ])
  })

  it('por monto libre: lo no asignado queda en sin_asignar y se paga sin cuenta', () => {
    const { pedido, estado } = pedidoAbierto()
    const [a, b] = cuentasDe([30_000, 20_000])
    if (!a || !b) throw new Error('faltan cuentas')
    const dividido = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 100_000 })),
        evento(pedido, 'CuentaDividida', { cuentas: [a, b] }),
      ],
      estado,
    )
    // 100.000 − (30.000 + 20.000) sin asignar.
    expect(problemaDe(dividido, evento(pedido, 'PagoRegistrado', pagoTarjeta(50_001)))).toBe(
      'pago_excede_saldo',
    )
    const cerrado = aplicarTodos(
      [
        evento(pedido, 'PagoRegistrado', pagoTarjeta(30_000, { cuenta_id: a.cuenta_id })),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(20_000, { cuenta_id: b.cuenta_id })),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(50_000)),
        evento(pedido, 'PedidoCerrado', {}),
      ],
      dividido,
    )
    expect(cerrado.estado).toBe('cerrado')
  })

  it('con pago previo: se divide el saldo pendiente y el pago queda en la cuenta general', () => {
    const { pedido, estado } = pedidoAbierto()
    const saldo = 60_000
    const propina = propinaSugerida([{ neto: saldo, tarifa: 800 }], 1000)
    expect(propina).toBe(5556)
    const [a, b] = cuentasDe(partesIguales(saldo, 2), partesIguales(propina, 2))
    if (!a || !b) throw new Error('faltan cuentas')
    const previo = pagoEfectivo(40_000)
    const conPago = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 100_000 })),
        evento(pedido, 'PagoRegistrado', previo),
      ],
      estado,
    )
    // Dividir los 100.000 enteros ya no cuadra; el saldo de 60.000 sí.
    expect(
      problemaDe(
        conPago,
        evento(pedido, 'CuentaDividida', { cuentas: cuentasDe([50_000, 50_000]) }),
      ),
    ).toBe('division_no_cuadra')
    const dividido = aplicarTodos([evento(pedido, 'CuentaDividida', { cuentas: [a, b] })], conPago)

    expect(dividido.cuentas?.map((c) => [c.monto, c.propinaSugerida])).toEqual([
      [30_000, 2778],
      [30_000, 2778],
    ])
    expect(dividido.pagos[previo.pago_id]?.cuentaId).toBeNull()
    expect(saldoCuenta(dividido, a.cuenta_id)).toBe(30_000)
    // El pago previo en la cuenta general no se recalcula ni libera lo ya cubierto.
    expect(problemaDe(dividido, evento(pedido, 'PagoRegistrado', pagoTarjeta(1)))).toBe(
      'pago_excede_saldo',
    )
  })

  it('DivisionDeshecha: con pagos se rechaza; si el pago se anula, se puede', () => {
    const { pedido, estado } = pedidoAbierto()
    const [a, b] = cuentasDe([50_000, 50_000])
    if (!a || !b) throw new Error('faltan cuentas')
    const pago = pagoTarjeta(50_000, { cuenta_id: a.cuenta_id })
    const conPago = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 100_000 })),
        evento(pedido, 'CuentaDividida', { cuentas: [a, b] }),
        evento(pedido, 'PagoRegistrado', pago),
      ],
      estado,
    )
    expect(problemaDe(conPago, evento(pedido, 'DivisionDeshecha', {}))).toBe('tiene_pagos')
    const anulado = aplicarTodos(
      [evento(pedido, 'PagoAnulado', { pago_id: pago.pago_id, turno_caja_id: TURNO }, MOTIVO)],
      conPago,
    )
    expect(aplicarTodos([evento(pedido, 'DivisionDeshecha', {})], anulado).cuentas).toBeNull()
  })
})

describe('descuentos en el reductor', () => {
  it('cortesía de 1 de 3 cervezas de $14.900', () => {
    const { pedido, estado } = pedidoAbierto()
    const cervezas = copiaItem({ precio_unitario: 14_900, cantidad: 3 })
    const final = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', cervezas),
        descuentoEvento(pedido, 'item', 'cortesia', 14_900, [[cervezas.item_id, 14_900]], 1),
      ],
      estado,
    )
    expect(totalesPedido(final)).toMatchObject({ bruto: 44_700, descuento: 14_900, neto: 29_800 })
  })

  it('cortesía total y luego 10 % al pedido: todo a la pizza, ninguna línea negativa', () => {
    const { pedido, estado } = pedidoAbierto()
    const cervezas = copiaItem({ precio_unitario: 14_900, cantidad: 3 })
    const pizza = copiaItem()
    const conCortesia = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', cervezas),
        evento(pedido, 'ItemAgregado', pizza),
        descuentoEvento(pedido, 'item', 'cortesia', 44_700, [[cervezas.item_id, 44_700]], 3),
      ],
      estado,
    )
    // El 10 % se calcula sobre el neto de las líneas (40.900) y se reparte sobre lo que queda.
    const descuento = porcentaje(totalesPedido(conCortesia).neto, 1000)
    expect(descuento).toBe(4090)
    const final = aplicarTodos(
      [
        descuentoEvento(pedido, 'pedido', 'porcentaje', 1000, [
          [cervezas.item_id, 0],
          [pizza.item_id, 4090],
        ]),
      ],
      conCortesia,
    )
    const netoDe = (id: string) => {
      const linea = final.items[id]
      if (!linea) throw new Error(`falta la línea ${id}`)
      return totalesItem(final, linea).neto
    }
    expect(netoDe(cervezas.item_id)).toBe(0)
    expect(netoDe(pizza.item_id)).toBe(36_810)
    // Repartir 4.470 a la cerveza dejaría −4.470: se rechaza.
    expect(
      problemaDe(
        conCortesia,
        descuentoEvento(pedido, 'pedido', 'porcentaje', 1000, [
          [cervezas.item_id, 4470],
          [pizza.item_id, 0],
        ]),
      ),
    ).toBe('descuento_excede')
  })

  it('varios descuentos al pedido sin cascada en el monto: cada uno sobre la misma base', () => {
    const { pedido, estado } = pedidoAbierto()
    const pizza = copiaItem()
    const pasta = copiaItem({ precio_unitario: 12_900 })
    const conItems = aplicarTodos(
      [evento(pedido, 'ItemAgregado', pizza), evento(pedido, 'ItemAgregado', pasta)],
      estado,
    )
    const base = totalesPedido(conItems).neto
    const lineas = [40_900, 12_900]
    const primero = repartirDescuentoPedido(porcentaje(base, 1000), lineas) ?? []
    const restantes = lineas.map((l, i) => l - (primero[i] ?? 0))
    const segundo = repartirDescuentoPedido(porcentaje(base, 1000), restantes) ?? []
    const final = aplicarTodos(
      [
        descuentoEvento(pedido, 'pedido', 'porcentaje', 1000, [
          [pizza.item_id, primero[0] ?? 0],
          [pasta.item_id, primero[1] ?? 0],
        ]),
        descuentoEvento(pedido, 'pedido', 'porcentaje', 1000, [
          [pizza.item_id, segundo[0] ?? 0],
          [pasta.item_id, segundo[1] ?? 0],
        ]),
      ],
      conItems,
    )
    // 2 × 5.380, no 5.380 + 4.842.
    expect(totalesPedido(final)).toMatchObject({ descuento: 10_760, neto: 43_040 })
  })

  it('pedido de $0: acepta un descuento de $0 y rechaza uno mayor', () => {
    const { pedido, estado } = pedidoAbierto()
    const cortesia = copiaItem({ precio_unitario: 0 })
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', cortesia)], estado)
    expect(totalesPedido(conItem)).toMatchObject({ bruto: 0, neto: 0, saldo: 0 })
    expect(
      problemaDe(conItem, descuentoEvento(pedido, 'pedido', 'valor', 0, [[cortesia.item_id, 0]])),
    ).toBeUndefined()
    expect(
      problemaDe(conItem, descuentoEvento(pedido, 'pedido', 'valor', 1, [[cortesia.item_id, 1]])),
    ).toBe('descuento_excede')
    // Un pedido de $0 también se cierra sin pagos.
    expect(aplicarTodos([evento(pedido, 'PedidoCerrado', {})], conItem).estado).toBe('cerrado')
  })

  it('cambiar la cantidad con descuento exige retirarlo; retirado, se puede', () => {
    const { pedido, estado } = pedidoAbierto()
    const pizza = copiaItem()
    const descuento = descuentoEvento(pedido, 'item', 'valor', 5000, [[pizza.item_id, 5000]])
    const descontado = aplicarTodos([evento(pedido, 'ItemAgregado', pizza), descuento], estado)
    const cambiar = evento(pedido, 'ItemCambiado', { item_id: pizza.item_id, cantidad: 2 })
    expect(problemaDe(descontado, cambiar)).toBe('tiene_descuentos')

    const retirado = aplicarTodos(
      [evento(pedido, 'DescuentoRetirado', { descuento_id: descuento.datos.descuento_id }, MOTIVO)],
      descontado,
    )
    expect(totalesPedido(aplicarTodos([deNuevo(cambiar)], retirado))).toMatchObject({
      bruto: 81_800,
      neto: 81_800,
    })
  })
})

describe('proyección: los montos se leen del evento, nunca se recalculan', () => {
  it('un descuento guarda los montos del evento aunque no coincidan con su regla', () => {
    const { pedido, estado } = pedidoAbierto()
    const item = copiaItem({ precio_unitario: 12_950 })
    const final = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', item),
        // 15 % de 12.950 serían 1.943; el evento dice 1.000 y eso es lo que se proyecta.
        descuentoEvento(pedido, 'item', 'porcentaje', 1500, [[item.item_id, 1000]]),
      ],
      estado,
    )
    expect(totalesPedido(final)).toMatchObject({ descuento: 1000, neto: 11_950 })
  })

  it('las cuentas, la propina sugerida y el ajuste de redondeo son los del evento', () => {
    const { pedido, estado } = pedidoAbierto()
    const [a, b] = cuentasDe([70_000, 10_000], [123, 4])
    if (!a || !b) throw new Error('faltan cuentas')
    const dividido = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 100_000 })),
        evento(pedido, 'CuentaDividida', { cuentas: [a, b] }),
      ],
      estado,
    )
    expect(dividido.cuentas).toEqual([
      { id: a.cuenta_id, nombre: 'Cuenta 1', monto: 70_000, propinaSugerida: 123 },
      { id: b.cuenta_id, nombre: 'Cuenta 2', monto: 10_000, propinaSugerida: 4 },
    ])

    const conPrecuenta = aplicarTodos(
      [
        evento(pedido, 'PrecuentaImpresa', {
          cuenta_id: a.cuenta_id,
          subtotal: 7,
          propina_sugerida: 9,
        }),
      ],
      dividido,
    )
    expect(conPrecuenta.ultimaPrecuenta).toEqual({
      cuentaId: a.cuenta_id,
      subtotal: 7,
      propinaSugerida: 9,
    })

    // El ajuste debe ser el de la regla de redondeo: 36.860 → 36.900, ajuste +40. Uno que solo
    // cuadra (−40) se rechaza: con él se podría cerrar un pedido sin cobrarlo.
    const { pedido: p2, estado: e2 } = pedidoAbierto()
    const conItem = aplicarTodos(
      [evento(p2, 'ItemAgregado', copiaItem({ precio_unitario: 36_860 }))],
      e2,
    )
    const malo = evento(
      p2,
      'PagoRegistrado',
      pagoEfectivo(36_860, { ajuste_redondeo: -40, cambio: 3180 }),
    )
    expect(aplicarEvento(conItem, malo).problema?.tipo).toBe('ajuste_invalido')
    const pagado = aplicarTodos(
      [evento(p2, 'PagoRegistrado', pagoEfectivo(36_860, { ajuste_redondeo: 40, cambio: 3100 }))],
      conItem,
    )
    expect(Object.values(pagado.pagos)[0]?.ajusteRedondeo).toBe(40)
  })

  it('el precio, los extras y la tarifa del ítem son los copiados en el evento', () => {
    const { pedido, estado } = pedidoAbierto()
    const item = copiaItem({
      precio_unitario: 39_900,
      cantidad: 2,
      tarifa: 1900,
      impuesto_tipo: 'iva',
      modificadores: [{ modificador_id: nuevoId(), nombre: 'Queso', precio_extra: 3000 }],
    })
    const final = aplicarTodos([evento(pedido, 'ItemAgregado', item)], estado)
    expect(totalesPedido(final).bruto).toBe(85_800)
    expect(final.items[item.item_id]).toMatchObject({
      precioUnitario: 39_900,
      tarifa: 1900,
      impuestoTipo: 'iva',
    })
  })

  it('aplicarEvento nunca lanza, con ningún tipo de evento ni estado, aunque los datos falten', () => {
    const { pedido, estado } = pedidoAbierto()
    const cerrado = aplicarTodos([evento(pedido, 'PedidoCerrado', {})], estado)
    const base = evento(pedido, 'ComandaReimpresa', { comanda_id: nuevoId() })
    const basura: unknown[] = [null, undefined, 42, 'texto', [], {}, { item_ids: 'x', items: null }]

    for (const tipo of TIPOS_EVENTO_PEDIDO) {
      for (const datos of basura) {
        const malo = { ...base, tipo, datos } as unknown as EventoPedido
        for (const previo of [null, estado, cerrado] as (EstadoPedido | null)[]) {
          const r = aplicarEvento(previo, malo)
          expect(r).toHaveProperty('estado')
          expect(r).toHaveProperty('problema')
        }
      }
    }
    // Y un evento con el sobre incompleto.
    const sinSobre = { tipo: 'ItemAgregado', datos: copiaItem() } as unknown as EventoPedido
    expect(() => aplicarEvento(estado, sinSobre)).not.toThrow()
  })
})

describe('informes: día operativo y pagos entre turnos', () => {
  it('abono en una mesa aún abierta: el saldo queda abierto y no hay día operativo', () => {
    const { pedido, estado } = pedidoAbierto()
    const abonado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem()),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(20_000)),
      ],
      estado,
    )
    expect(abonado).toMatchObject({ estado: 'abierto', diaOperativo: null })
    expect(totalesPedido(abonado)).toMatchObject({ pagado: 20_000, saldo: 20_900 })
  })

  it('abono antes del corte de día y cierre después: el día es el del cierre', () => {
    const { pedido, estado } = pedidoAbierto()
    const tardeAyer = evento(
      pedido,
      'PagoRegistrado',
      pagoTarjeta(20_000, { turno_caja_id: nuevoId() }),
      { dia_operativo: '2026-10-23' },
    )
    const cerrado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem(), { dia_operativo: '2026-10-23' }),
        deNuevo(tardeAyer),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(20_900), { dia_operativo: '2026-10-24' }),
        evento(pedido, 'PedidoCerrado', {}, { dia_operativo: '2026-10-24' }),
      ],
      estado,
    )
    expect(cerrado.diaOperativo).toBe('2026-10-24')
    // Σ neto = Σ monto, sin importar el día o turno en que se registró cada pago.
    const montos = Object.values(cerrado.pagos).reduce((a, p) => a + p.monto, 0)
    expect(montos).toBe(totalesPedido(cerrado).neto)
    expect(new Set(Object.values(cerrado.pagos).map((p) => p.turnoCajaId)).size).toBe(2)
  })

  it('reapertura de otro día: el pedido conserva el día del primer cierre', () => {
    const { pedido, estado } = pedidoAbierto()
    const item = copiaItem({ precio_unitario: 10_000 })
    const extra = copiaItem({ precio_unitario: 5000 })
    const primerCierre = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', item),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(10_000)),
        evento(pedido, 'PedidoCerrado', {}, { dia_operativo: '2026-10-23' }),
      ],
      estado,
    )
    const reabierto = aplicarTodos(
      [
        evento(pedido, 'PedidoReabierto', {}, { ...MOTIVO, dia_operativo: '2026-10-24' }),
        evento(pedido, 'ItemAgregado', extra, { dia_operativo: '2026-10-24' }),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(5000), { dia_operativo: '2026-10-24' }),
        evento(pedido, 'PedidoCerrado', {}, { dia_operativo: '2026-10-24' }),
      ],
      primerCierre,
    )
    expect(reabierto.diaOperativo).toBe('2026-10-23')
    expect(totalesPedido(reabierto)).toMatchObject({ neto: 15_000, pagado: 15_000, saldo: 0 })
  })
})

describe('mover y unir: el total se conserva', () => {
  it('unir un pedido con descuento exige retirarlo antes: el descuento nunca se pierde', () => {
    const origen = pedidoAbierto()
    const destino = pedidoAbierto()
    const pizza = copiaItem()
    const descuento = descuentoEvento(origen.pedido, 'item', 'valor', 5000, [[pizza.item_id, 5000]])
    const conDescuento = aplicarTodos(
      [evento(origen.pedido, 'ItemAgregado', pizza), descuento],
      origen.estado,
    )
    const unir = evento(
      destino.pedido,
      'PedidosUnidos',
      {
        pedido_origen_id: origen.pedido,
        items: [{ item: pizza, estado: 'pendiente', cantidad_anulada: 0, agregado_por: MESERO }],
      },
      { relacionados: [origen.pedido] },
    )
    expect(problemaDe(conDescuento, unir)).toBe('tiene_descuentos')

    const sinDescuento = aplicarTodos(
      [
        evento(
          origen.pedido,
          'DescuentoRetirado',
          { descuento_id: descuento.datos.descuento_id },
          MOTIVO,
        ),
      ],
      conDescuento,
    )
    const otraVez = deNuevo(unir)
    const despues =
      totalesPedido(aplicarTodos([otraVez], sinDescuento)).neto +
      totalesPedido(aplicarTodos([otraVez], destino.estado)).neto
    expect(despues).toBe(40_900)
  })

  it('mover un ítem entre pedidos conserva bruto, anulado y neto de los dos', () => {
    const origen = pedidoAbierto()
    const destino = pedidoAbierto()
    const cervezas = copiaItem({ precio_unitario: 14_900, cantidad: 3 })
    const enviada = aplicarTodos(
      [
        evento(origen.pedido, 'ItemAgregado', cervezas),
        enviarItems(origen.pedido, [cervezas.item_id]),
        evento(
          origen.pedido,
          'ItemAnulado',
          { item_id: cervezas.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
          MOTIVO,
        ),
      ],
      origen.estado,
    )
    const mover = evento(
      origen.pedido,
      'ItemsMovidos',
      {
        pedido_destino_id: destino.pedido,
        items: [
          {
            item: cervezas,
            estado: 'enviado',
            cantidad_anulada: 1,
            agregado_por: MESERO,
          },
        ],
      },
      { relacionados: [destino.pedido] },
    )
    const nuevoOrigen = aplicarTodos([mover], enviada)
    const nuevoDestino = aplicarTodos([mover], destino.estado)
    expect(totalesPedido(nuevoOrigen)).toMatchObject({ bruto: 0, anulado: 0, neto: 0 })
    expect(totalesPedido(nuevoDestino)).toMatchObject({
      bruto: 44_700,
      anulado: 14_900,
      neto: 29_800,
    })
  })
})
