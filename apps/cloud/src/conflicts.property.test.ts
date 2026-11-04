import { ALERT_EVENT_TYPES, alerts, type OrderEvent, report } from '@pos/core'
import { type HubStore, MemoryStore, ordersOf, reportData, savedReconciliation } from '@pos/sync'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { arbAct, run } from '../../../packages/sync/src/testing/registers'
import { eventsOf } from '../../../packages/sync/src/testing/setup'
import { dayAlerts } from './alerts'
import { inRestaurant } from './cloud'
import { registersNow } from './register'
import { cloudReportData, configFrom, type Scope } from './reports'
import { createWorld, type World } from './testing/world'

// Task 1.7b in the cloud with random histories: the events of three registers that went offline
// and came back (some saved by the hub as not applied) uploaded to Postgres give the same open
// registers, report and alerts as the hub's own store; the same events uploaded again are the same,
// and a copy that differs only in the mark is divergent (the first one stays).

const SEED = Number(process.env.FC_SEED ?? 20_261_105)
const RUNS = Number(process.env.FC_CLOUD_RUNS ?? 12)
const FROM = '2026-10-23'
const UNTIL = '2026-10-25'
const DAY = '2026-10-24'
const CONFIG = configFrom({})

let world: World

beforeAll(async () => {
  world = await createWorld()
})

function hubStore(events: readonly OrderEvent[]): HubStore {
  const store = new MemoryStore()
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
  return store
}

function hubAlerts(events: readonly OrderEvent[], day: string) {
  const store = hubStore(events)
  const data = reportData(store, day, day)
  const r = report({
    ...data,
    config: { sales_by_waiter: CONFIG.sales_by_waiter, rounding_mode: CONFIG.rounding_mode },
  })
  const ids = new Set([
    ...store.periodEvents(ALERT_EVENT_TYPES, day, day).map((e) => e.aggregate_id),
    ...data.events.map((e) => e.aggregate_id),
  ])
  return alerts({
    day,
    voids: r.voids,
    cancellations: r.cancellations,
    orders: new Map([...ids].map((id) => [id, store.aggregateEvents(id)])),
    registerClosings: data.registerClosings,
    unapplied: r.unapplied,
    threshold: CONFIG.register_variance_threshold,
  })
}

describe('random histories uploaded to the cloud (task 1.7b)', () => {
  it('registers, report and alerts are the hub’s; a resend is the same and a copy without the mark is divergent', async () => {
    let marked = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAct, { minLength: 10, maxLength: 60, size: 'max' }),
        async (actions) => {
          const story = await run(actions)
          const events = eventsOf(story.m)
          const hub = await world.newHub()
          const scope: Scope = { restaurantId: hub.restaurantId, hubIds: [hub.hub.id] }
          const first = await world.cloud.receiveEvents(hub.hub, events)
          expect(first.every((r) => r.status === 'saved')).toBe(true)

          // The open registers: the hub's reconciliation, shift by shift.
          const now = await inRestaurant(world.sql, hub.restaurantId, (tx) =>
            registersNow(tx, scope, '2026-10-01', DAY),
          )
          const store = hubStore(events)
          for (const shift of story.shifts) {
            const inCloud = now.open.find((o) => o.shift_id === shift)?.reconciliation
            expect(inCloud).toEqual(story.m.hub().reconciliation(shift))
            expect(inCloud).toEqual(savedReconciliation(store, shift))
          }

          // The report over the whole range.
          const { data } = await inRestaurant(world.sql, hub.restaurantId, (tx) =>
            cloudReportData(tx, scope, FROM, UNTIL),
          )
          expect(data).toEqual(reportData(store, FROM, UNTIL))

          // The alerts of the day.
          const cloud = await inRestaurant(world.sql, hub.restaurantId, (tx) =>
            dayAlerts(tx, scope, DAY, CONFIG),
          )
          expect(cloud.alerts).toEqual(hubAlerts(events, DAY))

          // The same events again: nothing new. Without the mark: divergent exactly when marked.
          const again = await world.cloud.receiveEvents(hub.hub, events)
          expect(again.every((r) => r.status === 'already_stored')).toBe(true)
          const stripped = events.map((e) => {
            const { unapplied: _u, ...rest } = e
            return rest as OrderEvent
          })
          const without = await world.cloud.receiveEvents(hub.hub, stripped)
          expect(without.map((r) => r.status)).toEqual(
            events.map((e) => (e.unapplied ? 'divergent' : 'already_stored')),
          )
          marked += events.filter((e) => e.unapplied).length
          // What was stored first still rules.
          const after = await inRestaurant(world.sql, hub.restaurantId, (tx) =>
            registersNow(tx, scope, '2026-10-01', DAY),
          )
          expect(after.open.map((o) => o.reconciliation)).toEqual(
            now.open.map((o) => o.reconciliation),
          )
        },
      ),
      { seed: SEED, numRuns: RUNS },
    )
    expect(marked).toBeGreaterThan(0)
  }, 240_000)
})
