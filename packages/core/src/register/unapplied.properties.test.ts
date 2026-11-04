import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ApplicableEvent, OrderEvent } from '../events/order'
import { newId } from '../id'
import { type ReportInput, report } from '../reports/report'
import { cardPaymentData, cashPaymentData, event } from '../testing/factory'
import { type ChargedByMethod, shiftReconciliation, type UnappliedMovement } from './shift'

// Money the hub did not apply (`unapplied`, task 1.7b, docs/DINERO.md#caja) over random register
// events with random marks: two shifts, payments by every method (cash with rounding and tip),
// voids and refunds from either shift (also of payments not among the events) and cash movements,
// on three business days. A marked event counts exactly as if it were not there, and what it
// would have moved is all in `unapplied`. Fixed seed: the same cases on every run.

const CONFIG = { seed: 20_261_104, numRuns: 400 }
const DAYS = ['2026-10-23', '2026-10-24', '2026-10-25'] as const
const SHIFTS = [newId(), newId()] as const
const CUSTOM = [newId(), newId()] as const
const REPORT_CONFIG: ReportInput['config'] = {
  sales_by_waiter: 'added_by',
  rounding_mode: 'half_up',
}

type Data<T extends OrderEvent['type']> = Extract<OrderEvent, { type: T }>['data']

const arbPayment = fc.record({
  kind: fc.constant('payment' as const),
  method: fc.constantFrom('cash', 'card', 'nequi', 'other0', 'other1'),
  amount: fc.integer({ min: 100, max: 300_000 }),
  adjustment: fc.integer({ min: -99, max: 99 }),
  tip: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 30_000 })),
  shift: fc.nat(1),
  day: fc.nat(2),
  marked: fc.boolean(),
})
/** A void or refund of the n-th payment (modulo how many there are); without payments, of none. */
const arbReversal = fc.record({
  kind: fc.constantFrom('void' as const, 'refund' as const),
  payment: fc.nat(),
  /** Of a payment that is not among the events (it was charged before them, or is unknown). */
  unknown: fc.boolean(),
  sale: fc.nat(),
  tip: fc.nat(),
  shift: fc.nat(1),
  day: fc.nat(2),
  marked: fc.boolean(),
})
const arbMovement = fc.record({
  kind: fc.constant('movement' as const),
  type: fc.constantFrom('cash_in' as const, 'cash_out' as const, 'tip_payout' as const),
  amount: fc.integer({ min: 1, max: 100_000 }),
  shift: fc.nat(1),
  day: fc.nat(2),
})
const arbStory = fc.record({
  bases: fc.tuple(fc.nat(500_000), fc.nat(500_000)),
  steps: fc.array(fc.oneof(arbPayment, arbPayment, arbReversal, arbMovement), {
    minLength: 1,
    maxLength: 40,
  }),
  from: fc.nat(2),
  length: fc.nat(2),
})

type Step = (typeof arbStory extends fc.Arbitrary<infer S> ? S : never)['steps'][number]

/** The events of a story. A void or refund of a marked payment is marked too: the hub could not
 * apply it (the order never had that payment). */
function eventsOf(bases: readonly [number, number], steps: readonly Step[]): ApplicableEvent[] {
  const order = newId()
  const out: ApplicableEvent[] = SHIFTS.map((shift, i) =>
    event(
      shift,
      'ShiftOpened',
      { register_id: newId(), base: bases[i] ?? 0 },
      { aggregate_type: 'register_shift', business_day: DAYS[0] },
    ),
  )
  const payments: { data: Data<'PaymentRecorded'>; marked: boolean }[] = []
  for (const s of steps) {
    const shift = SHIFTS[s.shift] as string
    const hub = { business_day: DAYS[s.day] }
    const mark = (marked: boolean) => (marked ? { unapplied: true as const } : {})
    if (s.kind === 'payment') {
      const custom = s.method === 'other0' ? CUSTOM[0] : s.method === 'other1' ? CUSTOM[1] : null
      const data =
        s.method === 'cash'
          ? cashPaymentData(s.amount, {
              register_shift_id: shift,
              rounding_adjustment: s.adjustment,
              tip: s.tip,
              change: 0,
              tendered: s.amount + s.adjustment + s.tip,
              rounding: s.adjustment === 0 ? null : { multiple: 100, mode: 'nearest_half_down' },
            })
          : cardPaymentData(s.amount, {
              register_shift_id: shift,
              tip: s.tip,
              ...(s.method === 'card'
                ? {}
                : custom
                  ? { method: 'other', custom_method_id: custom, cardTerminal: null }
                  : { method: 'nequi', cardTerminal: null }),
            } as never)
      payments.push({ data, marked: s.marked })
      out.push(event(order, 'PaymentRecorded', data, { ...hub, ...mark(s.marked) }))
    } else if (s.kind === 'movement') {
      out.push(
        event(
          shift,
          'CashMovementRecorded',
          {
            movement_id: newId(),
            type: s.type,
            amount: s.amount,
            description: 'Movimiento',
            to_whom: s.type === 'tip_payout' ? 'Equipo' : null,
            days: s.type === 'tip_payout' ? [hub.business_day as string] : [],
          },
          { aggregate_type: 'register_shift', ...hub } as never,
        ),
      )
    } else {
      const target = s.unknown ? undefined : payments[s.payment % Math.max(payments.length, 1)]
      const paymentId = target?.data.payment_id ?? newId()
      const marked = s.marked || target?.marked === true
      const extras = { ...hub, ...mark(marked), reason: 'Prueba' }
      if (s.kind === 'void')
        out.push(
          event(
            order,
            'PaymentVoided',
            { payment_id: paymentId, register_shift_id: shift },
            extras,
          ),
        )
      else {
        const sale = target ? s.sale % (target.data.amount + 1) : s.sale % 50_000
        const tip = target ? s.tip % (target.data.tip + 1) : 0
        out.push(
          event(
            order,
            'RefundRecorded',
            {
              payment_id: paymentId,
              refund_id: newId(),
              sale_amount: Math.max(sale, tip === 0 ? 1 : 0),
              tip_amount: tip,
              method: target?.data.method ?? 'card',
              register_shift_id: shift,
            },
            extras,
          ),
        )
      }
    }
  }
  return out
}

