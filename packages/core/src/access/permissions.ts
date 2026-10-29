import type { NewEvent, OrderEventType } from '../events/order'
import type { OrderState } from '../order/state'

// Built-in permissions and roles (docs/MODELO_DATOS.md#permisos). The keys are fixed; each
// restaurant only decides which roles have them (`role_permissions`).

export const PERMISSIONS = [
  'take_order',
  'remove_unsent_item',
  'void_sent_item',
  'cancel_order',
  'apply_discount',
  'comp',
  'reassign_table',
  'split_check',
  'record_payment',
  'void_payment',
  'close_table',
  'reopen_check',
  'open_register_shift',
  'close_register_shift',
  'cash_movement',
  'open_drawer_no_sale',
  'mark_preparation',
  'mark_product_sold_out',
  'edit_catalog',
  'edit_prices',
  'manage_users',
  'manage_devices',
  'view_reports',
  'view_own_reports',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)

const allExcept = (...outside: Permission[]) => PERMISSIONS.filter((p) => !outside.includes(p))

/**
 * What each permission says on the roles screen, grouped as shown there. Each restaurant
 * decides which roles have which (ADR-013).
 */
export const PERMISSION_DESCRIPTIONS: readonly {
  group: string
  permissions: readonly { permission: Permission; name: string }[]
}[] = [
  {
    group: 'Pedidos',
    permissions: [
      { permission: 'take_order', name: 'Tomar y enviar pedidos' },
      { permission: 'remove_unsent_item', name: 'Quitar lo que aún no se envió' },
      { permission: 'void_sent_item', name: 'Anular lo ya enviado a cocina' },
      { permission: 'cancel_order', name: 'Cancelar un pedido completo' },
      { permission: 'reassign_table', name: 'Pasar una mesa a otro mesero' },
      { permission: 'mark_product_sold_out', name: 'Marcar productos agotados' },
    ],
  },
  {
    group: 'Cuenta y cobro',
    permissions: [
      { permission: 'apply_discount', name: 'Dar descuentos' },
      { permission: 'comp', name: 'Dar cortesías' },
      { permission: 'split_check', name: 'Dividir la cuenta' },
      { permission: 'record_payment', name: 'Cobrar' },
      { permission: 'void_payment', name: 'Anular pagos y reembolsar' },
      { permission: 'close_table', name: 'Cerrar mesas' },
      { permission: 'reopen_check', name: 'Reabrir una cuenta cerrada' },
    ],
  },
  {
    group: 'Caja',
    permissions: [
      { permission: 'open_register_shift', name: 'Abrir turno de caja' },
      { permission: 'close_register_shift', name: 'Cerrar turno de caja' },
      { permission: 'cash_movement', name: 'Entradas y salidas de efectivo' },
      { permission: 'open_drawer_no_sale', name: 'Abrir el cajón sin venta' },
    ],
  },
  {
    group: 'Cocina',
    permissions: [
      { permission: 'mark_preparation', name: 'Marcar platos en preparación y listos' },
    ],
  },
  {
    group: 'Administración',
    permissions: [
      { permission: 'edit_catalog', name: 'Editar la carta y el plano' },
      { permission: 'edit_prices', name: 'Cambiar precios' },
      { permission: 'manage_users', name: 'Personal y roles (equivale a poder todo)' },
      { permission: 'manage_devices', name: 'Retirar celulares y equipos' },
    ],
  },
  {
    group: 'Reportes',
    permissions: [
      { permission: 'view_reports', name: 'Ver todos los reportes' },
      { permission: 'view_own_reports', name: 'Ver sus propias ventas' },
    ],
  },
]

/**
 * Permissions that cannot be used when signing in with just a 4-digit PIN: anyone who has one
 * signs in with username and password (ADR-013). A PIN is easier to guess than a password, and
 * these move money, change the menu or manage the restaurant.
 */
export const PASSWORD_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'record_payment',
  'void_payment',
  'close_table',
  'reopen_check',
  'open_register_shift',
  'close_register_shift',
  'cash_movement',
  'open_drawer_no_sale',
  'edit_catalog',
  'edit_prices',
  'manage_users',
  'manage_devices',
  'view_reports',
])

/** Checkout permissions: signing in with one makes the device a register (payments, closes). */
export const CHECKOUT_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'record_payment',
  'void_payment',
  'close_table',
])

/**
 * The only things a kitchen screen can do (ADR-015): mark ready, undo what was marked by mistake
 * and mark sold out. Its technical user has a hidden role with these permissions.
 */
export const SCREEN_PERMISSIONS: readonly Permission[] = [
  'mark_preparation',
  'mark_product_sold_out',
]

