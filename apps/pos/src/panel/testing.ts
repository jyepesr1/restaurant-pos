import { type Alert, newId, type Report, type ShiftReconciliation } from '@pos/core'
import { kitchenTickets, type LocalEvent, openOrders } from '@pos/sync'
import type { CheckoutRules } from '../floor/checks'
import type { PeriodReport } from '../floor/engine'
import { inOrder, itemData, local, opening, TIME } from '../floor/testing'
import type { AlertsAnswer, LiveFloor, Me, RegisterAnswer, Summary } from './api'
import type { FloorAnswer } from './live-floor'

// Fixtures for the panel's tests.

export function reportOf(sales: Partial<Report['sales']> = {}, day = '2026-10-29'): Report {
  return {
    from: day,
    until: day,
    sales: {
      gross: 0,
      voided: 0,
      discounts: 0,
      net: 0,
      roundingAdjustments: 0,
      taxes: [],
      tips: 0,
      checks: 0,
      guests: 0,
      averageTicket: 0,
      spendPerGuest: 0,
      ...sales,
    },
    byMethod: [],
    byWaiter: [],
    byProduct: [],
    voids: [],
    cancellations: [],
    discounts: [],
    tipPool: { tips: 0, paidOut: 0, balance: 0 },
    unapplied: [],
  }
}

export function summaryOf(over: Partial<Summary> = {}): Summary {
  return {
    server_now: '2026-10-30T02:41:00.000Z',
    today: '2026-10-29',
    report: {
      ...reportOf({ net: 1_250_000, checks: 14, guests: 31, averageTicket: 89_286, tips: 112_000 }),
      byMethod: [
        { method: 'cash', customMethodId: null, sale: 450_000, tip: 30_000, payments: 5 },
        { method: 'card', customMethodId: null, sale: 800_000, tip: 82_000, payments: 9 },
      ],
    },
    last_week: {
      day: '2026-10-22',
      report_until_now: reportOf({ net: 1_000_000, checks: 12, guests: 25 }, '2026-10-22'),
      report_full: reportOf({ net: 1_800_000 }, '2026-10-22'),
    },
    users: { ana: 'Ana' },
    local: {
      last_seen_at: '2026-10-30T02:41:00.000Z',
      last_event_at: '2026-10-30T02:39:00.000Z',
      pending: 0,
    },
    open: { orders: 5, tables: 6, guests: 14, total: 486_000 },
    ...over,
  }
}

export const rules: CheckoutRules = {
  paymentMethods: ['cash', 'card', 'other'],
  customMethods: [{ id: 'qr', name: 'QR Bancolombia' }],
  archivedCustomMethods: [{ id: 'sodexo', name: 'Sodexo' }],
  suggestedTip: 1000,
  roundingMode: 'half_up',
  cashRounding: 50,
  cashRoundingMode: 'nearest_half_up',
  printsPreBill: true,
}

export const me = (
  permissions: string[] = ['remote_access', 'view_reports'],
  restaurant: Partial<Me['restaurant']> = {},
): Me => ({
  user: { id: 'ana', name: 'Ana Gómez', permissions },
  restaurant: {
    id: 'r1',
    name: 'La Spritzzería',
    slug: 'la-spritzzeria',
    time_zone: 'America/Bogota',
    brand: null,
    payment_methods: rules,
    ...restaurant,
  },
})

export const periodReportOf = (over: Partial<PeriodReport> = {}): PeriodReport => ({
  today: '2026-10-29',
  report: reportOf({ net: 50_000, checks: 1 }),
  closings: [],
  users: { ana: 'Ana' },
  printer: false,
  ...over,
})

// ── The live floor (task 1.11c-2) ──

export const WAITER = newId()
export const KITCHEN = newId()
export const BAR = newId()
export const TABLE_1 = newId()
export const TABLE_2 = newId()
export const TERRACE_TABLE = newId()
const geometry = { width: 80, height: 80, rotation: 0, capacity: 4 }

