import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { type EstadoMesaDemo, estadoMesa, pedidosAbiertos } from './proyeccion'
import { apertura, datosItem, enOrden, local } from './pruebas'

// El estado de la mesa en el plano con la cocina (ADR-015): tomando > listo > en cocina > servida.

const idDe = (l: ReturnType<typeof local>) => (l.evento.datos as { item_id: string }).item_id

/** Una mesa con un solo pedido: cada plato con el estado que se indique. */
function mesa(
  platos: (
    | 'pendiente'
    | 'retenido'
    | 'enviado'
    | 'preparando'
    | 'listo'
    | 'entregado'
    | 'anulado'
  )[],
  extra: ReturnType<typeof local>[] = [],
) {
  const p = nuevoId()
  const eventos: ReturnType<typeof local>[] = [local('PedidoAbierto', p, apertura)]
  if (platos.includes('retenido')) eventos.push(local('CursoRetenido', p, { curso: 'postre' }))
  const items = platos.map((estado) => ({
    estado,
    ev: local('ItemAgregado', p, datosItem({ curso: estado === 'retenido' ? 'postre' : null })),
  }))
  eventos.push(...items.map((i) => i.ev))
  const ids = (e: string) => items.filter((i) => i.estado === e).map((i) => idDe(i.ev))
  const enviados = items.filter((i) => !['pendiente', 'retenido'].includes(i.estado))
  if (enviados.length)
    eventos.push(
      local('ItemsEnviados', p, {
        comandas: [
          {
            comanda_id: nuevoId(),
            estacion_id: nuevoId(),
            item_ids: enviados.map((i) => idDe(i.ev)),
          },
        ],
      }),
    )
  if (ids('preparando').length)
    eventos.push(local('ItemEnPreparacion', p, { item_ids: ids('preparando') }))
  if (ids('listo').length) eventos.push(local('ItemListo', p, { item_ids: ids('listo') }))
  if (ids('entregado').length)
    eventos.push(local('ItemEntregado', p, { item_ids: ids('entregado') }))
  if (ids('anulado').length)
    for (const id of ids('anulado'))
      eventos.push(
        local(
          'ItemAnulado',
          p,
          { item_id: id, cantidad: 1, ya_preparado: false, comanda_id: null },
          'confirmado',
          {
            motivo: 'x',
          },
        ),
      )
  return pedidosAbiertos(enOrden([...eventos, ...extra]))
}

describe('estadoMesa con la cocina', () => {
  it.each<[string[], EstadoMesaDemo]>([
    [[], 'libre'],
    [['enviado'], 'en_cocina'],
    [['preparando'], 'en_cocina'],
    [['listo'], 'listo'],
    [['entregado'], 'servida'],
    [['anulado'], 'libre'],
    [['pendiente'], 'tomando'],
    [['retenido'], 'tomando'],
  ])('con %j la mesa está «%s»', (platos, esperado) => {
    expect(estadoMesa(mesa(platos as never))).toBe(esperado)
  })

  it.each<[string[], EstadoMesaDemo]>([
    // tomando manda sobre todo
    [['pendiente', 'listo'], 'tomando'],
    [['pendiente', 'enviado'], 'tomando'],
    [['pendiente', 'entregado'], 'tomando'],
    [['retenido', 'listo', 'entregado'], 'tomando'],
    // listo manda sobre en cocina y servida
    [['listo', 'enviado'], 'listo'],
    [['listo', 'preparando'], 'listo'],
    [['listo', 'entregado'], 'listo'],
    [['listo', 'enviado', 'entregado'], 'listo'],
    // en cocina manda sobre servida
    [['enviado', 'entregado'], 'en_cocina'],
    [['preparando', 'entregado'], 'en_cocina'],
    // lo anulado no cuenta
    [['anulado', 'entregado'], 'servida'],
    [['anulado', 'listo'], 'listo'],
    [['anulado', 'pendiente'], 'tomando'],
    // todo entregado
    [['entregado', 'entregado'], 'servida'],
  ])('con %j la mesa está «%s»', (platos, esperado) => {
    expect(estadoMesa(mesa(platos as never))).toBe(esperado)
  })

  it('devolver un plato entregado a la cola lo regresa a «en cocina»', () => {
    const p = nuevoId()
    const a = local('ItemAgregado', p, datosItem())
    const pedidos = pedidosAbiertos(
      enOrden([
        local('PedidoAbierto', p, apertura),
        a,
        local('ItemsEnviados', p, {
          comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [idDe(a)] }],
        }),
        local('ItemEntregado', p, { item_ids: [idDe(a)] }),
      ]),
    )
    expect(estadoMesa(pedidos)).toBe('servida')
    const otra = pedidosAbiertos(
      enOrden([
        local('PedidoAbierto', p, apertura),
        a,
        local('ItemsEnviados', p, {
          comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [idDe(a)] }],
        }),
        local('ItemEntregado', p, { item_ids: [idDe(a)] }),
        local('ItemDevueltoACola', p, { item_ids: [idDe(a)] }),
      ]),
    )
    expect(estadoMesa(otra)).toBe('en_cocina')
  })

  it('con varios pedidos en la misma mesa gana el más urgente', () => {
    const [a, b, c] = [nuevoId(), nuevoId(), nuevoId()]
    const itemA = local('ItemAgregado', a, datosItem())
    const itemB = local('ItemAgregado', b, datosItem())
    const itemC = local('ItemAgregado', c, datosItem())
    const envio = (p: string, it: typeof itemA) =>
      local('ItemsEnviados', p, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [idDe(it)] }],
      })
    const todos = pedidosAbiertos(
      enOrden([
        local('PedidoAbierto', a, apertura),
        itemA,
        envio(a, itemA),
        local('ItemEntregado', a, { item_ids: [idDe(itemA)] }),
        local('PedidoAbierto', b, apertura),
        itemB,
        envio(b, itemB),
        local('PedidoAbierto', c, apertura),
        itemC,
        envio(c, itemC),
        local('ItemListo', c, { item_ids: [idDe(itemC)] }),
      ]),
    )
    const de = (...ids: string[]) => todos.filter((x) => ids.includes(x.estado.id))
    expect(estadoMesa(de(a))).toBe('servida')
    expect(estadoMesa(de(a, b))).toBe('en_cocina')
    expect(estadoMesa(de(a, b, c))).toBe('listo')
    expect(estadoMesa(de(a, c))).toBe('listo')
  })

  it('un plato listo marcado en un evento pendiente (sin confirmar) ya cuenta en el plano', () => {
    const p = nuevoId()
    const a = local('ItemAgregado', p, datosItem())
    const pedidos = pedidosAbiertos(
      enOrden([
        local('PedidoAbierto', p, apertura),
        a,
        local('ItemsEnviados', p, {
          comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [idDe(a)] }],
        }),
        local('ItemListo', p, { item_ids: [idDe(a)] }, 'pendiente'),
      ]),
    )
    expect(estadoMesa(pedidos)).toBe('listo')
  })
})
