import { businessDay, report } from '@pos/core'
import { datosDeInforme } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { guardasDeEquipo, type OpcionesImpresion } from '../impresion/rutas'
import { configDe, encolarCierreZ, impresoraDeCierre, nombresDeUsuarios } from './cierre-z'

// Reportes básicos (tarea 1.9, docs/KPIS.md): el informe de un período de días operativos y la
// reimpresión del cierre Z. Solo con el permiso «Ver todos los reportes».

/**
 * Un período no pasa de dos meses: el informe se arma en el mismo proceso que atiende a los
 * equipos y no debe frenarlos. Lo más largo es trabajo de la nube (Fase 3).
 */
export const MAX_DIAS_REPORTE = 62

/** Una fecha real AAAA-MM-DD (sin `toISOString`, que lanza con fechas imposibles). */
const esDia = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const t = Date.parse(`${d}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d)
}
const Day = z.string().refine(esDia, 'Fecha inválida')

const Sesion = z.strictObject({
  session_id: z.string().length(26),
  secret: z.string().min(1).max(100),
})

const diasEntre = (from: string, until: string) =>
  Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1

export async function rutasReportes(app: FastifyInstance, o: OpcionesImpresion) {
  const { db, restauranteId, access, cola, timeZone } = o
  const clock = o.clock ?? (() => new Date().toISOString())
  const { conEquipo, datosInvalidos, quien } = guardasDeEquipo(access)
  const options = { db, restauranteId, timeZone }

  // El informe de un período. Sin fechas, el día operativo de hoy.
  app.post('/api/reports', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ from: Day.optional(), until: Day.optional() }).safeParse(
      req.body,
    )
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['view_reports'])) return reply
    const cfg = configDe(options)
    const today = businessDay(clock(), timeZone, cfg.business_day_start)
    const from = cuerpo.data.from ?? today
    const until = cuerpo.data.until ?? from
    if (from > until) return datosInvalidos(reply, 'La fecha inicial va antes de la final')
    if (diasEntre(from, until) > MAX_DIAS_REPORTE)
      return datosInvalidos(reply, `Elige un período de ${MAX_DIAS_REPORTE} días o menos`)

    const data = datosDeInforme(new AlmacenSqlite(db, restauranteId), from, until)
    const result = report({
      ...data,
      config: { sales_by_waiter: cfg.sales_by_waiter, rounding_mode: cfg.rounding_mode },
    })
    const usuarios = nombresDeUsuarios(options, [
      ...result.byWaiter.map((m) => m.userId),
      ...result.voids.flatMap((a) => [a.userId, a.authorizedById ?? a.userId]),
      ...result.cancellations.flatMap((c) => [c.userId, c.authorizedById ?? c.userId]),
      ...data.cierresDeCaja.flatMap((c) => [c.abiertoPor, c.cerradoPor]),
    ])
    return {
      today,
      report: result,
      closings: data.cierresDeCaja.map((c) => ({
        shiftId: c.reconciliation.shiftId,
        businessDay: c.businessDay,
        openedAt: c.reconciliation.openedAt,
        abiertoPor: c.abiertoPor,
        cerradoPor: c.cerradoPor,
        base: c.reconciliation.base,
        byMethod: c.reconciliation.byMethod,
        closed: c.reconciliation.closed,
      })),
      usuarios,
      printer: impresoraDeCierre(options) !== null,
    }
  })

  // Reimprimir el cierre Z de un turno cerrado.
  app.post('/api/reports/z-report', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ turno_id: z.string().length(26) }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['view_reports'])) return reply
    const r = encolarCierreZ(options, cuerpo.data.turno_id, { reprintedAt: clock() })
    if (r === 'no_printer')
      return reply.code(409).send({
        error: 'no_printer',
        message: 'Elige la impresora de precuentas en «Caja y pagos» para imprimir el cierre',
      })
    if (r === 'no_closeout')
      return reply
        .code(404)
        .send({ error: 'no_closeout', message: 'Ese turno no existe o sigue abierto' })
    cola.despertar()
    return reply.code(204).send()
  })
}
