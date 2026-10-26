import { describe, expect, it } from 'vitest'
import type { EventoPedido } from '../eventos/pedido'
import { nuevoId } from '../id'
import { reconstruir } from '../pedido/aplicar'
import type { EstadoPedido } from '../pedido/estado'
import {
  copiaItem,
  enOrden,
  evento,
  MESERO,
  pagoEfectivo,
  pagoTarjeta,
  TURNO,
} from '../pruebas/fabrica'
import { type EntradaInforme, informe } from './informe'

// Casos borde del informe (tarea 1.9): redondeo del promedio, textos de respaldo, medios propios,
// reembolsos de otro día, propinas y lo que pasa cuando una mesa se une o se mueve después de
// anular algo.

const CONFIG: EntradaInforme['config'] = {
  ventas_por_mesero: 'quien_agrega',
  redondeo_modo: 'mitad_arriba',
}
const DIA = '2026-10-24'
const periodo = { desde: DIA, hasta: DIA }

/** Aplica en el orden dado (con secuencias crecientes) y devuelve el estado de `pedidoId`. */
function estadoDe(eventos: EventoPedido[], pedidoId: string): EstadoPedido {
  let ultima = 0
  const ordenados = eventos.map((e) => {
    const nuevo = enOrden(e, ultima)
    ultima = nuevo.secuencia
    return nuevo
  })
  const estado = reconstruir(ordenados, pedidoId)
  if (!estado) throw new Error('El pedido no se reconstruyó')
  return estado
}

const abrir = (id: string, comensales = 2) =>
  evento(id, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales })
const enviar = (id: string, itemIds: string[]) =>
  evento(id, 'ItemsEnviados', {
    comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: itemIds }],
  })

describe('informe: promedios', () => {
  it('con mitad_par el ticket promedio lleva la mitad al par; con mitad_arriba, hacia arriba', () => {
    // 3 cuentas de 1 peso y 1 de 2 pesos no sirve: se necesita neto/cuentas = x,5.
    // Cuentas de 10.001 y 10.000: 20.001 ÷ 2 = 10.000,5.
    const pedidos = [10_001, 10_000].map((precio) => {
      const id = nuevoId()
      const item = copiaItem({ precio_unitario: precio })
      const eventos = [
        abrir(id),
        evento(id, 'ItemAgregado', item),
        evento(id, 'PagoRegistrado', pagoEfectivo(precio)),
        evento(id, 'PedidoCerrado', {}, { dia_operativo: DIA }),
      ]
      return estadoDe(eventos, id)
    })
    const base = { ...periodo, cerrados: pedidos, relacionados: [], eventos: [] }
    expect(informe({ ...base, config: CONFIG }).ventas.ticketPromedio).toBe(10_001)
    expect(
      informe({ ...base, config: { ...CONFIG, redondeo_modo: 'mitad_par' } }).ventas.ticketPromedio,
    ).toBe(10_000)
  })

  it('el gasto por comensal usa los comensales de todos los pedidos, también los sin cuenta', () => {
    const a = nuevoId()
    const b = nuevoId()
    const itemA = copiaItem({ precio_unitario: 30_000 })
    const pedidoA = estadoDe(
      [
        abrir(a, 3),
        evento(a, 'ItemAgregado', itemA),
        evento(a, 'PagoRegistrado', pagoEfectivo(30_000)),
        evento(a, 'PedidoCerrado', {}, { dia_operativo: DIA }),
      ],
      a,
    )
    // Un pedido sin nada: cerrado con 1 comensal, no cuenta como cuenta.
    const pedidoB = estadoDe(
      [abrir(b, 1), evento(b, 'PedidoCerrado', {}, { dia_operativo: DIA })],
      b,
    )
    const r = informe({
      ...periodo,
      cerrados: [pedidoA, pedidoB],
      relacionados: [],
      eventos: [],
      config: CONFIG,
    })
    expect(r.ventas).toMatchObject({ cuentas: 1, comensales: 4, gastoPorComensal: 7_500 })
    expect(r.ventas.ticketPromedio).toBe(30_000)
  })
})

