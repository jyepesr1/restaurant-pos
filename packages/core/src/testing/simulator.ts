import fc from 'fast-check'
import { expect } from 'vitest'
import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { allocateOrderDiscount, chargedInCash, comp, equalParts, percent } from '../money'
import { applyEvent } from '../order/apply'
import type { ItemStatus, OrderItem, OrderState } from '../order/state'
import { checkBalance, itemTotals, orderTotals } from '../order/totals'
import { cardPaymentData, cashPaymentData, event, itemCopy, SHIFT, WAITER } from './factory'
import { freeze } from './freeze'

// Service simulator with two orders (A and B) for property tests. An `Action` is a tuple of
// integers interpreted against the current state (so almost every action is an applicable
// event and fast-check can shrink failing cases). Every state and every event is deep-frozen:
// if the reducer modifies its input, it throws and ends up as `invalid_event`, which the
// simulator counts in `invalidCases`.

export interface Action {
  type: number
  /** Order it acts on (the source when moving and merging). */
  p: 0 | 1
  a: number
  b: number
  c: number
}

export const ACTION_TYPES = 27

// More weight on adding, sending and charging to reach deep states; closing and canceling weigh
// little because they end the order.
const WEIGHTS: readonly [number, number][] = [
  [0, 8],
  [1, 6],
  [13, 6],
  [24, 4],
  [4, 3],
  [5, 2],
  [6, 2],
  [7, 2],
  [8, 3],
  [9, 2],
  [10, 1],
  [11, 2],
  [12, 1],
  [14, 1],
  [15, 2],
  [16, 1],
  [17, 2],
  [18, 1],
  [19, 3],
  [20, 1],
  [25, 1],
]
const WEIGHTED_TYPES = WEIGHTS.flatMap(([type, weight]) => Array<number>(weight).fill(type))
for (let t = 0; t < ACTION_TYPES; t++) if (!WEIGHTED_TYPES.includes(t)) WEIGHTED_TYPES.push(t)

export const actionArb: fc.Arbitrary<Action> = fc.record({
  type: fc.constantFrom(...WEIGHTED_TYPES),
  p: fc.constantFrom<0 | 1>(0, 1),
  a: fc.nat(999),
  b: fc.nat(999),
  c: fc.nat(999),
})

/** Movement between orders that both accepted: before and after of the two states. */
export interface Movement {
  type: 'ItemsMoved' | 'OrdersMerged'
  source: 0 | 1
  target: 0 | 1
  event: OrderEvent
  before: readonly [OrderState, OrderState]
  after: readonly [OrderState, OrderState]
}

const PRICES = [0, 200, 12_900, 12_950, 14_900, 16_000, 29_900, 40_900, 100_000]
const RATES = [800, 1900, 0] as const
const COURSES = [null, 'entry', 'main', 'dessert'] as const
const BPS = [500, 1000, 1500, 5000, 9500, 10_000]
const DAYS = ['2026-10-24', '2026-10-25']

const ACTIVE_ITEM_STATUSES: readonly ItemStatus[] = [
  'held',
  'pending',
  'sent',
  'in_preparation',
  'ready',
  'served',
]

const itemsOf = (status: OrderState): OrderItem[] =>
  Object.values(status.items).sort((x, y) => x.position - y.position)

const select = <T>(list: readonly T[], n: number): T | undefined => list[n % list.length]

/** Net of the line after its own discounts, without the order's. */
function netAfterLine(status: OrderState, item: OrderItem): number {
  const t = itemTotals(status, item)
  const fromOrder = Object.values(status.discounts)
    .filter((d) => d.scope === 'order')
    .reduce((a, d) => a + (d.amounts[item.id] ?? 0), 0)
  return t.net + fromOrder
}

/** What a payment without a check, or with one, can cover right now. */
function available(status: OrderState, checkId: string | null): number {
  if (checkId === null && status.checks) {
    const inChecks = status.checks.reduce(
      (a, c) => a + Math.max(0, checkBalance(status, c.id) ?? 0),
      0,
    )
    return orderTotals(status).balance - inChecks
  }
  return checkBalance(status, checkId) ?? 0
}

