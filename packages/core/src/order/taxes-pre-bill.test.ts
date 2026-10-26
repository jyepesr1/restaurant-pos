import { describe, expect, it } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { event, inOrder, itemCopy } from '../testing/factory'
import { applyEvent } from './apply'
import type { OrderState } from './state'
import { checkPendingTip, orderTaxes, orderTotals } from './totals'

// The itemized tax on the pre-bill (task 1.6) and the tip still pending on a partially paid
// split check.

function orderWith(...items: Parameters<typeof itemCopy>[0][]): OrderState {
  const id = newId()
  const events: OrderEvent[] = [
    event(id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
    ...items.map((i) => event(id, 'ItemAdded', itemCopy(i))),
  ]
  return events.reduce<OrderState | null>((status, e) => {
    const r = applyEvent(status, inOrder(e, status?.lastSequence ?? 0))
    if (r.issue) throw new Error(r.issue.type)
    return r.status
  }, null) as OrderState
}

describe('orderTaxes', () => {
  it('$40.900 at 8 %: INC $3.030 and base $37.870 (the DIAN breakdown is 302.963 cents)', () => {
    expect(orderTaxes(orderWith({}))).toEqual([
      { type: 'inc', rate: 800, base: 37_870, tax: 3_030 },
    ])
  })

  it('groups by type and rate, and base + tax equals the order net', () => {
    const order = orderWith(
      { unit_price: 30_900, quantity: 2 },
      { unit_price: 12_000, tax_type: 'iva', rate: 1900 },
      { unit_price: 8_000, tax_type: 'exempt', rate: 0 },
    )
    const groups = orderTaxes(order)
    expect(groups.map((g) => `${g.type}:${g.rate}`)).toEqual(['inc:800', 'iva:1900', 'exempt:0'])
    expect(groups.find((g) => g.type === 'exempt')).toMatchObject({ base: 8_000, tax: 0 })
    expect(groups.reduce((a, g) => a + g.base + g.tax, 0)).toBe(orderTotals(order).net)
  })

  it('an order without products has no taxes', () => {
    expect(orderTaxes(orderWith())).toEqual([])
  })
})

describe('checkPendingTip', () => {
  const check = { amount: 33_334, suggestedTip: 3_087 }
  it('with no payments, the check tip; fully paid, 0', () => {
    expect(checkPendingTip(check, 33_334)).toBe(3_087)
    expect(checkPendingTip(check, 0)).toBe(0)
  })
  it('partially paid: the share of the tip for what is still due', () => {
    // Paid 20.000 of 33.334: 13.334 left → 3.087 × 13.334 / 33.334 ≈ 1.235.
    const missing = checkPendingTip(check, 13_334)
    expect(missing).toBe(1_235)
    // What was suggested in the partial payment plus what is left add up to the whole tip.
    expect(checkPendingTip(check, 33_334) - missing + missing).toBe(3_087)
  })
})
