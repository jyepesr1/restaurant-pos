import { describe, expect, it } from 'vitest'
import { convertMenu, DONENESS, rulesWithoutDish, WITH_FLAVOR } from './menu'

// The conversion with data already read from the YAML. The tests with the pilot's real menu are in
// apps/hub/src/seed.

const dish = (name: string, price: number, extra: object = {}) => ({
  nombre: { es: name },
  precio: price,
  ...extra,
})
const section = (key: string, group: 'comida' | 'barra', dishes: object[], extra = {}) => ({
  clave: key,
  nombre: key,
  grupo: group,
  boton: { es: ` ${key} ` },
  platos: dishes,
  ...extra,
})

describe('convert the menu', () => {
  it('glass and bottle are merged; the description and price come from the variants', () => {
    const [wines] = convertMenu({
      secciones: [
        section('VINI', 'barra', [
          dish('Malbec Botella', 120_000, { descripcion: { es: 'Mendoza' } }),
          dish('Malbec Copa', 28_000),
          dish('Botella Rosé', 90_000),
        ]),
      ],
    })
    expect(wines).toMatchObject({ name: 'VINI', station: 'barra', photo: null })
    expect(wines?.products).toEqual([
      {
        key: 'VINI:malbec',
        name: 'Malbec',
        description: 'Mendoza',
        price: 28_000,
        variants: [
          { name: 'Copa', price: 28_000 },
          { name: 'Botella', price: 120_000 },
        ],
        groups: [],
      },
      {
        key: 'VINI:botella-rose',
        name: 'Botella Rosé',
        description: null,
        price: 90_000,
        variants: [],
        groups: [],
      },
    ])
  })

  it('flavor required by list, doneness by section or dish; unavailable items are left out', () => {
    const categories = convertMenu({
      secciones: [
        section('HAMBURGUESAS', 'comida', [
          dish('Clásica', 30_000),
          dish('Vegana', 30_000, { disponible: false }),
        ]),
        section('BEBIDAS', 'barra', [
          dish(WITH_FLAVOR[0] as string, 13_900, { descripcion: { es: 'Rojo / Verde' } }),
        ]),
      ],
    })
    const [burgers, drinks] = categories
    expect(burgers?.products.map((p) => p.name)).toEqual(['Clásica'])
    expect(burgers?.products[0]?.groups).toEqual([DONENESS])
    expect(drinks?.products[0]).toMatchObject({
      description: null,
      groups: [
        {
          name: 'Sabor',
          minimum: 1,
          maximum: 1,
          options: [{ name: 'Rojo' }, { name: 'Verde' }],
        },
      ],
    })
    expect(rulesWithoutDish(categories)).toEqual(['Tagliata di Manzo', 'Soda Hatsu'])
  })

  it('rejects what does not fit', () => {
    const makeOne = (extra: object) => ({
      secciones: [section('A', 'comida', [dish('X', 1)], extra)],
    })
    expect(() => convertMenu({ secciones: [] })).toThrow()
    expect(() => convertMenu(makeOne({ clave: 'A B' }))).toThrow()
    expect(() =>
      convertMenu({
        secciones: [section('A', 'comida', []), section('A', 'barra', [], { visible: false })],
      }),
    ).toThrow(/repetida/)
    expect(() => convertMenu({ secciones: [section('A', 'comida', [dish('X', 1.5)])] })).toThrow()
    expect(() =>
      convertMenu({ secciones: [section('A', 'comida', [dish('X', 1), dish('x', 2)])] }),
    ).toThrow(/repetido/)
    const flavor = (description: string) => ({
      secciones: [
        section('B', 'barra', [
          dish(WITH_FLAVOR[0] as string, 1, { descripcion: { es: description } }),
        ]),
      ],
    })
    expect(() => convertMenu(flavor('Rojo'))).toThrow(/sabores/)
    expect(() => convertMenu(flavor('Rojo/rojo'))).toThrow(/repite/)
  })

  it('hidden sections are left out and the order stays consecutive', () => {
    const categories = convertMenu({
      secciones: [
        section('A', 'comida', []),
        section('B', 'comida', [], { visible: false }),
        section('C', 'barra', [], { foto: 'images/c.jpg' }),
      ],
    })
    expect(categories.map((c) => [c.key, c.position, c.photo])).toEqual([
      ['A', 0, null],
      ['C', 1, 'images/c.jpg'],
    ])
  })
})
