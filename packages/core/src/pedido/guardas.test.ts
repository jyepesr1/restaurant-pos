import { describe, expect, it } from 'vitest'
import type { EventoPedido } from '../eventos/pedido'
import { nuevoId } from '../id'
import { copiaItem, deNuevo, enOrden, evento, MESERO, pagoTarjeta, TURNO } from '../pruebas/fabrica'
import { aplicarEvento, reconstruir } from './aplicar'
import type { EstadoPedido } from './estado'

// Cada regla que impide aplicar un evento, probada una por una (docs/MODELO_DATOS.md#reglas-de-aplicación).

function aplicarTodos(eventos: EventoPedido[], inicial: EstadoPedido | null = null): EstadoPedido {
  return eventos.reduce<EstadoPedido | null>((estado, e) => {
    const r = aplicarEvento(estado, enOrden(e, estado?.ultimaSecuencia ?? 0))
    if (r.problema) throw new Error(`${e.tipo}: ${r.problema.tipo}`)
    return r.estado
  }, inicial) as EstadoPedido
}

const enviar = (pedido: string, ids: string[]) =>
  evento(pedido, 'ItemsEnviados', {
    comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: ids }],
  })

const movido = (item: ReturnType<typeof copiaItem>) => ({
  item,
  estado: 'enviado' as const,
  cantidad_anulada: 0,
  agregado_por: MESERO,
})

/** Pedido con un ítem enviado de $40.900. */
function base() {
  const pedido = nuevoId()
  const item = copiaItem()
  const estado = aplicarTodos([
    evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 2 }),
    evento(pedido, 'ItemAgregado', item),
    enviar(pedido, [item.item_id]),
  ])
  return { pedido, item, estado }
}

const descontar = (pedido: string, itemId: string, monto: number, descuento = nuevoId()) =>
  evento(
    pedido,
    'DescuentoAplicado',
    {
      descuento_id: descuento,
      alcance: 'item',
      regla: 'valor',
      valor: monto,
      cantidad_unidades: null,
      montos: [{ item_id: itemId, monto }],
    },
    { motivo: 'm' },
  )

const problema = (estado: EstadoPedido | null, e: EventoPedido) =>
  aplicarEvento(estado, e).problema?.tipo

