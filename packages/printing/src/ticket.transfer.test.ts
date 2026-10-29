import { describe, expect, it } from 'vitest'
import { asText, COLUMNS, type Ticket, ticketLines } from './index'

// The transfer ticket (task 1.5): CAMBIO DE MESA with the new table and «Antes: …».

const base: Ticket = {
  type: 'move',
  station: 'Cocina',
  number: 7,
  target: 'Mesa 5 + 6',
  order: 3,
  waiter: 'Ana',
  time: '8:42 p. m.',
  guests: 4,
  items: [{ quantity: 2, name: 'Tagliata', guest: null, course: null, options: [], notes: null }],
  before: 'Mesa 3',
}
const format = { columns: COLUMNS[80], page: 'pc850' as const }
const text = (c: Ticket) => asText(ticketLines(c, format), 48)

describe('transfer ticket', () => {
  it('has CAMBIO DE MESA, the new table with its number and the previous one', () => {
    const t = text(base)
    expect(t).toContain('CAMBIO DE MESA')
    expect(t).toMatch(/Mesa 5 \+ 6 +#7/i)
    expect(t).toContain('Antes: Mesa 3')
    expect(t).toContain('2 X TAGLIATA')
  })

  it('without «antes» it does not print that line', () => {
    expect(text({ ...base, before: null })).not.toContain('Antes:')
    expect(text({ ...base, before: undefined })).not.toContain('Antes:')
  })

  it('the other types do not show CAMBIO DE MESA', () => {
    for (const type of ['new', 'reprint', 'modification', 'void', 'note'] as const)
      expect(text({ ...base, type, before: null })).not.toContain('CAMBIO DE MESA')
  })

  it('also fits at 58 mm, with a long table name, without exceeding the width', () => {
    const longName = {
      ...base,
      target: 'Mesa Terraza Norte 12 + Terraza Norte 13',
      before: 'Mesa Barra Principal 1',
    }
    const l = ticketLines(longName, { columns: COLUMNS[58], page: 'pc850' })
    for (const line of asText(l, COLUMNS[58]).split('\n'))
      expect([...line].length).toBeLessThanOrEqual(COLUMNS[58] * 2)
    expect(asText(l, COLUMNS[58])).toContain('Antes:')
  })
})
