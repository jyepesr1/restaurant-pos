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

// El cierre Z (tarea 1.9, docs/KPIS.md#cierre-z-impreso): sale en la impresora de precuentas al
// cerrar la caja y se reimprime desde Reportes. Los montos se congelan al crear el trabajo: una
// reimpresión vuelve a calcularlos con lo guardado y dice que es una reimpresión.

export interface OpcionesCierreZ {
  db: SqliteDatabase
  restaurantId: string
  timeZone: string
}

/** La configuración del restaurante con sus valores por defecto. */
export const configDe = (o: { db: SqliteDatabase; restaurantId: string }) =>
  fullConfig(
    JSON.parse(
      String(
        o.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(o.restaurantId)?.config ??
          '{}',
      ),
    ),
  )

/** Nombres de las personas, por id (las que ya no están siguen con su nombre). */
export function nombresDeUsuarios(o: OpcionesCierreZ, ids: Iterable<string>) {
  const names: Record<string, string> = {}
  const consulta = o.db.prepare('SELECT name FROM users WHERE restaurant_id = ? AND id = ?')
  for (const id of new Set(ids))
    names[id] = String(consulta.get(o.restaurantId, id)?.name ?? 'Alguien')
  return names
}

/** «sábado 24 de octubre de 2026» de un día operativo AAAA-MM-DD. */
export const diaEnPalabras = (day: string) =>
  new Intl.DateTimeFormat('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T12:00:00Z`))

const fechaHora = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timeZone,
  }).format(new Date(iso))

/** El cierre Z de un turno cerrado; null si el turno no existe o sigue abierto. */
export function armarCierreZ(
  o: OpcionesCierreZ,
  shiftId: string,
  reprintedAt: string | null,
): ZReport | null {
  const store = new SqliteStore(o.db, o.restaurantId)
  const closeout = shiftClose(store, shiftId)
  const closed = closeout?.reconciliation.closed
  if (!closeout || !closed) return null
  const config = configDe(o)
  // Un turno es de un día: aunque se cierre pasadas las 6 a. m., lleva las ventas del día en que abrió.
  const day = closeout.openingDay
  const r = report({ ...reportData(store, day, day), config })
  const names = nombresDeUsuarios(o, [closeout.openedBy, closeout.closedBy])
  const method = (m: { method: PaymentMethod; customMethodId: string | null }) =>
    methodName(m.method, m.customMethodId, config.custom_methods)
  const c = closeout.reconciliation
  return {
    restaurant: String(
      o.db.prepare('SELECT name FROM restaurants WHERE id = ?').get(o.restaurantId)?.name ?? '',
    ),
    day: diaEnPalabras(day),
    opened: fechaHora(c.openedAt, o.timeZone),
    closed: fechaHora(closed.time, o.timeZone),
    openedByName: names[closeout.openedBy] ?? '',
    closedByName: names[closeout.closedBy] ?? '',
    cash: {
      base: c.base,
      charged: c.cash.charged,
      refunds: c.cash.refunds,
      entries: c.cash.entries,
      outflows: c.cash.outflows,
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
      settings: r.sales.settings,
      // Lo anulado en el día, como la lista de Reportes (cuenta el día en que se anuló).
      voided: r.voids.reduce((a, x) => a + x.value, 0),
      canceled: r.cancellations.reduce((a, x) => a + x.value, 0),
      discounts: r.sales.discounts,
    },
    reprinted: reprintedAt ? fechaHora(reprintedAt, o.timeZone) : null,
  }
}

/** La impresora de precuentas, si hay una elegida y activa. */
export function impresoraDeCierre(o: OpcionesCierreZ): string | null {
  const id = configDe(o).pre_bill_printer_id
  if (!id) return null
  const activa = o.db
    .prepare('SELECT 1 FROM printers WHERE restaurant_id = ? AND id = ? AND active = 1')
    .get(o.restaurantId, id)
  return activa ? id : null
}

/**
 * Pone el cierre Z en la cola. Al cerrar la caja va con el id del evento (reintentar el mismo
 * evento no lo duplica); una reimpresión va sin evento. Lo arma una sola vez.
 */
export function encolarCierreZ(
  o: OpcionesCierreZ,
  shiftId: string,
  when: { event: OrderEvent } | { reprintedAt: string },
): 'queued' | 'no_printer' | 'no_closeout' {
  const printerId = impresoraDeCierre(o)
  if (!printerId) return 'no_printer'
  const reprintedAt = 'reprintedAt' in when ? when.reprintedAt : null
  const z = armarCierreZ(o, shiftId, reprintedAt)
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
