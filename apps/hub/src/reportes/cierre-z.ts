import {
  configCompleta,
  type EventoPedido,
  informe,
  type MedioPago,
  nombreDeMedio,
  nuevoId,
} from '@pos/core'
import type { BaseSqlite } from '@pos/db'
import { type CierreZ, nombreImpuesto } from '@pos/printing'
import { cierreDeTurno, datosDeInforme } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'

// El cierre Z (tarea 1.9, docs/KPIS.md#cierre-z-impreso): sale en la impresora de precuentas al
// cerrar la caja y se reimprime desde Reportes. Los montos se congelan al crear el trabajo: una
// reimpresión vuelve a calcularlos con lo guardado y dice que es una reimpresión.

export interface OpcionesCierreZ {
  db: BaseSqlite
  restauranteId: string
  zonaHoraria: string
}

/** La configuración del restaurante con sus valores por defecto. */
export const configDe = (o: { db: BaseSqlite; restauranteId: string }) =>
  configCompleta(
    JSON.parse(
      String(
        o.db.prepare('SELECT config FROM restaurante WHERE id = ?').get(o.restauranteId)?.config ??
          '{}',
      ),
    ),
  )

/** Nombres de las personas, por id (las que ya no están siguen con su nombre). */
export function nombresDeUsuarios(o: OpcionesCierreZ, ids: Iterable<string>) {
  const nombres: Record<string, string> = {}
  const consulta = o.db.prepare('SELECT nombre FROM usuario WHERE restaurante_id = ? AND id = ?')
  for (const id of new Set(ids))
    nombres[id] = String(consulta.get(o.restauranteId, id)?.nombre ?? 'Alguien')
  return nombres
}

/** «sábado 24 de octubre de 2026» de un día operativo AAAA-MM-DD. */
export const diaEnPalabras = (dia: string) =>
  new Intl.DateTimeFormat('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${dia}T12:00:00Z`))

const fechaHora = (iso: string, zonaHoraria: string) =>
  new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zonaHoraria,
  }).format(new Date(iso))

/** El cierre Z de un turno cerrado; null si el turno no existe o sigue abierto. */
export function armarCierreZ(
  o: OpcionesCierreZ,
  turnoId: string,
  reimpresoEn: string | null,
): CierreZ | null {
  const almacen = new AlmacenSqlite(o.db, o.restauranteId)
  const cierre = cierreDeTurno(almacen, turnoId)
  const cerrado = cierre?.cuadre.cerrado
  if (!cierre || !cerrado) return null
  const config = configDe(o)
  // Un turno es de un día: aunque se cierre pasadas las 6 a. m., lleva las ventas del día en que abrió.
  const dia = cierre.diaApertura
  const r = informe({ ...datosDeInforme(almacen, dia, dia), config })
  const nombres = nombresDeUsuarios(o, [cierre.abiertoPor, cierre.cerradoPor])
  const medio = (m: { medio: MedioPago; medioPropioId: string | null }) =>
    nombreDeMedio(m.medio, m.medioPropioId, config.medios_propios)
  const c = cierre.cuadre
  return {
    restaurante: String(
      o.db.prepare('SELECT nombre FROM restaurante WHERE id = ?').get(o.restauranteId)?.nombre ??
        '',
    ),
    dia: diaEnPalabras(dia),
    abierto: fechaHora(c.abiertoEn, o.zonaHoraria),
    cerrado: fechaHora(cerrado.hora, o.zonaHoraria),
    abrio: nombres[cierre.abiertoPor] ?? '',
    cerro: nombres[cierre.cerradoPor] ?? '',
    efectivo: {
      base: c.base,
      cobrado: c.efectivo.cobrado,
      devoluciones: c.efectivo.devoluciones,
      entradas: c.efectivo.entradas,
      salidas: c.efectivo.salidas,
      pagosPropinas: c.efectivo.pagosPropinas,
      esperado: cerrado.esperado,
      contado: cerrado.contado,
      diferencia: cerrado.diferencia,
    },
    otrosMedios: cerrado.otrosMedios.map((m) => ({
      nombre: medio(m),
      esperado: m.esperado,
      reportado: m.reportado,
      diferencia: m.diferencia,
    })),
    justificacion: cerrado.justificacion,
    cobrado: c.porMedio.map((m) => ({ nombre: medio(m), venta: m.venta, propina: m.propina })),
    ventas: {
      neto: r.ventas.neto,
      impuestos: r.ventas.impuestos.map((i) => ({
        nombre: nombreImpuesto(i.tipo, i.tarifa),
        base: i.base,
        valor: i.impuesto,
      })),
      propinas: r.ventas.propinas,
      cuentas: r.ventas.cuentas,
      comensales: r.ventas.comensales,
      ticketPromedio: r.ventas.ticketPromedio,
      ajustes: r.ventas.ajustes,
      // Lo anulado en el día, como la lista de Reportes (cuenta el día en que se anuló).
      anulado: r.anulaciones.reduce((a, x) => a + x.valor, 0),
      cancelado: r.cancelaciones.reduce((a, x) => a + x.valor, 0),
      descuentos: r.ventas.descuentos,
    },
    reimpreso: reimpresoEn ? fechaHora(reimpresoEn, o.zonaHoraria) : null,
  }
}

/** La impresora de precuentas, si hay una elegida y activa. */
export function impresoraDeCierre(o: OpcionesCierreZ): string | null {
  const id = configDe(o).impresora_precuenta_id
  if (!id) return null
  const activa = o.db
    .prepare('SELECT 1 FROM impresora WHERE restaurante_id = ? AND id = ? AND activo = 1')
    .get(o.restauranteId, id)
  return activa ? id : null
}

/**
 * Pone el cierre Z en la cola. Al cerrar la caja va con el id del evento (reintentar el mismo
 * evento no lo duplica); una reimpresión va sin evento. Lo arma una sola vez.
 */
export function encolarCierreZ(
  o: OpcionesCierreZ,
  turnoId: string,
  cuando: { evento: EventoPedido } | { reimpresoEn: string },
): 'en_cola' | 'sin_impresora' | 'sin_cierre' {
  const impresoraId = impresoraDeCierre(o)
  if (!impresoraId) return 'sin_impresora'
  const reimpresoEn = 'reimpresoEn' in cuando ? cuando.reimpresoEn : null
  const z = armarCierreZ(o, turnoId, reimpresoEn)
  if (!z) return 'sin_cierre'
  o.db
    .prepare(
      `INSERT INTO trabajo_impresion
         (id, restaurante_id, impresora_id, tipo, evento_id, comanda_id, contenido, creado_en)
       VALUES (?, ?, ?, 'informe', ?, 'cierre', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      nuevoId(),
      o.restauranteId,
      impresoraId,
      'evento' in cuando ? cuando.evento.id : null,
      JSON.stringify(z),
      'evento' in cuando ? cuando.evento.recibido_en : (reimpresoEn as string),
    )
  return 'en_cola'
}
