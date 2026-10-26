import { type ApplicableEvent, newId, rebuild, validateNewEvent } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { comandasDeCurso, comandasPorEstacion, datosItem, lineaIgual } from './pedido'
import {
  agotados,
  claveAgotado,
  estadoMesa,
  masPedidos,
  type PedidoVisible,
  pedidosAbiertos,
} from './proyeccion'
import { catalogoDePrueba, datosItem as item, local, opening } from './pruebas'

// Bordes de la toma de pedido de la 1.3: agotados con su orden, lo más pedido, sumar a la línea
// igual, marchar un curso, los datos del ítem y el pedido para llevar.

const conSecuencia = (l: EventoLocal, sequence: number): EventoLocal => ({
  ...l,
  event: { ...l.event, sequence } as ApplicableEvent,
})
const deProducto = { aggregate_type: 'product' } as const
const brand = (
  type: 'ProductSoldOut' | 'ProductAvailable',
  product: string,
  variant: string | null = null,
  status: 'confirmed' | 'pending' = 'confirmed',
) => local(type, product, { product_id: product, variant_id: variant }, status, deProducto)

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
const catalog = catalogoDePrueba({
  categories: [{ id: newId(), name: 'Bebidas', estacionId: 'E-BARRA', products: [simple] }],
})

const orderWith = (...events: ((p: string) => EventoLocal)[]) => {
  const p = newId()
  const locales = [local('OrderOpened', p, opening), ...events.map((f) => f(p))]
  return {
    p,
    locales,
    status: rebuild(
      locales.map((l) => l.event),
      p,
    ),
  }
}
const aggregate =
  (data: ReturnType<typeof item>, status: 'confirmed' | 'pending' = 'confirmed') =>
  (p: string) =>
    local('ItemAdded', p, data, status)

