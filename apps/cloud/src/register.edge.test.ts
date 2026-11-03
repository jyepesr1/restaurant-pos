import { newId, type OrderEvent } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { event } from '../../../packages/core/src/testing/factory'
import { ALERT_DAYS } from './alerts'
import { type AlertsAnswer, addDays, type RegisterAnswer } from './panel'
import { panelRequest, putSnapshot } from './testing/panel'
import { person, publish, signInAs } from './testing/session'
import { createWorld, type TestHub, type World } from './testing/world'

// «Caja» and «Alertas» at the edges of the operating day (task 1.11c-2): a shift that crosses
// midnight, the 6:00 change of business day, the variance threshold at 0 and at its limit, and the
// 14-day limit that moves with the business day. The restaurant is in Bogotá (UTC-5).

let m: World
let hub: TestHub
let cookie: string

const CASHIER = newId()
const REGISTER = newId()

/** The clock, in UTC. Bogotá is UTC-5, so 11:00Z is 06:00 there. */
const setClock = (iso: string) => {
  m.clock.now = new Date(iso)
}

async function configure(threshold: number | undefined, start = '06:00') {
  expect(
    await putSnapshot(m, hub, 'config', {
      config: {
        business_day_start: start,
        ...(threshold === undefined ? {} : { register_variance_threshold: threshold }),
      },
      time_zone: 'America/Bogota',
    }),
  ).toBe(204)
}

let owner: ReturnType<typeof person>

beforeEach(async () => {
  m = await createWorld()
  hub = await m.newHub()
  owner = person(['remote_access', 'view_reports'], 'Dueña')
  await publish(m, hub, [owner])
  cookie = await signInAs(m, hub, owner)
})

/** Moves the clock far ahead and signs in again (a session idle for 7 days is gone). */
async function laterAt(iso: string) {
  setClock(iso)
  cookie = await signInAs(m, hub, owner)
}

const numbered = (events: readonly OrderEvent[]) =>
  events.map((e, i) => ({ ...e, sequence: i + 1 }))

async function upload(events: readonly OrderEvent[]) {
  const r = await m.cloud.receiveEvents(hub.hub, numbered(events))
  expect(r.every((x) => x.status === 'saved' || x.status === 'already_stored')).toBe(true)
}

interface Others {
  method: 'card' | 'transfer'
  expected: number
  reported: number
}

/** A shift opened with 100.000 and no sales, closed with `variance` in cash (and the other methods). */
function shift(opts: {
  openedAt: string
  openDay: string
  closedAt?: string
  closeDay?: string
  variance?: number
  others?: Others[]
  justification?: string | null
  base?: number
}) {
  const base = opts.base ?? 100_000
  const id = newId()
  const common = {
    aggregate_type: 'register_shift' as const,
    user_id: CASHIER,
    device_id: REGISTER,
  }
  const events: OrderEvent[] = [
    event(
      id,
      'ShiftOpened',
      { register_id: REGISTER, base },
      { ...common, business_day: opts.openDay, received_at: opts.openedAt },
    ),
  ]
  if (opts.closedAt) {
    const count = newId()
    const variance = opts.variance ?? 0
    const at = {
      ...common,
      business_day: opts.closeDay ?? opts.openDay,
      received_at: opts.closedAt,
    }
    events.push(
      event(
        id,
        'CashCountRecorded',
        {
          cash_count_id: count,
          tally: [
            { value: 1000, quantity: Math.floor((base + variance) / 1000) },
            { value: 1, quantity: (base + variance) % 1000 },
          ],
          counted_cash: base + variance,
        },
        at,
      ),
      event(
        id,
        'ShiftClosed',
        {
          cash_count_id: count,
          expected_cash: base,
          counted_cash: base + variance,
          variance,
          justification: opts.justification ?? (variance === 0 ? null : 'Se contó mal'),
          other_methods: (opts.others ?? []).map((o) => ({
            method: o.method,
            custom_method_id: null,
            expected: o.expected,
            reported: o.reported,
            variance: o.reported - o.expected,
          })),
        },
        at,
      ),
    )
  }
  return { id, events }
}

