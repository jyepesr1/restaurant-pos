import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  groupChanges,
  groupDraft,
  groupIssues,
  newGroup,
  newProduct,
  productChanges,
  productDraft,
  productIssues,
  productsWithGroup,
  readPesos,
} from './drafts'
import type { EditableCatalog } from './engine'

const reg = { version: 1, active: true }

function editView(): EditableCatalog {
  const tax = newId()
  const category = newId()
  const wine = newId()
  const doneness = newId()
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
        id: wine,
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
      { ...reg, id: newId(), product_id: wine, name: 'Botella', price: 129_900, position: 1 },
      { ...reg, id: newId(), product_id: wine, name: 'Copa', price: 30_900, position: 0 },
    ],
    groups: [{ ...reg, id: doneness, name: 'Término', minimum: 1, maximum: 1 }],
    links: [{ ...reg, id: newId(), product_id: tagliata, group_id: doneness, position: 0 }],
    modifiers: [
      { ...reg, id: newId(), group_id: doneness, name: 'Medio', extra_price: 0, position: 1 },
      { ...reg, id: newId(), group_id: doneness, name: 'Rojo', extra_price: 0, position: 0 },
    ],
  }
}

const idOf = (c: EditableCatalog, name: string) =>
  c.products.find((p) => p.name === name)?.id as string

describe('readPesos', () => {
  it.each([
    ['40.900', 40_900],
    ['$ 40900', 40_900],
    ['40 900', 40_900],
    ['0', 0],
    ['100.000.000', 100_000_000],
  ])('%s → %d', (text, value) => expect(readPesos(text)).toBe(value))

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
  ])('rejects «%s»', (text) => expect(readPesos(text)).toBeNull())
})

