import {
  applyEvent,
  type ChargedByMethod,
  newId,
  type OrderEvent,
  type OrderState,
  otherMethodsReconciliation,
  report,
  type ShiftReconciliation,
  shiftReconciliation,
} from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { HubSync } from './hub/hub'
import { SqliteStore } from './hub/store-sqlite'
import { openAccess } from './testing/access'
import { arbAct, asShift, run } from './testing/registers'
import { eventsOf, seeTheSame } from './testing/setup'

// Task 1.7b with random histories: three registers that go offline and come back, charging,
// voiding, refunding and closing the same orders from stale copies, with the hub crashing in the
// middle. Whatever happens, the hub's verdict is the order reducer's own, the money of the
// registers adds up to the money in the order states (the reducer is the arbiter), every device and
// the restarted hub read the same figures, and the report agrees with the registers.

const SEED = Number(process.env.FC_SEED ?? 20_261_104)
const RUNS = Number(process.env.FC_RUNS ?? 60)
const FROM = '2026-10-23'
const UNTIL = '2026-10-25'
const CONFIG = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** What the order states say was charged, net, per method: the reducer's own books. */
function netByMethod(states: readonly OrderState[]) {
  const net = new Map<string, number>()
  for (const s of states)
    for (const p of Object.values(s.payments)) {
      if (p.voided) continue
      const value = p.amount + p.roundingAdjustment + p.tip - p.refundedSale - p.refundedTip
      net.set(p.method, (net.get(p.method) ?? 0) + value)
    }
  return net
}

function methodTotals(lists: readonly ChargedByMethod[][]) {
  const total = new Map<string, number>()
  for (const l of lists)
    for (const m of l) total.set(m.method, (total.get(m.method) ?? 0) + m.sale + m.tip)
  for (const [k, v] of total) if (v === 0) total.delete(k)
  return total
}

const CONFLICT_MARKED = new Set([
  'order_closed',
  'item_not_found',
  'item_already_sent',
  'item_already_voided',
])

let totalUnapplied = 0
let totalMoney = 0
let totalEvents = 0

