import type { PaginaCodigos } from './codificacion'
import { aLosLados, type Formato, type Linea, parrafo } from './documento'

// La precuenta en papel (tarea 1.6, brief §4.5): lo que lleva la mesa, el total, lo ya pagado, la
// propina sugerida y el total con propina. El hub arma `Precuenta` con los montos ya calculados
// por `@pos/core`; aquí solo se decide el orden y el estilo.

export interface LineaPrecuenta {
  cantidad: number
  nombre: string
  /** Opciones elegidas (término, adicionales). */
  opciones: string[]
  /** Neto de la línea en pesos: con impuesto, sin lo anulado ni los descuentos. */
  valor: number
}

export interface Precuenta {
  restaurante: string
  /** «Mesa 6», «Mesa 5 + 6», «Para llevar». */
  destino: string
  pedido: number | null
  mesero: string
  /** Ya formateada en la zona horaria del restaurante. */
  hora: string
  comensales: number | null
  lineas: LineaPrecuenta[]
  /**
   * El impuesto discriminado, por tipo y tarifa («INC 8 %»): base sin impuesto e impuesto en
   * pesos. Los exentos van con impuesto 0. Un hub de antes no lo manda.
   */
  impuestos?: { nombre: string; base: number; valor: number }[]
  total: number
  pagado: number
  /** En una cuenta dividida, cuál y cuánto le toca. */
  cuenta: { nombre: string; monto: number } | null
  /** Lo que se cobra sin propina: el saldo, o lo de la cuenta. */
  subtotal: number
  propina: number
  /** Puntos básicos (1000 = 10 %) si es la sugerida; null si el cliente pidió otra. */
  tasaPropina: number | null
}

/** $40.900, con punto de miles como en Colombia. */
export const pesos = (n: number) =>
  `${n < 0 ? '-' : ''}$${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`

const porcentaje = (bp: number) => `${bp / 100}`.replace('.', ',')

/** La precuenta partida en líneas para una impresora de ese ancho y esa tabla de caracteres. */
export function lineasPrecuenta(
  p: Precuenta,
  formato: { columnas: number; pagina: PaginaCodigos },
): Linea[] {
  const f: Formato = formato
  const datos = [
    p.pedido ? `Pedido ${p.pedido}` : null,
    p.mesero || null,
    p.hora,
    p.comensales ? `${p.comensales} pers.` : null,
  ].filter((d): d is string => !!d)

  const lineas: Linea[] = [
    ...parrafo(p.restaurante, f, { grande: true, centro: true }),
    ...parrafo('PRECUENTA', f, { invertido: true, centro: true, negrita: true }),
    { espacio: true },
    ...parrafo(p.destino, f, { grande: true }),
    ...parrafo(datos.join(' · '), f),
    { separador: true },
  ]
  for (const l of p.lineas) {
    lineas.push(...aLosLados(`${l.cantidad} x ${l.nombre}`, pesos(l.valor), f))
    // Las opciones van sangradas bajo su plato (`partir` quita los espacios del comienzo).
    for (const opcion of l.opciones)
      for (const linea of parrafo(opcion, { ...f, columnas: f.columnas - 2 }))
        if ('texto' in linea) lineas.push({ ...linea, texto: `  ${linea.texto}` })
  }
  lineas.push({ separador: true })
  const impuestos = p.impuestos ?? []
  if (impuestos.length > 0) {
    lineas.push(
      ...aLosLados('Base sin impuestos', pesos(impuestos.reduce((a, i) => a + i.base, 0)), f),
    )
    for (const i of impuestos)
      if (i.valor > 0) lineas.push(...aLosLados(i.nombre, pesos(i.valor), f))
  }
  lineas.push(...aLosLados('Total', pesos(p.total), f, { negrita: true }))
  if (p.pagado > 0) {
    lineas.push(...aLosLados('Ya pagado', `-${pesos(p.pagado)}`, f))
    lineas.push(...aLosLados('Saldo', pesos(p.total - p.pagado), f, { negrita: true }))
  }
  if (p.cuenta) {
    lineas.push({ separador: true })
    lineas.push(...aLosLados(p.cuenta.nombre, pesos(p.cuenta.monto), f, { negrita: true }))
  }
  if (p.propina > 0) {
    lineas.push(
      ...aLosLados(
        p.tasaPropina === null ? 'Propina' : `Propina sugerida (${porcentaje(p.tasaPropina)} %)`,
        pesos(p.propina),
        f,
      ),
      ...aLosLados('Total con propina', pesos(p.subtotal + p.propina), f, {
        grande: true,
      }),
    )
  } else {
    lineas.push(...aLosLados('A pagar', pesos(p.subtotal), f, { grande: true }))
  }
  lineas.push(
    { separador: true },
    ...parrafo('La propina es voluntaria.', f, { centro: true }),
    ...parrafo('Esta precuenta no es una factura.', f, { centro: true }),
  )
  return lineas
}

/** «INC 8 %», «IVA 19 %», «Exento». */
export function nombreImpuesto(tipo: 'inc' | 'iva' | 'exento', tarifa: number): string {
  if (tipo === 'exento' || tarifa === 0) return 'Exento'
  return `${tipo.toUpperCase()} ${porcentaje(tarifa)} %`
}
