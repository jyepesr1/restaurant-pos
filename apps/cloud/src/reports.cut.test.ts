import { newId, type OrderEvent } from '@pos/core'
import { MemoryStore, ordersOf, reportData } from '@pos/sync'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { actionArb } from '../../../packages/core/src/testing/simulator'
import { buildHistory, DAYS, type HistoryPlan } from '../../../packages/sync/src/testing/histories'
import { inRestaurant } from './cloud'
import { cloudReportData, type Scope, sequenceAt } from './reports'
import { createWorld, type TestHub, type World } from './testing/world'

// «Up to this time last week» (the dashboard): the cut is the highest sequence the hub had
// received by that instant, so the cloud gives what the hub gave with its first events. Also the
// error paths of loading: two events with the same sequence, and more rounds than allowed.

let m: World
beforeAll(async () => {
  m = await createWorld()
})

function hubStore(events: readonly OrderEvent[]) {
  const store = new MemoryStore()
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
  return store
}

async function upload(h: TestHub, events: readonly OrderEvent[]) {
  for (let i = 0; i < events.length; i += 500) {
    const r = await m.cloud.receiveEvents(h.hub, events.slice(i, i + 500))
    expect(r.every((x) => x.status === 'saved')).toBe(true)
  }
}

const scopeOf = (h: TestHub, extra: Partial<Scope> = {}): Scope => ({
  restaurantId: h.restaurantId,
  hubIds: [h.hub.id],
  ...extra,
})

const fromCloud = (scope: Scope, from: string, until: string) =>
  inRestaurant(m.sql, scope.restaurantId, (tx) => cloudReportData(tx, scope, from, until))

/** The cloud's cut, the two ways: loading again up to the sequence, or cutting a full load. */
async function bothCuts(h: TestHub, instant: string, from: string, until: string) {
  return inRestaurant(m.sql, h.restaurantId, async (tx) => {
    const scope = scopeOf(h)
    const cut = await sequenceAt(tx, h.restaurantId, scope.hubIds, instant)
    const loaded = await cloudReportData(tx, { ...scope, asOf: instant }, from, until)
    const full = await cloudReportData(tx, scope, from, until)
    const fromFull = await cloudReportData(tx, { ...scope, upTo: cut }, from, until, {
      store: full.store.upTo(cut),
    })
    return { cut, loaded: loaded.data, fromFull: fromFull.data }
  })
}

const BASE = Date.parse('2026-10-23T12:00:00.000Z')
const plan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 60, size: 'max' }),
  days: fc.array(fc.nat(2), { minLength: 1, maxLength: 100 }),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})

