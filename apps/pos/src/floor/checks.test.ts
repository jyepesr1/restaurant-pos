import {
  chargedInCash,
  METHOD_NAME,
  newId,
  type OrderState,
  orderTotals,
  PaymentMethod,
  suggestedTip,
  validateNewEvent,
} from '@pos/core'
import type { Catalog, LocalEvent, LocalState } from '@pos/sync'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  byProducts,
  type CheckoutRules,
  cashPayment,
  cashTip,
  checkoutOptions,
  inEqualParts,
  linesOf,
  methodName,
  outstanding,
  paymentTip,
  rulesOf,
  shiftOfRegister,
  shiftSummary,
  suggestedTipOf,
  taxName,
  tipWithPercent,
  trimAssignments,
} from './checks'
import { openOrders } from './projection'
import { inOrder, itemData, local, opening, TIME, testCatalog } from './testing'

// Pre-bill, split, payments and tip at the register (task 1.6): each amount comes from `@pos/core`
// with the restaurant's rules (docs/DINERO.md). This tests what `checks.ts` builds.

const RULES: CheckoutRules = {
  paymentMethods: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
  suggestedTip: 1000,
  roundingMode: 'half_up',
  cashRounding: 100,
  cashRoundingMode: 'nearest_half_down',
  printsPreBill: false,
}

const SHIFT = newId()
const paymentIdOf = (l: LocalEvent) => (l.event.data as { payment_id: string }).payment_id
const add = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)

/** An id counter so the split tests are readable. */
const ids = () => {
  let n = 0
  return () => `check-${++n}`
}

/** An open order with those products (price × quantity, at 8 %). */
function orderWith(
  products: { price: number; quantity?: number; name?: string; rate?: number }[],
  extra: LocalEvent[] = [],
): { id: string; status: OrderState; items: string[] } {
  const id = newId()
  const items = products.map((p) =>
    itemData({
      unit_price: p.price,
      quantity: p.quantity ?? 1,
      name: p.name ?? 'Plato',
      rate: p.rate ?? 800,
    }),
  )
  const events = [
    local('OrderOpened', id, opening),
    ...items.map((i) => local('ItemAdded', id, i)),
    ...extra.map((e) => ({ ...e, event: { ...e.event, aggregate_id: id } })),
  ] as LocalEvent[]
  const visible = openOrders(inOrder(events)).find((p) => p.status.id === id)
  if (!visible) throw new Error('no order')
  return { id, status: visible.status, items: items.map((i) => i.item_id) }
}

/** The same order after applying more own events. */
function withEvents(id: string, base: LocalEvent[], more: LocalEvent[]): OrderState {
  const v = openOrders(inOrder([...base, ...more])).find((p) => p.status.id === id)
  if (!v) throw new Error('no order')
  return v.status
}

const paymentData = (fields: Record<string, unknown> = {}) => ({
  payment_id: newId(),
  check_id: null,
  register_shift_id: SHIFT,
  method: 'nequi' as const,
  amount: 1_000,
  tip: 0,
  tendered: null,
  change: null,
  rounding_adjustment: 0,
  rounding: null,
  cardTerminal: null,
  charge_reference: null,
  ...fields,
})

/** A single-dish order with own events (for payments and splits). */
function oneDishOrder(price: number, more: (id: string) => LocalEvent[] = () => []) {
  const id = newId()
  const dish = itemData({ unit_price: price })
  const base = [local('OrderOpened', id, opening), local('ItemAdded', id, dish)] as LocalEvent[]
  const events = [...base, ...more(id)]
  const v = openOrders(inOrder(events)).find((p) => p.status.id === id)
  if (!v) throw new Error('no order')
  return { id, status: v.status, base, dish, events }
}

describe('rulesOf, names and format', () => {
  it('a catalog without checkout (hub from before 1.6) or no catalog has no rules', () => {
    expect(rulesOf(null)).toBeNull()
    expect(rulesOf(testCatalog())).toBeNull()
  })

  it('with checkout it returns the rules as they are', () => {
    const catalog: Catalog = testCatalog()
    catalog.restaurant.checkout = RULES
    expect(rulesOf(catalog)).toBe(RULES)
  })

  it('each payment method has its name in Spanish', () => {
    expect(Object.keys(METHOD_NAME).sort()).toEqual([...PaymentMethod.options].sort())
    expect(METHOD_NAME.nequi).toBe('Nequi')
    expect(METHOD_NAME.breb).toBe('Bre-B')
    for (const name of Object.values(METHOD_NAME)) expect(name.length).toBeGreaterThan(2)
  })

  it('taxName: INC, IVA and exempt', () => {
    expect(taxName('inc', 800)).toBe('INC 8 %')
    expect(taxName('iva', 1900)).toBe('IVA 19 %')
    expect(taxName('iva', 550)).toBe('IVA 5,5 %')
    expect(taxName('exempt', 0)).toBe('Exento')
    expect(taxName('inc', 0)).toBe('Exento')
  })
})

describe('suggestedTipOf and cashTip', () => {
  it("it is the order's tip: 100.000 at 8 % → 9.259; an amount of 0 or less, 0", () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(suggestedTipOf(status, 100_000, RULES)).toBe(9_259)
    expect(suggestedTipOf(status, 0, RULES)).toBe(0)
    expect(suggestedTipOf(status, -5, RULES)).toBe(0)
  })

  it("follows the restaurant's rate: 0 % suggests nothing", () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(suggestedTipOf(status, 100_000, { ...RULES, suggestedTip: 0 })).toBe(0)
    expect(suggestedTipOf(status, 100_000, { ...RULES, suggestedTip: 500 })).toBe(4_630)
  })

  it.each([
    [23_843, 23_800],
    [23_850, 23_800],
    [23_851, 23_900],
    [23_800, 23_800],
    [0, 0],
    [49, 0],
    [50, 0],
    [51, 100],
  ])(
    'in cash the tip %i is suggested rounded to %i (multiple of 100, half toward the customer)',
    (tip, expected) => {
      expect(cashTip(tip, RULES)).toBe(expected)
    },
  )

  it('with another multiple or mode of the restaurant', () => {
    expect(cashTip(23_843, { ...RULES, cashRounding: 50 })).toBe(23_850)
    expect(cashTip(23_843, { ...RULES, cashRounding: 1 })).toBe(23_843)
    expect(cashTip(23_843, { ...RULES, cashRoundingMode: 'up' })).toBe(23_900)
    expect(cashTip(23_843, { ...RULES, cashRoundingMode: 'down' })).toBe(23_800)
  })
})

