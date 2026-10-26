import { newId, rebuild } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { comandasDeCurso, datosItem, lineaIgual } from './pedido'
import { agotados, claveAgotado, masPedidos, pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba, datosItem as item, local, opening } from './pruebas'

const simple = {
  id: newId(),
  name: 'Limonada',
  description: null,
  favorite: false,
  price: 9_900,
  tax: { type: 'inc' as const, rate: 800 },
  variants: [],
  groups: [],
}
const withDishes = () =>
  catalogoDePrueba({
    categories: [{ id: newId(), name: 'Bebidas', stationId: 'E-BARRA', products: [simple] }],
  })

// Toma de pedido de la 1.3: agotados, lo más pedido, la línea que suma, marchar un curso y los
// datos del ítem con persona, curso y nota.

const soldOut = (
  product: string,
  status: 'confirmed' | 'pending' = 'confirmed',
  variant: string | null = null,
) =>
  local('ProductSoldOut', product, { product_id: product, variant_id: variant }, status, {
    aggregate_type: 'product',
  })
const available = (product: string, status: 'confirmed' | 'pending' = 'confirmed') =>
  local('ProductAvailable', product, { product_id: product, variant_id: null }, status, {
    aggregate_type: 'product',
  })

describe('agotados (86)', () => {
  it('el último evento manda; lo propio pendiente va encima de lo confirmado', () => {
    const p = newId()
    expect(agotados([soldOut(p)])).toEqual(new Set([p]))
    expect(agotados([soldOut(p), available(p)])).toEqual(new Set())
    // Confirmado "disponible", pero este equipo lo acaba de marcar agotado sin conexión.
    expect(agotados([available(p), soldOut(p, 'pending')])).toEqual(new Set([p]))
  })

  it('una variante se agota sola (la botella, no la copa)', () => {
    const p = newId()
    const bottle = newId()
    expect(agotados([soldOut(p, 'confirmed', bottle)])).toEqual(new Set([claveAgotado(p, bottle)]))
  })

  it('un evento rechazado no cuenta, y los eventos de producto no se vuelven pedidos', () => {
    const p = newId()
    const rejected = { ...soldOut(p), status: 'rejected' as const }
    expect(agotados([rejected])).toEqual(new Set())
    const order = newId()
    expect(
      pedidosAbiertos([soldOut(p), local('OrderOpened', order, opening)]).map((x) => x.status.id),
    ).toEqual([order])
  })
})

describe('lo más pedido', () => {
  it('cuenta unidades por producto, del más al menos', () => {
    const order = newId()
    const a = newId()
    const b = newId()
    const locals = [
      local('OrderOpened', order, opening),
      local('ItemAdded', order, item({ product_id: a, quantity: 1 })),
      local('ItemAdded', order, item({ product_id: b, quantity: 3 })),
      local('ItemAdded', order, item({ product_id: a, quantity: 1 })),
    ]
    expect(masPedidos(locals)).toEqual([b, a])
    expect(masPedidos(locals, 1)).toEqual([b])
  })
})

describe('el mismo producto otra vez', () => {
  const orderWith = (...data: ReturnType<typeof item>[]) => {
    const order = newId()
    return rebuild(
      [local('OrderOpened', order, opening), ...data.map((d) => local('ItemAdded', order, d))].map(
        (l) => l.event,
      ),
      order,
    )
  }

  it('suma a la línea sin enviar igual: mismo producto, persona, curso, sin nota', () => {
    const product = newId()
    const first = item({ product_id: product })
    const status = orderWith(first)
    expect(lineaIgual(status, item({ product_id: product }))?.id).toBe(first.item_id)
  })

  it('no suma si cambia la persona, el curso, la nota o las opciones', () => {
    const product = newId()
    const status = orderWith(item({ product_id: product }))
    expect(lineaIgual(status, item({ product_id: product, guest: 2 }))).toBeNull()
    expect(lineaIgual(status, item({ product_id: product, course: 'main' }))).toBeNull()
    expect(lineaIgual(status, item({ product_id: product, notes: 'sin hielo' }))).toBeNull()
    expect(
      lineaIgual(
        status,
        item({
          product_id: product,
          modifiers: [{ modifier_id: newId(), name: 'Doble', extra_price: 0 }],
        }),
      ),
    ).toBeNull()
    expect(lineaIgual(null, item({ product_id: product }))).toBeNull()
  })
})

describe('marchar un curso', () => {
  it('manda solo lo del curso, por estación', () => {
    const catalog = withDishes()
    const order = newId()
    const entry = item({ product_id: simple.id, course: 'entry' })
    const main = item({ product_id: simple.id, course: 'main' })
    const status = rebuild(
      [
        local('OrderOpened', order, opening),
        local('ItemAdded', order, entry),
        local('ItemAdded', order, main),
      ].map((l) => l.event),
      order,
    )
    if (!status) throw new Error('falta')
    const data = comandasDeCurso(catalog, status, 'main')
    expect(data?.tickets).toEqual([
      expect.objectContaining({ station_id: 'E-BARRA', item_ids: [main.item_id] }),
    ])
    expect(comandasDeCurso(catalog, status, 'dessert')).toBeNull()
  })
})

describe('datos del ítem', () => {
  it('llevan persona, curso, cantidad y la nota recortada (vacía es null)', () => {
    const catalog = withDishes()
    const p = simple
    expect(
      datosItem(
        catalog,
        p,
        null,
        {},
        { guest: 2, course: 'dessert', quantity: 3, notes: '  sin azúcar ' },
      ),
    ).toMatchObject({
      guest: 2,
      course: 'dessert',
      quantity: 3,
      notes: 'sin azúcar',
    })
    expect(datosItem(catalog, p, null, {}, { notes: '   ' }).notes).toBeNull()
  })
})