describe('the cut by sequence', () => {
  it('for every k: the cloud cut at received_at[k] is the hub with events[0..k]', async () => {
    await fc.assert(
      fc.asyncProperty(
        plan,
        fc.array(fc.nat(10_000), { minLength: 3, maxLength: 3 }),
        async (p, picks) => {
          const h = buildHistory(p)
          const events = h.events.map((e, i) => ({
            ...e,
            received_at: new Date(BASE + i * 1000).toISOString(),
          })) as OrderEvent[]
          const hub = await m.newHub()
          await upload(hub, events)
          for (const pick of picks) {
            const k = pick % events.length
            const instant = (events[k] as OrderEvent).received_at
            const expected = reportData(hubStore(events.slice(0, k + 1)), DAYS[0], DAYS[2])
            const r = await bothCuts(hub, instant, DAYS[0], DAYS[2])
            expect(r.cut).toBe(k + 1)
            expect(r.loaded).toEqual(expected)
            expect(r.fromFull).toEqual(expected)
          }
        },
      ),
      { seed: 20_261_030, numRuns: 20 },
    )
  })

  it('with a hub clock that goes back, the cut is the last sequence received by then', async () => {
    await fc.assert(
      fc.asyncProperty(
        plan,
        fc.array(fc.integer({ min: -40_000, max: 0 }), { minLength: 150, maxLength: 150 }),
        fc.nat(10_000),
        async (p, jitter, pick) => {
          const h = buildHistory(p)
          const events = h.events.map((e, i) => ({
            ...e,
            received_at: new Date(BASE + i * 1000 + (jitter[i] ?? 0)).toISOString(),
          })) as OrderEvent[]
          const hub = await m.newHub()
          await upload(hub, events)
          const instant = (events[pick % events.length] as OrderEvent).received_at
          const lastIndex = events.reduce(
            (last, e, i) => (Date.parse(e.received_at) <= Date.parse(instant) ? i : last),
            -1,
          )
          const expected = reportData(hubStore(events.slice(0, lastIndex + 1)), DAYS[0], DAYS[2])
          const r = await bothCuts(hub, instant, DAYS[0], DAYS[2])
          expect(r.cut).toBe(lastIndex + 1)
          expect(r.loaded).toEqual(expected)
          expect(r.fromFull).toEqual(expected)
        },
      ),
      { seed: 20_261_031, numRuns: 15 },
    )
  })

  const DAY = '2026-10-19'
  const at = (minute: number) =>
    new Date(Date.parse(`${DAY}T17:00:00.000Z`) + minute * 60_000).toISOString()
  const numbered = (list: OrderEvent[]) => list.map((e, i) => ({ ...e, sequence: i + 1 }))
  const hubFields = (minute: number, day = DAY) =>
    ({ business_day: day, received_at: at(minute) }) as Partial<OrderEvent>

  it('an order closed before the cut and reopened and closed again after it counts as at the cut', async () => {
    const order = newId()
    const events = numbered([
      event(
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: newId(), guests: 2 },
        hubFields(0),
      ),
      event(order, 'ItemAdded', itemCopy({ unit_price: 40_000 }), hubFields(1)),
      event(order, 'PaymentRecorded', cashPaymentData(40_000), hubFields(2)),
      event(order, 'OrderClosed', {}, hubFields(3)),
      event(order, 'OrderReopened', {}, { ...hubFields(10), reason: 'Motivo de prueba' }),
      event(order, 'ItemAdded', itemCopy({ unit_price: 15_000 }), hubFields(11)),
      event(order, 'PaymentRecorded', cashPaymentData(15_000), hubFields(12)),
      event(order, 'OrderClosed', {}, hubFields(13)),
    ])
    const hub = await m.newHub()
    await upload(hub, events)
    for (const k of [3, 5, 7]) {
      const expected = reportData(hubStore(events.slice(0, k + 1)), DAY, DAY)
      const r = await bothCuts(hub, at(k < 4 ? 3 : k + 6), DAY, DAY)
      expect(r.loaded).toEqual(expected)
      expect(r.fromFull).toEqual(expected)
    }
    const atCut = (await bothCuts(hub, at(5), DAY, DAY)).loaded
    expect(atCut.closings).toHaveLength(1)
  })

  it('a shift closed before the cut with charges from the day before keeps them', async () => {
    const shift = newId()
    const register = newId()
    const before = '2026-10-18'
    const shiftEvent = (type: string, data: unknown, fields: Partial<OrderEvent>) =>
      ({
        ...event(newId(), 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 }, fields),
        id: newId(),
        type,
        aggregate_type: 'register_shift',
        aggregate_id: shift,
        data,
      }) as unknown as OrderEvent
    const order = newId()
    const later = newId()
    const count = newId()
    const events = numbered([
      shiftEvent('ShiftOpened', { register_id: register, base: 50_000 }, hubFields(-600, before)),
      event(
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: newId(), guests: 2 },
        hubFields(-590, before),
      ),
      event(order, 'ItemAdded', itemCopy({ unit_price: 30_000 }), hubFields(-589, before)),
      event(
        order,
        'PaymentRecorded',
        cashPaymentData(30_000, { register_shift_id: shift }),
        hubFields(-588, before),
      ),
      event(order, 'OrderClosed', {}, hubFields(-587, before)),
      shiftEvent(
        'CashCountRecorded',
        { cash_count_id: count, tally: [{ value: 1_000, quantity: 80 }], counted_cash: 80_000 },
        hubFields(5),
      ),
      shiftEvent(
        'ShiftClosed',
        {
          cash_count_id: count,
          expected_cash: 80_000,
          counted_cash: 80_000,
          variance: 0,
          justification: null,
          other_methods: [],
        },
        hubFields(6),
      ),
      event(
        later,
        'OrderOpened',
        { channel: 'dine_in', table_id: newId(), guests: 2 },
        hubFields(30),
      ),
      event(later, 'ItemAdded', itemCopy({ unit_price: 9_000 }), hubFields(31)),
      event(later, 'PaymentRecorded', cashPaymentData(9_000), hubFields(32)),
      event(later, 'OrderClosed', {}, hubFields(33)),
    ])
    const hub = await m.newHub()
    await upload(hub, events)
    const expected = reportData(hubStore(events.slice(0, 7)), DAY, DAY)
    expect(expected.registerClosings).toHaveLength(1)
    const r = await bothCuts(hub, at(10), DAY, DAY)
    expect(r.cut).toBe(7)
    expect(r.loaded).toEqual(expected)
    expect(r.fromFull).toEqual(expected)
  })
})

describe('loading errors', () => {
  it('two different events with the same sequence in the location: no report, an error for the log', async () => {
    const first = await m.newHub()
    const order = newId()
    const a = event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }, {
      business_day: DAYS[1],
      sequence: 1,
    } as Partial<OrderEvent>)
    const b = {
      ...event(order, 'OrderClosed', {}, { business_day: DAYS[1] } as Partial<OrderEvent>),
      sequence: 1,
    }
    await upload(first, [a])
    // Another PC of the same location (re-registered without its history) that numbers from 1 again.
    const code = await m.cloud.createCode(first.restaurantId)
    if (!code) throw new Error('no code')
    const again = await m.cloud.registerHub({
      code: code.code,
      restaurant_id: first.restaurantId,
      hub_id: newId(),
      location_id: first.hub.locationId,
      name: 'Otra caja',
      instance: 'x',
    })
    if (!again.ok) throw new Error(again.reason)
    const second = await m.cloud.authenticate(again.credential)
    if (!second) throw new Error('no hub')
    expect((await m.cloud.receiveEvents(second, [b]))[0]?.status).toBe('saved')
    await expect(
      fromCloud(scopeOf(first, { hubIds: [first.hub.id, second.id] }), DAYS[1], DAYS[1]),
    ).rejects.toThrow(/misma secuencia 1/)
  })

  it('more rounds than allowed: an error, not an incomplete report', async () => {
    const h = buildHistory({
      ...(fc.sample(plan, { seed: 9, numRuns: 1 })[0] as HistoryPlan),
      closes: [true, true],
    })
    const hub = await m.newHub()
    await upload(hub, h.events)
    const full = await fromCloud(scopeOf(hub), DAYS[0], DAYS[2])
    // The closed shifts' charges are fetched in a second round.
    expect(full.rounds).toBeGreaterThan(1)
    await expect(
      inRestaurant(m.sql, hub.restaurantId, (tx) =>
        cloudReportData(tx, scopeOf(hub), DAYS[0], DAYS[2], { maxRounds: 1 }),
      ),
    ).rejects.toThrow(/más de 1 lecturas/)
  })
})
