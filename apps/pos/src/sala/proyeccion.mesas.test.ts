import { newId, type OrderState } from '@pos/core'
import type { LocalEvent } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { comandasEnCocina } from './comandas'
import { movidoDe } from './pedido'
import {
  estadoMesa,
  ocupaMesa,
  type PedidoVisible,
  pedidosAbiertos as proyectar,
} from './proyeccion'
import { datosItem, inOrder, local, opening } from './pruebas'

// Tarea 1.5 en la lista de pedidos del equipo y en «Pedidos en cocina»: un plato que pasa de un
// pedido a otro se ve en el destino y no en el origen, también si el movimiento aún está
// pendiente (sin conexión). Las mesas unidas ocupan todas el mismo pedido.

const COCINA = newId()
const pedidosAbiertos = (l: LocalEvent[]) => proyectar(inOrder(l))
const idDe = (l: LocalEvent) => (l.event.data as { item_id: string }).item_id
const ofOrder = (v: PedidoVisible[], id: string) => v.find((p) => p.status.id === id)

/** Origen con un plato enviado; destino abierto; y el evento de mover como lo arma la pantalla. */
function scenario(options: { estadoMover?: 'confirmed' | 'pending' | 'rejected' } = {}) {
  const source = newId()
  const target = newId()
  const a = local('ItemAdded', source, datosItem({ name: 'Tagliata', quantity: 2 }))
  const b = local('ItemAdded', source, datosItem({ name: 'Risotto' }))
  const ticket = newId()
  const base = [
    local('OrderOpened', source, { ...opening, table_id: newId() }),
    local('OrderOpened', target, { ...opening, table_id: newId() }),
    a,
    b,
    local('ItemsSent', source, {
      tickets: [{ ticket_id: ticket, station_id: COCINA, item_ids: [idDe(a), idDe(b)] }],
    }),
  ] as LocalEvent[]
  const before = pedidosAbiertos(base)
  const itemA = ofOrder(before, source)?.status.items[idDe(a)]
  if (!itemA) throw new Error('sin ítem')
  const move = local(
    'ItemsMoved',
    source,
    { target_order_id: target, items: [movidoDe(itemA)] },
    options.estadoMover ?? 'confirmed',
    { related: [target] },
  )
  return { source, target, a, b, ticket, base, move, all: [...base, move] as LocalEvent[] }
}

