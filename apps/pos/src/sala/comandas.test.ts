import { newId } from '@pos/core'
import type { LocalEvent } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { type ComandaEnCocina, comandasEnCocina, demora, tiemposDe } from './comandas'
import { pedidosAbiertos } from './proyeccion'
import { datosItem, inOrder, local, opening, TIME } from './pruebas'

// «Pedidos en cocina» y la pantalla de cocina (ADR-015): lo enviado que falta entregar, calculado
// de los eventos guardados en el equipo, y qué tan demorado va.

const COCINA = newId()
const BARRA = newId()
const idDe = (l: LocalEvent) => (l.event.data as { item_id: string }).item_id

/** Un pedido abierto con eventos a voluntad; devuelve los eventos y lo que ve el equipo. */
function build(construct: (p: string) => LocalEvent[]) {
  const p = newId()
  const locals = inOrder([local('OrderOpened', p, opening), ...construct(p)])
  return { p, locals, orders: pedidosAbiertos(locals) }
}

const envio = (
  p: string,
  tickets: { ids: string[]; station?: string; ticket?: string }[],
  status: 'confirmed' | 'pending' = 'confirmed',
) =>
  local(
    'ItemsSent',
    p,
    {
      tickets: tickets.map((c) => ({
        ticket_id: c.ticket ?? newId(),
        station_id: c.station ?? COCINA,
        item_ids: c.ids,
      })),
    },
    status,
  )

/** El evento con el número de comanda que dio el hub. */
const conNumeros = (l: LocalEvent, numbers: Record<string, number>): LocalEvent => ({
  ...l,
  event: { ...l.event, assignments: { ticket_numbers: numbers } } as never,
})
const receivedAt = (l: LocalEvent, time: string): LocalEvent => ({
  ...l,
  event: { ...l.event, received_at: time } as never,
})

const resumen = (c: ComandaEnCocina[]) =>
  c.map((x) => ({ n: x.number, items: x.items.map((i) => i.name), list: x.list }))

