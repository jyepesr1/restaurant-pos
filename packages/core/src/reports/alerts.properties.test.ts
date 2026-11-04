import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { isLargeVariance, type ShiftReconciliation } from '../register/shift'
import { event, itemCopy, SHIFT } from '../testing/factory'
import { type AlertClosing, alerts } from './alerts'

// Properties of the owner's alerts (task 1.11c-2): the variance rule, and that the list does not
// depend on the order in which the cloud or the hub happen to hand over the events.

describe('isLargeVariance', () => {
  const pesos = fc.integer({ min: -2_000_000, max: 2_000_000 })
  const threshold = fc.integer({ min: 0, max: 1_000_000 })

  it('short and over count the same', () => {
    fc.assert(
      fc.property(pesos, threshold, (v, t) => isLargeVariance(v, t) === isLargeVariance(-v, t)),
    )
  })

  it('a variance of 0 is never large, whatever the threshold', () => {
    fc.assert(fc.property(threshold, (t) => !isLargeVariance(0, t)))
  })

  it('raising the threshold can only turn large variances into small ones', () => {
    fc.assert(
      fc.property(pesos, threshold, threshold, (v, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a]
        return !isLargeVariance(v, high) || isLargeVariance(v, low)
      }),
    )
  })

  it('thresholds 0 and 1 are the same rule: any difference counts', () => {
    fc.assert(fc.property(pesos, (v) => isLargeVariance(v, 0) === isLargeVariance(v, 1)))
  })

  it('the limit itself is large and one peso below it is not', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (t) => {
        expect(isLargeVariance(t, t)).toBe(true)
        expect(isLargeVariance(-t, t)).toBe(true)
        expect(isLargeVariance(t - 1, t)).toBe(false)
        expect(isLargeVariance(-(t - 1), t)).toBe(false)
        return true
      }),
    )
  })
})

const DAY = '2026-10-24'
const at = (n: number) => `${DAY}T${String(10 + (n % 12)).padStart(2, '0')}:00:00.000Z`

/** An order with a discount, a voided payment and a reopening on the day: three alerts. */
function busyOrder(n: number) {
  const id = newId()
  const item = itemCopy({ unit_price: 20_000 })
  const events: OrderEvent[] = [
    event(
      id,
      'OrderOpened',
      { channel: 'takeout', table_id: null, guests: 1 },
      { business_day: DAY },
    ),
    event(id, 'ItemAdded', item, { business_day: DAY }),
    event(
      id,
      'DiscountApplied',
      {
        discount_id: newId(),
        scope: 'item',
        rule: 'percent',
        value: 1000,
        unit_count: null,
        amounts: [{ item_id: item.item_id, amount: 2_000 }],
      },
      { business_day: DAY, received_at: at(n), reason: 'Cliente frecuente' },
    ),
  ]
  return { id, events }
}

function closing(n: number, variance: number): AlertClosing {
  const counted = 100_000 + variance
  return {
    eventId: newId(),
    openedBy: newId(),
    closedBy: newId(),
    reconciliation: {
      shiftId: SHIFT,
      registerId: newId(),
      base: 100_000,
      openedAt: at(0),
      byMethod: [],
      movements: [],
      cashCounts: [],
      unapplied: [],
      cash: { charged: 0, refunds: 0, cashIn: 0, cashOut: 0, tipPayouts: 0, expected: 100_000 },
      closed: {
        expected: 100_000,
        counted,
        variance,
        justification: 'x',
        otherMethods: [],
        time: at(n),
      },
    } satisfies ShiftReconciliation,
  }
}

describe('alerts() does not depend on the order it is handed things', () => {
  it('any order of the orders and of the register closes gives the same list', () => {
    const orders = [busyOrder(1), busyOrder(2), busyOrder(3), busyOrder(4)]
    const closings = [closing(5, -5_000), closing(6, 2_000), closing(7, 0), closing(8, -999)]
    const base = alerts({
      day: DAY,
      voids: [],
      cancellations: [],
      orders: new Map(orders.map((o) => [o.id, o.events])),
      registerClosings: closings,
      threshold: 1_000,
      unapplied: [],
    })
    expect(base.map((a) => a.type).sort()).toEqual(
      [...Array(4).fill('discount'), 'register_variance', 'register_variance'].sort(),
    )
    fc.assert(
      fc.property(
        fc.shuffledSubarray(orders, { minLength: orders.length, maxLength: orders.length }),
        fc.shuffledSubarray(closings, { minLength: closings.length, maxLength: closings.length }),
        (o, c) => {
          const list = alerts({
            day: DAY,
            voids: [],
            cancellations: [],
            orders: new Map(o.map((x) => [x.id, x.events])),
            registerClosings: c,
            threshold: 1_000,
            unapplied: [],
          })
          expect(list).toEqual(base)
          expect(new Set(list.map((a) => a.id)).size).toBe(list.length)
        },
      ),
      { seed: 20_261_103 },
    )
  })

  it('an order whose events come in reverse still ends up with the same discount alert', () => {
    const o = busyOrder(2)
    const forward = alerts({
      day: DAY,
      voids: [],
      cancellations: [],
      orders: new Map([[o.id, o.events]]),
      registerClosings: [],
      threshold: 0,
      unapplied: [],
    })
    expect(forward).toHaveLength(1)
    const reversed = alerts({
      day: DAY,
      voids: [],
      cancellations: [],
      orders: new Map([[o.id, [...o.events].reverse()]]),
      registerClosings: [],
      threshold: 0,
      unapplied: [],
    })
    expect(reversed).toHaveLength(1)
    expect(reversed[0]?.value).toBe(2_000)
  })
})