describe('agotados(): orden de confirmados y pendientes', () => {
  it('los confirmados mandan por secuencia aunque la lista venga desordenada', () => {
    const p = newId()
    const markSoldOut = conSecuencia(brand('ProductSoldOut', p), 5)
    const release = conSecuencia(brand('ProductAvailable', p), 9)
    expect(agotados([release, markSoldOut])).toEqual(new Set())
    expect(agotados([markSoldOut, release])).toEqual(new Set())
    const liberar2 = conSecuencia(brand('ProductAvailable', p), 3)
    expect(agotados([markSoldOut, liberar2])).toEqual(new Set([p]))
  })

  it('lo pendiente propio va siempre encima de lo confirmado, esté donde esté en la lista', () => {
    const p = newId()
    const confirmadoAgotado = conSecuencia(brand('ProductSoldOut', p), 50)
    const pendienteLibre = brand('ProductAvailable', p, null, 'pending')
    expect(agotados([pendienteLibre, confirmadoAgotado])).toEqual(new Set())
    expect(agotados([confirmadoAgotado, pendienteLibre])).toEqual(new Set())
    // Y al revés: pendiente "agotado" sobre un "disponible" confirmado posterior en secuencia.
    const confirmadoLibre = conSecuencia(brand('ProductAvailable', p), 99)
    const pendienteAgotado = brand('ProductSoldOut', p, null, 'pending')
    expect(agotados([pendienteAgotado, confirmadoLibre])).toEqual(new Set([p]))
  })

  it('varios pendientes se aplican en el orden de la lista; el último manda', () => {
    const p = newId()
    expect(
      agotados([
        brand('ProductSoldOut', p, null, 'pending'),
        brand('ProductAvailable', p, null, 'pending'),
        brand('ProductSoldOut', p, null, 'pending'),
      ]),
    ).toEqual(new Set([p]))
    expect(
      agotados([
        brand('ProductSoldOut', p, null, 'pending'),
        brand('ProductAvailable', p, null, 'pending'),
      ]),
    ).toEqual(new Set())
  })

  it('un confirmado sin secuencia cuenta como 0: va antes que cualquiera con secuencia', () => {
    const p = newId()
    const sinSecuencia = conSecuencia(brand('ProductAvailable', p), undefined as unknown as number)
    const conSec = conSecuencia(brand('ProductSoldOut', p), 1)
    expect(agotados([conSec, sinSecuencia])).toEqual(new Set([p]))
    expect(agotados([sinSecuencia, conSec])).toEqual(new Set([p]))
  })

  it('con variantes: cada una va sola y el producto entero es otra clave', () => {
    const p = newId()
    const glass = newId()
    const bottle = newId()
    const events = [
      conSecuencia(brand('ProductSoldOut', p, bottle), 1),
      conSecuencia(brand('ProductSoldOut', p, glass), 2),
      conSecuencia(brand('ProductAvailable', p, glass), 3),
    ]
    expect(agotados(events)).toEqual(new Set([claveAgotado(p, bottle)]))
    // Marcar disponible el producto entero no libera la botella, y agotarlo no toca a la copa.
    expect(agotados([...events, conSecuencia(brand('ProductAvailable', p), 4)])).toEqual(
      new Set([claveAgotado(p, bottle)]),
    )
    expect(agotados([...events, conSecuencia(brand('ProductSoldOut', p), 4)])).toEqual(
      new Set([claveAgotado(p, bottle), claveAgotado(p)]),
    )
    expect(claveAgotado(p)).toBe(p)
    expect(claveAgotado(p, null)).toBe(p)
    expect(claveAgotado(p, glass)).not.toBe(claveAgotado(p, bottle))
  })

  it('un evento rechazado o en cuarentena no cuenta; uno confirmado de otro producto tampoco influye', () => {
    const p = newId()
    const other = newId()
    const rejected = { ...brand('ProductSoldOut', p), status: 'rejected' as const }
    const quarantine = { ...brand('ProductSoldOut', p), status: 'quarantine' as const }
    expect(agotados([rejected, quarantine])).toEqual(new Set())
    expect(agotados([rejected, conSecuencia(brand('ProductSoldOut', other), 1)])).toEqual(
      new Set([other]),
    )
    // Un rechazado "disponible" no libera lo que sigue agotado.
    const liberaRechazado = { ...brand('ProductAvailable', p), status: 'rejected' as const }
    expect(agotados([conSecuencia(brand('ProductSoldOut', p), 1), liberaRechazado])).toEqual(
      new Set([p]),
    )
  })

  it('los eventos de pedido no cuentan, y sin eventos no hay nada agotado', () => {
    const { locales } = orderWith(aggregate(item()))
    expect(agotados(locales)).toEqual(new Set())
    expect(agotados([])).toEqual(new Set())
  })
})

describe('masPedidos con eventos rechazados y otros bordes', () => {
  it('los ítems rechazados o en cuarentena no suman', () => {
    const p = newId()
    const good = newId()
    const badCase = newId()
    const locales = [
      local('OrderOpened', p, opening),
      local('ItemAdded', p, item({ product_id: good, quantity: 1 })),
      {
        ...local('ItemAdded', p, item({ product_id: badCase, quantity: 9 })),
        status: 'rejected' as const,
      },
      {
        ...local('ItemAdded', p, item({ product_id: badCase, quantity: 9 })),
        status: 'quarantine' as const,
      },
    ]
    expect(masPedidos(locales)).toEqual([good])
  })

  it('un pendiente propio sí cuenta; en un empate va primero lo confirmado, en el orden del hub', () => {
    const p = newId()
    const a = newId()
    const b = newId()
    const c = newId()
    const locales = [
      local('ItemAdded', p, item({ product_id: a, quantity: 2 })),
      local('ItemAdded', p, item({ product_id: b, quantity: 2 }), 'pending'),
      local('ItemAdded', p, item({ product_id: c, quantity: 2 })),
    ]
    expect(masPedidos(locales)).toEqual([a, c, b])
    expect(masPedidos(locales, 2)).toEqual([a, c])
    expect(masPedidos(locales, 0)).toEqual([])
    expect(masPedidos([])).toEqual([])
  })

  it('el tope por defecto es 12 productos', () => {
    const p = newId()
    const locales = Array.from({ length: 15 }, (_, i) =>
      local('ItemAdded', p, item({ product_id: newId(), quantity: 15 - i })),
    )
    expect(masPedidos(locales)).toHaveLength(12)
  })

  // Lo encontró qa-pruebas en la 1.3 y ya está corregido: sumar el mismo producto otra vez se
  // guarda como `ItemChanged` sobre la línea, y `masPedidos` solo miraba ItemAdded.
  it('masPedidos cuenta las unidades que se suman con ItemCambiado', () => {
    const p = newId()
    const lemonade = newId()
    const beer = newId()
    const line = item({ product_id: lemonade, quantity: 1 })
    const locales = [
      local('OrderOpened', p, opening),
      local('ItemAdded', p, line),
      local('ItemAdded', p, item({ product_id: beer, quantity: 3 })),
      local('ItemChanged', p, { item_id: line.item_id, quantity: 10 }),
    ]
    expect(masPedidos(locales)).toEqual([lemonade, beer])
  })

  it('lo quitado no cuenta y lo anulado se descuenta', () => {
    const p = newId()
    const [lemonade, beer, agua] = [newId(), newId(), newId()]
    const quitada = item({ product_id: lemonade, quantity: 5 })
    const voidedItem = item({ product_id: beer, quantity: 4 })
    const locales = [
      local('OrderOpened', p, opening),
      local('ItemAdded', p, quitada),
      local('ItemAdded', p, voidedItem),
      local('ItemAdded', p, item({ product_id: agua, quantity: 2 })),
      local('ItemRemoved', p, { item_id: quitada.item_id }),
      local('ItemVoided', p, {
        item_id: voidedItem.item_id,
        quantity: 3,
        already_prepared: false,
        ticket_id: null,
      }),
    ]
    expect(masPedidos(locales)).toEqual([agua, beer])
  })
})

