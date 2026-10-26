import { type EstadoPedido, nuevoId } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { comandasEnCocina } from './comandas'
import { movidoDe } from './pedido'
import {
  estadoMesa,
  ocupaMesa,
  type PedidoVisible,
  pedidosAbiertos as proyectar,
} from './proyeccion'
import { apertura, datosItem, enOrden, local } from './pruebas'

// Tarea 1.5 en la lista de pedidos del equipo y en «Pedidos en cocina»: un plato que pasa de un
// pedido a otro se ve en el destino y no en el origen, también si el movimiento aún está
// pendiente (sin conexión). Las mesas unidas ocupan todas el mismo pedido.

const COCINA = nuevoId()
const pedidosAbiertos = (l: EventoLocal[]) => proyectar(enOrden(l))
const idDe = (l: EventoLocal) => (l.evento.datos as { item_id: string }).item_id
const dePedido = (v: PedidoVisible[], id: string) => v.find((p) => p.estado.id === id)

/** Origen con un plato enviado; destino abierto; y el evento de mover como lo arma la pantalla. */
function escenario(opciones: { estadoMover?: 'confirmado' | 'pendiente' | 'rechazado' } = {}) {
  const origen = nuevoId()
  const destino = nuevoId()
  const a = local('ItemAgregado', origen, datosItem({ nombre: 'Tagliata', cantidad: 2 }))
  const b = local('ItemAgregado', origen, datosItem({ nombre: 'Risotto' }))
  const comanda = nuevoId()
  const base = [
    local('PedidoAbierto', origen, { ...apertura, mesa_id: nuevoId() }),
    local('PedidoAbierto', destino, { ...apertura, mesa_id: nuevoId() }),
    a,
    b,
    local('ItemsEnviados', origen, {
      comandas: [{ comanda_id: comanda, estacion_id: COCINA, item_ids: [idDe(a), idDe(b)] }],
    }),
  ] as EventoLocal[]
  const antes = pedidosAbiertos(base)
  const itemA = dePedido(antes, origen)?.estado.items[idDe(a)]
  if (!itemA) throw new Error('sin ítem')
  const mover = local(
    'ItemsMovidos',
    origen,
    { pedido_destino_id: destino, items: [movidoDe(itemA)] },
    opciones.estadoMover ?? 'confirmado',
    { relacionados: [destino] },
  )
  return { origen, destino, a, b, comanda, base, mover, todos: [...base, mover] as EventoLocal[] }
}

