import { describe, expect, it } from 'vitest'
import { validateNewEvent } from '../events/order'
import { newId } from '../id'
import { again, event, itemCopy, TIME, WAITER } from '../testing/factory'
import { applyAll, issueOf } from '../testing/helpers'
import { applyEvent, rebuild } from './apply'
import type { OrderState } from './state'

// Merging tables for a large party (task 1.5): `TablesMerged` and `TablesSeparated` on the order,
// `OrderState.mergedTables` and how it interacts with changing tables.

/** Dine-in order opened at a known table. */
function withTable(): { order: string; table: string; status: OrderState }
function withTable(table: null): { order: string; table: null; status: OrderState }
function withTable(table: string | null = newId()) {
  const order = newId()
  const status = applyAll([
    event(order, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 2 }),
  ])
  return { order, table, status }
}

const merge = (order: string, ...tables: string[]) =>
  event(order, 'TablesMerged', { table_ids: tables })
const separate = (order: string, ...tables: string[]) =>
  event(order, 'TablesSeparated', { table_ids: tables })
const moveToTable = (order: string, table: string) =>
  event(order, 'OrderMovedTable', { target_table_id: table })

describe('TablesMerged', () => {
  it('a new order has no merged tables', () => {
    expect(withTable().status.mergedTables).toEqual([])
    expect(withTable(null).status.mergedTables).toEqual([])
  })

  it('adds the tables in the order they arrive and leaves the main one as is', () => {
    const { order, table, status } = withTable()
    const [a, b, c] = [newId(), newId(), newId()]
    const mergedResult = applyAll([merge(order, c, a), merge(order, b)], status)
    expect(mergedResult.mergedTables).toEqual([c, a, b])
    expect(mergedResult.tableId).toBe(table)
  })

  it('an order without a table (bar, takeout) does not merge tables and the state stays the same', () => {
    const { order, status } = withTable(null)
    const r = applyEvent(status, merge(order, newId()))
    expect(r.issue?.type).toBe('no_table')
    expect(r.status).toBe(status)
  })

  it('an order without a table that moves to one can merge', () => {
    const { order, status } = withTable(null)
    const table = newId()
    const another = newId()
    const r = applyAll([moveToTable(order, table), merge(order, another)], status)
    expect(r).toMatchObject({ tableId: table, mergedTables: [another] })
  })

  it('the main table in the list does not count twice: it is dropped and the others are merged', () => {
    const { order, table, status } = withTable()
    const another = newId()
    const mergedResult = applyAll([merge(order, table, another)], status)
    expect(mergedResult.mergedTables).toEqual([another])
  })

  it('merging only its own table changes nothing: tables_already_merged', () => {
    const { order, table, status } = withTable()
    const r = applyEvent(status, merge(order, table))
    expect(r.issue?.type).toBe('tables_already_merged')
    expect(r.status).toBe(status)
  })

  it('repeating a merge is tables_already_merged; mixing new with already merged adds only the new', () => {
    const { order, status } = withTable()
    const [a, b] = [newId(), newId()]
    const one = applyAll([merge(order, a)], status)
    expect(issueOf(one, merge(order, a))).toBe('tables_already_merged')
    const two = applyEvent(one, merge(order, a, b))
    expect(two.issue).toBeNull()
    expect(two.status?.mergedTables).toEqual([a, b])
  })

  it('never duplicates a table even if merged in different events', () => {
    const { order, status } = withTable()
    const m = newId()
    const r = applyAll([merge(order, m), merge(order, newId(), m)], status)
    expect(r.mergedTables.filter((x) => x === m)).toHaveLength(1)
  })

  it('does not modify the input state', () => {
    const { order, status } = withTable()
    const copy = structuredClone(status)
    applyEvent(status, merge(order, newId()))
    expect(status).toEqual(copy)
  })

  it.each(['closed', 'canceled'] as const)('a %s order: no merging or separating', (final) => {
    const { order, status } = withTable()
    const m = newId()
    const mergedResult = applyAll([merge(order, m)], status)
    const closed = applyAll(
      [
        event(
          order,
          final === 'closed' ? 'OrderClosed' : 'OrderCanceled',
          {},
          {
            reason: 'Prueba',
          },
        ),
      ],
      mergedResult,
    )
    expect(closed.status).toBe(final)
    expect(issueOf(closed, merge(order, newId()))).toBe('order_closed')
    expect(issueOf(closed, separate(order, m))).toBe('order_closed')
  })

  it('an order that does not exist has nothing to merge', () => {
    expect(issueOf(null, merge(newId(), newId()))).toBe('order_not_found')
  })

  it('a foreign event (another order) is not applied', () => {
    const { status } = withTable()
    expect(issueOf(status, merge(newId(), newId()))).toBe('foreign_event')
  })

  it('an already applied event is ignored (idempotent by sequence)', () => {
    const { order, status } = withTable()
    const e = merge(order, newId())
    const makeOne = applyEvent(status, e)
    expect(makeOne.issue).toBeNull()
    const another = applyEvent(makeOne.status, e)
    expect(another.issue?.type).toBe('event_already_applied')
    expect(another.status?.mergedTables).toEqual(makeOne.status?.mergedTables)
  })

  it('the same event with another id and sequence does not duplicate: tables_already_merged', () => {
    const { order, status } = withTable()
    const e = merge(order, newId())
    const makeOne = applyAll([e], status)
    expect(issueOf(makeOne, again(e))).toBe('tables_already_merged')
  })

  it('having merged tables changes neither the totals nor the items', () => {
    const { order, status } = withTable()
    const item = itemCopy()
    const withIt = applyAll([event(order, 'ItemAdded', item)], status)
    const mergedResult = applyAll([merge(order, newId())], withIt)
    expect({ ...mergedResult, mergedTables: [], lastSequence: 0 }).toEqual({
      ...withIt,
      lastSequence: 0,
    })
  })
})

