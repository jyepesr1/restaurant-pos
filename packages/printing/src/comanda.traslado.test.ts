import { describe, expect, it } from 'vitest'
import { COLUMNAS, type Comanda, comoTexto, lineasComanda } from './index'

// La comanda de traslado (tarea 1.5): CAMBIO DE MESA con la mesa nueva y «Antes: …».

const base: Comanda = {
  tipo: 'traslado',
  estacion: 'Cocina',
  numero: 7,
  destino: 'Mesa 5 + 6',
  pedido: 3,
  mesero: 'Ana',
  hora: '8:42 p. m.',
  comensales: 4,
  items: [
    { cantidad: 2, nombre: 'Tagliata', comensal: null, curso: null, opciones: [], notas: null },
  ],
  antes: 'Mesa 3',
}
const formato = { columnas: COLUMNAS[80], pagina: 'pc850' as const }
const texto = (c: Comanda) => comoTexto(lineasComanda(c, formato), 48)

describe('comanda de traslado', () => {
  it('lleva CAMBIO DE MESA, la mesa nueva con su número y la de antes', () => {
    const t = texto(base)
    expect(t).toContain('CAMBIO DE MESA')
    expect(t).toMatch(/Mesa 5 \+ 6 +#7/i)
    expect(t).toContain('Antes: Mesa 3')
    expect(t).toContain('2 X TAGLIATA')
  })

  it('sin «antes» no imprime esa línea', () => {
    expect(texto({ ...base, antes: null })).not.toContain('Antes:')
    expect(texto({ ...base, antes: undefined })).not.toContain('Antes:')
  })

  it('los demás tipos no muestran CAMBIO DE MESA', () => {
    for (const tipo of ['nueva', 'reimpresion', 'modificacion', 'anulacion', 'nota'] as const)
      expect(texto({ ...base, tipo, antes: null })).not.toContain('CAMBIO DE MESA')
  })

  it('también cabe en 58 mm, con una mesa de nombre largo, sin pasarse del ancho', () => {
    const largo = {
      ...base,
      destino: 'Mesa Terraza Norte 12 + Terraza Norte 13',
      antes: 'Mesa Barra Principal 1',
    }
    const l = lineasComanda(largo, { columnas: COLUMNAS[58], pagina: 'pc850' })
    for (const linea of comoTexto(l, COLUMNAS[58]).split('\n'))
      expect([...linea].length).toBeLessThanOrEqual(COLUMNAS[58] * 2)
    expect(comoTexto(l, COLUMNAS[58])).toContain('Antes:')
  })
})