describe('informe: textos de respaldo y horas', () => {
  it('una anulación o cancelación de un pedido que no se conoce no inventa valores', () => {
    const id = nuevoId()
    const anulado = evento(
      id,
      'ItemAnulado',
      { item_id: nuevoId(), cantidad: 2, ya_preparado: true, comanda_id: null },
      { motivo: 'Se cayó', hora_estimada_hub: '2026-10-24T21:00:00.000Z', recibido_en: undefined },
    )
    const cancelado = evento(id, 'PedidoCancelado', {}, { motivo: 'x' })
    const r = informe({
      ...periodo,
      cerrados: [],
      relacionados: [],
      eventos: [anulado, cancelado],
      config: CONFIG,
    })
    expect(r.anulaciones).toEqual([
      expect.objectContaining({
        nombre: 'Producto',
        valor: 0,
        pedidoNumero: null,
        unidades: 2,
        // Sin hora de recibido cae a la estimada por el hub.
        hora: '2026-10-24T21:00:00.000Z',
        autorizadoPorId: null,
      }),
    ])
    expect(r.cancelaciones).toEqual([expect.objectContaining({ valor: 0, pedidoNumero: null })])
  })

  it('el número del pedido sale del estado y quien autorizó, del evento', () => {
    const id = nuevoId()
    const item = copiaItem({ precio_unitario: 8_000, cantidad: 3 })
    const autoriza = nuevoId()
    const eventos = [
      abrir(id),
      evento(id, 'ItemAgregado', item),
      enviar(id, [item.item_id]),
      evento(
        id,
        'ItemAnulado',
        { item_id: item.item_id, cantidad: 2, ya_preparado: false, comanda_id: null },
        { motivo: 'Error', autorizado_por_id: autoriza },
      ),
    ]
    const estado = estadoDe(eventos, id)
    const r = informe({
      ...periodo,
      cerrados: [],
      relacionados: [{ ...estado, numeroDia: 7 }],
      eventos,
      config: CONFIG,
    })
    expect(r.anulaciones[0]).toMatchObject({
      pedidoNumero: 7,
      valor: 16_000,
      autorizadoPorId: autoriza,
      usuarioId: MESERO,
    })
  })
})

