import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ORDER_EVENT_TYPES, PRODUCT_EVENT_TYPES, SHIFT_EVENT_TYPES } from '../events/order'
import { shuffle } from '../testing/freeze'
import { type Action, actionArb, Service } from '../testing/simulator'
import { rebuild } from './apply'
import type { OrderState } from './state'
import { checkBalance, itemTotals, orderTotals } from './totals'

// Property tests of the reducer on two orders that move items between them and merge. The
// identities are those in docs/DINERO.md#día-operativo-e-informes. Fixed seed: same cases
// on every run.

const sequence = fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' })
const CONFIG = { seed: 20_261_024, numRuns: 600 }

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

/** Invariants every state must hold, whatever path led to it. */
function verifyState(status: OrderState) {
  const t = orderTotals(status)

  // gross − discounts − voids = net, on the order and on each line.
  expect(t.gross - t.discount - t.voided).toBe(t.net)
  let linesNet = 0
  for (const item of Object.values(status.items)) {
    const ti = itemTotals(status, item)
    expect(ti.gross - ti.discount - ti.voided).toBe(ti.net)
    expect(ti.net, `line ${item.name} ended with a negative net`).toBeGreaterThanOrEqual(0)
    expect(item.voidedQuantity).toBeLessThanOrEqual(item.quantity)
    linesNet += ti.net
  }
  expect(linesNet).toBe(t.net)

  // No discount stores a negative amount.
  for (const discount of Object.values(status.discounts)) {
    for (const amount of Object.values(discount.amounts)) expect(amount).toBeGreaterThanOrEqual(0)
  }

  // Never overcharge.
  expect(t.balance).toBeGreaterThanOrEqual(0)
  for (const payment of Object.values(status.payments)) {
    expect(payment.refundedSale).toBeLessThanOrEqual(payment.amount)
    expect(payment.refundedTip).toBeLessThanOrEqual(payment.tip)
  }

  // Σ charged = Σ amount + Σ rounding_adjustment, and a closed order charged exactly its net.
  const currentOnes = Object.values(status.payments).filter((p) => !p.voided)
  const charged = sum(currentOnes.map((p) => p.amount + p.roundingAdjustment))
  expect(charged).toBe(
    sum(currentOnes.map((p) => p.amount)) + sum(currentOnes.map((p) => p.roundingAdjustment)),
  )
  expect(t.paid + sum(currentOnes.map((p) => p.refundedSale)) + t.roundingAdjustments).toBe(charged)
  if (status.status === 'closed') {
    expect(t.balance).toBe(0)
    expect(sum(currentOnes.map((p) => p.amount - p.refundedSale))).toBe(t.net)
    expect(status.businessDay).not.toBeNull()
  }

  // With a split check, no check is overpaid and what is assigned fits within the balance.
  if (status.checks) {
    let pending = 0
    for (const check of status.checks) {
      const balance = checkBalance(status, check.id) ?? Number.NaN
      expect(balance).toBeGreaterThanOrEqual(0)
      pending += balance
    }
    expect(pending).toBeLessThanOrEqual(t.balance)
  }
}

function execute(actions: Action[], onEachStep?: (s: Service) => void): Service {
  const service = new Service()
  for (const action of actions) {
    service.step(action)
    for (const status of service.statuses) if (status) verifyState(status)
    onEachStep?.(service)
  }
  return service
}

describe('reducer properties with two orders', () => {
  it('report identities, no negative line net, and conservation when moving and merging', () => {
    const seenSet = new Set<string>()
    fc.assert(
      fc.property(sequence, (actions) => {
        const service = execute(actions)
        for (const type of service.appliedTypes) seenSet.add(type)

        expect(service.invalidCases).toEqual([])

        // Σ charged of current payments, recomputed from the applied events.
        const appliedPayments = new Map<string, number>()
        for (const e of service.appliedEvents) {
          if (e.type === 'PaymentRecorded') {
            appliedPayments.set(e.data.payment_id, e.data.amount + e.data.rounding_adjustment)
          }
        }
        for (const e of service.appliedEvents) {
          if (e.type === 'PaymentVoided') appliedPayments.delete(e.data.payment_id)
        }
        const fromEvents = sum([...appliedPayments.values()])
        const fromStates = sum(
          service.statuses.flatMap((status) =>
            Object.values(status?.payments ?? {})
              .filter((payment) => !payment.voided)
              .map((payment) => payment.amount + payment.roundingAdjustment),
          ),
        )
        expect(fromStates).toBe(fromEvents)

        for (const m of service.movements.filter((x) => x.type === 'ItemsMoved')) {
          // Moving an item between orders neither creates nor destroys money: the total of both
          // orders (and their gross and voided amounts) stays the same. Discounts prevent moving
          // the line.
          const before = m.before.map((e) => orderTotals(e))
          const after = m.after.map((e) => orderTotals(e))
          for (const field of ['net', 'gross', 'voided', 'discount'] as const) {
            expect(sum(after.map((t) => t[field])), `ItemsMoved changed ${field}`).toBe(
              sum(before.map((t) => t[field])),
            )
          }
        }
      }),
      CONFIG,
    )

    // The simulator exercises every order event except the rescue one, which creates another order.
    // Product (sold out) and register events do not belong to an order.
    const missingOnes = ORDER_EVENT_TYPES.filter(
      (type) =>
        type !== 'RescueOrderCreated' &&
        !PRODUCT_EVENT_TYPES.includes(type) &&
        !SHIFT_EVENT_TYPES.includes(type) &&
        !seenSet.has(type),
    )
    expect(missingOnes).toEqual([])
  })

  it('merging preserves the total: the source order arrives whole at the target', () => {
    fc.assert(
      fc.property(sequence, (actions) => {
        const service = execute(actions)
        for (const m of service.movements.filter((x) => x.type === 'OrdersMerged')) {
          const before = m.before.map((e) => orderTotals(e))
          const after = m.after.map((e) => orderTotals(e))
          expect(sum(after.map((t) => t.net)), 'OrdersMerged did not preserve the total').toBe(
            sum(before.map((t) => t.net)),
          )
          // The source ends empty and canceled, with no current payments.
          expect(after[m.source]?.net).toBe(0)
          expect(m.after[m.source]?.status).toBe('canceled')
        }
      }),
      { ...CONFIG, seed: 20_261_027 },
    )
  })

  it('the reducer never modifies its input (state and event deep-frozen)', () => {
    fc.assert(
      fc.property(sequence, (actions) => {
        const service = execute(actions)
        // A valid event is never treated as invalid: if the reducer mutated its frozen input
        // it would throw and show up here as `invalid_event`.
        expect(service.invalidCases).toEqual([])
        for (const status of service.statuses) {
          if (status) expect(Object.isFrozen(status)).toBe(true)
        }
      }),
      { ...CONFIG, seed: 20_261_025 },
    )
  })

  it('rebuilding with shuffled or reversed events gives the same state as in order', () => {
    fc.assert(
      fc.property(sequence, fc.integer({ min: 0, max: 2 ** 31 }), (actions, seedValue) => {
        const service = execute(actions)
        const shuffledLog = shuffle(service.log, seedValue)
        const reversed = [...service.log].reverse()

        for (const p of [0, 1] as const) {
          const id = service.orders[p]
          const inOrder = rebuild(service.log, id)
          expect(inOrder).toEqual(service.statuses[p])
          expect(rebuild(shuffledLog, id)).toEqual(inOrder)
          expect(rebuild(reversed, id)).toEqual(inOrder)
        }
      }),
      { ...CONFIG, seed: 20_261_026 },
    )
  })
})
