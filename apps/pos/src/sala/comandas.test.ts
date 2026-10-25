import { nuevoId } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { type ComandaEnCocina, comandasEnCocina, demora, tiemposDe } from './comandas'
import { pedidosAbiertos } from './proyeccion'
import { apertura, datosItem, enOrden, HORA, local } from './pruebas'

// «Pedidos en cocina» y la pantalla de cocina (ADR-015): lo enviado que falta entregar, calculado
// de los eventos guardados en el equipo, y qué tan demorado va.

const COCINA = nuevoId()
const BARRA = nuevoId()
const idDe = (l: EventoLocal) => (l.evento.datos as { item_id: string }).item_id

/** Un pedido abierto con eventos a voluntad; devuelve los eventos y lo que ve el equipo. */
function armar(construir: (p: string) => EventoLocal[]) {
  const p = nuevoId()
  const locales = enOrden([local('PedidoAbierto', p, apertura), ...construir(p)])
  return { p, locales, pedidos: pedidosAbiertos(locales) }
}

const envio = (
  p: string,
  comandas: { ids: string[]; estacion?: string; comanda?: string }[],
  estado: 'confirmado' | 'pendiente' = 'confirmado',
) =>
  local(
    'ItemsEnviados',
    p,
    {
      comandas: comandas.map((c) => ({
        comanda_id: c.comanda ?? nuevoId(),
        estacion_id: c.estacion ?? COCINA,
        item_ids: c.ids,
      })),
    },
    estado,
  )

/** El evento con el número de comanda que dio el hub. */
const conNumeros = (l: EventoLocal, numeros: Record<string, number>): EventoLocal => ({
  ...l,
  evento: { ...l.evento, asignaciones: { numeros_comanda: numeros } } as never,
})
const recibidoEn = (l: EventoLocal, hora: string): EventoLocal => ({
  ...l,
  evento: { ...l.evento, recibido_en: hora } as never,
})

const resumen = (c: ComandaEnCocina[]) =>
  c.map((x) => ({ n: x.numero, items: x.items.map((i) => i.nombre), lista: x.lista }))