describe('pedidosAbiertos con productos movidos', () => {
  it('el plato aparece en el destino y no en el origen', () => {
    const e = scenario()
    const v = pedidosAbiertos(e.all)
    expect(Object.keys(ofOrder(v, e.source)?.status.items ?? {})).toEqual([idDe(e.b)])
    expect(Object.keys(ofOrder(v, e.target)?.status.items ?? {})).toEqual([idDe(e.a)])
    expect(ofOrder(v, e.target)?.status.items[idDe(e.a)]).toMatchObject({
      status: 'sent',
      quantity: 2,
    })
  })

  it('los totales se reparten y su suma no cambia', () => {
    const e = scenario()
    const before = pedidosAbiertos(e.base)
    const after = pedidosAbiertos(e.all)
    const sum = (v: PedidoVisible[]) => v.reduce((n, p) => n + p.total, 0)
    expect(sum(after)).toBe(sum(before))
    expect(ofOrder(after, e.target)?.total).toBeGreaterThan(0)
  })

  it('pendiente (sin conexión): ya se ve movido, y los dos pedidos quedan «por confirmar»', () => {
    const e = scenario({ estadoMover: 'pending' })
    const v = pedidosAbiertos(e.all)
    expect(ofOrder(v, e.source)?.status.items[idDe(e.a)]).toBeUndefined()
    expect(ofOrder(v, e.target)?.status.items[idDe(e.a)]).toBeDefined()
    expect(ofOrder(v, e.source)?.porConfirmar).toBe(true)
    expect(ofOrder(v, e.target)?.porConfirmar).toBe(true)
  })

  it('un movimiento rechazado por el hub no cambia nada: el plato sigue en el origen', () => {
    const e = scenario({ estadoMover: 'rejected' })
    const v = pedidosAbiertos(e.all)
    expect(ofOrder(v, e.source)?.status.items[idDe(e.a)]).toBeDefined()
    expect(ofOrder(v, e.target)?.status.items).toEqual({})
  })

  it('abrir el destino y mover, ambos pendientes: el pedido nuevo aparece ya con el plato', () => {
    const source = newId()
    const target = newId()
    const a = local('ItemAdded', source, datosItem())
    const base = [
      local('OrderOpened', source, { ...opening, table_id: newId() }),
      a,
      local('ItemsSent', source, {
        tickets: [{ ticket_id: newId(), station_id: COCINA, item_ids: [idDe(a)] }],
      }),
    ] as LocalEvent[]
    const item = ofOrder(pedidosAbiertos(base), source)?.status.items[idDe(a)]
    if (!item) throw new Error('sin ítem')
    const batch = [
      ...base,
      local('OrderOpened', target, { ...opening, table_id: newId() }, 'pending'),
      local('ItemsMoved', source, { target_order_id: target, items: [movidoDe(item)] }, 'pending', {
        related: [target],
      }),
    ] as LocalEvent[]
    const v = pedidosAbiertos(batch)
    expect(ofOrder(v, target)?.status.items[idDe(a)]).toBeDefined()
    expect(ofOrder(v, source)?.status.items).toEqual({})
  })

  it('un origen que se queda sin productos sigue abierto pero no ocupa su mesa; el destino sí', () => {
    const e = scenario()
    const everything = {
      ...e.move,
      event: {
        ...e.move.event,
        data: {
          target_order_id: e.target,
          items: [e.a, e.b].map((l) =>
            movidoDe(ofOrder(pedidosAbiertos(e.base), e.source)?.status.items[idDe(l)] as never),
          ),
        },
      },
    } as LocalEvent
    const v = pedidosAbiertos([...e.base, everything])
    const source = ofOrder(v, e.source)
    expect(source?.status.status).toBe('open')
    expect(Object.keys(source?.status.items ?? {})).toEqual([])
    expect(ocupaMesa((source as PedidoVisible).status)).toBe(false)
    expect(ocupaMesa(ofOrder(v, e.target)?.status as never)).toBe(true)
    expect(estadoMesa([source as PedidoVisible])).toBe('free')
  })

  it('el movimiento no duplica el pedido de destino ni deja eventos ajenos en un tercero', () => {
    const e = scenario()
    const thirdOne = newId()
    const v = pedidosAbiertos([
      ...e.all,
      local('OrderOpened', thirdOne, { ...opening, table_id: newId() }),
    ])
    expect(v.map((p) => p.status.id).sort()).toEqual([e.source, e.target, thirdOne].sort())
    expect(ofOrder(v, thirdOne)?.status.items).toEqual({})
  })

  it('ida y vuelta: el plato vuelve al origen', () => {
    const e = scenario()
    const enDestino = ofOrder(pedidosAbiertos(e.all), e.target)?.status.items[idDe(e.a)]
    if (!enDestino) throw new Error('sin ítem')
    const runOnce = local(
      'ItemsMoved',
      e.target,
      { target_order_id: e.source, items: [movidoDe(enDestino)] },
      'confirmed',
      { related: [e.source] },
    )
    const v = pedidosAbiertos([...e.all, runOnce] as LocalEvent[])
    expect(ofOrder(v, e.source)?.status.items[idDe(e.a)]).toBeDefined()
    expect(ofOrder(v, e.target)?.status.items[idDe(e.a)]).toBeUndefined()
  })
})