describe('random histories with three registers going offline (task 1.7b)', () => {
  it('the verdict is the reducer’s, the money adds up to the order states, and every node reads the same', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAct, { minLength: 10, maxLength: 70, size: 'max' }),
        async (actions) => {
          const { m, registers, waiter, shifts, orders, unappliedCount } = await run(actions)
          const hub = m.hub()
          const events = eventsOf(m)
          totalUnapplied += unappliedCount
          totalEvents += events.length
          totalMoney += events.filter(
            (e) => e.unapplied && e.type.match(/^(Payment|Refund)/),
          ).length

          // Every node holds the same events and orders, the mark included.
          await seeTheSame(hub, events, [waiter, ...registers], orders)
          const byId = new Map(events.map((e) => [e.id, e]))
          for (const node of [waiter, ...registers])
            for (const l of await node.client.locals()) {
              if (l.status !== 'confirmed') continue
              // Field by field the hub's copy, the mark included (and no mark where there is none).
              expect(l.event, `${node.name} ${l.event.type}`).toEqual(byId.get(l.event.id))
              expect('unapplied' in l.event).toBe(byId.get(l.event.id)?.unapplied === true)
            }

          // The mark is exactly the conflicts the hub detected in the reducer's terms.
          const conflicts = new Map(hub.conflicts().map((c) => [c.eventId, c.type]))
          for (const e of events) {
            const type = conflicts.get(e.id)
            if (e.unapplied) expect(CONFLICT_MARKED.has(type ?? ''), `${e.type} ${type}`).toBe(true)
            else if (type) expect(CONFLICT_MARKED.has(type), `${e.type} ${type}`).toBe(false)
          }

          // The verdict is truthful: replaying each order, a marked event is one the reducer would
          // not apply, and an unmarked one is applied.
          for (const id of orders) {
            let state: OrderState | null = null
            for (const e of events.filter((x) => x.aggregate_id === id)) {
              const { unapplied: _u, ...bare } = e
              const r = applyEvent(state, bare as OrderEvent)
              const refused = !!r.issue && r.issue.type !== 'items_omitted'
              expect(refused, `${e.type} #${e.sequence} marked=${e.unapplied === true}`).toBe(
                e.unapplied === true,
              )
              if (!e.unapplied) state = r.status
            }
          }

          // The registers' books against the order states' books.
          const states = orders.map((id) => hub.order(id) as OrderState)
          const recs = shifts.map((s) => hub.reconciliation(s) as ShiftReconciliation)
          const expected = netByMethod(states)
          const registered = methodTotals(recs.map((r) => r.byMethod))
          expect([...registered].sort()).toEqual([...expected].filter(([, v]) => v !== 0).sort())
          expect(sum(recs.map((r) => r.cash.charged - r.cash.refunds))).toBe(
            expected.get('cash') ?? 0,
          )
          for (const r of recs)
            expect(r.cash.expected).toBe(
              100_000 +
                r.cash.charged -
                r.cash.refunds +
                r.cash.cashIn -
                r.cash.cashOut -
                r.cash.tipPayouts,
            )

          // The report agrees with the registers, and lists exactly the unapplied money.
          const rep = report({ ...hub.reportData(FROM, UNTIL), config: CONFIG })
          expect([...methodTotals([rep.byMethod])].sort()).toEqual([...registered].sort())
          const inRegisters = recs.flatMap((r) => r.unapplied.map((u) => u.eventId)).sort()
          expect(rep.unapplied.map((u) => u.eventId).sort()).toEqual(inRegisters)
          const markedMoney = events
            .filter(
              (e) =>
                e.unapplied &&
                (e.type === 'PaymentRecorded' ||
                  e.type === 'PaymentVoided' ||
                  e.type === 'RefundRecorded'),
            )
            .map((e) => e.id)
            .sort()
          expect(inRegisters).toEqual(markedMoney)
          // A marked void or cancellation is no void or cancellation.
          const voidIds = new Set(rep.voids.map((v) => v.eventId))
          const cancelIds = new Set(rep.cancellations.map((v) => v.eventId))
          for (const e of events.filter((x) => x.unapplied)) {
            expect(voidIds.has(e.id)).toBe(false)
            expect(cancelIds.has(e.id)).toBe(false)
          }

          // Each device computes its own register's figures like the hub does.
          for (const [i, node] of registers.entries()) {
            const confirmed = (await node.client.locals())
              .filter((l) => l.status === 'confirmed')
              .map((l) => l.event)
              .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
            expect(shiftReconciliation(confirmed, shifts[i] as string)).toEqual(recs[i])
          }

          // Only the owner of an event is told about it, once.
          for (const node of registers) {
            const told = node.unapplied.map((l) => l.event.id)
            expect(new Set(told).size).toBe(told.length)
            for (const id of told) {
              expect(byId.get(id)?.unapplied).toBe(true)
              expect(byId.get(id)?.device_id).toBe(node.deviceId)
            }
          }
          expect(waiter.unapplied).toEqual([])

          // A restarted hub (same database) reads exactly the same.
          const restarted = new HubSync(new SqliteStore(m.db, m.restaurantId), {
            restaurantId: m.restaurantId,
            timeZone: 'America/Bogota',
            businessDayStart: '06:00',
            access: openAccess,
            instance: 'hub-restart',
            clock: m.network.isoTime,
          })
          for (const s of shifts) expect(restarted.reconciliation(s)).toEqual(hub.reconciliation(s))
          expect(restarted.reportData(FROM, UNTIL)).toEqual(hub.reportData(FROM, UNTIL))
          for (const id of orders) expect(restarted.order(id)).toEqual(hub.order(id))
        },
      ),
      { seed: SEED, numRuns: RUNS },
    )
    // The generator reaches the interesting case: some runs end with money not applied.
    expect(totalUnapplied).toBeGreaterThan(0)
    expect(totalEvents).toBeGreaterThan(0)
    expect(totalMoney).toBeGreaterThan(0)
  }, 120_000)
})

