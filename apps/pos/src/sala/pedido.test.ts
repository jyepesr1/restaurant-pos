import { newId, rebuild } from '@pos/core'
import type { Catalog } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import {
  comandasPorEstacion,
  copiaDe,
  datosItem,
  faltaElegir,
  type GrupoCatalogo,
  type ProductoCatalogo,
  pideOpciones,
  porEnviar,
  precioElegido,
} from './pedido'
import { catalogoDePrueba, datosItem as copy, local, opening } from './pruebas'

const group = (fields: Partial<GrupoCatalogo> = {}): GrupoCatalogo => ({
  id: newId(),
  name: 'Punto de cocción',
  minimum: 1,
  maximum: 1,
  options: [
    { id: 'O-1', name: 'Término medio', extraPrice: 0 },
    { id: 'O-2', name: 'Bien cocido', extraPrice: 0 },
    { id: 'O-3', name: 'Extra queso', extraPrice: 3_000 },
  ],
  ...fields,
})

const product = (fields: Partial<ProductoCatalogo> = {}): ProductoCatalogo => ({
  id: newId(),
  name: 'Ramón Bilbao',
  description: null,
  favorite: false,
  price: 20_000,
  tax: { type: 'inc', rate: 800 },
  variants: [],
  groups: [],
  ...fields,
})

const vino = product({
  variants: [
    { id: 'V-COPA', name: 'Copa', price: 24_000 },
    { id: 'V-BOTELLA', name: 'Botella', price: 98_000 },
  ],
})

describe('pideOpciones', () => {
  it('es falso sin variantes ni grupos y verdadero con cualquiera de los dos', () => {
    expect(pideOpciones(product())).toBe(false)
    expect(pideOpciones(vino)).toBe(true)
    expect(pideOpciones(product({ groups: [group()] }))).toBe(true)
  })
})

describe('faltaElegir', () => {
  it('sin variantes ni grupos no falta nada', () => {
    expect(faltaElegir(product(), null, {})).toEqual([])
  })

  it('pide el tamaño si el producto tiene variantes y no se eligió, o se eligió una ajena', () => {
    expect(faltaElegir(vino, null, {})).toEqual(['tamaño'])
    expect(faltaElegir(vino, 'V-OTRO-PRODUCTO', {})).toEqual(['tamaño'])
    expect(faltaElegir(vino, 'V-COPA', {})).toEqual([])
  })

  it('pide cada grupo bajo su mínimo, con el nombre en minúsculas', () => {
    const g = group({ minimum: 2, maximum: 3 })
    const p = product({ groups: [g] })
    expect(faltaElegir(p, null, {})).toEqual(['punto de cocción'])
    expect(faltaElegir(p, null, { [g.id]: ['O-1'] })).toEqual(['punto de cocción'])
    expect(faltaElegir(p, null, { [g.id]: ['O-1', 'O-2'] })).toEqual([])
  })

  it('un grupo con mínimo 0 es opcional', () => {
    const p = product({ groups: [group({ minimum: 0, maximum: 2 })] })
    expect(faltaElegir(p, null, {})).toEqual([])
  })

  it('junta tamaño y grupos, en ese orden', () => {
    const p = product({ variants: vino.variants, groups: [group()] })
    expect(faltaElegir(p, null, {})).toEqual(['tamaño', 'punto de cocción'])
  })
})