describe('comandasEnCocina con un plato movido', () => {
  it('la comanda se parte en dos tarjetas: lo que quedó en el origen y lo que llegó al destino', () => {
    const e = scenario()
    const locals = inOrder(e.all)
    const orders = proyectar(locals)
    const c = comandasEnCocina(locals, orders)
    expect(c).toHaveLength(2)
    expect(c.every((x) => x.comandaId === e.ticket)).toBe(true)
    const porPedido = Object.fromEntries(
      c.map((x) => [x.order.status.id, x.items.map((i) => i.name)]),
    )
    expect(porPedido).toEqual({ [e.source]: ['Risotto'], [e.target]: ['Tagliata'] })
  })

  it('cada tarjeta tiene una clave distinta (comanda + pedido)', () => {
    const e = scenario()
    const locals = inOrder(e.all)
    const c = comandasEnCocina(locals, proyectar(locals))
    expect(new Set(c.map((x) => x.key)).size).toBe(c.length)
    expect(c.map((x) => x.key).sort()).toEqual(
      [`${e.ticket}:${e.source}`, `${e.ticket}:${e.target}`].sort(),
    )
  })

  it('sin mover, una sola tarjeta con clave comanda:pedido', () => {
    const e = scenario()
    const locals = inOrder(e.base)
    const c = comandasEnCocina(locals, proyectar(locals))
    expect(c).toHaveLength(1)
    expect(c[0]?.key).toBe(`${e.ticket}:${e.source}`)
    expect(c[0]?.items.map((i) => i.name)).toEqual(['Tagliata', 'Risotto'])
  })

  it('si se mueve todo, solo queda la tarjeta del destino', () => {
    const e = scenario()
    const base = proyectar(inOrder(e.base))
    const source = ofOrder(base, e.source)
    const everything = local(
      'ItemsMoved',
      e.source,
      {
        target_order_id: e.target,
        items: [e.a, e.b].map((l) => movidoDe(source?.status.items[idDe(l)] as never)),
      },
      'confirmed',
      { related: [e.target] },
    )
    const locals = inOrder([...e.base, everything] as LocalEvent[])
    const c = comandasEnCocina(locals, proyectar(locals))
    expect(c).toHaveLength(1)
    expect(c[0]?.order.status.id).toBe(e.target)
    expect(c[0]?.items).toHaveLength(2)
  })

  it('pendiente sin conexión: la tarjeta ya sigue al plato al destino', () => {
    const e = scenario({ estadoMover: 'pending' })
    const locals = inOrder(e.all)
    const c = comandasEnCocina(locals, proyectar(locals))
    expect(c.find((x) => x.order.status.id === e.target)?.items.map((i) => i.name)).toEqual([
      'Tagliata',
    ])
  })

  it('un plato entregado en el destino sale de cocina; el que sigue en el origen se queda', () => {
    const e = scenario()
    const locals = inOrder([
      ...e.all,
      local('ItemServed', e.target, { item_ids: [idDe(e.a)] }),
    ] as LocalEvent[])
    const c = comandasEnCocina(locals, proyectar(locals))
    expect(c.map((x) => x.order.status.id)).toEqual([e.source])
  })

  it('un pedido cancelado deja de aparecer en cocina', () => {
    const e = scenario()
    const locals = inOrder([
      ...e.all,
      local('OrderCanceled', e.target, {}, 'confirmed', { reason: 'x' }),
    ] as LocalEvent[])
    const c = comandasEnCocina(locals, proyectar(locals))
    expect(c.map((x) => x.order.status.id)).toEqual([e.source])
  })

  it('el orden por hora de envío se mantiene entre las tarjetas partidas y otras comandas', () => {
    const e = scenario()
    const locals = inOrder(e.all)
    const c = comandasEnCocina(locals, proyectar(locals))
    expect(c.map((x) => x.enviadaEn)).toEqual([...c.map((x) => x.enviadaEn)].sort())
  })
})

