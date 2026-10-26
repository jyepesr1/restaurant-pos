import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { rebuild } from '../order/apply'
import type { OrderState } from '../order/state'
import { pricePerUnit } from '../order/totals'
import { type Action, actionArb, Service } from '../testing/simulator'
import { type ReportInput, report } from './report'

// Report properties (task 1.9, docs/KPIS.md) over random histories of two orders (the reducer
// simulator): payments, voids, discounts, refunds, closes and reopenings. The identities are
// those of KPIS.md; the period is spread over three business days. Fixed seed: the same cases on
// every run.

const sequence = fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' })
const CONFIG = { seed: 20_261_029, numRuns: 500 }

const DAYS = ['2026-10-23', '2026-10-24', '2026-10-25'] as const
const WAITERS = [
  '01JBAAAAAAAAAAAAAAAAAAAAA1',
  '01JBAAAAAAAAAAAAAAAAAAAAA2',
  '01JBAAAAAAAAAAAAAAAAAAAAA3',
]
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

const PERIOD_TYPES = [
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
  'ItemVoided',
  'OrderCanceled',
]

const story = fc.record({
  actions: sequence,
  /** A day (0..2) and a waiter (0..2) per event, by its position. */
  random: fc.array(fc.tuple(fc.nat(2), fc.nat(2)), { minLength: 1, maxLength: 200 }),
  mode: fc.constantFrom('half_up' as const, 'half_even' as const),
  byWaiter: fc.constantFrom('added_by' as const, 'assigned_waiter' as const),
  from: fc.nat(2),
  length: fc.nat(2),
})

type Story = {
  service: Service
  statuses: OrderState[]
  events: OrderEvent[]
  /** All the events the simulator applied, with days and waiters already assigned. */
  config: ReportInput['config']
}

type Random = {
  actions: Action[]
  random: [number, number][]
  mode: 'half_up' | 'half_even'
  byWaiter: 'added_by' | 'assigned_waiter'
  from: number
  length: number
}

function build(h: Random): Story {
  const service = new Service()
  for (const a of h.actions) service.step(a)
  const random = (i: number) => h.random[i % h.random.length] ?? [1, 0]
  // Each item is added by one of three waiters and each payment, void or refund falls on a day.
  const log = service.log.map((e, i) =>
    e.type === 'ItemAdded' ? ({ ...e, user_id: WAITERS[random(i)[1]] } as OrderEvent) : e,
  )
  const statuses = service.orders
    .map((id) => rebuild(log, id))
    .filter((p): p is OrderState => p !== null)
  const appliedEvents = new Set(service.appliedEvents.map((e) => e.id))
  const events = log
    .map((e, i) =>
      PERIOD_TYPES.includes(e.type) ? { ...e, business_day: DAYS[random(i)[0]] as string } : e,
    )
    .filter((e) => appliedEvents.has(e.id)) as OrderEvent[]
  return {
    service,
    statuses,
    events,
    config: { sales_by_waiter: h.byWaiter, rounding_mode: h.mode },
  }
}

const inputOf = (
  h: Story,
  from: string,
  until: string,
  closedIds: OrderState[] = h.statuses.filter((p) => p.status === 'closed'),
): ReportInput => ({
  from,
  until,
  closedIds,
  related: h.statuses,
  events: h.events,
  config: h.config,
})