describe('paymentTip: partial payments add up to the whole tip', () => {
  it('100.000: 30.000 + 70.000 give 2.778 + 6.481 = 9.259', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const a = paymentTip(status, null, 100_000, 30_000, RULES)
    const b = paymentTip(status, null, 70_000, 70_000, RULES)
    expect([a, b]).toEqual([2_778, 6_481])
    expect(a + b).toBe(suggestedTipOf(status, 100_000, RULES))
  })

  it('amount 0, negative or greater than what is available: 0', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(paymentTip(status, null, 100_000, 0, RULES)).toBe(0)
    expect(paymentTip(status, null, 100_000, -1, RULES)).toBe(0)
    expect(paymentTip(status, null, 100_000, 100_001, RULES)).toBe(0)
  })

  it('paying everything available carries the tip of everything available', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(paymentTip(status, null, 60_000, 60_000, RULES)).toBe(5_556)
  })

  it('in a split check it uses the tip set when splitting (4.630 of 50.000)', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const check = { amount: 50_000, suggestedTip: 4_630 }
    expect(paymentTip(status, check, 50_000, 50_000, RULES)).toBe(4_630)
    const a = paymentTip(status, check, 50_000, 20_000, RULES)
    const b = paymentTip(status, check, 30_000, 30_000, RULES)
    expect(a + b).toBe(4_630)
  })

  it('property: any allocation of the balance into payments adds up to the tip of the balance', () => {
    const { status } = orderWith([{ price: 87_650 }, { price: 12_300, quantity: 3 }])
    const balance = orderTotals(status).balance
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 6 }),
        (relativeWeights) => {
          const total = add(relativeWeights)
          // Whole parts that add up to the balance (the last one takes the rest).
          const parts = relativeWeights.map((p) => Math.floor((balance * p) / total))
          parts[parts.length - 1] = (parts.at(-1) ?? 0) + (balance - add(parts))
          let available = balance
          let sum = 0
          for (const share of parts) {
            if (share <= 0) continue
            sum += paymentTip(status, null, available, share, RULES)
            available -= share
          }
          expect(sum).toBe(suggestedTipOf(status, balance, RULES))
        },
      ),
      { seed: 16, numRuns: 200 },
    )
  })
})

describe('linesOf: what is still standing', () => {
  it('in the order it was ordered, with options and net', () => {
    const { status } = orderWith([
      { price: 40_900, name: 'Margarita', quantity: 2 },
      { price: 58_900, name: 'Tagliata' },
    ])
    expect(linesOf(status).map((l) => [l.name, l.quantity, l.net])).toEqual([
      ['Margarita', 2, 81_800],
      ['Tagliata', 1, 58_900],
    ])
  })

  it('an order without products has no lines', () => {
    expect(linesOf(orderWith([]).status)).toEqual([])
  })
})

describe('inEqualParts', () => {
  it('100.000 in 3: 33.334 + 33.333 + 33.333, with their names and no fixed products', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const checks = inEqualParts(status, 3, RULES, ids())
    expect(checks.map((c) => c.amount)).toEqual([33_334, 33_333, 33_333])
    expect(checks.map((c) => c.name)).toEqual(['Persona 1', 'Persona 2', 'Persona 3'])
    expect(checks.map((c) => c.check_id)).toEqual(['check-1', 'check-2', 'check-3'])
    for (const c of checks) expect(c.items).toEqual([])
  })

  it('the tips add up to the balance tip allocated by largest remainder (9.259 in 3)', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const checks = inEqualParts(status, 3, RULES, ids())
    expect(add(checks.map((c) => c.suggested_tip))).toBe(9_259)
    expect(checks.map((c) => c.suggested_tip)).toEqual([3_087, 3_086, 3_086])
  })

  it('with $40.000 already paid: the $60.000 balance in 2 → 30.000 + 30.000 and tips 2.778 + 2.778', () => {
    const p = oneDishOrder(100_000, (id) => [
      local('PaymentRecorded', id, paymentData({ amount: 40_000 })),
    ])
    const checks = inEqualParts(p.status, 2, RULES, ids())
    expect(checks.map((c) => c.amount)).toEqual([30_000, 30_000])
    expect(checks.map((c) => c.suggested_tip)).toEqual([2_778, 2_778])
  })

  it('more people than pesos: 2 pesos in 3 → 1 + 1 + 0, with no negative amounts', () => {
    const { status } = orderWith([{ price: 2 }])
    const checks = inEqualParts(status, 3, RULES, ids())
    expect(checks.map((c) => c.amount)).toEqual([1, 1, 0])
  })

  it('a balance of 0 (all paid) gives checks at 0 and tips at 0, without throwing', () => {
    const p = oneDishOrder(40_000, (id) => [
      local('PaymentRecorded', id, paymentData({ amount: 40_000 })),
    ])
    const checks = inEqualParts(p.status, 2, RULES, ids())
    expect(checks.map((c) => [c.amount, c.suggested_tip])).toEqual([
      [0, 0],
      [0, 0],
    ])
  })

  it('with no suggested tip in the restaurant, the checks carry 0', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const checks = inEqualParts(status, 4, { ...RULES, suggestedTip: 0 }, ids())
    expect(checks.map((c) => c.suggested_tip)).toEqual([0, 0, 0, 0])
  })

  it('the split passes the CheckSplit schema and the reducer accepts it, and the checks add up to the balance', () => {
    const { id, status, base } = oneDishOrder(100_000)
    const checks = inEqualParts(status, 3, RULES, newId)
    const event = local('CheckSplit', id, { checks })
    expect(validateNewEvent(withoutHub(event)).ok).toBe(true)
    const after = withEvents(id, base, [event])
    expect(after.checks?.map((c) => c.amount)).toEqual([33_334, 33_333, 33_333])
    expect(add(after.checks?.map((c) => c.amount) ?? [])).toBe(orderTotals(after).balance)
  })

  it('property: Σ amounts = balance, Σ tips = balance tip, nothing negative', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            price: fc.integer({ min: 0, max: 300_000 }),
            quantity: fc.integer({ min: 1, max: 5 }),
            rate: fc.constantFrom(0, 800, 1900),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.integer({ min: 2, max: 12 }),
        fc.integer({ min: 0, max: 1000 }),
        (products, people, tipRate) => {
          const { status } = orderWith(products)
          const rules = { ...RULES, suggestedTip: tipRate }
          const balance = orderTotals(status).balance
          const checks = inEqualParts(status, people, rules, newId)
          expect(add(checks.map((c) => c.amount))).toBe(balance)
          expect(add(checks.map((c) => c.suggested_tip))).toBe(
            suggestedTipOf(status, balance, rules),
          )
          for (const c of checks) {
            expect(c.amount).toBeGreaterThanOrEqual(0)
            expect(c.suggested_tip).toBeGreaterThanOrEqual(0)
          }
          const largest = Math.max(...checks.map((c) => c.amount))
          const smallest = Math.min(...checks.map((c) => c.amount))
          expect(largest - smallest).toBeLessThanOrEqual(1)
        },
      ),
      { seed: 17, numRuns: 150 },
    )
  })
})

/** The event as the device creates it (without what the hub adds), for the schema. */
function withoutHub(l: LocalEvent) {
  const {
    sequence: _s,
    received_at: _r,
    business_day: _d,
    assignments: _a,
    affects: _f,
    authorized_by_id: _p,
    ...fresh
  } = l.event as unknown as Record<string, unknown>
  return fresh
}

function stateWithVoided(p: ReturnType<typeof oneDishOrder>, other: ReturnType<typeof itemData>) {
  return withEvents(
    p.id,
    [...p.base, local('ItemAdded', p.id, other)],
    [
      local('ItemsSent', p.id, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [other.item_id] }],
      }),
      local(
        'ItemVoided',
        p.id,
        { item_id: other.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        'confirmed',
        { reason: 'Error' },
      ),
    ],
  )
}

