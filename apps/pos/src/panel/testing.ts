import type { Report } from '@pos/core'
import type { CheckoutRules } from '../floor/checks'
import type { PeriodReport } from '../floor/engine'
import type { Me, Summary } from './api'

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
