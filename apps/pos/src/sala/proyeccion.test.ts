import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  estadoMesa,
  itemsVigentes,
  type PedidoVisible,
  pedidosAbiertos as proyectar,
} from './proyeccion'
import { apertura, datosItem, enOrden, local } from './pruebas'

const pedidosAbiertos = (locales: Parameters<typeof enOrden>[0]) => proyectar(enOrden(locales))

const itemId = (l: ReturnType<typeof local>) => (l.evento.datos as { item_id: string }).item_id

describe('pedidosAbiertos', () => {
  it('sin eventos no hay pedidos', () => {
    expect(pedidosAbiertos([])).toEqual([])
  })

  it('arma el pedido con sus ítems y el neto', () => {
    const p = nuevoId()
    const r = pedidosAbiertos([
      local('PedidoAbierto', p, apertura),
      local('ItemAgregado', p, datosItem({ precio_unitario: 10_000 })),
      local('ItemAgregado', p, datosItem({ precio_unitario: 5_000, cantidad: 2 })),
    ])
    expect(r).toHaveLength(1)
    expect(r[0]?.estado.id).toBe(p)
    expect(Object.keys(r[0]?.estado.items ?? {})).toHaveLength(2)
    expect(r[0]?.total).toBe(20_000)
    expect(r[0]?.porConfirmar).toBe(false)
    expect(r[0]?.itemsPorConfirmar.size).toBe(0)
  })

  it('marca como por confirmar solo los ítems pendientes de confirmar', () => {
    const p = nuevoId()
    const ya = local('ItemAgregado', p, datosItem())
    const falta = local('ItemAgregado', p, datosItem(), 'pendiente')
    const [v] = pedidosAbiertos([local('PedidoAbierto', p, apertura), ya, falta])
    expect(v?.porConfirmar).toBe(true)
    expect([...(v?.itemsPorConfirmar ?? [])]).toEqual([itemId(falta)])
  })

  it('un ItemsEnviados pendiente marca como por confirmar los ítems de sus comandas', () => {
    const p = nuevoId()
    const [uno, dos, tres] = [1, 2, 3].map(() => local('ItemAgregado', p, datosItem()))
    const ids = [uno, dos, tres].map((l) => itemId(l as never))
    const [v] = pedidosAbiertos([
      local('PedidoAbierto', p, apertura),
      uno as never,
      dos as never,
      tres as never,
      local(
        'ItemsEnviados',
        p,
        {
          comandas: [
            { comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [ids[0] as string] },
            { comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [ids[2] as string] },
          ],
        },
        'pendiente',
      ),
    ])
    expect([...(v?.itemsPorConfirmar ?? [])].sort()).toEqual([ids[0], ids[2]].sort())
    expect(v?.estado.items[ids[0] as string]?.estado).toBe('enviado')
    expect(v?.estado.items[ids[1] as string]?.estado).toBe('pendiente')
  })

  it('un ItemsEnviados ya confirmado no marca nada', () => {
    const p = nuevoId()
    const item = local('ItemAgregado', p, datosItem())
    const [v] = pedidosAbiertos([
      local('PedidoAbierto', p, apertura),
      item,
      local('ItemsEnviados', p, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [itemId(item)] }],
      }),
    ])
    expect(v?.itemsPorConfirmar.size).toBe(0)
    expect(v?.porConfirmar).toBe(false)
  })

  it('un evento pendiente que no es ItemAgregado marca el pedido pero no los ítems', () => {
    const p = nuevoId()
    const item = local('ItemAgregado', p, datosItem())
    const [v] = pedidosAbiertos([
      local('PedidoAbierto', p, apertura),
      item,
      local('ItemCambiado', p, { item_id: itemId(item), notas: 'sin hielo' }, 'pendiente'),
    ])
    expect(v?.porConfirmar).toBe(true)
    expect(v?.itemsPorConfirmar.size).toBe(0)
    expect(v?.estado.items[itemId(item)]?.notas).toBe('sin hielo')
  })

  it('un pedido abierto solo con eventos pendientes (sin conexión) ya se ve', () => {
    const p = nuevoId()
    const [v] = pedidosAbiertos([
      local('PedidoAbierto', p, apertura, 'pendiente'),
      local('ItemAgregado', p, datosItem({ precio_unitario: 32_000 }), 'pendiente'),
    ])
    expect(v?.total).toBe(32_000)
    expect(v?.porConfirmar).toBe(true)
  })

  it('ignora los eventos rechazados y los que están en cuarentena', () => {
    const p = nuevoId()
    const malo = local('ItemAgregado', p, datosItem({ precio_unitario: 99_000 }), 'rechazado')
    const raro = local('ItemAgregado', p, datosItem({ precio_unitario: 88_000 }), 'cuarentena')
    const [v] = pedidosAbiertos([
      local('PedidoAbierto', p, apertura),
      local('ItemAgregado', p, datosItem({ precio_unitario: 1_000 })),
      malo,
      raro,
    ])
    expect(v?.total).toBe(1_000)
    expect(v?.estado.items[itemId(malo)]).toBeUndefined()
    expect(v?.estado.items[itemId(raro)]).toBeUndefined()
  })

  it('un pedido cuya apertura fue rechazada no aparece', () => {
    const p = nuevoId()
    expect(
      pedidosAbiertos([
        local('PedidoAbierto', p, apertura, 'rechazado'),
        local('ItemAgregado', p, datosItem(), 'pendiente'),
      ]),
    ).toEqual([])
  })

  it('no muestra pedidos cerrados ni cancelados', () => {
    const cerrado = nuevoId()
    const cancelado = nuevoId()
    const abierto = nuevoId()
    const r = pedidosAbiertos([
      local('PedidoAbierto', cerrado, apertura),
      local('PedidoCerrado', cerrado, {}),
      local('PedidoAbierto', cancelado, apertura),
      local('PedidoCancelado', cancelado, {}, 'confirmado', { motivo: 'error' }),
      local('PedidoAbierto', abierto, apertura),
    ])
    expect(r.map((v) => v.estado.id)).toEqual([abierto])
  })

  it('un cierre rechazado deja el pedido abierto', () => {
    const p = nuevoId()
    const r = pedidosAbiertos([
      local('PedidoAbierto', p, apertura),
      local('PedidoCerrado', p, {}, 'rechazado'),
    ])
    expect(r).toHaveLength(1)
  })

  it('ordena del más antiguo al más nuevo por hora de apertura', () => {
    const [a, b, c] = [nuevoId(), nuevoId(), nuevoId()]
    // La hora de apertura es la que puso el hub al recibirlo (`recibido_en`).
    const abrir = (id: string, hora: string) => {
      const l = local('PedidoAbierto', id, apertura)
      return { ...l, evento: { ...l.evento, recibido_en: hora } }
    }
    const r = pedidosAbiertos([
      abrir(b, '2026-10-24T15:10:00.000Z'),
      abrir(c, '2026-10-24T15:20:00.000Z'),
      abrir(a, '2026-10-24T15:00:00.000Z'),
    ])
    expect(r.map((v) => v.estado.id)).toEqual([a, b, c])
  })

  it('separa los pedidos aunque sus eventos lleguen mezclados', () => {
    const [a, b] = [nuevoId(), nuevoId()]
    const r = pedidosAbiertos([
      local('PedidoAbierto', a, apertura),
      local('PedidoAbierto', b, apertura),
      local('ItemAgregado', b, datosItem({ precio_unitario: 7_000 })),
      local('ItemAgregado', a, datosItem({ precio_unitario: 3_000 })),
    ])
    const totales = Object.fromEntries(r.map((v) => [v.estado.id, v.total]))
    expect(totales).toEqual({ [a]: 3_000, [b]: 7_000 })
  })

  it('el mismo evento repetido no duplica el ítem', () => {
    const p = nuevoId()
    const item = local('ItemAgregado', p, datosItem({ precio_unitario: 4_000 }))
    const [v] = pedidosAbiertos([local('PedidoAbierto', p, apertura), item, item])
    expect(v?.total).toBe(4_000)
  })
})

