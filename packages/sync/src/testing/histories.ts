import { newId, type OrderEvent, validateNewEvent } from '@pos/core'
// The @pos/core reducer simulator: two orders and two shifts with random events. Test-only, so it
// is imported by path and not from the package.
import { type Action, Service } from '../../../core/src/testing/simulator'
import type { HubStore } from '../hub/store'

// Random histories to test what the hub reads from the database for reports (task 1.9): the
// simulator's events, with business days spread out, register shifts opened and closed, and the
// contiguous sequence numbers the database requires.

export const DAYS = ['2026-10-23', '2026-10-24', '2026-10-25'] as const
const PERIOD_EVENT_TYPES = [
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
  'ItemVoided',
  'OrderCanceled',
]

export interface HistoryPlan {
  actions: Action[]
  /** One day (0..2) per event, by its position. */
  days: number[]
  /** Which of the two shifts are closed at the end. */
  closes: [boolean, boolean]
  /** With tips paid out from the register in each shift. */
  tips: [number, number]
  /**
   * Days in order, as in real life: events before `cuts[0]` belong to the first day, up to
   * `cuts[1]` to the second and the rest to the third (each is a position among the accepted
   * events). That way no new event falls on a day already past. Replaces `days`, and also spreads
   * the day of the table closes.
   */
  cuts?: [number, number]
}

export interface Story {
  service: Service
  /** All accepted events, with their contiguous sequence from 1. */
  events: OrderEvent[]
  shifts: readonly [string, string]
}

const REGISTER = newId()
const USER = newId()

function raw(
  type: string,
  aggregate: string,
  data: unknown,
  extras: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'register_shift',
    aggregate_id: aggregate,
    related: [],
    data,
    session_id: null,
    user_id: USER,
    device_id: REGISTER,
    authorization_id: null,
    reason: null,
    device_time: '2026-10-24T20:00:00.000Z',
    hub_estimated_time: '2026-10-24T20:00:00.000Z',
    base_sequence: 0,
    received_at: '2026-10-24T20:00:00.000Z',
    assignments: {},
    affects: [],
    authorized_by_id: null,
    ...extras,
  }
}

/** Builds the history: opens shifts, runs the simulator, spreads the days and closes shifts. */
export function buildHistory(plan: HistoryPlan): Story {
  const service = new Service()
  for (const a of plan.actions) service.step(a)
  const appliedEvents = new Set(service.appliedEvents.map((e) => e.id))
  const day = (i: number) => DAYS[plan.days[i % plan.days.length] ?? 1] as string

  const opening = service.shifts.map((t) =>
    raw('ShiftOpened', t, { register_id: REGISTER, base: 100_000 }, { business_day: DAYS[0] }),
  )
  const method = plan.cuts
    ? service.log
        .filter((e) => appliedEvents.has(e.id))
        .map((e, j) => {
          const [c1, c2] = plan.cuts as [number, number]
          const d = j < c1 ? DAYS[0] : j < c2 ? DAYS[1] : DAYS[2]
          return { ...e, business_day: d } as OrderEvent
        })
    : service.log
        .map((e, i) =>
          PERIOD_EVENT_TYPES.includes(e.type) ? ({ ...e, business_day: day(i) } as OrderEvent) : e,
        )
        .filter((e) => appliedEvents.has(e.id))
  const closeout = service.shifts.flatMap((t, n) => {
    const tips = plan.tips[n as 0 | 1]
    const events = []
    if (tips > 0)
      events.push(
        raw(
          'CashMovementRecorded',
          t,
          {
            movement_id: newId(),
            type: 'tip_payout',
            amount: tips,
            description: 'Propinas',
            to_whom: 'Equipo',
            days: [DAYS[1]],
          },
          { business_day: DAYS[1] },
        ),
      )
    if (plan.closes[n as 0 | 1]) {
      const cashCount = newId()
      events.push(
        raw(
          'CashCountRecorded',
          t,
          {
            cash_count_id: cashCount,
            tally: [{ value: 1_000, quantity: 100 }],
            counted_cash: 100_000,
          },
          { business_day: DAYS[2] },
        ),
        raw(
          'ShiftClosed',
          t,
          {
            cash_count_id: cashCount,
            expected_cash: 100_000,
            counted_cash: 100_000,
            variance: 0,
            justification: null,
            other_methods: [],
          },
          { business_day: DAYS[2] },
        ),
      )
    }
    return events
  })

  const events = [...opening, ...method, ...closeout].map((e, i) => ({
    ...e,
    sequence: i + 1,
  })) as unknown as OrderEvent[]
  // Register events go through the real schema: the history never has one the hub would reject.
  for (const e of events.filter((x) => x.aggregate_type === 'register_shift')) {
    const {
      sequence: _s,
      received_at: _r,
      business_day: _d,
      assignments: _a,
      affects: _f,
      authorized_by_id: _p,
      ...fresh
    } = e as unknown as Record<string, unknown>
    const v = validateNewEvent(fresh)
    if (!v.ok) throw new Error(`Invalid register event: ${v.errors.join('; ')}`)
  }
  return { service, events, shifts: service.shifts }
}

const ordersOf = (e: OrderEvent) => [...new Set([e.aggregate_id, ...e.related])]

/** Saves the events in a store, as the hub would save them. */
export function load(store: HubStore, events: readonly OrderEvent[]) {
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
}

/** Gives the events the contiguous sequence from 1 that the database requires. */
export const enumerate = (events: readonly OrderEvent[]): OrderEvent[] =>
  events.map((e, i) => ({ ...e, sequence: i + 1 }))