describe('pedidosAbiertos con productos movidos', () => {
  it('el plato aparece en el destino y no en el origen', () => {
    const e = escenario()
    const v = pedidosAbiertos(e.todos)
    expect(Object.keys(dePedido(v, e.origen)?.estado.items ?? {})).toEqual([idDe(e.b)])
    expect(Object.keys(dePedido(v, e.destino)?.estado.items ?? {})).toEqual([idDe(e.a)])
    expect(dePedido(v, e.destino)?.estado.items[idDe(e.a)]).toMatchObject({
      estado: 'enviado',
      cantidad: 2,
    })
  })

  it('los totales se reparten y su suma no cambia', () => {
    const e = escenario()
    const antes = pedidosAbiertos(e.base)
    const despues = pedidosAbiertos(e.todos)
    const suma = (v: PedidoVisible[]) => v.reduce((n, p) => n + p.total, 0)
    expect(suma(despues)).toBe(suma(antes))
    expect(dePedido(despues, e.destino)?.total).toBeGreaterThan(0)
  })

  it('pendiente (sin conexión): ya se ve movido, y los dos pedidos quedan «por confirmar»', () => {
    const e = escenario({ estadoMover: 'pendiente' })
    const v = pedidosAbiertos(e.todos)
    expect(dePedido(v, e.origen)?.estado.items[idDe(e.a)]).toBeUndefined()
    expect(dePedido(v, e.destino)?.estado.items[idDe(e.a)]).toBeDefined()
    expect(dePedido(v, e.origen)?.porConfirmar).toBe(true)
    expect(dePedido(v, e.destino)?.porConfirmar).toBe(true)
  })

  it('un movimiento rechazado por el hub no cambia nada: el plato sigue en el origen', () => {
    const e = escenario({ estadoMover: 'rechazado' })
    const v = pedidosAbiertos(e.todos)
    expect(dePedido(v, e.origen)?.estado.items[idDe(e.a)]).toBeDefined()
    expect(dePedido(v, e.destino)?.estado.items).toEqual({})
  })

  it('abrir el destino y mover, ambos pendientes: el pedido nuevo aparece ya con el plato', () => {
    const origen = nuevoId()
    const destino = nuevoId()
    const a = local('ItemAgregado', origen, datosItem())
    const base = [
      local('PedidoAbierto', origen, { ...apertura, mesa_id: nuevoId() }),
      a,
      local('ItemsEnviados', origen, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: COCINA, item_ids: [idDe(a)] }],
      }),
    ] as EventoLocal[]
    const item = dePedido(pedidosAbiertos(base), origen)?.estado.items[idDe(a)]
    if (!item) throw new Error('sin ítem')
    const lote = [
      ...base,
      local('PedidoAbierto', destino, { ...apertura, mesa_id: nuevoId() }, 'pendiente'),
      local(
        'ItemsMovidos',
        origen,
        { pedido_destino_id: destino, items: [movidoDe(item)] },
        'pendiente',
        { relacionados: [destino] },
      ),
    ] as EventoLocal[]
    const v = pedidosAbiertos(lote)
    expect(dePedido(v, destino)?.estado.items[idDe(a)]).toBeDefined()
    expect(dePedido(v, origen)?.estado.items).toEqual({})
  })

  it('un origen que se queda sin productos sigue abierto pero no ocupa su mesa; el destino sí', () => {
    const e = escenario()
    const todo = {
      ...e.mover,
      evento: {
        ...e.mover.evento,
        datos: {
          pedido_destino_id: e.destino,
          items: [e.a, e.b].map((l) =>
            movidoDe(dePedido(pedidosAbiertos(e.base), e.origen)?.estado.items[idDe(l)] as never),
          ),
        },
      },
    } as EventoLocal
    const v = pedidosAbiertos([...e.base, todo])
    const origen = dePedido(v, e.origen)
    expect(origen?.estado.estado).toBe('abierto')
    expect(Object.keys(origen?.estado.items ?? {})).toEqual([])
    expect(ocupaMesa((origen as PedidoVisible).estado)).toBe(false)
    expect(ocupaMesa(dePedido(v, e.destino)?.estado as never)).toBe(true)
    expect(estadoMesa([origen as PedidoVisible])).toBe('libre')
  })

  it('el movimiento no duplica el pedido de destino ni deja eventos ajenos en un tercero', () => {
    const e = escenario()
    const tercero = nuevoId()
    const v = pedidosAbiertos([
      ...e.todos,
      local('PedidoAbierto', tercero, { ...apertura, mesa_id: nuevoId() }),
    ])
    expect(v.map((p) => p.estado.id).sort()).toEqual([e.origen, e.destino, tercero].sort())
    expect(dePedido(v, tercero)?.estado.items).toEqual({})
  })

  it('ida y vuelta: el plato vuelve al origen', () => {
    const e = escenario()
    const enDestino = dePedido(pedidosAbiertos(e.todos), e.destino)?.estado.items[idDe(e.a)]
    if (!enDestino) throw new Error('sin ítem')
    const vuelta = local(
      'ItemsMovidos',
      e.destino,
      { pedido_destino_id: e.origen, items: [movidoDe(enDestino)] },
      'confirmado',
      { relacionados: [e.origen] },
    )
    const v = pedidosAbiertos([...e.todos, vuelta] as EventoLocal[])
    expect(dePedido(v, e.origen)?.estado.items[idDe(e.a)]).toBeDefined()
    expect(dePedido(v, e.destino)?.estado.items[idDe(e.a)]).toBeUndefined()
  })
})

