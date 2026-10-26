import type { PaginaCodigos } from './codificacion'
import { aLosLados, type Formato, type Linea, parrafo } from './documento'

// Qué lleva una comanda y cómo se ve en papel (ADR-015). El hub arma `Comanda` con los datos ya
// resueltos (nombres de mesa, mesero y estación, la hora en la zona del restaurante): aquí solo se
// decide el orden y el estilo.

/** `nota`: cambió la nota de todo el pedido con platos ya en cocina (alergias: que no se pierda). */
export type TipoComanda =
  | 'newOne'
  | 'reprinting'
  | 'modification'
  | 'voidEntry'
  | 'note'
  /** Platos ya en cocina que pasaron a otra mesa: la cocina debe llevarlos a la nueva. */
  | 'move'
export type CursoComanda = 'entry' | 'main' | 'dessert'

export interface ItemComanda {
  quantity: number
  name: string
  guest: number | null
  course: CursoComanda | null
  /** Opciones elegidas (término, sin cebolla, adicionales): van resaltadas. */
  options: string[]
  notes: string | null
}

export interface Comanda {
  type: TipoComanda
  /** «Cocina», «Barra»… */
  station: string
  /** Número del día; la reimpresión y la anulación llevan el de la comanda original. */
  numero: number | null
  /** «Mesa 6», «Para llevar», «Domicilio», «Barra». */
  target: string
  /** Número de pedido del día. */
  order: number | null
  waiter: string
  /** Ya formateada en la zona horaria del restaurante («8:42 p. m.»). */
  time: string
  guests: number | null
  items: ItemComanda[]
  /** Cursos que siguen retenidos en el pedido: la cocina sabe que vienen después. */
  retenidos?: CursoComanda[]
  /** La nota de todo el pedido («alérgico al maní»): sale arriba, resaltada. */
  notaPedido?: string | null
  /** En un cambio de mesa, dónde estaba antes («Mesa 5»). */
  before?: string | null
}

const TITULO: Record<TipoComanda, string | null> = {
  newOne: null,
  reprinting: 'REIMPRESIÓN',
  modification: 'CAMBIO',
  voidEntry: 'ANULAR',
  note: 'NOTA NUEVA',
  move: 'CAMBIO DE MESA',
}

const NOMBRE_CURSO: Record<CursoComanda, string> = {
  entry: 'Entrada',
  main: 'Fuerte',
  dessert: 'Postre',
}

const ORDEN_CURSO: (CursoComanda | null)[] = [null, 'entry', 'main', 'dessert']

function lineasItem(item: ItemComanda, format: Formato, voidEntry: boolean): Linea[] {
  const persona = item.guest ? `  P${item.guest}` : ''
  const lines: Linea[] = aLosLados(
    `${voidEntry ? '-' : ''}${item.quantity} x ${item.name}`,
    persona.trim(),
    format,
    { large: true },
  )
  for (const opcion of item.options)
    lines.push(...parrafo(`> ${opcion}`, format, { negrita: true }))
  if (item.notes) lines.push(...parrafo(`NOTA: ${item.notes}`, format, { reversed: true }))
  return lines
}

/** La comanda partida en líneas para una impresora de ese ancho y esa tabla de caracteres. */
export function lineasComanda(
  ticket: Comanda,
  format: { columnas: number; pagina: PaginaCodigos },
): Linea[] {
  const titulo = TITULO[ticket.type]
  const encabezado = titulo ? `${titulo} · ${ticket.station}` : ticket.station
  const data = [
    ticket.order ? `Pedido ${ticket.order}` : null,
    ticket.waiter,
    ticket.time,
    ticket.guests ? `${ticket.guests} pers.` : null,
  ].filter((d): d is string => !!d)

  const lines: Linea[] = [
    ...parrafo(encabezado.toUpperCase(), format, { large: true, reversed: true, centro: true }),
    { space: true },
    ...aLosLados(ticket.target, ticket.numero ? `#${ticket.numero}` : '', format, {
      large: true,
    }),
    ...parrafo(data.join(' · '), format),
    ...(ticket.before ? parrafo(`Antes: ${ticket.before}`, format, { negrita: true }) : []),
    ...(ticket.notaPedido
      ? parrafo(`NOTA DEL PEDIDO: ${ticket.notaPedido}`, format, {
          reversed: true,
          negrita: true,
        })
      : ticket.type === 'note'
        ? parrafo('SE QUITÓ LA NOTA DEL PEDIDO', format, { reversed: true, negrita: true })
        : []),
    { separator: true },
  ]

  const voidEntry = ticket.type === 'voidEntry'
  const conCurso = ticket.items.some((i) => i.course)
  for (const course of ORDEN_CURSO) {
    const items = ticket.items.filter((i) => i.course === course)
    if (items.length === 0) continue
    if (conCurso && course)
      lines.push(...parrafo(NOMBRE_CURSO[course].toUpperCase(), format, { negrita: true }))
    for (const item of items) lines.push(...lineasItem(item, format, voidEntry))
    lines.push({ separator: true })
  }

  const retenidos = ticket.retenidos ?? []
  if (retenidos.length > 0)
    lines.push(
      ...parrafo(
        `En espera: ${retenidos.map((c) => NOMBRE_CURSO[c]).join(', ')}. Sale cuando el mesero lo marche.`,
        format,
      ),
    )
  return lines
}

/**
 * Página de prueba: confirma que la impresora responde, que el ancho es el correcto (la regla
 * debe llenar justo una línea) y que la tabla de caracteres imprime las tildes.
 */
export function lineasPrueba(
  data: { printer: string; stations: string[]; time: string },
  format: { columnas: number; pagina: PaginaCodigos },
): Linea[] {
  const rule = '1234567890'.repeat(Math.ceil(format.columnas / 10)).slice(0, format.columnas)
  return [
    ...parrafo('PRUEBA DE IMPRESIÓN', format, { large: true, reversed: true, centro: true }),
    { space: true },
    ...parrafo(data.printer, format, { large: true }),
    ...parrafo(
      data.stations.length > 0
        ? `Imprime: ${data.stations.join(', ')}`
        : 'Todavía no imprime ninguna estación',
      format,
    ),
    ...parrafo(data.time, format),
    { separator: true },
    ...parrafo('La regla debe llenar una sola línea:', format),
    { text: rule },
    { space: true },
    ...parrafo('Tildes y eñes: ñ Ñ á é í ó ú Á É Í Ó Ú ü ¿¡', format, { negrita: true }),
    ...parrafo(
      'Si salen símbolos raros en vez de tildes, cambia la tabla de caracteres de esta impresora.',
      format,
    ),
    { separator: true },
    ...parrafo('Faro', format, { centro: true }),
  ]
}