describe('byProducts', () => {
  it('each product to its check: amounts, whole fractions and nothing unassigned', () => {
    const { status, items } = orderWith([{ price: 40_000 }, { price: 60_000 }])
    const r = byProducts(
      status,
      new Map([
        [items[0] as string, [0]],
        [items[1] as string, [1]],
      ]),
      2,
      RULES,
      ids(),
    )
    expect(r.unassigned).toBe(0)
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 60_000])
    expect(r.checks.map((c) => c.name)).toEqual(['Cuenta 1', 'Cuenta 2'])
    expect(r.checks[0]?.items).toEqual([{ item_id: items[0], fraction: { n: 1, d: 1 } }])
    expect(add(r.checks.map((c) => c.suggested_tip))).toBe(suggestedTipOf(status, 100_000, RULES))
  })

  it('a product shared among 3 is allocated by largest remainder with a 1/3 fraction in each check', () => {
    const { status, items } = orderWith([{ price: 100_000, name: 'Botella' }])
    const r = byProducts(status, new Map([[items[0] as string, [0, 1, 2]]]), 3, RULES, ids())
    expect(r.checks.map((c) => c.amount)).toEqual([33_334, 33_333, 33_333])
    for (const c of r.checks) expect(c.items[0]?.fraction).toEqual({ n: 1, d: 3 })
    expect(r.unassigned).toBe(0)
  })

  it('a product shared by two checks (1/2) and another by only one', () => {
    const { status, items } = orderWith([{ price: 50_001 }, { price: 20_000 }])
    const r = byProducts(
      status,
      new Map([
        [items[0] as string, [0, 1]],
        [items[1] as string, [1]],
      ]),
      2,
      RULES,
      ids(),
    )
    expect(r.checks.map((c) => c.amount)).toEqual([25_001, 45_000])
    expect(r.checks[1]?.items.map((i) => i.fraction)).toEqual([
      { n: 1, d: 2 },
      { n: 1, d: 1 },
    ])
  })

  it('nothing assigned: everything stays unassigned, the checks at 0 and no tip', () => {
    const { status } = orderWith([{ price: 40_000 }, { price: 60_000 }])
    const r = byProducts(status, new Map(), 3, RULES, ids())
    expect(r.unassigned).toBe(100_000)
    expect(r.checks.map((c) => [c.amount, c.suggested_tip, c.items])).toEqual([
      [0, 0, []],
      [0, 0, []],
      [0, 0, []],
    ])
  })

  it("what nobody takes stays unassigned and its amounts do not count in the checks' tip", () => {
    const { status, items } = orderWith([{ price: 40_000 }, { price: 60_000 }])
    const r = byProducts(status, new Map([[items[0] as string, [0]]]), 2, RULES, ids())
    expect(r.unassigned).toBe(60_000)
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 0])
    expect(add(r.checks.map((c) => c.suggested_tip))).toBe(suggestedTipOf(status, 40_000, RULES))
  })

  it('trimmed checks: what was assigned to a check that no longer exists is ignored', () => {
    const { status, items } = orderWith([{ price: 40_000 }, { price: 60_000 }])
    const r = byProducts(
      status,
      new Map([
        [items[0] as string, [0, 3]],
        [items[1] as string, [4]],
      ]),
      2,
      RULES,
      ids(),
    )
    // The first one stays only in check 0 (fraction 1/1); the second, with no owner.
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 0])
    expect(r.checks[0]?.items).toEqual([{ item_id: items[0], fraction: { n: 1, d: 1 } }])
    expect(r.unassigned).toBe(60_000)
  })

  it('a voided product that is not assigned does not count in the split', () => {
    const p = oneDishOrder(40_000)
    const other = itemData({ unit_price: 10_000 })
    const status = stateWithVoided(p, other)
    const r = byProducts(status, new Map([[p.dish.item_id, [0]]]), 2, RULES, ids())
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 0])
    expect(r.unassigned).toBe(0)
  })

  // BUG: if a product is voided (another device) after the cashier assigned it to a check, the
  // assignment stays in the map and `splitByItems` throws «El ítem … no está en el pedido».
  // apps/pos/src/floor/checks.ts, byProducts: the assignments are not filtered by `linesOf`.
  it('a product assigned and then voided does not break the split', () => {
    const p = oneDishOrder(40_000)
    const other = itemData({ unit_price: 10_000 })
    const status = stateWithVoided(p, other)
    const r = byProducts(
      status,
      new Map([
        [p.dish.item_id, [0]],
        [other.item_id, [1]],
      ]),
      2,
      RULES,
      ids(),
    )
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 0])
  })

  it('the result passes the CheckSplit schema and the reducer accepts it', () => {
    const p = oneDishOrder(90_000)
    const other = itemData({ unit_price: 30_000 })
    const base = [...p.base, local('ItemAdded', p.id, other)]
    const status = withEvents(p.id, base, [])
    const r = byProducts(
      status,
      new Map([
        [p.dish.item_id, [0, 1, 2]],
        [other.item_id, [2]],
      ]),
      3,
      RULES,
      newId,
    )
    const event = local('CheckSplit', p.id, { checks: r.checks })
    expect(validateNewEvent(withoutHub(event)).ok).toBe(true)
    const after = withEvents(p.id, base, [event])
    expect(after.checks?.map((c) => c.amount)).toEqual([30_000, 30_000, 60_000])
  })

  it("property: Σ amounts + unassigned = total of the lines, and a product's fractions do not exceed 1", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 200_000 }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 2, max: 5 }),
        fc.array(fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 4 }), {
          minLength: 5,
          maxLength: 5,
        }),
        (prices, checks, allocation) => {
          const { status, items } = orderWith(prices.map((price) => ({ price })))
          const assignedChecks = new Map(
            items.map((id, i) => [id, [...new Set(allocation[i] ?? [])]] as const),
          )
          const r = byProducts(status, assignedChecks, checks, RULES, newId)
          expect(add(r.checks.map((c) => c.amount)) + r.unassigned).toBe(add(prices))
          for (const c of r.checks) expect(c.amount).toBeGreaterThanOrEqual(0)
          const byItem = new Map<string, number>()
          for (const c of r.checks)
            for (const i of c.items)
              byItem.set(i.item_id, (byItem.get(i.item_id) ?? 0) + i.fraction.n / i.fraction.d)
          for (const total of byItem.values()) expect(total).toBeLessThanOrEqual(1 + 1e-9)
          const event = local('CheckSplit', status.id, { checks: r.checks })
          expect(validateNewEvent(withoutHub(event)).ok).toBe(true)
        },
      ),
      { seed: 18, numRuns: 150 },
    )
  })
})

describe('trimAssignments', () => {
  it('removes the checks that no longer exist and the products left with none', () => {
    const assignedChecks = new Map<string, readonly number[]>([
      ['a', [0, 1, 2]],
      ['b', [2]],
      ['c', [1]],
    ])
    const r = trimAssignments(assignedChecks, 2)
    expect([...r]).toEqual([
      ['a', [0, 1]],
      ['c', [1]],
    ])
    // It does not touch the original map.
    expect(assignedChecks.get('a')).toEqual([0, 1, 2])
  })

  it('with extra checks nothing changes, and with 0 checks it is empty', () => {
    const assignedChecks = new Map<string, readonly number[]>([['a', [0, 1]]])
    expect([...trimAssignments(assignedChecks, 5)]).toEqual([['a', [0, 1]]])
    expect(trimAssignments(assignedChecks, 0).size).toBe(0)
  })
})

