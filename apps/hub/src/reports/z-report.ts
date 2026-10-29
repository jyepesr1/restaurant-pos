import {
  fullConfig,
  methodName,
  newId,
  type OrderEvent,
  type PaymentMethod,
  report,
} from '@pos/core'
import type { SqliteDatabase } from '@pos/db'
import { taxName, type ZReport } from '@pos/printing'
import { reportData, shiftClose } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'

// The Z report (task 1.9, docs/KPIS.md#cierre-z-impreso): it comes out of the pre-bill printer
// when the register is closed and is reprinted from Reports. Amounts are frozen when the job is
// created: a reprint recalculates them from what is stored and says it is a reprint.

export interface ZReportOptions {
  db: SqliteDatabase
  restaurantId: string
  timeZone: string
}

/** The restaurant config with its defaults. */
export const configOf = (o: { db: SqliteDatabase; restaurantId: string }) =>
  fullConfig(
    JSON.parse(
      String(
        o.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(o.restaurantId)?.config ??
          '{}',
      ),
    ),
  )

/** People's names, by id (those who are gone keep their name). */
export function userNames(o: ZReportOptions, ids: Iterable<string>) {
  const names: Record<string, string> = {}
  const query = o.db.prepare('SELECT name FROM users WHERE restaurant_id = ? AND id = ?')
  for (const id of new Set(ids))
    names[id] = String(query.get(o.restaurantId, id)?.name ?? 'Alguien')
  return names
}

/** «sábado 24 de octubre de 2026» from a business day YYYY-MM-DD. */
export const dayInWords = (day: string) =>
  new Intl.DateTimeFormat('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T12:00:00Z`))

const dateTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timeZone,
  }).format(new Date(iso))

/** The Z report of a closed shift; null if the shift does not exist or is still open. */
export function buildZReport(
  o: ZReportOptions,
  shiftId: string,
  reprintedAt: string | null,
): ZReport | null {
  const store = new SqliteStore(o.db, o.restaurantId)
  const closeout = shiftClose(store, shiftId)
  const closed = closeout?.reconciliation.closed
  if (!closeout || !closed) return null
  const config = configOf(o)
  // A shift belongs to one day: even if it closes after 6 a.m., it carries the sales of the day
  // it opened.
  const day = closeout.openingDay
  const r = report({ ...reportData(store, day, day), config })
  const names = userNames(o, [closeout.openedBy, closeout.closedBy])
  const method = (m: { method: PaymentMethod; customMethodId: string | null }) =>
    methodName(m.method, m.customMethodId, config.custom_methods)
  const c = closeout.reconciliation
  return {
    restaurant: String(
      o.db.prepare('SELECT name FROM restaurants WHERE id = ?').get(o.restaurantId)?.name ?? '',
    ),
    day: dayInWords(day),
    opened: dateTime(c.openedAt, o.timeZone),
    closed: dateTime(closed.time, o.timeZone),
    openedByName: names[closeout.openedBy] ?? '',
    closedByName: names[closeout.closedBy] ?? '',
    cash: {
      base: c.base,
      charged: c.cash.charged,
      refunds: c.cash.refunds,
      cashIn: c.cash.cashIn,
      cashOut: c.cash.cashOut,
      tipPayouts: c.cash.tipPayouts,
      expected: closed.expected,
      counted: closed.counted,
      variance: closed.variance,
    },
    otherMethods: closed.otherMethods.map((m) => ({
      name: method(m),
      expected: m.expected,
      reported: m.reported,
      variance: m.variance,
    })),
    justification: closed.justification,
    charged: c.byMethod.map((m) => ({ name: method(m), sale: m.sale, tip: m.tip })),
    sales: {
      net: r.sales.net,
      taxes: r.sales.taxes.map((i) => ({
        name: taxName(i.type, i.rate),
        base: i.base,
        value: i.tax,
      })),
      tips: r.sales.tips,
      checks: r.sales.checks,
      guests: r.sales.guests,
      averageTicket: r.sales.averageTicket,
      roundingAdjustments: r.sales.roundingAdjustments,
      // What was voided in the day, like the Reports list (counts the day it was voided).
      voided: r.voids.reduce((a, x) => a + x.value, 0),
      canceled: r.cancellations.reduce((a, x) => a + x.value, 0),
      discounts: r.sales.discounts,
    },
    reprinted: reprintedAt ? dateTime(reprintedAt, o.timeZone) : null,
  }
}

/** The pre-bill printer, if one is chosen and active. */
export function zReportPrinter(o: ZReportOptions): string | null {
  const id = configOf(o).pre_bill_printer_id
  if (!id) return null
  const active = o.db
    .prepare('SELECT 1 FROM printers WHERE restaurant_id = ? AND id = ? AND active = 1')
    .get(o.restaurantId, id)
  return active ? id : null
}

/**
 * Queues the Z report. On register close it carries the event id (retrying the same event does
 * not duplicate it); a reprint goes without an event. It is built only once.
 */
export function enqueueZReport(
  o: ZReportOptions,
  shiftId: string,
  when: { event: OrderEvent } | { reprintedAt: string },
): 'queued' | 'no_printer' | 'no_closeout' {
  const printerId = zReportPrinter(o)
  if (!printerId) return 'no_printer'
  const reprintedAt = 'reprintedAt' in when ? when.reprintedAt : null
  const z = buildZReport(o, shiftId, reprintedAt)
  if (!z) return 'no_closeout'
  o.db
    .prepare(
      `INSERT INTO print_jobs
         (id, restaurant_id, printer_id, type, event_id, ticket_id, content, created_at)
       VALUES (?, ?, ?, 'report', ?, 'closeout', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      newId(),
      o.restaurantId,
      printerId,
      'event' in when ? when.event.id : null,
      JSON.stringify(z),
      'event' in when ? when.event.received_at : (reprintedAt as string),
    )
  return 'queued'
}
