import { describe, expect, it } from 'vitest'
import { distancia, normalizar, search } from './busqueda'

const names = (elements: string[], busqueda: string) => search(elements, busqueda, (x) => x)

describe('búsqueda tolerante: bordes', () => {
  it('normalizar conserva la ñ y quita signos, tildes y espacios repetidos', () => {
    expect(normalizar('Piña Colada')).toBe('pina colada')
    expect(normalizar('¡Café—con  leche!')).toBe('cafe con leche')
    expect(normalizar('   ')).toBe('')
    expect(normalizar('')).toBe('')
  })

  it('distancia: iguales, vacías, borrado, inserción y cambio', () => {
    expect(distancia('', '')).toBe(0)
    expect(distancia('spritz', 'spritz')).toBe(0)
    expect(distancia('spritz', 'sprit')).toBe(1)
    expect(distancia('sprit', 'spritz')).toBe(1)
    expect(distancia('spritz', 'spritx')).toBe(1)
    expect(distancia('abc', '')).toBe(3)
  })

  it('la tolerancia crece con el largo: 3 letras exactas, 6 con un error, 7 con dos', () => {
    // 3 letras: sin errores
    expect(names(['Gin Tonic'], 'gon')).toEqual([])
    // 6 letras: un error vale, dos no
    expect(names(['Aperol Spritz'], 'aperal')).toEqual(['Aperol Spritz'])
    expect(names(['Aperol Spritz'], 'apxrxl')).toEqual([])
    // 7 letras: dos errores valen
    expect(names(['Limonada de Coco'], 'limunadu')).toEqual(['Limonada de Coco'])
  })

  it('el calce exacto va antes que el aproximado, y el empate respeta el orden de la carta', () => {
    const menu = ['Aperal casero', 'Aperol Spritz', 'Aperol Soda']
    expect(names(menu, 'aperol')).toEqual(['Aperol Spritz', 'Aperol Soda', 'Aperal casero'])
  })

  it('un producto con pocas letras iguales no aparece por azar', () => {
    expect(names(['Té Hatsu', 'Tagliata di Manzo'], 'xyz')).toEqual([])
  })

  it('palabras en cualquier orden y con tildes de la persona', () => {
    expect(names(['Tagliata di Manzo'], 'MANZÓ tagliata')).toEqual(['Tagliata di Manzo'])
  })

  it('una búsqueda con solo símbolos devuelve todo, como una vacía', () => {
    expect(names(['A', 'B'], '¡¡??')).toEqual(['A', 'B'])
  })

  it('no modifica la lista original', () => {
    const list = ['Pinsa', 'Aperol']
    names(list, 'ape')
    expect(list).toEqual(['Pinsa', 'Aperol'])
  })

  it('usa la función de texto, no el elemento: busca por nombre y categoría', () => {
    const products = [{ n: 'Spritz Burguer', c: 'Hamburguesas' }]
    expect(search(products, 'hamburgesa', (p) => `${p.n} ${p.c}`)).toEqual(products)
  })
})
