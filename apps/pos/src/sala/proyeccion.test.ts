import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  estadoMesa,
  itemsVigentes,
  type PedidoVisible,
  pedidosAbiertos as proyectar,
} from './proyeccion'
import { datosItem, inOrder, local, opening } from './pruebas'

const pedidosAbiertos = (locals: Parameters<typeof inOrder>[0]) => proyectar(inOrder(locals))

const itemId = (l: ReturnType<typeof local>) => (l.event.data as { item_id: string }).item_id

describe('pedidosAbiertos', () => {
  it('sin eventos no hay pedidos', () => {
    expect(pedidosAbiertos([])).toEqual([])
  })

  it('arma el pedido con sus ítems y el neto', () => {
    const p = newId()
    const r = pedidosAbiertos([
      local('OrderOpened', p, opening),
      local('ItemAdded', p, datosItem({ unit_price: 10_000 })),
      local('ItemAdded', p, datosItem({ unit_price: 5_000, quantity: 2 })),
    ])
    expect(r).toHaveLength(1)
    expect(r[0]?.status.id).toBe(p)
    expect(Object.keys(r[0]?.status.items ?? {})).toHaveLength(2)
    expect(r[0]?.total).toBe(20_000)
    expect(r[0]?.porConfirmar).toBe(false)
    expect(r[0]?.itemsPorConfirmar.size).toBe(0)
  })

  it('marca como por confirmar solo los ítems pendientes de confirmar', () => {
    const p = newId()
    const already = local('ItemAdded', p, datosItem())
    const missing = local('ItemAdded', p, datosItem(), 'pending')
    const [v] = pedidosAbiertos([local('OrderOpened', p, opening), already, missing])
    expect(v?.porConfirmar).toBe(true)
    expect([...(v?.itemsPorConfirmar ?? [])]).toEqual([itemId(missing)])
  })

  it('un ItemsEnviados pendiente marca como por confirmar los ítems de sus comandas', () => {
    const p = newId()
    const [one, two, three] = [1, 2, 3].map(() => local('ItemAdded', p, datosItem()))
    const ids = [one, two, three].map((l) => itemId(l as never))
    const [v] = pedidosAbiertos([
      local('OrderOpened', p, opening),
      one as never,
      two as never,
      three as never,
      local(
        'ItemsSent',
        p,
        {
          tickets: [
            { ticket_id: newId(), station_id: newId(), item_ids: [ids[0] as string] },
            { ticket_id: newId(), station_id: newId(), item_ids: [ids[2] as string] },
          ],
        },
        'pending',
      ),
    ])
    expect([...(v?.itemsPorConfirmar ?? [])].sort()).toEqual([ids[0], ids[2]].sort())
    expect(v?.status.items[ids[0] as string]?.status).toBe('sent')
    expect(v?.status.items[ids[1] as string]?.status).toBe('pending')
  })

  it('un ItemsEnviados ya confirmado no marca nada', () => {
    const p = newId()
    const item = local('ItemAdded', p, datosItem())
    const [v] = pedidosAbiertos([
      local('OrderOpened', p, opening),
      item,
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [itemId(item)] }],
      }),
    ])
    expect(v?.itemsPorConfirmar.size).toBe(0)
    expect(v?.porConfirmar).toBe(false)
  })

  it('un evento pendiente que no es ItemAgregado marca el pedido pero no los ítems', () => {
    const p = newId()
    const item = local('ItemAdded', p, datosItem())
    const [v] = pedidosAbiertos([
      local('OrderOpened', p, opening),
      item,
      local('ItemChanged', p, { item_id: itemId(item), notes: 'sin hielo' }, 'pending'),
    ])
    expect(v?.porConfirmar).toBe(true)
    expect(v?.itemsPorConfirmar.size).toBe(0)
    expect(v?.status.items[itemId(item)]?.notes).toBe('sin hielo')
  })

  it('un pedido abierto solo con eventos pendientes (sin conexión) ya se ve', () => {
    const p = newId()
    const [v] = pedidosAbiertos([
      local('OrderOpened', p, opening, 'pending'),
      local('ItemAdded', p, datosItem({ unit_price: 32_000 }), 'pending'),
    ])
    expect(v?.total).toBe(32_000)
    expect(v?.porConfirmar).toBe(true)
  })

  it('ignora los eventos rechazados y los que están en cuarentena', () => {
    const p = newId()
    const badCase = local('ItemAdded', p, datosItem({ unit_price: 99_000 }), 'rejected')
    const odd = local('ItemAdded', p, datosItem({ unit_price: 88_000 }), 'quarantine')
    const [v] = pedidosAbiertos([
      local('OrderOpened', p, opening),
      local('ItemAdded', p, datosItem({ unit_price: 1_000 })),
      badCase,
      odd,
    ])
    expect(v?.total).toBe(1_000)
    expect(v?.status.items[itemId(badCase)]).toBeUndefined()
    expect(v?.status.items[itemId(odd)]).toBeUndefined()
  })

  it('un pedido cuya apertura fue rechazada no aparece', () => {
    const p = newId()
    expect(
      pedidosAbiertos([
        local('OrderOpened', p, opening, 'rejected'),
        local('ItemAdded', p, datosItem(), 'pending'),
      ]),
    ).toEqual([])
  })

  it('no muestra pedidos cerrados ni cancelados', () => {
    const closed = newId()
    const canceled = newId()
    const opened = newId()
    const r = pedidosAbiertos([
      local('OrderOpened', closed, opening),
      local('OrderClosed', closed, {}),
      local('OrderOpened', canceled, opening),
      local('OrderCanceled', canceled, {}, 'confirmed', { reason: 'error' }),
      local('OrderOpened', opened, opening),
    ])
    expect(r.map((v) => v.status.id)).toEqual([opened])
  })

  it('un cierre rechazado deja el pedido abierto', () => {
    const p = newId()
    const r = pedidosAbiertos([
      local('OrderOpened', p, opening),
      local('OrderClosed', p, {}, 'rejected'),
    ])
    expect(r).toHaveLength(1)
  })

  it('ordena del más antiguo al más nuevo por hora de apertura', () => {
    const [a, b, c] = [newId(), newId(), newId()]
    // La hora de apertura es la que puso el hub al recibirlo (`received_at`).
    const open = (id: string, time: string) => {
      const l = local('OrderOpened', id, opening)
      return { ...l, event: { ...l.event, received_at: time } }
    }
    const r = pedidosAbiertos([
      open(b, '2026-10-24T15:10:00.000Z'),
      open(c, '2026-10-24T15:20:00.000Z'),
      open(a, '2026-10-24T15:00:00.000Z'),
    ])
    expect(r.map((v) => v.status.id)).toEqual([a, b, c])
  })

  it('separa los pedidos aunque sus eventos lleguen mezclados', () => {
    const [a, b] = [newId(), newId()]
    const r = pedidosAbiertos([
      local('OrderOpened', a, opening),
      local('OrderOpened', b, opening),
      local('ItemAdded', b, datosItem({ unit_price: 7_000 })),
      local('ItemAdded', a, datosItem({ unit_price: 3_000 })),
    ])
    const totales = Object.fromEntries(r.map((v) => [v.status.id, v.total]))
    expect(totales).toEqual({ [a]: 3_000, [b]: 7_000 })
  })

  it('el mismo evento repetido no duplica el ítem', () => {
    const p = newId()
    const item = local('ItemAdded', p, datosItem({ unit_price: 4_000 }))
    const [v] = pedidosAbiertos([local('OrderOpened', p, opening), item, item])
    expect(v?.total).toBe(4_000)
  })
})