const get = async <T>(route: string): Promise<{ status: number; body: T }> => {
  const r = await panelRequest(m, 'GET', route, { cookie })
  return { status: r.status, body: (await r.json()) as T }
}
const register = async () => (await get<RegisterAnswer>('/v1/panel/register')).body
const alertsOf = async (day = '') =>
  (await get<AlertsAnswer>(`/v1/panel/alerts${day ? `?day=${day}` : ''}`)).body

describe('the business day changes at 6:00, not at midnight', () => {
  // Opened at 23:30 on the 26th (04:30Z the 27th), closed at 01:30 on the 27th with 5.000 missing.
  const night = () =>
    shift({
      openedAt: '2026-10-27T04:30:00.000Z',
      openDay: '2026-10-26',
      closedAt: '2026-10-27T06:30:00.000Z',
      closeDay: '2026-10-26',
      variance: -5_000,
    })

  it('until 05:59 the new calendar day has not started: «today» is still the 26th everywhere', async () => {
    await configure(undefined)
    await upload(night().events)
    setClock('2026-10-27T10:59:59.000Z')
    const [floor, reg, al, summary] = await Promise.all([
      get<{ today: string }>('/v1/panel/floor'),
      get<RegisterAnswer>('/v1/panel/register'),
      get<AlertsAnswer>('/v1/panel/alerts'),
      get<{ today: string; alerts: number }>('/v1/panel/summary'),
    ])
    expect([floor.body.today, reg.body.today, al.body.today, summary.body.today]).toEqual(
      Array(4).fill('2026-10-26'),
    )
    // The close made after midnight still counts for the 26th: it is today’s close and today’s alert.
    expect(reg.body.closed.map((c) => c.businessDay)).toEqual(['2026-10-26'])
    expect(al.body.alerts.map((a) => [a.type, a.value])).toEqual([['register_variance', -5_000]])
    expect(summary.body.alerts).toBe(1)
    // And the 27th has not come.
    const tomorrow = await get<{ message: string }>('/v1/panel/alerts?day=2026-10-27')
    expect(tomorrow.status).toBe(400)
    expect(tomorrow.body.message).toBe('Ese día todavía no ha llegado')
  })

  it('at 06:00 sharp the 27th starts: yesterday’s close leaves «cerradas hoy» and is an alert of the 26th', async () => {
    await configure(undefined)
    await upload(night().events)
    setClock('2026-10-27T11:00:00.000Z')
    const reg = await register()
    expect(reg.today).toBe('2026-10-27')
    expect(reg.closed).toEqual([])
    expect(reg.open).toEqual([])
    expect((await alertsOf()).alerts).toEqual([])
    const yesterday = await alertsOf('2026-10-26')
    expect(yesterday.alerts.map((a) => a.type)).toEqual(['register_variance'])
    expect(yesterday.alerts[0]).toMatchObject({ userId: CASHIER, reason: 'Se contó mal' })
  })

  it('a shift still open after midnight is open before and after the change of day, with the same expected cash', async () => {
    await configure(undefined)
    const open = shift({ openedAt: '2026-10-27T04:30:00.000Z', openDay: '2026-10-26' })
    await upload(open.events)
    for (const clock of [
      '2026-10-27T05:30:00.000Z', // 00:30
      '2026-10-27T10:59:59.000Z', // 05:59:59
      '2026-10-27T11:00:00.000Z', // 06:00
      '2026-10-28T16:00:00.000Z', // a day and a half later, still not closed
    ]) {
      setClock(clock)
      const reg = await register()
      expect(
        reg.open.map((o) => o.shift_id),
        clock,
      ).toEqual([open.id])
      expect(reg.open[0]?.reconciliation.cash.expected, clock).toBe(100_000)
      expect(reg.open[0]?.opened_at).toBe('2026-10-27T04:30:00.000Z')
    }
  })

  it('a shift opened the day before and closed after the change of day: an alert of the closing day only', async () => {
    await configure(undefined)
    await upload(
      shift({
        openedAt: '2026-10-26T20:00:00.000Z',
        openDay: '2026-10-26',
        closedAt: '2026-10-27T14:00:00.000Z',
        closeDay: '2026-10-27',
        variance: 2_000,
      }).events,
    )
    setClock('2026-10-27T15:00:00.000Z')
    expect((await alertsOf('2026-10-26')).alerts).toEqual([])
    const day = await alertsOf('2026-10-27')
    expect(day.alerts.map((a) => [a.type, a.value])).toEqual([['register_variance', 2_000]])
    expect((await register()).closed.map((c) => c.businessDay)).toEqual(['2026-10-27'])
  })

  it('another start of day (04:00) and another time zone move the change exactly there', async () => {
    await configure(undefined, '04:00')
    await upload(night().events)
    setClock('2026-10-27T08:59:59.000Z') // 03:59:59 in Bogotá
    expect((await register()).today).toBe('2026-10-26')
    setClock('2026-10-27T09:00:00.000Z') // 04:00:00
    expect((await register()).today).toBe('2026-10-27')
    // Pacific/Auckland (UTC+13 in October): the same instant is already the 28th in the morning.
    expect(
      await putSnapshot(m, hub, 'config', {
        config: { business_day_start: '06:00' },
        time_zone: 'Pacific/Auckland',
      }),
    ).toBe(204)
    setClock('2026-10-27T16:59:59.000Z') // 05:59:59 on the 28th there
    expect((await register()).today).toBe('2026-10-27')
    setClock('2026-10-27T17:00:00.000Z') // 06:00 on the 28th there
    expect((await register()).today).toBe('2026-10-28')
  })
})

