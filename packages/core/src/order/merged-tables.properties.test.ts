import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { newId } from '../id'
import { event } from '../testing/factory'
import { applyAll } from '../testing/helpers'
import { type Action, actionArb, Service } from '../testing/simulator'
import { applyEvent } from './apply'
import type { OrderState } from './state'
import { orderTotals } from './totals'

// Properties of merging tables (task 1.5): a minimal model written separately against the reducer,
// and the invariants over the service simulator's sequences. Fixed seed.

const CONFIG = { seed: 20_261_025, numRuns: 400 }
const TABLES = Array.from({ length: 6 }, () => newId())

type Step =
  | { t: 'merge'; tables: number[] }
  | { t: 'separate'; tables: number[] }
  | { t: 'moveToTable'; table: number }

const indices = fc.uniqueArray(fc.nat(TABLES.length - 1), { minLength: 1, maxLength: 4 })
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  indices.map((tables): Step => ({ t: 'merge', tables })),
  indices.map((tables): Step => ({ t: 'separate', tables })),
  fc.nat(TABLES.length - 1).map((table): Step => ({ t: 'moveToTable', table })),
)

/** What the document says: the model, without touching the reducer. */
interface Model {
  main: string | null
  merged: string[]
}

function applyToModel(m: Model, p: Step): { model: Model; issue: string | null } {
  if (p.t === 'moveToTable') {
    const table = TABLES[p.table] as string
    return {
      model: { main: table, merged: m.merged.filter((x) => x !== table) },
      issue: null,
    }
  }
  const given = p.tables.map((i) => TABLES[i] as string)
  if (p.t === 'merge') {
    if (!m.main) return { model: m, issue: 'no_table' }
    const newTables = given.filter((x) => x !== m.main && !m.merged.includes(x))
    if (newTables.length === 0) return { model: m, issue: 'tables_already_merged' }
    return { model: { ...m, merged: [...m.merged, ...newTables] }, issue: null }
  }
  if (!m.merged.some((x) => given.includes(x))) return { model: m, issue: 'tables_not_merged' }
  return { model: { ...m, merged: m.merged.filter((x) => !given.includes(x)) }, issue: null }
}

const asEvent = (order: string, p: Step) =>
  p.t === 'moveToTable'
    ? event(order, 'OrderMovedTable', { target_table_id: TABLES[p.table] as string })
    : event(order, p.t === 'merge' ? 'TablesMerged' : 'TablesSeparated', {
        table_ids: p.tables.map((i) => TABLES[i] as string),
      })

const noDuplicates = (list: readonly string[]) => new Set(list).size === list.length

describe('merged tables: the reducer against a model', () => {
  it.each([
    ['with a table', true],
    ['without a table (bar)', false],
  ])('order %s: same tables and same issues as the model in any sequence', (_n, withTable) => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 40 }), (steps) => {
        const order = newId()
        let status: OrderState | null = applyAll([
          event(order, 'OrderOpened', {
            channel: 'dine_in',
            table_id: withTable ? (TABLES[0] as string) : null,
            guests: 2,
          }),
        ])
        let model: Model = { main: withTable ? (TABLES[0] as string) : null, merged: [] }
        for (const step of steps) {
          const expected = applyToModel(model, step)
          const r = applyEvent(status, asEvent(order, step))
          expect(r.issue?.type ?? null).toBe(expected.issue)
          status = r.status
          model = expected.model
          expect(status?.tableId).toBe(model.main)
          expect(status?.mergedTables).toEqual(model.merged)
          // Invariants: no duplicates, and the main table is never among the merged ones.
          expect(noDuplicates(status?.mergedTables ?? [])).toBe(true)
          if (status?.tableId) expect(status.mergedTables).not.toContain(status.tableId)
        }
      }),
      CONFIG,
    )
  })

  it('a rejected event leaves the state exactly the same (same reference)', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const order = newId()
        let status: OrderState | null = applyAll([
          event(order, 'OrderOpened', {
            channel: 'dine_in',
            table_id: TABLES[0] as string,
            guests: 1,
          }),
        ])
        for (const step of steps) {
          const r = applyEvent(status, asEvent(order, step))
          if (r.issue) expect(r.status).toBe(status)
          status = r.status
        }
      }),
      { ...CONFIG, seed: 20_261_026 },
    )
  })

  it('the tables an order occupies (main + merged) are always distinct', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 40 }), (steps) => {
        const order = newId()
        let status = applyAll([
          event(order, 'OrderOpened', {
            channel: 'dine_in',
            table_id: TABLES[0] as string,
            guests: 1,
          }),
        ])
        for (const step of steps) {
          status = applyEvent(status, asEvent(order, step)).status as OrderState
          const occupiedIds = [status.tableId, ...status.mergedTables].filter(Boolean) as string[]
          expect(noDuplicates(occupiedIds)).toBe(true)
        }
      }),
      { ...CONFIG, seed: 20_261_027 },
    )
  })
})

describe('merged tables with the service simulator', () => {
  const sequence = fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' })

  it('on any path, merged tables never repeat nor include the main table', () => {
    fc.assert(
      fc.property(sequence, (actions) => {
        const service = new Service()
        for (const action of actions) {
          service.step(action)
          for (const status of service.statuses) {
            if (!status) continue
            expect(noDuplicates(status.mergedTables)).toBe(true)
            if (status.tableId) expect(status.mergedTables).not.toContain(status.tableId)
          }
        }
        expect(service.invalidCases).toEqual([])
      }),
      CONFIG,
    )
  })

  it('merging, separating and changing tables do not move money, items or payments', () => {
    let mergedCount = 0
    fc.assert(
      fc.property(sequence, (actions) => {
        const service = new Service()
        for (const action of actions as Action[]) {
          const before = service.statuses.map((e) => (e ? structuredClone(e) : null))
          const length = service.log.length
          service.step(action)
          const fresh = service.log.at(-1)
          if (service.log.length === length || !fresh) continue
          if (!['TablesMerged', 'TablesSeparated', 'OrderMovedTable'].includes(fresh.type)) continue
          if (service.appliedEvents.at(-1) !== fresh) continue
          if (fresh.type === 'TablesMerged') mergedCount += 1
          const p = service.orders.indexOf(fresh.aggregate_id)
          const a = before[p]
          const d = service.statuses[p]
          if (!a || !d) throw new Error('missing order')
          expect(orderTotals(d)).toEqual(orderTotals(a))
          expect(d.items).toEqual(a.items)
          expect(d.payments).toEqual(a.payments)
          expect(d.discounts).toEqual(a.discounts)
          expect(d.status).toBe(a.status)
          // And the other order is not affected at all.
          expect(service.statuses[1 - p]).toEqual(before[1 - p])
        }
      }),
      { ...CONFIG, seed: 20_261_028 },
    )
    // The simulator does exercise merging: without this the property would prove nothing.
    expect(mergedCount).toBeGreaterThan(0)
  })
})
