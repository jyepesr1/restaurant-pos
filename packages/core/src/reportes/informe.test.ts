import { describe, expect, it } from 'vitest'
import type { EventoPedido } from '../eventos/pedido'
import { nuevoId } from '../id'
import { aplicarEvento } from '../pedido/aplicar'
import type { EstadoPedido } from '../pedido/estado'
import { totalesPedido } from '../pedido/totales'
import { copiaItem, enOrden, evento, pagoEfectivo, pagoTarjeta, TURNO } from '../pruebas/fabrica'
import { type EntradaInforme, informe } from './informe'

// Los reportes básicos (tarea 1.9) con las fórmulas de docs/KPIS.md.

const ANA = nuevoId()
const LUIS = nuevoId()
const CONFIG: EntradaInforme['config'] = {
  ventas_por_mesero: 'quien_agrega',
  redondeo_modo: 'mitad_arriba',
}

function aplicar(eventos: EventoPedido[], desde: EstadoPedido | null = null): EstadoPedido {
  return eventos.reduce<EstadoPedido | null>((estado, e) => {
    const r = aplicarEvento(estado, enOrden(e, estado?.ultimaSecuencia ?? 0))
    if (r.problema) throw new Error(`${e.tipo}: ${r.problema.tipo}`)
    return r.estado
  }, desde) as EstadoPedido
}

/** Un pedido con sus eventos, para armar escenarios y quedarse con los del período. */
function pedido(comensales = 2, mesero = ANA) {
  const id = nuevoId()
  const eventos: EventoPedido[] = [
    evento(
      id,
      'PedidoAbierto',
      { canal: 'salon', mesa_id: nuevoId(), comensales },
      { usuario_id: mesero },
    ),
  ]
  const agregar = (campos: Parameters<typeof copiaItem>[0] = {}, por = mesero) => {
    const item = copiaItem(campos)
    eventos.push(evento(id, 'ItemAgregado', item, { usuario_id: por }))
    // Enviado a cocina de una vez: solo lo enviado se anula (lo demás se quita).
    eventos.push(
      evento(id, 'ItemsEnviados', {
        comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [item.item_id] }],
      }),
    )
    return item
  }
  const registrar = (e: EventoPedido) => {
    eventos.push(e)
    return e
  }
  return {
    id,
    eventos,
    agregar,
    registrar,
    pagar: (datos: ReturnType<typeof pagoEfectivo>, dia = '2026-10-24') =>
      registrar(evento(id, 'PagoRegistrado', datos, { dia_operativo: dia })),
    cerrar: (dia = '2026-10-24') =>
      registrar(evento(id, 'PedidoCerrado', {}, { dia_operativo: dia })),
    estado: () => aplicar(eventos),
  }
}

const periodo = { desde: '2026-10-24', hasta: '2026-10-24' }

