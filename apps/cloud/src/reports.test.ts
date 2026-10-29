import { newId, type OrderEvent, report } from '@pos/core'
import { MemoryStore, ordersOf, reportData } from '@pos/sync'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionArb } from '../../../packages/core/src/testing/simulator'
import { buildHistory, DAYS, type HistoryPlan } from '../../../packages/sync/src/testing/histories'
import { type AuthenticatedHub, inRestaurant } from './cloud'
import { cloudReportData, configFrom, MAX_ROUNDS, periodReport, type Scope } from './reports'
import { createWorld, type TestHub, type World } from './testing/world'

// The cloud's reports are the hub's (task 1.11c-1, docs/PANEL.md#reportes-con-el-mismo-código):
// with the same order histories, `reportData` over Postgres gives exactly what the hub's store
// gives, and so does `report()`.

const REPORT_CONFIG = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const

let m: World
beforeAll(async () => {
  m = await createWorld()
})

/** The hub's store with the events, indexed by `ordersOf` as the hub does. */
function hubStore(events: readonly OrderEvent[]) {
  const store = new MemoryStore()
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
  return store
}

async function upload(hub: AuthenticatedHub, events: readonly OrderEvent[]) {
  for (let i = 0; i < events.length; i += 500) {
    const r = await m.cloud.receiveEvents(hub, events.slice(i, i + 500))
    expect(r.every((x) => x.status === 'saved' || x.status === 'already_stored')).toBe(true)
  }
}

const scopeOf = (h: TestHub, hubIds = [h.hub.id], asOf: string | null = null): Scope => ({
  restaurantId: h.restaurantId,
  hubIds,
  asOf,
})

const fromCloud = (scope: Scope, from: string, until: string) =>
  inRestaurant(m.sql, scope.restaurantId, (tx) => cloudReportData(tx, scope, from, until))

const plan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 70, size: 'max' }),
  days: fc.array(fc.nat(2), { minLength: 1, maxLength: 150 }),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})
const range = fc.record({ from: fc.nat(2), length: fc.nat(2) })

describe('the same report as the hub', () => {
  it('with random histories (payments, voids and refunds from another day, reopened orders, shifts)', async () => {
    await fc.assert(
      fc.asyncProperty(plan, range, async (p, v) => {
        const h = buildHistory(p)
        const hub = await m.newHub()
        await upload(hub.hub, h.events)
        const from = DAYS[Math.min(v.from, 2)] as string
        const until = DAYS[Math.min(v.from + v.length, 2)] as string
        const inHub = reportData(hubStore(h.events), from, until)
        const { data, rounds } = await fromCloud(scopeOf(hub), from, until)
        expect(rounds).toBeLessThanOrEqual(MAX_ROUNDS)
        expect(data).toEqual(inHub)
        expect(report({ ...data, config: REPORT_CONFIG })).toEqual(
          report({ ...inHub, config: REPORT_CONFIG }),
        )
      }),
      { seed: 20_261_029, numRuns: 40 },
    )
  })

  it('a re-registered PC (another hub_id, same location) continues the same series', async () => {
    const h = buildHistory(fc.sample(plan, { seed: 7, numRuns: 1 })[0] as HistoryPlan)
    const first = await m.newHub()
    const half = Math.floor(h.events.length / 2)
    await upload(first.hub, h.events.slice(0, half))
    await m.cloud.revokeHub(first.hub.id)
    const code = await m.cloud.createCode(first.restaurantId)
    if (!code) throw new Error('no code')
    const again = await m.cloud.registerHub({
      code: code.code,
      restaurant_id: first.restaurantId,
      hub_id: newId(),
      location_id: first.hub.locationId,
      name: 'Caja nueva',
      instance: 'i2',
    })
    if (!again.ok) throw new Error(again.reason)
    const second = await m.cloud.authenticate(again.credential)
    if (!second) throw new Error('no hub')
    // The new PC resends a little of what was already there, then continues.
    await upload(second, h.events.slice(half - 3))
    const hubs = [first.hub.id, second.id]
    for (const [from, until] of [
      [DAYS[0], DAYS[2]],
      [DAYS[1], DAYS[1]],
    ] as const) {
      const { data } = await fromCloud(scopeOf(first, hubs), from, until)
      expect(data).toEqual(reportData(hubStore(h.events), from, until))
    }
  })

  it('another location of the same restaurant does not mix in (its sequences are another series)', async () => {
    const plans = fc.sample(plan, { seed: 11, numRuns: 2 }) as HistoryPlan[]
    const [a, b] = plans.map(buildHistory) as [
      ReturnType<typeof buildHistory>,
      ReturnType<typeof buildHistory>,
    ]
    const here = await m.newHub()
    const there = await m.newHub(here.restaurantId)
    expect(there.hub.locationId).not.toBe(here.hub.locationId)
    await upload(here.hub, a.events)
    await upload(there.hub, b.events)
    const { data } = await fromCloud(scopeOf(here), DAYS[0], DAYS[2])
    expect(data).toEqual(reportData(hubStore(a.events), DAYS[0], DAYS[2]))
  })

  it('with asOf, only what the hub had received up to that instant', async () => {
    const h = buildHistory(fc.sample(plan, { seed: 3, numRuns: 1 })[0] as HistoryPlan)
    const cut = Math.floor(h.events.length / 2)
    const timed = h.events.map((e, i) => ({
      ...e,
      received_at: new Date(Date.parse('2026-10-24T20:00:00.000Z') + i * 1000).toISOString(),
    })) as OrderEvent[]
    const hub = await m.newHub()
    await upload(hub.hub, timed)
    const asOf = (timed[cut - 1] as OrderEvent).received_at
    const { data } = await fromCloud(scopeOf(hub, [hub.hub.id], asOf), DAYS[0], DAYS[2])
    expect(data).toEqual(reportData(hubStore(timed.slice(0, cut)), DAYS[0], DAYS[2]))
  })

  it('a location with no hubs or no events gives an empty report, without errors', async () => {
    const hub = await m.newHub()
    const empty = reportData(new MemoryStore(), DAYS[0], DAYS[2])
    expect((await fromCloud(scopeOf(hub), DAYS[0], DAYS[2])).data).toEqual(empty)
    expect((await fromCloud(scopeOf(hub, []), DAYS[0], DAYS[2])).data).toEqual(empty)
  })

  it('the response has the shape of the hub’s /api/reports, without a printer', async () => {
    const h = buildHistory({
      ...(fc.sample(plan, { seed: 5, numRuns: 1 })[0] as HistoryPlan),
      closes: [true, true],
    })
    const hub = await m.newHub()
    await upload(hub.hub, h.events)
    const { data } = await fromCloud(scopeOf(hub), DAYS[0], DAYS[2])
    const names = new Map([[h.events[0]?.user_id as string, 'Caja']])
    const r = periodReport(data, configFrom({}), names, '2026-10-29')
    expect(Object.keys(r).sort()).toEqual(['closings', 'printer', 'report', 'today', 'users'])
    expect(r.printer).toBe(false)
    expect(r.today).toBe('2026-10-29')
    expect(r.closings).toHaveLength(data.registerClosings.length)
    expect(r.report).toEqual(report({ ...data, config: REPORT_CONFIG }))
    for (const name of Object.values(r.users)) expect(['Caja', 'Alguien']).toContain(name)
  })
})