/**
 * The cloud's answer for a small floor, made with the devices' own projections: Mesa 1 with a
 * pizza in the kitchen and a lemonade ready (ticket #12), a discount and a note; a takeout order
 * still being taken; Mesa 2 and the terrace's Mesa 3 free. The cloud's clock is 20 minutes after
 * everything was sent (TIME), and the hub was heard from just then.
 */
export function floorAnswerOf(over: Partial<FloorAnswer> = {}): FloorAnswer {
  const a = newId()
  const takeout = newId()
  const pizza = itemData({ name: 'Pizza margarita', unit_price: 40_000, guest: 1 })
  const lemonade = itemData({ name: 'Limonada', unit_price: 10_000, notes: 'sin hielo' })
  const ticket = newId()
  const sent = local('ItemsSent', a, {
    tickets: [
      { ticket_id: ticket, station_id: KITCHEN, item_ids: [pizza.item_id, lemonade.item_id] },
    ],
  })
  const withNumber = {
    ...sent,
    event: { ...sent.event, assignments: { ticket_numbers: { [ticket]: 12 } } },
  } as LocalEvent
  const locals = inOrder([
    local('OrderOpened', a, { ...opening, table_id: TABLE_1, guests: 3 }, 'confirmed', {
      user_id: WAITER,
    }),
    local('ItemAdded', a, pizza),
    local('ItemAdded', a, lemonade),
    local('OrderNoteChanged', a, { notes: 'alérgico al maní' }),
    withNumber,
    local('ItemReady', a, { item_ids: [lemonade.item_id] }),
    local('OrderOpened', takeout, { channel: 'takeout', table_id: null, guests: 1 }, 'confirmed', {
      user_id: WAITER,
    }),
    local('ItemAdded', takeout, itemData({ name: 'Café', unit_price: 5_000 })),
  ])
  const orders = openOrders(locals)
  const tickets = kitchenTickets(locals, orders)
  const states = orders.map((p) => p.status)
  // A courtesy on the lemonade, with its reason (the reducer's own shape).
  const first = states.find((o) => o.id === a)
  if (first)
    first.discounts = {
      d1: {
        id: 'd1',
        scope: 'item',
        rule: 'comp',
        value: 0,
        amounts: { [lemonade.item_id]: 10_000 },
        reason: 'Cliente frecuente',
      },
    }
  const serverNow = new Date(Date.parse(TIME) + 20 * 60_000).toISOString()
  const answer: LiveFloor = {
    server_now: serverNow,
    today: '2026-10-24',
    as_of: TIME,
    local: { last_seen_at: serverNow, last_event_at: TIME, pending: 0 },
    plan_version: 'v1',
    plan: {
      zones: [
        { id: 'z1', name: 'Salón', level: 1 },
        { id: 'z2', name: 'Terraza', level: 1 },
      ],
      tables: [
        { id: TABLE_1, zoneId: 'z1', name: '1', x: 0, y: 0, shape: 'round', ...geometry },
        { id: TABLE_2, zoneId: 'z1', name: '2', x: 200, y: 0, shape: 'square', ...geometry },
        { id: TERRACE_TABLE, zoneId: 'z2', name: '3', x: 0, y: 0, shape: 'square', ...geometry },
      ],
      elements: [],
      stations: [
        { id: KITCHEN, name: 'Cocina', prints: true },
        { id: BAR, name: 'Barra', screen: true },
      ],
    },
    timers: { yellow: 15, red: 30 },
    orders: states,
    tickets: tickets.map((t) => ({
      key: t.key,
      ticket_id: t.ticketId,
      order_id: t.order.status.id,
      station_id: t.stationId,
      number: t.number,
      sent_at: t.sentAt,
      item_ids: t.items.map((i) => i.id),
      ready: t.list,
    })),
    users: { [WAITER]: 'Ana Gómez' },
  }
  return { ...answer, plan: answer.plan as FloorAnswer['plan'], ...over }
}