describe('comandasEnCocina con un plato movido', () => {
  it('la comanda se parte en dos tarjetas: lo que quedó en el origen y lo que llegó al destino', () => {
    const e = escenario()
    const locales = enOrden(e.todos)
    const pedidos = proyectar(locales)
    const c = comandasEnCocina(locales, pedidos)
    expect(c).toHaveLength(2)
    expect(c.every((x) => x.comandaId === e.comanda)).toBe(true)
    const porPedido = Object.fromEntries(
      c.map((x) => [x.pedido.estado.id, x.items.map((i) => i.nombre)]),
    )
    expect(porPedido).toEqual({ [e.origen]: ['Risotto'], [e.destino]: ['Tagliata'] })
  })

  it('cada tarjeta tiene una clave distinta (comanda + pedido)', () => {
    const e = escenario()
    const locales = enOrden(e.todos)
    const c = comandasEnCocina(locales, proyectar(locales))
    expect(new Set(c.map((x) => x.clave)).size).toBe(c.length)
    expect(c.map((x) => x.clave).sort()).toEqual(
      [`${e.comanda}:${e.origen}`, `${e.comanda}:${e.destino}`].sort(),
    )
  })

  it('sin mover, una sola tarjeta con clave comanda:pedido', () => {
    const e = escenario()
    const locales = enOrden(e.base)
    const c = comandasEnCocina(locales, proyectar(locales))
    expect(c).toHaveLength(1)
    expect(c[0]?.clave).toBe(`${e.comanda}:${e.origen}`)
    expect(c[0]?.items.map((i) => i.nombre)).toEqual(['Tagliata', 'Risotto'])
  })

  it('si se mueve todo, solo queda la tarjeta del destino', () => {
    const e = escenario()
    const base = proyectar(enOrden(e.base))
    const origen = dePedido(base, e.origen)
    const todo = local(
      'ItemsMovidos',
      e.origen,
      {
        pedido_destino_id: e.destino,
        items: [e.a, e.b].map((l) => movidoDe(origen?.estado.items[idDe(l)] as never)),
      },
      'confirmado',
      { relacionados: [e.destino] },
    )
    const locales = enOrden([...e.base, todo] as EventoLocal[])
    const c = comandasEnCocina(locales, proyectar(locales))
    expect(c).toHaveLength(1)
    expect(c[0]?.pedido.estado.id).toBe(e.destino)
    expect(c[0]?.items).toHaveLength(2)
  })

  it('pendiente sin conexión: la tarjeta ya sigue al plato al destino', () => {
    const e = escenario({ estadoMover: 'pendiente' })
    const locales = enOrden(e.todos)
    const c = comandasEnCocina(locales, proyectar(locales))
    expect(c.find((x) => x.pedido.estado.id === e.destino)?.items.map((i) => i.nombre)).toEqual([
      'Tagliata',
    ])
  })

  it('un plato entregado en el destino sale de cocina; el que sigue en el origen se queda', () => {
    const e = escenario()
    const locales = enOrden([
      ...e.todos,
      local('ItemEntregado', e.destino, { item_ids: [idDe(e.a)] }),
    ] as EventoLocal[])
    const c = comandasEnCocina(locales, proyectar(locales))
    expect(c.map((x) => x.pedido.estado.id)).toEqual([e.origen])
  })

  it('un pedido cancelado deja de aparecer en cocina', () => {
    const e = escenario()
    const locales = enOrden([
      ...e.todos,
      local('PedidoCancelado', e.destino, {}, 'confirmado', { motivo: 'x' }),
    ] as EventoLocal[])
    const c = comandasEnCocina(locales, proyectar(locales))
    expect(c.map((x) => x.pedido.estado.id)).toEqual([e.origen])
  })

  it('el orden por hora de envío se mantiene entre las tarjetas partidas y otras comandas', () => {
    const e = escenario()
    const locales = enOrden(e.todos)
    const c = comandasEnCocina(locales, proyectar(locales))
    expect(c.map((x) => x.enviadaEn)).toEqual([...c.map((x) => x.enviadaEn)].sort())
  })
})