describe('cashPayment: the examples in docs/DINERO.md', () => {
  const charges = (
    balance: number,
    tendered: number,
    extra: Partial<{ amount: number; tip: number }> = {},
  ) =>
    cashPayment({ balance, amount: extra.amount ?? balance, tip: extra.tip ?? 0, tendered }, RULES)
  const ROUNDING = { multiple: 100, mode: 'nearest_half_down' }

  it.each([
    // balance, tendered, charged, adjustment, change
    [36_810, 40_000, 36_800, -10, 3_200],
    [36_850, 40_000, 36_800, -50, 3_200],
    [36_851, 40_000, 36_900, 49, 3_100],
    [36_860, 50_000, 36_900, 40, 13_100],
    [36_800, 36_800, 36_800, 0, 0],
  ])(
    'balance %i, the customer gives %i → charges %i, adjustment %i, change %i',
    (balance, tendered, charged, adjustment, change) => {
      const c = charges(balance, tendered)
      expect(c).toMatchObject({ charged, adjustment, change, missing: 0, amountDue: charged })
      expect(c.rounding).toEqual(adjustment === 0 ? null : ROUNDING)
    },
  )

  it('the charge with adjustment is the same as the core one (chargedInCash)', () => {
    for (const balance of [36_810, 36_850, 36_851, 36_860, 36_800, 1, 49, 50, 51, 99, 100])
      expect(charges(balance, balance + 1_000_000).charged).toBe(chargedInCash(balance, 100))
  })

  it('partial payment: the exact amount is charged, with no rounding or rule in the event', () => {
    const c = cashPayment({ balance: 100_000, amount: 36_851, tip: 0, tendered: 40_000 }, RULES)
    expect(c).toMatchObject({
      charged: 36_851,
      adjustment: 0,
      change: 3_149,
      missing: 0,
      rounding: null,
    })
  })

  it('an amount one peso below the balance is already partial: no rounding', () => {
    const c = cashPayment({ balance: 36_851, amount: 36_850, tip: 0, tendered: 36_850 }, RULES)
    expect(c).toMatchObject({ charged: 36_850, adjustment: 0, rounding: null })
  })

  it('a balance of half a multiple or less is charged at $0 with a negative adjustment', () => {
    expect(charges(30, 0)).toMatchObject({
      charged: 0,
      adjustment: -30,
      amountDue: 0,
      change: 0,
      missing: 0,
    })
    expect(charges(50, 0)).toMatchObject({ charged: 0, adjustment: -50, rounding: ROUNDING })
    expect(charges(51, 100)).toMatchObject({ charged: 100, adjustment: 49 })
  })

  it('after paying by card: a $30 balance in cash, the tip is handed over', () => {
    const c = charges(30, 3_000, { tip: 3_000 })
    expect(c).toMatchObject({ charged: 0, adjustment: -30, amountDue: 3_000, change: 0 })
  })

  it('balance that is an exact half multiple (150), and balance 0 with amount 0 is an error', () => {
    expect(charges(150, 200)).toMatchObject({ charged: 100, adjustment: -50 })
    expect(() => charges(0, 0)).toThrow(RangeError)
  })

  it('the tip is added to what the customer hands over; the leftover change is computed on the total', () => {
    const c = charges(36_810, 50_000, { tip: 3_000 })
    expect(c).toMatchObject({ charged: 36_800, amountDue: 39_800, change: 10_200, missing: 0 })
  })

  it('if what was tendered is not enough: what is missing is missing and the change is 0', () => {
    expect(charges(36_810, 30_000)).toMatchObject({ missing: 6_800, change: 0 })
    expect(charges(36_810, 36_799)).toMatchObject({ missing: 1, change: 0 })
    expect(charges(36_810, 36_800)).toMatchObject({ missing: 0, change: 0 })
  })

  it('rejects amount 0, amount greater than the balance, decimals and negatives', () => {
    const base = { balance: 36_810, amount: 36_810, tip: 0, tendered: 40_000 }
    expect(() => cashPayment({ ...base, amount: 0 }, RULES)).toThrow(RangeError)
    expect(() => cashPayment({ ...base, amount: 36_811 }, RULES)).toThrow(RangeError)
    expect(() => cashPayment({ ...base, amount: 1.5 }, RULES)).toThrow()
    expect(() => cashPayment({ ...base, tip: -1 }, RULES)).toThrow()
    expect(() => cashPayment({ ...base, tendered: Number.NaN }, RULES)).toThrow()
    expect(() => cashPayment({ ...base, balance: -5 }, RULES)).toThrow()
  })

  it.each([
    ['nearest_half_up', 50, 36_825, 36_850, 25],
    ['down', 100, 36_899, 36_800, -99],
    ['up', 100, 36_801, 36_900, 99],
  ] as const)(
    'mode %s with multiple %i: balance %i → charges %i (adjustment %i)',
    (mode, multiple, balance, charged, adjustment) => {
      const c = cashPayment(
        { balance, amount: balance, tip: 0, tendered: 1_000_000 },
        { ...RULES, cashRounding: multiple, cashRoundingMode: mode },
      )
      expect(c).toMatchObject({ charged, adjustment, rounding: { multiple, mode } })
    },
  )

  it('with multiple 1 there is never an adjustment or rule in the event', () => {
    const c = cashPayment(
      { balance: 36_851, amount: 36_851, tip: 0, tendered: 36_851 },
      { ...RULES, cashRounding: 1 },
    )
    expect(c).toMatchObject({ charged: 36_851, adjustment: 0, rounding: null })
  })

  it('property: tendered = amount + adjustment + tip + change when it is enough, and the adjustment is less than the multiple', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom(1, 50, 100, 500, 1000),
        fc.constantFrom('nearest_half_down', 'nearest_half_up', 'down', 'up'),
        (balance, fraction, tip, extra, multiple, mode) => {
          const amount = Math.max(1, Math.floor(balance * fraction))
          const rules = { ...RULES, cashRounding: multiple, cashRoundingMode: mode }
          const base = cashPayment({ balance, amount, tip, tendered: 0 }, rules)
          const tendered = base.amountDue + extra
          const c = cashPayment({ balance, amount, tip, tendered }, rules)
          expect(c.missing).toBe(0)
          expect(tendered).toBe(amount + c.adjustment + tip + c.change)
          expect(Math.abs(c.adjustment)).toBeLessThan(multiple)
          if (amount < balance) expect(c.adjustment).toBe(0)
          // The rule travels only when there is an adjustment to explain.
          expect(c.rounding === null).toBe(c.adjustment === 0)
          expect(c.change).toBe(extra)
        },
      ),
      { seed: 19, numRuns: 300 },
    )
  })
})

