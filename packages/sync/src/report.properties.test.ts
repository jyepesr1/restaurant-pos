import {
  newId,
  type OrderEvent,
  type OrderState,
  orderTotals,
  rebuild,
  report,
  shiftReconciliation,
} from '@pos/core'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { actionArb } from '../../core/src/testing/simulator'
import { reportData, savedReconciliation, shiftClose } from './hub/report'
import { MemoryStore } from './hub/store'
import { SqliteStore } from './hub/store-sqlite'
import { buildHistory, DAYS, type HistoryPlan, load } from './testing/histories'
import { NOW, sqliteDatabase } from './testing/setup'

// What the hub reads from the database for reports (task 1.9, docs/KPIS.md#período), with random
// histories from the reducer simulator: payments, voids and refunds from another day, orders
// reopened and closed again, and register shifts. The same with the in-memory store and SQLite.

const CONFIG = { seed: 20_261_041, numRuns: 120 }
const REPORT_CONFIG = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const

const plan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 70, size: 'max' }),
  days: fc.array(fc.nat(2), { minLength: 1, maxLength: 150 }),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})
const consoleLines = fc.record({ from: fc.nat(2), length: fc.nat(2) })
const range = (v: { from: number; length: number }) => ({
  from: DAYS[Math.min(v.from, 2)] as string,
  until: DAYS[Math.min(v.from + v.length, 2)] as string,
})

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

function stores(events: readonly OrderEvent[]) {
  const memory = new MemoryStore()
  load(memory, events)
  const { db, restaurantId } = sqliteDatabase()
  const sqlite = new SqliteStore(db, restaurantId)
  load(sqlite, events)
  return { memory, sqlite, db, restaurantId }
}