describe('comandasEnCocina', () => {
  it('sin eventos o sin pedidos abiertos no hay nada', () => {
    expect(comandasEnCocina([], [])).toEqual([])
    const { locales } = armar((p) => [local('ItemAgregado', p, datosItem())])
    expect(comandasEnCocina(locales, [])).toEqual([])
  })

  it('lo que aún no se envió no está en cocina', () => {
    const { locales, pedidos } = armar((p) => [local('ItemAgregado', p, datosItem())])
    expect(comandasEnCocina(locales, pedidos)).toEqual([])
  })

  it('una comanda enviada aparece con su número, su estación y lo que falta entregar', () => {
    const comanda = nuevoId()
    const { p, locales, pedidos } = armar((p) => {
      const a = local('ItemAgregado', p, datosItem({ nombre: 'Tagliata' }))
      const b = local('ItemAgregado', p, datosItem({ nombre: 'Risotto' }))
      return [a, b, conNumeros(envio(p, [{ ids: [idDe(a), idDe(b)], comanda }]), { [comanda]: 7 })]
    })
    const r = comandasEnCocina(locales, pedidos)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      comandaId: comanda,
      estacionId: COCINA,
      numero: 7,
      enviadaEn: HORA,
      lista: false,
    })
    expect(r[0]?.pedido.estado.id).toBe(p)
    expect(resumen(r)).toEqual([{ n: 7, items: ['Tagliata', 'Risotto'], lista: false }])
  })

  it('la comanda sale cuando se entrega todo lo suyo', () => {
    const { locales, pedidos } = armar((p) => {
      const a = local('ItemAgregado', p, datosItem())
      const b = local('ItemAgregado', p, datosItem())
      return [
        a,
        b,
        envio(p, [{ ids: [idDe(a), idDe(b)] }]),
        local('ItemEntregado', p, { item_ids: [idDe(a), idDe(b)] }),
      ]
    })
    expect(comandasEnCocina(locales, pedidos)).toEqual([])
  })

  it('con entregas parciales solo quedan los que faltan, y «lista» mira solo esos', () => {
    const { locales, pedidos } = armar((p) => {
      const a = local('ItemAgregado', p, datosItem({ nombre: 'Entregado' }))
      const b = local('ItemAgregado', p, datosItem({ nombre: 'Listo' }))
      const c = local('ItemAgregado', p, datosItem({ nombre: 'Enviado' }))
      return [
        a,
        b,
        c,
        envio(p, [{ ids: [idDe(a), idDe(b), idDe(c)] }]),
        local('ItemEntregado', p, { item_ids: [idDe(a)] }),
        local('ItemListo', p, { item_ids: [idDe(b)] }),
      ]
    })
    expect(resumen(comandasEnCocina(locales, pedidos))).toEqual([
      { n: null, items: ['Listo', 'Enviado'], lista: false },
    ])
  })

  it('«lista» es verdadero solo cuando todo lo que falta ya está listo', () => {
    const { locales, pedidos } = armar((p) => {
      const a = local('ItemAgregado', p, datosItem({ nombre: 'A' }))
      const b = local('ItemAgregado', p, datosItem({ nombre: 'B' }))
      return [
        a,
        b,
        envio(p, [{ ids: [idDe(a), idDe(b)] }]),
        local('ItemListo', p, { item_ids: [idDe(a), idDe(b)] }),
      ]
    })
    expect(comandasEnCocina(locales, pedidos)[0]?.lista).toBe(true)
  })

  it('lo entregado y lo listo se mezclan: si solo queda lo listo, la comanda está lista', () => {
    const { locales, pedidos } = armar((p) => {
      const a = local('ItemAgregado', p, datosItem({ nombre: 'A' }))
      const b = local('ItemAgregado', p, datosItem({ nombre: 'B' }))
      return [
        a,
        b,
        envio(p, [{ ids: [idDe(a), idDe(b)] }]),
        local('ItemEntregado', p, { item_ids: [idDe(a)] }),
        local('ItemListo', p, { item_ids: [idDe(b)] }),
      ]
    })
    expect(resumen(comandasEnCocina(locales, pedidos))).toEqual([
      { n: null, items: ['B'], lista: true },
    ])
  })

  it('un plato en preparación sigue en cocina y no está listo', () => {
    const { locales, pedidos } = armar((p) => {
      const a = local('ItemAgregado', p, datosItem())
      return [
        a,
        envio(p, [{ ids: [idDe(a)] }]),
        local('ItemEnPreparacion', p, { item_ids: [idDe(a)] }),
      ]
    })
    const r = comandasEnCocina(locales, pedidos)
    expect(r).toHaveLength(1)
    expect(r[0]?.lista).toBe(false)
  })

  it('lo que se devuelve a la cola vuelve a cocina', () => {
    const { locales, pedidos } = armar((p) => {
      const a = local('ItemAgregado', p, datosItem())
      return [
        a,
        envio(p, [{ ids: [idDe(a)] }]),
        local('ItemEntregado', p, { item_ids: [idDe(a)] }),
        local('ItemDevueltoACola', p, { item_ids: [idDe(a)] }),
      ]
    })
    expect(comandasEnCocina(locales, pedidos)).toHaveLength(1)
  })

  describe('anulaciones parciales', () => {
    it('anular unas unidades deja el plato en cocina; anular todas lo saca', () => {
      const { locales, pedidos } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'Pizza', cantidad: 3 }))
        const b = local('ItemAgregado', p, datosItem({ nombre: 'Pasta' }))
        return [
          a,
          b,
          envio(p, [{ ids: [idDe(a), idDe(b)] }]),
          local(
            'ItemAnulado',
            p,
            { item_id: idDe(a), cantidad: 1, ya_preparado: false, comanda_id: null },
            'confirmado',
            {
              motivo: 'se arrepintió',
            },
          ),
        ]
      })
      expect(resumen(comandasEnCocina(locales, pedidos))[0]?.items).toEqual(['Pizza', 'Pasta'])
      const pizza = comandasEnCocina(locales, pedidos)[0]?.items[0]
      expect(pizza).toMatchObject({ cantidad: 3, cantidadAnulada: 1 })

      const todo = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'Pizza', cantidad: 3 }))
        const b = local('ItemAgregado', p, datosItem({ nombre: 'Pasta' }))
        return [
          a,
          b,
          envio(p, [{ ids: [idDe(a), idDe(b)] }]),
          local(
            'ItemAnulado',
            p,
            { item_id: idDe(a), cantidad: 3, ya_preparado: false, comanda_id: null },
            'confirmado',
            {
              motivo: 'se arrepintió',
            },
          ),
        ]
      })
      expect(resumen(comandasEnCocina(todo.locales, todo.pedidos))[0]?.items).toEqual(['Pasta'])
    })

    it('si se anula todo lo de la comanda, la comanda desaparece', () => {
      const { locales, pedidos } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem())
        return [
          a,
          envio(p, [{ ids: [idDe(a)] }]),
          local(
            'ItemAnulado',
            p,
            { item_id: idDe(a), cantidad: 1, ya_preparado: false, comanda_id: null },
            'confirmado',
            {
              motivo: 'x',
            },
          ),
        ]
      })
      expect(comandasEnCocina(locales, pedidos)).toEqual([])
    })
  })

  describe('eventos que el hub aún no confirmó', () => {
    it('un envío pendiente ya cuenta, sin número, y con la hora estimada del hub', () => {
      const { locales, pedidos } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'Tagliata' }))
        return [a, envio(p, [{ ids: [idDe(a)] }], 'pendiente')]
      })
      const r = comandasEnCocina(locales, pedidos)
      expect(resumen(r)).toEqual([{ n: null, items: ['Tagliata'], lista: false }])
      expect(r[0]?.enviadaEn).toBe(HORA)
    })

    it('al confirmarse toma el número y la hora en que lo recibió el hub', () => {
      const comanda = nuevoId()
      const { locales, pedidos } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem())
        return [
          a,
          recibidoEn(
            conNumeros(envio(p, [{ ids: [idDe(a)], comanda }]), { [comanda]: 4 }),
            '2026-10-24T15:03:00.000Z',
          ),
        ]
      })
      expect(comandasEnCocina(locales, pedidos)[0]).toMatchObject({
        numero: 4,
        enviadaEn: '2026-10-24T15:03:00.000Z',
      })
    })

    it('un envío rechazado o en cuarentena no aparece', () => {
      for (const estado of ['rechazado', 'cuarentena'] as const) {
        const { locales, pedidos } = armar((p) => {
          const a = local('ItemAgregado', p, datosItem())
          return [a, { ...envio(p, [{ ids: [idDe(a)] }]), estado }]
        })
        expect(comandasEnCocina(locales, pedidos)).toEqual([])
      }
    })

    it('si el número de otra comanda llega, no se le asigna a la equivocada', () => {
      const [c1, c2] = [nuevoId(), nuevoId()]
      const { locales, pedidos } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'A' }))
        const b = local('ItemAgregado', p, datosItem({ nombre: 'B' }))
        return [
          a,
          b,
          conNumeros(
            envio(p, [
              { ids: [idDe(a)], comanda: c1 },
              { ids: [idDe(b)], comanda: c2, estacion: BARRA },
            ]),
            { [c2]: 9 },
          ),
        ]
      })
      expect(resumen(comandasEnCocina(locales, pedidos))).toEqual([
        { n: null, items: ['A'], lista: false },
        { n: 9, items: ['B'], lista: false },
      ])
    })
  })

  describe('varias comandas', () => {
    it('un envío con dos estaciones da dos comandas del mismo pedido', () => {
      const { p, locales, pedidos } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'Plato' }))
        const b = local('ItemAgregado', p, datosItem({ nombre: 'Trago' }))
        return [a, b, envio(p, [{ ids: [idDe(a)] }, { ids: [idDe(b)], estacion: BARRA }])]
      })
      const r = comandasEnCocina(locales, pedidos)
      expect(r.map((c) => c.estacionId)).toEqual([COCINA, BARRA])
      expect(r.every((c) => c.pedido.estado.id === p)).toBe(true)
      expect(r[0]?.comandaId).not.toBe(r[1]?.comandaId)
    })

    it('envíos en momentos distintos de varios pedidos salen del más viejo al más nuevo', () => {
      const uno = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'Tarde' }))
        return [a, recibidoEn(envio(p, [{ ids: [idDe(a)] }]), '2026-10-24T15:30:00.000Z')]
      })
      const dos = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'Temprano' }))
        return [a, recibidoEn(envio(p, [{ ids: [idDe(a)] }]), '2026-10-24T15:05:00.000Z')]
      })
      const todos = [...uno.locales, ...dos.locales]
      const pedidos = pedidosAbiertos(enOrden(todos))
      const r = comandasEnCocina(todos, pedidos)
      expect(r.flatMap((c) => c.items.map((i) => i.nombre))).toEqual(['Temprano', 'Tarde'])
    })

    it('dos envíos del mismo pedido (más platos después) son dos comandas', () => {
      const { locales, pedidos } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'Primero' }))
        const b = local('ItemAgregado', p, datosItem({ nombre: 'Segundo' }))
        return [
          a,
          envio(p, [{ ids: [idDe(a)] }]),
          b,
          recibidoEn(envio(p, [{ ids: [idDe(b)] }]), '2026-10-24T15:10:00.000Z'),
        ]
      })
      expect(resumen(comandasEnCocina(locales, pedidos)).map((c) => c.items[0])).toEqual([
        'Primero',
        'Segundo',
      ])
    })

    it('los platos de una comanda salen en el orden en que se pidieron', () => {
      const { locales, pedidos } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'Uno' }))
        const b = local('ItemAgregado', p, datosItem({ nombre: 'Dos' }))
        const c = local('ItemAgregado', p, datosItem({ nombre: 'Tres' }))
        return [a, b, c, envio(p, [{ ids: [idDe(c), idDe(a), idDe(b)] }])]
      })
      expect(comandasEnCocina(locales, pedidos)[0]?.items.map((i) => i.nombre)).toEqual([
        'Uno',
        'Dos',
        'Tres',
      ])
    })

    it('una comanda con un ítem que ya no existe en el pedido ignora ese ítem', () => {
      const { locales, pedidos } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem({ nombre: 'Real' }))
        return [a, envio(p, [{ ids: [idDe(a), nuevoId()] }])]
      })
      expect(comandasEnCocina(locales, pedidos)[0]?.items.map((i) => i.nombre)).toEqual(['Real'])
    })

    it('un pedido cerrado o cancelado ya no aparece en cocina', () => {
      const { p, locales } = armar((p) => {
        const a = local('ItemAgregado', p, datosItem())
        return [a, envio(p, [{ ids: [idDe(a)] }])]
      })
      const cancelado = enOrden([
        ...locales,
        local('PedidoCancelado', p, {}, 'confirmado', { motivo: 'error' }),
      ])
      const pedidos = pedidosAbiertos(cancelado)
      expect(pedidos).toEqual([])
      expect(comandasEnCocina(cancelado, pedidos)).toEqual([])
    })
  })
})