describe('datosItem', () => {
  const catalog = catalogoDePrueba({ version: 7 })

  it('producto simple: copia nombre, precio e impuesto del catálogo', () => {
    const p = product({ name: 'Limonada', price: 9_900 })
    const d = datosItem(catalog, p, null, {})
    expect(d).toMatchObject({
      product_id: p.id,
      variant_id: null,
      name: 'Limonada',
      unit_price: 9_900,
      tax_type: 'inc',
      rate: 800,
      quantity: 1,
      modifiers: [],
      catalog_version: 7,
      price_channel_id: null,
    })
    expect(d.item_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('con variante: el precio y el nombre son los de la variante', () => {
    const d = datosItem(catalog, vino, 'V-BOTELLA', {})
    expect(d).toMatchObject({
      variant_id: 'V-BOTELLA',
      name: 'Ramón Bilbao · Botella',
      unit_price: 98_000,
    })
  })

  it('con modificadores: guarda id, nombre y recargo de lo elegido, en el orden del catálogo', () => {
    const g = group({ minimum: 1, maximum: 3 })
    const p = product({ groups: [g] })
    const d = datosItem(catalog, p, null, { [g.id]: ['O-3', 'O-1'] })
    expect(d.modifiers).toEqual([
      { modifier_id: 'O-1', name: 'Término medio', extra_price: 0 },
      { modifier_id: 'O-3', name: 'Extra queso', extra_price: 3_000 },
    ])
    // El precio unitario no incluye el recargo: lo suma el cálculo del pedido.
    expect(d.unit_price).toBe(20_000)
  })

  it('un id que no es del grupo no cuenta como elegido', () => {
    const g = group({ minimum: 1, maximum: 1 })
    const p = product({ groups: [g] })
    expect(faltaElegir(p, null, { [g.id]: ['AJENA'] })).toEqual(['punto de cocción'])
    expect(() => datosItem(catalog, p, null, { [g.id]: ['AJENA'] })).toThrow('Falta elegir')
    const d = datosItem(catalog, p, null, { [g.id]: ['O-1', 'AJENA'] })
    expect(d.modifiers.map((m) => m.modifier_id)).toEqual(['O-1'])
  })

  it('pasarse del máximo del grupo no se recorta en silencio: lanza y no guarda nada', () => {
    const g = group({ minimum: 1, maximum: 1 })
    const p = product({ groups: [g] })
    expect(() => datosItem(catalog, p, null, { [g.id]: ['O-1', 'O-2'] })).toThrow(
      'En punto de cocción se eligen máximo 1',
    )
    // Justo en el máximo está bien.
    expect(datosItem(catalog, p, null, { [g.id]: ['O-2'] }).modifiers).toHaveLength(1)
  })

  it('un producto exento queda con tarifa 0', () => {
    const p = product({ tax: { type: 'exempt', rate: 800 } })
    expect(datosItem(catalog, p, null, {})).toMatchObject({ tax_type: 'exempt', rate: 0 })
  })

  it('con variante y modificadores a la vez', () => {
    const g = group()
    const p = product({ variants: vino.variants, groups: [g] })
    const d = datosItem(catalog, p, 'V-COPA', { [g.id]: ['O-2'] })
    expect(d).toMatchObject({ name: 'Ramón Bilbao · Copa', unit_price: 24_000 })
    expect(d.modifiers).toHaveLength(1)
  })

  it('si falta elegir, lanza con lo que falta y no genera nada', () => {
    const p = product({ variants: vino.variants, groups: [group()] })
    expect(() => datosItem(catalog, p, null, {})).toThrow('Falta elegir: tamaño, punto de cocción')
  })

  it('cada llamada genera un item_id nuevo', () => {
    const p = product()
    expect(datosItem(catalog, p, null, {}).item_id).not.toBe(
      datosItem(catalog, p, null, {}).item_id,
    )
  })

  it('los datos pasan el esquema del evento ItemAgregado', async () => {
    const { validateNewEvent } = await import('@pos/core')
    const g = group()
    const p = product({ variants: vino.variants, groups: [g] })
    const data = datosItem(catalog, p, 'V-COPA', { [g.id]: ['O-1'] })
    // El esquema pide ULID en producto, variante y modificador: se prueban con ids reales.
    const real = { ...data, product_id: newId(), variant_id: newId() }
    real.modifiers = real.modifiers.map((m) => ({ ...m, modifier_id: newId() }))
    const event = local('ItemAdded', newId(), real, 'pending').event
    expect(validateNewEvent(event).ok).toBe(true)
  })
})

describe('comandasPorEstacion', () => {
  const orderId = newId()
  const enCocina = newId()
  const enBarra = newId()
  const sinEstacion = newId()

  function estadoCon(products: string[]) {
    const events = [
      local('OrderOpened', orderId, opening),
      ...products.map((product_id) => local('ItemAdded', orderId, copy({ product_id }), 'pending')),
    ]
    const status = rebuild(
      events.map((l) => l.event),
      orderId,
    )
    if (!status) throw new Error('sin estado')
    return status
  }

  const catalog: Catalog = catalogoDePrueba({
    categories: [
      {
        id: 'C1',
        name: 'Pizzas',
        stationId: 'E-COCINA',
        products: [product({ id: enCocina })],
      },
      { id: 'C2', name: 'Tragos', stationId: 'E-BARRA', products: [product({ id: enBarra })] },
      { id: 'C3', name: 'Varios', stationId: null, products: [product({ id: sinEstacion })] },
    ],
  })

  it('una comanda por estación, con los ítems de cada una', () => {
    const status = estadoCon([enCocina, enBarra, enCocina])
    const r = comandasPorEstacion(catalog, status)
    expect(r?.tickets).toHaveLength(2)
    const kitchen = r?.tickets.find((c) => c.station_id === 'E-COCINA')
    const bar = r?.tickets.find((c) => c.station_id === 'E-BARRA')
    expect(kitchen?.item_ids).toHaveLength(2)
    expect(bar?.item_ids).toHaveLength(1)
    expect(new Set(r?.tickets.map((c) => c.ticket_id)).size).toBe(2)
    // Todos los pendientes salen en alguna comanda, sin repetirse.
    const sentList = r?.tickets.flatMap((c) => c.item_ids) ?? []
    expect(new Set(sentList)).toEqual(new Set(porEnviar(status).map((i) => i.id)))
  })

  it('una categoría sin estación va a la primera estación del restaurante', () => {
    const r = comandasPorEstacion(catalog, estadoCon([sinEstacion]))
    expect(r?.tickets.map((c) => c.station_id)).toEqual(['E-COCINA'])
  })

  it('un producto que ya no está en el catálogo también va a la primera estación', () => {
    const r = comandasPorEstacion(catalog, estadoCon([newId()]))
    expect(r?.tickets.map((c) => c.station_id)).toEqual(['E-COCINA'])
  })

  it('sin estaciones en el restaurante no hay a dónde enviar lo de una categoría sin estación', () => {
    const without = { ...catalog, stations: [] }
    expect(comandasPorEstacion(without, estadoCon([sinEstacion]))).toBeNull()
    // Lo que sí tiene estación propia (aunque el restaurante no liste ninguna) sigue funcionando.
    expect(comandasPorEstacion(without, estadoCon([enBarra]))?.tickets).toHaveLength(1)
  })

  it('si algún ítem no tiene a dónde ir, no se envía nada (ni siquiera lo que sí podría)', () => {
    const without = { ...catalog, stations: [] }
    expect(comandasPorEstacion(without, estadoCon([enCocina, sinEstacion]))).toBeNull()
  })

  it('sin ítems por enviar devuelve null', () => {
    expect(comandasPorEstacion(catalog, estadoCon([]))).toBeNull()
  })

  it('lo ya enviado no vuelve a salir', () => {
    const aggregate = copy({ product_id: enCocina })
    const itemId = aggregate.item_id
    const events = [
      local('OrderOpened', orderId, opening),
      local('ItemAdded', orderId, aggregate, 'pending'),
    ]
    events.push(
      local(
        'ItemsSent',
        orderId,
        { tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [itemId] }] },
        'pending',
      ),
    )
    const status = rebuild(
      events.map((l) => l.event),
      orderId,
    )
    expect(status?.items[itemId]?.status).toBe('sent')
    expect(comandasPorEstacion(catalog, status as never)).toBeNull()
  })
})

describe('precioElegido', () => {
  const g = group({ minimum: 0, maximum: 3 })

  it('producto simple: su precio', () => {
    expect(precioElegido(product({ price: 12_000 }), null, {})).toBe(12_000)
  })

  it('la variante reemplaza el precio base y los extras se suman', () => {
    const p = product({ variants: vino.variants, groups: [g] })
    expect(precioElegido(p, 'V-BOTELLA', {})).toBe(98_000)
    expect(precioElegido(p, 'V-COPA', { [g.id]: ['O-3'] })).toBe(27_000)
    expect(precioElegido(p, 'V-COPA', { [g.id]: ['O-3', 'O-1'] })).toBe(27_000)
  })

  it('sin variante elegida usa el precio del producto; un id ajeno no suma', () => {
    const p = product({ price: 20_000, variants: vino.variants, groups: [g] })
    expect(precioElegido(p, null, { [g.id]: ['AJENA'] })).toBe(20_000)
  })

  it('coincide con lo que cobra el pedido para el ítem guardado', async () => {
    const { rebuild, orderTotals } = await import('@pos/core')
    const p = product({ variants: vino.variants, groups: [g] })
    const elegidas = { [g.id]: ['O-3'] }
    const orderId = newId()
    const real = { ...datosItem(catalogoDePrueba(), p, 'V-COPA', elegidas), product_id: newId() }
    real.variant_id = newId()
    real.modifiers = real.modifiers.map((m) => ({ ...m, modifier_id: newId() }))
    const status = rebuild(
      [
        local('OrderOpened', orderId, opening).event,
        local('ItemAdded', orderId, real, 'pending').event,
      ],
      orderId,
    )
    expect(orderTotals(status as never).net).toBe(precioElegido(p, 'V-COPA', elegidas))
  })
})

describe('copiaDe', () => {
  it('repite el ítem con id nuevo y la versión de catálogo indicada', () => {
    const orderId = newId()
    const original = copy({
      product_id: newId(),
      name: 'Pizza',
      quantity: 2,
      guest: 3,
      course: 'main',
      notes: 'sin cebolla',
      modifiers: [{ modifier_id: newId(), name: 'Extra queso', extra_price: 3_000 }],
    })
    const status = rebuild(
      [local('OrderOpened', orderId, opening).event, local('ItemAdded', orderId, original).event],
      orderId,
    )
    const item = status?.items[original.item_id]
    if (!item) throw new Error('sin ítem')
    const c = copiaDe(item, 9)
    expect(c.item_id).not.toBe(original.item_id)
    expect(c).toEqual({ ...original, item_id: c.item_id, catalog_version: 9 })
  })
})