describe('lineaIgual: retenido, anulado y opciones en otro orden', () => {
  const op = (n: string) => ({ modifier_id: n, name: n, extra_price: 0 })

  it('las opciones en otro orden son la misma línea', () => {
    const product = newId()
    const [a, b, c] = [newId(), newId(), newId()]
    const first = item({ product_id: product, modifiers: [op(a), op(b), op(c)] })
    const { status } = orderWith(aggregate(first))
    const equal = lineaIgual(
      status,
      item({ product_id: product, modifiers: [op(c), op(a), op(b)] }),
    )
    expect(equal?.id).toBe(first.item_id)
    // Una opción de más o de menos ya no lo es.
    expect(lineaIgual(status, item({ product_id: product, modifiers: [op(a), op(b)] }))).toBeNull()
    expect(
      lineaIgual(
        status,
        item({ product_id: product, modifiers: [op(a), op(b), op(c), op(newId())] }),
      ),
    ).toBeNull()
  })

  it('una línea ya enviada o quitada no se suma', () => {
    const product = newId()
    const line = item({ product_id: product })
    const sent = orderWith(aggregate(line), (p) =>
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [line.item_id] }],
      }),
    )
    expect(lineaIgual(sent.status, item({ product_id: product }))).toBeNull()

    const quitada = orderWith(aggregate(line), (p) =>
      local('ItemRemoved', p, { item_id: line.item_id }),
    )
    expect(lineaIgual(quitada.status, item({ product_id: product }))).toBeNull()
  })

  it('con dos líneas iguales posibles (otra persona) elige la de la misma persona', () => {
    const product = newId()
    const table = item({ product_id: product, guest: null })
    const p2 = item({ product_id: product, guest: 2 })
    const { status } = orderWith(aggregate(table), aggregate(p2))
    expect(lineaIgual(status, item({ product_id: product, guest: 2 }))?.id).toBe(p2.item_id)
    expect(lineaIgual(status, item({ product_id: product, guest: null }))?.id).toBe(table.item_id)
    expect(lineaIgual(status, item({ product_id: product, guest: 3 }))).toBeNull()
  })

  it('no suma si lo nuevo lleva nota ni a una línea que ya tiene nota', () => {
    const product = newId()
    const withNote = orderWith(aggregate(item({ product_id: product, notes: 'sin hielo' })))
    expect(lineaIgual(withNote.status, item({ product_id: product }))).toBeNull()
    expect(
      lineaIgual(withNote.status, item({ product_id: product, notes: 'sin hielo' })),
    ).toBeNull()
  })

  it('distingue la variante (copa y botella son líneas distintas)', () => {
    const product = newId()
    const glass = newId()
    const bottle = newId()
    const { status } = orderWith(aggregate(item({ product_id: product, variant_id: glass })))
    expect(lineaIgual(status, item({ product_id: product, variant_id: bottle }))).toBeNull()
    expect(lineaIgual(status, item({ product_id: product, variant_id: glass }))).not.toBeNull()
    expect(lineaIgual(status, item({ product_id: product, variant_id: null }))).toBeNull()
  })

  it('un pedido sin líneas o un pedido distinto no da coincidencia', () => {
    const { status } = orderWith()
    expect(lineaIgual(status, item())).toBeNull()
  })

  it('el mismo producto en un curso retenido suma a su línea retenida', () => {
    const product = newId()
    const first = item({ product_id: product, course: 'dessert' })
    const { status } = orderWith(
      (p) => local('CourseHeld', p, { course: 'dessert' }),
      aggregate(first),
    )
    expect(status?.items[first.item_id]?.status).toBe('held')
    expect(lineaIgual(status, item({ product_id: product, course: 'dessert' }))?.id).toBe(
      first.item_id,
    )
  })

  it('no suma a una línea con otro precio copiado (otra versión de la carta)', () => {
    const product = newId()
    const vieja = item({ product_id: product, unit_price: 9_900, catalog_version: 1 })
    const { status } = orderWith(aggregate(vieja))
    const newOne = (fields: Record<string, unknown>) =>
      lineaIgual(status, item({ product_id: product, unit_price: 9_900, ...fields }))
    expect(newOne({ unit_price: 10_900, catalog_version: 2 })).toBeNull()
    expect(newOne({ catalog_version: 2 })?.id).toBe(vieja.item_id)
    expect(newOne({ tax_type: 'iva', rate: 1_900 })).toBeNull()
    expect(newOne({ rate: 1_900 })).toBeNull()
    expect(newOne({ tax_type: 'exempt', rate: 0 })).toBeNull()
  })

  it('la misma opción con otro precio extra no es la misma línea', () => {
    const product = newId()
    const o = newId()
    const conOpcion = (price: number) => ({
      modifier_id: o,
      name: 'Doble',
      extra_price: price,
    })
    const { status } = orderWith(
      aggregate(item({ product_id: product, modifiers: [conOpcion(2_000)] })),
    )
    expect(
      lineaIgual(status, item({ product_id: product, modifiers: [conOpcion(3_000)] })),
    ).toBeNull()
    expect(
      lineaIgual(status, item({ product_id: product, modifiers: [conOpcion(2_000)] })),
    ).not.toBeNull()
  })

  it('no suma a una línea con descuento ni en un pedido dividido', () => {
    const product = newId()
    const line = item({ product_id: product })
    const { status } = orderWith(aggregate(line))
    if (!status) throw new Error('falta')
    const withDiscount = {
      ...status,
      discounts: {
        D1: { id: 'D1', amounts: { [line.item_id]: 500 } },
      },
    } as unknown as typeof status
    expect(lineaIgual(withDiscount, item({ product_id: product }))).toBeNull()
    const divided = { ...status, checks: [] } as unknown as typeof status
    expect(lineaIgual(divided, item({ product_id: product }))).toBeNull()
    expect(lineaIgual(status, item({ product_id: product }))?.id).toBe(line.item_id)
  })
})

