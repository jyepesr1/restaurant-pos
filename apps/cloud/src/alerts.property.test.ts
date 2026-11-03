import {
  ALERT_EVENT_TYPES,
  alerts,
  newId,
  type OrderEvent,
  type RestaurantConfig,
  report,
} from '@pos/core'
import { type HubStore, HubSync, MemoryStore, ordersOf, reportData } from '@pos/sync'
import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { actionArb } from '../../../packages/core/src/testing/simulator'
import { openAccess } from '../../../packages/sync/src/testing/access'
import { buildHistory, DAYS, type HistoryPlan } from '../../../packages/sync/src/testing/histories'
import { dayAlerts } from './alerts'
import { inRestaurant } from './cloud'
import { LIVE_WINDOW_DAYS } from './live'
import { addDays } from './panel'
import { registersNow } from './register'
import { closingJson, configFrom, hubsOfLocation, type Scope } from './reports'
import { createWorld, type TestHub, type World } from './testing/world'

// «Caja» and «Alertas» against the hub with random histories, now also over every threshold of the
// variance (0 included) and every day of the history (task 1.11c-2): what the cloud answers is what
// the hub’s own code answers from the same events.

let m: World

beforeEach(async () => {
  m = await createWorld()
})

const plan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' }),
  days: fc.array(fc.nat(2), { minLength: 1, maxLength: 150 }),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})
// Plus the days when the closes are spread in order (as in real life), not at random.
const orderedPlan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' }),
  days: fc.constant([0]),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
  cuts: fc.tuple(fc.nat(60), fc.nat(60)).map(([a, b]) => [Math.min(a, b), Math.max(a, b)]),
})

const THRESHOLDS = [0, 1, 2, 500, 1_000, 5_000, 1_000_000] as const

async function upload(h: TestHub, events: readonly OrderEvent[]) {
  for (let i = 0; i < events.length; i += 500) {
    const r = await m.cloud.receiveEvents(h.hub, events.slice(i, i + 500))
    expect(r.every((x) => x.status === 'saved' || x.status === 'already_stored')).toBe(true)
  }
}

const scopeOf = async (h: TestHub): Promise<Scope> => ({
  restaurantId: h.restaurantId,
  hubIds: await inRestaurant(m.sql, h.restaurantId, (tx) =>
    hubsOfLocation(tx, h.restaurantId, h.hub.locationId),
  ),
})

/** The same alerts from the hub’s store, with every event at hand. */
function inHub(events: readonly OrderEvent[], day: string, config: RestaurantConfig) {
  const store: HubStore = new MemoryStore()
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
  const data = reportData(store, day, day)
  const r = report({
    ...data,
    config: { sales_by_waiter: config.sales_by_waiter, rounding_mode: config.rounding_mode },
  })
  const ids = new Set([
    ...store.periodEvents(ALERT_EVENT_TYPES, day, day).map((e) => e.aggregate_id),
    ...data.events
      .filter((e) =>
        ['ItemVoided', 'OrderCanceled', 'PaymentVoided', 'RefundRecorded'].includes(e.type),
      )
      .map((e) => e.aggregate_id),
  ])
  return alerts({
    day,
    voids: r.voids,
    cancellations: r.cancellations,
    orders: new Map([...ids].map((id) => [id, store.aggregateEvents(id)])),
    registerClosings: data.registerClosings,
    threshold: config.register_variance_threshold,
  })
}

const VARIANCES = [0, 1, -1, 2, 999, -999, 1000, -1000, 1001, -1001, 5000, -5000, 30_000, -30_000]
const variancesArb = fc.record({
  cash: fc.tuple(fc.constantFrom(...VARIANCES), fc.constantFrom(...VARIANCES)),
  // Per shift: what a card and a transfer closing say against what the system recorded.
  card: fc.tuple(fc.constantFrom(...VARIANCES), fc.constantFrom(...VARIANCES)),
  transfer: fc.tuple(fc.constantFrom(...VARIANCES), fc.constantFrom(...VARIANCES)),
})

/**
 * The same history, but with the registers closing short or over (the generator closes them at
 * exactly what they should have): the cash count and the card and transfer closings carry a
 * variance. The history’s shifts are, in order, the first and second shift of the day.
 */
function withVariances(
  events: readonly OrderEvent[],
  shifts: readonly string[],
  v: { cash: number[]; card: number[]; transfer: number[] },
): OrderEvent[] {
  const countOf = new Map<string, number>()
  for (const e of events)
    if (e.type === 'ShiftClosed') countOf.set(e.data.cash_count_id, shifts.indexOf(e.aggregate_id))
  const tally = (counted: number) => [
    { value: 1000, quantity: Math.floor(counted / 1000) },
    { value: 1, quantity: counted % 1000 },
  ]
  return events.map((e) => {
    if (e.type === 'CashCountRecorded' && countOf.has(e.data.cash_count_id)) {
      const counted = 100_000 + (v.cash[countOf.get(e.data.cash_count_id) ?? 0] ?? 0)
      return {
        ...e,
        data: { ...e.data, tally: tally(counted), counted_cash: counted },
      } as OrderEvent
    }
    if (e.type === 'ShiftClosed') {
      const n = shifts.indexOf(e.aggregate_id)
      const cash = v.cash[n] ?? 0
      const other = (method: 'card' | 'transfer', delta: number | undefined) => ({
        method,
        custom_method_id: null,
        expected: 200_000,
        reported: 200_000 + (delta ?? 0),
        variance: delta ?? 0,
      })
      return {
        ...e,
        data: {
          ...e.data,
          counted_cash: 100_000 + cash,
          variance: cash,
          justification: cash === 0 ? null : 'Justificación',
          other_methods: [other('card', v.card[n]), other('transfer', v.transfer[n])],
        },
      } as OrderEvent
    }
    return e
  })
}

