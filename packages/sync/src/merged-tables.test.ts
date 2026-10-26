import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { FloorSync } from './hub/floor'
import { type Connection, HubSync } from './hub/hub'
import { MemoryStore } from './hub/store'
import { SqliteStore } from './hub/store-sqlite'
import { openAccess } from './testing/access'
import type { NetNode } from './testing/network'
import { item, NOW, type Setup, setup, sqliteDatabase } from './testing/setup'

// Task 1.5 in the hub: a table another order already occupies (also as a merged table) cannot be
// taken, whether opening, moving or merging; moving products requires being online; and it is all
// per restaurant. Tested with real events against the hub, without going through the client.

const connectionOf = (m: Setup, node: NetNode) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`No token for ${node.name}`)
  return connection
}

const WITH_REASON = new Set(['OrderCanceled', 'OrderReopened', 'ItemVoided'])

function device() {
  const m = setup()
  const ana = m.network.device('ana')
  const beto = m.network.device('beto')
  /** `knows: false` sends `base_sequence: 0`: the device was offline. */
  const submit = (
    who: NetNode,
    order: string,
    type: string,
    data: unknown,
    extras: Partial<Record<keyof OrderEvent, unknown>> & { knows?: boolean } = {},
  ) => {
    const { knows = true, ...rest } = extras
    const r = m.hub().receiveBatch(connectionOf(m, who), [
      {
        id: newId(),
        type,
        schema_version: 1,
        aggregate_type: 'order',
        aggregate_id: order,
        related: [],
        data,
        session_id: null,
        user_id: who.userId,
        device_id: who.deviceId,
        authorization_id: null,
        reason: WITH_REASON.has(type) ? 'Prueba' : null,
        device_time: NOW,
        hub_estimated_time: NOW,
        base_sequence: knows ? m.store.maxSequence() : 0,
        ...rest,
      },
    ])
    return r.results[0]
  }
  const open = (who: NetNode, table: string | null, extras = {}) => {
    const order = newId()
    const result = submit(
      who,
      order,
      'OrderOpened',
      { channel: 'dine_in', table_id: table, guests: 2 },
      extras,
    )
    return { order, result }
  }
  const merge = (who: NetNode, order: string, tables: string[], extras = {}) =>
    submit(who, order, 'TablesMerged', { table_ids: tables }, extras)
  const separate = (who: NetNode, order: string, tables: string[], extras = {}) =>
    submit(who, order, 'TablesSeparated', { table_ids: tables }, extras)
  const moveToTable = (who: NetNode, order: string, table: string, extras = {}) =>
    submit(who, order, 'OrderMovedTable', { target_table_id: table }, extras)
  return { m, ana, beto, submit, open, merge, separate, moveToTable }
}