describe('TablesSeparated', () => {
  it('releases the given tables and keeps the others', () => {
    const { order, status } = withTable()
    const [a, b, c] = [newId(), newId(), newId()]
    const mergedResult = applyAll([merge(order, a, b, c)], status)
    expect(applyAll([separate(order, b)], mergedResult).mergedTables).toEqual([a, c])
    expect(applyAll([separate(order, c, a)], mergedResult).mergedTables).toEqual([b])
    expect(applyAll([separate(order, a, b, c)], mergedResult).mergedTables).toEqual([])
  })

  it('a table that is not merged is not released: tables_not_merged and the state stays the same', () => {
    const { order, status } = withTable()
    const mergedResult = applyAll([merge(order, newId())], status)
    const r = applyEvent(mergedResult, separate(order, newId()))
    expect(r.issue?.type).toBe('tables_not_merged')
    expect(r.status).toBe(mergedResult)
  })

  it('an order without merged tables has nothing to separate', () => {
    const { order, status } = withTable()
    expect(issueOf(status, separate(order, newId()))).toBe('tables_not_merged')
  })

  it('the main table cannot be released with this event', () => {
    const { order, table, status } = withTable()
    const mergedResult = applyAll([merge(order, newId())], status)
    expect(issueOf(mergedResult, separate(order, table))).toBe('tables_not_merged')
  })

  it('with one merged and one not: releases the merged one without complaining', () => {
    const { order, status } = withTable()
    const a = newId()
    const mergedResult = applyAll([merge(order, a)], status)
    const r = applyEvent(mergedResult, separate(order, newId(), a))
    expect(r.issue).toBeNull()
    expect(r.status?.mergedTables).toEqual([])
  })

  it('separating twice: the second is tables_not_merged', () => {
    const { order, status } = withTable()
    const a = newId()
    const separated = applyAll([merge(order, a), separate(order, a)], status)
    expect(issueOf(separated, separate(order, a))).toBe('tables_not_merged')
  })

  it('a separated table can be merged again', () => {
    const { order, status } = withTable()
    const a = newId()
    const r = applyAll([merge(order, a), separate(order, a), merge(order, a)], status)
    expect(r.mergedTables).toEqual([a])
  })
})