describe('informe: ventas', () => {
  it('suma bruto, anulado, descuentos, neto, propinas, cuentas y comensales', () => {
    const a = pedido(3)
    const margarita = a.agregar({ precio_unitario: 40_900, cantidad: 2 })
    a.registrar(
      evento(
        a.id,
        'ItemAnulado',
        { item_id: margarita.item_id, cantidad: 1, ya_preparado: true, comanda_id: null },
        { motivo: 'Se cayó' },
      ),
    )
    a.agregar({ precio_unitario: 12_000, impuesto_tipo: 'iva', tarifa: 1900 })
    a.pagar(pagoEfectivo(52_900, { propina: 5_000 }))
    a.cerrar()

    const b = pedido(2, LUIS)
    b.agregar({ precio_unitario: 30_000 })
    b.pagar(pagoTarjeta(30_000, { propina: 3_000 }))
    b.cerrar()

    const r = informe({
      ...periodo,
      cerrados: [a.estado(), b.estado()],
      relacionados: [],
      eventos: [...a.eventos, ...b.eventos],
      config: CONFIG,
    })
    expect(r.ventas).toMatchObject({
      bruto: 81_800 + 12_000 + 30_000,
      anulado: 40_900,
      descuentos: 0,
      neto: 82_900,
      propinas: 8_000,
      cuentas: 2,
      comensales: 5,
      ticketPromedio: 41_450,
      gastoPorComensal: 16_580,
    })
    // Base más impuesto da el neto.
    expect(r.ventas.impuestos.reduce((s, i) => s + i.base + i.impuesto, 0)).toBe(82_900)
    expect(r.ventas.impuestos.map((i) => `${i.tipo}:${i.tarifa}`)).toEqual(['inc:800', 'iva:1900'])
  })

  it('el ticket promedio redondea mitad hacia arriba y da 0 sin cuentas ni comensales', () => {
    const p = [10_001, 10_000].map((precio) => {
      const x = pedido(0)
      x.agregar({ precio_unitario: precio })
      x.pagar(pagoEfectivo(precio))
      x.cerrar()
      return x
    })
    const r = informe({
      ...periodo,
      cerrados: p.map((x) => x.estado()),
      relacionados: [],
      eventos: p.flatMap((x) => x.eventos),
      config: CONFIG,
    })
    expect(r.ventas.ticketPromedio).toBe(10_001) // 20.001 ÷ 2 = 10.000,5 → 10.001
    expect(r.ventas.gastoPorComensal).toBe(0)

    const vacio = informe({
      ...periodo,
      cerrados: [],
      relacionados: [],
      eventos: [],
      config: CONFIG,
    })
    expect(vacio.ventas).toMatchObject({ neto: 0, cuentas: 0, ticketPromedio: 0 })
  })

  it('una cortesía total no cuenta como cuenta pero sí como comensales', () => {
    const x = pedido(4)
    const item = x.agregar({ precio_unitario: 20_000 })
    x.registrar(
      evento(
        x.id,
        'DescuentoAplicado',
        {
          descuento_id: nuevoId(),
          alcance: 'item',
          regla: 'cortesia',
          valor: 0,
          cantidad_unidades: 1,
          montos: [{ item_id: item.item_id, monto: 20_000 }],
        },
        { motivo: 'Cumpleaños' },
      ),
    )
    x.cerrar()
    const r = informe({
      ...periodo,
      cerrados: [x.estado()],
      relacionados: [],
      eventos: x.eventos,
      config: CONFIG,
    })
    expect(r.ventas).toMatchObject({ bruto: 20_000, descuentos: 20_000, neto: 0, cuentas: 0 })
    expect(r.ventas.comensales).toBe(4)
    expect(r.descuentos).toEqual([
      {
        pedidoId: x.id,
        pedidoNumero: null,
        regla: 'cortesia',
        valor: 0,
        monto: 20_000,
        motivo: 'Cumpleaños',
      },
    ])
    expect(r.porMesero).toEqual([])
  })
})

describe('informe: por medio de pago', () => {
  it('cuenta los pagos registrados en el período, no los del pedido cerrado', () => {
    // Un abono de ayer en un pedido que se cierra hoy: cuenta ayer por medio y hoy en ventas.
    const x = pedido()
    x.agregar({ precio_unitario: 50_000 })
    x.pagar(pagoTarjeta(20_000), '2026-10-23')
    x.pagar(pagoEfectivo(30_000, { propina: 2_000 }))
    x.cerrar()
    const r = informe({
      ...periodo,
      cerrados: [x.estado()],
      relacionados: [],
      eventos: x.eventos,
      config: CONFIG,
    })
    expect(r.ventas.neto).toBe(50_000)
    expect(r.porMedio).toEqual([
      expect.objectContaining({ medio: 'efectivo', venta: 30_000, propina: 2_000 }),
    ])
    expect(r.fondoPropinas).toEqual({ propinas: 2_000, pagadas: 0, saldo: 2_000 })
  })

  it('una anulación de hoy de un pago de ayer resta hoy', () => {
    const x = pedido()
    x.agregar({ precio_unitario: 15_000 })
    const pago = pagoTarjeta(15_000, { propina: 1_500 })
    x.pagar(pago, '2026-10-23')
    x.registrar(
      evento(
        x.id,
        'PagoAnulado',
        { pago_id: pago.pago_id, turno_caja_id: TURNO },
        { motivo: 'Error', dia_operativo: '2026-10-24' },
      ),
    )
    const r = informe({
      ...periodo,
      cerrados: [],
      relacionados: [x.estado()],
      eventos: x.eventos,
      config: CONFIG,
    })
    expect(r.porMedio).toEqual([
      expect.objectContaining({ medio: 'tarjeta', venta: -15_000, propina: -1_500 }),
    ])
    expect(r.fondoPropinas.propinas).toBe(-1_500)
  })
})

