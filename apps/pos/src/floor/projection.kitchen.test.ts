import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { type DemoTableStatus, openOrders, tableStatus } from './projection'
import { inOrder, itemData, local, opening } from './testing'

// Table status on the floor plan with the kitchen (ADR-015): taking > ready > in kitchen > served.

const idOf = (l: ReturnType<typeof local>) => (l.event.data as { item_id: string }).item_id

/** A table with a single order: each dish with the given status. */
function table(
  dishes: ('pending' | 'held' | 'sent' | 'in_preparation' | 'ready' | 'served' | 'voided')[],
  extra: ReturnType<typeof local>[] = [],
) {
  const p = newId()
  const events: ReturnType<typeof local>[] = [local('OrderOpened', p, opening)]
  if (dishes.includes('held')) events.push(local('CourseHeld', p, { course: 'dessert' }))
  const items = dishes.map((status) => ({
    status,
    ev: local('ItemAdded', p, itemData({ course: status === 'held' ? 'dessert' : null })),
  }))
  events.push(...items.map((i) => i.ev))
  const ids = (e: string) => items.filter((i) => i.status === e).map((i) => idOf(i.ev))
  const sentList = items.filter((i) => !['pending', 'held'].includes(i.status))
  if (sentList.length)
    events.push(
      local('ItemsSent', p, {
        tickets: [
          {
            ticket_id: newId(),
            station_id: newId(),
            item_ids: sentList.map((i) => idOf(i.ev)),
          },
        ],
      }),
    )
  if (ids('in_preparation').length)
    events.push(local('ItemInPreparation', p, { item_ids: ids('in_preparation') }))
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
  return openOrders(inOrder([...events, ...extra]))
}

describe('tableStatus with the kitchen', () => {
  it.each<[string[], DemoTableStatus]>([
    [[], 'free'],
    [['sent'], 'in_kitchen'],
    [['in_preparation'], 'in_kitchen'],
    [['ready'], 'ready'],
    [['served'], 'served'],
    [['voided'], 'free'],
    [['pending'], 'taking'],
    [['held'], 'taking'],
  ])('with %j the table is «%s»', (dishes, expected) => {
    expect(tableStatus(table(dishes as never))).toBe(expected)
  })

  it.each<[string[], DemoTableStatus]>([
    // taking wins over everything
    [['pending', 'ready'], 'taking'],
    [['pending', 'sent'], 'taking'],
    [['pending', 'served'], 'taking'],
    [['held', 'ready', 'served'], 'taking'],
    // ready wins over in kitchen and served
    [['ready', 'sent'], 'ready'],
    [['ready', 'in_preparation'], 'ready'],
    [['ready', 'served'], 'ready'],
    [['ready', 'sent', 'served'], 'ready'],
    // in kitchen wins over served
    [['sent', 'served'], 'in_kitchen'],
    [['in_preparation', 'served'], 'in_kitchen'],
    // voided does not count
    [['voided', 'served'], 'served'],
    [['voided', 'ready'], 'ready'],
    [['voided', 'pending'], 'taking'],
    // all delivered
    [['served', 'served'], 'served'],
  ])('with %j the table is «%s»', (dishes, expected) => {
    expect(tableStatus(table(dishes as never))).toBe(expected)
  })

  it('sending a delivered dish back to the queue returns it to «in_kitchen»', () => {
    const p = newId()
    const a = local('ItemAdded', p, itemData())
    const orders = openOrders(
      inOrder([
        local('OrderOpened', p, opening),
        a,
        local('ItemsSent', p, {
          tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [idOf(a)] }],
        }),
        local('ItemServed', p, { item_ids: [idOf(a)] }),
      ]),
    )
    expect(tableStatus(orders)).toBe('served')
    const another = openOrders(
      inOrder([
        local('OrderOpened', p, opening),
        a,
        local('ItemsSent', p, {
          tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [idOf(a)] }],
        }),
        local('ItemServed', p, { item_ids: [idOf(a)] }),
        local('ItemReturnedToQueue', p, { item_ids: [idOf(a)] }),
      ]),
    )
    expect(tableStatus(another)).toBe('in_kitchen')
  })

  it('with several orders on the same table the most urgent wins', () => {
    const [a, b, c] = [newId(), newId(), newId()]
    const itemA = local('ItemAdded', a, itemData())
    const itemB = local('ItemAdded', b, itemData())
    const itemC = local('ItemAdded', c, itemData())
    const submission = (p: string, it: typeof itemA) =>
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [idOf(it)] }],
      })
    const all = openOrders(
      inOrder([
        local('OrderOpened', a, opening),
        itemA,
        submission(a, itemA),
        local('ItemServed', a, { item_ids: [idOf(itemA)] }),
        local('OrderOpened', b, opening),
        itemB,
        submission(b, itemB),
        local('OrderOpened', c, opening),
        itemC,
        submission(c, itemC),
        local('ItemReady', c, { item_ids: [idOf(itemC)] }),
      ]),
    )
    const src = (...ids: string[]) => all.filter((x) => ids.includes(x.status.id))
    expect(tableStatus(src(a))).toBe('served')
    expect(tableStatus(src(a, b))).toBe('in_kitchen')
    expect(tableStatus(src(a, b, c))).toBe('ready')
    expect(tableStatus(src(a, c))).toBe('ready')
  })

  it('a dish marked ready in a pending event (unconfirmed) already counts on the floor plan', () => {
    const p = newId()
    const a = local('ItemAdded', p, itemData())
    const orders = openOrders(
      inOrder([
        local('OrderOpened', p, opening),
        a,
        local('ItemsSent', p, {
          tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [idOf(a)] }],
        }),
        local('ItemReady', p, { item_ids: [idOf(a)] }, 'pending'),
      ]),
    )
    expect(tableStatus(orders)).toBe('ready')
  })
})
