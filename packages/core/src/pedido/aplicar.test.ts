import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { cobradoEnEfectivo, partesIguales, porcentaje, repartirDescuentoPedido } from '../dinero'
import type { EventoPedido } from '../eventos/pedido'
import { nuevoId } from '../id'
import {
  copiaItem,
  deNuevo,
  enOrden,
  evento,
  MESERO,
  pagoEfectivo,
  pagoTarjeta,
} from '../pruebas/fabrica'
import { aplicarEvento, reconstruir } from './aplicar'
import type { EstadoPedido } from './estado'
import { saldoCuenta, totalesPedido } from './totales'

/** Aplica eventos en orden y falla si alguno no se pudo aplicar. */
function aplicarTodos(eventos: EventoPedido[], inicial: EstadoPedido | null = null): EstadoPedido {
  return eventos.reduce<EstadoPedido | null>((estado, e) => {
    const r = aplicarEvento(estado, enOrden(e, estado?.ultimaSecuencia ?? 0))
    if (r.problema) throw new Error(`${e.tipo}: ${r.problema.tipo} (${r.problema.descripcion})`)
    return r.estado
  }, inicial) as EstadoPedido
}

function abierto(pedido = nuevoId()) {
  return {
    pedido,
    estado: aplicarTodos([
      evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }),
    ]),
  }
}

const enviar = (pedido: string, itemIds: string[]) =>
  evento(pedido, 'ItemsEnviados', {
    comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: itemIds }],
  })

describe('servicio completo', () => {
  it('abre, agrega, envía, cobra en efectivo redondeado y cierra', () => {
    const { pedido, estado } = abierto()
    const pizza = copiaItem()
    const cerveza = copiaItem({ nombre: 'Corona', precio_unitario: 13_900, cantidad: 2 })
    const conItems = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', pizza),
        evento(pedido, 'ItemAgregado', cerveza),
        enviar(pedido, [pizza.item_id, cerveza.item_id]),
        evento(pedido, 'ItemListo', { item_ids: [pizza.item_id] }),
        evento(pedido, 'ItemEntregado', { item_ids: [pizza.item_id] }),
        evento(pedido, 'PrecuentaImpresa', {
          cuenta_id: null,
          subtotal: 68_700,
          propina_sugerida: 6361,
        }),
      ],
      estado,
    )
    expect(totalesPedido(conItems)).toMatchObject({ bruto: 68_700, neto: 68_700, saldo: 68_700 })

    const saldo = totalesPedido(conItems).saldo
    const ajuste = cobradoEnEfectivo(saldo, 100) - saldo
    const cerrado = aplicarTodos(
      [
        evento(
          pedido,
          'PagoRegistrado',
          pagoEfectivo(saldo, { ajuste_redondeo: ajuste, propina: 6361, cambio: 4939 }),
        ),
        evento(pedido, 'PedidoCerrado', {}, { dia_operativo: '2026-10-24' }),
      ],
      conItems,
    )

    expect(cerrado.estado).toBe('cerrado')
    expect(cerrado.diaOperativo).toBe('2026-10-24')
    expect(totalesPedido(cerrado)).toMatchObject({
      saldo: 0,
      pagado: 68_700,
      propinas: 6361,
      ajustes: 0,
    })
    expect(cerrado.items[pizza.item_id]?.estado).toBe('entregado')
    expect(cerrado.items[cerveza.item_id]?.estado).toBe('enviado')
  })

  it('no modifica el estado anterior', () => {
    const { pedido, estado } = abierto()
    const congelado = structuredClone(estado)

    aplicarEvento(estado, evento(pedido, 'ItemAgregado', copiaItem()))

    expect(estado).toEqual(congelado)
  })

  it('registra quién agregó cada ítem y su orden', () => {
    const { pedido, estado } = abierto()
    const luis = nuevoId()
    const a = copiaItem()
    const b = copiaItem()
    const final = aplicarTodos(
      [evento(pedido, 'ItemAgregado', a), evento(pedido, 'ItemAgregado', b, { usuario_id: luis })],
      estado,
    )

    expect(final.items[a.item_id]).toMatchObject({ agregadoPor: MESERO })
    expect(final.items[b.item_id]).toMatchObject({ agregadoPor: luis, orden: 2 })
  })
})