describe('«Alertas»: the same as the hub for every threshold and every day', () => {
  for (const [name, arbitrary] of [
    ['days at random', plan],
    ['days in order', orderedPlan],
  ] as const)
    it(`${name}`, async () => {
      let varianceAlerts = 0
      let silencedByThreshold = 0
      await fc.assert(
        fc.asyncProperty(
          arbitrary,
          variancesArb,
          fc.constantFrom(...THRESHOLDS),
          fc.constantFrom(DAYS[2], DAYS[2], DAYS[1], DAYS[0]),
          async (p, v, threshold, day) => {
            const h = buildHistory(p)
            const events = withVariances(h.events, h.shifts, {
              cash: [...v.cash],
              card: [...v.card],
              transfer: [...v.transfer],
            })
            const target = await m.newHub()
            await upload(target, events)
            const config = configFrom({ register_variance_threshold: threshold })
            const scope = await scopeOf(target)
            const cloud = await inRestaurant(m.sql, target.restaurantId, (tx) =>
              dayAlerts(tx, scope, day, config),
            )
            const expected = inHub(events, day, config)
            expect(cloud.alerts).toEqual(expected)

            // An oracle that does not use the hub’s code: the closes are all on the last day.
            const limit = Math.max(1, threshold)
            const closed = [0, 1].filter((n) => p.closes[n as 0 | 1])
            const variances = closed.flatMap((n) => [v.cash[n], v.card[n], v.transfer[n]])
            const oracle = day === DAYS[2] ? variances.filter((x) => Math.abs(x ?? 0) >= limit) : []
            const found = cloud.alerts.filter((a) => a.type === 'register_variance')
            expect(found.map((a) => a.value).sort()).toEqual(oracle.sort())
            for (const a of found) expect(Math.abs(a.value)).toBeGreaterThanOrEqual(limit)
            varianceAlerts += found.length

            // Raising the threshold never adds alerts, and never touches the other kinds.
            const strict = inHub(
              events,
              day,
              configFrom({ register_variance_threshold: 1_000_000 }),
            )
            if (strict.length < expected.length) silencedByThreshold++
            expect(strict.length).toBeLessThanOrEqual(expected.length)
            expect(strict.filter((a) => a.type !== 'register_variance')).toEqual(
              expected.filter((a) => a.type !== 'register_variance'),
            )
          },
        ),
        { seed: 20_261_103, numRuns: 40 },
      )
      // Not vacuous: variances were found, and a stricter threshold silenced some.
      expect(varianceAlerts).toBeGreaterThan(5)
      expect(silencedByThreshold).toBeGreaterThan(0)
    })
})

/** The hub over a store with those events: it rebuilds its open shifts from them. */
function hubWith(events: readonly OrderEvent[]) {
  const store = new MemoryStore()
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
  const sync = new HubSync(store, {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: () => '2026-10-26T15:00:00.000Z',
    access: openAccess,
  })
  return { store, sync }
}

describe('«Caja»: the same as the hub for every day', () => {
  it('open shifts and the day’s closes, whatever “today” is', async () => {
    let checkedOpen = 0
    let checkedClosed = 0
    await fc.assert(
      fc.asyncProperty(orderedPlan, fc.constantFrom(...DAYS), async (p, today) => {
        const h = buildHistory(p)
        const target = await m.newHub()
        await upload(target, h.events)
        const { store, sync } = hubWith(h.events)
        const scope = await scopeOf(target)
        const live = await inRestaurant(m.sql, target.restaurantId, (tx) =>
          registersNow(tx, scope, addDays(today, -LIVE_WINDOW_DAYS), today),
        )
        const closedShifts = new Set(
          h.events.filter((e) => e.type === 'ShiftClosed').map((e) => e.aggregate_id),
        )
        expect(live.open.map((o) => o.shift_id).sort()).toEqual(
          h.shifts.filter((id) => !closedShifts.has(id)).sort(),
        )
        for (const o of live.open) {
          expect(o.reconciliation).toEqual(sync.reconciliation(o.shift_id))
          checkedOpen++
        }
        const expectedClosed = reportData(store, today, today).registerClosings.map(closingJson)
        expect(live.closed).toEqual(expectedClosed)
        checkedClosed += expectedClosed.length
      }),
      { seed: 20_261_103, numRuns: 35 },
    )
    expect(checkedOpen + checkedClosed).toBeGreaterThan(5)
  })
})