describe('ocupaMesa', () => {
  const opened = (extras: Parameters<typeof local>[4] = {}, add = false, remove = false) => {
    const p = newId()
    const it = datosItem()
    const ev = [local('OrderOpened', p, { ...opening, table_id: newId() }, 'confirmed', extras)]
    if (add) ev.push(local('ItemAdded', p, it) as never)
    if (remove) ev.push(local('ItemRemoved', p, { item_id: it.item_id }) as never)
    return pedidosAbiertos(ev as LocalEvent[])[0]?.status as OrderState
  }

  it('un pedido recién abierto, sin nada, ocupa la mesa', () => {
    expect(ocupaMesa(opened())).toBe(true)
  })

  it('con un producto vigente, la ocupa', () => {
    expect(ocupaMesa(opened({}, true))).toBe(true)
  })

  it('uno cerrado o cancelado no', () => {
    const p = newId()
    const canceled = pedidosAbiertos([
      local('OrderOpened', p, { ...opening, table_id: newId() }),
      local('OrderCanceled', p, {}, 'confirmed', { reason: 'x' }),
    ])
    expect(canceled).toEqual([])
    const status = { ...opened(), status: 'canceled' as const }
    expect(ocupaMesa(status)).toBe(false)
    expect(ocupaMesa({ ...opened(), status: 'closed' as const })).toBe(false)
  })

  it('con todo anulado deja de ocuparla', () => {
    const p = newId()
    const it = datosItem()
    const v = pedidosAbiertos([
      local('OrderOpened', p, { ...opening, table_id: newId() }),
      local('ItemAdded', p, it),
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: COCINA, item_ids: [it.item_id] }],
      }),
      local(
        'ItemVoided',
        p,
        { item_id: it.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        'confirmed',
        { reason: 'x' },
      ),
    ] as LocalEvent[])
    expect(v).toHaveLength(1)
    expect(ocupaMesa((v[0] as PedidoVisible).status)).toBe(false)
  })

  it('quitar lo que aún no se enviaba no suelta la mesa: el mesero sigue tomando el pedido', () => {
    // Igual que en el hub (packages/sync/src/hub/hub.ts `ocupa`): solo lo pasado a otra mesa o lo
    // anulado la suelta.
    expect(ocupaMesa(opened({}, true, true))).toBe(true)
  })
})

describe('estadoMesa y mesas unidas', () => {
  function group() {
    const p = newId()
    const [m1, m2] = [newId(), newId()]
    const it = datosItem()
    const events = [
      local('OrderOpened', p, { ...opening, table_id: m1 }),
      local('TablesMerged', p, { table_ids: [m2] }),
      local('ItemAdded', p, it),
    ] as LocalEvent[]
    return { p, m1, m2, it, events }
  }

  it('el pedido de un grupo conserva sus mesas unidas en la proyección', () => {
    const g = group()
    const [v] = pedidosAbiertos(g.events)
    expect(v?.status.tableId).toBe(g.m1)
    expect(v?.status.mergedTables).toEqual([g.m2])
  })

  it('las mesas unidas comparten estado: tomando, en cocina, listo y servida', () => {
    const g = group()
    const status = (extra: LocalEvent[]) => estadoMesa(pedidosAbiertos([...g.events, ...extra]))
    expect(status([])).toBe('taking')
    const send = local('ItemsSent', g.p, {
      tickets: [{ ticket_id: newId(), station_id: COCINA, item_ids: [g.it.item_id] }],
    })
    expect(status([send])).toBe('in_kitchen')
    expect(status([send, local('ItemReady', g.p, { item_ids: [g.it.item_id] })])).toBe('ready')
    expect(status([send, local('ItemServed', g.p, { item_ids: [g.it.item_id] })])).toBe('served')
  })

  it('un grupo vacío (recién unido, sin productos) se ve libre', () => {
    const g = group()
    expect(estadoMesa(pedidosAbiertos(g.events.slice(0, 2)))).toBe('free')
  })

  it('separar las mesas deja la proyección sin unidas', () => {
    const g = group()
    const [v] = pedidosAbiertos([...g.events, local('TablesSeparated', g.p, { table_ids: [g.m2] })])
    expect(v?.status.mergedTables).toEqual([])
  })

  it('una unión pendiente (sin conexión) ya se ve en la proyección', () => {
    const g = group()
    const [v] = pedidosAbiertos([
      ...g.events.slice(0, 1),
      local('TablesMerged', g.p, { table_ids: [g.m2] }, 'pending'),
    ])
    expect(v?.status.mergedTables).toEqual([g.m2])
    expect(v?.porConfirmar).toBe(true)
  })
})
