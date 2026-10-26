import { newId } from '@pos/core'
import type { LocalEvent } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { openOrders } from './projection'
import { inOrder, itemData, local, opening, TIME } from './testing'
import { delay, type KitchenTicket, kitchenTickets, timersOf } from './tickets'

// «Pedidos en cocina» and the kitchen screen (ADR-015): what was sent and is still to be delivered,
// computed from the events saved on the device, and how late it is.

const KITCHEN = newId()
const BAR = newId()
const idOf = (l: LocalEvent) => (l.event.data as { item_id: string }).item_id

/** An open order with any events; returns the events and what the device sees. */
function build(construct: (p: string) => LocalEvent[]) {
  const p = newId()
  const locals = inOrder([local('OrderOpened', p, opening), ...construct(p)])
  return { p, locals, orders: openOrders(locals) }
}

const submission = (
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
        station_id: c.station ?? KITCHEN,
        item_ids: c.ids,
      })),
    },
    status,
  )

/** The event with the ticket number the hub assigned. */
const withNumbers = (l: LocalEvent, numbers: Record<string, number>): LocalEvent => ({
  ...l,
  event: { ...l.event, assignments: { ticket_numbers: numbers } } as never,
})
const receivedAt = (l: LocalEvent, time: string): LocalEvent => ({
  ...l,
  event: { ...l.event, received_at: time } as never,
})

const summary = (c: KitchenTicket[]) =>
  c.map((x) => ({ n: x.number, items: x.items.map((i) => i.name), list: x.list }))

