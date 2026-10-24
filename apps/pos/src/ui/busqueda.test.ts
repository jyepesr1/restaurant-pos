import { describe, expect, it } from 'vitest'
import { buscar, distancia, normalizar } from './busqueda'

const carta = [
  'Spritz Burguer',
  'Hamburguesa clásica',
  'Aperol Spritz',
  'Té Hatsu',
  'Limonada de Coco',
  'Tagliata di Manzo',
  'Quattro Formaggi',
]
const nombres = (busqueda: string) => buscar(carta, busqueda, (x) => x)

describe('búsqueda tolerante', () => {
  it('ignora tildes y mayúsculas', () => {
    expect(normalizar('  Té   HATSU! ')).toBe('te hatsu')
    expect(nombres('te')).toContain('Té Hatsu')
    expect(nombres('CLASICA')).toEqual(['Hamburguesa clásica'])
  })

  it('perdona errores de escritura comunes', () => {
    expect(nombres('hamburgesa')).toEqual(['Hamburguesa clásica'])
    expect(nombres('apreol')[0]).toBe('Aperol Spritz')
    expect(nombres('quatro formagi')).toEqual(['Quattro Formaggi'])
    expect(nombres('tagliatta')).toEqual(['Tagliata di Manzo'])
  })

  it('busca por el comienzo de cualquier palabra y exige todas las palabras', () => {
    expect(nombres('spritz')).toEqual(['Spritz Burguer', 'Aperol Spritz'])
    expect(nombres('coco lim')).toEqual(['Limonada de Coco'])
    expect(nombres('spritz coco')).toEqual([])
  })

  it('en palabras cortas no adivina: "tex" no es "te"', () => {
    expect(nombres('tex')).toEqual([])
  })

  it('sin búsqueda devuelve todo en su orden', () => {
    expect(nombres('  ')).toEqual(carta)
  })

  it('distancia de edición con letras vecinas intercambiadas', () => {
    expect(distancia('aperol', 'apreol')).toBe(1)
    expect(distancia('gato', 'pato')).toBe(1)
    expect(distancia('', 'abc')).toBe(3)
  })
})