describe('product', () => {
  it('without touching anything there are no changes', () => {
    const c = editView()
    for (const name of ['Ramón Bilbao', 'Tagliata'])
      expect(productChanges(c, productDraft(c, idOf(c, name)))).toEqual([])
  })

  it('the draft brings the variants and the groups in their order', () => {
    const c = editView()
    const b = productDraft(c, idOf(c, 'Ramón Bilbao'))
    expect(b.variants.map((v) => v.name)).toEqual(['Copa', 'Botella'])
    expect(productDraft(c, idOf(c, 'Tagliata')).groups).toEqual([c.groups[0]?.id])
  })

  it("changing the bottle's price only changes that variant", () => {
    const c = editView()
    const b = productDraft(c, idOf(c, 'Ramón Bilbao'))
    const bottle = b.variants[1]
    if (!bottle) throw new Error('missing')
    bottle.price = 135_000
    expect(productChanges(c, b)).toEqual([
      { entity: 'variants', id: bottle.id, data: { price: 135_000 } },
    ])
  })

  it("with variants, the product's price is the cheapest one's", () => {
    const c = editView()
    const b = productDraft(c, idOf(c, 'Ramón Bilbao'))
    const glass = b.variants[0]
    if (!glass) throw new Error('missing')
    glass.price = 28_000
    expect(productChanges(c, b)).toEqual([
      { entity: 'products', id: b.id, data: { price: 28_000 } },
      { entity: 'variants', id: glass.id, data: { price: 28_000 } },
    ])
  })

  it('removing a variant archives it; a new one carries all its fields', () => {
    const c = editView()
    const b = productDraft(c, idOf(c, 'Ramón Bilbao'))
    const bottle = b.variants[1]
    if (!bottle) throw new Error('missing')
    bottle.active = false
    const media = {
      id: newId(),
      fresh: true,
      name: 'Media botella',
      price: 70_000,
      active: true,
    }
    b.variants.push(media)
    expect(productChanges(c, b)).toEqual([
      { entity: 'variants', id: bottle.id, data: { active: false } },
      {
        entity: 'variants',
        id: media.id,
        data: {
          product_id: b.id,
          name: 'Media botella',
          price: 70_000,
          // It goes after the glass: the archived bottle does not take up a place.
          position: 1,
          active: true,
        },
      },
    ])
  })

  it('a new variant removed before saving is not sent', () => {
    const c = editView()
    const b = productDraft(c, idOf(c, 'Tagliata'))
    b.variants.push({ id: newId(), fresh: true, name: 'X', price: 1, active: false })
    expect(productChanges(c, b)).toEqual([])
  })

  it('a new product carries all the fields, with the empty description as null', () => {
    const c = editView()
    const b = newProduct(c, c.categories[0]?.id as string)
    b.name = '  Pinsa  '
    b.price = 20_900
    expect(productChanges(c, b)).toEqual([
      {
        entity: 'products',
        id: b.id,
        data: {
          category_id: b.categoryId,
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

  it('removing a group archives its link and adding it back reactivates it, without duplicating it', () => {
    const c = editView()
    const tagliata = idOf(c, 'Tagliata')
    const link = c.links[0]
    if (!link) throw new Error('missing')
    const b = productDraft(c, tagliata)
    b.groups = []
    expect(productChanges(c, b)).toEqual([
      { entity: 'product_modifier_groups', id: link.id, data: { active: false } },
    ])
    link.active = false
    const another = productDraft(c, tagliata)
    another.groups = [link.group_id]
    expect(productChanges(c, another)).toEqual([
      { entity: 'product_modifier_groups', id: link.id, data: { active: true } },
    ])
  })

  it('a new group on a product creates its link', () => {
    const c = editView()
    const b = productDraft(c, idOf(c, 'Ramón Bilbao'))
    b.groups = [c.groups[0]?.id as string]
    const [change] = productChanges(c, b)
    expect(change).toMatchObject({
      entity: 'product_modifier_groups',
      data: { product_id: b.id, group_id: c.groups[0]?.id, position: 0, active: true },
    })
  })

  it('warns about what is missing before saving', () => {
    const c = editView()
    const b = newProduct(c, '')
    b.variants = [
      { id: newId(), fresh: true, name: 'Copa', price: 1, active: true },
      { id: newId(), fresh: true, name: 'copa ', price: 2, active: true },
    ]
    b.groups = ['a', 'a']
    expect(productIssues(b)).toEqual([
      'Falta el nombre',
      'Falta la categoría',
      'Hay dos tamaños con el mismo nombre',
      'Un grupo de opciones está dos veces',
    ])
  })

  it('a new product without sizes asks for the price', () => {
    const c = editView()
    const b = newProduct(c, c.categories[0]?.id as string)
    b.name = 'Pinsa'
    expect(productIssues(b)).toEqual(['Escribe el precio'])
    b.price = 20_900
    expect(productIssues(b)).toEqual([])
  })
})

describe('option group', () => {
  it('without touching anything there are no changes; the draft brings the options in order', () => {
    const c = editView()
    const g = groupDraft(c, c.groups[0]?.id as string)
    expect(g.options.map((o) => o.name)).toEqual(['Rojo', 'Medio'])
    expect(groupChanges(c, g)).toEqual([])
  })

  it('an option with a price, the maximum and archiving an option', () => {
    const c = editView()
    const g = groupDraft(c, c.groups[0]?.id as string)
    const [red, method] = g.options
    if (!red || !method) throw new Error('missing')
    g.maximum = 2
    red.extraPrice = 2_000
    method.active = false
    expect(groupChanges(c, g)).toEqual([
      { entity: 'modifier_groups', id: g.id, data: { maximum: 2 } },
      { entity: 'modifiers', id: red.id, data: { extra_price: 2_000 } },
      { entity: 'modifiers', id: method.id, data: { active: false } },
    ])
  })

  it('a new group carries everything', () => {
    const c = editView()
    const g = newGroup()
    g.name = 'Adicionales'
    g.maximum = 3
    g.options.push({
      id: newId(),
      fresh: true,
      name: 'Tocineta',
      extraPrice: 4_000,
      active: true,
    })
    expect(groupChanges(c, g).map((x) => x.entity)).toEqual(['modifier_groups', 'modifiers'])
    expect(groupIssues(g)).toEqual([])
  })

  it('warns about what does not add up', () => {
    const g = newGroup()
    g.minimum = 2
    g.maximum = 1
    expect(groupIssues(g)).toEqual([
      'Falta el nombre',
      'Agrega al menos una opción',
      'El mínimo no puede pasar del máximo',
    ])
    g.maximum = 3
    g.options.push({ id: newId(), fresh: true, name: 'Uno', extraPrice: 0, active: true })
    expect(groupIssues(g)).toContain('El mínimo (2) es mayor que las opciones que hay (1)')
  })

  it('counts the active products that use it', () => {
    const c = editView()
    const group = c.groups[0]?.id as string
    expect(productsWithGroup(c, group)).toBe(1)
    const tagliata = c.products.find((p) => p.name === 'Tagliata')
    if (tagliata) tagliata.active = false
    expect(productsWithGroup(c, group)).toBe(0)
  })
})
