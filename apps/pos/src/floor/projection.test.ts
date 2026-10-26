import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { currentItems, openOrders as project, tableStatus, type VisibleOrder } from './projection'
import { inOrder, itemData, local, opening } from './testing'

const openOrders = (locals: Parameters<typeof inOrder>[0]) => project(inOrder(locals))

const itemId = (l: ReturnType<typeof local>) => (l.event.data as { item_id: string }).item_id

describe('openOrders', () => {
  it('without events there are no orders', () => {
    expect(openOrders([])).toEqual([])
  })

  it('builds the order with its items and the net', () => {
    const p = newId()
    const r = openOrders([
      local('OrderOpened', p, opening),
      local('ItemAdded', p, itemData({ unit_price: 10_000 })),
      local('ItemAdded', p, itemData({ unit_price: 5_000, quantity: 2 })),
    ])
    expect(r).toHaveLength(1)
    expect(r[0]?.status.id).toBe(p)
    expect(Object.keys(r[0]?.status.items ?? {})).toHaveLength(2)
    expect(r[0]?.total).toBe(20_000)
    expect(r[0]?.pendingConfirmation).toBe(false)
    expect(r[0]?.itemsToConfirm.size).toBe(0)
  })

  it('marks as unconfirmed only the items pending confirmation', () => {
    const p = newId()
    const already = local('ItemAdded', p, itemData())
    const missing = local('ItemAdded', p, itemData(), 'pending')
    const [v] = openOrders([local('OrderOpened', p, opening), already, missing])
    expect(v?.pendingConfirmation).toBe(true)
    expect([...(v?.itemsToConfirm ?? [])]).toEqual([itemId(missing)])
  })

  it('a pending ItemsSent marks the items of its tickets as unconfirmed', () => {
    const p = newId()
    const [one, two, three] = [1, 2, 3].map(() => local('ItemAdded', p, itemData()))
    const ids = [one, two, three].map((l) => itemId(l as never))
    const [v] = openOrders([
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
    expect([...(v?.itemsToConfirm ?? [])].sort()).toEqual([ids[0], ids[2]].sort())
    expect(v?.status.items[ids[0] as string]?.status).toBe('sent')
    expect(v?.status.items[ids[1] as string]?.status).toBe('pending')
  })

  it('an already confirmed ItemsSent marks nothing', () => {
    const p = newId()
    const item = local('ItemAdded', p, itemData())
    const [v] = openOrders([
      local('OrderOpened', p, opening),
      item,
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [itemId(item)] }],
      }),
    ])
    expect(v?.itemsToConfirm.size).toBe(0)
    expect(v?.pendingConfirmation).toBe(false)
  })

  it('a pending event that is not ItemAdded marks the order but not the items', () => {
    const p = newId()
    const item = local('ItemAdded', p, itemData())
    const [v] = openOrders([
      local('OrderOpened', p, opening),
      item,
      local('ItemChanged', p, { item_id: itemId(item), notes: 'sin hielo' }, 'pending'),
    ])
    expect(v?.pendingConfirmation).toBe(true)
    expect(v?.itemsToConfirm.size).toBe(0)
    expect(v?.status.items[itemId(item)]?.notes).toBe('sin hielo')
  })

  it('an order opened only with pending events (offline) is already visible', () => {
    const p = newId()
    const [v] = openOrders([
      local('OrderOpened', p, opening, 'pending'),
      local('ItemAdded', p, itemData({ unit_price: 32_000 }), 'pending'),
    ])
    expect(v?.total).toBe(32_000)
    expect(v?.pendingConfirmation).toBe(true)
  })

  it('ignores rejected events and those in quarantine', () => {
    const p = newId()
    const badCase = local('ItemAdded', p, itemData({ unit_price: 99_000 }), 'rejected')
    const odd = local('ItemAdded', p, itemData({ unit_price: 88_000 }), 'quarantine')
    const [v] = openOrders([
      local('OrderOpened', p, opening),
      local('ItemAdded', p, itemData({ unit_price: 1_000 })),
      badCase,
      odd,
    ])
    expect(v?.total).toBe(1_000)
    expect(v?.status.items[itemId(badCase)]).toBeUndefined()
    expect(v?.status.items[itemId(odd)]).toBeUndefined()
  })

  it('an order whose opening was rejected does not appear', () => {
    const p = newId()
    expect(
      openOrders([
        local('OrderOpened', p, opening, 'rejected'),
        local('ItemAdded', p, itemData(), 'pending'),
      ]),
    ).toEqual([])
  })

  it('does not show closed or canceled orders', () => {
    const closed = newId()
    const canceled = newId()
    const opened = newId()
    const r = openOrders([
      local('OrderOpened', closed, opening),
      local('OrderClosed', closed, {}),
      local('OrderOpened', canceled, opening),
      local('OrderCanceled', canceled, {}, 'confirmed', { reason: 'error' }),
      local('OrderOpened', opened, opening),
    ])
    expect(r.map((v) => v.status.id)).toEqual([opened])
  })

  it('a rejected close leaves the order open', () => {
    const p = newId()
    const r = openOrders([
      local('OrderOpened', p, opening),
      local('OrderClosed', p, {}, 'rejected'),
    ])
    expect(r).toHaveLength(1)
  })

  it('sorts from oldest to newest by opening time', () => {
    const [a, b, c] = [newId(), newId(), newId()]
    // The opening time is the one the hub set when receiving it (`received_at`).
    const open = (id: string, time: string) => {
      const l = local('OrderOpened', id, opening)
      return { ...l, event: { ...l.event, received_at: time } }
    }
    const r = openOrders([
      open(b, '2026-10-24T15:10:00.000Z'),
      open(c, '2026-10-24T15:20:00.000Z'),
      open(a, '2026-10-24T15:00:00.000Z'),
    ])
    expect(r.map((v) => v.status.id)).toEqual([a, b, c])
  })

  it('separates the orders even if their events arrive mixed', () => {
    const [a, b] = [newId(), newId()]
    const r = openOrders([
      local('OrderOpened', a, opening),
      local('OrderOpened', b, opening),
      local('ItemAdded', b, itemData({ unit_price: 7_000 })),
      local('ItemAdded', a, itemData({ unit_price: 3_000 })),
    ])
    const totals = Object.fromEntries(r.map((v) => [v.status.id, v.total]))
    expect(totals).toEqual({ [a]: 3_000, [b]: 7_000 })
  })

  it('the same repeated event does not duplicate the item', () => {
    const p = newId()
    const item = local('ItemAdded', p, itemData({ unit_price: 4_000 }))
    const [v] = openOrders([local('OrderOpened', p, opening), item, item])
    expect(v?.total).toBe(4_000)
  })
})