/** What was charged per method in a period, computed separately straight from the events. */
function oraclePerMethod(events: readonly OrderEvent[], from: string, until: string) {
  const payments = new Map<string, { method: string; own: string; amount: number; tip: number }>()
  for (const e of events)
    if (e.type === 'PaymentRecorded')
      payments.set(e.data.payment_id, {
        method: e.data.method,
        own: e.data.custom_method_id ?? '',
        amount: e.data.amount + e.data.rounding_adjustment,
        tip: e.data.tip,
      })
  const total = new Map<string, { sale: number; tip: number; payments: number }>()
  const add = (key: string, sale: number, tip: number, payments: number) => {
    const t = total.get(key) ?? { sale: 0, tip: 0, payments: 0 }
    t.sale += sale
    t.tip += tip
    t.payments += payments
    total.set(key, t)
  }
  for (const e of events) {
    if (e.business_day < from || e.business_day > until) continue
    if (e.type === 'PaymentRecorded') {
      const p = payments.get(e.data.payment_id)
      if (p) add(`${p.method}:${p.own}`, p.amount, p.tip, 1)
    } else if (e.type === 'PaymentVoided') {
      const p = payments.get(e.data.payment_id)
      if (p) add(`${p.method}:${p.own}`, -p.amount, -p.tip, -1)
    } else if (e.type === 'RefundRecorded') {
      const p = payments.get(e.data.payment_id)
      add(`${e.data.method}:${p?.own ?? ''}`, -e.data.sale_amount, -e.data.tip_amount, 0)
    }
  }
  return new Map([...total].filter(([, t]) => t.sale !== 0 || t.tip !== 0 || t.payments !== 0))
}

describe('report: KPIS.md identities with random histories', () => {
  it('Σ net by product = net, Σ net by waiter = net and base + tax = net', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const r = report(inputOf(hist, DAYS[0], DAYS[2]))
        const { sales } = r
        expect(sum(r.byProduct.map((p) => p.net))).toBe(sales.net)
        expect(sum(r.byWaiter.map((m) => m.net))).toBe(sales.net)
        expect(sum(sales.taxes.map((i) => i.base + i.tax))).toBe(sales.net)
        for (const i of sales.taxes) {
          expect(i.tax).toBeGreaterThanOrEqual(0)
          expect(i.base).toBeGreaterThanOrEqual(0)
          expect(Number.isInteger(i.base) && Number.isInteger(i.tax)).toBe(true)
        }
        // gross − voided − discounts = net.
        expect(sales.gross - sales.voided - sales.discounts).toBe(sales.net)
      }),
      CONFIG,
    )
  })

  it('the net is Σ (amount − sale refund) of the payments of closed orders', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const closedIds = hist.statuses.filter((p) => p.status === 'closed')
        const r = report(inputOf(hist, DAYS[0], DAYS[2]))
        const payments = closedIds
          .flatMap((p) => Object.values(p.payments))
          .filter((p) => !p.voided)
        expect(r.sales.net).toBe(sum(payments.map((p) => p.amount - p.refundedSale)))
        expect(r.sales.tips).toBe(sum(payments.map((p) => p.tip - p.refundedTip)))
        expect(r.sales.guests).toBe(sum(closedIds.map((p) => p.guests)))
        expect(r.sales.checks).toBeLessThanOrEqual(closedIds.length)
      }),
      { ...CONFIG, seed: 20_261_030 },
    )
  })

  it('average check and spend per guest: net ÷ divisor in whole pesos, 0 with no divisor', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const { sales } = report(inputOf(hist, DAYS[0], DAYS[2]))
        for (const [value, divisor] of [
          [sales.averageTicket, sales.checks],
          [sales.spendPerGuest, sales.guests],
        ] as const) {
          expect(Number.isInteger(value)).toBe(true)
          if (divisor === 0) expect(value).toBe(0)
          // The rounding never strays more than half a peso from the exact quotient.
          else expect(Math.abs(value * divisor - sales.net)).toBeLessThanOrEqual(divisor / 2)
        }
      }),
      { ...CONFIG, seed: 20_261_031 },
    )
  })

  it('by waiter: to whoever added the item or, if so configured, to the table waiter', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const closedIds = hist.statuses.filter((p) => p.status === 'closed')
        const adds = report({
          ...inputOf(hist, DAYS[0], DAYS[2]),
          config: { ...hist.config, sales_by_waiter: 'added_by' },
        })
        const assigned = report({
          ...inputOf(hist, DAYS[0], DAYS[2]),
          config: { ...hist.config, sales_by_waiter: 'assigned_waiter' },
        })
        for (const m of adds.byWaiter) expect(WAITERS).toContain(m.userId)
        const assignedWaiters = new Set(closedIds.map((p) => p.assignedWaiterId))
        for (const m of assigned.byWaiter) expect(assignedWaiters).toContain(m.userId)
        for (const r of [adds, assigned]) {
          expect(sum(r.byWaiter.map((m) => m.net))).toBe(r.sales.net)
          // Sorted from most to least net, with no repeated waiter and no empty rows.
          expect(new Set(r.byWaiter.map((m) => m.userId)).size).toBe(r.byWaiter.length)
          for (const m of r.byWaiter) {
            expect(m.net !== 0 || m.checks > 0).toBe(true)
            expect(m.checks).toBeLessThanOrEqual(closedIds.length)
          }
          for (let i = 1; i < r.byWaiter.length; i++)
            expect(r.byWaiter[i - 1]?.net ?? 0).toBeGreaterThanOrEqual(r.byWaiter[i]?.net ?? 0)
        }
        // Both ways of assigning add up to the same.
        expect(sum(adds.byWaiter.map((m) => m.net))).toBe(sum(assigned.byWaiter.map((m) => m.net)))
      }),
      { ...CONFIG, seed: 20_261_032, numRuns: 250 },
    )
  })

  it('by product: units are quantity − voided and are sorted from most to least net', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const closedIds = hist.statuses.filter((p) => p.status === 'closed')
        const r = report(inputOf(hist, DAYS[0], DAYS[2]))
        const units = sum(
          closedIds.flatMap((p) =>
            Object.values(p.items).map((i) => i.quantity - i.voidedQuantity),
          ),
        )
        expect(sum(r.byProduct.map((p) => p.units))).toBe(units)
        for (let i = 1; i < r.byProduct.length; i++)
          expect(r.byProduct[i - 1]?.net ?? 0).toBeGreaterThanOrEqual(r.byProduct[i]?.net ?? 0)
        for (const p of r.byProduct) expect(p.units).toBeGreaterThanOrEqual(0)
      }),
      { ...CONFIG, seed: 20_261_033, numRuns: 250 },
    )
  })

  it('the order of the closed orders does not change any total', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const closedIds = hist.statuses.filter((p) => p.status === 'closed')
        const a = report(inputOf(hist, DAYS[0], DAYS[2], closedIds))
        const b = report(inputOf(hist, DAYS[0], DAYS[2], [...closedIds].reverse()))
        expect(b.sales.net).toBe(a.sales.net)
        expect(b.sales.gross).toBe(a.sales.gross)
        expect(b.sales.checks).toBe(a.sales.checks)
        const key = (x: { type: string; rate: number }) => `${x.type}:${x.rate}`
        expect(new Map(b.sales.taxes.map((i) => [key(i), i.tax]))).toEqual(
          new Map(a.sales.taxes.map((i) => [key(i), i.tax])),
        )
        expect(new Map(b.byWaiter.map((m) => [m.userId, m.net]))).toEqual(
          new Map(a.byWaiter.map((m) => [m.userId, m.net])),
        )
      }),
      { ...CONFIG, seed: 20_261_034, numRuns: 250 },
    )
  })
})