describe('the 14-day limit moves with the business day', () => {
  it('the oldest day allowed is 14 days before today, and it changes at 06:00', async () => {
    await configure(undefined)
    const oldest = (today: string) => addDays(today, -ALERT_DAYS)
    // 05:59 on 2026-11-10: today is the 9th.
    await laterAt('2026-11-10T10:59:59.000Z')
    expect((await get('/v1/panel/alerts')).status).toBe(200)
    expect((await get(`/v1/panel/alerts?day=${oldest('2026-11-09')}`)).status).toBe(200)
    expect((await get(`/v1/panel/alerts?day=${addDays(oldest('2026-11-09'), -1)}`)).status).toBe(
      400,
    )
    // One second later, the 10th: the 26th of October (the oldest before) is out.
    setClock('2026-11-10T11:00:00.000Z')
    expect((await get(`/v1/panel/alerts?day=${oldest('2026-11-09')}`)).status).toBe(400)
    expect((await get(`/v1/panel/alerts?day=${oldest('2026-11-10')}`)).status).toBe(200)
    // Today’s own day is always allowed, the next one never.
    expect((await get('/v1/panel/alerts?day=2026-11-10')).status).toBe(200)
    expect((await get('/v1/panel/alerts?day=2026-11-11')).status).toBe(400)
  })

  it('across a year end the limit counts real days', async () => {
    await configure(undefined)
    await laterAt('2027-01-05T15:00:00.000Z')
    expect((await get('/v1/panel/alerts?day=2026-12-22')).status).toBe(200)
    expect((await get('/v1/panel/alerts?day=2026-12-21')).status).toBe(400)
    // A leap day: 2028-03-01 minus 14 is 2028-02-16 (the 29th exists).
    await laterAt('2028-03-01T15:00:00.000Z')
    expect((await get('/v1/panel/alerts?day=2028-02-16')).status).toBe(200)
    expect((await get('/v1/panel/alerts?day=2028-02-15')).status).toBe(400)
  })

  it('a day with alerts exactly 14 days back still shows them', async () => {
    await configure(undefined)
    const day = '2026-10-12'
    await upload(
      shift({
        openedAt: `${day}T14:00:00.000Z`,
        openDay: day,
        closedAt: `${day}T23:00:00.000Z`,
        variance: -3_000,
      }).events,
    )
    setClock('2026-10-26T15:00:00.000Z')
    expect(addDays('2026-10-26', -ALERT_DAYS)).toBe(day)
    expect((await alertsOf(day)).alerts.map((a) => a.value)).toEqual([-3_000])
  })
})