describe('comandasEnCocina', () => {
  it('sin eventos o sin pedidos abiertos no hay nada', () => {
    expect(comandasEnCocina([], [])).toEqual([])
    const { locals } = build((p) => [local('ItemAdded', p, datosItem())])
    expect(comandasEnCocina(locals, [])).toEqual([])
  })

  it('lo que aún no se envió no está en cocina', () => {
    const { locals, orders } = build((p) => [local('ItemAdded', p, datosItem())])
    expect(comandasEnCocina(locals, orders)).toEqual([])
  })

  it('una comanda enviada aparece con su número, su estación y lo que falta entregar', () => {
    const ticket = newId()
    const { p, locals, orders } = build((p) => {
      const a = local('ItemAdded', p, datosItem({ name: 'Tagliata' }))
      const b = local('ItemAdded', p, datosItem({ name: 'Risotto' }))
      return [a, b, conNumeros(envio(p, [{ ids: [idDe(a), idDe(b)], ticket }]), { [ticket]: 7 })]
    })
    const r = comandasEnCocina(locals, orders)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      comandaId: ticket,
      stationId: COCINA,
      number: 7,
      enviadaEn: TIME,
      list: false,
    })
    expect(r[0]?.order.status.id).toBe(p)
    expect(resumen(r)).toEqual([{ n: 7, items: ['Tagliata', 'Risotto'], list: false }])
  })

  it('la comanda sale cuando se entrega todo lo suyo', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, datosItem())
      const b = local('ItemAdded', p, datosItem())
      return [
        a,
        b,
        envio(p, [{ ids: [idDe(a), idDe(b)] }]),
        local('ItemServed', p, { item_ids: [idDe(a), idDe(b)] }),
      ]
    })
    expect(comandasEnCocina(locals, orders)).toEqual([])
  })

  it('con entregas parciales solo quedan los que faltan, y «lista» mira solo esos', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, datosItem({ name: 'Entregado' }))
      const b = local('ItemAdded', p, datosItem({ name: 'Listo' }))
      const c = local('ItemAdded', p, datosItem({ name: 'Enviado' }))
      return [
        a,
        b,
        c,
        envio(p, [{ ids: [idDe(a), idDe(b), idDe(c)] }]),
        local('ItemServed', p, { item_ids: [idDe(a)] }),
        local('ItemReady', p, { item_ids: [idDe(b)] }),
      ]
    })
    expect(resumen(comandasEnCocina(locals, orders))).toEqual([
      { n: null, items: ['Listo', 'Enviado'], list: false },
    ])
  })

  it('«lista» es verdadero solo cuando todo lo que falta ya está listo', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, datosItem({ name: 'A' }))
      const b = local('ItemAdded', p, datosItem({ name: 'B' }))
      return [
        a,
        b,
        envio(p, [{ ids: [idDe(a), idDe(b)] }]),
        local('ItemReady', p, { item_ids: [idDe(a), idDe(b)] }),
      ]
    })
    expect(comandasEnCocina(locals, orders)[0]?.list).toBe(true)
  })

  it('lo entregado y lo listo se mezclan: si solo queda lo listo, la comanda está lista', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, datosItem({ name: 'A' }))
      const b = local('ItemAdded', p, datosItem({ name: 'B' }))
      return [
        a,
        b,
        envio(p, [{ ids: [idDe(a), idDe(b)] }]),
        local('ItemServed', p, { item_ids: [idDe(a)] }),
        local('ItemReady', p, { item_ids: [idDe(b)] }),
      ]
    })
    expect(resumen(comandasEnCocina(locals, orders))).toEqual([
      { n: null, items: ['B'], list: true },
    ])
  })

  it('un plato en preparación sigue en cocina y no está listo', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, datosItem())
      return [
        a,
        envio(p, [{ ids: [idDe(a)] }]),
        local('ItemInPreparation', p, { item_ids: [idDe(a)] }),
      ]
    })
    const r = comandasEnCocina(locals, orders)
    expect(r).toHaveLength(1)
    expect(r[0]?.list).toBe(false)
  })

  it('lo que se devuelve a la cola vuelve a cocina', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, datosItem())
      return [
        a,
        envio(p, [{ ids: [idDe(a)] }]),
        local('ItemServed', p, { item_ids: [idDe(a)] }),
        local('ItemReturnedToQueue', p, { item_ids: [idDe(a)] }),
      ]
    })
    expect(comandasEnCocina(locals, orders)).toHaveLength(1)
  })

  describe('anulaciones parciales', () => {
    it('anular unas unidades deja el plato en cocina; anular todas lo saca', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'Pizza', quantity: 3 }))
        const b = local('ItemAdded', p, datosItem({ name: 'Pasta' }))
        return [
          a,
          b,
          envio(p, [{ ids: [idDe(a), idDe(b)] }]),
          local(
            'ItemVoided',
            p,
            { item_id: idDe(a), quantity: 1, already_prepared: false, ticket_id: null },
            'confirmed',
            {
              reason: 'se arrepintió',
            },
          ),
        ]
      })
      expect(resumen(comandasEnCocina(locals, orders))[0]?.items).toEqual(['Pizza', 'Pasta'])
      const pizza = comandasEnCocina(locals, orders)[0]?.items[0]
      expect(pizza).toMatchObject({ quantity: 3, voidedQuantity: 1 })

      const everything = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'Pizza', quantity: 3 }))
        const b = local('ItemAdded', p, datosItem({ name: 'Pasta' }))
        return [
          a,
          b,
          envio(p, [{ ids: [idDe(a), idDe(b)] }]),
          local(
            'ItemVoided',
            p,
            { item_id: idDe(a), quantity: 3, already_prepared: false, ticket_id: null },
            'confirmed',
            {
              reason: 'se arrepintió',
            },
          ),
        ]
      })
      expect(resumen(comandasEnCocina(everything.locals, everything.orders))[0]?.items).toEqual([
        'Pasta',
      ])
    })

    it('si se anula todo lo de la comanda, la comanda desaparece', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, datosItem())
        return [
          a,
          envio(p, [{ ids: [idDe(a)] }]),
          local(
            'ItemVoided',
            p,
            { item_id: idDe(a), quantity: 1, already_prepared: false, ticket_id: null },
            'confirmed',
            {
              reason: 'x',
            },
          ),
        ]
      })
      expect(comandasEnCocina(locals, orders)).toEqual([])
    })
  })

  describe('eventos que el hub aún no confirmó', () => {
    it('un envío pendiente ya cuenta, sin número, y con la hora estimada del hub', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'Tagliata' }))
        return [a, envio(p, [{ ids: [idDe(a)] }], 'pending')]
      })
      const r = comandasEnCocina(locals, orders)
      expect(resumen(r)).toEqual([{ n: null, items: ['Tagliata'], list: false }])
      expect(r[0]?.enviadaEn).toBe(TIME)
    })

    it('al confirmarse toma el número y la hora en que lo recibió el hub', () => {
      const ticket = newId()
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, datosItem())
        return [
          a,
          receivedAt(
            conNumeros(envio(p, [{ ids: [idDe(a)], ticket }]), { [ticket]: 4 }),
            '2026-10-24T15:03:00.000Z',
          ),
        ]
      })
      expect(comandasEnCocina(locals, orders)[0]).toMatchObject({
        number: 4,
        enviadaEn: '2026-10-24T15:03:00.000Z',
      })
    })

    it('un envío rechazado o en cuarentena no aparece', () => {
      for (const status of ['rejected', 'quarantine'] as const) {
        const { locals, orders } = build((p) => {
          const a = local('ItemAdded', p, datosItem())
          return [a, { ...envio(p, [{ ids: [idDe(a)] }]), status }]
        })
        expect(comandasEnCocina(locals, orders)).toEqual([])
      }
    })

    it('si el número de otra comanda llega, no se le asigna a la equivocada', () => {
      const [c1, c2] = [newId(), newId()]
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'A' }))
        const b = local('ItemAdded', p, datosItem({ name: 'B' }))
        return [
          a,
          b,
          conNumeros(
            envio(p, [
              { ids: [idDe(a)], ticket: c1 },
              { ids: [idDe(b)], ticket: c2, station: BARRA },
            ]),
            { [c2]: 9 },
          ),
        ]
      })
      expect(resumen(comandasEnCocina(locals, orders))).toEqual([
        { n: null, items: ['A'], list: false },
        { n: 9, items: ['B'], list: false },
      ])
    })
  })

  describe('varias comandas', () => {
    it('un envío con dos estaciones da dos comandas del mismo pedido', () => {
      const { p, locals, orders } = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'Plato' }))
        const b = local('ItemAdded', p, datosItem({ name: 'Trago' }))
        return [a, b, envio(p, [{ ids: [idDe(a)] }, { ids: [idDe(b)], station: BARRA }])]
      })
      const r = comandasEnCocina(locals, orders)
      expect(r.map((c) => c.stationId)).toEqual([COCINA, BARRA])
      expect(r.every((c) => c.order.status.id === p)).toBe(true)
      expect(r[0]?.comandaId).not.toBe(r[1]?.comandaId)
    })

    it('envíos en momentos distintos de varios pedidos salen del más viejo al más nuevo', () => {
      const one = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'Tarde' }))
        return [a, receivedAt(envio(p, [{ ids: [idDe(a)] }]), '2026-10-24T15:30:00.000Z')]
      })
      const two = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'Temprano' }))
        return [a, receivedAt(envio(p, [{ ids: [idDe(a)] }]), '2026-10-24T15:05:00.000Z')]
      })
      const all = [...one.locals, ...two.locals]
      const orders = pedidosAbiertos(inOrder(all))
      const r = comandasEnCocina(all, orders)
      expect(r.flatMap((c) => c.items.map((i) => i.name))).toEqual(['Temprano', 'Tarde'])
    })

    it('dos envíos del mismo pedido (más platos después) son dos comandas', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'Primero' }))
        const b = local('ItemAdded', p, datosItem({ name: 'Segundo' }))
        return [
          a,
          envio(p, [{ ids: [idDe(a)] }]),
          b,
          receivedAt(envio(p, [{ ids: [idDe(b)] }]), '2026-10-24T15:10:00.000Z'),
        ]
      })
      expect(resumen(comandasEnCocina(locals, orders)).map((c) => c.items[0])).toEqual([
        'Primero',
        'Segundo',
      ])
    })

    it('los platos de una comanda salen en el orden en que se pidieron', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'Uno' }))
        const b = local('ItemAdded', p, datosItem({ name: 'Dos' }))
        const c = local('ItemAdded', p, datosItem({ name: 'Tres' }))
        return [a, b, c, envio(p, [{ ids: [idDe(c), idDe(a), idDe(b)] }])]
      })
      expect(comandasEnCocina(locals, orders)[0]?.items.map((i) => i.name)).toEqual([
        'Uno',
        'Dos',
        'Tres',
      ])
    })

    it('una comanda con un ítem que ya no existe en el pedido ignora ese ítem', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, datosItem({ name: 'Real' }))
        return [a, envio(p, [{ ids: [idDe(a), newId()] }])]
      })
      expect(comandasEnCocina(locals, orders)[0]?.items.map((i) => i.name)).toEqual(['Real'])
    })

    it('un pedido cerrado o cancelado ya no aparece en cocina', () => {
      const { p, locals } = build((p) => {
        const a = local('ItemAdded', p, datosItem())
        return [a, envio(p, [{ ids: [idDe(a)] }])]
      })
      const canceled = inOrder([
        ...locals,
        local('OrderCanceled', p, {}, 'confirmed', { reason: 'error' }),
      ])
      const orders = pedidosAbiertos(canceled)
      expect(orders).toEqual([])
      expect(comandasEnCocina(canceled, orders)).toEqual([])
    })
  })
})