describe('informe: por mesero y por producto', () => {
  it('reparte a quien agregó cada ítem, o al mesero de la mesa si así se configura', () => {
    const x = pedido(2, ANA)
    x.agregar({ precio_unitario: 40_000 }, ANA)
    x.agregar({ precio_unitario: 10_000 }, LUIS)
    x.pagar(pagoEfectivo(50_000))
    x.cerrar()
    const entrada = {
      ...periodo,
      cerrados: [x.estado()],
      relacionados: [],
      eventos: x.eventos,
    }
    expect(informe({ ...entrada, config: CONFIG }).porMesero).toEqual([
      { usuarioId: ANA, neto: 40_000, cuentas: 1, ticketPromedio: 40_000 },
      { usuarioId: LUIS, neto: 10_000, cuentas: 1, ticketPromedio: 10_000 },
    ])
    const asignado = informe({
      ...entrada,
      config: { ...CONFIG, ventas_por_mesero: 'mesero_asignado' },
    })
    expect(asignado.porMesero).toEqual([
      { usuarioId: x.estado().meseroAsignadoId, neto: 50_000, cuentas: 1, ticketPromedio: 50_000 },
    ])
  })

  it('agrupa por producto y variante, con unidades vendidas sin las anuladas', () => {
    const producto = nuevoId()
    const otra = nuevoId()
    const x = pedido()
    const a = x.agregar({ producto_id: producto, cantidad: 3, precio_unitario: 10_000 })
    x.agregar({ producto_id: producto, cantidad: 1, precio_unitario: 10_000 })
    x.agregar({
      producto_id: producto,
      variante_id: otra,
      nombre: 'Grande',
      precio_unitario: 15_000,
    })
    x.registrar(
      evento(
        x.id,
        'ItemAnulado',
        { item_id: a.item_id, cantidad: 3, ya_preparado: false, comanda_id: null },
        { motivo: 'Cambió de idea' },
      ),
    )
    x.pagar(pagoEfectivo(25_000))
    x.cerrar()
    const r = informe({
      ...periodo,
      cerrados: [x.estado()],
      relacionados: [],
      eventos: x.eventos,
      config: CONFIG,
    })
    expect(r.porProducto).toEqual([
      expect.objectContaining({ varianteId: otra, unidades: 1, neto: 15_000 }),
      expect.objectContaining({ varianteId: null, unidades: 1, neto: 10_000 }),
    ])
    expect(r.porProducto.reduce((s, p) => s + p.neto, 0)).toBe(r.ventas.neto)
    expect(r.anulaciones).toEqual([
      expect.objectContaining({
        pedidoId: x.id,
        unidades: 3,
        valor: 30_000,
        motivo: 'Cambió de idea',
        yaPreparado: false,
      }),
    ])
  })
})