describe('reportData with random histories', () => {
  it('is the same with the in-memory store, with SQLite and after reopening the database', () => {
    fc.assert(
      fc.property(plan, consoleLines, (p, v) => {
        const h = buildHistory(p)
        const { memory, sqlite, db, restaurantId } = stores(h.events)
        const { from, until } = range(v)
        const inMemory = reportData(memory, from, until)
        const inSqlite = reportData(sqlite, from, until)
        expect(inSqlite).toEqual(inMemory)
        // «Restart the hub»: another store over the same database gives the same.
        expect(reportData(new SqliteStore(db, restaurantId), from, until)).toEqual(inMemory)
        // And the report that comes out of them.
        expect(report({ ...inSqlite, config: REPORT_CONFIG })).toEqual(
          report({ ...inMemory, config: REPORT_CONFIG }),
        )
      }),
      CONFIG,
    )
  })

  it('there is one close per OrderClosed in the period, with the order at closing and at its previous close', () => {
    fc.assert(
      fc.property(plan, consoleLines, (p, v) => {
        const h = buildHistory(p)
        const { memory, sqlite } = stores(h.events)
        const { from, until } = range(v)
        const data = reportData(memory, from, until)
        expect(reportData(sqlite, from, until).closings).toEqual(data.closings)
        const closings = h.events.filter(
          (e) => e.type === 'OrderClosed' && e.business_day >= from && e.business_day <= until,
        )
        expect(data.closings).toHaveLength(closings.length)
        for (const [i, c] of closings.entries()) {
          const datum = data.closings[i]
          const priors = h.events.filter(
            (e) =>
              e.type === 'OrderClosed' &&
              e.aggregate_id === c.aggregate_id &&
              e.sequence < c.sequence,
          )
          const upto1 = (sequence: number) =>
            rebuild(
              h.events.filter((e) => e.sequence <= sequence),
              c.aggregate_id,
            )
          expect(datum?.after).toEqual(upto1(c.sequence))
          // The first close has no previous one; the rest start from the close right before.
          const previous = priors.at(-1)
          expect(datum?.before ?? null).toEqual(previous ? upto1(previous.sequence) : null)
          expect(datum?.after.status).toBe('closed')
        }
      }),
      { ...CONFIG, seed: 20_261_042 },
    )
  })

  it('the period events are those of its days, in order, and each reversal brings its payment', () => {
    fc.assert(
      fc.property(plan, consoleLines, (p, v) => {
        const h = buildHistory(p)
        const { sqlite } = stores(h.events)
        const { from, until } = range(v)
        const data = reportData(sqlite, from, until)
        const sequences = data.events.map((e) => e.sequence)
        expect(sequences).toEqual([...sequences].sort((a, b) => (a ?? 0) - (b ?? 0)))
        expect(new Set(data.events.map((e) => e.id)).size).toBe(data.events.length)
        const payments = new Set(
          data.events.filter((e) => e.type === 'PaymentRecorded').map((e) => e.data.payment_id),
        )
        const fromPeriod = h.events.filter(
          (e) =>
            e.business_day >= from &&
            e.business_day <= until &&
            [
              'PaymentRecorded',
              'PaymentVoided',
              'RefundRecorded',
              'ItemVoided',
              'OrderCanceled',
              'CashMovementRecorded',
            ].includes(e.type),
        )
        // Everything from the period is there, and the extras are only payments from another day
        // that someone reversed.
        const ids = new Set(data.events.map((e) => e.id))
        for (const e of fromPeriod) expect(ids).toContain(e.id)
        const dayIds = new Set(fromPeriod.map((e) => e.id))
        for (const e of data.events) {
          if (dayIds.has(e.id)) continue
          expect(e.type).toBe('PaymentRecorded')
          expect(
            data.events.some(
              (x) =>
                (x.type === 'PaymentVoided' || x.type === 'RefundRecorded') &&
                x.data.payment_id === (e.data as { payment_id: string }).payment_id,
            ),
          ).toBe(true)
        }
        for (const e of data.events) {
          if (e.type === 'PaymentVoided' || e.type === 'RefundRecorded')
            expect(payments).toContain(e.data.payment_id)
        }
      }),
      { ...CONFIG, seed: 20_261_043 },
    )
  })

  it('voids and refunds of a payment from another day subtract on the day they are recorded', () => {
    fc.assert(
      fc.property(plan, consoleLines, (p, v) => {
        const h = buildHistory(p)
        const { sqlite } = stores(h.events)
        const { from, until } = range(v)
        const r = report({ ...reportData(sqlite, from, until), config: REPORT_CONFIG })
        // Separately, over all events: the money that came in or went out per method on those days.
        const payments = new Map(
          h.events
            .filter((e) => e.type === 'PaymentRecorded')
            .map((e) => [e.data.payment_id, e.data] as const),
        )
        const expected = new Map<string, number>()
        const move = (key: string, n: number) => expected.set(key, (expected.get(key) ?? 0) + n)
        for (const e of h.events) {
          if (e.business_day < from || e.business_day > until) continue
          if (e.type === 'PaymentRecorded')
            move(
              `${e.data.method}:${e.data.custom_method_id ?? ''}`,
              e.data.amount + e.data.rounding_adjustment,
            )
          else if (e.type === 'PaymentVoided') {
            const o = payments.get(e.data.payment_id)
            if (o)
              move(`${o.method}:${o.custom_method_id ?? ''}`, -(o.amount + o.rounding_adjustment))
          } else if (e.type === 'RefundRecorded') {
            const o = payments.get(e.data.payment_id)
            move(`${e.data.method}:${o?.custom_method_id ?? ''}`, -e.data.sale_amount)
          }
        }
        for (const m of r.byMethod)
          expect(m.sale, `${m.method}`).toBe(
            expected.get(`${m.method}:${m.customMethodId ?? ''}`) ?? 0,
          )
        // What did not show up in the report must be 0 in the oracle.
        const emitted = new Set(r.byMethod.map((m) => `${m.method}:${m.customMethodId ?? ''}`))
        for (const [key, n] of expected) if (!emitted.has(key)) expect(n).toBe(0)
      }),
      { ...CONFIG, seed: 20_261_044 },
    )
  })

  it('each void is worth units × the price with extras the item had, wherever it is today', () => {
    fc.assert(
      fc.property(plan, consoleLines, (p, v) => {
        const h = buildHistory(p)
        const { sqlite } = stores(h.events)
        const { from, until } = range(v)
        const r = report({ ...reportData(sqlite, from, until), config: REPORT_CONFIG })
        // Each item's price, taken from when it was added or from the copy that traveled on move or
        // merge.
        const prices = new Map<string, number>()
        const copy = (i: {
          item_id: string
          unit_price: number
          modifiers: { extra_price: number }[]
        }) => prices.set(i.item_id, i.unit_price + sum(i.modifiers.map((m) => m.extra_price)))
        for (const e of h.events) {
          if (e.type === 'ItemAdded') copy(e.data)
          else if (e.type === 'ItemsMoved' || e.type === 'OrdersMerged')
            for (const m of e.data.items) copy(m.item)
        }
        const voidedEvents = h.events.filter(
          (e) => e.type === 'ItemVoided' && e.business_day >= from && e.business_day <= until,
        )
        expect(r.voids.map((a) => a.eventId)).toEqual(voidedEvents.map((e) => e.id))
        for (const [i, a] of r.voids.entries()) {
          const e = voidedEvents[i]
          if (e?.type !== 'ItemVoided') throw new Error('out of order')
          expect(a.value).toBe(e.data.quantity * (prices.get(e.data.item_id) ?? Number.NaN))
          expect(a.name).not.toBe('Producto')
        }
      }),
      { ...CONFIG, seed: 20_261_049 },
    )
  })

  it('the period net is what was paid beyond the previous close at each close, without refunds', () => {
    const paid = (p: OrderState | null) =>
      sum(
        Object.values(p?.payments ?? {})
          .filter((x) => !x.voided)
          .map((x) => x.amount - x.refundedSale),
      )
    fc.assert(
      fc.property(plan, consoleLines, (p, v) => {
        const h = buildHistory(p)
        const { memory } = stores(h.events)
        const { from, until } = range(v)
        const data = reportData(memory, from, until)
        const r = report({ ...data, config: REPORT_CONFIG })
        expect(r.sales.net).toBe(sum(data.closings.map((c) => paid(c.after) - paid(c.before))))
        expect(sum(r.byProduct.map((x) => x.net))).toBe(r.sales.net)
        expect(sum(r.byWaiter.map((x) => x.net))).toBe(r.sales.net)
        expect(sum(r.sales.taxes.map((x) => x.base + x.tax))).toBe(r.sales.net)
        // A check and its guests are counted once: at the first close.
        expect(r.sales.guests).toBe(
          sum(data.closings.filter((c) => c.before === null).map((c) => c.after.guests)),
        )
      }),
      { ...CONFIG, seed: 20_261_045 },
    )
  })
})

