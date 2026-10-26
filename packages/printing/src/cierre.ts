import type { PaginaCodigos } from './codificacion'
import { aLosLados, type Estilo, type Formato, type Linea, parrafo } from './documento'
import { pesos } from './precuenta'

// El cierre Z en papel (tarea 1.9, docs/KPIS.md#cierre-z-impreso): el cuadre del turno, las ventas
// del día operativo, lo cobrado por medio y lo anulado. Sale en la impresora de precuentas al
// cerrar la caja y se puede reimprimir desde Reportes. El hub arma `CierreZ` con los montos ya
// calculados por `@pos/core`; aquí solo se decide el orden y el estilo.

export interface MedioCierreZ {
  nombre: string
  /** Lo registrado en el sistema (venta + propina). */
  esperado: number
  /** Lo que dice el cierre del datáfono o la app. */
  reportado: number
  diferencia: number
}

export interface CierreZ {
  restaurante: string
  /** El día operativo, ya en palabras («sábado 24 de octubre de 2026»). */
  dia: string
  /** Horas ya formateadas en la zona horaria del restaurante. */
  abierto: string
  cerrado: string
  abrio: string
  cerro: string
  efectivo: {
    base: number
    cobrado: number
    devoluciones: number
    entradas: number
    salidas: number
    pagosPropinas: number
    esperado: number
    contado: number
    diferencia: number
  }
  otrosMedios: MedioCierreZ[]
  justificacion: string | null
  /** Lo cobrado en el turno, por medio de pago. */
  cobrado: { nombre: string; venta: number; propina: number }[]
  /** Las ventas de todo el día operativo (no solo del turno). */
  ventas: {
    neto: number
    impuestos: { nombre: string; base: number; valor: number }[]
    propinas: number
    cuentas: number
    comensales: number
    ticketPromedio: number
    /** Ajuste por redondeo del efectivo: lo cobrado de más o de menos al redondear. */
    ajustes?: number
    anulado: number
    cancelado: number
    descuentos: number
  }
  /** Hora de la reimpresión, si lo es. */
  reimpreso: string | null
}

/** «Cuadra», «Sobran $1.000» o «Faltan $1.000», como en la pantalla de la caja. */
const enPalabras = (n: number) =>
  n === 0 ? 'Cuadra' : n > 0 ? `Sobran ${pesos(n)}` : `Faltan ${pesos(-n)}`

/** El cierre Z partido en líneas para una impresora de ese ancho y esa tabla de caracteres. */
export function lineasCierreZ(
  z: CierreZ,
  formato: { columnas: number; pagina: PaginaCodigos },
): Linea[] {
  const f: Formato = formato
  const fila = (izquierda: string, derecha: string, estilo: Estilo = {}) =>
    aLosLados(izquierda, derecha, f, estilo)
  const titulo = (texto: string) => [
    { separador: true } as Linea,
    ...parrafo(texto, f, { negrita: true }),
  ]
  const e = z.efectivo
  const lineas: Linea[] = [
    ...parrafo(z.restaurante, f, { grande: true, centro: true }),
    ...parrafo('CIERRE DE CAJA', f, { invertido: true, centro: true, negrita: true }),
    ...(z.reimpreso ? parrafo(`Reimpresión ${z.reimpreso}`, f, { centro: true }) : []),
    { espacio: true },
    ...parrafo(z.dia, f, { negrita: true }),
    ...parrafo(`Abrió ${z.abrio} · ${z.abierto}`, f),
    ...parrafo(`Cerró ${z.cerro} · ${z.cerrado}`, f),

    ...titulo('Efectivo'),
    ...fila('Base', pesos(e.base)),
    ...fila('Cobrado', pesos(e.cobrado)),
  ]
  if (e.devoluciones) lineas.push(...fila('Devoluciones', `-${pesos(e.devoluciones)}`))
  if (e.entradas) lineas.push(...fila('Entradas', pesos(e.entradas)))
  if (e.salidas) lineas.push(...fila('Salidas', `-${pesos(e.salidas)}`))
  if (e.pagosPropinas) lineas.push(...fila('Pago de propinas', `-${pesos(e.pagosPropinas)}`))
  lineas.push(
    ...fila('Esperado', pesos(e.esperado), { negrita: true }),
    ...fila('Contado', pesos(e.contado), { negrita: true }),
    ...fila('Diferencia', enPalabras(e.diferencia), { negrita: true }),
  )

  if (z.otrosMedios.length > 0) {
    lineas.push(...titulo('Otros medios (según sistema / según cierre)'))
    for (const m of z.otrosMedios) {
      lineas.push(...fila(m.nombre, `${pesos(m.esperado)} / ${pesos(m.reportado)}`))
      if (m.diferencia !== 0) lineas.push(...fila('  Diferencia', enPalabras(m.diferencia)))
    }
  }
  if (z.justificacion) lineas.push(...titulo('Justificación'), ...parrafo(z.justificacion, f))

  if (z.cobrado.length > 0) {
    lineas.push(...titulo('Cobrado en el turno'))
    for (const m of z.cobrado) {
      lineas.push(...fila(m.nombre, pesos(m.venta + m.propina)))
      if (m.propina !== 0) lineas.push(...fila('  de propina', pesos(m.propina)))
    }
  }

  const v = z.ventas
  lineas.push(...titulo('Ventas del día'), ...fila('Ventas', pesos(v.neto), { negrita: true }))
  if (v.impuestos.length > 0) {
    lineas.push(...fila('Base sin impuestos', pesos(v.impuestos.reduce((a, i) => a + i.base, 0))))
    for (const i of v.impuestos) if (i.valor > 0) lineas.push(...fila(i.nombre, pesos(i.valor)))
  }
  lineas.push(
    ...(v.ajustes ? fila('Ajuste por redondeo', pesos(v.ajustes)) : []),
    ...fila('Propinas', pesos(v.propinas)),
    ...fila('Cuentas', String(v.cuentas)),
    ...fila('Comensales', String(v.comensales)),
    ...fila('Ticket promedio', pesos(v.ticketPromedio)),
  )
  if (v.anulado || v.cancelado || v.descuentos) {
    lineas.push(...titulo('Anulado y descontado'))
    if (v.anulado) lineas.push(...fila('Productos anulados', pesos(v.anulado)))
    if (v.cancelado) lineas.push(...fila('Pedidos cancelados', pesos(v.cancelado)))
    if (v.descuentos) lineas.push(...fila('Descuentos', pesos(v.descuentos)))
  }
  lineas.push(
    { separador: true },
    { espacio: true },
    ...parrafo('Firma cajero', f),
    { espacio: true },
    { espacio: true },
    ...parrafo('Firma de quien recibe', f),
  )
  return lineas
}
