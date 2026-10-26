import type { MedioPago } from '@pos/core'
import type { ReglasCobro } from './cuentas'
import { nombreDeMedio } from './cuentas'
import type { Reporte } from './motor'

// Lo que calcula la pantalla Reportes (tarea 1.9) sin dibujar nada: los períodos que se eligen
// con un toque, las fechas en palabras y el CSV para Excel (docs/KPIS.md#exportar).

export type Atajo = 'hoy' | 'ayer' | 'semana' | 'mes' | 'mesPasado'

/** El período más largo que da el hub (`MAX_DIAS_REPORTE`). */
export const MAX_DIAS = 62

export interface Periodo {
  desde: string
  hasta: string
}

/** El día operativo `dias` antes o después (AAAA-MM-DD, sin zona horaria). */
export function sumarDias(dia: string, dias: number): string {
  const fecha = new Date(`${dia}T12:00:00Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

/** Hoy, ayer, los últimos 7 días, este mes (hasta hoy) o el mes pasado, desde el día operativo de hoy. */
export function periodoDe(atajo: Atajo, hoy: string): Periodo {
  if (atajo === 'ayer') return { desde: sumarDias(hoy, -1), hasta: sumarDias(hoy, -1) }
  if (atajo === 'semana') return { desde: sumarDias(hoy, -6), hasta: hoy }
  const primero = `${hoy.slice(0, 8)}01`
  if (atajo === 'mes') return { desde: primero, hasta: hoy }
  if (atajo === 'mesPasado') {
    const ultimo = sumarDias(primero, -1)
    return { desde: `${ultimo.slice(0, 8)}01`, hasta: ultimo }
  }
  return { desde: hoy, hasta: hoy }
}

const formato = (opciones: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('es-CO', { ...opciones, timeZone: 'UTC' })
const aFecha = (dia: string) => new Date(`${dia}T12:00:00Z`)

/** «sábado, 24 de octubre de 2026» o «del 18–24 de octubre de 2026». */
export function periodoEnPalabras({ desde, hasta }: Periodo): string {
  if (desde === hasta)
    return formato({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
      aFecha(desde),
    )
  return `del ${formato({ day: 'numeric', month: 'long', year: 'numeric' }).formatRange(
    aFecha(desde),
    aFecha(hasta),
  )}`
}

/** «2026-10-24 20:15» en la zona del restaurante: Excel lo lee como fecha y hora. */
export function fechaHoraCsv(iso: string, zonaHoraria: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: zonaHoraria,
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  )
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** «24 oct.», para las filas de un período de varios días. */
export const diaCorto = (dia: string) =>
  formato({ day: 'numeric', month: 'short' }).format(aFecha(dia))

/** Puntos básicos en porcentaje con coma: 1250 → «12,5 %». */
export const puntosEnPorcentaje = (bp: number) => `${(bp / 100).toLocaleString('es-CO')} %`

/** Porcentaje con un decimal, solo para mostrar (KPIS.md#por-producto). */
export function porcentaje(parte: number, total: number): string {
  if (total === 0) return '0 %'
  return `${(Math.round((parte * 1000) / total) / 10).toLocaleString('es-CO')} %`
}

// ── CSV ────────────────────────────────────────────────────────────────

/**
 * Una celda del CSV. El texto que empieza con = + - @ va con un apóstrofo para que Excel no lo
 * tome como fórmula (un producto llamado «=HYPERLINK(…)» no se ejecuta al abrir el archivo).
 */
export function celda(valor: string | number): string {
  if (typeof valor === 'number') return String(valor)
  const seguro = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor
  return /[;"\n\r]/.test(seguro) ? `"${seguro.replaceAll('"', '""')}"` : seguro
}

const filaCsv = (valores: (string | number)[]) => valores.map(celda).join(';')

const NOMBRE_REGLA = { porcentaje: 'Porcentaje', valor: 'Valor', cortesia: 'Cortesía' } as const

/**
 * El reporte en CSV para Excel: separado por punto y coma, UTF-8 con BOM y montos enteros en
 * pesos, sin separador de miles. Una sección tras otra, con una línea en blanco entre ellas.
 */
export function csvDeReporte(
  r: Reporte,
  periodo: Periodo,
  reglas: ReglasCobro | null,
  restaurante: string,
): string {
  const { informe: inf } = r
  const v = inf.ventas
  const quien = (id: string | null) => (id ? (r.usuarios[id] ?? '') : '')
  const hora = (iso: string) => fechaHoraCsv(iso, reglas?.zonaHoraria ?? 'America/Bogota')
  const pedido = (n: number | null) => (n === null ? '' : n)
  const medio = (m: { medio: MedioPago; medioPropioId: string | null }) =>
    nombreDeMedio(m.medio, m.medioPropioId, reglas)
  const secciones: (string | number)[][][] = [
    [
      ['Reporte', restaurante],
      ['Desde', periodo.desde],
      ['Hasta', periodo.hasta],
    ],
    [
      ['Ventas', 'Pesos'],
      ['Bruto', v.bruto],
      ['Anulado', v.anulado],
      ['Descuentos', v.descuentos],
      ['Neto', v.neto],
      ['Ajuste por redondeo', v.ajustes],
      ...v.impuestos.flatMap((i) => [
        [`Base ${i.tipo.toUpperCase()} ${puntosEnPorcentaje(i.tarifa)}`, i.base],
        [`Impuesto ${i.tipo.toUpperCase()} ${puntosEnPorcentaje(i.tarifa)}`, i.impuesto],
      ]),
      ['Propinas', v.propinas],
      ['Cuentas', v.cuentas],
      ['Comensales', v.comensales],
      ['Ticket promedio', v.ticketPromedio],
      ['Gasto por comensal', v.gastoPorComensal],
    ],
    [
      ['Medio de pago', 'Venta', 'Propina', 'Pagos'],
      ...inf.porMedio.map((m) => [medio(m), m.venta, m.propina, m.pagos]),
    ],
    [
      ['Mesero', 'Neto', 'Cuentas', 'Ticket promedio'],
      ...inf.porMesero.map((m) => [quien(m.usuarioId), m.neto, m.cuentas, m.ticketPromedio]),
    ],
    [
      ['Producto', 'Unidades', 'Neto'],
      ...inf.porProducto.map((p) => [p.nombre, p.unidades, p.neto]),
    ],
    [
      [
        'Anulación',
        'Pedido',
        'Unidades',
        'Valor',
        'Motivo',
        'Ya preparado',
        'Quién',
        'Autorizó',
        'Hora',
      ],
      ...inf.anulaciones.map((a) => [
        a.nombre,
        pedido(a.pedidoNumero),
        a.unidades,
        a.valor,
        a.motivo ?? '',
        a.yaPreparado ? 'Sí' : 'No',
        quien(a.usuarioId),
        quien(a.autorizadoPorId),
        hora(a.hora),
      ]),
    ],
    [
      ['Pedido cancelado', 'Valor', 'Motivo', 'Quién', 'Autorizó', 'Hora'],
      ...inf.cancelaciones.map((c) => [
        pedido(c.pedidoNumero),
        c.valor,
        c.motivo ?? '',
        quien(c.usuarioId),
        quien(c.autorizadoPorId),
        hora(c.hora),
      ]),
    ],
    [
      ['Descuento', 'Pedido', 'Valor', 'Monto', 'Motivo'],
      ...inf.descuentos.map((d) => [
        NOMBRE_REGLA[d.regla],
        pedido(d.pedidoNumero),
        d.regla === 'porcentaje' ? puntosEnPorcentaje(d.valor) : d.valor,
        d.monto,
        d.motivo ?? '',
      ]),
    ],
    [
      [
        'Cierre de caja',
        'Abrió',
        'Cerró',
        'Base',
        'Esperado',
        'Contado',
        'Diferencia',
        'Justificación',
      ],
      ...r.cierres.map((c) => [
        c.diaOperativo,
        quien(c.abiertoPor),
        quien(c.cerradoPor),
        c.base,
        c.cerrado.esperado,
        c.cerrado.contado,
        c.cerrado.diferencia,
        c.cerrado.justificacion ?? '',
      ]),
    ],
    [
      ['Cierre de caja', 'Otro medio', 'Según el sistema', 'Según su cierre', 'Diferencia'],
      ...r.cierres.flatMap((c) =>
        c.cerrado.otrosMedios.map((m) => [
          c.diaOperativo,
          medio(m),
          m.esperado,
          m.reportado,
          m.diferencia,
        ]),
      ),
    ],
    [
      ['Fondo de propinas', 'Pesos'],
      ['Propinas registradas', inf.fondoPropinas.propinas],
      ['Pagadas desde la caja', inf.fondoPropinas.pagadas],
      ['Saldo', inf.fondoPropinas.saldo],
    ],
  ]
  return `﻿${secciones.map((s) => s.map(filaCsv).join('\r\n')).join('\r\n\r\n')}\r\n`
}

/** El nombre del archivo: «reporte-2026-10-24.csv» o «reporte-2026-10-18-a-2026-10-24.csv». */
export const nombreCsv = ({ desde, hasta }: Periodo) =>
  desde === hasta ? `reporte-${desde}.csv` : `reporte-${desde}-a-${hasta}.csv`