export type RoleKey = 'admin' | 'cashier' | 'reports' | 'waiter'

/**
 * Roles every restaurant starts with (ADR-013). They are a starting point: the admin changes
 * their permissions and creates any roles they want. They are not archived.
 */
export const DEFAULT_ROLES: Record<RoleKey, { name: string; permissions: readonly Permission[] }> =
  {
    admin: { name: 'Administrador', permissions: allExcept('view_own_reports') },
    cashier: {
      name: 'Cajero',
      permissions: [
        'take_order',
        'remove_unsent_item',
        'void_sent_item',
        'apply_discount',
        'reassign_table',
        'split_check',
        'record_payment',
        'close_table',
        'open_register_shift',
        'close_register_shift',
        'cash_movement',
        'mark_product_sold_out',
        'view_own_reports',
      ],
    },
    reports: { name: 'Reportes', permissions: ['view_reports'] },
    waiter: {
      name: 'Mesero',
      permissions: ['take_order', 'remove_unsent_item', 'mark_preparation', 'view_own_reports'],
    },
  }

/**
 * Built-in roles from before ADR-013. On startup, a hub that has them converts them: Contador
 * is renamed Reportes, and Gerente and Cocina become the restaurant's own roles (with their
 * permissions and their people), which the admin can change or archive.
 */
export const RETIRED_ROLES = {
  rename: { Contador: 'Reportes' },
  toCustom: ['Gerente', 'Cocina'],
} as const

/** `null`: no device can create it; only the hub emits it. */
const PERMISSION_BY_TYPE: Record<OrderEventType, Permission | null> = {
  OrderOpened: 'take_order',
  RescueOrderCreated: null,
  WaiterAssigned: 'reassign_table',
  GuestsChanged: 'take_order',
  OrderNoteChanged: 'take_order',
  ItemAdded: 'take_order',
  ItemChanged: 'take_order',
  ItemRemoved: 'remove_unsent_item',
  ItemsSent: 'take_order',
  ItemModifiedAfterSend: 'take_order',
  TicketReprinted: 'take_order',
  CourseHeld: 'take_order',
  CourseFired: 'take_order',
  ItemInPreparation: 'mark_preparation',
  ItemReady: 'mark_preparation',
  ItemServed: 'mark_preparation',
  ItemReturnedToQueue: 'mark_preparation',
  ItemVoided: 'void_sent_item',
  ItemsMoved: 'take_order',
  OrderMovedTable: 'take_order',
  TablesMerged: 'take_order',
  TablesSeparated: 'take_order',
  OrdersMerged: 'take_order',
  DiscountApplied: 'apply_discount',
  DiscountRemoved: 'apply_discount',
  PreBillPrinted: 'take_order',
  CheckSplit: 'split_check',
  SplitUndone: 'split_check',
  PaymentRecorded: 'record_payment',
  PaymentVoided: 'void_payment',
  RefundRecorded: 'void_payment',
  OrderClosed: 'close_table',
  OrderReopened: 'reopen_check',
  OrderCanceled: 'cancel_order',
  ProductSoldOut: 'mark_product_sold_out',
  ProductAvailable: 'mark_product_sold_out',
  ShiftOpened: 'open_register_shift',
  CashMovementRecorded: 'cash_movement',
  CashCountRecorded: 'close_register_shift',
  ShiftClosed: 'close_register_shift',
}

const sumExtras = (prices: readonly number[]) => prices.reduce((a, b) => a + b, 0)

/**
 * Permission required to create that event. Some depend on the content and on the order state:
 * changing the modifiers of an already sent item so that it costs less is a partial void, not
 * an ordinary change.
 */
export function permissionFor(event: NewEvent, order: OrderState | null = null): Permission | null {
  if (event.type === 'DiscountApplied' && event.data.rule === 'comp') return 'comp'
  if (event.type === 'ItemModifiedAfterSend' && event.data.modifiers) {
    const item = order?.items[event.data.item_id]
    const before = sumExtras(item?.modifiers.map((m) => m.extraPrice) ?? [])
    const after = sumExtras(event.data.modifiers.map((m) => m.extra_price))
    if (item && after < before) return 'void_sent_item'
  }
  return PERMISSION_BY_TYPE[event.type]
}

/** Payments and closes only come from a register device (docs/MODELO_DATOS.md#permisos). */
export const ONLY_FROM_REGISTER: ReadonlySet<OrderEventType> = new Set([
  'ShiftOpened',
  'CashMovementRecorded',
  'CashCountRecorded',
  'ShiftClosed',
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
  'OrderClosed',
])