const withoutMarked = (events: readonly ApplicableEvent[]) => events.filter((e) => !e.unapplied)
const withoutMarks = (events: readonly ApplicableEvent[]) =>
  events.map((e) => {
    const { unapplied: _u, ...bare } = e
    return bare as ApplicableEvent
  })
const charged = (byMethod: readonly ChargedByMethod[], only?: string) =>
  byMethod.filter((m) => !only || m.method === only).reduce((a, m) => a + m.sale + m.tip, 0)
const apart = (list: readonly UnappliedMovement[], only?: string) =>
  list.filter((u) => !only || u.method === only).reduce((a, u) => a + (u.amount ?? 0), 0)
const isMoney = (e: ApplicableEvent) =>
  e.type === 'PaymentRecorded' || e.type === 'PaymentVoided' || e.type === 'RefundRecorded'

describe('random register events with random marks (task 1.7b)', () => {
  it('the shift reconciliation counts the marked ones as if they were not there, and lists them apart', () => {
    fc.assert(
      fc.property(arbStory, ({ bases, steps }) => {
        const events = eventsOf(bases, steps)
        for (const shift of SHIFTS) {
          const marked = shiftReconciliation(events, shift)
          const dropped = shiftReconciliation(withoutMarked(events), shift)
          const unmarked = shiftReconciliation(withoutMarks(events), shift)
          if (!marked || !dropped || !unmarked) throw new Error('No reconciliation')
          expect(marked.cash).toEqual(dropped.cash)
          expect(marked.byMethod).toEqual(dropped.byMethod)
          expect(marked.movements).toEqual(dropped.movements)
          expect(marked.cash.expected).toBe(
            marked.base +
              marked.cash.charged -
              marked.cash.refunds +
              marked.cash.cashIn -
              marked.cash.cashOut -
              marked.cash.tipPayouts,
          )
          // Apart: exactly the shift's marked money, in order.
          expect(marked.unapplied.map((u) => u.eventId)).toEqual(
            events
              .filter(
                (e) =>
                  e.unapplied &&
                  isMoney(e) &&
                  (e.data as { register_shift_id: string }).register_shift_id === shift,
              )
              .map((e) => e.id),
          )
          expect(dropped.unapplied).toEqual([])
          // Nothing is lost: what is counted plus what is apart is what would count with no marks.
          expect(charged(marked.byMethod) + apart(marked.unapplied)).toBe(
            charged(unmarked.byMethod),
          )
          expect(marked.cash.charged - marked.cash.refunds + apart(marked.unapplied, 'cash')).toBe(
            unmarked.cash.charged - unmarked.cash.refunds,
          )
        }
      }),
      CONFIG,
    )
  })

  it('the report’s methods and tip pool count the marked ones as if they were not there, and list them apart', () => {
    fc.assert(
      fc.property(arbStory, ({ bases, steps, from, length }) => {
        const events = eventsOf(bases, steps)
        const period = {
          from: DAYS[from] as string,
          until: DAYS[Math.min(from + length, 2)] as string,
        }
        const of = (list: readonly ApplicableEvent[]) =>
          report({ ...period, related: [], events: list, config: REPORT_CONFIG })
        const marked = of(events)
        const dropped = of(withoutMarked(events))
        const unmarked = of(withoutMarks(events))
        expect(marked.byMethod).toEqual(dropped.byMethod)
        expect(marked.tipPool).toEqual(dropped.tipPool)
        expect(dropped.unapplied).toEqual([])
        const inPeriod = (e: ApplicableEvent) =>
          (e.business_day ?? '') >= period.from && (e.business_day ?? '') <= period.until
        expect(marked.unapplied.map((u) => u.eventId)).toEqual(
          events.filter((e) => e.unapplied && isMoney(e) && inPeriod(e)).map((e) => e.id),
        )
        for (const method of [undefined, 'cash', 'card', 'nequi', 'other'])
          expect(charged(marked.byMethod, method) + apart(marked.unapplied, method)).toBe(
            charged(unmarked.byMethod, method),
          )
        // The tips apart are the tips the pool would have had.
        expect(marked.tipPool.tips + marked.unapplied.reduce((a, u) => a + (u.tip ?? 0), 0)).toBe(
          unmarked.tipPool.tips,
        )
      }),
      CONFIG,
    )
  })
})
