import { newId } from '@pos/core'
import type { LocalEvent } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { openOrders } from './projection'
import { inOrder, itemData, local, opening } from './testing'
import { kitchenTickets } from './tickets'

// «Pedidos en cocina» and the kitchen screen with a send the hub saved without applying
// (`unapplied`, task 1.7b): the hub printed nothing for it and the order did not change, so the
// kitchen has no card for it either.

const KITCHEN = newId()
const idOf = (l: LocalEvent) => (l.event.data as { item_id: string }).item_id
const marked = (l: LocalEvent): LocalEvent => ({
  ...l,
  event: { ...l.event, unapplied: true } as never,
})

describe('kitchenTickets and a send the hub did not apply', () => {
  it('a stale send that repeats a dish already in the kitchen does not make a second card', () => {
    const p = newId()
    const a = local('ItemAdded', p, itemData({ name: 'Tagliata' }))
    const b = local('ItemAdded', p, itemData({ name: 'Risotto' }))
    const first = newId()
    const second = newId()
    const sent = (ids: string[], ticket: string) =>
      local('ItemsSent', p, {
        tickets: [{ ticket_id: ticket, station_id: KITCHEN, item_ids: ids }],
      })
    // Another device sent both; this one, stale, sent the same ones again: the hub saved it as a
    // conflict (the order did not take it).
    const locals = inOrder([
      local('OrderOpened', p, opening),
      a,
      b,
      sent([idOf(a), idOf(b)], first),
      marked(sent([idOf(a), idOf(b)], second)),
    ])
    const cards = kitchenTickets(locals, openOrders(locals))
    expect(cards.map((c) => c.ticketId)).toEqual([first])
  })
})
