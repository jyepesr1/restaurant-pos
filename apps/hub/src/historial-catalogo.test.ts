import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { type Autor, actualizarVersionado, insertarVersionado } from './acceso/registros'
import { HistorialCatalogo, revisorPrecios } from './precios'
import { montarCarta } from './pruebas-catalogo'

// El historial del catálogo y la revisión del precio copiado cuando el catálogo cambió entre la
// versión que vio el equipo y la que tiene el hub (docs/DINERO.md#precio-copiado).

const AUTOR: Autor = { userId: null, dispositivoId: null }

function montar() {
  const m = montarCarta()
  const historial = new HistorialCatalogo(m.db, m.restauranteId)
  const patch = (tableName: string, id: string, fields: Record<string, string | number | null>) => {
    actualizarVersionado(m.db, tableName, m.restauranteId, id, fields, AUTOR, m.clock())
    return historial.versionActual()
  }
  const crear = (tableName: string, fields: Record<string, string | number | null>) => {
    const id = insertarVersionado(m.db, tableName, m.restauranteId, fields, AUTOR, m.clock())
    return { id, version: historial.versionActual() }
  }
  const data = (p: ReturnType<typeof m.product>, fields: Record<string, unknown> = {}) => ({
    item_id: newId(),
    product_id: p.id,
    variant_id: null as string | null,
    name: p.name,
    unit_price: p.price,
    tax_type: p.tax.type,
    rate: p.tax.rate,
    quantity: 1,
    guest: null,
    course: null,
    modifiers: [] as { modifier_id: string; name: string; extra_price: number }[],
    notes: null,
    catalog_version: historial.versionActual(),
    price_channel_id: null,
    ...fields,
  })
  const variance = (d: ReturnType<typeof data>) =>
    historial.variance({ type: 'ItemAdded', data: d } as Parameters<
      HistorialCatalogo['variance']
    >[0])
  return { ...m, historial, patch, crear, data, variance }
}

describe('historial con muchos cambios del mismo registro', () => {
  it('cada versión devuelve el precio que tenía, y entre versiones el último anterior', () => {
    const m = montar()
    const burrata = m.product('Burrata Spritz')
    const versiones: { version: number; price: number }[] = [
      { version: m.historial.versionActual(), price: burrata.price },
    ]
    for (let i = 1; i <= 300; i++) {
      const price = burrata.price + i * 100
      versiones.push({ version: m.patch('products', burrata.id, { price }), price })
      // Un cambio de otro registro en medio: la versión avanza sin tocar la burrata.
      if (i % 7 === 0) m.crear('stations', { name: `Estación ${i}`, position: i })
    }
    for (const { version, price } of versiones)
      expect(m.historial.estadoEn('products', burrata.id, version)?.price, `v${version}`).toBe(
        price,
      )
    // Una versión entre dos cambios del producto vale lo del cambio anterior.
    const [a, b] = [versiones[7], versiones[8]]
    if (!a || !b) throw new Error('falta')
    for (let v = a.version; v < b.version; v++)
      expect(m.historial.estadoEn('products', burrata.id, v)?.price).toBe(a.price)
  })

  it('cada fila guarda como "antes" el "después" de la anterior y las versiones solo suben', () => {
    const m = montar()
    const burrata = m.product('Burrata Spritz')
    for (let i = 1; i <= 120; i++) m.patch('products', burrata.id, { price: 1_000 + i })
    const rows = m.db
      .prepare('SELECT * FROM catalog_changes WHERE record_id = ? ORDER BY version')
      .all(burrata.id)
    expect(rows).toHaveLength(121)
    expect(rows[0]?.before).toBeNull()
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.before).toBe(rows[i - 1]?.after)
      expect(Number(rows[i]?.version)).toBeGreaterThan(Number(rows[i - 1]?.version))
    }
    const allRows = m.db.prepare('SELECT version FROM catalog_changes').all()
    expect(new Set(allRows.map((f) => f.version)).size).toBe(allRows.length)
  })

  it('antes de que el registro existiera no hay estado', () => {
    const m = montar()
    const { id, version } = m.crear('stations', { name: 'Nueva', position: 9 })
    expect(m.historial.estadoEn('stations', id, version - 1)).toBeUndefined()
    expect(m.historial.estadoEn('stations', id, 0)).toBeUndefined()
    expect(m.historial.estadoEn('stations', id, version)?.name).toBe('Nueva')
    expect(m.historial.estadoEn('stations', newId(), version)).toBeUndefined()
    // Con la entidad equivocada, el mismo id no existe.
    expect(m.historial.estadoEn('products', id, version)).toBeUndefined()
  })

  it('los registros de otro restaurante no se mezclan', () => {
    const m = montar()
    const other = new HistorialCatalogo(m.db, newId())
    const burrata = m.product('Burrata Spritz')
    expect(other.estadoEn('products', burrata.id, m.historial.versionActual())).toBeUndefined()
    expect(other.versionActual()).toBe(0)
  })

  it('el historial con el catálogo migrado coincide con lo que tiene cada tabla hoy', () => {
    const m = montar()
    for (const p of m.catalog().categories.flatMap((c) => c.products)) {
      const row = m.db.prepare('SELECT * FROM products WHERE id = ?').get(p.id)
      expect(m.historial.estadoEn('products', p.id, m.historial.versionActual())).toEqual(row)
    }
  })
})