describe('con el pedido dividido no se cambian sus montos', () => {
  const { pedido, item, estado } = base()
  const pendiente = copiaItem()
  const conPendiente = aplicarTodos([evento(pedido, 'ItemAgregado', pendiente)], estado)
  const cuentas = [20_450, 20_450].map((monto, i) => ({
    cuenta_id: nuevoId(),
    nombre: `P${i}`,
    monto,
    propina_sugerida: 0,
    items: [],
  }))
  const dividido = aplicarTodos([evento(pedido, 'CuentaDividida', { cuentas })], conPendiente)
  const anular = evento(
    pedido,
    'ItemAnulado',
    { item_id: item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
    { motivo: 'm' },
  )

  it.each<[string, EventoPedido]>([
    [
      'cambiar un ítem',
      evento(pedido, 'ItemCambiado', { item_id: pendiente.item_id, cantidad: 2 }),
    ],
    ['anular', anular],
    [
      'mover',
      evento(pedido, 'ItemsMovidos', { pedido_destino_id: nuevoId(), items: [movido(item)] }),
    ],
    ['descontar', descontar(pedido, item.item_id, 1000)],
    [
      'agregar extras con precio',
      evento(pedido, 'ItemModificadoTrasEnvio', {
        item_id: item.item_id,
        comanda_id: nuevoId(),
        modificadores: [{ modificador_id: nuevoId(), nombre: 'Extra', precio_extra: 3000 }],
      }),
    ],
    [
      'recibir un pedido unido',
      evento(pedido, 'PedidosUnidos', { pedido_origen_id: nuevoId(), items: [] }),
    ],
  ])('%s', (_caso, e) => {
    expect(problema(dividido, e)).toBe('pedido_dividido')
  })

  it('unirse a otro', () => {
    const unir = evento(nuevoId(), 'PedidosUnidos', { pedido_origen_id: pedido, items: [] })
    expect(problema(dividido, unir)).toBe('pedido_dividido')
  })

  it('retirar un descuento', () => {
    const descuento = nuevoId()
    const descontado = aplicarTodos(
      [descontar(pedido, item.item_id, 1000, descuento)],
      conPendiente,
    )
    const divididoConDescuento = aplicarTodos(
      [
        evento(pedido, 'CuentaDividida', {
          cuentas: cuentas.map((c) => ({ ...c, monto: 19_950 })),
        }),
      ],
      descontado,
    )
    expect(
      problema(
        divididoConDescuento,
        evento(pedido, 'DescuentoRetirado', { descuento_id: descuento }, { motivo: 'm' }),
      ),
    ).toBe('pedido_dividido')
  })
})

describe('con descuento en la línea', () => {
  const { pedido, item, estado } = base()
  const descontado = aplicarTodos([descontar(pedido, item.item_id, 5000)], estado)

  it('no se anula, no se mueve ni cambia su precio', () => {
    expect(
      problema(
        descontado,
        evento(
          pedido,
          'ItemAnulado',
          { item_id: item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
          { motivo: 'm' },
        ),
      ),
    ).toBe('tiene_descuentos')
    expect(
      problema(
        descontado,
        evento(pedido, 'ItemsMovidos', { pedido_destino_id: nuevoId(), items: [movido(item)] }),
      ),
    ).toBe('tiene_descuentos')
    expect(
      problema(
        descontado,
        evento(pedido, 'ItemModificadoTrasEnvio', {
          item_id: item.item_id,
          comanda_id: nuevoId(),
          modificadores: [{ modificador_id: nuevoId(), nombre: 'Extra', precio_extra: 3000 }],
        }),
      ),
    ).toBe('tiene_descuentos')
  })

  it('cambiar solo las notas sí se puede', () => {
    expect(
      problema(
        descontado,
        evento(pedido, 'ItemModificadoTrasEnvio', {
          item_id: item.item_id,
          comanda_id: nuevoId(),
          notas: 'Sin albahaca',
        }),
      ),
    ).toBeUndefined()
  })

  it('un descuento repetido o retirar uno inexistente', () => {
    const descuento = nuevoId()
    const conDescuento = aplicarTodos([descontar(pedido, item.item_id, 1000, descuento)], estado)
    expect(problema(conDescuento, descontar(pedido, item.item_id, 1000, descuento))).toBe(
      'descuento_ya_existe',
    )
    expect(
      problema(
        estado,
        evento(pedido, 'DescuentoRetirado', { descuento_id: nuevoId() }, { motivo: 'm' }),
      ),
    ).toBe('descuento_inexistente')
  })

  it('descontar un ítem inexistente o un pedido ya pagado', () => {
    expect(problema(estado, descontar(pedido, nuevoId(), 1000))).toBe('item_inexistente')
    const pagado = aplicarTodos([evento(pedido, 'PagoRegistrado', pagoTarjeta(40_900))], estado)
    expect(problema(pagado, descontar(pedido, item.item_id, 1000))).toBe('saldo_negativo')
  })
})

describe('mover y unir: casos inválidos', () => {
  it('mover un ítem inexistente, repetirlo en el destino o algo ya pagado', () => {
    const { pedido, item, estado } = base()
    const destino = nuevoId()
    const mover = evento(pedido, 'ItemsMovidos', {
      pedido_destino_id: destino,
      items: [movido(item)],
    })
    expect(
      problema(
        estado,
        evento(pedido, 'ItemsMovidos', {
          pedido_destino_id: destino,
          items: [movido(copiaItem())],
        }),
      ),
    ).toBe('item_inexistente')

    const estadoDestino = aplicarTodos([
      evento(destino, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 0 }),
      mover,
    ])
    expect(problema(estadoDestino, deNuevo(mover))).toBe('item_ya_existe')

    const pagado = aplicarTodos([evento(pedido, 'PagoRegistrado', pagoTarjeta(40_900))], estado)
    expect(problema(pagado, deNuevo(mover))).toBe('saldo_negativo')
  })

  it('unir: el pedido debe ser origen o destino y no repetir ítems', () => {
    const { pedido, item, estado } = base()
    expect(
      problema(
        estado,
        evento(nuevoId(), 'PedidosUnidos', { pedido_origen_id: nuevoId(), items: [] }),
      ),
    ).toBe('evento_ajeno')
    expect(
      problema(
        estado,
        evento(pedido, 'PedidosUnidos', { pedido_origen_id: nuevoId(), items: [movido(item)] }),
      ),
    ).toBe('item_ya_existe')
  })
})

describe('otros casos', () => {
  it('modificar tras enviar: ítem inexistente, anulado o que dejaría saldo negativo', () => {
    const { pedido, item, estado } = base()
    const conExtra = copiaItem()
    const conExtras = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', {
          ...conExtra,
          modificadores: [{ modificador_id: nuevoId(), nombre: 'Extra', precio_extra: 3000 }],
        }),
        enviar(pedido, [conExtra.item_id]),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(84_800)),
      ],
      estado,
    )
    const quitarExtras = evento(pedido, 'ItemModificadoTrasEnvio', {
      item_id: conExtra.item_id,
      comanda_id: nuevoId(),
      modificadores: [],
    })
    expect(problema(conExtras, quitarExtras)).toBe('saldo_negativo')
    expect(
      problema(
        estado,
        evento(pedido, 'ItemModificadoTrasEnvio', {
          item_id: nuevoId(),
          comanda_id: nuevoId(),
          notas: 'x',
        }),
      ),
    ).toBe('item_inexistente')

    const anulado = aplicarTodos(
      [
        evento(
          pedido,
          'ItemAnulado',
          { item_id: item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
          { motivo: 'm' },
        ),
      ],
      estado,
    )
    expect(
      problema(
        anulado,
        evento(pedido, 'ItemModificadoTrasEnvio', {
          item_id: item.item_id,
          comanda_id: nuevoId(),
          notas: 'x',
        }),
      ),
    ).toBe('item_ya_anulado')
  })

  it('cambiar comensal y curso de un ítem sin enviar', () => {
    const { pedido, estado } = base()
    const item = copiaItem()
    const cambiado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', item),
        evento(pedido, 'ItemCambiado', { item_id: item.item_id, comensal: 2, curso: 'fuerte' }),
      ],
      estado,
    )
    expect(cambiado.items[item.item_id]).toMatchObject({ comensal: 2, curso: 'fuerte' })
    expect(
      problema(estado, evento(pedido, 'ItemCambiado', { item_id: nuevoId(), cantidad: 2 })),
    ).toBe('item_inexistente')
  })

  it('retener un curso no toca los ítems de otros cursos', () => {
    const { pedido, item, estado } = base()
    const retenido = aplicarTodos([evento(pedido, 'CursoRetenido', { curso: 'postre' })], estado)
    expect(retenido.items[item.item_id]?.estado).toBe('enviado')
  })

  it('reimprimir una comanda no cambia nada del pedido', () => {
    const { pedido, estado } = base()
    const reimpreso = aplicarTodos(
      [evento(pedido, 'ComandaReimpresa', { comanda_id: nuevoId() })],
      estado,
    )
    expect({ ...reimpreso, ultimaSecuencia: 0 }).toEqual({ ...estado, ultimaSecuencia: 0 })
  })

  it('un pedido de rescate nace abierto y ligado al original', () => {
    const original = nuevoId()
    const rescate = nuevoId()
    const estado = aplicarTodos([
      evento(rescate, 'PedidoRescateCreado', {
        pedido_original_id: original,
        canal: 'salon',
        mesa_id: null,
        mesero_id: MESERO,
      }),
    ])
    expect(estado).toMatchObject({
      id: rescate,
      estado: 'abierto',
      rescateDe: original,
      comensales: 0,
    })
  })

  it('reembolsar un pago inexistente o anulado', () => {
    const { pedido, estado } = base()
    const pago = pagoTarjeta(10_000)
    const anulado = aplicarTodos(
      [
        evento(pedido, 'PagoRegistrado', pago),
        evento(
          pedido,
          'PagoAnulado',
          { pago_id: pago.pago_id, turno_caja_id: TURNO },
          { motivo: 'm' },
        ),
      ],
      estado,
    )
    const reembolsar = (pagoId: string) =>
      evento(
        pedido,
        'ReembolsoRegistrado',
        {
          pago_id: pagoId,
          reembolso_id: nuevoId(),
          monto_venta: 1,
          monto_propina: 0,
          medio: 'tarjeta',
          turno_caja_id: TURNO,
        },
        { motivo: 'm' },
      )
    expect(problema(anulado, reembolsar(nuevoId()))).toBe('pago_inexistente')
    expect(problema(anulado, reembolsar(pago.pago_id))).toBe('pago_ya_anulado')
  })

  it('reconstruir ignora los eventos de otros pedidos, aunque lleguen primero', () => {
    const { pedido } = base()
    const otro = nuevoId()
    const deOtro = evento(
      otro,
      'PedidoAbierto',
      { canal: 'barra', mesa_id: null, comensales: 1 },
      { secuencia: 1 },
    )
    const propio = evento(
      pedido,
      'PedidoAbierto',
      { canal: 'salon', mesa_id: null, comensales: 2 },
      { secuencia: 2 },
    )

    expect(reconstruir([deOtro, propio], pedido)?.id).toBe(pedido)
    expect(reconstruir([deOtro], pedido)).toBeNull()
  })
})
