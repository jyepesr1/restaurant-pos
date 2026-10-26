import { describe, expect, it } from 'vitest'
import { distancia, normalizar, search } from './busqueda'

const menu = [
  'Spritz Burguer',
  'Hamburguesa clásica',
  'Aperol Spritz',
  'Té Hatsu',
  'Limonada de Coco',
  'Tagliata di Manzo',
  'Quattro Formaggi',
]
const names = (busqueda: string) => search(menu, busqueda, (x) => x)

describe('búsqueda tolerante', () => {
  it('ignora tildes y mayúsculas', () => {
    expect(normalizar('  Té   HATSU! ')).toBe('te hatsu')
    expect(names('te')).toContain('Té Hatsu')
    expect(names('CLASICA')).toEqual(['Hamburguesa clásica'])
  })

  it('perdona errores de escritura comunes', () => {
    expect(names('hamburgesa')).toEqual(['Hamburguesa clásica'])
    expect(names('apreol')[0]).toBe('Aperol Spritz')
    expect(names('quatro formagi')).toEqual(['Quattro Formaggi'])
    expect(names('tagliatta')).toEqual(['Tagliata di Manzo'])
  })

  it('busca por el comienzo de cualquier palabra y exige todas las palabras', () => {
    expect(names('spritz')).toEqual(['Spritz Burguer', 'Aperol Spritz'])
    expect(names('coco lim')).toEqual(['Limonada de Coco'])
    expect(names('spritz coco')).toEqual([])
  })

  it('en palabras cortas no adivina: "tex" no es "te"', () => {
    expect(names('tex')).toEqual([])
  })

  it('sin búsqueda devuelve todo en su orden', () => {
    expect(names('  ')).toEqual(menu)
  })

  it('distancia de edición con letras vecinas intercambiadas', () => {
    expect(distancia('aperol', 'apreol')).toBe(1)
    expect(distancia('gato', 'pato')).toBe(1)
    expect(distancia('', 'abc')).toBe(3)
  })
})
