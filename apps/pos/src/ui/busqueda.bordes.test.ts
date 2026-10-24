import { describe, expect, it } from 'vitest'
import { buscar, distancia, normalizar } from './busqueda'

const nombres = (elementos: string[], busqueda: string) => buscar(elementos, busqueda, (x) => x)

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
    expect(nombres(['Gin Tonic'], 'gon')).toEqual([])
    // 6 letras: un error vale, dos no
    expect(nombres(['Aperol Spritz'], 'aperal')).toEqual(['Aperol Spritz'])
    expect(nombres(['Aperol Spritz'], 'apxrxl')).toEqual([])
    // 7 letras: dos errores valen
    expect(nombres(['Limonada de Coco'], 'limunadu')).toEqual(['Limonada de Coco'])
  })

  it('el calce exacto va antes que el aproximado, y el empate respeta el orden de la carta', () => {
    const carta = ['Aperal casero', 'Aperol Spritz', 'Aperol Soda']
    expect(nombres(carta, 'aperol')).toEqual(['Aperol Spritz', 'Aperol Soda', 'Aperal casero'])
  })

  it('un producto con pocas letras iguales no aparece por azar', () => {
    expect(nombres(['Té Hatsu', 'Tagliata di Manzo'], 'xyz')).toEqual([])
  })

  it('palabras en cualquier orden y con tildes de la persona', () => {
    expect(nombres(['Tagliata di Manzo'], 'MANZÓ tagliata')).toEqual(['Tagliata di Manzo'])
  })

  it('una búsqueda con solo símbolos devuelve todo, como una vacía', () => {
    expect(nombres(['A', 'B'], '¡¡??')).toEqual(['A', 'B'])
  })

  it('no modifica la lista original', () => {
    const lista = ['Pinsa', 'Aperol']
    nombres(lista, 'ape')
    expect(lista).toEqual(['Pinsa', 'Aperol'])
  })

  it('usa la función de texto, no el elemento: busca por nombre y categoría', () => {
    const productos = [{ n: 'Spritz Burguer', c: 'Hamburguesas' }]
    expect(buscar(productos, 'hamburgesa', (p) => `${p.n} ${p.c}`)).toEqual(productos)
  })
})