describe('changing tables with merged tables', () => {
  it('moving to one of its merged tables makes it the main one and it is no longer counted separately', () => {
    const { order, table, status } = withTable()
    const [a, b] = [newId(), newId()]
    const mergedResult = applyAll([merge(order, a, b)], status)
    const r = applyAll([moveToTable(order, a)], mergedResult)
    expect(r.tableId).toBe(a)
    // The previous table becomes free: it does not become "merged".
    expect(r.mergedTables).toEqual([b])
    expect(r.mergedTables).not.toContain(table)
    expect(r.mergedTables).not.toContain(a)
  })

  it('moving to a new table keeps the group (the merged ones stay merged)', () => {
    const { order, status } = withTable()
    const [a, newOne] = [newId(), newId()]
    const r = applyAll([merge(order, a), moveToTable(order, newOne)], status)
    expect(r).toMatchObject({ tableId: newOne, mergedTables: [a] })
  })

  it('moving to the table it is already at is valid and does not touch the merged ones', () => {
    const { order, table, status } = withTable()
    const a = newId()
    const r = applyAll([merge(order, a), moveToTable(order, table)], status)
    expect(r).toMatchObject({ tableId: table, mergedTables: [a] })
  })

  it('moving away and back to a table never leaves the main one among the merged ones', () => {
    const { order, table, status } = withTable()
    const a = newId()
    const r = applyAll([merge(order, a), moveToTable(order, a), moveToTable(order, table)], status)
    expect(r.tableId).toBe(table)
    expect(r.mergedTables).not.toContain(table)
  })

  it('after moving to a merged table, it can no longer be released as merged', () => {
    const { order, status } = withTable()
    const a = newId()
    const r = applyAll([merge(order, a), moveToTable(order, a)], status)
    expect(issueOf(r, separate(order, a))).toBe('tables_not_merged')
  })

  it('a bar order that moves to a table ends up with a table and no merged ones', () => {
    const { order, status } = withTable(null)
    const table = newId()
    expect(applyAll([moveToTable(order, table)], status)).toMatchObject({
      tableId: table,
      mergedTables: [],
    })
  })
})

describe('rebuild with merged tables', () => {
  it('the same result when rebuilding as when applying one by one', () => {
    const { order, status } = withTable()
    const [a, b] = [newId(), newId()]
    const events = [
      merge(order, a, b),
      moveToTable(order, a),
      separate(order, b),
      merge(order, newId()),
    ]
    const one = applyAll(events, status)
    const opened = event(order, 'OrderOpened', {
      channel: 'dine_in',
      table_id: status.tableId,
      guests: 2,
    })
    const all = [opened, ...events].map((e, i) => ({ ...e, sequence: i + 1 }))
    const rec = rebuild(all, order)
    expect(rec?.mergedTables).toEqual(one.mergedTables)
    expect(rec?.tableId).toBe(one.tableId)
  })

  it('a merge event tolerates extra or missing data without throwing (ends up as invalid_event)', () => {
    const { order, status } = withTable()
    const faulty = { ...merge(order, newId()), data: {} } as unknown as Parameters<
      typeof applyEvent
    >[1]
    const r = applyEvent(status, faulty)
    expect(r.issue).not.toBeNull()
    expect(r.status).toEqual(status)
  })
})

describe('schema of TablesMerged and TablesSeparated', () => {
  const envelope = (type: string, data: unknown) => ({
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    related: [],
    data,
    session_id: null,
    user_id: WAITER,
    device_id: newId(),
    authorization_id: null,
    reason: null,
    device_time: TIME,
    hub_estimated_time: TIME,
    base_sequence: 0,
  })
  const ok = (type: string, data: unknown) => validateNewEvent(envelope(type, data)).ok
  const ids = (n: number) => Array.from({ length: n }, () => newId())

  it.each(['TablesMerged', 'TablesSeparated'])('%s accepts 1 to 10 distinct tables', (type) => {
    expect(ok(type, { table_ids: ids(1) })).toBe(true)
    expect(ok(type, { table_ids: ids(10) })).toBe(true)
  })

  it.each(['TablesMerged', 'TablesSeparated'])(
    '%s rejects empty, more than 10, repeated, bad ids and extra fields',
    (type) => {
      const repeated = newId()
      expect(ok(type, { table_ids: [] })).toBe(false)
      expect(ok(type, { table_ids: ids(11) })).toBe(false)
      expect(ok(type, { table_ids: [repeated, repeated] })).toBe(false)
      expect(ok(type, { table_ids: ['mesa-5'] })).toBe(false)
      expect(ok(type, { table_ids: [newId().toLowerCase()] })).toBe(false)
      expect(ok(type, { table_ids: 'x' })).toBe(false)
      expect(ok(type, {})).toBe(false)
      expect(ok(type, { table_ids: ids(1), extra: 1 })).toBe(false)
      expect(ok(type, { table_ids: ids(1).concat([null as unknown as string]) })).toBe(false)
    },
  )

  it('they are order events (order aggregate) and require no reason', () => {
    expect(validateNewEvent(envelope('TablesMerged', { table_ids: ids(2) })).ok).toBe(true)
    expect(
      validateNewEvent({
        ...envelope('TablesMerged', { table_ids: ids(2) }),
        aggregate_type: 'product',
      }).ok,
    ).toBe(false)
  })
})