describe('informe: medios y reembolsos', () => {
  it('un medio propio va aparte por su id, y su anulación resta de ese mismo medio', () => {
    const propio = nuevoId()
    const otro = nuevoId()
    const id = nuevoId()
    const item = copiaItem({ precio_unitario: 40_000 })
    const p1 = pagoTarjeta(10_000, { medio: 'otro', medio_propio_id: propio, datafono: null })
    const p2 = pagoTarjeta(10_000, { medio: 'otro', medio_propio_id: otro, datafono: null })
    const eventos = [
      abrir(id),
      evento(id, 'ItemAgregado', item),
      evento(id, 'PagoRegistrado', p1),
      evento(id, 'PagoRegistrado', p2),
      evento(id, 'PagoAnulado', { pago_id: p1.pago_id, turno_caja_id: TURNO }, { motivo: 'm' }),
    ]
    const r = informe({
      ...periodo,
      cerrados: [],
      relacionados: [estadoDe(eventos, id)],
      eventos,
      config: CONFIG,
    })
    // El propio anulado queda en 0 pagos y no sale; el otro sigue.
    expect(r.porMedio).toEqual([
      { medio: 'otro', medioPropioId: otro, venta: 10_000, propina: 0, pagos: 1 },
    ])
  })

  it('un reembolso de hoy de un pago de ayer resta hoy, con el medio y la propina del reembolso', () => {
    const id = nuevoId()
    const item = copiaItem({ precio_unitario: 30_000 })
    const pago = pagoTarjeta(30_000, { propina: 3_000 })
    const reembolso = evento(
      id,
      'ReembolsoRegistrado',
      {
        pago_id: pago.pago_id,
        reembolso_id: nuevoId(),
        monto_venta: 5_000,
        monto_propina: 500,
        medio: 'tarjeta',
        turno_caja_id: TURNO,
      },
      { motivo: 'Cobro de más', dia_operativo: DIA },
    )
    const eventos = [
      abrir(id),
      evento(id, 'ItemAgregado', item),
      evento(id, 'PagoRegistrado', pago, { dia_operativo: '2026-10-23' }),
      reembolso,
    ]
    const hoy = informe({
      ...periodo,
      cerrados: [],
      relacionados: [estadoDe(eventos, id)],
      eventos,
      config: CONFIG,
    })
    expect(hoy.porMedio).toEqual([
      { medio: 'tarjeta', medioPropioId: null, venta: -5_000, propina: -500, pagos: 0 },
    ])
    expect(hoy.fondoPropinas.propinas).toBe(-500)
    const ayer = informe({
      desde: '2026-10-23',
      hasta: '2026-10-23',
      cerrados: [],
      relacionados: [],
      eventos,
      config: CONFIG,
    })
    expect(ayer.porMedio).toEqual([
      { medio: 'tarjeta', medioPropioId: null, venta: 30_000, propina: 3_000, pagos: 1 },
    ])
  })

  it('la propina de un pedido cerrado resta lo reembolsado y el neto resta la venta reembolsada', () => {
    const id = nuevoId()
    const item = copiaItem({ precio_unitario: 20_000, cantidad: 2 })
    const pago = pagoEfectivo(40_000, { propina: 4_000 })
    const eventos = [
      abrir(id),
      evento(id, 'ItemAgregado', item),
      enviar(id, [item.item_id]),
      evento(id, 'PagoRegistrado', pago),
      evento(id, 'PedidoCerrado', {}, { dia_operativo: DIA }),
      evento(id, 'PedidoReabierto', {}, { motivo: 'm' }),
      evento(
        id,
        'ReembolsoRegistrado',
        {
          pago_id: pago.pago_id,
          reembolso_id: nuevoId(),
          monto_venta: 20_000,
          monto_propina: 1_000,
          medio: 'efectivo',
          turno_caja_id: TURNO,
        },
        { motivo: 'm' },
      ),
      evento(
        id,
        'ItemAnulado',
        { item_id: item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
        { motivo: 'm' },
      ),
      evento(id, 'PedidoCerrado', {}, { dia_operativo: '2026-10-25' }),
    ]
    const estado = estadoDe(eventos, id)
    expect(estado.estado).toBe('cerrado')
    // Se reabre y se cierra otra vez: sigue siendo del día de su primer cierre.
    expect(estado.diaOperativo).toBe(DIA)
    const r = informe({ ...periodo, cerrados: [estado], relacionados: [], eventos, config: CONFIG })
    expect(r.ventas).toMatchObject({ neto: 20_000, anulado: 20_000, propinas: 3_000, cuentas: 1 })
  })
})

describe('informe: mesas unidas o movidas después de anular', () => {
  // Al unir dos mesas el pedido de origen queda cancelado y vacío: la anulación hecha en él se
  // explica con el pedido tal como estaba justo antes de anular (`alAnular`, que arma el hub).
  it('la anulación hecha antes de unir las mesas sigue con su producto y su valor', () => {
    const origen = nuevoId()
    const destino = nuevoId()
    const item = copiaItem({ precio_unitario: 12_000, cantidad: 2, nombre: 'Limonada' })
    const antes = [
      abrir(origen),
      abrir(destino),
      evento(origen, 'ItemAgregado', item),
      enviar(origen, [item.item_id]),
    ]
    const anula = evento(
      origen,
      'ItemAnulado',
      { item_id: item.item_id, cantidad: 1, ya_preparado: true, comanda_id: null },
      { motivo: 'Se cayó' },
    )
    const une = evento(
      destino,
      'PedidosUnidos',
      {
        pedido_origen_id: origen,
        items: [{ item, estado: 'enviado', cantidad_anulada: 1, agregado_por: MESERO }],
      },
      { relacionados: [origen] },
    )
    const eventos = [...antes, anula, une]
    const a = estadoDe(eventos, origen)
    const b = estadoDe(eventos, destino)
    expect(a.estado).toBe('cancelado')
    expect(b.items[item.item_id]).toMatchObject({ cantidad: 2, cantidadAnulada: 1 })
    const alAnular = new Map([[anula.id, estadoDe([...antes, anula].slice(0, -1), origen)]])
    const r = informe({
      ...periodo,
      cerrados: [],
      relacionados: [a, b],
      alAnular,
      eventos,
      config: CONFIG,
    })
    expect(r.anulaciones).toHaveLength(1)
    expect(r.anulaciones[0]).toMatchObject({ nombre: 'Limonada', valor: 12_000 })
  })

  it('el impuesto se suma entre pedidos y se redondea una vez por grupo', () => {
    // Tres cuentas de $16.000 al 8 %: cada una lleva $1.185,19; juntas, $3.555,56 → $3.556
    // (redondeando cada cuenta daría $3.555).
    const pedidos = [1, 2, 3].map(() => {
      const id = nuevoId()
      const item = copiaItem({ precio_unitario: 16_000 })
      return estadoDe(
        [
          abrir(id),
          evento(id, 'ItemAgregado', item),
          evento(id, 'PagoRegistrado', pagoEfectivo(16_000)),
          evento(id, 'PedidoCerrado', {}, { dia_operativo: DIA }),
        ],
        id,
      )
    })
    const r = informe({
      ...periodo,
      cerrados: pedidos,
      relacionados: [],
      eventos: [],
      config: CONFIG,
    })
    expect(r.ventas.impuestos).toEqual([
      { tipo: 'inc', tarifa: 800, base: 48_000 - 3_556, impuesto: 3_556 },
    ])
  })

  it('el ajuste por redondeo del efectivo suma los pagos de los pedidos cerrados', () => {
    const pedido = (precio: number, ajuste: number) => {
      const id = nuevoId()
      return estadoDe(
        [
          abrir(id),
          evento(id, 'ItemAgregado', copiaItem({ precio_unitario: precio })),
          evento(id, 'PagoRegistrado', pagoEfectivo(precio, { ajuste_redondeo: ajuste })),
          evento(id, 'PedidoCerrado', {}, { dia_operativo: DIA }),
        ],
        id,
      )
    }
    const r = informe({
      ...periodo,
      cerrados: [pedido(12_960, 40), pedido(12_920, -20), pedido(10_000, 0)],
      relacionados: [],
      eventos: [],
      config: CONFIG,
    })
    expect(r.ventas.ajustes).toBe(20)
  })
})
