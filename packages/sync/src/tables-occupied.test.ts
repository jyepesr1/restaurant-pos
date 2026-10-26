import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import type { NetNode } from './testing/network'
import { item, NOW, type Setup, setup } from './testing/setup'

// `hasOpenOrder` (task 1.2): what the floor plan editor checks before archiving a
// table. Tested with real events against the hub, without going through the client.

const connectionOf = (m: Setup, node: NetNode) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`No token for ${node.name}`)
  return connection
}

const WITH_REASON = new Set(['OrderCanceled', 'OrderReopened'])

function device() {
  const m = setup()
  const node = m.network.device('ana')
  const other = m.network.device('beto')
  // By default the device knows everything the hub has (base_sequence = the latest).
  const sendFrom = (
    who: NetNode,
    order: string,
    type: string,
    data: unknown,
    extras: object = {},
  ) => {
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
        base_sequence: m.store.maxSequence(),
        ...extras,
      },
    ])
    return r.results[0]
  }
  const send = (order: string, type: string, data: unknown, extras: object = {}) =>
    sendFrom(node, order, type, data, extras)
  const open = (table: string | null, order = newId()) => {
    const r = send(order, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 2 })
    return { order, result: r }
  }
  return { m, node, other, send, sendFrom, open }
}

describe('HubSync.hasOpenOrder', () => {
  it('a table with no orders, or that does not exist, is not occupied', () => {
    const { m } = device()
    expect(m.hub().hasOpenOrder(newId())).toBe(false)
    expect(m.hub().hasOpenOrder('')).toBe(false)
  })

  it('is occupied when the order opens and freed when it closes', () => {
    const { m, send, open } = device()
    const table = newId()
    const { order } = open(table)
    expect(m.hub().hasOpenOrder(table)).toBe(true)
    expect(send(order, 'OrderClosed', {})?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(table)).toBe(false)
  })

  it('is freed when the order is canceled', () => {
    const { m, send, open } = device()
    const table = newId()
    const { order } = open(table)
    send(order, 'ItemAdded', item())
    expect(m.hub().hasOpenOrder(table)).toBe(true)
    expect(send(order, 'OrderCanceled', {})?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(table)).toBe(false)
  })

  it('a reopened order occupies its table again', () => {
    const { m, send, open } = device()
    const table = newId()
    const { order } = open(table)
    send(order, 'OrderClosed', {})
    expect(m.hub().hasOpenOrder(table)).toBe(false)
    expect(send(order, 'OrderReopened', {})?.status).toBe('confirmed')
    expect(m.hub().hasOpenOrder(table)).toBe(true)
  })

  it('an order that could not close (balance due) still occupies the table', () => {
    const { m, send, open } = device()
    const table = newId()
    const { order } = open(table)
    send(order, 'ItemAdded', item())
    expect(send(order, 'OrderClosed', {})).toMatchObject({
      status: 'rejected',
      reason: 'pending_balance',
    })
    expect(m.hub().hasOpenOrder(table)).toBe(true)
  })

  it('moving the order to another table frees the source and occupies the target', () => {
    const { m, send, open } = device()
    const source = newId()
    const target = newId()
    const { order } = open(source)
    send(order, 'OrderMovedTable', { target_table_id: target })
    expect(m.hub().hasOpenOrder(source)).toBe(false)
    expect(m.hub().hasOpenOrder(target)).toBe(true)
  })

  it('an order without a table (bar, takeout) occupies none', () => {
    const { m, open } = device()
    open(null)
    expect(m.hub().hasOpenOrder(newId())).toBe(false)
  })

  it('with several orders on the same table (conflict), it stays occupied until the last closes', () => {
    const { m, other, send, sendFrom, open } = device()
    const table = newId()
    const one = open(table)
    // Another waiter opens the same table without knowing about the first order (base_sequence 0):
    // it is accepted and the register is alerted.
    const two = newId()
    const r = sendFrom(
      other,
      two,
      'OrderOpened',
      { channel: 'dine_in', table_id: table, guests: 1 },
      { base_sequence: 0 },
    )
    expect(r).toMatchObject({ status: 'confirmed', conflict: 'duplicate_table' })
    send(one.order, 'OrderClosed', {})
    expect(m.hub().hasOpenOrder(table)).toBe(true)
    sendFrom(other, two, 'OrderClosed', {})
    expect(m.hub().hasOpenOrder(table)).toBe(false)
  })

  it('a rejected order (occupied table the device knew about) does not count twice', () => {
    const { m, other: beto, send, sendFrom } = device()
    const table = newId()
    const one = newId()
    send(one, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 2 })
    // Beto already knew the first order (his base is the latest): it is rejected.
    const other = sendFrom(beto, newId(), 'OrderOpened', {
      channel: 'dine_in',
      table_id: table,
      guests: 1,
    })
    expect(other).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    send(one, 'OrderClosed', {})
    expect(m.hub().hasOpenOrder(table)).toBe(false)
  })

  it('when the hub restarts, occupied tables are rebuilt from the stored events', () => {
    const { m, send, open } = device()
    const takenPath = newId()
    const closedSession = newId()
    const canceledOrder = newId()
    open(takenPath)
    send(open(closedSession).order, 'OrderClosed', {})
    send(open(canceledOrder).order, 'OrderCanceled', {})
    m.network.crashHub()
    const fresh = m.hub()
    expect(fresh.hasOpenOrder(takenPath)).toBe(true)
    expect(fresh.hasOpenOrder(closedSession)).toBe(false)
    expect(fresh.hasOpenOrder(canceledOrder)).toBe(false)
  })

  it('FloorSync answers the same as the hub', () => {
    const { m, open } = device()
    const table = newId()
    open(table)
    expect(m.network.floor.hasOpenOrder(table)).toBe(true)
    expect(m.network.floor.hasOpenOrder(newId())).toBe(false)
  })

  it('answers correctly with many open and closed orders', () => {
    const { m, send, open } = device()
    const tables = Array.from({ length: 60 }, () => newId())
    const orders = tables.map((table) => open(table).order)
    // The even ones are closed.
    for (const [i, p] of orders.entries()) if (i % 2 === 0) send(p, 'OrderClosed', {})
    for (const [i, table] of tables.entries()) expect(m.hub().hasOpenOrder(table)).toBe(i % 2 === 1)
  })
})