describe('merging tables in the hub', () => {
  it('merging a free table is accepted and the table stays occupied until separated', () => {
    const { m, ana, open, merge, separate } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    expect(m.hub().hasOpenOrder(m2)).toBe(false)
    expect(merge(ana, order, [m2])).toMatchObject({ status: 'confirmed', conflict: null })
    expect(m.hub().hasOpenOrder(m2)).toBe(true)
    expect(m.hub().hasOpenOrder(m1)).toBe(true)
    expect(m.hub().order(order)?.mergedTables).toEqual([m2])
    expect(separate(ana, order, [m2])?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(m2)).toBe(false)
    expect(m.hub().hasOpenOrder(m1)).toBe(true)
  })

  it('a merged table is freed when the order is closed or canceled and is occupied again when reopened', () => {
    const { m, ana, open, merge, submit } = device()
    const [m1, m2, m3, m4] = [newId(), newId(), newId(), newId()]
    const a = open(ana, m1).order
    merge(ana, a, [m2])
    expect(submit(ana, a, 'OrderClosed', {})?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(m2)).toBe(false)
    expect(submit(ana, a, 'OrderReopened', {})?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(m2)).toBe(true)

    const b = open(ana, m3).order
    merge(ana, b, [m4])
    expect(submit(ana, b, 'OrderCanceled', {})?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(m4)).toBe(false)
    expect(m.hub().hasOpenOrder(m3)).toBe(false)
  })

  it('merging into an order with no table is rejected by the reducer (no_table), not by the table', () => {
    const { ana, open, merge } = device()
    const { order } = open(ana, null)
    expect(merge(ana, order, [newId()])).toMatchObject({
      status: 'rejected',
      reason: 'no_table',
    })
  })

  it('separating what is not merged is rejected (tables_not_merged) and so is repeating the merge', () => {
    const { ana, open, merge, separate } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    expect(separate(ana, order, [m2])).toMatchObject({
      status: 'rejected',
      reason: 'tables_not_merged',
    })
    merge(ana, order, [m2])
    expect(merge(ana, order, [m2])).toMatchObject({
      status: 'rejected',
      reason: 'tables_already_merged',
    })
  })

  it('the merged table of an order cannot be merged into another: table_occupied, whatever it knows', () => {
    const { ana, beto, open, merge } = device()
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    const two = open(beto, m3).order
    // Beto knows everything: rejected.
    expect(merge(beto, two, [m2])).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    // Beto was offline: merging requires being up to date, so it is rejected too.
    expect(merge(beto, two, [m2], { knows: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
  })

  it('merging the main table of another order is rejected too', () => {
    const { ana, beto, open, merge } = device()
    const [m1, m3] = [newId(), newId()]
    open(ana, m1)
    const two = open(beto, m3).order
    expect(merge(beto, two, [m1])).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    expect(merge(beto, two, [m1], { knows: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
  })

  it('a list where only one table is occupied is rejected entirely and leaves none merged', () => {
    const { m, ana, beto, open, merge } = device()
    const [m1, free, takenPath] = [newId(), newId(), newId()]
    open(ana, takenPath)
    const two = open(beto, m1).order
    expect(merge(beto, two, [free, takenPath])).toMatchObject({ status: 'rejected' })
    expect(m.hub().order(two)?.mergedTables).toEqual([])
    expect(m.hub().hasOpenOrder(free)).toBe(false)
  })

  it('a closed order occupies nothing: its table and its merged ones can be merged into another', () => {
    const { ana, beto, open, merge, submit } = device()
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    submit(ana, one, 'OrderClosed', {})
    const two = open(beto, m3).order
    expect(merge(beto, two, [m1, m2])?.status).toBe('confirmed')
  })

  it('the rejection is idempotent: resending the same event gives the same reason', () => {
    const { m, ana, beto, open } = device()
    const [m1, m2] = [newId(), newId()]
    open(ana, m1)
    const two = open(beto, m2).order
    const event = {
      id: newId(),
      type: 'TablesMerged',
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: two,
      related: [],
      data: { table_ids: [m1] },
      session_id: null,
      user_id: beto.userId,
      device_id: beto.deviceId,
      authorization_id: null,
      reason: null,
      device_time: NOW,
      hub_estimated_time: NOW,
      base_sequence: m.store.maxSequence(),
    }
    const connection = connectionOf(m, beto)
    const a = m.hub().receiveBatch(connection, [event]).results[0]
    const b = m.hub().receiveBatch(connection, [event]).results[0]
    expect(a).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    expect(b).toEqual(a)
  })
})

describe('opening a table another order occupies as merged', () => {
  it('if the device knew the order, it is rejected as table_occupied', () => {
    const { ana, beto, open, merge } = device()
    const [m1, m2] = [newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    expect(open(beto, m2).result).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
  })

  it('if it did not know it (offline), it is accepted and duplicate_table is flagged at the register', () => {
    const { m, ana, beto, open, merge } = device()
    const [m1, m2] = [newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    const { result } = open(beto, m2, { knows: false })
    expect(result).toMatchObject({ status: 'confirmed', conflict: 'duplicate_table' })
    expect(
      m
        .hub()
        .conflicts()
        .map((c) => c.type),
    ).toEqual(['duplicate_table'])
  })

  it('opening on a table that is no longer merged is normal', () => {
    const { ana, beto, open, merge, separate } = device()
    const [m1, m2] = [newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    separate(ana, one, [m2])
    expect(open(beto, m2).result).toMatchObject({ status: 'confirmed', conflict: null })
  })
})

describe('moving to another table', () => {
  it('to a free table is accepted: frees the previous one and occupies the new one', () => {
    const { m, ana, open, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    expect(moveToTable(ana, order, m2)?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(m1)).toBe(false)
    expect(m.hub().hasOpenOrder(m2)).toBe(true)
  })

  it('to an occupied table is rejected if the device knew the other order', () => {
    const { m, ana, beto, open, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    open(beto, m2)
    expect(moveToTable(ana, order, m2)).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().order(order)?.tableId).toBe(m1)
  })

  it('to an occupied table is rejected even if the device did not know it: not a conflict', () => {
    const { m, ana, beto, open, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    open(beto, m2)
    expect(moveToTable(ana, order, m2, { knows: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().conflicts()).toEqual([])
  })

  it('to a merged table of another order is rejected', () => {
    const { ana, beto, open, merge, moveToTable } = device()
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const { order } = open(ana, m1)
    const other = open(beto, m2).order
    merge(beto, other, [m3])
    expect(moveToTable(ana, order, m3)).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(moveToTable(ana, order, m3, { knows: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
  })

  it('to one of its own merged tables is accepted: the previous one becomes free', () => {
    const { m, ana, open, merge, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    merge(ana, order, [m2])
    expect(moveToTable(ana, order, m2)?.status).toBe('confirmed')
    expect(m.hub().order(order)).toMatchObject({ tableId: m2, mergedTables: [] })
    expect(m.hub().hasOpenOrder(m1)).toBe(false)
    expect(m.hub().hasOpenOrder(m2)).toBe(true)
  })

  it('to the table it is already at is accepted (it does not clash with itself)', () => {
    const { ana, open, moveToTable } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    expect(moveToTable(ana, order, m1)?.status).toBe('confirmed')
  })

  it('to the table of an already closed order is accepted', () => {
    const { ana, beto, open, moveToTable, submit } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    const other = open(beto, m2).order
    submit(beto, other, 'OrderClosed', {})
    expect(moveToTable(ana, order, m2)?.status).toBe('confirmed')
  })

  it('two devices that want the same free table: the first wins and the second is rejected', () => {
    const { m, ana, beto, open, moveToTable } = device()
    const [m1, m2, free] = [newId(), newId(), newId()]
    const a = open(ana, m1).order
    const b = open(beto, m2).order
    expect(moveToTable(ana, a, free)?.status).toBe('confirmed')
    expect(moveToTable(beto, b, free, { knows: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().order(b)?.tableId).toBe(m2)
  })

  it('two orders merging the same free table: only the first keeps it', () => {
    const { m, ana, beto, open, merge } = device()
    const [m1, m2, free] = [newId(), newId(), newId()]
    const a = open(ana, m1).order
    const b = open(beto, m2).order
    expect(merge(ana, a, [free])?.status).toBe('confirmed')
    expect(merge(beto, b, [free], { knows: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().order(b)?.mergedTables).toEqual([])
  })
})

describe('an order that is empty after having products no longer occupies its table', () => {
  const copy = (i: ReturnType<typeof item>) => {
    const { catalog_version: _v, price_channel_id: _c, ...rest } = i
    return rest
  }

  it('a newly opened one, with no products, does occupy it (and its merged ones too)', () => {
    const { m, ana, beto, open, merge } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    merge(ana, order, [m2])
    expect(m.hub().hasOpenOrder(m1)).toBe(true)
    expect(m.hub().hasOpenOrder(m2)).toBe(true)
    expect(open(beto, m1).result).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
  })

  it('when all its products move to another order, its table and merged ones become free', () => {
    const { m, ana, beto, open, merge, submit } = device()
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const { order: source } = open(ana, m1)
    merge(ana, source, [m2])
    const it = item(12_900)
    submit(ana, source, 'ItemAdded', it)
    submit(ana, source, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    expect(m.hub().hasOpenOrder(m1)).toBe(true)
    const target = open(ana, m3).order
    const r = submit(
      ana,
      source,
      'ItemsMoved',
      {
        target_order_id: target,
        items: [{ item: copy(it), status: 'sent', voided_quantity: 0, added_by: ana.userId }],
      },
      { related: [target] },
    )
    expect(r?.status).toBe('confirmed')
    // The source stays open but empty: it no longer occupies anything.
    expect(m.hub().order(source)?.status).toBe('open')
    expect(m.hub().hasOpenOrder(m1)).toBe(false)
    expect(m.hub().hasOpenOrder(m2)).toBe(false)
    expect(m.hub().hasOpenOrder(m3)).toBe(true)
    // Another device can open those tables, and move or merge into them.
    expect(open(beto, m1).result).toMatchObject({ status: 'confirmed', conflict: null })
    const other = open(beto, newId()).order
    expect(merge(beto, other, [m2])?.status).toBe('confirmed')
  })

  it('voiding everything it had also frees it; with one live unit, it does not', () => {
    const { m, ana, open, submit } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    const it = item(12_900, { quantity: 2 })
    submit(ana, order, 'ItemAdded', it)
    submit(ana, order, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    const voidItem = (quantity: number) =>
      submit(ana, order, 'ItemVoided', {
        item_id: it.item_id,
        quantity,
        already_prepared: false,
        ticket_id: null,
      })
    expect(voidItem(1)?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(m1)).toBe(true)
    expect(voidItem(1)?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(m1)).toBe(false)
  })

  it('an order with only served items still occupies the table (the check is not closed)', () => {
    const { m, ana, open, submit } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    const it = item()
    submit(ana, order, 'ItemAdded', it)
    submit(ana, order, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    submit(ana, order, 'ItemServed', { item_ids: [it.item_id] })
    expect(m.hub().hasOpenOrder(m1)).toBe(true)
  })

  it('moving to the table of an emptied order is accepted', () => {
    const { ana, beto, open, submit, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const empty = open(ana, m1).order
    const it = item()
    submit(ana, empty, 'ItemAdded', it)
    submit(ana, empty, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    submit(ana, empty, 'ItemVoided', {
      item_id: it.item_id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    const other = open(beto, m2).order
    expect(moveToTable(beto, other, m1)?.status).toBe('confirmed')
  })

  // An emptied order releases its table but keeps `tableId`: if another takes it and the emptied
  // one gets a product, it would occupy it again; the hub checks it as when opening
  // (`tablesItTakes`).
  it('adding a product to an emptied order whose table another took is rejected or flagged', () => {
    const { ana, beto, open, submit } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    const it = item()
    submit(ana, order, 'ItemAdded', it)
    submit(ana, order, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    submit(ana, order, 'ItemVoided', {
      item_id: it.item_id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    expect(open(beto, m1).result?.status).toBe('confirmed')
    const r = submit(ana, order, 'ItemAdded', item())
    expect(r?.status === 'rejected' || (r?.status === 'confirmed' && r.conflict !== null)).toBe(
      true,
    )
  })

  it('removing what was not yet sent does not release the table: another waiter cannot open it', () => {
    const { ana, beto, open, submit } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    const it = item()
    submit(ana, order, 'ItemAdded', it)
    submit(ana, order, 'ItemRemoved', { item_id: it.item_id })
    expect(open(beto, m1).result?.status).toBe('rejected')
  })

  // Reopening a check whose table another order already took does not leave two open orders on it.
  it('reopening a check whose table another order already took is rejected or flagged', () => {
    const { ana, beto, open, submit } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    submit(ana, order, 'OrderClosed', {})
    open(beto, m1)
    const r = submit(ana, order, 'OrderReopened', {})
    expect(r?.status === 'rejected' || (r?.status === 'confirmed' && r.conflict !== null)).toBe(
      true,
    )
  })
})

describe('hasOpenOrder with merged tables', () => {
  it('counts merged tables, also after restarting the hub and from FloorSync', () => {
    const { m, ana, open, merge } = device()
    const [m1, m2, another] = [newId(), newId(), newId()]
    const { order } = open(ana, m1)
    merge(ana, order, [m2])
    expect(m.network.floor.hasOpenOrder(m2)).toBe(true)
    m.network.crashHub()
    expect(m.hub().hasOpenOrder(m2)).toBe(true)
    expect(m.hub().hasOpenOrder(another)).toBe(false)
    expect(m.network.floor.hasOpenOrder(m2)).toBe(true)
  })

  it('with the in-memory hub (no SQLite) it answers the same', () => {
    const hub = new HubSync(new MemoryStore(), {
      restaurantId: '',
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock: () => NOW,
      access: openAccess,
    })
    const withIt: Connection = { deviceId: newId(), type: 'waiter', revokedAt: null }
    const user = newId()
    const [m1, m2] = [newId(), newId()]
    const order = newId()
    const base = (type: string, data: unknown, base_sequence: number) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data,
      session_id: null,
      user_id: user,
      device_id: withIt.deviceId,
      authorization_id: null,
      reason: null,
      device_time: NOW,
      hub_estimated_time: NOW,
      base_sequence,
    })
    const r = hub.receiveBatch(withIt, [
      base('OrderOpened', { channel: 'dine_in', table_id: m1, guests: 2 }, 0),
      base('TablesMerged', { table_ids: [m2] }, 1),
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(hub.hasOpenOrder(m2)).toBe(true)
  })

  it('a table merged into an order with other merged tables: only those count', () => {
    const { m, ana, open, merge, separate } = device()
    const tables = Array.from({ length: 5 }, () => newId())
    const { order } = open(ana, tables[0] as string)
    merge(ana, order, tables.slice(1, 4))
    separate(ana, order, [tables[2] as string])
    expect(tables.map((x) => m.hub().hasOpenOrder(x))).toEqual([true, true, false, true, false])
  })
})

describe('moving products to another table', () => {
  const copy = (i: ReturnType<typeof item>) => {
    const { catalog_version: _v, price_channel_id: _c, ...rest } = i
    return rest
  }

  function withSentDish() {
    const e = device()
    const m1 = newId()
    const source = e.open(e.ana, m1).order
    const it = item(12_900, { quantity: 2 })
    e.submit(e.ana, source, 'ItemAdded', it)
    e.submit(e.ana, source, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    const movement = (target: string, extras = {}) => ({
      order: source,
      type: 'ItemsMoved',
      data: {
        target_order_id: target,
        items: [
          {
            item: copy(it),
            status: 'sent',
            voided_quantity: 0,
            added_by: e.ana.userId,
          },
        ],
      },
      extras: { related: [target], ...extras },
    })
    return { ...e, source, it, movement }
  }

  it('to a free table, in one batch: the order is opened and moved, all or nothing', () => {
    const e = withSentDish()
    const target = newId()
    const free = newId()
    const hub = e.m.hub()
    const connection = connectionOf(e.m, e.ana)
    const base = e.m.store.maxSequence()
    const mov = e.movement(target)
    const envelope = (type: string, order: string, data: unknown, extras = {}) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data,
      session_id: null,
      user_id: e.ana.userId,
      device_id: e.ana.deviceId,
      authorization_id: null,
      reason: null,
      device_time: NOW,
      hub_estimated_time: NOW,
      base_sequence: base,
      ...extras,
    })
    const r = hub.receiveBatch(connection, [
      envelope('OrderOpened', target, { channel: 'dine_in', table_id: free, guests: 1 }),
      envelope('ItemsMoved', mov.order, mov.data, mov.extras),
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(hub.order(target)?.items[e.it.item_id]).toMatchObject({
      status: 'sent',
      quantity: 2,
    })
    expect(hub.order(e.source)?.items).toEqual({})
    expect(hub.hasOpenOrder(free)).toBe(true)
  })

  it('if the table of the new order is occupied, both the opening and the move are rejected', () => {
    const e = withSentDish()
    const takenPath = newId()
    e.open(e.beto, takenPath)
    const target = newId()
    const mov = e.movement(target)
    const base = e.m.store.maxSequence()
    const envelope = (type: string, order: string, data: unknown, extras = {}) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data,
      session_id: null,
      user_id: e.ana.userId,
      device_id: e.ana.deviceId,
      authorization_id: null,
      reason: null,
      device_time: NOW,
      hub_estimated_time: NOW,
      base_sequence: base,
      ...extras,
    })
    const r = e.m
      .hub()
      .receiveBatch(connectionOf(e.m, e.ana), [
        envelope('OrderOpened', target, { channel: 'dine_in', table_id: takenPath, guests: 1 }),
        envelope('ItemsMoved', mov.order, mov.data, mov.extras),
      ])
    expect(r.results[0]).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    expect(r.results[1]).toMatchObject({ status: 'rejected', reason: 'depends_on_rejected' })
    // The dish stays where it was.
    expect(e.m.hub().order(e.source)?.items[e.it.item_id]?.status).toBe('sent')
  })

  it('to an existing order with another device up to date is accepted without conflict', () => {
    const e = withSentDish()
    const target = e.open(e.beto, newId()).order
    const mov = e.movement(target)
    const r = e.submit(e.ana, mov.order, mov.type, mov.data, mov.extras)
    expect(r).toMatchObject({ status: 'confirmed', conflict: null })
  })

  it('not up to date and with the dish already voided by another device: rejected, not a conflict', () => {
    const e = withSentDish()
    const target = e.open(e.ana, newId()).order
    const anaBase = e.m.store.maxSequence()
    // Beto voids the whole dish while Ana does not find out.
    expect(
      e.submit(e.beto, e.source, 'ItemVoided', {
        item_id: e.it.item_id,
        quantity: 2,
        already_prepared: false,
        ticket_id: null,
      })?.status,
    ).toBe('confirmed')
    const mov = e.movement(target)
    const r = e.submit(e.ana, mov.order, mov.type, mov.data, {
      ...mov.extras,
      base_sequence: anaBase,
    })
    expect(r).toMatchObject({ status: 'rejected' })
    expect(e.m.hub().conflicts()).toEqual([])
    expect(e.m.hub().order(target)?.items).toEqual({})
  })

  it('in contrast, voiding while not up to date what another already voided is accepted as a conflict', () => {
    const e = withSentDish()
    const anaBase = e.m.store.maxSequence()
    const voidItem = (who: NetNode, extras = {}) =>
      e.submit(
        who,
        e.source,
        'ItemVoided',
        { item_id: e.it.item_id, quantity: 2, already_prepared: false, ticket_id: null },
        extras,
      )
    voidItem(e.beto)
    expect(voidItem(e.ana, { base_sequence: anaBase })).toMatchObject({
      status: 'confirmed',
      conflict: 'item_already_voided',
    })
  })

  it('not up to date, with an outdated copy (another voided one unit): mismatched_copy, rejected', () => {
    const e = withSentDish()
    const target = e.open(e.ana, newId()).order
    const anaBase = e.m.store.maxSequence()
    e.submit(e.beto, e.source, 'ItemVoided', {
      item_id: e.it.item_id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    const mov = e.movement(target)
    expect(
      e.submit(e.ana, mov.order, mov.type, mov.data, {
        ...mov.extras,
        base_sequence: anaBase,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'mismatched_copy' })
  })

  it('up to date and with a dish no longer in the source: rejected (item_not_found)', () => {
    const e = withSentDish()
    const target = e.open(e.ana, newId()).order
    const mov = e.movement(target)
    expect(e.submit(e.ana, mov.order, mov.type, mov.data, mov.extras)?.status).toBe('confirmed')
    // Moving it again from the source: it is no longer there.
    expect(e.submit(e.ana, mov.order, mov.type, mov.data, mov.extras)).toMatchObject({
      status: 'rejected',
      reason: 'item_not_found',
    })
  })

  it('the same move resent (lost response) gets the same answer and does not move twice', () => {
    const e = withSentDish()
    const target = e.open(e.ana, newId()).order
    const mov = e.movement(target)
    const event = {
      id: newId(),
      type: mov.type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: mov.order,
      related: [target],
      data: mov.data,
      session_id: null,
      user_id: e.ana.userId,
      device_id: e.ana.deviceId,
      authorization_id: null,
      reason: null,
      device_time: NOW,
      hub_estimated_time: NOW,
      base_sequence: e.m.store.maxSequence(),
    }
    const connection = connectionOf(e.m, e.ana)
    const a = e.m.hub().receiveBatch(connection, [event])
    const b = e.m.hub().receiveBatch(connection, [event])
    expect(a.results[0]?.status).toBe('confirmed')
    expect(b.results).toEqual(a.results)
    expect(b.acceptedEvents).toEqual([])
    expect(Object.keys(e.m.hub().order(target)?.items ?? {})).toEqual([e.it.item_id])
  })

  it('the event reaches both orders: the hub counts it in the source and in the target', () => {
    const e = withSentDish()
    const target = e.open(e.ana, newId()).order
    const mov = e.movement(target)
    e.submit(e.ana, mov.order, mov.type, mov.data, mov.extras)
    const ofTarget = e.m.store.aggregateEvents(target).map((x) => x.type)
    expect(ofTarget).toEqual(['OrderOpened', 'ItemsMoved'])
  })
})

describe('several restaurants in the same database', () => {
  function twoHubs() {
    const { db, restaurantId } = sqliteDatabase()
    const other = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(other, other, NOW, NOW)
    const create = (id: string) =>
      new HubSync(new SqliteStore(db, id), {
        restaurantId: id,
        timeZone: 'America/Bogota',
        businessDayStart: '06:00',
        instance: `hub-${id}`,
        clock: () => NOW,
        access: openAccess,
      })
    return { db, one: create(restaurantId), two: create(other), restaurantId, other }
  }
  const deviceConn = (): Connection => ({
    deviceId: newId(),
    type: 'waiter',
    revokedAt: null,
  })
  const envelope = (
    withIt: Connection,
    order: string,
    type: string,
    data: unknown,
    base_sequence = 0,
  ) => ({
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: order,
    related: [],
    data,
    session_id: null,
    user_id: newId(),
    device_id: withIt.deviceId,
    authorization_id: null,
    reason: null,
    device_time: NOW,
    hub_estimated_time: NOW,
    base_sequence,
  })

  it('the same table in two restaurants does not clash: not when opening, merging or moving', () => {
    const { one, two } = twoHubs()
    const [cOne, cTwo] = [deviceConn(), deviceConn()]
    const [table, another] = [newId(), newId()]
    const a = newId()
    const b = newId()
    expect(
      one.receiveBatch(cOne, [
        envelope(cOne, a, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 1 }),
      ]).results[0]?.status,
    ).toBe('confirmed')
    expect(
      two.receiveBatch(cTwo, [
        envelope(cTwo, b, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 1 }),
      ]).results[0],
    ).toMatchObject({ status: 'confirmed', conflict: null })
    // Merging it in one does not occupy it in the other.
    one.receiveBatch(cOne, [envelope(cOne, a, 'TablesMerged', { table_ids: [another] }, 1)])
    expect(one.hasOpenOrder(another)).toBe(true)
    expect(two.hasOpenOrder(another)).toBe(false)
    expect(
      two.receiveBatch(cTwo, [
        envelope(cTwo, b, 'OrderMovedTable', { target_table_id: another }, 1),
      ]).results[0]?.status,
    ).toBe('confirmed')
  })

  it('each hub only sees and numbers its own', () => {
    const { one, two, db, restaurantId, other } = twoHubs()
    const [cOne, cTwo] = [deviceConn(), deviceConn()]
    const table = newId()
    one.receiveBatch(cOne, [
      envelope(cOne, newId(), 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 1 }),
    ])
    expect(two.hasOpenOrder(table)).toBe(false)
    two.receiveBatch(cTwo, [
      envelope(cTwo, newId(), 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 1 }),
    ])
    const check = (r: string) =>
      db.prepare('SELECT count(*) AS n FROM events WHERE restaurant_id = ?').get(r)?.n
    expect([check(restaurantId), check(other)]).toEqual([1, 1])
    // A new hub on the same database rebuilds only its own restaurant's data.
    const restarted = new HubSync(new SqliteStore(db, restaurantId), {
      restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-new',
      clock: () => NOW,
      access: openAccess,
    })
    expect(restarted.hasOpenOrder(table)).toBe(true)
    expect(new FloorSync(restarted, () => null).hasOpenOrder(table)).toBe(true)
  })
})
