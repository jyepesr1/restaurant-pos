import type { Channel, Course, PaymentMethod, TaxType } from '../events/common'

export type ItemStatus =
  | 'held'
  | 'pending'
  | 'sent'
  | 'in_preparation'
  | 'ready'
  | 'served'
  | 'voided'

export interface ItemModifier {
  modifierId: string
  name: string
  extraPrice: number
}

export interface OrderItem {
  id: string
  productId: string
  variantId: string | null
  name: string
  unitPrice: number
  taxType: TaxType
  rate: number
  quantity: number
  voidedQuantity: number
  guest: number | null
  course: Course | null
  status: ItemStatus
  addedBy: string
  notes: string | null
  modifiers: ItemModifier[]
  /** Order in which it was added: breaks ties in allocations. */
  position: number
}

export interface OrderDiscount {
  id: string
  scope: 'item' | 'order'
  rule: 'percent' | 'value' | 'comp'
  value: number
  /** Pesos already computed per item: the projection never recomputes them. */
  amounts: Record<string, number>
  reason: string | null
}

export interface Check {
  id: string
  name: string
  amount: number
  suggestedTip: number
}

export interface Payment {
  id: string
  checkId: string | null
  registerShiftId: string
  method: PaymentMethod
  /** With `method: 'other'`, which of the restaurant's custom methods. */
  customMethodId: string | null
  amount: number
  tip: number
  roundingAdjustment: number
  voided: boolean
  refundedSale: number
  refundedTip: number
  /** Refunds already applied: the same one is never applied twice. */
  refundIds: string[]
}

export interface OrderState {
  id: string
  channel: Channel
  tableId: string | null
  guests: number
  assignedWaiterId: string
  status: 'open' | 'closed' | 'canceled'
  openedAt: string
  closedAt: string | null
  /** Business day of the first close (docs/DINERO.md#día-operativo-e-informes). */
  businessDay: string | null
  dayNumber: number | null
  rescueOf: string | null
  mergedInto: string | null
  /** Note for the whole order: goes on every ticket and to the kitchen. */
  notes: string | null
  /** Other tables the order occupies besides `tableId` (a large party, task 1.5). */
  mergedTables: string[]
  /** Emptied by moving all its products to another table (task 1.5): no longer holds its own. */
  emptiedOnMove: boolean
  items: Record<string, OrderItem>
  discounts: Record<string, OrderDiscount>
  heldCourses: Course[]
  checks: Check[] | null
  payments: Record<string, Payment>
  lastPreBill: { checkId: string | null; subtotal: number; suggestedTip: number } | null
  lastSequence: number
  nextPosition: number
}