describe('precio_distinto con el catálogo cambiado después', () => {
  it('una variante archivada después: el ítem viejo cuadra, el nuevo ya no', () => {
    const m = montar()
    const vino = m.product('Ramón Bilbao Crianza')
    const [glass, bottle] = vino.variants
    if (!glass || !bottle) throw new Error('falta')
    const oldOne = (extra = {}) =>
      m.data(vino, { variant_id: bottle.id, unit_price: bottle.price, ...extra })
    const versionVieja = m.historial.versionActual()
    expect(m.variance(oldOne())).toBeNull()

    const v = m.patch('variants', bottle.id, { active: 0 })
    // El equipo que seguía con la carta de antes vendió la botella: cuadra con su versión.
    expect(m.variance(oldOne({ catalog_version: versionVieja }))).toBeNull()
    // Con la versión en la que ya estaba archivada, la botella no existe.
    expect(m.variance(oldOne({ catalog_version: v }))).toMatch(/sin elegir una de sus opciones/)
    // La copa sigue.
    expect(
      m.variance(
        m.data(vino, { variant_id: glass.id, unit_price: glass.price, catalog_version: v }),
      ),
    ).toBeNull()
  })

  it('archivar todas las variantes: el producto vuelve a venderse sin opción', () => {
    const m = montar()
    const vino = m.product('Ramón Bilbao Crianza')
    let v = 0
    for (const variant of vino.variants) v = m.patch('variants', variant.id, { active: 0 })
    expect(m.variance(m.data(vino, { catalog_version: v }))).toBeNull()
    expect(
      m.variance(m.data(vino, { variant_id: vino.variants[0]?.id, catalog_version: v })),
    ).toMatch(/opción que el producto no tiene/)
  })

  it('una variante que cambió de precio entre versiones', () => {
    const m = montar()
    const vino = m.product('Ramón Bilbao Crianza')
    const bottle = vino.variants[1]
    if (!bottle) throw new Error('falta')
    const before = m.historial.versionActual()
    const after = m.patch('variants', bottle.id, { price: bottle.price + 10_000 })
    const item = (price: number, catalog_version: number) =>
      m.data(vino, { variant_id: bottle.id, unit_price: price, catalog_version })
    expect(m.variance(item(bottle.price, before))).toBeNull()
    expect(m.variance(item(bottle.price + 10_000, before))).toMatch(/la carta decía/)
    expect(m.variance(item(bottle.price, after))).toMatch(/la carta decía/)
    expect(m.variance(item(bottle.price + 10_000, after))).toBeNull()
  })

  it('una variante creada después: con la versión vieja el producto no pedía opción', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    const before = m.historial.versionActual()
    const newOne = m.crear('variants', {
      product_id: pizza.id,
      name: 'Familiar',
      price: 90_000,
      position: 0,
    })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: newOne.version }))).toMatch(
      /sin elegir una de sus opciones/,
    )
    expect(
      m.variance(
        m.data(pizza, {
          catalog_version: newOne.version,
          variant_id: newOne.id,
          unit_price: 90_000,
        }),
      ),
    ).toBeNull()
    // La variante todavía no existía en la versión vieja.
    expect(
      m.variance(
        m.data(pizza, { catalog_version: before, variant_id: newOne.id, unit_price: 90_000 }),
      ),
    ).toMatch(/opción que el producto no tiene/)
  })

  it('un modificador que cambió de precio entre versiones', () => {
    const m = montar()
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    if (!option) throw new Error('falta')
    const before = m.historial.versionActual()
    const after = m.patch('modifiers', option.id, {
      extra_price: option.extraPrice + 2_500,
    })
    const item = (extra: number, catalog_version: number) =>
      m.data(tagliata, {
        catalog_version,
        modifiers: [{ modifier_id: option.id, name: option.name, extra_price: extra }],
      })
    expect(m.variance(item(option.extraPrice, before))).toBeNull()
    expect(m.variance(item(option.extraPrice, after))).toMatch(/La opción «.+» se cobró/)
    expect(m.variance(item(option.extraPrice + 2_500, after))).toBeNull()
    expect(m.variance(item(option.extraPrice + 2_500, before))).toMatch(/La opción «.+» se cobró/)
  })

  it('un modificador archivado después ya no estaba en la carta; antes sí', () => {
    const m = montar()
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    if (!option) throw new Error('falta')
    const before = m.historial.versionActual()
    const after = m.patch('modifiers', option.id, { active: 0 })
    const item = (catalog_version: number) =>
      m.data(tagliata, {
        catalog_version,
        modifiers: [{ modifier_id: option.id, name: option.name, extra_price: option.extraPrice }],
      })
    expect(m.variance(item(before))).toBeNull()
    expect(m.variance(item(after))).toMatch(/no estaba en la carta/)
  })

  it('un impuesto cambiado: la tarifa vieja vale con la versión vieja', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    const impuestoId = String(
      m.db.prepare('SELECT tax_id FROM products WHERE id = ?').get(pizza.id)?.tax_id,
    )
    const before = m.historial.versionActual()
    const after = m.patch('taxes', impuestoId, { rate: pizza.tax.rate + 100 })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: after }))).toMatch(/impuesto/)
    expect(
      m.variance(m.data(pizza, { catalog_version: after, rate: pizza.tax.rate + 100 })),
    ).toBeNull()
  })

  it('un producto que cambió de impuesto (otro registro) también se detecta', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    const exempt = m.crear('taxes', { name: 'Exento', type: 'exempt', rate: 0 })
    const before = m.historial.versionActual()
    const after = m.patch('products', pizza.id, { tax_id: exempt.id })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: after }))).toMatch(/impuesto/)
    expect(
      m.variance(m.data(pizza, { catalog_version: after, tax_type: 'exempt', rate: 0 })),
    ).toBeNull()
  })

  it('el tipo de impuesto distinto con la misma tarifa tampoco cuadra', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    const otroTipo = pizza.tax.type === 'inc' ? 'iva' : 'inc'
    expect(m.variance(m.data(pizza, { tax_type: otroTipo }))).toMatch(/impuesto/)
  })

  it('un producto creado después de la versión del ítem no estaba en la carta', () => {
    const m = montar()
    const base = m.product('Burrata Spritz')
    const tax = String(
      m.db.prepare('SELECT tax_id FROM products WHERE id = ?').get(base.id)?.tax_id,
    )
    const category = String(
      m.db.prepare('SELECT category_id FROM products WHERE id = ?').get(base.id)?.category_id,
    )
    const before = m.historial.versionActual()
    const fresh = m.crear('products', {
      category_id: category,
      name: 'Postre nuevo',
      price: 15_000,
      tax_id: tax,
    })
    const comoLoVeria = (catalog_version: number) => ({
      ...m.data(base, { catalog_version }),
      product_id: fresh.id,
      name: 'Postre nuevo',
      unit_price: 15_000,
    })
    expect(m.variance(comoLoVeria(before))).toMatch(/no estaba en la carta/)
    expect(m.variance(comoLoVeria(fresh.version - 1))).toMatch(/no estaba en la carta/)
    expect(m.variance(comoLoVeria(fresh.version))).toBeNull()
  })

  it('archivado y reactivado: cuadra antes y después, no en el hueco', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    const before = m.historial.versionActual()
    const archived = m.patch('products', pizza.id, { active: 0 })
    const reactivado = m.patch('products', pizza.id, { active: 1 })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: archived }))).toMatch(
      /no estaba en la carta/,
    )
    expect(m.variance(m.data(pizza, { catalog_version: reactivado }))).toBeNull()
  })

  it('una versión del futuro que el hub no tiene se marca, sea cual sea el producto', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    const futura = m.historial.versionActual() + 1
    expect(m.variance(m.data(pizza, { catalog_version: futura }))).toMatch(/versión del catálogo/)
    expect(m.variance(m.data(pizza, { catalog_version: Number.MAX_SAFE_INTEGER }))).toMatch(
      /versión del catálogo/,
    )
  })

  it('un producto_id que en realidad es otra cosa del catálogo se marca', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    const vino = m.product('Ramón Bilbao Crianza')
    const variant = vino.variants[0]
    const group = m.product('Tagliata di Manzo').groups[0]
    if (!variant || !group) throw new Error('falta')
    for (const id of [variant.id, group.id, group.options[0]?.id, newId()])
      expect(m.variance(m.data(pizza, { product_id: id })), String(id)).not.toBeNull()
  })

  it('con un modificador repetido', () => {
    const m = montar()
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    if (!option) throw new Error('falta')
    const mod = {
      modifier_id: option.id,
      name: option.name,
      extra_price: option.extraPrice,
    }
    expect(m.variance(m.data(tagliata, { modifiers: [mod] }))).toBeNull()
    expect(m.variance(m.data(tagliata, { modifiers: [mod, mod] }))).toMatch(/viene dos veces/)
  })

  it('revisorPrecios solo mira los ItemAgregado', () => {
    const m = montar()
    const revisor = revisorPrecios(m.db, m.restauranteId)
    const pizza = m.product('Burrata Spritz')
    const badCase = m.data(pizza, { unit_price: 1 })
    expect(revisor.revisar({ type: 'ItemAdded', data: badCase } as never)).toMatch(/la carta decía/)
    expect(revisor.revisar({ type: 'OrderOpened', data: {} } as never)).toBeNull()
  })

  it('un ítem con 200 cambios de precio después sigue comparando contra su versión', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    const vistaPorElEquipo = m.historial.versionActual()
    for (let i = 1; i <= 200; i++) m.patch('products', pizza.id, { price: pizza.price + i })
    expect(m.variance(m.data(pizza, { catalog_version: vistaPorElEquipo }))).toBeNull()
    expect(m.variance(m.data(pizza))).toMatch(/la carta decía/)
  })

  it('un precio especial (precio_canal_id) se marca: todavía no existen', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    expect(m.variance(m.data(pizza, { price_channel_id: newId() }))).toMatch(/precio especial/)
  })

  it('un impuesto archivado después no cuadra con la versión nueva, sí con la vieja', () => {
    const m = montar()
    const pizza = m.product('Burrata Spritz')
    const impuestoId = String(
      m.db.prepare('SELECT tax_id FROM products WHERE id = ?').get(pizza.id)?.tax_id,
    )
    const before = m.historial.versionActual()
    const after = m.patch('taxes', impuestoId, { active: 0 })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: after }))).toMatch(/impuesto/)
  })

  it('una opción de un grupo archivado, o de un producto que no tiene ese grupo, se marca', () => {
    const m = montar()
    const tagliata = m.product('Tagliata di Manzo')
    const group = tagliata.groups[0]
    const option = group?.options[0]
    if (!group || !option) throw new Error('falta')
    const conOpcion = (p: ReturnType<typeof m.product>, catalog_version?: number) =>
      m.data(p, {
        ...(catalog_version === undefined ? {} : { catalog_version }),
        modifiers: [{ modifier_id: option.id, name: option.name, extra_price: option.extraPrice }],
      })
    // De otro producto.
    expect(m.variance(conOpcion(m.product('Burrata Spritz')))).toMatch(/no es de/)
    // Del grupo archivado después: antes valía.
    const before = m.historial.versionActual()
    const after = m.patch('modifier_groups', group.id, { active: 0 })
    expect(m.variance(conOpcion(tagliata, before))).toBeNull()
    expect(m.variance(conOpcion(tagliata, after))).toMatch(/no es de/)
  })

  it('una opción cuyo enlace con el producto se archivó después valía con la versión anterior', () => {
    const m = montar()
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    if (!option) throw new Error('falta')
    const enlace = String(
      m.db.prepare('SELECT id FROM product_modifier_groups WHERE product_id = ?').get(tagliata.id)
        ?.id,
    )
    const before = m.historial.versionActual()
    const after = m.patch('product_modifier_groups', enlace, { active: 0 })
    const item = (catalog_version: number) =>
      m.data(tagliata, {
        catalog_version,
        modifiers: [{ modifier_id: option.id, name: option.name, extra_price: option.extraPrice }],
      })
    expect(m.variance(item(before))).toBeNull()
    expect(m.variance(item(after))).toMatch(/no es de/)
  })
})