describe('comandasDeCurso con pendientes de otros cursos', () => {
  const catalogoDos = catalogoDePrueba({
    categories: [
      { id: newId(), name: 'Bebidas', estacionId: 'E-BARRA', products: [simple] },
      {
        id: newId(),
        name: 'Platos',
        estacionId: 'E-COCINA',
        products: [{ ...simple, id: 'P-PLATO', name: 'Pizza' }],
      },
    ],
  })

  it('solo manda el curso marchado: las de otros cursos y las sin curso se quedan pendientes', () => {
    const entry = item({ product_id: simple.id, course: 'entry' })
    const fuerteBarra = item({ product_id: simple.id, course: 'main' })
    const fuerteCocina = item({ product_id: 'P-PLATO', course: 'main' })
    const dessert = item({ product_id: 'P-PLATO', course: 'dessert' })
    const sinCurso = item({ product_id: simple.id, course: null })
    const { status } = orderWith(
      aggregate(entry),
      aggregate(fuerteBarra),
      aggregate(fuerteCocina),
      aggregate(dessert),
      aggregate(sinCurso),
    )
    if (!status) throw new Error('falta')

    const data = comandasDeCurso(catalogoDos, status, 'main')
    const enviados = data?.tickets.flatMap((c) => c.item_ids).sort()
    expect(enviados).toEqual([fuerteBarra.item_id, fuerteCocina.item_id].sort())
    expect(data?.tickets.map((c) => c.station_id).sort()).toEqual(['E-BARRA', 'E-COCINA'])
    // El estado original no se modificó: los demás siguen por enviar.
    expect(Object.keys(status.items)).toHaveLength(5)
    expect(
      comandasPorEstacion(catalogoDos, status)?.tickets.flatMap((c) => c.item_ids),
    ).toHaveLength(5)
  })

  it('si el curso ya salió o no tiene nada, no hay nada que mandar (aunque haya pendientes de otros)', () => {
    const main = item({ product_id: simple.id, course: 'main' })
    const dessert = item({ product_id: simple.id, course: 'dessert' })
    const { status } = orderWith(aggregate(main), aggregate(dessert), (p) =>
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: 'E-BARRA', item_ids: [main.item_id] }],
      }),
    )
    if (!status) throw new Error('falta')
    expect(comandasDeCurso(catalogoDos, status, 'main')).toBeNull()
    expect(comandasDeCurso(catalogoDos, status, 'entry')).toBeNull()
    expect(comandasDeCurso(catalogoDos, status, 'dessert')?.tickets).toHaveLength(1)
  })

  it('lo retenido de ese curso espera hasta marchar; después sale', () => {
    const dessert = item({ product_id: simple.id, course: 'dessert' })
    const held = orderWith((p) => local('CourseHeld', p, { course: 'dessert' }), aggregate(dessert))
    if (!held.status) throw new Error('falta')
    expect(comandasDeCurso(catalogoDos, held.status, 'dessert')).toBeNull()

    const fired = orderWith(
      (p) => local('CourseHeld', p, { course: 'dessert' }),
      aggregate(dessert),
      (p) => local('CourseFired', p, { course: 'dessert' }),
    )
    if (!fired.status) throw new Error('falta')
    expect(comandasDeCurso(catalogoDos, fired.status, 'dessert')?.tickets[0]?.item_ids).toEqual([
      dessert.item_id,
    ])
  })
})