describe('outstanding', () => {
  it("without a split: the order's balance, with no checks and nothing unassigned", () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(outstanding(status)).toEqual({ balance: 100_000, checks: [], unassigned: 0 })
  })

  it('with previous payments and no split: the balance goes down', () => {
    const p = oneDishOrder(100_000, (id) => [
      local('PaymentRecorded', id, paymentData({ amount: 40_000 })),
    ])
    expect(outstanding(p.status)).toMatchObject({ balance: 60_000, checks: [], unassigned: 0 })
  })

  function divided(amounts: number[], payments: { check: number; amount: number }[] = []) {
    const p = oneDishOrder(100_000)
    const checks = amounts.map((amount, i) => ({
      check_id: newId(),
      name: `Cuenta ${i + 1}`,
      amount,
      suggested_tip: Math.round(amount * 0.0926),
      items: [],
    }))
    const splitEvent = local('CheckSplit', p.id, { checks })
    const paymentEvents = payments.map((x) =>
      local(
        'PaymentRecorded',
        p.id,
        paymentData({ check_id: checks[x.check]?.check_id, amount: x.amount }),
      ),
    )
    return { ...p, checks, status: withEvents(p.id, p.base, [splitEvent, ...paymentEvents]) }
  }

  it('each check with its balance and pending tip, and nothing unassigned if they add up to the total', () => {
    const d = divided([60_000, 40_000])
    const r = outstanding(d.status)
    expect(r.balance).toBe(100_000)
    expect(r.unassigned).toBe(0)
    expect(r.checks.map((c) => [c.name, c.amount, c.balance])).toEqual([
      ['Cuenta 1', 60_000, 60_000],
      ['Cuenta 2', 40_000, 40_000],
    ])
    for (const c of r.checks) expect(c.pendingTip).toBe(c.suggestedTip)
  })

  it('a fully paid check stays at balance 0 and pending tip 0', () => {
    const d = divided([60_000, 40_000], [{ check: 0, amount: 60_000 }])
    const r = outstanding(d.status)
    expect(r.checks[0]).toMatchObject({ balance: 0, pendingTip: 0 })
    expect(r.checks[1]).toMatchObject({ balance: 40_000 })
    expect(r.balance).toBe(40_000)
    expect(r.unassigned).toBe(0)
  })

  it('a partly paid check keeps the proportional part of its tip', () => {
    const d = divided([60_000, 40_000], [{ check: 0, amount: 20_000 }])
    const c = outstanding(d.status).checks[0]
    expect(c).toMatchObject({ balance: 40_000 })
    expect(c?.pendingTip).toBeGreaterThan(0)
    expect(c?.pendingTip).toBeLessThan(c?.suggestedTip ?? 0)
  })

  it('what was not put in any check shows as unassigned (split by free amount)', () => {
    const d = divided([30_000, 30_000])
    const r = outstanding(d.status)
    expect(r.balance).toBe(100_000)
    expect(r.unassigned).toBe(40_000)
  })

  it('what is added after splitting goes to unassigned', () => {
    const d = divided([60_000, 40_000])
    const extra = itemData({ unit_price: 10_000 })
    const status = withEvents(
      d.id,
      [...d.base],
      [local('CheckSplit', d.id, { checks: d.checks }), local('ItemAdded', d.id, extra)],
    )
    const r = outstanding(status)
    expect(r.balance).toBe(110_000)
    expect(r.unassigned).toBe(10_000)
  })

  it('a payment on the general check (before splitting) lowers the balance and is deducted from the unassigned', () => {
    const p = oneDishOrder(100_000)
    const checks = [
      { check_id: newId(), name: 'A', amount: 30_000, suggested_tip: 2_778, items: [] },
      { check_id: newId(), name: 'B', amount: 30_000, suggested_tip: 2_778, items: [] },
    ]
    const status = withEvents(p.id, p.base, [
      local('PaymentRecorded', p.id, paymentData({ amount: 40_000 })),
      local('CheckSplit', p.id, { checks }),
    ])
    expect(outstanding(status)).toMatchObject({ balance: 60_000, unassigned: 0 })
  })

  it("the sum of the checks' balances plus the unassigned is the order's balance", () => {
    const d = divided([25_000, 25_000], [{ check: 1, amount: 5_000 }])
    const r = outstanding(d.status)
    expect(add(r.checks.map((c) => c.balance)) + r.unassigned).toBe(r.balance)
  })
})

// ── Shift and summary ────────────────────────────────────────────────────────

const REGISTER = newId()
const shiftEvent = (
  registerId: string,
  base: number,
  status: LocalState = 'confirmed',
  extras: object = {},
) =>
  local('ShiftOpened', newId(), { register_id: registerId, base }, status, {
    aggregate_type: 'register_shift',
    ...extras,
  } as never)

describe('shiftOfRegister', () => {
  it("without shifts, or with another register's shifts, there is no shift", () => {
    expect(shiftOfRegister([], REGISTER)).toBeNull()
    expect(shiftOfRegister([shiftEvent(newId(), 50_000)], REGISTER)).toBeNull()
  })

  it('a confirmed shift: its base and its id, not pending confirmation', () => {
    const t = shiftEvent(REGISTER, 200_000)
    expect(shiftOfRegister([t], REGISTER)).toEqual({
      id: t.event.aggregate_id,
      base: 200_000,
      openedAt: TIME,
      pendingConfirmation: false,
    })
  })

  it('a pending shift already counts (it was saved here) and is marked to be confirmed', () => {
    const t = shiftEvent(REGISTER, 0, 'pending')
    expect(shiftOfRegister([t], REGISTER)).toMatchObject({ base: 0, pendingConfirmation: true })
  })

  it('a shift rejected by the hub does not count; the previous one remains', () => {
    const good = shiftEvent(REGISTER, 100)
    const rejected = shiftEvent(REGISTER, 999, 'rejected', {
      hub_estimated_time: '2026-10-24T18:00:00.000Z',
    })
    expect(shiftOfRegister([good, rejected], REGISTER)?.base).toBe(100)
    expect(shiftOfRegister([rejected], REGISTER)).toBeNull()
  })

  it('with two shifts on the same register the most recent wins, regardless of the list order', () => {
    const older = shiftEvent(REGISTER, 100, 'pending', {
      hub_estimated_time: '2026-10-24T10:00:00.000Z',
    })
    const fresh = shiftEvent(REGISTER, 200, 'pending', {
      hub_estimated_time: '2026-10-24T22:00:00.000Z',
    })
    expect(shiftOfRegister([older, fresh], REGISTER)?.base).toBe(200)
    expect(shiftOfRegister([fresh, older], REGISTER)?.base).toBe(200)
  })

  it('with different registers, each one sees its own', () => {
    const another = newId()
    const a = shiftEvent(REGISTER, 111)
    const b = shiftEvent(another, 222)
    expect(shiftOfRegister([a, b], REGISTER)?.base).toBe(111)
    expect(shiftOfRegister([a, b], another)?.base).toBe(222)
  })

  it('ignores events that are not shift events', () => {
    const p = oneDishOrder(1_000)
    expect(shiftOfRegister(p.events, REGISTER)).toBeNull()
  })
})