describe('demora', () => {
  const tiempos = { amarillo: 10, rojo: 20 }
  const enviada = '2026-10-24T15:00:00.000Z'
  const t0 = Date.parse(enviada)
  const min = 60_000

  it.each([
    [0, 'a_tiempo'],
    [1, 'a_tiempo'],
    [9 * min + 59_999, 'a_tiempo'],
    [10 * min - 1, 'a_tiempo'],
    [10 * min, 'demorada'],
    [10 * min + 1, 'demorada'],
    [19 * min + 59_999, 'demorada'],
    [20 * min - 1, 'demorada'],
    [20 * min, 'muy_demorada'],
    [20 * min + 1, 'muy_demorada'],
    [3 * 60 * min, 'muy_demorada'],
  ])('a los %i ms de enviada va «%s» (ámbar 10, rojo 20)', (ms, esperado) => {
    expect(demora(enviada, t0 + ms, tiempos)).toBe(esperado)
  })

  it('con el reloj del equipo atrasado (la hora de envío está en el futuro) va a tiempo', () => {
    expect(demora(enviada, t0 - 5 * min, tiempos)).toBe('a_tiempo')
    expect(demora(enviada, t0 - 24 * 60 * min, tiempos)).toBe('a_tiempo')
  })

  it('respeta los tiempos del local', () => {
    expect(demora(enviada, t0 + 3 * min, { amarillo: 3, rojo: 6 })).toBe('demorada')
    expect(demora(enviada, t0 + 6 * min, { amarillo: 3, rojo: 6 })).toBe('muy_demorada')
    expect(demora(enviada, t0 + 5 * min, { amarillo: 15, rojo: 30 })).toBe('a_tiempo')
  })

  it('si el rojo y el ámbar coinciden, gana el rojo', () => {
    expect(demora(enviada, t0 + 7 * min, { amarillo: 7, rojo: 7 })).toBe('muy_demorada')
  })

  it('una hora ilegible no marca alarma falsa', () => {
    expect(demora('no es una fecha', t0, tiempos)).toBe('a_tiempo')
    expect(demora('', t0, tiempos)).toBe('a_tiempo')
  })

  it('con minutos con decimales (ámbar 0.5) también compara bien', () => {
    expect(demora(enviada, t0 + 29_999, { amarillo: 0.5, rojo: 1 })).toBe('a_tiempo')
    expect(demora(enviada, t0 + 30_000, { amarillo: 0.5, rojo: 1 })).toBe('demorada')
  })
})

describe('tiemposDe', () => {
  it('usa los del restaurante', () => {
    expect(tiemposDe({ cocinaAmarilloMin: 5, cocinaRojoMin: 12 })).toEqual({
      amarillo: 5,
      rojo: 12,
    })
  })

  it('un hub de antes de la 1.4 (sin los campos) usa 10 y 20', () => {
    expect(tiemposDe({})).toEqual({ amarillo: 10, rojo: 20 })
  })

  it('si solo viene uno, el otro es el de fábrica', () => {
    expect(tiemposDe({ cocinaAmarilloMin: 4 })).toEqual({ amarillo: 4, rojo: 20 })
    expect(tiemposDe({ cocinaRojoMin: 40 })).toEqual({ amarillo: 10, rojo: 40 })
  })
})