describe('ciclo de vida del pedido', () => {
  it('no se puede abrir dos veces ni tocar un pedido que no existe', () => {
    const { pedido, estado } = abierto()

    expect(
      aplicarEvento(
        estado,
        evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 0 }),
      ).problema?.tipo,
    ).toBe('pedido_ya_existe')
    expect(aplicarEvento(null, evento(nuevoId(), 'ItemAgregado', copiaItem())).problema?.tipo).toBe(
      'pedido_inexistente',
    )
  })

  it('cerrar exige saldo 0; cerrado no admite cambios; reabrir conserva el día del primer cierre', () => {
    const { pedido, estado } = abierto()
    const item = copiaItem({ precio_unitario: 20_000 })
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', item)], estado)

    expect(aplicarEvento(conItem, evento(pedido, 'PedidoCerrado', {})).problema?.tipo).toBe(
      'saldo_pendiente',
    )

    const cerrado = aplicarTodos(
      [
        evento(pedido, 'PagoRegistrado', pagoTarjeta(20_000)),
        evento(pedido, 'PedidoCerrado', {}, { dia_operativo: '2026-10-23' }),
      ],
      conItem,
    )
    expect(aplicarEvento(cerrado, evento(pedido, 'ItemAgregado', copiaItem())).problema?.tipo).toBe(
      'pedido_cerrado',
    )
    expect(
      aplicarEvento(cerrado, evento(pedido, 'PedidoReabierto', {}, { motivo: 'x' })).problema,
    ).toBeNull()
    expect(
      aplicarEvento(conItem, evento(pedido, 'PedidoReabierto', {}, { motivo: 'x' })).problema?.tipo,
    ).toBe('pedido_no_cerrado')

    const reabiertoYCerrado = aplicarTodos(
      [
        evento(pedido, 'PedidoReabierto', {}, { motivo: 'Faltó un postre' }),
        evento(pedido, 'PedidoCerrado', {}, { dia_operativo: '2026-10-24' }),
      ],
      cerrado,
    )
    expect(reabiertoYCerrado.diaOperativo).toBe('2026-10-23')
  })

  it('cancelar exige que no haya pagos vigentes', () => {
    const { pedido, estado } = abierto()
    const conPago = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem()),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(10_000)),
      ],
      estado,
    )

    expect(
      aplicarEvento(conPago, evento(pedido, 'PedidoCancelado', {}, { motivo: 'm' })).problema?.tipo,
    ).toBe('tiene_pagos')
    expect(
      aplicarEvento(estado, evento(pedido, 'PedidoCancelado', {}, { motivo: 'm' })).estado?.estado,
    ).toBe('cancelado')
  })

  it('mesero, comensales y mesa', () => {
    const { pedido, estado } = abierto()
    const otro = nuevoId()
    const mesa = nuevoId()
    const final = aplicarTodos(
      [
        evento(pedido, 'MeseroAsignado', { mesero_id: otro }),
        evento(pedido, 'ComensalesCambiados', { comensales: 6 }),
        evento(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: mesa }),
      ],
      estado,
    )

    expect(final).toMatchObject({ meseroAsignadoId: otro, comensales: 6, mesaId: mesa })
  })
})