// ── «Caja» and «Alertas» (task 1.11c-2) ──

export const CASHIER = 'carla'
export const OWNER = 'luis'

export function reconciliationOf(over: Partial<ShiftReconciliation> = {}): ShiftReconciliation {
  return {
    shiftId: 's1',
    registerId: 'r1',
    base: 100_000,
    openedAt: '2026-10-29T17:00:00.000Z',
    byMethod: [
      { method: 'cash', customMethodId: null, sale: 450_000, tip: 30_000, payments: 5 },
      { method: 'card', customMethodId: null, sale: 800_000, tip: 82_000, payments: 9 },
      { method: 'other', customMethodId: 'qr', sale: 40_000, tip: 0, payments: 1 },
    ],
    movements: [],
    cashCounts: [],
    unapplied: [],
    cash: {
      charged: 480_000,
      refunds: 0,
      cashIn: 0,
      cashOut: 20_000,
      tipPayouts: 0,
      expected: 560_000,
    },
    closed: null,
    ...over,
  }
}

/**
 * Two registers open (one since yesterday) and one closed today missing $5.000 in cash and
 * $2.000 in Nequi, with its justification.
 */
export function registerAnswerOf(over: Partial<RegisterAnswer> = {}): RegisterAnswer {
  return {
    server_now: '2026-10-30T02:41:00.000Z',
    today: '2026-10-29',
    as_of: '2026-10-30T02:39:00.000Z',
    local: {
      last_seen_at: '2026-10-30T02:41:00.000Z',
      last_event_at: '2026-10-30T02:39:00.000Z',
      pending: 0,
    },
    threshold: 1_000,
    open: [
      {
        shift_id: 's0',
        register_id: 'r2',
        opened_at: '2026-10-28T23:00:00.000Z',
        opened_by: OWNER,
        reconciliation: reconciliationOf({
          shiftId: 's0',
          registerId: 'r2',
          base: 50_000,
          openedAt: '2026-10-28T23:00:00.000Z',
          byMethod: [],
          cash: { charged: 0, refunds: 0, cashIn: 0, cashOut: 0, tipPayouts: 0, expected: 50_000 },
        }),
      },
      {
        shift_id: 's1',
        register_id: 'r1',
        opened_at: '2026-10-29T17:00:00.000Z',
        opened_by: CASHIER,
        reconciliation: reconciliationOf(),
      },
    ],
    closed: [
      {
        shiftId: 's2',
        businessDay: '2026-10-29',
        openedAt: '2026-10-29T12:00:00.000Z',
        openedBy: CASHIER,
        closedBy: OWNER,
        base: 100_000,
        byMethod: [],
        closed: {
          expected: 300_000,
          counted: 295_000,
          variance: -5_000,
          justification: 'Se dio mal un cambio',
          otherMethods: [
            {
              method: 'nequi',
              customMethodId: null,
              expected: 80_000,
              reported: 78_000,
              variance: -2_000,
            },
          ],
          time: '2026-10-29T22:00:00.000Z',
        },
      },
    ],
    users: { [CASHIER]: 'Carla', [OWNER]: 'Luis' },
    ...over,
  }
}

const TABLE_3 = 't3'
const order = { id: 'o1', number: 12, tableId: TABLE_3, channel: 'dine_in' as const }

