import { type Format, type Line, paragraph, toSides } from './document'
import type { CodePage } from './encoding'

// What a ticket contains and how it looks on paper (ADR-015). The hub builds `Ticket` with the data
// already resolved (table, waiter and station names, the time in the restaurant's time zone): this
// only decides order and style.

/** `note`: the whole-order note changed with dishes already in the kitchen (allergies: keep it). */
export type TicketType =
  | 'new'
  | 'reprint'
  | 'modification'
  | 'void'
  | 'note'
  /** Dishes already in the kitchen moved to another table: the kitchen must take them there. */
  | 'move'
export type TicketCourse = 'starter' | 'main' | 'dessert'

export interface TicketItem {
  quantity: number
  name: string
  guest: number | null
  course: TicketCourse | null
  /** Chosen options (doneness, no onion, add-ons): they are highlighted. */
  options: string[]
  notes: string | null
}

export interface Ticket {
  type: TicketType
  /** «Cocina», «Barra»… */
  station: string
  /** Number of the day; a reprint and a void carry the original ticket's number. */
  number: number | null
  /** «Mesa 6», «Para llevar», «Domicilio», «Barra». */
  target: string
  /** Order number of the day. */
  order: number | null
  waiter: string
  /** Already formatted in the restaurant's time zone («8:42 p. m.»). */
  time: string
  guests: number | null
  items: TicketItem[]
  /** Courses still held in the order: the kitchen knows they come later. */
  heldCourses?: TicketCourse[]
  /** The whole-order note («alérgico al maní»): printed at the top, highlighted. */
  orderNote?: string | null
  /** On a table change, where it was before («Mesa 5»). */
  before?: string | null
}

const TITLE: Record<TicketType, string | null> = {
  new: null,
  reprint: 'REIMPRESIÓN',
  modification: 'CAMBIO',
  void: 'ANULAR',
  note: 'NOTA NUEVA',
  move: 'CAMBIO DE MESA',
}

const COURSE_NAME: Record<TicketCourse, string> = {
  starter: 'Entrada',
  main: 'Fuerte',
  dessert: 'Postre',
}

const COURSE_ORDER: (TicketCourse | null)[] = [null, 'starter', 'main', 'dessert']

function itemLines(item: TicketItem, format: Format, isVoid: boolean): Line[] {
  const person = item.guest ? `  P${item.guest}` : ''
  const lines: Line[] = toSides(
    `${isVoid ? '-' : ''}${item.quantity} x ${item.name}`,
    person.trim(),
    format,
    { large: true },
  )
  for (const option of item.options) lines.push(...paragraph(`> ${option}`, format, { bold: true }))
  if (item.notes) lines.push(...paragraph(`NOTA: ${item.notes}`, format, { reversed: true }))
  return lines
}

/** The ticket split into lines for a printer of that width and that code page. */
export function ticketLines(ticket: Ticket, format: { columns: number; page: CodePage }): Line[] {
  const title = TITLE[ticket.type]
  const heading = title ? `${title} · ${ticket.station}` : ticket.station
  const data = [
    ticket.order ? `Pedido ${ticket.order}` : null,
    ticket.waiter,
    ticket.time,
    ticket.guests ? `${ticket.guests} pers.` : null,
  ].filter((d): d is string => !!d)

  const lines: Line[] = [
    ...paragraph(heading.toUpperCase(), format, { large: true, reversed: true, center: true }),
    { space: true },
    ...toSides(ticket.target, ticket.number ? `#${ticket.number}` : '', format, {
      large: true,
    }),
    ...paragraph(data.join(' · '), format),
    ...(ticket.before ? paragraph(`Antes: ${ticket.before}`, format, { bold: true }) : []),
    ...(ticket.orderNote
      ? paragraph(`NOTA DEL PEDIDO: ${ticket.orderNote}`, format, {
          reversed: true,
          bold: true,
        })
      : ticket.type === 'note'
        ? paragraph('SE QUITÓ LA NOTA DEL PEDIDO', format, { reversed: true, bold: true })
        : []),
    { separator: true },
  ]

  const isVoid = ticket.type === 'void'
  const withCourse = ticket.items.some((i) => i.course)
  for (const course of COURSE_ORDER) {
    const items = ticket.items.filter((i) => i.course === course)
    if (items.length === 0) continue
    if (withCourse && course)
      lines.push(...paragraph(COURSE_NAME[course].toUpperCase(), format, { bold: true }))
    for (const item of items) lines.push(...itemLines(item, format, isVoid))
    lines.push({ separator: true })
  }

  const heldCourses = ticket.heldCourses ?? []
  if (heldCourses.length > 0)
    lines.push(
      ...paragraph(
        `En espera: ${heldCourses.map((c) => COURSE_NAME[c]).join(', ')}. Sale cuando el mesero lo marche.`,
        format,
      ),
    )
  return lines
}

/**
 * Test page: confirms the printer responds, the width is right (the ruler must fill exactly one
 * line) and the code page prints the accents.
 */
export function testLines(
  data: { printer: string; stations: string[]; time: string },
  format: { columns: number; page: CodePage },
): Line[] {
  const rule = '1234567890'.repeat(Math.ceil(format.columns / 10)).slice(0, format.columns)
  return [
    ...paragraph('PRUEBA DE IMPRESIÓN', format, { large: true, reversed: true, center: true }),
    { space: true },
    ...paragraph(data.printer, format, { large: true }),
    ...paragraph(
      data.stations.length > 0
        ? `Imprime: ${data.stations.join(', ')}`
        : 'Todavía no imprime ninguna estación',
      format,
    ),
    ...paragraph(data.time, format),
    { separator: true },
    ...paragraph('La regla debe llenar una sola línea:', format),
    { text: rule },
    { space: true },
    ...paragraph('Tildes y eñes: ñ Ñ á é í ó ú Á É Í Ó Ú ü ¿¡', format, { bold: true }),
    ...paragraph(
      'Si salen símbolos raros en vez de tildes, cambia la tabla de caracteres de esta impresora.',
      format,
    ),
    { separator: true },
    ...paragraph('Faro', format, { center: true }),
  ]
}