describe('ítems', () => {
  it('cambiar o quitar solo antes de enviar', () => {
    const { pedido, estado } = abierto()
    const item = copiaItem()
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', item)], estado)

    expect(
      aplicarEvento(
        conItem,
        evento(pedido, 'ItemCambiado', {
          item_id: item.item_id,
          cantidad: 3,
          notas: 'Sin cebolla',
        }),
      ).estado?.items[item.item_id],
    ).toMatchObject({ cantidad: 3, notas: 'Sin cebolla' })
    expect(
      aplicarEvento(conItem, evento(pedido, 'ItemQuitado', { item_id: item.item_id })).estado
        ?.items[item.item_id],
    ).toBeUndefined()

    const enviado = aplicarTodos([enviar(pedido, [item.item_id])], conItem)
    const r = aplicarEvento(enviado, evento(pedido, 'ItemQuitado', { item_id: item.item_id }))
    expect(r.problema?.tipo).toBe('item_ya_enviado')
    expect(r.estado).toBe(enviado)
  })

  it('quitar o cambiar un ítem sin enviar en un pedido ya pagado no deja saldo negativo', () => {
    // Caso encontrado por la prueba de propiedades.
    const { pedido, estado } = abierto()
    const item = copiaItem({ precio_unitario: 10_000, cantidad: 2 })
    const pagado = aplicarTodos(
      [evento(pedido, 'ItemAgregado', item), evento(pedido, 'PagoRegistrado', pagoTarjeta(20_000))],
      estado,
    )

    expect(
      aplicarEvento(pagado, evento(pedido, 'ItemQuitado', { item_id: item.item_id })).problema
        ?.tipo,
    ).toBe('saldo_negativo')
    expect(
      aplicarEvento(pagado, evento(pedido, 'ItemCambiado', { item_id: item.item_id, cantidad: 1 }))
        .problema?.tipo,
    ).toBe('saldo_negativo')
    expect(
      aplicarEvento(pagado, evento(pedido, 'ItemCambiado', { item_id: item.item_id, cantidad: 3 }))
        .problema,
    ).toBeNull()
  })

  it('un ítem repetido no se agrega dos veces', () => {
    const { pedido, estado } = abierto()
    const item = copiaItem()
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', item)], estado)

    expect(aplicarEvento(conItem, evento(pedido, 'ItemAgregado', item)).problema?.tipo).toBe(
      'item_ya_existe',
    )
  })

  it('un curso retenido retiene sus ítems hasta marcharlo', () => {
    const { pedido, estado } = abierto()
    const postre = copiaItem({ nombre: 'Panna Cotta', curso: 'postre' })
    const otroPostre = copiaItem({ nombre: 'Pera Tentazione', curso: 'postre' })
    const retenido = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', postre),
        evento(pedido, 'CursoRetenido', { curso: 'postre' }),
        evento(pedido, 'ItemAgregado', otroPostre),
      ],
      estado,
    )

    expect(retenido.items[postre.item_id]?.estado).toBe('retenido')
    expect(retenido.items[otroPostre.item_id]?.estado).toBe('retenido')
    expect(aplicarEvento(retenido, enviar(pedido, [postre.item_id])).problema?.tipo).toBe(
      'estado_item_invalido',
    )

    const marchado = aplicarTodos([evento(pedido, 'CursoMarchado', { curso: 'postre' })], retenido)
    expect(marchado.items[postre.item_id]?.estado).toBe('pendiente')
    expect(marchado.cursosRetenidos).toEqual([])
  })

  it('preparación: enviado → en preparación → listo → entregado, y recuperar uno marcado por error', () => {
    const { pedido, estado } = abierto()
    const item = copiaItem()
    const listo = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', item),
        enviar(pedido, [item.item_id]),
        evento(pedido, 'ItemEnPreparacion', { item_ids: [item.item_id] }),
        evento(pedido, 'ItemListo', { item_ids: [item.item_id] }),
      ],
      estado,
    )
    expect(listo.items[item.item_id]?.estado).toBe('listo')
    expect(
      aplicarTodos([evento(pedido, 'ItemDevueltoACola', { item_ids: [item.item_id] })], listo)
        .items[item.item_id]?.estado,
    ).toBe('enviado')
    expect(
      aplicarEvento(listo, evento(pedido, 'ItemEnPreparacion', { item_ids: [item.item_id] }))
        .problema?.tipo,
    ).toBe('estado_item_invalido')
  })

  it('un cambio de estado de varios ítems se aplica a los que pueden y avisa de los demás', () => {
    const { pedido, estado } = abierto()
    const a = copiaItem()
    const b = copiaItem()
    const parcial = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', a),
        evento(pedido, 'ItemAgregado', b),
        enviar(pedido, [a.item_id]),
      ],
      estado,
    )

    const r = aplicarEvento(
      parcial,
      evento(pedido, 'ItemListo', { item_ids: [a.item_id, b.item_id] }),
    )
    // b no se ha enviado: a pasa a listo igual y se informa que b quedó fuera.
    expect(r.problema?.tipo).toBe('items_omitidos')
    expect(r.estado?.items[a.item_id]?.estado).toBe('listo')
    expect(r.estado?.items[b.item_id]?.estado).toBe('pendiente')
    expect(
      aplicarEvento(parcial, evento(pedido, 'ItemListo', { item_ids: [b.item_id] })).problema?.tipo,
    ).toBe('estado_item_invalido')
    expect(
      aplicarEvento(parcial, evento(pedido, 'ItemListo', { item_ids: [nuevoId()] })).problema?.tipo,
    ).toBe('item_inexistente')
  })

  it('modificar tras enviar cambia notas y extras; no aplica a ítems sin enviar', () => {
    const { pedido, estado } = abierto()
    const item = copiaItem()
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', item)], estado)
    const modificar = evento(pedido, 'ItemModificadoTrasEnvio', {
      item_id: item.item_id,
      comanda_id: nuevoId(),
      notas: 'Bien cocido',
      modificadores: [{ modificador_id: nuevoId(), nombre: 'Extra burrata', precio_extra: 8000 }],
    })

    expect(aplicarEvento(conItem, modificar).problema?.tipo).toBe('item_no_enviado')
    const modificado = aplicarTodos([enviar(pedido, [item.item_id]), deNuevo(modificar)], conItem)
    expect(modificado.items[item.item_id]?.notas).toBe('Bien cocido')
    expect(totalesPedido(modificado).neto).toBe(48_900)
  })
})