describe('shiftSummary', () => {
  const T1 = newId()
  const T2 = newId()
  const paymentEvent = (
    order: string,
    fields: Record<string, unknown>,
    status: LocalState = 'confirmed',
  ) => local('PaymentRecorded', order, paymentData(fields), status)
  const pid = newId()

  const cash = (amount: number, adjustment: number, tip = 0, shift = T1) => ({
    register_shift_id: shift,
    method: 'cash',
    amount,
    rounding_adjustment: adjustment,
    tip,
    tendered: amount + adjustment + tip,
    change: 0,
    rounding: adjustment === 0 ? null : { multiple: 100, mode: 'nearest_half_down' },
  })

  it('without payments: nothing, 0 payments', () => {
    expect(shiftSummary([], T1)).toEqual({ byMethod: [], payments: 0 })
  })

  it('adds up by method: sale with its adjustment, tip and number of payments', () => {
    const r = shiftSummary(
      [
        paymentEvent(pid, cash(36_810, -10, 3_000)),
        paymentEvent(pid, { register_shift_id: T1, amount: 20_000, tip: 2_000 }),
        paymentEvent(pid, { register_shift_id: T1, amount: 5_000, tip: 0 }),
      ],
      T1,
    )
    expect(r.payments).toBe(3)
    expect(r.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 36_800, tip: 3_000, payments: 1 },
      { method: 'nequi', customMethodId: null, sale: 25_000, tip: 2_000, payments: 2 },
    ])
  })

  it("only counts the requested shift: another shift's payments are not included", () => {
    const events = [
      paymentEvent(pid, cash(10_000, 0, 0, T1)),
      paymentEvent(pid, cash(7_000, 0, 0, T2)),
    ]
    expect(shiftSummary(events, T1).byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 10_000, tip: 0, payments: 1 },
    ])
    expect(shiftSummary(events, T2).byMethod[0]).toMatchObject({ sale: 7_000 })
  })

  it('counts the pending ones and not the rejected ones', () => {
    const r = shiftSummary(
      [
        paymentEvent(pid, { register_shift_id: T1, amount: 1_000 }, 'pending'),
        paymentEvent(pid, { register_shift_id: T1, amount: 2_000 }, 'rejected'),
      ],
      T1,
    )
    expect(r.byMethod).toEqual([
      { method: 'nequi', customMethodId: null, sale: 1_000, tip: 0, payments: 1 },
    ])
  })

  it('a payment voided in the same shift is subtracted in full: sale with adjustment, tip and the payment', () => {
    const payment = paymentEvent(pid, cash(36_810, -10, 3_000))
    const voided = local('PaymentVoided', pid, {
      payment_id: paymentIdOf(payment),
      register_shift_id: T1,
    })
    const r = shiftSummary([payment, voided], T1)
    expect(r.payments).toBe(0)
    // A method that ends at zero does not show in the summary.
    expect(r.byMethod).toEqual([])
  })

  it('a payment voided in another shift: the original stays in its own and the reversal goes to the one where it is recorded', () => {
    const payment = paymentEvent(pid, cash(36_810, -10, 3_000, T1))
    const voided = local('PaymentVoided', pid, {
      payment_id: paymentIdOf(payment),
      register_shift_id: T2,
    })
    const events = [payment, voided]
    expect(shiftSummary(events, T1).byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 36_800, tip: 3_000, payments: 1 },
    ])
    expect(shiftSummary(events, T2).byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: -36_800, tip: -3_000, payments: -1 },
    ])
  })

  it("a refund subtracts sale and tip from its shift's method, without changing the number of payments", () => {
    const payment = paymentEvent(pid, { register_shift_id: T1, amount: 20_000, tip: 2_000 })
    const refund = local('RefundRecorded', pid, {
      payment_id: paymentIdOf(payment),
      refund_id: newId(),
      sale_amount: 5_000,
      tip_amount: 500,
      method: 'nequi',
      register_shift_id: T1,
    })
    expect(shiftSummary([payment, refund], T1).byMethod).toEqual([
      { method: 'nequi', customMethodId: null, sale: 15_000, tip: 1_500, payments: 1 },
    ])
  })

  it('a void whose payment is not known here (rejected) subtracts nothing', () => {
    const rejected = paymentEvent(pid, { register_shift_id: T1, amount: 9_000 }, 'rejected')
    const voided = local(
      'PaymentVoided',
      pid,
      { payment_id: paymentIdOf(rejected), register_shift_id: T1 },
      'pending',
    )
    expect(shiftSummary([rejected, voided], T1)).toEqual({ byMethod: [], payments: 0 })
  })

  it('a rejected void does not subtract', () => {
    const payment = paymentEvent(pid, { register_shift_id: T1, amount: 9_000 })
    const voided = local(
      'PaymentVoided',
      pid,
      { payment_id: paymentIdOf(payment), register_shift_id: T1 },
      'rejected',
    )
    expect(shiftSummary([payment, voided], T1).byMethod[0]).toMatchObject({
      sale: 9_000,
      payments: 1,
    })
  })

  it("cash and tip by method add up to the shift's total charged (identity from DINERO.md)", () => {
    const payments = [
      paymentEvent(pid, cash(36_810, -10, 3_000)),
      paymentEvent(pid, {
        register_shift_id: T1,
        amount: 63_190,
        tip: 0,
        method: 'card',
        cardTerminal: {
          card_terminal_id: newId(),
          franchise: null,
          last4: null,
          approval_code: null,
          receipt: null,
        },
      }),
    ]
    const r = shiftSummary(payments, T1)
    // Σ charged = Σ amount + Σ adjustment: 36.800 + 63.190 = 99.990; 3.000 in tips.
    expect(add(r.byMethod.map((m) => m.sale))).toBe(99_990)
    expect(add(r.byMethod.map((m) => m.tip))).toBe(3_000)
  })

  it('property: each voided payment leaves the summary as if it had never been made', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 1, max: 100_000 }),
            tip: fc.integer({ min: 0, max: 10_000 }),
            method: fc.constantFrom('nequi', 'daviplata', 'breb'),
            voidItem: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        (payments) => {
          const events: LocalEvent[] = []
          const kept: LocalEvent[] = []
          for (const p of payments) {
            const e = paymentEvent(pid, { register_shift_id: T1, ...p })
            events.push(e)
            if (p.voidItem)
              events.push(
                local('PaymentVoided', pid, { payment_id: paymentIdOf(e), register_shift_id: T1 }),
              )
            else kept.push(e)
          }
          const leavesZero = (r: ReturnType<typeof shiftSummary>) =>
            r.byMethod
              .filter((m) => m.sale !== 0 || m.tip !== 0 || m.payments !== 0)
              .sort((a, b) => a.method.localeCompare(b.method))
          expect(leavesZero(shiftSummary(events, T1))).toEqual(leavesZero(shiftSummary(kept, T1)))
        },
      ),
      { seed: 20, numRuns: 100 },
    )
  })
})

