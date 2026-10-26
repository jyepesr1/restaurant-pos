import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  borradorDeGrupo,
  borradorDeProducto,
  cambiosDeGrupo,
  cambiosDeProducto,
  grupoNuevo,
  leerPesos,
  problemasDeGrupo,
  problemasDeProducto,
  productoNuevo,
  productosConGrupo,
} from './borradores'
import type { CatalogoEdicion } from './motor'

const reg = { version: 1, active: true }

function edicion(): CatalogoEdicion {
  const tax = newId()
  const category = newId()
  const vino = newId()
  const termino = newId()
  const tagliata = newId()
  return {
    version: 10,
    zones: [],
    tables: [],
    elements: [],
    taxes: [{ ...reg, id: tax, name: 'INC 8 %', type: 'inc', rate: 800 }],
    stations: [],
    categories: [{ ...reg, id: category, name: 'Vinos', position: 0, station_id: null }],
    products: [
      {
        ...reg,
        id: vino,
        category_id: category,
        name: 'Ramón Bilbao',
        description: null,
        price: 30_900,
        tax_id: tax,
        favorite: false,
      },
      {
        ...reg,
        id: tagliata,
        category_id: category,
        name: 'Tagliata',
        description: 'Solomito',
        price: 40_900,
        tax_id: tax,
        favorite: false,
      },
    ],
    variants: [
      { ...reg, id: newId(), product_id: vino, name: 'Botella', price: 129_900, position: 1 },
      { ...reg, id: newId(), product_id: vino, name: 'Copa', price: 30_900, position: 0 },
    ],
    groups: [{ ...reg, id: termino, name: 'Término', minimum: 1, maximum: 1 }],
    links: [{ ...reg, id: newId(), product_id: tagliata, group_id: termino, position: 0 }],
    modifiers: [
      { ...reg, id: newId(), group_id: termino, name: 'Medio', extra_price: 0, position: 1 },
      { ...reg, id: newId(), group_id: termino, name: 'Rojo', extra_price: 0, position: 0 },
    ],
  }
}

const idDe = (c: CatalogoEdicion, name: string) =>
  c.products.find((p) => p.name === name)?.id as string

describe('leerPesos', () => {
  it.each([
    ['40.900', 40_900],
    ['$ 40900', 40_900],
    ['40 900', 40_900],
    ['0', 0],
    ['100.000.000', 100_000_000],
  ])('%s → %d', (text, value) => expect(leerPesos(text)).toBe(value))

  it.each([
    '',
    '40,5',
    '-100',
    'abc',
    '100.000.001',
    '1e5',
    '1.5',
    '40.90',
    '4.09.00',
    '1.500,00',
    '1..500',
  ])('rechaza «%s»', (text) => expect(leerPesos(text)).toBeNull())
})