describe('anulaciones', () => {
  it('anulación parcial: 1 de 3 cervezas conserva la cantidad original para los informes', () => {
    const { pedido, estado } = abierto()
    const cervezas = copiaItem({ nombre: 'Heineken', precio_unitario: 14_900, cantidad: 3 })
    const anulada = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', cervezas),
        enviar(pedido, [cervezas.item_id]),
        evento(
          pedido,
          'ItemAnulado',
          { item_id: cervezas.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
          { motivo: 'Cliente cambió' },
        ),
      ],
      estado,
    )

    expect(anulada.items[cervezas.item_id]).toMatchObject({
      cantidad: 3,
      cantidadAnulada: 1,
      estado: 'enviado',
    })
    expect(totalesPedido(anulada)).toMatchObject({ bruto: 44_700, anulado: 14_900, neto: 29_800 })

    const todas = aplicarTodos(
      [
        evento(
          pedido,
          'ItemAnulado',
          { item_id: cervezas.item_id, cantidad: 2, ya_preparado: false, comanda_id: null },
          { motivo: 'm' },
        ),
      ],
      anulada,
    )
    expect(todas.items[cervezas.item_id]?.estado).toBe('anulado')
    expect(
      aplicarEvento(
        todas,
        evento(
          pedido,
          'ItemAnulado',
          { item_id: cervezas.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
          { motivo: 'm' },
        ),
      ).problema?.tipo,
    ).toBe('item_ya_anulado')
  })

  it('no se anulan más unidades de las que quedan ni ítems sin enviar', () => {
    const { pedido, estado } = abierto()
    const item = copiaItem({ cantidad: 2 })
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', item)], estado)
    const anular = (cantidad: number) =>
      evento(
        pedido,
        'ItemAnulado',
        { item_id: item.item_id, cantidad, ya_preparado: true, comanda_id: null },
        { motivo: 'm' },
      )

    expect(aplicarEvento(conItem, anular(1)).problema?.tipo).toBe('item_no_enviado')
    expect(
      aplicarEvento(aplicarTodos([enviar(pedido, [item.item_id])], conItem), anular(3)).problema
        ?.tipo,
    ).toBe('cantidad_invalida')
  })

  it('anular algo ya pagado exige primero reembolsar', () => {
    const { pedido, estado } = abierto()
    const item = copiaItem({ precio_unitario: 12_900 })
    const pago = pagoTarjeta(12_900)
    const pagado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', item),
        enviar(pedido, [item.item_id]),
        evento(pedido, 'PagoRegistrado', pago),
      ],
      estado,
    )
    const anular = evento(
      pedido,
      'ItemAnulado',
      { item_id: item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
      { motivo: 'm' },
    )

    expect(aplicarEvento(pagado, anular).problema?.tipo).toBe('saldo_negativo')

    const reembolsado = aplicarTodos(
      [
        evento(
          pedido,
          'ReembolsoRegistrado',
          {
            pago_id: pago.pago_id,
            reembolso_id: nuevoId(),
            monto_venta: 12_900,
            monto_propina: 0,
            medio: 'tarjeta',
            turno_caja_id: pago.turno_caja_id,
          },
          { motivo: 'Plato devuelto' },
        ),
      ],
      pagado,
    )
    expect(aplicarEvento(reembolsado, deNuevo(anular)).problema).toBeNull()
  })
})