describe('demora', () => {
  const tiempos = { amarillo: 10, rojo: 20 }
  const sent = '2026-10-24T15:00:00.000Z'
  const t0 = Date.parse(sent)
  const min = 60_000

  it.each([
    [0, 'on_time'],
    [1, 'on_time'],
    [9 * min + 59_999, 'on_time'],
    [10 * min - 1, 'on_time'],
    [10 * min, 'late'],
    [10 * min + 1, 'late'],
    [19 * min + 59_999, 'late'],
    [20 * min - 1, 'late'],
    [20 * min, 'very_late'],
    [20 * min + 1, 'very_late'],
    [3 * 60 * min, 'very_late'],
  ])('a los %i ms de enviada va «%s» (ámbar 10, rojo 20)', (ms, expected) => {
    expect(demora(sent, t0 + ms, tiempos)).toBe(expected)
  })

  it('con el reloj del equipo atrasado (la hora de envío está en el futuro) va a tiempo', () => {
    expect(demora(sent, t0 - 5 * min, tiempos)).toBe('on_time')
    expect(demora(sent, t0 - 24 * 60 * min, tiempos)).toBe('on_time')
  })

  it('respeta los tiempos del local', () => {
    expect(demora(sent, t0 + 3 * min, { amarillo: 3, rojo: 6 })).toBe('late')
    expect(demora(sent, t0 + 6 * min, { amarillo: 3, rojo: 6 })).toBe('very_late')
    expect(demora(sent, t0 + 5 * min, { amarillo: 15, rojo: 30 })).toBe('on_time')
  })

  it('si el rojo y el ámbar coinciden, gana el rojo', () => {
    expect(demora(sent, t0 + 7 * min, { amarillo: 7, rojo: 7 })).toBe('very_late')
  })

  it('una hora ilegible no marca alarma falsa', () => {
    expect(demora('no es una fecha', t0, tiempos)).toBe('on_time')
    expect(demora('', t0, tiempos)).toBe('on_time')
  })

  it('con minutos con decimales (ámbar 0.5) también compara bien', () => {
    expect(demora(sent, t0 + 29_999, { amarillo: 0.5, rojo: 1 })).toBe('on_time')
    expect(demora(sent, t0 + 30_000, { amarillo: 0.5, rojo: 1 })).toBe('late')
  })
})

describe('tiemposDe', () => {
  it('usa los del restaurante', () => {
    expect(tiemposDe({ kitchenYellowMin: 5, kitchenRedMin: 12 })).toEqual({
      amarillo: 5,
      rojo: 12,
    })
  })

  it('un hub de antes de la 1.4 (sin los campos) usa 10 y 20', () => {
    expect(tiemposDe({})).toEqual({ amarillo: 10, rojo: 20 })
  })

  it('si solo viene uno, el otro es el de fábrica', () => {
    expect(tiemposDe({ kitchenYellowMin: 4 })).toEqual({ amarillo: 4, rojo: 20 })
    expect(tiemposDe({ kitchenRedMin: 40 })).toEqual({ amarillo: 10, rojo: 40 })
  })
})
