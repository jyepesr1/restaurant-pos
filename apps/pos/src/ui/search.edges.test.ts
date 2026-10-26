import { describe, expect, it } from 'vitest'
import { distance, normalize, search } from './search'

const names = (elements: string[], searchQuery: string) => search(elements, searchQuery, (x) => x)

describe('fuzzy search: edge cases', () => {
  it('normalize keeps the ñ and removes punctuation, accents and repeated spaces', () => {
    expect(normalize('Piña Colada')).toBe('pina colada')
    expect(normalize('¡Café—con  leche!')).toBe('cafe con leche')
    expect(normalize('   ')).toBe('')
    expect(normalize('')).toBe('')
  })

  it('distance: equal, empty, deletion, insertion and substitution', () => {
    expect(distance('', '')).toBe(0)
    expect(distance('spritz', 'spritz')).toBe(0)
    expect(distance('spritz', 'sprit')).toBe(1)
    expect(distance('sprit', 'spritz')).toBe(1)
    expect(distance('spritz', 'spritx')).toBe(1)
    expect(distance('abc', '')).toBe(3)
  })

  it('tolerance grows with length: 3 letters exact, 6 with one error, 7 with two', () => {
    // 3 letters: no errors
    expect(names(['Gin Tonic'], 'gon')).toEqual([])
    // 6 letters: one error is fine, two are not
    expect(names(['Aperol Spritz'], 'aperal')).toEqual(['Aperol Spritz'])
    expect(names(['Aperol Spritz'], 'apxrxl')).toEqual([])
    // 7 letters: two errors are fine
    expect(names(['Limonada de Coco'], 'limunadu')).toEqual(['Limonada de Coco'])
  })

  it('the exact match goes before the approximate one, and a tie keeps the menu order', () => {
    const menu = ['Aperal casero', 'Aperol Spritz', 'Aperol Soda']
    expect(names(menu, 'aperol')).toEqual(['Aperol Spritz', 'Aperol Soda', 'Aperal casero'])
  })

  it('a product with few matching letters does not show up by chance', () => {
    expect(names(['Té Hatsu', 'Tagliata di Manzo'], 'xyz')).toEqual([])
  })

  it('words in any order and with accents typed by the person', () => {
    expect(names(['Tagliata di Manzo'], 'MANZÓ tagliata')).toEqual(['Tagliata di Manzo'])
  })

  it('a search with only symbols returns everything, like an empty one', () => {
    expect(names(['A', 'B'], '¡¡??')).toEqual(['A', 'B'])
  })

  it('does not modify the original list', () => {
    const list = ['Pinsa', 'Aperol']
    names(list, 'ape')
    expect(list).toEqual(['Pinsa', 'Aperol'])
  })

  it('uses the text function, not the element: searches by name and category', () => {
    const products = [{ n: 'Spritz Burguer', c: 'Hamburguesas' }]
    expect(search(products, 'hamburgesa', (p) => `${p.n} ${p.c}`)).toEqual(products)
  })
})