// The checkout panel (Checkout.tsx) builds the payment this way when recording; this tests that
// what comes out of `cashPayment` and the rules passes the PaymentRecorded schema and the reducer.
describe("the checkout panel's data passes the schema and the reducer", () => {
  type Method = 'cash' | 'card' | 'nequi'

  /** Mirror of `record` in CheckoutForm (Checkout.tsx): same fields and same sources. */
  function buildPayment(p: {
    method: Method
    balance: number
    amount: number
    tip: number
    tendered?: number
    checkId?: string | null
    cardTerminalId?: string
  }) {
    const calculation = cashPayment(
      { balance: p.balance, amount: p.amount, tip: p.tip, tendered: p.tendered ?? 0 },
      RULES,
    )
    const served = p.tendered ?? calculation.amountDue
    const final = cashPayment(
      { balance: p.balance, amount: p.amount, tip: p.tip, tendered: served },
      RULES,
    )
    return {
      payment_id: newId(),
      check_id: p.checkId ?? null,
      register_shift_id: SHIFT,
      method: p.method,
      amount: p.amount,
      tip: p.tip,
      tendered: p.method === 'cash' ? served : null,
      change: p.method === 'cash' ? final.change : null,
      rounding_adjustment: p.method === 'cash' ? final.adjustment : 0,
      rounding: p.method === 'cash' ? final.rounding : null,
      cardTerminal:
        p.method === 'card' && p.cardTerminalId
          ? {
              card_terminal_id: p.cardTerminalId,
              franchise: null,
              last4: null,
              approval_code: null,
              receipt: null,
              card_type: 'debit' as const,
            }
          : null,
      charge_reference: null,
      custom_method_id: null,
    }
  }

  const apply = (price: number, payment: ReturnType<typeof buildPayment>) => {
    const p = oneDishOrder(price)
    const event = local('PaymentRecorded', p.id, payment as never)
    const ok = validateNewEvent(withoutHub(event)).ok
    const status = withEvents(p.id, p.base, [event])
    return { ok, status, payments: Object.values(status.payments) }
  }

  it('cash that closes with a negative adjustment: $36.810 → charges 36.800, rule in the event', () => {
    const payment = buildPayment({
      method: 'cash',
      balance: 36_810,
      amount: 36_810,
      tip: 3_000,
      tendered: 50_000,
    })
    expect(payment).toMatchObject({ rounding_adjustment: -10, change: 10_200, tendered: 50_000 })
    const r = apply(36_810, payment)
    expect(r.ok).toBe(true)
    expect(r.payments).toHaveLength(1)
    expect(orderTotals(r.status)).toMatchObject({
      balance: 0,
      roundingAdjustments: -10,
      tips: 3_000,
    })
  })

  it('exact cash by default (the customer hands over the exact amount): change 0', () => {
    const payment = buildPayment({ method: 'cash', balance: 36_851, amount: 36_851, tip: 0 })
    expect(payment).toMatchObject({ rounding_adjustment: 49, change: 0, tendered: 36_900 })
    const r = apply(36_851, payment)
    expect(r.ok).toBe(true)
    expect(r.payments).toHaveLength(1)
  })

  it('partial cash without rounding, the reducer accepts it and leaves a balance', () => {
    const payment = buildPayment({
      method: 'cash',
      balance: 100_000,
      amount: 36_851,
      tip: 0,
      tendered: 40_000,
    })
    expect(payment).toMatchObject({ rounding_adjustment: 0, rounding: null, change: 3_149 })
    const r = apply(100_000, payment)
    expect(r.ok).toBe(true)
    expect(orderTotals(r.status).balance).toBe(63_149)
  })

  it('the change the customer leaves becomes a tip: tendered = amount + adjustment + tip + change', () => {
    // Balance 36.810, hands over 40.000 and leaves the 3.200 change as a tip.
    const calculation = cashPayment(
      { balance: 36_810, amount: 36_810, tip: 0, tendered: 40_000 },
      RULES,
    )
    const payment = buildPayment({
      method: 'cash',
      balance: 36_810,
      amount: 36_810,
      tip: calculation.change,
      tendered: 40_000,
    })
    expect(payment).toMatchObject({ tip: 3_200, change: 0, tendered: 40_000 })
    expect(apply(36_810, payment).ok).toBe(true)
  })

  it('card with card terminal and only the amount (no approval): passes the schema and the reducer', () => {
    const payment = buildPayment({
      method: 'card',
      balance: 40_900,
      amount: 40_900,
      tip: 4_090,
      cardTerminalId: newId(),
    })
    expect(payment).toMatchObject({
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: { approval_code: null, franchise: null, last4: null, receipt: null },
    })
    const r = apply(40_900, payment)
    expect(r.ok).toBe(true)
    expect(r.payments[0]).toMatchObject({ method: 'card', amount: 40_900, tip: 4_090 })
  })

  it('card without card terminal does not pass the schema (the panel does not allow charging without picking one)', () => {
    const payment = buildPayment({ method: 'card', balance: 40_900, amount: 40_900, tip: 0 })
    expect(payment.cardTerminal).toBeNull()
    expect(apply(40_900, payment).ok).toBe(false)
  })

  it('Nequi: no tendered, change or card terminal, and the balance is not rounded', () => {
    const payment = buildPayment({ method: 'nequi', balance: 36_851, amount: 36_851, tip: 3_685 })
    expect(payment).toMatchObject({
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: null,
    })
    const r = apply(36_851, payment)
    expect(r.ok).toBe(true)
    expect(orderTotals(r.status)).toMatchObject({ balance: 0, roundingAdjustments: 0 })
  })

  it('payment to a split check: it carries the check_id and the reducer accepts it', () => {
    const p = oneDishOrder(100_000)
    const check = {
      check_id: newId(),
      name: 'Cuenta 1',
      amount: 50_000,
      suggested_tip: 4_630,
      items: [],
    }
    const another = { ...check, check_id: newId(), name: 'Cuenta 2', suggested_tip: 4_629 }
    const payment = buildPayment({
      method: 'nequi',
      balance: 50_000,
      amount: 50_000,
      tip: 4_630,
      checkId: check.check_id,
    })
    const status = withEvents(p.id, p.base, [
      local('CheckSplit', p.id, { checks: [check, another] }),
      local('PaymentRecorded', p.id, payment as never),
    ])
    expect(status.payments[payment.payment_id]).toMatchObject({
      checkId: check.check_id,
      amount: 50_000,
    })
    expect(outstanding(status).checks.map((c) => c.balance)).toEqual([0, 50_000])
  })

  it('property: cash, card and Nequi always pass schema and reducer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom<Method>('cash', 'card', 'nequi'),
        (price, fraction, tip, excess, method) => {
          const amount = Math.max(1, Math.floor(price * fraction))
          const base = cashPayment({ balance: price, amount, tip, tendered: 0 }, RULES)
          const payment = buildPayment({
            method,
            balance: price,
            amount,
            tip,
            tendered: base.amountDue + excess,
            cardTerminalId: newId(),
          })
          const r = apply(price, payment)
          expect(r.ok).toBe(true)
          expect(r.payments).toHaveLength(1)
        },
      ),
      { seed: 21, numRuns: 200 },
    )
  })
})

describe("the core's suggestedTip versus the screen's", () => {
  it('with the whole order the screen gives the same as suggestedTip of the lines', () => {
    const { status } = orderWith([
      { price: 53_800 },
      { price: 14_900, quantity: 3, rate: 0 },
      { price: 10_000, rate: 1900 },
    ])
    const lines = Object.values(status.items).map((i) => ({
      net: i.quantity * i.unitPrice,
      rate: i.rate,
    }))
    expect(suggestedTipOf(status, orderTotals(status).balance, RULES)).toBe(
      suggestedTip(lines, 1000),
    )
  })
})

const SODEXO = newId()
const QR = newId()
const WITH_CUSTOM: CheckoutRules = {
  ...RULES,
  customMethods: [
    { id: SODEXO, name: 'Sodexo' },
    { id: QR, name: 'QR Bancolombia' },
  ],
}