describe('itemsVigentes', () => {
  it('deja fuera los anulados y ordena por el orden en que se agregaron', () => {
    const p = newId()
    const [a, b, c] = [1, 2, 3].map(() => local('ItemAdded', p, datosItem()))
    const [v] = pedidosAbiertos([
      local('OrderOpened', p, opening),
      a as never,
      b as never,
      c as never,
      local('ItemRemoved', p, { item_id: itemId(b as never) }, 'confirmed'),
    ])
    expect(itemsVigentes((v as PedidoVisible).status).map((i) => i.id)).toEqual([
      itemId(a as never),
      itemId(c as never),
    ])
  })
})

describe('estadoMesa', () => {
  const visible = (...events: ReturnType<typeof local>[]) => {
    const p = events[0]?.event.aggregate_id as string
    return pedidosAbiertos([local('OrderOpened', p, opening), ...events])
  }
  const envio = (p: string, ids: string[]) =>
    local('ItemsSent', p, {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: ids }],
    })

  it('sin pedidos, o con pedidos sin ítems, está libre', () => {
    expect(estadoMesa([])).toBe('free')
    const p = newId()
    expect(estadoMesa(pedidosAbiertos([local('OrderOpened', p, opening)]))).toBe('free')
  })

  it('con algo sin enviar está tomando', () => {
    const p = newId()
    expect(estadoMesa(visible(local('ItemAdded', p, datosItem())))).toBe('taking')
  })

  it('con todo enviado está en cocina', () => {
    const p = newId()
    const item = local('ItemAdded', p, datosItem())
    expect(estadoMesa(visible(item, envio(p, [itemId(item)])))).toBe('in_kitchen')
  })

  it('enviado más un ítem nuevo sin enviar vuelve a tomando', () => {
    const p = newId()
    const one = local('ItemAdded', p, datosItem())
    const two = local('ItemAdded', p, datosItem())
    expect(estadoMesa(visible(one, envio(p, [itemId(one)]), two))).toBe('taking')
  })

  it('un ítem retenido por curso cuenta como sin enviar', () => {
    const p = newId()
    const item = local('ItemAdded', p, datosItem({ course: 'dessert' }))
    const table = visible(local('CourseHeld', p, { course: 'dessert' }), item)
    expect(Object.values(table[0]?.status.items ?? {})[0]?.status).toBe('held')
    expect(estadoMesa(table)).toBe('taking')
  })

  it('los ítems anulados no cuentan', () => {
    const p = newId()
    const item = local('ItemAdded', p, datosItem())
    expect(estadoMesa(visible(item, local('ItemRemoved', p, { item_id: itemId(item) })))).toBe(
      'free',
    )
  })

  it('con varios pedidos en la mesa mira todos', () => {
    const [a, b] = [newId(), newId()]
    const itemA = local('ItemAdded', a, datosItem())
    const tables = pedidosAbiertos([
      local('OrderOpened', a, opening),
      itemA,
      envio(a, [itemId(itemA)]),
      local('OrderOpened', b, opening),
      local('ItemAdded', b, datosItem()),
    ])
    expect(tables).toHaveLength(2)
    expect(estadoMesa(tables)).toBe('taking')
    expect(estadoMesa(tables.filter((m) => m.status.id === a))).toBe('in_kitchen')
  })
})