describe('historial_desde: lo anterior a la migración', () => {
  it('antes de esa versión se usa el estado más viejo conocido, no "no existía"', () => {
    const m = montar()
    const burrata = m.product('Burrata Spritz')
    const creada = Number(
      m.db
        .prepare('SELECT version FROM catalog_changes WHERE record_id = ? AND before IS NULL')
        .get(burrata.id)?.version,
    )
    const v = m.patch('products', burrata.id, { price: burrata.price + 500 })
    // Sin `historial_desde`, una versión anterior a su alta no lo conoce.
    expect(m.historial.estadoEn('products', burrata.id, creada - 1)).toBeUndefined()
    // La migración de una base vieja deja ese contador: lo anterior toma el estado más viejo.
    m.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'history_since', ?)")
      .run(m.restauranteId, v)
    expect(m.historial.estadoEn('products', burrata.id, creada - 1)?.price).toBe(burrata.price)
    expect(m.historial.estadoEn('products', burrata.id, v - 1)?.price).toBe(burrata.price)
    // Desde esa versión ya hay historial completo.
    expect(m.historial.estadoEn('products', burrata.id, v)?.price).toBe(burrata.price + 500)
    // Lo que no existe en ninguna versión sigue sin existir.
    expect(m.historial.estadoEn('products', newId(), creada - 1)).toBeUndefined()
    // Un ítem de la versión vieja cuadra con el precio viejo.
    expect(m.variance(m.data(burrata, { catalog_version: creada - 1 }))).toBeNull()
  })
})