describe('datosItem con extras fuera de rango', () => {
  const datosValidos = (extras: Parameters<typeof datosItem>[4]) => {
    const d = datosItem(catalog, simple, null, {}, extras)
    const p = newId()
    return validateNewEvent({
      id: newId(),
      type: 'ItemAdded',
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: p,
      related: [],
      data: d,
      session_id: null,
      user_id: newId(),
      device_id: newId(),
      authorization_id: null,
      reason: null,
      device_time: '2026-10-24T15:00:00.000Z',
      hub_estimated_time: '2026-10-24T15:00:00.000Z',
      base_sequence: 0,
    })
  }

  it('sin extras: una unidad, para la mesa, sin curso ni nota', () => {
    expect(datosItem(catalog, simple, null, {})).toMatchObject({
      quantity: 1,
      guest: null,
      course: null,
      notes: null,
      catalog_version: catalog.version,
      price_channel_id: null,
    })
  })

  it('cantidad 0 y comensal 0 llegan tal cual, y el esquema los rechaza antes de guardarse', () => {
    expect(datosItem(catalog, simple, null, {}, { quantity: 0 }).quantity).toBe(0)
    expect(datosItem(catalog, simple, null, {}, { guest: 0 }).guest).toBe(0)
    expect(datosValidos({ quantity: 0 }).ok).toBe(false)
    expect(datosValidos({ guest: 0 }).ok).toBe(false)
    expect(datosValidos({ quantity: -3 }).ok).toBe(false)
    expect(datosValidos({ guest: 100 }).ok).toBe(false)
    expect(datosValidos({ quantity: 1.5 }).ok).toBe(false)
  })

  it('cantidad 99 vale; 100 pasa el esquema pero la pantalla nunca pasa de 99', () => {
    expect(datosValidos({ quantity: 99 }).ok).toBe(true)
    // El esquema admite hasta el tope de cantidad (999); el límite de 99 lo pone la pantalla.
    expect(datosValidos({ quantity: 100 }).ok).toBe(true)
    expect(datosValidos({ quantity: 1_000 }).ok).toBe(false)
  })

  it('comensal 1 y 99 valen; la nota se recorta y una de más de 500 letras no pasa el esquema', () => {
    expect(datosValidos({ guest: 1 }).ok).toBe(true)
    expect(datosValidos({ guest: 99 }).ok).toBe(true)
    expect(datosItem(catalog, simple, null, {}, { notes: '\n  sin hielo \t' }).notes).toBe(
      'sin hielo',
    )
    expect(datosValidos({ notes: 'a'.repeat(500) }).ok).toBe(true)
    expect(datosValidos({ notes: 'a'.repeat(501) }).ok).toBe(false)
  })

  it('extras vacíos o con null explícito valen como "sin extras"', () => {
    const d = datosItem(catalog, simple, null, {}, { guest: null, course: null, notes: undefined })
    expect(d).toMatchObject({ guest: null, course: null, notes: null, quantity: 1 })
  })
})