describe('informe: anulaciones, cancelaciones y caja', () => {
  it('lista las cancelaciones del período con lo que tenía el pedido', () => {
    const x = pedido()
    x.agregar({ precio_unitario: 22_000 })
    x.registrar(evento(x.id, 'PedidoCancelado', {}, { motivo: 'Se fueron' }))
    const estado = x.estado()
    const r = informe({
      ...periodo,
      cerrados: [],
      relacionados: [estado],
      eventos: x.eventos,
      config: CONFIG,
    })
    expect(r.cancelaciones).toEqual([
      expect.objectContaining({ pedidoId: x.id, valor: 22_000, motivo: 'Se fueron' }),
    ])
    expect(r.ventas.neto).toBe(0)
  })

  it('deja por fuera lo registrado fuera del período', () => {
    const x = pedido()
    const item = x.agregar({ precio_unitario: 9_000, cantidad: 2 })
    x.registrar(
      evento(
        x.id,
        'ItemAnulado',
        { item_id: item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
        { motivo: 'm', dia_operativo: '2026-10-25' },
      ),
    )
    const r = informe({
      ...periodo,
      cerrados: [],
      relacionados: [x.estado()],
      eventos: x.eventos,
      config: CONFIG,
    })
    expect(r.anulaciones).toEqual([])
  })

  it('el fondo de propinas resta lo pagado desde la caja en el período', () => {
    const x = pedido()
    x.agregar({ precio_unitario: 40_000 })
    x.pagar(pagoEfectivo(40_000, { propina: 4_000 }))
    x.cerrar()
    const turno = nuevoId()
    const pagoPropinas = evento(
      turno,
      'MovimientoCajaRegistrado',
      {
        movimiento_id: nuevoId(),
        tipo: 'pago_propinas',
        monto: 3_000,
        descripcion: 'Propinas',
        a_quien: 'Equipo',
        dias: ['2026-10-24'],
      },
      { agregado_tipo: 'turno_caja' } as never,
    )
    const r = informe({
      ...periodo,
      cerrados: [x.estado()],
      relacionados: [],
      eventos: [...x.eventos, pagoPropinas],
      config: CONFIG,
    })
    expect(r.fondoPropinas).toEqual({ propinas: 4_000, pagadas: 3_000, saldo: 1_000 })
  })

  it('el neto coincide con lo pagado por los pedidos cerrados (identidad de KPIS.md)', () => {
    const pedidos = [12_345, 67_890, 1_000].map((precio, i) => {
      const x = pedido(i + 1)
      x.agregar({ precio_unitario: precio })
      x.pagar(pagoEfectivo(precio))
      x.cerrar()
      return x.estado()
    })
    const r = informe({
      ...periodo,
      cerrados: pedidos,
      relacionados: [],
      eventos: [],
      config: CONFIG,
    })
    expect(r.ventas.neto).toBe(pedidos.reduce((s, p) => s + totalesPedido(p).neto, 0))
  })
})

describe('informe: impuestos y ajuste por redondeo (auditoría de dinero)', () => {
  it('suma las centésimas de todos los pedidos y redondea una sola vez: 3 × $16.000 al 8 % = $3.556', () => {
    const pedidos = [1, 2, 3].map(() => {
      const x = pedido()
      x.agregar({ precio_unitario: 16_000 })
      x.pagar(pagoEfectivo(16_000))
      x.cerrar()
      return x.estado()
    })
    const r = informe({
      ...periodo,
      cerrados: pedidos,
      relacionados: [],
      eventos: [],
      config: CONFIG,
    })
    // Cada pedido redondeado daría $1.185 × 3 = $3.555.
    expect(r.ventas.impuestos).toEqual([
      { tipo: 'inc', tarifa: 800, base: 44_444, impuesto: 3_556 },
    ])
  })

  it('el ajuste por redondeo del efectivo es su propio renglón, y no cambia el neto', () => {
    const x = pedido()
    x.agregar({ precio_unitario: 36_810 })
    x.pagar(pagoEfectivo(36_810, { ajuste_redondeo: -10 }))
    x.cerrar()
    const r = informe({
      ...periodo,
      cerrados: [x.estado()],
      relacionados: [],
      eventos: x.eventos,
      config: CONFIG,
    })
    expect(r.ventas).toMatchObject({ neto: 36_810, ajustes: -10 })
    expect(r.porMedio[0]).toMatchObject({ medio: 'efectivo', venta: 36_800 })
  })

  it('una anulación toma el ítem del pedido como estaba al anular (aunque luego se mueva)', () => {
    const x = pedido()
    const limonada = x.agregar({ nombre: 'Limonada', precio_unitario: 12_000, cantidad: 2 })
    const anulacion = x.registrar(
      evento(
        x.id,
        'ItemAnulado',
        { item_id: limonada.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
        { motivo: 'm' },
      ),
    )
    const antes = x.estado()
    // Sin el estado al anular, un pedido que ya no tiene el ítem lo mostraría en $0.
    const vacio = { ...antes, items: {} }
    const r = informe({
      ...periodo,
      cerrados: [],
      relacionados: [vacio],
      alAnular: new Map([[anulacion.id, antes]]),
      eventos: x.eventos,
      config: CONFIG,
    })
    expect(r.anulaciones).toEqual([
      expect.objectContaining({ nombre: 'Limonada', unidades: 1, valor: 12_000 }),
    ])
  })
})
