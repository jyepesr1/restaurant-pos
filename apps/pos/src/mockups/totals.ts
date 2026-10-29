import { balanceOf, type CheckLine, checkTotal } from './check'
import type { OrderItem, Table } from './data'

// What several screens calculate the same way for a table: names, totals and times.

/** A ticket moves to "atención" at 10 minutes and to "demora" at 20 (KDS and plan). */
export const SERVICE_MINUTES = 10
export const DELAY_MINUTES = 20

export const itemName = (i: OrderItem) =>
  [i.product.name, i.variant && `(${i.variant.toLowerCase()})`].filter(Boolean).join(' ')

/** The items that count: voided ones stay visible, but are not charged. */
export const currentItems = (table: Table) => table.items.filter((i) => !i.voided)

export const lineOf = (i: OrderItem): CheckLine => ({
  id: i.id,
  quantity: i.quantity,
  unitPrice: i.unitPrice,
  extras: i.options.map((o) => o.extraPrice),
})

export const tableTotal = (table: Table) => checkTotal(currentItems(table).map(lineOf))
export const tableBalance = (table: Table) => balanceOf(tableTotal(table), table.payments)

/** Minutes between `from` and `now`. */
export const minutesSince = (from: number | null, now: number) =>
  from === null ? 0 : Math.max(0, Math.floor((now - from) / 60_000))

/** What was sent that the kitchen or bar has not delivered yet. */
export const inPreparation = (table: Table) =>
  currentItems(table).filter((i) => i.sentAt !== null && !i.dispatched)

/** Minutes of the oldest ticket still in preparation (0 if there is none). */
export function longestWait(table: Table, now: number): number {
  const pendingList = inPreparation(table)
  if (pendingList.length === 0) return 0
  return minutesSince(Math.min(...pendingList.map((i) => i.sentAt as number)), now)
}
