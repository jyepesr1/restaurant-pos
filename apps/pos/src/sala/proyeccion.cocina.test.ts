import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { type EstadoMesaDemo, estadoMesa, pedidosAbiertos } from './proyeccion'
import { datosItem, inOrder, local, opening } from './pruebas'

// El estado de la mesa en el plano con la cocina (ADR-015): tomando > listo > en cocina > servida.

const idDe = (l: ReturnType<typeof local>) => (l.event.data as { item_id: string }).item_id

/** Una mesa con un solo pedido: cada plato con el estado que se indique. */
function table(
  dishes: ('pending' | 'held' | 'sent' | 'preparando' | 'ready' | 'served' | 'voided')[],
  extra: ReturnType<typeof local>[] = [],
) {
  const p = newId()
  const events: ReturnType<typeof local>[] = [local('OrderOpened', p, opening)]
  if (dishes.includes('held')) events.push(local('CourseHeld', p, { course: 'dessert' }))
  const items = dishes.map((status) => ({
    status,
    ev: local('ItemAdded', p, datosItem({ course: status === 'held' ? 'dessert' : null })),
  }))
  events.push(...items.map((i) => i.ev))
  const ids = (e: string) => items.filter((i) => i.status === e).map((i) => idDe(i.ev))
  const enviados = items.filter((i) => !['pending', 'held'].includes(i.status))
  if (enviados.length)
    events.push(
      local('ItemsSent', p, {
        tickets: [
          {
            ticket_id: newId(),
            station_id: newId(),
            item_ids: enviados.map((i) => idDe(i.ev)),
          },
        ],
      }),
    )
  if (ids('preparando').length)
    events.push(local('ItemInPreparation', p, { item_ids: ids('preparando') }))
  if (ids('ready').length) events.push(local('ItemReady', p, { item_ids: ids('ready') }))
  if (ids('served').length) events.push(local('ItemServed', p, { item_ids: ids('served') }))
  if (ids('voided').length)
    for (const id of ids('voided'))
      events.push(
        local(
          'ItemVoided',
          p,
          { item_id: id, quantity: 1, already_prepared: false, ticket_id: null },
          'confirmed',
          {
            reason: 'x',
          },
        ),
      )
  return pedidosAbiertos(inOrder([...events, ...extra]))
}

describe('estadoMesa con la cocina', () => {
  it.each<[string[], EstadoMesaDemo]>([
    [[], 'free'],
    [['sent'], 'in_kitchen'],
    [['preparando'], 'in_kitchen'],
    [['ready'], 'ready'],
    [['served'], 'served'],
    [['voided'], 'free'],
    [['pending'], 'taking'],
    [['held'], 'taking'],
  ])('con %j la mesa está «%s»', (dishes, expected) => {
    expect(estadoMesa(table(dishes as never))).toBe(expected)
  })

  it.each<[string[], EstadoMesaDemo]>([
    // tomando manda sobre todo
    [['pending', 'ready'], 'taking'],
    [['pending', 'sent'], 'taking'],
    [['pending', 'served'], 'taking'],
    [['held', 'ready', 'served'], 'taking'],
    // listo manda sobre en cocina y servida
    [['ready', 'sent'], 'ready'],
    [['ready', 'preparando'], 'ready'],
    [['ready', 'served'], 'ready'],
    [['ready', 'sent', 'served'], 'ready'],
    // en cocina manda sobre servida
    [['sent', 'served'], 'in_kitchen'],
    [['preparando', 'served'], 'in_kitchen'],
    // lo anulado no cuenta
    [['voided', 'served'], 'served'],
    [['voided', 'ready'], 'ready'],
    [['voided', 'pending'], 'taking'],
    // todo entregado
    [['served', 'served'], 'served'],
  ])('con %j la mesa está «%s»', (dishes, expected) => {
    expect(estadoMesa(table(dishes as never))).toBe(expected)
  })

  it('devolver un plato entregado a la cola lo regresa a «en cocina»', () => {
    const p = newId()
    const a = local('ItemAdded', p, datosItem())
    const orders = pedidosAbiertos(
      inOrder([
        local('OrderOpened', p, opening),
        a,
        local('ItemsSent', p, {
          tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [idDe(a)] }],
        }),
        local('ItemServed', p, { item_ids: [idDe(a)] }),
      ]),
    )
    expect(estadoMesa(orders)).toBe('served')
    const another = pedidosAbiertos(
      inOrder([
        local('OrderOpened', p, opening),
        a,
        local('ItemsSent', p, {
          tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [idDe(a)] }],
        }),
        local('ItemServed', p, { item_ids: [idDe(a)] }),
        local('ItemReturnedToQueue', p, { item_ids: [idDe(a)] }),
      ]),
    )
    expect(estadoMesa(another)).toBe('in_kitchen')
  })

  it('con varios pedidos en la misma mesa gana el más urgente', () => {
    const [a, b, c] = [newId(), newId(), newId()]
    const itemA = local('ItemAdded', a, datosItem())
    const itemB = local('ItemAdded', b, datosItem())
    const itemC = local('ItemAdded', c, datosItem())
    const envio = (p: string, it: typeof itemA) =>
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [idDe(it)] }],
      })
    const all = pedidosAbiertos(
      inOrder([
        local('OrderOpened', a, opening),
        itemA,
        envio(a, itemA),
        local('ItemServed', a, { item_ids: [idDe(itemA)] }),
        local('OrderOpened', b, opening),
        itemB,
        envio(b, itemB),
        local('OrderOpened', c, opening),
        itemC,
        envio(c, itemC),
        local('ItemReady', c, { item_ids: [idDe(itemC)] }),
      ]),
    )
    const de = (...ids: string[]) => all.filter((x) => ids.includes(x.status.id))
    expect(estadoMesa(de(a))).toBe('served')
    expect(estadoMesa(de(a, b))).toBe('in_kitchen')
    expect(estadoMesa(de(a, b, c))).toBe('ready')
    expect(estadoMesa(de(a, c))).toBe('ready')
  })

  it('un plato listo marcado en un evento pendiente (sin confirmar) ya cuenta en el plano', () => {
    const p = newId()
    const a = local('ItemAdded', p, datosItem())
    const orders = pedidosAbiertos(
      inOrder([
        local('OrderOpened', p, opening),
        a,
        local('ItemsSent', p, {
          tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [idDe(a)] }],
        }),
        local('ItemReady', p, { item_ids: [idDe(a)] }, 'pending'),
      ]),
    )
    expect(estadoMesa(orders)).toBe('ready')
  })
})