describe('ocupaMesa', () => {
  const abierto = (extras: Parameters<typeof local>[4] = {}, agregar = false, quitar = false) => {
    const p = nuevoId()
    const it = datosItem()
    const ev = [
      local('PedidoAbierto', p, { ...apertura, mesa_id: nuevoId() }, 'confirmado', extras),
    ]
    if (agregar) ev.push(local('ItemAgregado', p, it) as never)
    if (quitar) ev.push(local('ItemQuitado', p, { item_id: it.item_id }) as never)
    return pedidosAbiertos(ev as EventoLocal[])[0]?.estado as EstadoPedido
  }

  it('un pedido recién abierto, sin nada, ocupa la mesa', () => {
    expect(ocupaMesa(abierto())).toBe(true)
  })

  it('con un producto vigente, la ocupa', () => {
    expect(ocupaMesa(abierto({}, true))).toBe(true)
  })

  it('uno cerrado o cancelado no', () => {
    const p = nuevoId()
    const cancelado = pedidosAbiertos([
      local('PedidoAbierto', p, { ...apertura, mesa_id: nuevoId() }),
      local('PedidoCancelado', p, {}, 'confirmado', { motivo: 'x' }),
    ])
    expect(cancelado).toEqual([])
    const estado = { ...abierto(), estado: 'cancelado' as const }
    expect(ocupaMesa(estado)).toBe(false)
    expect(ocupaMesa({ ...abierto(), estado: 'cerrado' as const })).toBe(false)
  })

  it('con todo anulado deja de ocuparla', () => {
    const p = nuevoId()
    const it = datosItem()
    const v = pedidosAbiertos([
      local('PedidoAbierto', p, { ...apertura, mesa_id: nuevoId() }),
      local('ItemAgregado', p, it),
      local('ItemsEnviados', p, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: COCINA, item_ids: [it.item_id] }],
      }),
      local(
        'ItemAnulado',
        p,
        { item_id: it.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
        'confirmado',
        { motivo: 'x' },
      ),
    ] as EventoLocal[])
    expect(v).toHaveLength(1)
    expect(ocupaMesa((v[0] as PedidoVisible).estado)).toBe(false)
  })

  it('quitar lo que aún no se enviaba no suelta la mesa: el mesero sigue tomando el pedido', () => {
    // Igual que en el hub (packages/sync/src/hub/hub.ts `ocupa`): solo lo pasado a otra mesa o lo
    // anulado la suelta.
    expect(ocupaMesa(abierto({}, true, true))).toBe(true)
  })
})

describe('estadoMesa y mesas unidas', () => {
  function grupo() {
    const p = nuevoId()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const it = datosItem()
    const eventos = [
      local('PedidoAbierto', p, { ...apertura, mesa_id: m1 }),
      local('MesasUnidas', p, { mesa_ids: [m2] }),
      local('ItemAgregado', p, it),
    ] as EventoLocal[]
    return { p, m1, m2, it, eventos }
  }

  it('el pedido de un grupo conserva sus mesas unidas en la proyección', () => {
    const g = grupo()
    const [v] = pedidosAbiertos(g.eventos)
    expect(v?.estado.mesaId).toBe(g.m1)
    expect(v?.estado.mesasUnidas).toEqual([g.m2])
  })

  it('las mesas unidas comparten estado: tomando, en cocina, listo y servida', () => {
    const g = grupo()
    const estado = (extra: EventoLocal[]) => estadoMesa(pedidosAbiertos([...g.eventos, ...extra]))
    expect(estado([])).toBe('tomando')
    const enviar = local('ItemsEnviados', g.p, {
      comandas: [{ comanda_id: nuevoId(), estacion_id: COCINA, item_ids: [g.it.item_id] }],
    })
    expect(estado([enviar])).toBe('en_cocina')
    expect(estado([enviar, local('ItemListo', g.p, { item_ids: [g.it.item_id] })])).toBe('listo')
    expect(estado([enviar, local('ItemEntregado', g.p, { item_ids: [g.it.item_id] })])).toBe(
      'servida',
    )
  })

  it('un grupo vacío (recién unido, sin productos) se ve libre', () => {
    const g = grupo()
    expect(estadoMesa(pedidosAbiertos(g.eventos.slice(0, 2)))).toBe('libre')
  })

  it('separar las mesas deja la proyección sin unidas', () => {
    const g = grupo()
    const [v] = pedidosAbiertos([...g.eventos, local('MesasSeparadas', g.p, { mesa_ids: [g.m2] })])
    expect(v?.estado.mesasUnidas).toEqual([])
  })

  it('una unión pendiente (sin conexión) ya se ve en la proyección', () => {
    const g = grupo()
    const [v] = pedidosAbiertos([
      ...g.eventos.slice(0, 1),
      local('MesasUnidas', g.p, { mesa_ids: [g.m2] }, 'pendiente'),
    ])
    expect(v?.estado.mesasUnidas).toEqual([g.m2])
    expect(v?.porConfirmar).toBe(true)
  })
})