describe('kitchenTickets', () => {
  it('with no events or no open orders there is nothing', () => {
    expect(kitchenTickets([], [])).toEqual([])
    const { locals } = build((p) => [local('ItemAdded', p, itemData())])
    expect(kitchenTickets(locals, [])).toEqual([])
  })

  it('what has not been sent yet is not in the kitchen', () => {
    const { locals, orders } = build((p) => [local('ItemAdded', p, itemData())])
    expect(kitchenTickets(locals, orders)).toEqual([])
  })

  it('a sent ticket shows with its number, its station and what is still to be delivered', () => {
    const ticket = newId()
    const { p, locals, orders } = build((p) => {
      const a = local('ItemAdded', p, itemData({ name: 'Tagliata' }))
      const b = local('ItemAdded', p, itemData({ name: 'Risotto' }))
      return [
        a,
        b,
        withNumbers(submission(p, [{ ids: [idOf(a), idOf(b)], ticket }]), { [ticket]: 7 }),
      ]
    })
    const r = kitchenTickets(locals, orders)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      ticketId: ticket,
      stationId: KITCHEN,
      number: 7,
      sentAt: TIME,
      list: false,
    })
    expect(r[0]?.order.status.id).toBe(p)
    expect(summary(r)).toEqual([{ n: 7, items: ['Tagliata', 'Risotto'], list: false }])
  })

  it('the ticket leaves when all of its items are delivered', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, itemData())
      const b = local('ItemAdded', p, itemData())
      return [
        a,
        b,
        submission(p, [{ ids: [idOf(a), idOf(b)] }]),
        local('ItemServed', p, { item_ids: [idOf(a), idOf(b)] }),
      ]
    })
    expect(kitchenTickets(locals, orders)).toEqual([])
  })

  it('with partial deliveries only the missing ones remain, and «ready» looks only at those', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, itemData({ name: 'Entregado' }))
      const b = local('ItemAdded', p, itemData({ name: 'Listo' }))
      const c = local('ItemAdded', p, itemData({ name: 'Enviado' }))
      return [
        a,
        b,
        c,
        submission(p, [{ ids: [idOf(a), idOf(b), idOf(c)] }]),
        local('ItemServed', p, { item_ids: [idOf(a)] }),
        local('ItemReady', p, { item_ids: [idOf(b)] }),
      ]
    })
    expect(summary(kitchenTickets(locals, orders))).toEqual([
      { n: null, items: ['Listo', 'Enviado'], list: false },
    ])
  })

  it('«ready» is true only when everything still missing is ready', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, itemData({ name: 'A' }))
      const b = local('ItemAdded', p, itemData({ name: 'B' }))
      return [
        a,
        b,
        submission(p, [{ ids: [idOf(a), idOf(b)] }]),
        local('ItemReady', p, { item_ids: [idOf(a), idOf(b)] }),
      ]
    })
    expect(kitchenTickets(locals, orders)[0]?.list).toBe(true)
  })

  it('delivered and ready mix: if only ready items remain, the ticket is ready', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, itemData({ name: 'A' }))
      const b = local('ItemAdded', p, itemData({ name: 'B' }))
      return [
        a,
        b,
        submission(p, [{ ids: [idOf(a), idOf(b)] }]),
        local('ItemServed', p, { item_ids: [idOf(a)] }),
        local('ItemReady', p, { item_ids: [idOf(b)] }),
      ]
    })
    expect(summary(kitchenTickets(locals, orders))).toEqual([{ n: null, items: ['B'], list: true }])
  })

  it('a dish in preparation stays in the kitchen and is not ready', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, itemData())
      return [
        a,
        submission(p, [{ ids: [idOf(a)] }]),
        local('ItemInPreparation', p, { item_ids: [idOf(a)] }),
      ]
    })
    const r = kitchenTickets(locals, orders)
    expect(r).toHaveLength(1)
    expect(r[0]?.list).toBe(false)
  })

  it('what is returned to the queue goes back to the kitchen', () => {
    const { locals, orders } = build((p) => {
      const a = local('ItemAdded', p, itemData())
      return [
        a,
        submission(p, [{ ids: [idOf(a)] }]),
        local('ItemServed', p, { item_ids: [idOf(a)] }),
        local('ItemReturnedToQueue', p, { item_ids: [idOf(a)] }),
      ]
    })
    expect(kitchenTickets(locals, orders)).toHaveLength(1)
  })

  describe('partial voids', () => {
    it('voiding some units leaves the dish in the kitchen; voiding all removes it', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'Pizza', quantity: 3 }))
        const b = local('ItemAdded', p, itemData({ name: 'Pasta' }))
        return [
          a,
          b,
          submission(p, [{ ids: [idOf(a), idOf(b)] }]),
          local(
            'ItemVoided',
            p,
            { item_id: idOf(a), quantity: 1, already_prepared: false, ticket_id: null },
            'confirmed',
            {
              reason: 'se arrepintió',
            },
          ),
        ]
      })
      expect(summary(kitchenTickets(locals, orders))[0]?.items).toEqual(['Pizza', 'Pasta'])
      const pizza = kitchenTickets(locals, orders)[0]?.items[0]
      expect(pizza).toMatchObject({ quantity: 3, voidedQuantity: 1 })

      const everything = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'Pizza', quantity: 3 }))
        const b = local('ItemAdded', p, itemData({ name: 'Pasta' }))
        return [
          a,
          b,
          submission(p, [{ ids: [idOf(a), idOf(b)] }]),
          local(
            'ItemVoided',
            p,
            { item_id: idOf(a), quantity: 3, already_prepared: false, ticket_id: null },
            'confirmed',
            {
              reason: 'se arrepintió',
            },
          ),
        ]
      })
      expect(summary(kitchenTickets(everything.locals, everything.orders))[0]?.items).toEqual([
        'Pasta',
      ])
    })

    it('if everything on the ticket is voided, the ticket disappears', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, itemData())
        return [
          a,
          submission(p, [{ ids: [idOf(a)] }]),
          local(
            'ItemVoided',
            p,
            { item_id: idOf(a), quantity: 1, already_prepared: false, ticket_id: null },
            'confirmed',
            {
              reason: 'x',
            },
          ),
        ]
      })
      expect(kitchenTickets(locals, orders)).toEqual([])
    })
  })

  describe('events the hub has not confirmed yet', () => {
    it('a pending send already counts, without a number, and with the estimated hub time', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'Tagliata' }))
        return [a, submission(p, [{ ids: [idOf(a)] }], 'pending')]
      })
      const r = kitchenTickets(locals, orders)
      expect(summary(r)).toEqual([{ n: null, items: ['Tagliata'], list: false }])
      expect(r[0]?.sentAt).toBe(TIME)
    })

    it('once confirmed it takes the number and the time the hub received it', () => {
      const ticket = newId()
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, itemData())
        return [
          a,
          receivedAt(
            withNumbers(submission(p, [{ ids: [idOf(a)], ticket }]), { [ticket]: 4 }),
            '2026-10-24T15:03:00.000Z',
          ),
        ]
      })
      expect(kitchenTickets(locals, orders)[0]).toMatchObject({
        number: 4,
        sentAt: '2026-10-24T15:03:00.000Z',
      })
    })

    it('a rejected or quarantined send does not show', () => {
      for (const status of ['rejected', 'quarantine'] as const) {
        const { locals, orders } = build((p) => {
          const a = local('ItemAdded', p, itemData())
          return [a, { ...submission(p, [{ ids: [idOf(a)] }]), status }]
        })
        expect(kitchenTickets(locals, orders)).toEqual([])
      }
    })

    it("if another ticket's number arrives, it is not assigned to the wrong one", () => {
      const [c1, c2] = [newId(), newId()]
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'A' }))
        const b = local('ItemAdded', p, itemData({ name: 'B' }))
        return [
          a,
          b,
          withNumbers(
            submission(p, [
              { ids: [idOf(a)], ticket: c1 },
              { ids: [idOf(b)], ticket: c2, station: BAR },
            ]),
            { [c2]: 9 },
          ),
        ]
      })
      expect(summary(kitchenTickets(locals, orders))).toEqual([
        { n: null, items: ['A'], list: false },
        { n: 9, items: ['B'], list: false },
      ])
    })
  })

  describe('several tickets', () => {
    it('a send with two stations gives two tickets for the same order', () => {
      const { p, locals, orders } = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'Plato' }))
        const b = local('ItemAdded', p, itemData({ name: 'Trago' }))
        return [a, b, submission(p, [{ ids: [idOf(a)] }, { ids: [idOf(b)], station: BAR }])]
      })
      const r = kitchenTickets(locals, orders)
      expect(r.map((c) => c.stationId)).toEqual([KITCHEN, BAR])
      expect(r.every((c) => c.order.status.id === p)).toBe(true)
      expect(r[0]?.ticketId).not.toBe(r[1]?.ticketId)
    })

    it('sends at different times from several orders come out oldest to newest', () => {
      const one = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'Tarde' }))
        return [a, receivedAt(submission(p, [{ ids: [idOf(a)] }]), '2026-10-24T15:30:00.000Z')]
      })
      const two = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'Temprano' }))
        return [a, receivedAt(submission(p, [{ ids: [idOf(a)] }]), '2026-10-24T15:05:00.000Z')]
      })
      const all = [...one.locals, ...two.locals]
      const orders = openOrders(inOrder(all))
      const r = kitchenTickets(all, orders)
      expect(r.flatMap((c) => c.items.map((i) => i.name))).toEqual(['Temprano', 'Tarde'])
    })

    it('two sends of the same order (more dishes later) are two tickets', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'Primero' }))
        const b = local('ItemAdded', p, itemData({ name: 'Segundo' }))
        return [
          a,
          submission(p, [{ ids: [idOf(a)] }]),
          b,
          receivedAt(submission(p, [{ ids: [idOf(b)] }]), '2026-10-24T15:10:00.000Z'),
        ]
      })
      expect(summary(kitchenTickets(locals, orders)).map((c) => c.items[0])).toEqual([
        'Primero',
        'Segundo',
      ])
    })

    it('the dishes of a ticket come out in the order they were ordered', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'Uno' }))
        const b = local('ItemAdded', p, itemData({ name: 'Dos' }))
        const c = local('ItemAdded', p, itemData({ name: 'Tres' }))
        return [a, b, c, submission(p, [{ ids: [idOf(c), idOf(a), idOf(b)] }])]
      })
      expect(kitchenTickets(locals, orders)[0]?.items.map((i) => i.name)).toEqual([
        'Uno',
        'Dos',
        'Tres',
      ])
    })

    it('a ticket with an item that no longer exists in the order ignores that item', () => {
      const { locals, orders } = build((p) => {
        const a = local('ItemAdded', p, itemData({ name: 'Real' }))
        return [a, submission(p, [{ ids: [idOf(a), newId()] }])]
      })
      expect(kitchenTickets(locals, orders)[0]?.items.map((i) => i.name)).toEqual(['Real'])
    })

    it('a closed or canceled order no longer shows in the kitchen', () => {
      const { p, locals } = build((p) => {
        const a = local('ItemAdded', p, itemData())
        return [a, submission(p, [{ ids: [idOf(a)] }])]
      })
      const canceled = inOrder([
        ...locals,
        local('OrderCanceled', p, {}, 'confirmed', { reason: 'error' }),
      ])
      const orders = openOrders(canceled)
      expect(orders).toEqual([])
      expect(kitchenTickets(canceled, orders)).toEqual([])
    })
  })
})