describe('descuentos', () => {
  it('10 % al pedido repartido en pesos y retirado', () => {
    const { pedido, estado } = abierto()
    const pizza = copiaItem()
    const cerveza = copiaItem({ precio_unitario: 12_900 })
    const conItems = aplicarTodos(
      [evento(pedido, 'ItemAgregado', pizza), evento(pedido, 'ItemAgregado', cerveza)],
      estado,
    )
    const montos = repartirDescuentoPedido(porcentaje(53_800, 1000), [40_900, 12_900]) ?? []
    const descuento = nuevoId()
    const descontado = aplicarTodos(
      [
        evento(
          pedido,
          'DescuentoAplicado',
          {
            descuento_id: descuento,
            alcance: 'pedido',
            regla: 'porcentaje',
            valor: 1000,
            cantidad_unidades: null,
            montos: [
              { item_id: pizza.item_id, monto: montos[0] ?? 0 },
              { item_id: cerveza.item_id, monto: montos[1] ?? 0 },
            ],
          },
          { motivo: 'Cliente frecuente' },
        ),
      ],
      conItems,
    )

    expect(totalesPedido(descontado)).toMatchObject({
      bruto: 53_800,
      descuento: 5380,
      neto: 48_420,
    })
    expect(
      aplicarEvento(
        descontado,
        evento(pedido, 'ItemCambiado', { item_id: pizza.item_id, cantidad: 2 }),
      ).problema?.tipo,
    ).toBe('tiene_descuentos')
    expect(
      totalesPedido(
        aplicarTodos(
          [evento(pedido, 'DescuentoRetirado', { descuento_id: descuento }, { motivo: 'm' })],
          descontado,
        ),
      ).neto,
    ).toBe(53_800)
  })

  it('un descuento que deja una línea negativa se rechaza', () => {
    const { pedido, estado } = abierto()
    const item = copiaItem()
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', item)], estado)
    const descontar = (monto: number) =>
      evento(
        pedido,
        'DescuentoAplicado',
        {
          descuento_id: nuevoId(),
          alcance: 'item',
          regla: 'valor',
          valor: monto,
          cantidad_unidades: null,
          montos: [{ item_id: item.item_id, monto }],
        },
        { motivo: 'm' },
      )

    expect(aplicarEvento(conItem, descontar(50_000)).problema?.tipo).toBe('descuento_excede')
    expect(aplicarEvento(conItem, descontar(40_900)).problema).toBeNull()
  })
})