describe('itemsVigentes', () => {
  it('deja fuera los anulados y ordena por el orden en que se agregaron', () => {
    const p = nuevoId()
    const [a, b, c] = [1, 2, 3].map(() => local('ItemAgregado', p, datosItem()))
    const [v] = pedidosAbiertos([
      local('PedidoAbierto', p, apertura),
      a as never,
      b as never,
      c as never,
      local('ItemQuitado', p, { item_id: itemId(b as never) }, 'confirmado'),
    ])
    expect(itemsVigentes((v as PedidoVisible).estado).map((i) => i.id)).toEqual([
      itemId(a as never),
      itemId(c as never),
    ])
  })
})

describe('estadoMesa', () => {
  const visible = (...eventos: ReturnType<typeof local>[]) => {
    const p = eventos[0]?.evento.agregado_id as string
    return pedidosAbiertos([local('PedidoAbierto', p, apertura), ...eventos])
  }
  const envio = (p: string, ids: string[]) =>
    local('ItemsEnviados', p, {
      comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: ids }],
    })

  it('sin pedidos, o con pedidos sin ítems, está libre', () => {
    expect(estadoMesa([])).toBe('libre')
    const p = nuevoId()
    expect(estadoMesa(pedidosAbiertos([local('PedidoAbierto', p, apertura)]))).toBe('libre')
  })

  it('con algo sin enviar está tomando', () => {
    const p = nuevoId()
    expect(estadoMesa(visible(local('ItemAgregado', p, datosItem())))).toBe('tomando')
  })

  it('con todo enviado está en cocina', () => {
    const p = nuevoId()
    const item = local('ItemAgregado', p, datosItem())
    expect(estadoMesa(visible(item, envio(p, [itemId(item)])))).toBe('en_cocina')
  })

  it('enviado más un ítem nuevo sin enviar vuelve a tomando', () => {
    const p = nuevoId()
    const uno = local('ItemAgregado', p, datosItem())
    const dos = local('ItemAgregado', p, datosItem())
    expect(estadoMesa(visible(uno, envio(p, [itemId(uno)]), dos))).toBe('tomando')
  })

  it('un ítem retenido por curso cuenta como sin enviar', () => {
    const p = nuevoId()
    const item = local('ItemAgregado', p, datosItem({ curso: 'postre' }))
    const mesa = visible(local('CursoRetenido', p, { curso: 'postre' }), item)
    expect(Object.values(mesa[0]?.estado.items ?? {})[0]?.estado).toBe('retenido')
    expect(estadoMesa(mesa)).toBe('tomando')
  })

  it('los ítems anulados no cuentan', () => {
    const p = nuevoId()
    const item = local('ItemAgregado', p, datosItem())
    expect(estadoMesa(visible(item, local('ItemQuitado', p, { item_id: itemId(item) })))).toBe(
      'libre',
    )
  })

  it('con varios pedidos en la mesa mira todos', () => {
    const [a, b] = [nuevoId(), nuevoId()]
    const itemA = local('ItemAgregado', a, datosItem())
    const mesas = pedidosAbiertos([
      local('PedidoAbierto', a, apertura),
      itemA,
      envio(a, [itemId(itemA)]),
      local('PedidoAbierto', b, apertura),
      local('ItemAgregado', b, datosItem()),
    ])
    expect(mesas).toHaveLength(2)
    expect(estadoMesa(mesas)).toBe('tomando')
    expect(estadoMesa(mesas.filter((m) => m.estado.id === a))).toBe('en_cocina')
  })
})
