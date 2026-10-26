import { businessDay, report } from '@pos/core'
import { reportData } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { deviceGuards, type PrintingOptions } from '../printing/routes'
import { configOf, enqueueZReport, userNames, zReportPrinter } from './z-report'

// Basic reports (task 1.9, docs/KPIS.md): the report for a period of business days and the
// Z report reprint. Only with the «Ver todos los reportes» permission.

/**
 * A period is at most two months: the report is built in the same process that serves the
 * devices and must not slow them down. Anything longer is work for the cloud (Phase 3).
 */
export const MAX_REPORT_DAYS = 62

/** A real YYYY-MM-DD date (without `toISOString`, which throws on impossible dates). */
const isDay = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const t = Date.parse(`${d}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d)
}
const Day = z.string().refine(isDay, 'Fecha inválida')

const Session = z.strictObject({
  session_id: z.string().length(26),
  secret: z.string().min(1).max(100),
})

const daysBetween = (from: string, until: string) =>
  Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1

export async function reportRoutes(app: FastifyInstance, o: PrintingOptions) {
  const { db, restaurantId, access, queue, timeZone } = o
  const clock = o.clock ?? (() => new Date().toISOString())
  const { withDevice, invalidData, who } = deviceGuards(access)
  const options = { db, restaurantId, timeZone }

  // The report for a period. Without dates, today's business day.
  app.post('/api/reports', withDevice, async (req, reply) => {
    const body = Session.extend({ from: Day.optional(), until: Day.optional() }).safeParse(req.body)
    if (!body.success) return invalidData(reply)
    if (!who(req, reply, body.data, ['view_reports'])) return reply
    const cfg = configOf(options)
    const today = businessDay(clock(), timeZone, cfg.business_day_start)
    const from = body.data.from ?? today
    const until = body.data.until ?? from
    if (from > until) return invalidData(reply, 'La fecha inicial va antes de la final')
    if (daysBetween(from, until) > MAX_REPORT_DAYS)
      return invalidData(reply, `Elige un período de ${MAX_REPORT_DAYS} días o menos`)

    const data = reportData(new SqliteStore(db, restaurantId), from, until)
    const result = report({
      ...data,
      config: { sales_by_waiter: cfg.sales_by_waiter, rounding_mode: cfg.rounding_mode },
    })
    const users = userNames(options, [
      ...result.byWaiter.map((m) => m.userId),
      ...result.voids.flatMap((a) => [a.userId, a.authorizedById ?? a.userId]),
      ...result.cancellations.flatMap((c) => [c.userId, c.authorizedById ?? c.userId]),
      ...data.registerClosings.flatMap((c) => [c.openedBy, c.closedBy]),
    ])
    return {
      today,
      report: result,
      closings: data.registerClosings.map((c) => ({
        shiftId: c.reconciliation.shiftId,
        businessDay: c.businessDay,
        openedAt: c.reconciliation.openedAt,
        openedBy: c.openedBy,
        closedBy: c.closedBy,
        base: c.reconciliation.base,
        byMethod: c.reconciliation.byMethod,
        closed: c.reconciliation.closed,
      })),
      users,
      printer: zReportPrinter(options) !== null,
    }
  })

  // Reprint the Z report of a closed shift.
  app.post('/api/reports/z-report', withDevice, async (req, reply) => {
    const body = Session.extend({ shift_id: z.string().length(26) }).safeParse(req.body)
    if (!body.success) return invalidData(reply)
    if (!who(req, reply, body.data, ['view_reports'])) return reply
    const r = enqueueZReport(options, body.data.shift_id, { reprintedAt: clock() })
    if (r === 'no_printer')
      return reply.code(409).send({
        error: 'no_printer',
        message: 'Elige la impresora de precuentas en «Caja y pagos» para imprimir el cierre',
      })
    if (r === 'no_closeout')
      return reply
        .code(404)
        .send({ error: 'no_closeout', message: 'Ese turno no existe o sigue abierto' })
    queue.wake()
    return reply.code(204).send()
  })
}