describe('división y pagos', () => {
  function dividido() {
    const { pedido, estado } = abierto()
    const item = copiaItem({ precio_unitario: 100_000 })
    const montos = partesIguales(100_000, 3)
    const cuentas = montos.map((monto, i) => ({
      cuenta_id: nuevoId(),
      nombre: `Parte ${i + 1}`,
      monto,
      propina_sugerida: 0,
      items: [],
    }))
    const final = aplicarTodos(
      [evento(pedido, 'ItemAgregado', item), evento(pedido, 'CuentaDividida', { cuentas })],
      estado,
    )
    return { pedido, estado: final, cuentas }
  }

  it('100.000 en 3: cada cuenta se paga por separado y lo agregado después queda sin asignar', () => {
    const { pedido, estado, cuentas } = dividido()
    const [primera] = cuentas
    const pagada = aplicarTodos(
      [
        evento(
          pedido,
          'PagoRegistrado',
          pagoTarjeta(33_334, { cuenta_id: primera?.cuenta_id ?? null }),
        ),
      ],
      estado,
    )

    expect(saldoCuenta(pagada, primera?.cuenta_id ?? null)).toBe(0)
    expect(
      aplicarEvento(
        pagada,
        evento(pedido, 'PagoRegistrado', pagoTarjeta(1, { cuenta_id: primera?.cuenta_id ?? null })),
      ).problema?.tipo,
    ).toBe('pago_excede_saldo')
    expect(aplicarEvento(pagada, evento(pedido, 'ItemAgregado', copiaItem())).problema).toBeNull()
    expect(
      aplicarEvento(pagada, evento(pedido, 'ItemQuitado', { item_id: nuevoId() })).problema?.tipo,
    ).toBe('item_inexistente')
    expect(aplicarEvento(pagada, evento(pedido, 'DivisionDeshecha', {})).problema?.tipo).toBe(
      'tiene_pagos',
    )
  })

  it('un pago sin cuenta en un pedido dividido solo cubre lo no asignado', () => {
    const { pedido, estado } = dividido()
    const conExtra = aplicarTodos(
      [evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 12_900 }))],
      estado,
    )

    expect(
      aplicarEvento(conExtra, evento(pedido, 'PagoRegistrado', pagoTarjeta(12_901))).problema?.tipo,
    ).toBe('pago_excede_saldo')
    expect(
      aplicarEvento(conExtra, evento(pedido, 'PagoRegistrado', pagoTarjeta(12_900))).problema,
    ).toBeNull()
  })

  it('no se divide dos veces ni por más que el saldo; deshacer sin pagos funciona', () => {
    const { pedido, estado, cuentas } = dividido()

    expect(
      aplicarEvento(estado, evento(pedido, 'CuentaDividida', { cuentas })).problema?.tipo,
    ).toBe('pedido_dividido')
    expect(aplicarEvento(estado, evento(pedido, 'DivisionDeshecha', {})).estado?.cuentas).toBeNull()

    const otro = abierto()
    const conItem = aplicarTodos(
      [evento(otro.pedido, 'ItemAgregado', copiaItem({ precio_unitario: 1000 }))],
      otro.estado,
    )
    expect(
      aplicarEvento(conItem, evento(otro.pedido, 'CuentaDividida', { cuentas })).problema?.tipo,
    ).toBe('division_no_cuadra')
    expect(aplicarEvento(conItem, evento(otro.pedido, 'DivisionDeshecha', {})).problema?.tipo).toBe(
      'pedido_no_dividido',
    )
  })

  it('una cuenta que no existe y un pago repetido', () => {
    const { pedido, estado } = abierto()
    const pago = pagoTarjeta(10_000)
    const conPago = aplicarTodos(
      [evento(pedido, 'ItemAgregado', copiaItem()), evento(pedido, 'PagoRegistrado', pago)],
      estado,
    )

    expect(aplicarEvento(conPago, evento(pedido, 'PagoRegistrado', pago)).problema?.tipo).toBe(
      'pago_ya_existe',
    )
    expect(
      aplicarEvento(
        conPago,
        evento(pedido, 'PagoRegistrado', pagoTarjeta(1, { cuenta_id: nuevoId() })),
      ).problema?.tipo,
    ).toBe('cuenta_inexistente')
  })

  it('el ajuste de redondeo solo va en el pago que deja el saldo en 0', () => {
    const { pedido, estado } = abierto()
    const conItem = aplicarTodos(
      [evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 36_810 }))],
      estado,
    )

    expect(
      aplicarEvento(
        conItem,
        evento(pedido, 'PagoRegistrado', pagoEfectivo(10_000, { ajuste_redondeo: -10 })),
      ).problema?.tipo,
    ).toBe('ajuste_invalido')
    const pagado = aplicarTodos(
      [
        evento(
          pedido,
          'PagoRegistrado',
          pagoEfectivo(36_810, { ajuste_redondeo: -10, cambio: 3200 }),
        ),
      ],
      conItem,
    )
    expect(totalesPedido(pagado)).toMatchObject({ saldo: 0, ajustes: -10 })
  })

  it('anular un pago devuelve el saldo; anularlo dos veces no', () => {
    const { pedido, estado } = abierto()
    const pago = pagoTarjeta(40_900)
    const pagado = aplicarTodos(
      [evento(pedido, 'ItemAgregado', copiaItem()), evento(pedido, 'PagoRegistrado', pago)],
      estado,
    )
    const anular = evento(
      pedido,
      'PagoAnulado',
      { pago_id: pago.pago_id, turno_caja_id: pago.turno_caja_id },
      { motivo: 'Datáfono rechazó' },
    )
    const anulado = aplicarTodos([anular], pagado)

    expect(totalesPedido(anulado).saldo).toBe(40_900)
    // El mismo evento otra vez se ignora; otra anulación del mismo pago se rechaza.
    expect(aplicarEvento(anulado, anular).problema?.tipo).toBe('evento_ya_aplicado')
    expect(aplicarEvento(anulado, deNuevo(anular)).problema?.tipo).toBe('pago_ya_anulado')
    expect(
      aplicarEvento(
        pagado,
        evento(
          pedido,
          'PagoAnulado',
          { pago_id: nuevoId(), turno_caja_id: pago.turno_caja_id },
          { motivo: 'm' },
        ),
      ).problema?.tipo,
    ).toBe('pago_inexistente')
  })

  it('el reembolso no pasa de lo pagado, ni de lo cobrado en efectivo con ajuste', () => {
    const { pedido, estado } = abierto()
    const pago = pagoEfectivo(36_850, { ajuste_redondeo: -50 })
    const pagado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 36_850 })),
        evento(pedido, 'PagoRegistrado', pago),
      ],
      estado,
    )
    const reembolsar = (venta: number, propina = 0) =>
      evento(
        pedido,
        'ReembolsoRegistrado',
        {
          pago_id: pago.pago_id,
          reembolso_id: nuevoId(),
          monto_venta: venta,
          monto_propina: propina,
          medio: 'efectivo',
          turno_caja_id: pago.turno_caja_id,
        },
        { motivo: 'm' },
      )

    expect(aplicarEvento(pagado, reembolsar(36_850)).problema?.tipo).toBe('reembolso_excede')
    // Devolver toda la venta cobrada (36.800) deja el ajuste suelto: se pide anular el pago.
    expect(aplicarEvento(pagado, reembolsar(36_800)).problema?.tipo).toBe('usar_anulacion')
    expect(aplicarEvento(pagado, reembolsar(36_799)).problema).toBeNull()
    expect(aplicarEvento(pagado, reembolsar(1, 1)).problema?.tipo).toBe('reembolso_excede')
  })
})