describe('register shifts read from the database', () => {
  it('the saved reconciliation, the shift charges and the close are the same in memory and in SQLite', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const h = buildHistory(p)
        const { memory, sqlite } = stores(h.events)
        for (const [n, shift] of h.shifts.entries()) {
          const opening = DAYS[0]
          const expectedCharges = h.events.filter(
            (e) =>
              ['PaymentRecorded', 'PaymentVoided', 'RefundRecorded'].includes(e.type) &&
              (e.data as { register_shift_id?: string }).register_shift_id === shift,
          )
          expect(memory.shiftCharges(shift, opening).map((e) => e.id)).toEqual(
            expectedCharges.map((e) => e.id),
          )
          expect(sqlite.shiftCharges(shift, opening).map((e) => e.id)).toEqual(
            expectedCharges.map((e) => e.id),
          )
          // The reconciliation from the database is the shift's, calculated with all events.
          const completed = shiftReconciliation(h.events, shift)
          expect(savedReconciliation(sqlite, shift)).toEqual(completed)
          expect(savedReconciliation(memory, shift)).toEqual(completed)
          const closeout = shiftClose(sqlite, shift)
          expect(shiftClose(memory, shift)).toEqual(closeout)
          if (p.closes[n as 0 | 1]) {
            expect(closeout?.reconciliation.closed).not.toBeNull()
            expect(closeout?.businessDay).toBe(DAYS[2])
            expect(closeout?.openingDay).toBe(DAYS[0])
          } else expect(closeout).toBeNull()
        }
      }),
      { ...CONFIG, seed: 20_261_046 },
    )
  })

  it('a shift never opened or made up has no reconciliation, close or charges', () => {
    const { memory, sqlite } = stores([])
    for (const a of [memory, sqlite]) {
      const id = newId()
      expect(savedReconciliation(a, id)).toBeNull()
      expect(shiftClose(a, id)).toBeNull()
      expect(a.shiftCharges(id, DAYS[0])).toEqual([])
      expect(a.periodEvents(['OrderClosed'], DAYS[0], DAYS[2])).toEqual([])
      expect(a.periodEvents([], DAYS[0], DAYS[2])).toEqual([])
    }
  })
})

