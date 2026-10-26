import { diaOperativo, informe } from '@pos/core'
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
const Dia = z.string().refine(esDia, 'Fecha inválida')

const Sesion = z.strictObject({
  sesion_id: z.string().length(26),
  secreto: z.string().min(1).max(100),
})

const diasEntre = (desde: string, hasta: string) =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1

export async function rutasReportes(app: FastifyInstance, o: OpcionesImpresion) {
  const { db, restauranteId, acceso, cola, zonaHoraria } = o
  const reloj = o.reloj ?? (() => new Date().toISOString())
  const { conEquipo, datosInvalidos, quien } = guardasDeEquipo(acceso)
  const opciones = { db, restauranteId, zonaHoraria }

  // El informe de un período. Sin fechas, el día operativo de hoy.
  app.post('/api/reportes', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ desde: Dia.optional(), hasta: Dia.optional() }).safeParse(
      req.body,
    )
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['ver_reportes'])) return reply
    const cfg = configDe(opciones)
    const hoy = diaOperativo(reloj(), zonaHoraria, cfg.inicio_dia_operativo)
    const desde = cuerpo.data.desde ?? hoy
    const hasta = cuerpo.data.hasta ?? desde
    if (desde > hasta) return datosInvalidos(reply, 'La fecha inicial va antes de la final')
    if (diasEntre(desde, hasta) > MAX_DIAS_REPORTE)
      return datosInvalidos(reply, `Elige un período de ${MAX_DIAS_REPORTE} días o menos`)

    const datos = datosDeInforme(new AlmacenSqlite(db, restauranteId), desde, hasta)
    const resultado = informe({
      ...datos,
      config: { ventas_por_mesero: cfg.ventas_por_mesero, redondeo_modo: cfg.redondeo_modo },
    })
    const usuarios = nombresDeUsuarios(opciones, [
      ...resultado.porMesero.map((m) => m.usuarioId),
      ...resultado.anulaciones.flatMap((a) => [a.usuarioId, a.autorizadoPorId ?? a.usuarioId]),
      ...resultado.cancelaciones.flatMap((c) => [c.usuarioId, c.autorizadoPorId ?? c.usuarioId]),
      ...datos.cierresDeCaja.flatMap((c) => [c.abiertoPor, c.cerradoPor]),
    ])
    return {
      hoy,
      informe: resultado,
      cierres: datos.cierresDeCaja.map((c) => ({
        turnoId: c.cuadre.turnoId,
        diaOperativo: c.diaOperativo,
        abiertoEn: c.cuadre.abiertoEn,
        abiertoPor: c.abiertoPor,
        cerradoPor: c.cerradoPor,
        base: c.cuadre.base,
        porMedio: c.cuadre.porMedio,
        cerrado: c.cuadre.cerrado,
      })),
      usuarios,
      impresora: impresoraDeCierre(opciones) !== null,
    }
  })

  // Reimprimir el cierre Z de un turno cerrado.
  app.post('/api/reportes/cierre-z', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ turno_id: z.string().length(26) }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['ver_reportes'])) return reply
    const r = encolarCierreZ(opciones, cuerpo.data.turno_id, { reimpresoEn: reloj() })
    if (r === 'sin_impresora')
      return reply.code(409).send({
        error: 'sin_impresora',
        mensaje: 'Elige la impresora de precuentas en «Caja y pagos» para imprimir el cierre',
      })
    if (r === 'sin_cierre')
      return reply
        .code(404)
        .send({ error: 'sin_cierre', mensaje: 'Ese turno no existe o sigue abierto' })
    cola.despertar()
    return reply.code(204).send()
  })
}