/** One alert of each kind, from the newest (as the cloud sends them). */
export const ALERTS: Alert[] = [
  {
    type: 'register_variance',
    id: 'a7',
    time: '2026-10-30T02:30:00.000Z',
    order: null,
    userId: OWNER,
    authorizedById: null,
    reason: 'Se dio mal un cambio',
    value: -5_000,
    shiftId: 's2',
    method: 'cash',
    customMethodId: null,
    expected: 300_000,
    counted: 295_000,
    openedBy: CASHIER,
  },
  {
    type: 'order_reopened',
    id: 'a6',
    time: '2026-10-30T02:20:00.000Z',
    order,
    userId: OWNER,
    authorizedById: null,
    reason: 'Faltó un postre',
    value: 61_800,
  },
  {
    type: 'refund',
    id: 'a5',
    time: '2026-10-30T02:10:00.000Z',
    order,
    userId: CASHIER,
    authorizedById: OWNER,
    reason: 'Plato frío',
    value: 12_000,
    method: 'other',
    customMethodId: 'qr',
    tip: 2_000,
  },
  {
    type: 'payment_voided',
    id: 'a4',
    time: '2026-10-30T02:00:00.000Z',
    order,
    userId: CASHIER,
    authorizedById: null,
    reason: 'Cobro duplicado',
    value: 44_900,
    method: 'cash',
    customMethodId: null,
    tip: 4_000,
    roundingAdjustment: 0,
  },
  {
    type: 'discount',
    id: 'a3',
    time: '2026-10-30T01:50:00.000Z',
    order,
    userId: 'ana',
    authorizedById: OWNER,
    reason: 'Cliente frecuente',
    value: 20_900,
    rule: 'comp',
    scope: 'item',
    basisPoints: null,
    units: 1,
    items: ['Pinsa'],
    removedAt: null,
    removedBy: null,
  },
  {
    type: 'order_canceled',
    id: 'a2',
    time: '2026-10-30T01:40:00.000Z',
    order: { id: 'o2', number: 13, tableId: null, channel: 'takeout' },
    userId: 'ana',
    authorizedById: null,
    reason: 'El cliente se fue',
    value: 12_000,
  },
  {
    type: 'item_voided',
    id: 'a1',
    time: '2026-10-30T01:30:00.000Z',
    order,
    userId: 'ana',
    authorizedById: OWNER,
    reason: 'Se quemó',
    value: 20_900,
    name: 'Pinsa',
    units: 1,
    alreadyPrepared: true,
  },
]

/**
 * Money the hub did not apply (task 1.7b), one of each kind, from the newest: a payment and a
 * refund with their method, and a voided payment whose payment is not among the events.
 */
export const UNAPPLIED_ALERTS: Alert[] = [
  {
    type: 'unapplied_money',
    id: 'u3',
    time: '2026-10-30T02:35:00.000Z',
    order,
    userId: CASHIER,
    authorizedById: OWNER,
    reason: 'Plato frío',
    value: -12_000,
    kind: 'RefundRecorded',
    method: 'other',
    customMethodId: 'qr',
  },
  {
    type: 'unapplied_money',
    id: 'u2',
    time: '2026-10-30T02:34:00.000Z',
    order,
    userId: CASHIER,
    authorizedById: null,
    reason: 'Cobro duplicado',
    value: null,
    kind: 'PaymentVoided',
    method: null,
    customMethodId: null,
  },
  {
    type: 'unapplied_money',
    id: 'u1',
    time: '2026-10-30T02:33:00.000Z',
    order,
    userId: CASHIER,
    authorizedById: null,
    reason: null,
    value: 44_900,
    kind: 'PaymentRecorded',
    method: 'cash',
    customMethodId: null,
  },
]

export function alertsAnswerOf(over: Partial<AlertsAnswer> = {}): AlertsAnswer {
  return {
    server_now: '2026-10-30T02:41:00.000Z',
    today: '2026-10-29',
    day: '2026-10-29',
    as_of: '2026-10-30T02:39:00.000Z',
    local: {
      last_seen_at: '2026-10-30T02:41:00.000Z',
      last_event_at: '2026-10-30T02:39:00.000Z',
      pending: 0,
    },
    threshold: 1_000,
    alerts: ALERTS,
    users: { ana: 'Ana', [CASHIER]: 'Carla', [OWNER]: 'Luis' },
    tables: { [TABLE_3]: '3' },
    ...over,
  }
}