describe('report: what was recorded in the period', () => {
  it('by method matches adding up the period events by hand', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const from = DAYS[Math.min(h.from, 2)] as string
        const until = DAYS[Math.min(h.from + h.length, 2)] as string
        const r = report(inputOf(hist, from, until))
        const expected = oraclePerMethod(hist.events, from, until)
        const obtained = new Map(
          r.byMethod.map((m) => [
            `${m.method}:${m.customMethodId ?? ''}`,
            { sale: m.sale, tip: m.tip, payments: m.payments },
          ]),
        )
        expect(obtained).toEqual(expected)
        // The tip pool is the tips of all methods, net of refunds.
        expect(r.tipPool.tips).toBe(sum(r.byMethod.map((m) => m.tip)))
        expect(r.tipPool.balance).toBe(r.tipPool.tips - r.tipPool.paidOut)
      }),
      { ...CONFIG, seed: 20_261_035 },
    )
  })

  it('it is additive: the three days separately add up to the full period', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const everything = report(inputOf(hist, DAYS[0], DAYS[2]))
        const days = DAYS.map((d) => report(inputOf(hist, d, d)))
        const byKey = (r: ReturnType<typeof report>) =>
          new Map(r.byMethod.map((m) => [`${m.method}:${m.customMethodId ?? ''}`, m]))
        const keys = new Set(days.flatMap((r) => [...byKey(r).keys()]))
        for (const k of keys) {
          for (const field of ['sale', 'tip', 'payments'] as const)
            expect(sum(days.map((r) => byKey(r).get(k)?.[field] ?? 0))).toBe(
              byKey(everything).get(k)?.[field] ?? 0,
            )
        }
        expect(sum(days.map((r) => r.voids.length))).toBe(everything.voids.length)
        expect(sum(days.map((r) => r.cancellations.length))).toBe(everything.cancellations.length)
        expect(sum(days.map((r) => r.tipPool.tips))).toBe(everything.tipPool.tips)
        expect(sum(days.map((r) => r.tipPool.paidOut))).toBe(everything.tipPool.paidOut)
      }),
      { ...CONFIG, seed: 20_261_036 },
    )
  })

  it('each applied ItemVoided and OrderCanceled appears once, on its day', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const r = report(inputOf(hist, DAYS[0], DAYS[2]))
        const voidedEvents = hist.events.filter((e) => e.type === 'ItemVoided')
        const canceledEvents = hist.events.filter((e) => e.type === 'OrderCanceled')
        expect(r.voids.map((a) => a.eventId)).toEqual(voidedEvents.map((e) => e.id))
        expect(r.cancellations.map((c) => c.eventId)).toEqual(canceledEvents.map((e) => e.id))
        // A period with no day of the history is empty.
        const outside = report(inputOf(hist, '2026-11-01', '2026-11-03'))
        expect(outside.voids).toEqual([])
        expect(outside.cancellations).toEqual([])
        expect(outside.byMethod).toEqual([])
        expect(outside.tipPool).toEqual({ tips: 0, paidOut: 0, balance: 0 })
      }),
      { ...CONFIG, seed: 20_261_037, numRuns: 250 },
    )
  })

  it('the value of each void is units × the line price with extras', () => {
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const r = report(inputOf(hist, DAYS[0], DAYS[2]))
        for (const [i, a] of r.voids.entries()) {
          const e = hist.events.filter((x) => x.type === 'ItemVoided')[i]
          if (e?.type !== 'ItemVoided') throw new Error('out of order')
          const item = hist.statuses.map((p) => p.items[e.data.item_id]).find(Boolean)
          expect(a.units).toBe(e.data.quantity)
          // If the item is still in some order, the value is that of its line.
          if (item) expect(a.value).toBe(e.data.quantity * pricePerUnit(item))
        }
      }),
      { ...CONFIG, seed: 20_261_038, numRuns: 250 },
    )
  })
})