describe('checkoutOptions and methodName (custom methods)', () => {
  it('the built-in ones in order, with card split into credit and debit', () => {
    const o = checkoutOptions(RULES)
    expect(o.map((x) => x.key)).toEqual([
      'cash',
      'credit',
      'debit',
      'nequi',
      'daviplata',
      'breb',
      'transfer',
    ])
    expect(o.filter((x) => x.method === 'card').map((x) => x.cardType)).toEqual(['credit', 'debit'])
    expect(o.find((x) => x.key === 'credit')?.name).toBe('Tarjeta crédito')
    expect(o.find((x) => x.key === 'debit')?.name).toBe('Tarjeta débito')
    for (const x of o.filter((x) => x.method !== 'card')) expect(x.cardType).toBeNull()
    for (const x of o) expect(x.customMethodId).toBeNull()
  })

  it('without card enabled, credit and debit do not show', () => {
    const o = checkoutOptions({ ...RULES, paymentMethods: ['cash', 'nequi'] })
    expect(o.map((x) => x.key)).toEqual(['cash', 'nequi'])
  })

  it('custom methods come last, as the "other" method with their id and name', () => {
    const o = checkoutOptions(WITH_CUSTOM)
    expect(o.slice(-2)).toEqual([
      { key: SODEXO, name: 'Sodexo', method: 'other', customMethodId: SODEXO, cardType: null },
      { key: QR, name: 'QR Bancolombia', method: 'other', customMethodId: QR, cardType: null },
    ])
    expect(new Set(o.map((x) => x.key)).size).toBe(o.length)
  })

  it('a hub without custom methods (undefined or empty list) adds nothing', () => {
    expect(checkoutOptions({ ...RULES, customMethods: [] })).toEqual(checkoutOptions(RULES))
  })

  it('methodName: the normal one by its name, the custom one by its own, and an archived or unknown one, «Otro»', () => {
    expect(methodName('nequi', null, RULES)).toBe('Nequi')
    expect(methodName('other', SODEXO, WITH_CUSTOM)).toBe('Sodexo')
    expect(methodName('other', newId(), WITH_CUSTOM)).toBe('Otro')
    expect(methodName('other', SODEXO, RULES)).toBe('Otro')
    expect(methodName('other', null, null)).toBe('Otro')
    expect(methodName('cash', undefined, null)).toBe('Efectivo')
  })
})

describe('tipWithPercent', () => {
  it('5 % of $100.000 at 8 %: 4.630; 15 %: 13.889; 0 %: 0', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(tipWithPercent(status, 100_000, 100_000, 500, RULES)).toBe(4_630)
    expect(tipWithPercent(status, 100_000, 100_000, 1500, RULES)).toBe(13_889)
    expect(tipWithPercent(status, 100_000, 100_000, 0, RULES)).toBe(0)
  })

  it('10 % matches the suggested one, and partial payments add up to the total one', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(tipWithPercent(status, 100_000, 100_000, 1000, RULES)).toBe(
      suggestedTipOf(status, 100_000, RULES),
    )
    const a = tipWithPercent(status, 100_000, 30_000, 500, RULES)
    const b = tipWithPercent(status, 70_000, 70_000, 500, RULES)
    expect(a + b).toBe(4_630)
  })

  it('an amount greater than what is available, or 0: tip 0', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(tipWithPercent(status, 50_000, 60_000, 500, RULES)).toBe(0)
    expect(tipWithPercent(status, 50_000, 0, 500, RULES)).toBe(0)
  })
})

describe('shiftSummary with custom methods and card type', () => {
  const T = newId()
  const pid = newId()
  const own = (id: string, amount: number, extra: Record<string, unknown> = {}) =>
    local(
      'PaymentRecorded',
      pid,
      paymentData({
        register_shift_id: T,
        method: 'other',
        custom_method_id: id,
        amount,
        ...extra,
      }) as never,
    )

  it('each custom method is its own row, distinct from the others and from each other', () => {
    const r = shiftSummary(
      [own(SODEXO, 10_000), own(QR, 5_000, { tip: 500 }), own(SODEXO, 2_000)],
      T,
    )
    expect(r.byMethod).toEqual([
      { method: 'other', customMethodId: SODEXO, sale: 12_000, tip: 0, payments: 2 },
      { method: 'other', customMethodId: QR, sale: 5_000, tip: 500, payments: 1 },
    ])
  })

  it("voiding or refunding a custom payment subtracts from that custom method's row", () => {
    const payment = own(SODEXO, 10_000)
    const voided = local('PaymentVoided', pid, {
      payment_id: paymentIdOf(payment),
      register_shift_id: T,
    })
    expect(shiftSummary([payment, voided], T).byMethod).toEqual([])
    const other = own(QR, 8_000)
    const refund = local('RefundRecorded', pid, {
      payment_id: paymentIdOf(other),
      refund_id: newId(),
      sale_amount: 3_000,
      tip_amount: 0,
      method: 'other',
      register_shift_id: T,
    })
    expect(shiftSummary([other, refund], T).byMethod).toEqual([
      { method: 'other', customMethodId: QR, sale: 5_000, tip: 0, payments: 1 },
    ])
  })

  it('credit and debit are the same "card" method in the summary', () => {
    const card = (type: 'credit' | 'debit' | null) =>
      local(
        'PaymentRecorded',
        pid,
        paymentData({
          register_shift_id: T,
          method: 'card',
          amount: 1_000,
          cardTerminal: {
            card_terminal_id: newId(),
            franchise: null,
            last4: null,
            approval_code: null,
            receipt: null,
            card_type: type,
          },
        }) as never,
      )
    const r = shiftSummary([card('credit'), card('debit'), card(null)], T)
    expect(r.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 3_000, tip: 0, payments: 3 },
    ])
  })
})

describe('payments with custom method and card type pass schema and reducer', () => {
  it('a custom method with its id is accepted and stays in the payment', () => {
    const p = oneDishOrder(10_000)
    const ev = local(
      'PaymentRecorded',
      p.id,
      paymentData({ method: 'other', custom_method_id: SODEXO, amount: 10_000 }) as never,
    )
    expect(validateNewEvent(withoutHub(ev)).ok).toBe(true)
    const status = withEvents(p.id, p.base, [ev])
    expect(Object.values(status.payments)[0]).toMatchObject({
      method: 'other',
      customMethodId: SODEXO,
    })
  })

  it('"other" without id, or an id with another method, do not pass the schema', () => {
    const p = oneDishOrder(10_000)
    const withoutId = local(
      'PaymentRecorded',
      p.id,
      paymentData({ method: 'other', amount: 10_000 }) as never,
    )
    const withId = local(
      'PaymentRecorded',
      p.id,
      paymentData({ method: 'nequi', custom_method_id: SODEXO, amount: 10_000 }) as never,
    )
    expect(validateNewEvent(withoutHub(withoutId)).ok).toBe(false)
    expect(validateNewEvent(withoutHub(withId)).ok).toBe(false)
  })

  it.each(['credit', 'debit', null] as const)('card with type %s is accepted', (type) => {
    const p = oneDishOrder(10_000)
    const ev = local(
      'PaymentRecorded',
      p.id,
      paymentData({
        method: 'card',
        amount: 10_000,
        cardTerminal: {
          card_terminal_id: newId(),
          franchise: null,
          last4: null,
          approval_code: null,
          receipt: null,
          card_type: type,
        },
      }) as never,
    )
    expect(validateNewEvent(withoutHub(ev)).ok).toBe(true)
    expect(Object.values(withEvents(p.id, p.base, [ev]).payments)).toHaveLength(1)
  })

  it('a card type that does not exist is rejected', () => {
    const p = oneDishOrder(10_000)
    const ev = local(
      'PaymentRecorded',
      p.id,
      paymentData({
        method: 'card',
        amount: 10_000,
        cardTerminal: {
          card_terminal_id: newId(),
          franchise: null,
          last4: null,
          approval_code: null,
          receipt: null,
          card_type: 'prepago',
        },
      }) as never,
    )
    expect(validateNewEvent(withoutHub(ev)).ok).toBe(false)
  })
})