describe('mover y unir', () => {
  it('ItemsMovidos quita del origen y agrega al destino conservando quién lo agregó', () => {
    const origen = abierto()
    const destino = abierto()
    const item = copiaItem()
    const conItem = aplicarTodos([evento(origen.pedido, 'ItemAgregado', item)], origen.estado)
    const movido = conItem.items[item.item_id]
    const mover = evento(
      origen.pedido,
      'ItemsMovidos',
      {
        pedido_destino_id: destino.pedido,
        items: [
          {
            item,
            estado: 'pendiente',
            cantidad_anulada: 0,
            agregado_por: movido?.agregadoPor ?? MESERO,
          },
        ],
      },
      { relacionados: [destino.pedido] },
    )

    expect(aplicarTodos([mover], conItem).items[item.item_id]).toBeUndefined()
    expect(aplicarTodos([mover], destino.estado).items[item.item_id]).toMatchObject({
      agregadoPor: MESERO,
      estado: 'pendiente',
    })
    expect(aplicarEvento(abierto().estado, mover).problema?.tipo).toBe('evento_ajeno')
  })

  it('PedidosUnidos cancela el origen y pasa sus ítems al destino', () => {
    const origen = abierto()
    const destino = abierto()
    const item = copiaItem()
    const conItem = aplicarTodos([evento(origen.pedido, 'ItemAgregado', item)], origen.estado)
    const unir = evento(
      destino.pedido,
      'PedidosUnidos',
      {
        pedido_origen_id: origen.pedido,
        items: [{ item, estado: 'pendiente', cantidad_anulada: 0, agregado_por: MESERO }],
      },
      { relacionados: [origen.pedido] },
    )

    expect(aplicarTodos([unir], conItem)).toMatchObject({
      estado: 'cancelado',
      unidoA: destino.pedido,
      items: {},
    })
    expect(Object.keys(aplicarTodos([unir], destino.estado).items)).toEqual([item.item_id])
  })

  it('no une un pedido que ya tiene pagos', () => {
    const origen = abierto()
    const conPago = aplicarTodos(
      [
        evento(origen.pedido, 'ItemAgregado', copiaItem()),
        evento(origen.pedido, 'PagoRegistrado', pagoTarjeta(1000)),
      ],
      origen.estado,
    )
    const unir = evento(
      nuevoId(),
      'PedidosUnidos',
      { pedido_origen_id: origen.pedido, items: [] },
      { relacionados: [origen.pedido] },
    )

    expect(aplicarEvento(conPago, unir).problema?.tipo).toBe('tiene_pagos')
  })
})