describe('currentItems', () => {
  it('leaves out the voided ones and sorts by the order in which they were added', () => {
    const p = newId()
    const [a, b, c] = [1, 2, 3].map(() => local('ItemAdded', p, itemData()))
    const [v] = openOrders([
      local('OrderOpened', p, opening),
      a as never,
      b as never,
      c as never,
      local('ItemRemoved', p, { item_id: itemId(b as never) }, 'confirmed'),
    ])
    expect(currentItems((v as VisibleOrder).status).map((i) => i.id)).toEqual([
      itemId(a as never),
      itemId(c as never),
    ])
  })
})

describe('tableStatus', () => {
  const visible = (...events: ReturnType<typeof local>[]) => {
    const p = events[0]?.event.aggregate_id as string
    return openOrders([local('OrderOpened', p, opening), ...events])
  }
  const submission = (p: string, ids: string[]) =>
    local('ItemsSent', p, {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: ids }],
    })

  it('without orders, or with orders without items, it is free', () => {
    expect(tableStatus([])).toBe('free')
    const p = newId()
    expect(tableStatus(openOrders([local('OrderOpened', p, opening)]))).toBe('free')
  })

  it('with something unsent it is taking', () => {
    const p = newId()
    expect(tableStatus(visible(local('ItemAdded', p, itemData())))).toBe('taking')
  })

  it('with everything sent it is in the kitchen', () => {
    const p = newId()
    const item = local('ItemAdded', p, itemData())
    expect(tableStatus(visible(item, submission(p, [itemId(item)])))).toBe('in_kitchen')
  })

  it('sent plus a new unsent item goes back to taking', () => {
    const p = newId()
    const one = local('ItemAdded', p, itemData())
    const two = local('ItemAdded', p, itemData())
    expect(tableStatus(visible(one, submission(p, [itemId(one)]), two))).toBe('taking')
  })

  it('an item held by course counts as unsent', () => {
    const p = newId()
    const item = local('ItemAdded', p, itemData({ course: 'dessert' }))
    const table = visible(local('CourseHeld', p, { course: 'dessert' }), item)
    expect(Object.values(table[0]?.status.items ?? {})[0]?.status).toBe('held')
    expect(tableStatus(table)).toBe('taking')
  })

  it('voided items do not count', () => {
    const p = newId()
    const item = local('ItemAdded', p, itemData())
    expect(tableStatus(visible(item, local('ItemRemoved', p, { item_id: itemId(item) })))).toBe(
      'free',
    )
  })

  it('with several orders on the table it looks at all of them', () => {
    const [a, b] = [newId(), newId()]
    const itemA = local('ItemAdded', a, itemData())
    const tables = openOrders([
      local('OrderOpened', a, opening),
      itemA,
      submission(a, [itemId(itemA)]),
      local('OrderOpened', b, opening),
      local('ItemAdded', b, itemData()),
    ])
    expect(tables).toHaveLength(2)
    expect(tableStatus(tables)).toBe('taking')
    expect(tableStatus(tables.filter((m) => m.status.id === a))).toBe('in_kitchen')
  })
})