describe('report: the history generator does reach every case', () => {
  it('it yields closed orders with net, payments, voids, discounts, reopens, cancellations', () => {
    const seen = {
      withNet: 0,
      withPayments: 0,
      voids: 0,
      discounts: 0,
      reopenedCount: 0,
      cancellations: 0,
      refunds: 0,
      multipleWaiters: 0,
    }
    fc.assert(
      fc.property(story, (h) => {
        const hist = build(h)
        const r = report(inputOf(hist, DAYS[0], DAYS[2]))
        if (r.sales.net > 0) seen.withNet += 1
        if (r.byMethod.length > 0) seen.withPayments += 1
        if (r.voids.length > 0) seen.voids += 1
        if (r.discounts.length > 0) seen.discounts += 1
        if (r.cancellations.length > 0) seen.cancellations += 1
        if (r.byWaiter.length > 1) seen.multipleWaiters += 1
        if (hist.events.some((e) => e.type === 'OrderReopened')) seen.reopenedCount += 1
        if (hist.events.some((e) => e.type === 'RefundRecorded')) seen.refunds += 1
      }),
      { ...CONFIG, seed: 20_261_039 },
    )
    for (const [caseName, n] of Object.entries(seen)) expect(n, caseName).toBeGreaterThan(0)
  })
})