describe('producto', () => {
  it('sin tocar nada no hay cambios', () => {
    const c = edicion()
    for (const name of ['Ramón Bilbao', 'Tagliata'])
      expect(cambiosDeProducto(c, borradorDeProducto(c, idDe(c, name)))).toEqual([])
  })

  it('el borrador trae las variantes y los grupos en su orden', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    expect(b.variants.map((v) => v.name)).toEqual(['Copa', 'Botella'])
    expect(borradorDeProducto(c, idDe(c, 'Tagliata')).groups).toEqual([c.groups[0]?.id])
  })

  it('cambiar el precio de la botella solo cambia esa variante', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    const bottle = b.variants[1]
    if (!bottle) throw new Error('falta')
    bottle.price = 135_000
    expect(cambiosDeProducto(c, b)).toEqual([
      { entity: 'variants', id: bottle.id, data: { price: 135_000 } },
    ])
  })

  it('con variantes, el precio del producto es el de la más barata', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    const glass = b.variants[0]
    if (!glass) throw new Error('falta')
    glass.price = 28_000
    expect(cambiosDeProducto(c, b)).toEqual([
      { entity: 'products', id: b.id, data: { price: 28_000 } },
      { entity: 'variants', id: glass.id, data: { price: 28_000 } },
    ])
  })

  it('quitar una variante la archiva; una nueva lleva todos sus campos', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    const bottle = b.variants[1]
    if (!bottle) throw new Error('falta')
    bottle.active = false
    const media = {
      id: newId(),
      fresh: true,
      name: 'Media botella',
      price: 70_000,
      active: true,
    }
    b.variants.push(media)
    expect(cambiosDeProducto(c, b)).toEqual([
      { entity: 'variants', id: bottle.id, data: { active: false } },
      {
        entity: 'variants',
        id: media.id,
        data: {
          product_id: b.id,
          name: 'Media botella',
          price: 70_000,
          // Va después de la copa: la botella archivada no ocupa lugar.
          position: 1,
          active: true,
        },
      },
    ])
  })

  it('una variante nueva que se quitó antes de guardar no viaja', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Tagliata'))
    b.variants.push({ id: newId(), fresh: true, name: 'X', price: 1, active: false })
    expect(cambiosDeProducto(c, b)).toEqual([])
  })

  it('un producto nuevo lleva todos los campos, con la descripción vacía como null', () => {
    const c = edicion()
    const b = productoNuevo(c, c.categories[0]?.id as string)
    b.name = '  Pinsa  '
    b.price = 20_900
    expect(cambiosDeProducto(c, b)).toEqual([
      {
        entity: 'products',
        id: b.id,
        data: {
          category_id: b.categoriaId,
          name: 'Pinsa',
          description: null,
          price: 20_900,
          tax_id: c.taxes[0]?.id,
          favorite: false,
          active: true,
        },
      },
    ])
  })

  it('quitar un grupo archiva su enlace y volver a ponerlo lo reactiva, sin duplicarlo', () => {
    const c = edicion()
    const tagliata = idDe(c, 'Tagliata')
    const link = c.links[0]
    if (!link) throw new Error('falta')
    const b = borradorDeProducto(c, tagliata)
    b.groups = []
    expect(cambiosDeProducto(c, b)).toEqual([
      { entity: 'product_modifier_groups', id: link.id, data: { active: false } },
    ])
    link.active = false
    const another = borradorDeProducto(c, tagliata)
    another.groups = [link.group_id]
    expect(cambiosDeProducto(c, another)).toEqual([
      { entity: 'product_modifier_groups', id: link.id, data: { active: true } },
    ])
  })

  it('un grupo nuevo en un producto crea su enlace', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    b.groups = [c.groups[0]?.id as string]
    const [change] = cambiosDeProducto(c, b)
    expect(change).toMatchObject({
      entity: 'product_modifier_groups',
      data: { product_id: b.id, group_id: c.groups[0]?.id, position: 0, active: true },
    })
  })

  it('avisa lo que falta antes de guardar', () => {
    const c = edicion()
    const b = productoNuevo(c, '')
    b.variants = [
      { id: newId(), fresh: true, name: 'Copa', price: 1, active: true },
      { id: newId(), fresh: true, name: 'copa ', price: 2, active: true },
    ]
    b.groups = ['a', 'a']
    expect(problemasDeProducto(b)).toEqual([
      'Falta el nombre',
      'Falta la categoría',
      'Hay dos tamaños con el mismo nombre',
      'Un grupo de opciones está dos veces',
    ])
  })

  it('un producto nuevo sin tamaños pide el precio', () => {
    const c = edicion()
    const b = productoNuevo(c, c.categories[0]?.id as string)
    b.name = 'Pinsa'
    expect(problemasDeProducto(b)).toEqual(['Escribe el precio'])
    b.price = 20_900
    expect(problemasDeProducto(b)).toEqual([])
  })
})

describe('grupo de opciones', () => {
  it('sin tocar nada no hay cambios; el borrador trae las opciones en orden', () => {
    const c = edicion()
    const g = borradorDeGrupo(c, c.groups[0]?.id as string)
    expect(g.options.map((o) => o.name)).toEqual(['Rojo', 'Medio'])
    expect(cambiosDeGrupo(c, g)).toEqual([])
  })

  it('una opción con precio, el máximo y archivar una opción', () => {
    const c = edicion()
    const g = borradorDeGrupo(c, c.groups[0]?.id as string)
    const [rojo, method] = g.options
    if (!rojo || !method) throw new Error('falta')
    g.maximum = 2
    rojo.extraPrice = 2_000
    method.active = false
    expect(cambiosDeGrupo(c, g)).toEqual([
      { entity: 'modifier_groups', id: g.id, data: { maximum: 2 } },
      { entity: 'modifiers', id: rojo.id, data: { extra_price: 2_000 } },
      { entity: 'modifiers', id: method.id, data: { active: false } },
    ])
  })

  it('un grupo nuevo lleva todo', () => {
    const c = edicion()
    const g = grupoNuevo()
    g.name = 'Adicionales'
    g.maximum = 3
    g.options.push({
      id: newId(),
      fresh: true,
      name: 'Tocineta',
      extraPrice: 4_000,
      active: true,
    })
    expect(cambiosDeGrupo(c, g).map((x) => x.entity)).toEqual(['modifier_groups', 'modifiers'])
    expect(problemasDeGrupo(g)).toEqual([])
  })

  it('avisa lo que no cuadra', () => {
    const g = grupoNuevo()
    g.minimum = 2
    g.maximum = 1
    expect(problemasDeGrupo(g)).toEqual([
      'Falta el nombre',
      'Agrega al menos una opción',
      'El mínimo no puede pasar del máximo',
    ])
    g.maximum = 3
    g.options.push({ id: newId(), fresh: true, name: 'Uno', extraPrice: 0, active: true })
    expect(problemasDeGrupo(g)).toContain('El mínimo (2) es mayor que las opciones que hay (1)')
  })

  it('cuenta los productos activos que lo usan', () => {
    const c = edicion()
    const group = c.groups[0]?.id as string
    expect(productosConGrupo(c, group)).toBe(1)
    const tagliata = c.products.find((p) => p.name === 'Tagliata')
    if (tagliata) tagliata.active = false
    expect(productosConGrupo(c, group)).toBe(0)
  })
})