describe('the variance threshold', () => {
  const close = (variance: number, others: Others[] = [], base?: number) =>
    shift({
      base,
      openedAt: '2026-10-26T14:00:00.000Z',
      openDay: '2026-10-26',
      closedAt: '2026-10-26T23:00:00.000Z',
      variance,
      others,
    }).events

  const typesFor = async (
    threshold: number | undefined,
    variance: number,
    others?: Others[],
    base?: number,
  ) => {
    m = await createWorld()
    hub = await m.newHub()
    const owner = person(['remote_access', 'view_reports'])
    await publish(m, hub, [owner])
    cookie = await signInAs(m, hub, owner)
    await configure(threshold)
    await upload(close(variance, others, base))
    setClock('2026-10-26T23:30:00.000Z')
    const a = await alertsOf()
    return { alerts: a.alerts, threshold: a.threshold }
  }

  it('threshold 0 behaves as 1: a variance of 0 is never an alert, one peso is', async () => {
    const exact = await typesFor(0, 0)
    expect(exact.threshold).toBe(0)
    expect(exact.alerts).toEqual([])
    for (const v of [-1, 1]) {
      const r = await typesFor(0, v)
      expect(
        r.alerts.map((a) => [a.type, a.value]),
        `${v}`,
      ).toEqual([['register_variance', v]])
    }
    // The same as threshold 1.
    expect((await typesFor(1, 0)).alerts).toEqual([])
    expect((await typesFor(1, -1)).alerts).toHaveLength(1)
  })

  it('at the limit it is an alert, one peso below it is not (short or over)', async () => {
    for (const [variance, expected] of [
      [-999, 0],
      [-1000, 1],
      [999, 0],
      [1000, 1],
      [-1001, 1],
    ] as const)
      expect((await typesFor(1000, variance)).alerts, `${variance}`).toHaveLength(expected)
    // The default threshold (none configured) is 1.000.
    const unset = await typesFor(undefined, -1000)
    expect(unset.threshold).toBe(1000)
    expect(unset.alerts).toHaveLength(1)
    expect((await typesFor(undefined, -999)).alerts).toEqual([])
  })

  it('the highest threshold (1.000.000) silences anything below it', async () => {
    expect((await typesFor(1_000_000, -999_999, [], 2_000_000)).alerts).toEqual([])
    expect((await typesFor(1_000_000, -1_000_000, [], 2_000_000)).alerts).toHaveLength(1)
  })

  it('datáfono and app variances follow the same limit, one alert per method', async () => {
    const r = await typesFor(1000, 0, [
      { method: 'card', expected: 500_000, reported: 499_000 },
      { method: 'transfer', expected: 80_000, reported: 80_999 },
    ])
    expect(r.alerts.map((a) => a.type)).toEqual(['register_variance'])
    expect(r.alerts[0]).toMatchObject({
      method: 'card',
      value: -1000,
      expected: 500_000,
      counted: 499_000,
    })
    const both = await typesFor(1000, -2_000, [
      { method: 'card', expected: 10_000, reported: 12_000 },
    ])
    expect(both.alerts.map((a) => [a.type, a.value]).sort()).toEqual([
      ['register_variance', -2000],
      ['register_variance', 2000],
    ])
    // Threshold 0 and a method off by one peso: an alert, as the hub says.
    const zero = await typesFor(0, 0, [{ method: 'card', expected: 10_000, reported: 10_001 }])
    expect(zero.alerts.map((a) => a.value)).toEqual([1])
  })

  it('the register screen gets the threshold the alerts use', async () => {
    await configure(0)
    expect((await register()).threshold).toBe(0)
    await configure(2_500)
    expect((await register()).threshold).toBe(2_500)
  })
})
