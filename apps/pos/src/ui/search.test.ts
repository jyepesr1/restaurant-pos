import { describe, expect, it } from 'vitest'
import { distance, normalize, search } from './search'

const menu = [
  'Spritz Burguer',
  'Hamburguesa clásica',
  'Aperol Spritz',
  'Té Hatsu',
  'Limonada de Coco',
  'Tagliata di Manzo',
  'Quattro Formaggi',
]
const names = (searchQuery: string) => search(menu, searchQuery, (x) => x)

describe('fuzzy search', () => {
  it('ignores accents and uppercase', () => {
    expect(normalize('  Té   HATSU! ')).toBe('te hatsu')
    expect(names('te')).toContain('Té Hatsu')
    expect(names('CLASICA')).toEqual(['Hamburguesa clásica'])
  })

  it('forgives common typos', () => {
    expect(names('hamburgesa')).toEqual(['Hamburguesa clásica'])
    expect(names('apreol')[0]).toBe('Aperol Spritz')
    expect(names('quatro formagi')).toEqual(['Quattro Formaggi'])
    expect(names('tagliatta')).toEqual(['Tagliata di Manzo'])
  })

  it('searches by the start of any word and requires all the words', () => {
    expect(names('spritz')).toEqual(['Spritz Burguer', 'Aperol Spritz'])
    expect(names('coco lim')).toEqual(['Limonada de Coco'])
    expect(names('spritz coco')).toEqual([])
  })

  it('in short words it does not guess: "tex" is not "te"', () => {
    expect(names('tex')).toEqual([])
  })

  it('without a search it returns everything in its order', () => {
    expect(names('  ')).toEqual(menu)
  })

  it('edit distance with swapped adjacent letters', () => {
    expect(distance('aperol', 'apreol')).toBe(1)
    expect(distance('gato', 'pato')).toBe(1)
    expect(distance('', 'abc')).toBe(3)
  })
})