describe('garantías del reductor', () => {
  it('nunca lanza: un evento malformado se informa como problema', () => {
    const { pedido, estado } = abierto()
    const roto = {
      ...evento(pedido, 'ItemListo', { item_ids: [nuevoId()] }),
      datos: null,
    } as unknown as EventoPedido

    expect(aplicarEvento(estado, roto).problema?.tipo).toBe('evento_invalido')
  })

  it('reconstruir aplica en orden de secuencia aunque lleguen desordenados', () => {
    const { pedido } = abierto()
    const abrir = evento(
      pedido,
      'PedidoAbierto',
      { canal: 'barra', mesa_id: null, comensales: 1 },
      { secuencia: 1 },
    )
    const item = copiaItem()
    const agregar = evento(pedido, 'ItemAgregado', item, { secuencia: 2 })
    const enviarlo = { ...enviar(pedido, [item.item_id]), secuencia: 3 }

    const estado = reconstruir([enviarlo, agregar, abrir], pedido)
    expect(estado?.items[item.item_id]?.estado).toBe('enviado')
    expect(estado?.ultimaSecuencia).toBe(3)
  })

  it('propiedad: con cualquier secuencia de eventos no lanza, es determinista y el saldo nunca es negativo', () => {
    const pedido = nuevoId()
    const items = Array.from({ length: 4 }, (_, i) =>
      copiaItem({ precio_unitario: 10_000 + i * 2900, cantidad: 1 + i }),
    )
    const fabricar = (accion: number, i: number, monto: number): EventoPedido => {
      const item = items[i % items.length] ?? items[0]
      const id = item?.item_id ?? nuevoId()
      switch (accion % 9) {
        case 0:
          return evento(pedido, 'ItemAgregado', item ?? copiaItem())
        case 1:
          return enviar(pedido, [id])
        case 2:
          return evento(pedido, 'ItemListo', { item_ids: [id] })
        case 3:
          return evento(
            pedido,
            'ItemAnulado',
            { item_id: id, cantidad: 1, ya_preparado: false, comanda_id: null },
            { motivo: 'm' },
          )
        case 4:
          return evento(
            pedido,
            'DescuentoAplicado',
            {
              descuento_id: nuevoId(),
              alcance: 'item',
              regla: 'valor',
              valor: monto,
              cantidad_unidades: null,
              montos: [{ item_id: id, monto }],
            },
            { motivo: 'm' },
          )
        case 5:
          return evento(pedido, 'PagoRegistrado', pagoTarjeta(Math.max(1, monto)))
        case 6:
          return evento(pedido, 'ItemQuitado', { item_id: id })
        case 7:
          return evento(pedido, 'PedidoCerrado', {})
        default:
          return evento(pedido, 'PedidoReabierto', {}, { motivo: 'm' })
      }
    }
    const abrir = evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 2 })

    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.integer({ min: 0, max: 60_000 })), {
          maxLength: 30,
        }),
        (acciones) => {
          const eventos = [abrir, ...acciones.map(([a, i, m]) => fabricar(a, i, m))]
          const plegar = () =>
            eventos.reduce<EstadoPedido | null>(
              (estado, e) => aplicarEvento(estado, e).estado,
              null,
            )
          const estado = plegar()

          expect(estado).toEqual(plegar())
          if (!estado) return
          const t = totalesPedido(estado)
          expect(t.saldo).toBeGreaterThanOrEqual(0)
          expect(t.bruto - t.anulado - t.descuento).toBe(t.neto)
          for (const item of Object.values(estado.items)) {
            expect(item.cantidadAnulada).toBeLessThanOrEqual(item.cantidad)
          }
        },
      ),
      { numRuns: 2000 },
    )
  })
})