describe('proyección de un pedido para llevar (sin mesa, con número del día)', () => {
  it('lleva canal, número del día y ningún mesaId; los agotados no lo estorban', () => {
    const p = newId()
    const locales = [
      local('OrderOpened', p, { channel: 'takeout', table_id: null, guests: 1 }),
      conSecuencia(brand('ProductSoldOut', newId()), 7),
      local('ItemAdded', p, item({ unit_price: 12_000 })),
    ]
    const [v] = pedidosAbiertos(locales)
    expect(v?.status.channel).toBe('takeout')
    expect(v?.status.tableId).toBeNull()
    expect(v?.status.dayNumber).toBe(1)
    expect(v?.total).toBe(12_000)
    expect(estadoMesa(v ? [v] : [])).toBe('taking')
  })

  it('sin confirmar todavía no tiene número del día; al confirmarse lo recibe del hub', () => {
    const p = newId()
    const opened = local(
      'OrderOpened',
      p,
      { channel: 'takeout', table_id: null, guests: 1 },
      'pending',
    )
    expect(pedidosAbiertos([opened])[0]?.status.dayNumber).toBeNull()
    expect(pedidosAbiertos([opened])[0]?.porConfirmar).toBe(true)

    const confirmed = {
      ...opened,
      status: 'confirmed' as const,
      event: {
        ...opened.event,
        sequence: 4,
        received_at: '2026-10-24T15:00:00.000Z',
        business_day: '2026-10-24',
        assignments: { day_number: 12 },
        affects: [],
        authorized_by_id: null,
      } as ApplicableEvent,
    }
    expect(pedidosAbiertos([confirmed])[0]?.status.dayNumber).toBe(12)
  })

  it('dos pedidos para llevar y uno de salón se distinguen; los de producto nunca aparecen como pedido', () => {
    const [a, b, c] = [newId(), newId(), newId()]
    const x = newId()
    const table = newId()
    const seenSet: PedidoVisible[] = pedidosAbiertos([
      local('OrderOpened', a, { channel: 'takeout', table_id: null, guests: 1 }),
      local('OrderOpened', b, { channel: 'delivery', table_id: null, guests: 1 }),
      local('OrderOpened', c, { channel: 'dine_in', table_id: table, guests: 2 }),
      brand('ProductSoldOut', x),
      brand('ProductAvailable', x),
    ])
    expect(seenSet.map((v) => v.status.channel).sort()).toEqual(['delivery', 'dine_in', 'takeout'])
    expect(seenSet.map((v) => v.status.id)).not.toContain(x)
    expect(seenSet.find((v) => v.status.channel === 'dine_in')?.status.tableId).toBe(table)
    expect(seenSet.filter((v) => v.status.tableId === null)).toHaveLength(2)
  })
})