const toCopy = (it: OrderItem) => ({
  item_id: it.id,
  product_id: it.productId,
  variant_id: it.variantId,
  name: it.name,
  unit_price: it.unitPrice,
  tax_type: it.taxType,
  rate: it.rate,
  quantity: it.quantity,
  guest: it.guest,
  course: it.course,
  modifiers: it.modifiers.map((m) => ({
    modifier_id: m.modifierId,
    name: m.name,
    extra_price: m.extraPrice,
  })),
  notes: it.notes,
})

/** A fixed table to merge and unmerge: this way the simulator exercises both paths. */
const MERGED_TABLE = newId()

const toMoved = (it: OrderItem) => ({
  item: toCopy(it),
  status: it.status as Exclude<ItemStatus, 'voided'>,
  voided_quantity: it.voidedQuantity,
  added_by: it.addedBy,
})

type Plan =
  | { cssClass: 'only'; p: 0 | 1; event: OrderEvent }
  | { cssClass: 'crossed'; source: 0 | 1; target: 0 | 1; event: OrderEvent }

export class Service {
  readonly orders: readonly [string, string] = [newId(), newId()]
  readonly shifts: readonly [string, string] = [SHIFT, newId()]
  statuses: [OrderState | null, OrderState | null] = [null, null]
  /** All emitted events the hub would have accepted, in sequence order. */
  readonly log: OrderEvent[] = []
  /** Events the reducer applied without issue, on either of the two orders. */
  readonly appliedEvents: OrderEvent[] = []
  readonly movements: Movement[] = []
  readonly appliedTypes = new Set<string>()
  readonly issues = new Map<string, number>()
  /** Valid events the reducer treated as invalid (it threw, e.g. for mutating its input). */
  readonly invalidCases: string[] = []
  /** Cross-order events one order accepted and the other did not: the hub would reject them. */
  discardedCount = 0

  constructor() {
    for (const p of [0, 1] as const) {
      this.applyToOne(
        p,
        event(this.orders[p], 'OrderOpened', {
          channel: 'dine_in',
          table_id: newId(),
          guests: 2,
        }),
      )
    }
  }

  private apply(p: 0 | 1, e: OrderEvent) {
    const previous = this.statuses[p]
    const previousCopy = previous ? structuredClone(previous) : null
    const r = applyEvent(previous, e)
    // The input does not change, not even one field.
    expect(previous).toEqual(previousCopy)
    if (r.issue) {
      this.issues.set(r.issue.type, (this.issues.get(r.issue.type) ?? 0) + 1)
      if (r.issue.type === 'invalid_event') {
        this.invalidCases.push(`${e.type}: ${r.issue.description}`)
      }
    }
    return r
  }

  private confirm(p: 0 | 1, status: OrderState | null) {
    this.statuses[p] = status ? freeze(status) : null
  }

  private applyToOne(p: 0 | 1, e: OrderEvent) {
    freeze(e)
    const r = this.apply(p, e)
    this.confirm(p, r.status)
    this.log.push(e)
    if (!r.issue) {
      this.appliedEvents.push(e)
      this.appliedTypes.add(e.type)
    }
  }

  private applyCrossed(source: 0 | 1, target: 0 | 1, e: OrderEvent) {
    freeze(e)
    const before = [this.statuses[0], this.statuses[1]] as const
    const ro = this.apply(source, e)
    const rd = this.apply(target, e)
    if (!ro.issue !== !rd.issue) {
      this.discardedCount += 1
      return
    }
    this.log.push(e)
    if (ro.issue) return
    this.confirm(source, ro.status)
    this.confirm(target, rd.status)
    this.appliedEvents.push(e)
    this.appliedTypes.add(e.type)
    this.movements.push({
      type: e.type as Movement['type'],
      source,
      target,
      event: e,
      before: before as unknown as Movement['before'],
      after: [this.statuses[0], this.statuses[1]] as unknown as Movement['after'],
    })
  }

