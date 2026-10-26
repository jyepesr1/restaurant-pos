import { describe, expect, it } from 'vitest'
import { COLUMNAS, type Comanda, comoTexto, lineasComanda } from './index'

// La comanda de traslado (tarea 1.5): CAMBIO DE MESA con la mesa nueva y «Antes: …».

const base: Comanda = {
  type: 'move',
  station: 'Cocina',
  numero: 7,
  target: 'Mesa 5 + 6',
  order: 3,
  waiter: 'Ana',
  time: '8:42 p. m.',
  guests: 4,
  items: [{ quantity: 2, name: 'Tagliata', guest: null, course: null, options: [], notes: null }],
  before: 'Mesa 3',
}
const format = { columnas: COLUMNAS[80], pagina: 'pc850' as const }
const text = (c: Comanda) => comoTexto(lineasComanda(c, format), 48)

describe('comanda de traslado', () => {
  it('lleva CAMBIO DE MESA, la mesa nueva con su número y la de antes', () => {
    const t = text(base)
    expect(t).toContain('CAMBIO DE MESA')
    expect(t).toMatch(/Mesa 5 \+ 6 +#7/i)
    expect(t).toContain('Antes: Mesa 3')
    expect(t).toContain('2 X TAGLIATA')
  })

  it('sin «antes» no imprime esa línea', () => {
    expect(text({ ...base, before: null })).not.toContain('Antes:')
    expect(text({ ...base, before: undefined })).not.toContain('Antes:')
  })

  it('los demás tipos no muestran CAMBIO DE MESA', () => {
    for (const type of ['newOne', 'reprinting', 'modification', 'voidEntry', 'note'] as const)
      expect(text({ ...base, type, before: null })).not.toContain('CAMBIO DE MESA')
  })

  it('también cabe en 58 mm, con una mesa de nombre largo, sin pasarse del ancho', () => {
    const length = {
      ...base,
      target: 'Mesa Terraza Norte 12 + Terraza Norte 13',
      before: 'Mesa Barra Principal 1',
    }
    const l = lineasComanda(length, { columnas: COLUMNAS[58], pagina: 'pc850' })
    for (const line of comoTexto(l, COLUMNAS[58]).split('\n'))
      expect([...line].length).toBeLessThanOrEqual(COLUMNAS[58] * 2)
    expect(comoTexto(l, COLUMNAS[58])).toContain('Antes:')
  })
})