describe('closing the registers after random histories (task 1.7b)', () => {
  it('the hub asks for a justification exactly when money was not applied, and closed shifts read the same after a restart', async () => {
    let withJustification = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAct, { minLength: 10, maxLength: 60, size: 'max' }),
        async (actions) => {
          const { m, registers, shifts } = await run(actions)
          const hub = m.hub()
          for (const [i, node] of registers.entries()) {
            const shift = shifts[i] as string
            const open = hub.reconciliation(shift) as ShiftReconciliation
            const expectedCash = open.cash.expected
            const thousands = Math.floor(expectedCash / 1_000)
            const tally = [
              ...(thousands > 0 ? [{ value: 1_000, quantity: thousands }] : []),
              ...(expectedCash % 1_000 > 0 ? [{ value: 1, quantity: expectedCash % 1_000 }] : []),
            ]
            const countId = newId()
            await node.create(
              shift,
              'CashCountRecorded',
              {
                cash_count_id: countId,
                tally,
                counted_cash: expectedCash,
                others: open.byMethod
                  .filter((b) => b.method !== 'cash')
                  .map((b) => ({
                    method: b.method as Exclude<typeof b.method, 'cash'>,
                    custom_method_id: b.customMethodId,
                    reported: b.sale + b.tip,
                  })),
              },
              asShift,
            )
            await m.network.settle()
            const counted = hub.reconciliation(shift) as ShiftReconciliation
            const others = otherMethodsReconciliation(counted, counted.cashCounts.at(-1) as never)
            const closeData = (justification: string | null) => ({
              cash_count_id: countId,
              expected_cash: expectedCash,
              counted_cash: expectedCash,
              variance: 0,
              justification,
              other_methods: others.map((o) => ({
                method: o.method as Exclude<typeof o.method, 'cash'>,
                custom_method_id: o.customMethodId,
                expected: o.expected,
                reported: o.reported,
                variance: o.variance,
              })),
            })
            const bare = await node.create(shift, 'ShiftClosed', closeData(null), asShift)
            await m.network.settle()
            const first = await node.store.get(bare.id)
            if (open.unapplied.length > 0) {
              expect(first).toMatchObject({ status: 'rejected', reason: 'missing_justification' })
              const done = await node.create(
                shift,
                'ShiftClosed',
                closeData('Dinero que no se aplicó'),
                asShift,
              )
              await m.network.settle()
              expect((await node.store.get(done.id))?.status).toBe('confirmed')
              withJustification += 1
            } else {
              expect(first?.status).toBe('confirmed')
            }
            const closed = hub.reconciliation(shift)
            expect(closed?.unapplied).toEqual(open.unapplied)
            expect(closed?.cash.expected).toBe(expectedCash)
            expect(closed?.closed).toMatchObject({ expected: expectedCash, variance: 0 })
          }
          const restarted = new HubSync(new SqliteStore(m.db, m.restaurantId), {
            restaurantId: m.restaurantId,
            timeZone: 'America/Bogota',
            businessDayStart: '06:00',
            access: openAccess,
            instance: 'hub-restart',
            clock: m.network.isoTime,
          })
          for (const s of shifts) expect(restarted.reconciliation(s)).toEqual(hub.reconciliation(s))
          expect(restarted.reportData(FROM, UNTIL)).toEqual(hub.reportData(FROM, UNTIL))
          const rep = report({ ...hub.reportData(FROM, UNTIL), config: CONFIG })
          expect(rep.unapplied.map((u) => u.eventId).sort()).toEqual(
            shifts
              .flatMap((s) => hub.reconciliation(s)?.unapplied ?? [])
              .map((u) => u.eventId)
              .sort(),
          )
        },
      ),
      { seed: SEED, numRuns: Math.min(RUNS, 40) },
    )
    expect(withJustification).toBeGreaterThan(0)
  }, 120_000)
})