  private shift(n: number): string {
    return this.shifts[n % 2] ?? SHIFT
  }

  step(action: Action) {
    const plan = this.planAction(action)
    if (!plan) return
    if (plan.cssClass === 'only') this.applyToOne(plan.p, plan.event)
    else this.applyCrossed(plan.source, plan.target, plan.event)
  }

  private planAction({ type, p, a, b, c }: Action): Plan | null {
    const est = this.statuses[p]
    if (!est) return null
    const id = this.orders[p]
    const q: 0 | 1 = p === 0 ? 1 : 0
    const items = itemsOf(est)
    const live = items.filter((i) => i.status !== 'voided')
    const only = (e: OrderEvent): Plan => ({ cssClass: 'only', p, event: e })
    const item = select(items, a)
    const reason = { reason: 'Motivo de prueba' }

    switch (type) {
      case 0: {
        const rate = RATES[c % RATES.length] ?? 800
        return only(
          event(
            id,
            'ItemAdded',
            itemCopy({
              unit_price: PRICES[a % PRICES.length] ?? 0,
              quantity: 1 + (b % 4),
              rate,
              tax_type: rate === 0 ? 'exempt' : rate === 1900 ? 'iva' : 'inc',
              course: COURSES[(a + c) % COURSES.length] ?? null,
              modifiers:
                b % 2 === 0
                  ? []
                  : [
                      {
                        modifier_id: newId(),
                        name: 'Extra',
                        extra_price: b % 4 === 1 ? 3000 : 0,
                      },
                    ],
            }),
          ),
        )
      }
      case 1: {
        const pendingList = items.filter((i) => i.status === 'pending')
        const ids = b % 2 === 0 ? pendingList.map((i) => i.id) : [select(items, a)?.id]
        const validEntries = ids.filter((x): x is string => x !== undefined)
        return validEntries.length ? only(sendEvent(id, validEntries)) : null
      }
      case 2:
        return item ? only(event(id, 'ItemRemoved', { item_id: item.id })) : null
      case 3:
        return item
          ? only(event(id, 'ItemChanged', { item_id: item.id, quantity: 1 + (b % 5) }))
          : null
      case 4:
        return item
          ? only(
              event(
                id,
                'ItemVoided',
                {
                  item_id: item.id,
                  quantity: 1 + (b % item.quantity),
                  already_prepared: c % 2 === 0,
                  ticket_id: null,
                },
                reason,
              ),
            )
          : null
      case 5: {
        if (!item) return null
        const amount = percent(itemTotals(est, item).gross, BPS[b % BPS.length] ?? 1000)
        return only(
          discountEvent(id, 'item', 'percent', BPS[b % BPS.length] ?? 1000, null, [
            { item_id: item.id, amount },
          ]),
        )
      }
      case 6: {
        if (!item) return null
        const net = itemTotals(est, item).net
        // Up to 10 % above the net: some must be rejected.
        const amount = Math.floor((net * 11 * (b % 91)) / 900)
        return only(
          discountEvent(id, 'item', 'value', amount, null, [{ item_id: item.id, amount }]),
        )
      }
      case 7: {
        if (!item) return null
        const units = 1 + (b % item.quantity)
        const amount = comp(
          units,
          item.unitPrice,
          item.modifiers.map((m) => m.extraPrice),
        )
        return only(
          discountEvent(id, 'item', 'comp', amount, units, [{ item_id: item.id, amount }]),
        )
      }
      case 8:
      case 9: {
        if (!live.length) return null
        const base = live.reduce((s, i) => s + netAfterLine(est, i), 0)
        const leftover = live.map((i) => itemTotals(est, i).net)
        const remainingTotal = leftover.reduce((s, r) => s + r, 0)
        const rule = type === 8 ? 'percent' : 'value'
        const bp = BPS[b % BPS.length] ?? 1000
        const pesos =
          rule === 'percent' ? percent(base, bp) : Math.floor((remainingTotal * (c % 101)) / 100)
        const parts =
          allocateOrderDiscount(pesos, leftover) ??
          // More than what is left: the reducer must reject it.
          leftover.map((r, i) => (i === 0 ? r + 1 : r))
        // For a percentage the value is in basis points; for an amount, it is the sum of the parts.
        const value = rule === 'percent' ? bp : parts.reduce((x, y) => x + y, 0)
        return only(
          discountEvent(
            id,
            'order',
            rule,
            value,
            null,
            live.map((i, k) => ({ item_id: i.id, amount: parts[k] ?? 0 })),
          ),
        )
      }
      case 10: {
        const ids = Object.keys(est.discounts)
        const discount = select(ids, a)
        return discount
          ? only(event(id, 'DiscountRemoved', { discount_id: discount }, reason))
          : null
      }
      case 11: {
        const n = 2 + (a % 4)
        const balance = orderTotals(est).balance
        if (balance < 2 && a % 5 !== 0) return null
        const total = b % 3 === 0 ? Math.floor(balance * 0.8) : balance
        const amounts = equalParts(total, n)
        const tips = equalParts(Math.floor(total / 10), n)
        return only(
          event(id, 'CheckSplit', {
            checks: amounts.map((amount, i) => ({
              check_id: newId(),
              name: `Cuenta ${i + 1}`,
              amount,
              suggested_tip: tips[i] ?? 0,
              items: i === 0 && live[0] ? [{ item_id: live[0].id, fraction: { n: 1, d: n } }] : [],
            })),
          }),
        )
      }
      case 12:
        return only(event(id, 'SplitUndone', {}))
      case 13: {
        const checkId = est.checks && a % 3 !== 0 ? (select(est.checks, b)?.id ?? null) : null
        const free = available(est, checkId)
        // Without a balance it is only tried now and then, to test the rejection.
        if (free <= 0 && c % 8 !== 0) return null
        const amount = Math.max(
          1,
          [free, Math.floor(free / 2), Math.floor(free / 3) + 1, 1, free + 1][c % 5] ?? 1,
        )
        const shift = this.shift(b)
        const tip = [0, 500, 1000][a % 3] ?? 0
        const cashMethod = b % 2 === 0
        if (cashMethod) {
          const closes = amount === free
          const adjustment = closes ? chargedInCash(amount, 100) - amount : 0
          return only(
            event(
              id,
              'PaymentRecorded',
              cashPaymentData(amount, {
                check_id: checkId,
                register_shift_id: shift,
                tip,
                rounding_adjustment: adjustment,
                change: [0, 1000, 20_000][c % 3] ?? 0,
              }),
            ),
          )
        }
        return only(
          event(
            id,
            'PaymentRecorded',
            cardPaymentData(amount, {
              check_id: checkId,
              register_shift_id: shift,
              tip,
              ...(c % 2 === 0 ? { method: 'nequi', cardTerminal: null } : {}),
            }),
          ),
        )
      }
      case 14: {
        const payment = select(Object.values(est.payments), a)
        return payment
          ? only(
              event(
                id,
                'PaymentVoided',
                { payment_id: payment.id, register_shift_id: this.shift(b) },
                reason,
              ),
            )
          : null
      }
      case 15: {
        const payment = select(Object.values(est.payments), a)
        if (!payment) return null
        const sale = b % (payment.amount + 1)
        const tip = c % (payment.tip + 1)
        return only(
          event(
            id,
            'RefundRecorded',
            {
              payment_id: payment.id,
              refund_id: newId(),
              sale_amount: sale + tip === 0 ? 1 : sale,
              tip_amount: tip,
              method: payment.method,
              register_shift_id: this.shift(a),
            },
            reason,
          ),
        )
      }
      case 16:
        return only(event(id, 'OrderClosed', {}, { business_day: DAYS[a % 2] }))
      case 17:
        return only(event(id, 'OrderReopened', {}, reason))
      case 18:
        return only(event(id, 'OrderCanceled', {}, reason))
      case 19: {
        const eligible = items.filter((i) => ACTIVE_ITEM_STATUSES.includes(i.status))
        const batch = b % 3 === 0 ? eligible : [select(eligible, a)].filter((i) => i !== undefined)
        if (!batch.length) return null
        return {
          cssClass: 'crossed',
          source: p,
          target: q,
          event: event(
            id,
            'ItemsMoved',
            { target_order_id: this.orders[q], items: batch.map(toMoved) },
            { related: [this.orders[q]] },
          ),
        }
      }
      case 20:
        return {
          cssClass: 'crossed',
          source: p,
          target: q,
          event: event(
            this.orders[q],
            'OrdersMerged',
            { source_order_id: id, items: live.map(toMoved) },
            { related: [id] },
          ),
        }
      case 21:
        return only(
          a % 3 === 0
            ? event(id, 'WaiterAssigned', { waiter_id: b % 2 === 0 ? WAITER : newId() })
            : a % 3 === 1
              ? b % 4 === 0
                ? event(id, 'OrderNoteChanged', {
                    notes: b % 8 === 0 ? null : 'alérgico al maní',
                  })
                : event(id, 'GuestsChanged', { guests: b % 20 })
              : b % 2 === 0
                ? event(
                    id,
                    est.mergedTables.includes(MERGED_TABLE) ? 'TablesSeparated' : 'TablesMerged',
                    { table_ids: [MERGED_TABLE] },
                  )
                : event(id, 'OrderMovedTable', { target_table_id: newId() }),
        )
      case 22: {
        const t = orderTotals(est)
        return only(
          event(id, 'PreBillPrinted', {
            check_id: est.checks ? (select(est.checks, a)?.id ?? null) : null,
            subtotal: t.net,
            suggested_tip: percent(t.net, 1000),
          }),
        )
      }
      case 23: {
        const course = (['entry', 'main', 'dessert'] as const)[a % 3] ?? 'entry'
        return only(event(id, b % 2 === 0 ? 'CourseHeld' : 'CourseFired', { course }))
      }
      case 24: {
        if (!item) return null
        const types = [
          'ItemInPreparation',
          'ItemReady',
          'ItemServed',
          'ItemReturnedToQueue',
        ] as const
        // Almost always the item's natural next step; sometimes a random one to test the rejection.
        const natural = {
          sent: 'ItemInPreparation',
          in_preparation: 'ItemReady',
          ready: 'ItemServed',
          served: 'ItemReturnedToQueue',
        } as const
        const next =
          b % 4 === 0 || !(item.status in natural)
            ? types[c % 4]
            : natural[item.status as keyof typeof natural]
        return only(event(id, next ?? 'ItemReady', { item_ids: [item.id] }))
      }
      case 25:
        return item
          ? only(
              event(id, 'ItemModifiedAfterSend', {
                item_id: item.id,
                ticket_id: newId(),
                notes: 'Sin hielo',
                ...(b % 2 === 0
                  ? {}
                  : {
                      modifiers: [
                        {
                          modifier_id: newId(),
                          name: 'Extra',
                          extra_price: [0, 3000][c % 2] ?? 0,
                        },
                      ],
                    }),
              }),
            )
          : null
      default:
        return only(event(id, 'TicketReprinted', { ticket_id: newId() }))
    }
  }
}

function sendEvent(order: string, itemIds: string[]) {
  return event(order, 'ItemsSent', {
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: itemIds }],
  })
}

function discountEvent(
  order: string,
  scope: 'item' | 'order',
  rule: 'percent' | 'value' | 'comp',
  value: number,
  units: number | null,
  amounts: { item_id: string; amount: number }[],
) {
  return event(
    order,
    'DiscountApplied',
    {
      discount_id: newId(),
      scope,
      rule,
      value,
      unit_count: units,
      amounts,
    },
    { reason: 'Motivo de prueba' },
  )
}