describe('multi-restaurant: the report of one does not see the other', () => {
  /** A database with two restaurants: the second is added to the setup's one. */
  function twoRestaurants() {
    const { db, restaurantId: a } = sqliteDatabase()
    const b = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(b, b, NOW, NOW)
    return { db, a, b }
  }

  it('with different histories, each report is the same as without the other restaurant', () => {
    fc.assert(
      fc.property(plan, plan, consoleLines, (pa, pb, v) => {
        const ha = buildHistory(pa)
        const hb = buildHistory(pb)
        const { db, a, b } = twoRestaurants()
        const storeA = new SqliteStore(db, a)
        const storeB = new SqliteStore(db, b)
        // Interleaved: A, B, A, B...
        const n = Math.max(ha.events.length, hb.events.length)
        for (let i = 0; i < n; i++) {
          const ea = ha.events[i]
          const eb = hb.events[i]
          if (ea) load(storeA, [ea])
          if (eb) load(storeB, [eb])
        }
        const only = (events: OrderEvent[]) => {
          const m = new MemoryStore()
          load(m, events)
          return m
        }
        const { from, until } = range(v)
        expect(reportData(storeA, from, until)).toEqual(reportData(only(ha.events), from, until))
        expect(reportData(storeB, from, until)).toEqual(reportData(only(hb.events), from, until))
        // The shifts of one do not exist for the other (the simulator shares the SHIFT id: each
        // restaurant's reconciliations count only its own payments).
        for (const t of ha.shifts) {
          expect(savedReconciliation(storeA, t)).toEqual(savedReconciliation(only(ha.events), t))
          expect(savedReconciliation(storeB, t)).toEqual(savedReconciliation(only(hb.events), t))
        }
      }),
      { ...CONFIG, numRuns: 40, seed: 20_261_047 },
    )
  })

  it('with the same ids in both, what belongs to one never shows up in the other', () => {
    const h = buildHistory({
      actions: [],
      days: [1],
      closes: [true, true],
      tips: [0, 0],
    })
    const { db, a, b } = twoRestaurants()
    const storeA = new SqliteStore(db, a)
    const storeB = new SqliteStore(db, b)
    load(storeA, h.events)
    for (const t of h.shifts) {
      expect(shiftClose(storeA, t)).not.toBeNull()
      expect(shiftClose(storeB, t)).toBeNull()
      expect(savedReconciliation(storeB, t)).toBeNull()
      expect(storeB.shiftCharges(t, DAYS[0])).toEqual([])
    }
    const empty = reportData(storeB, DAYS[0], DAYS[2])
    expect(empty).toMatchObject({
      closings: [],
      related: [],
      events: [],
      registerClosings: [],
    })
    expect(reportData(storeA, DAYS[0], DAYS[2]).registerClosings).toHaveLength(2)
  })

  it('same database in a file: reopening it still keeps the restaurants apart', () => {
    // A new database per test, without touching anyone else's.
    const db = openDatabase(':memory:')
    applyMigrations(db)
    const ids = [newId(), newId()] as const
    for (const id of ids)
      db.prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'R', '{}')`,
      ).run(id, id, NOW, NOW)
    const h = buildHistory({
      actions: [],
      days: [2],
      closes: [true, false],
      tips: [500, 0],
    })
    load(new SqliteStore(db, ids[0]), h.events)
    const reopened = new SqliteStore(db, ids[1])
    expect(reportData(reopened, DAYS[0], DAYS[2]).events).toEqual([])
    expect(reportData(new SqliteStore(db, ids[0]), DAYS[0], DAYS[2]).registerClosings).toHaveLength(
      1,
    )
  })
})

describe('the histories reach the cases that matter', () => {
  it('there are closes on another day, reopenings, reversals from another day, closed shifts and tips', () => {
    const seen = {
      closedIds: 0,
      closeOfAReopening: 0,
      reopenedNotClosed: 0,
      reversalFromOtherDay: 0,
      shiftClosed: 0,
    }
    fc.assert(
      fc.property(plan, consoleLines, (p, v) => {
        const h = buildHistory(p)
        const { memory } = stores(h.events)
        const { from, until } = range(v)
        const data = reportData(memory, from, until)
        if (data.closings.length > 0) seen.closedIds += 1
        if (data.closings.some((c) => c.before !== null)) seen.closeOfAReopening += 1
        if (data.registerClosings.length > 0) seen.shiftClosed += 1
        for (const status of h.service.statuses) {
          if (!status) continue
          const closings = h.events.filter(
            (e) => e.type === 'OrderClosed' && e.aggregate_id === status.id,
          )
          const reopened = h.events.some(
            (e) => e.type === 'OrderReopened' && e.aggregate_id === status.id,
          )
          if (reopened && status.status === 'open' && closings.length > 0)
            seen.reopenedNotClosed += 1
        }
        const recorded = new Map(
          h.events
            .filter((e) => e.type === 'PaymentRecorded')
            .map((e) => [e.data.payment_id, e.business_day] as const),
        )
        if (
          data.events.some(
            (e) =>
              (e.type === 'PaymentVoided' || e.type === 'RefundRecorded') &&
              recorded.get(e.data.payment_id) !== e.business_day,
          )
        )
          seen.reversalFromOtherDay += 1
      }),
      { ...CONFIG, numRuns: 300, seed: 20_261_048 },
    )
    for (const [caseName, n] of Object.entries(seen)) expect(n, caseName).toBeGreaterThan(0)
  })
})

// ── What was already reported for a day does not change (DINERO.md#día-operativo-e-informes) ──

const salesOf = (a: MemoryStore | SqliteStore, from: string, until = from) =>
  report({ ...reportData(a, from, until), config: REPORT_CONFIG })

/** Histories with days in order, as in real life: nothing new falls on a day already past. */
const sortedPlan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' }),
  days: fc.constant([1]),
  closes: fc.constant<[boolean, boolean]>([false, false]),
  tips: fc.constant<[number, number]>([0, 0]),
  cuts: fc
    .tuple(fc.nat(50), fc.nat(50))
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]),
})

const FIELDS = ['gross', 'voided', 'discounts', 'net', 'roundingAdjustments', 'tips'] as const

describe('what was reported for a day does not change', () => {
  it('the report of a day is the same today as after any later event on other days', () => {
    fc.assert(
      fc.property(sortedPlan, (p) => {
        const h = buildHistory(p)
        const { memory, sqlite } = stores(h.events)
        for (const day of DAYS) {
          // What was known at the end of that day: everything recorded up to it.
          const untilDay = h.events.filter((e) => e.business_day <= day)
          const { memory: yesterday, sqlite: yesterdaySqlite } = stores(untilDay)
          const atThatTime = salesOf(yesterday, day)
          expect(salesOf(memory, day)).toEqual(atThatTime)
          expect(salesOf(sqlite, day)).toEqual(atThatTime)
          expect(salesOf(yesterdaySqlite, day)).toEqual(atThatTime)
        }
      }),
      { ...CONFIG, seed: 20_261_050, numRuns: 60 },
    )
  })

  it('not even the table closes of that day change: each starts from the previous close and reaches its own', () => {
    fc.assert(
      fc.property(sortedPlan, (p) => {
        const h = buildHistory(p)
        const { memory } = stores(h.events)
        for (const day of DAYS) {
          const { memory: yesterday } = stores(h.events.filter((e) => e.business_day <= day))
          expect(reportData(memory, day, day).closings).toEqual(
            reportData(yesterday, day, day).closings,
          )
          expect(reportData(memory, day, day).events).toEqual(
            reportData(yesterday, day, day).events,
          )
        }
      }),
      { ...CONFIG, seed: 20_261_051, numRuns: 40 },
    )
  })
})

describe('Σ by days = the final state', () => {
  it('what the days of a reopened order add up to is its state at the last close', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const h = buildHistory(p)
        const { memory } = stores(h.events)
        const days = DAYS.map((d) => salesOf(memory, d).sales)
        const expected = {
          gross: 0,
          voided: 0,
          discounts: 0,
          net: 0,
          roundingAdjustments: 0,
          tips: 0,
        }
        let checks = 0
        let guests = 0
        for (const id of h.service.orders) {
          const closings = h.events.filter((e) => e.type === 'OrderClosed' && e.aggregate_id === id)
          const firstClosing = closings.at(0)
          const latest = closings.at(-1)
          if (!firstClosing || !latest) continue
          const stateIn = (sequence: number) =>
            rebuild(
              h.events.filter((e) => e.sequence <= sequence),
              id,
            ) as OrderState
          const final = orderTotals(stateIn(latest.sequence))
          expected.gross += final.gross
          expected.voided += final.voided
          expected.discounts += final.discount
          expected.net += final.net
          expected.roundingAdjustments += final.roundingAdjustments
          expected.tips += final.tips
          const initial = stateIn(firstClosing.sequence)
          guests += initial.guests
          if (orderTotals(initial).net > 0) checks += 1
        }
        for (const field of FIELDS)
          expect(sum(days.map((d) => d[field])), field).toBe(expected[field])
        expect(sum(days.map((d) => d.checks))).toBe(checks)
        expect(sum(days.map((d) => d.guests))).toBe(guests)
      }),
      { ...CONFIG, seed: 20_261_052, numRuns: 100 },
    )
  })

  it('each day, base + tax is its net, also when the day net is negative', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const h = buildHistory(p)
        const { memory } = stores(h.events)
        for (const d of DAYS) {
          const v = salesOf(memory, d).sales
          expect(sum(v.taxes.map((i) => i.base + i.tax))).toBe(v.net)
        }
      }),
      { ...CONFIG, seed: 20_261_054 },
    )
  })
})

describe('a range is the sum of its days', () => {
  it('net, gross, voided, discounts, adjustments, tips, checks and guests', () => {
    fc.assert(
      fc.property(plan, consoleLines, (p, v) => {
        const h = buildHistory(p)
        const { memory, sqlite } = stores(h.events)
        const { from, until } = range(v)
        const days = DAYS.filter((d) => d >= from && d <= until)
        const everything = salesOf(sqlite, from, until).sales
        const byDay = days.map((d) => salesOf(memory, d).sales)
        for (const field of [...FIELDS, 'checks', 'guests'] as const)
          expect(everything[field], field).toBe(sum(byDay.map((d) => d[field])))
      }),
      { ...CONFIG, seed: 20_261_055 },
    )
  })

  it('by method, by waiter, by product, voids, cancellations, discounts and pool', () => {
    fc.assert(
      fc.property(plan, consoleLines, (p, v) => {
        const h = buildHistory(p)
        const { memory } = stores(h.events)
        const { from, until } = range(v)
        const days = DAYS.filter((d) => d >= from && d <= until)
        const everything = salesOf(memory, from, until)
        const byDay = days.map((d) => salesOf(memory, d))
        const sumBy = <T>(list: T[][], key: (x: T) => string, fields: ((x: T) => number)[]) => {
          const m = new Map<string, number[]>()
          for (const row of list.flat()) {
            const acc = m.get(key(row)) ?? fields.map(() => 0)
            fields.forEach((c, i) => {
              acc[i] = (acc[i] ?? 0) + c(row)
            })
            m.set(key(row), acc)
          }
          // What adds up to zero does not show up in the report.
          return new Map([...m].filter(([, a]) => a.some((n) => n !== 0)))
        }
        const asMap = <T>(list: T[], key: (x: T) => string, fields: ((x: T) => number)[]) =>
          sumBy([list], key, fields)

        const method = (m: { method: string; customMethodId: string | null }) =>
          `${m.method}:${m.customMethodId ?? ''}`
        expect(
          asMap(everything.byMethod, method, [(m) => m.sale, (m) => m.tip, (m) => m.payments]),
        ).toEqual(
          sumBy(
            byDay.map((d) => d.byMethod),
            method,
            [(m) => m.sale, (m) => m.tip, (m) => m.payments],
          ),
        )
        expect(
          asMap(everything.byWaiter, (m) => m.userId, [(m) => m.net, (m) => m.checks]),
        ).toEqual(
          sumBy(
            byDay.map((d) => d.byWaiter),
            (m) => m.userId,
            [(m) => m.net, (m) => m.checks],
          ),
        )
        const product = (x: { productId: string; variantId: string | null }) =>
          `${x.productId}:${x.variantId ?? ''}`
        expect(asMap(everything.byProduct, product, [(x) => x.units, (x) => x.net])).toEqual(
          sumBy(
            byDay.map((d) => d.byProduct),
            product,
            [(x) => x.units, (x) => x.net],
          ),
        )
        expect(everything.voids.map((a) => a.eventId)).toEqual(
          byDay.flatMap((d) => d.voids.map((a) => a.eventId)),
        )
        expect(everything.cancellations.map((a) => a.eventId)).toEqual(
          byDay.flatMap((d) => d.cancellations.map((a) => a.eventId)),
        )
        expect(everything.discounts).toHaveLength(sum(byDay.map((d) => d.discounts.length)))
        for (const field of ['tips', 'paidOut', 'balance'] as const)
          expect(everything.tipPool[field]).toBe(sum(byDay.map((d) => d.tipPool[field])))
      }),
      { ...CONFIG, seed: 20_261_056 },
    )
  })
})
