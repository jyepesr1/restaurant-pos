import { describe, expect, it } from 'vitest'
import { CON_SABOR, convertirCarta, reglasSinPlato, TERMINO } from './carta'

// La conversión con datos ya leídos del YAML. Las pruebas con la carta real del piloto están en
// apps/hub/src/seed.

const plato = (nombre: string, precio: number, extra: object = {}) => ({
  nombre: { es: nombre },
  precio,
  ...extra,
})
const seccion = (clave: string, grupo: 'comida' | 'barra', platos: object[], extra = {}) => ({
  clave,
  nombre: clave,
  grupo,
  boton: { es: ` ${clave} ` },
  platos,
  ...extra,
})

describe('convertir la carta', () => {
  it('copa y botella se juntan; la descripción y el precio vienen de las variantes', () => {
    const [vinos] = convertirCarta({
      secciones: [
        seccion('VINI', 'barra', [
          plato('Malbec Botella', 120_000, { descripcion: { es: 'Mendoza' } }),
          plato('Malbec Copa', 28_000),
          plato('Botella Rosé', 90_000),
        ]),
      ],
    })
    expect(vinos).toMatchObject({ nombre: 'VINI', estacion: 'barra', foto: null })
    expect(vinos?.productos).toEqual([
      {
        clave: 'VINI:malbec',
        nombre: 'Malbec',
        descripcion: 'Mendoza',
        precio: 28_000,
        variantes: [
          { nombre: 'Copa', precio: 28_000 },
          { nombre: 'Botella', precio: 120_000 },
        ],
        grupos: [],
      },
      {
        clave: 'VINI:botella-rose',
        nombre: 'Botella Rosé',
        descripcion: null,
        precio: 90_000,
        variantes: [],
        grupos: [],
      },
    ])
  })

  it('sabor obligatorio por lista, término por sección o plato; lo no disponible no entra', () => {
    const categorias = convertirCarta({
      secciones: [
        seccion('HAMBURGUESAS', 'comida', [
          plato('Clásica', 30_000),
          plato('Vegana', 30_000, { disponible: false }),
        ]),
        seccion('BEBIDAS', 'barra', [
          plato(CON_SABOR[0] as string, 13_900, { descripcion: { es: 'Rojo / Verde' } }),
        ]),
      ],
    })
    const [hamburguesas, bebidas] = categorias
    expect(hamburguesas?.productos.map((p) => p.nombre)).toEqual(['Clásica'])
    expect(hamburguesas?.productos[0]?.grupos).toEqual([TERMINO])
    expect(bebidas?.productos[0]).toMatchObject({
      descripcion: null,
      grupos: [
        {
          nombre: 'Sabor',
          minimo: 1,
          maximo: 1,
          opciones: [{ nombre: 'Rojo' }, { nombre: 'Verde' }],
        },
      ],
    })
    expect(reglasSinPlato(categorias)).toEqual(['Tagliata di Manzo', 'Soda Hatsu'])
  })

  it('rechaza lo que no cuadra', () => {
    const una = (extra: object) => ({ secciones: [seccion('A', 'comida', [plato('X', 1)], extra)] })
    expect(() => convertirCarta({ secciones: [] })).toThrow()
    expect(() => convertirCarta(una({ clave: 'A B' }))).toThrow()
    expect(() =>
      convertirCarta({
        secciones: [seccion('A', 'comida', []), seccion('A', 'barra', [], { visible: false })],
      }),
    ).toThrow(/repetida/)
    expect(() =>
      convertirCarta({ secciones: [seccion('A', 'comida', [plato('X', 1.5)])] }),
    ).toThrow()
    expect(() =>
      convertirCarta({ secciones: [seccion('A', 'comida', [plato('X', 1), plato('x', 2)])] }),
    ).toThrow(/repetido/)
    const sabor = (descripcion: string) => ({
      secciones: [
        seccion('B', 'barra', [
          plato(CON_SABOR[0] as string, 1, { descripcion: { es: descripcion } }),
        ]),
      ],
    })
    expect(() => convertirCarta(sabor('Rojo'))).toThrow(/sabores/)
    expect(() => convertirCarta(sabor('Rojo/rojo'))).toThrow(/repite/)
  })

  it('las secciones invisibles no entran y el orden queda seguido', () => {
    const categorias = convertirCarta({
      secciones: [
        seccion('A', 'comida', []),
        seccion('B', 'comida', [], { visible: false }),
        seccion('C', 'barra', [], { foto: 'images/c.jpg' }),
      ],
    })
    expect(categorias.map((c) => [c.clave, c.orden, c.foto])).toEqual([
      ['A', 0, null],
      ['C', 1, 'images/c.jpg'],
    ])
  })
})