describe('delay', () => {
  const timers = { yellow: 10, red: 20 }
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
  ])('%i ms after sending it is «%s» (amber 10, red 20)', (ms, expected) => {
    expect(delay(sent, t0 + ms, timers)).toBe(expected)
  })

  it('with the device clock behind (the send time is in the future) it is on time', () => {
    expect(delay(sent, t0 - 5 * min, timers)).toBe('on_time')
    expect(delay(sent, t0 - 24 * 60 * min, timers)).toBe('on_time')
  })

  it("respects the location's timers", () => {
    expect(delay(sent, t0 + 3 * min, { yellow: 3, red: 6 })).toBe('late')
    expect(delay(sent, t0 + 6 * min, { yellow: 3, red: 6 })).toBe('very_late')
    expect(delay(sent, t0 + 5 * min, { yellow: 15, red: 30 })).toBe('on_time')
  })

  it('if red and amber coincide, red wins', () => {
    expect(delay(sent, t0 + 7 * min, { yellow: 7, red: 7 })).toBe('very_late')
  })

  it('an unreadable time does not raise a false alarm', () => {
    expect(delay('no es una fecha', t0, timers)).toBe('on_time')
    expect(delay('', t0, timers)).toBe('on_time')
  })

  it('with decimal minutes (amber 0.5) it also compares correctly', () => {
    expect(delay(sent, t0 + 29_999, { yellow: 0.5, red: 1 })).toBe('on_time')
    expect(delay(sent, t0 + 30_000, { yellow: 0.5, red: 1 })).toBe('late')
  })
})

describe('timersOf', () => {
  it("uses the restaurant's", () => {
    expect(timersOf({ kitchenYellowMin: 5, kitchenRedMin: 12 })).toEqual({
      yellow: 5,
      red: 12,
    })
  })

  it('a hub from before 1.4 (without the fields) uses 10 and 20', () => {
    expect(timersOf({})).toEqual({ yellow: 10, red: 20 })
  })

  it('if only one comes, the other is the default', () => {
    expect(timersOf({ kitchenYellowMin: 4 })).toEqual({ yellow: 4, red: 20 })
    expect(timersOf({ kitchenRedMin: 40 })).toEqual({ yellow: 10, red: 40 })
  })
})
