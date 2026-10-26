import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
import { HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { actualizarVersionado } from './acceso/registros'
import { leerCatalogo } from './catalogo'
import { HistorialCatalogo, revisorPrecios } from './precios'
import { leerCarta } from './seed/carta'
import { seed } from './seed/sembrar'

// El precio copiado se compara con el catálogo en la versión que vio el equipo, sobre la carta
// real del piloto (docs/DINERO.md#precio-copiado).

const CARTA = leerCarta(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

function setup() {
  const m = montarAcceso()
  seed(
    m.db,
    m.access,
    { restaurantId: m.restaurantId, roles: m.roles, menu: CARTA, sinPersonal: true },
    m.clock(),
  )
  const catalog = leerCatalogo(m.db, m.restaurantId)
  const products = catalog.categories.flatMap((c) => c.products)
  const product = (name: string) => {
    const p = products.find((x) => x.name === name)
    if (!p) throw new Error(`No está ${name}`)
    return p
  }
  const history = new HistorialCatalogo(m.db, m.restaurantId)
  return { ...m, catalog, product, history }
}

type Setup = ReturnType<typeof setup>
type Product = ReturnType<Setup['product']>

const data = (m: Setup, p: Product, fields: Record<string, unknown> = {}) => ({
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
  catalog_version: m.catalog.version,
  price_channel_id: null,
  ...fields,
})

const item = (d: ReturnType<typeof data>) =>
  ({ type: 'ItemAdded', data: d }) as Parameters<HistorialCatalogo['variance']>[0]

describe('precio copiado contra el historial del catálogo', () => {
  it('un ítem igual a la carta no tiene diferencias', () => {
    const m = setup()
    expect(m.history.variance(item(data(m, m.product('Burrata Spritz'))))).toBeNull()
  })

  it('con copa y botella: exige la variante y su precio, no el del producto', () => {
    const m = setup()
    const vino = m.product('Ramón Bilbao Crianza')
    const [glass, bottle] = vino.variants as [Product['variants'][0], Product['variants'][0]]
    expect(m.history.variance(item(data(m, vino)))).toMatch(/sin elegir una de sus opciones/)
    const conBotella = data(m, vino, { variant_id: bottle.id, unit_price: bottle.price })
    expect(m.history.variance(item(conBotella))).toBeNull()
    // La botella cobrada al precio de la copa.
    const barata = data(m, vino, { variant_id: bottle.id, unit_price: glass.price })
    expect(m.history.variance(item(barata))).toMatch(/se cobró a \$/)
  })

  it('una variante en un producto sin variantes, o de otro producto, no cuadra', () => {
    const m = setup()
    const vino = m.product('Ramón Bilbao Crianza')
    const pizza = m.product('Burrata Spritz')
    const ajena = data(m, pizza, { variant_id: vino.variants[0]?.id })
    expect(m.history.variance(item(ajena))).toMatch(/opción que el producto no tiene/)
  })

  it('el precio, el impuesto y los extras se comparan', () => {
    const m = setup()
    const tagliata = m.product('Tagliata di Manzo')
    const termino = tagliata.groups[0]?.options[0]
    if (!termino) throw new Error('La Tagliata debe tener término')
    const conTermino = (extra_price: number) =>
      data(m, tagliata, {
        modifiers: [{ modifier_id: termino.id, name: termino.name, extra_price }],
      })
    expect(m.history.variance(item(conTermino(termino.extraPrice)))).toBeNull()
    expect(m.history.variance(item(conTermino(termino.extraPrice + 500)))).toMatch(
      /La opción «.+» se cobró/,
    )
    const otroImpuesto = data(m, tagliata, { rate: 1900 })
    expect(m.history.variance(item(otroImpuesto))).toMatch(/impuesto/)
    const masBarato = data(m, tagliata, { unit_price: tagliata.price - 100 })
    expect(m.history.variance(item(masBarato))).toMatch(/la carta decía/)
    const ghost = data(m, tagliata, {
      modifiers: [{ modifier_id: newId(), name: 'Trufa', extra_price: 0 }],
    })
    expect(m.history.variance(item(ghost))).toMatch(/no estaba en la carta/)
  })

  it('cuenta la versión que vio el equipo: el precio de antes vale con la versión de antes', () => {
    const m = setup()
    const burrata = m.product('Burrata Spritz')
    const before = m.catalog.version
    actualizarVersionado(
      m.db,
      'products',
      m.restaurantId,
      burrata.id,
      { price: burrata.price + 2_000 },
      { userId: null, deviceId: null },
      m.clock(),
    )
    const after = m.history.currentVersion()
    expect(after).toBeGreaterThan(before)
    // Equipo sin conexión con la carta vieja: su precio era el correcto.
    expect(m.history.variance(item(data(m, burrata)))).toBeNull()
    // Con la carta nueva, el precio viejo ya no cuadra.
    const late = data(m, burrata, { catalog_version: after })
    expect(m.history.variance(item(late))).toMatch(/la carta decía/)
    const fresh = data(m, burrata, {
      catalog_version: after,
      unit_price: burrata.price + 2_000,
    })
    expect(m.history.variance(item(fresh))).toBeNull()
  })

  it('un producto archivado o una versión que el hub no tiene no cuadran', () => {
    const m = setup()
    const burrata = m.product('Burrata Spritz')
    expect(
      m.history.variance(item(data(m, burrata, { catalog_version: m.catalog.version + 1 }))),
    ).toMatch(/versión del catálogo/)
    actualizarVersionado(
      m.db,
      'products',
      m.restaurantId,
      burrata.id,
      { active: 0 },
      { userId: null, deviceId: null },
      m.clock(),
    )
    const v = m.history.currentVersion()
    expect(m.history.variance(item(data(m, burrata, { catalog_version: v })))).toMatch(
      /no estaba en la carta/,
    )
    expect(m.history.variance(item(data(m, burrata, { catalog_version: 0 })))).toMatch(
      /no estaba en la carta/,
    )
  })

  it('una opción de otro producto, repetida o un precio especial no cuadran', () => {
    const m = setup()
    const tagliata = m.product('Tagliata di Manzo')
    const te = m.product('Té Hatsu')
    const flavor = te.groups[0]?.options[0]
    const termino = tagliata.groups[0]?.options[0]
    if (!flavor || !termino) throw new Error('falta')
    const mod = (o: { id: string; name: string; extraPrice: number }) => ({
      modifier_id: o.id,
      name: o.name,
      extra_price: o.extraPrice,
    })
    expect(m.history.variance(item(data(m, tagliata, { modifiers: [mod(flavor)] })))).toMatch(
      /no es de «Tagliata/,
    )
    expect(
      m.history.variance(item(data(m, tagliata, { modifiers: [mod(termino), mod(termino)] }))),
    ).toMatch(/dos veces/)
    expect(
      m.history.variance(
        item(data(m, tagliata, { modifiers: [mod(termino)], price_channel_id: newId() })),
      ),
    ).toMatch(/precio especial/)
  })

  it('un impuesto archivado no cuadra', () => {
    const m = setup()
    const burrata = m.product('Burrata Spritz')
    const tax = String(
      m.db.prepare('SELECT tax_id FROM products WHERE id = ?').get(burrata.id)?.tax_id,
    )
    actualizarVersionado(
      m.db,
      'taxes',
      m.restaurantId,
      tax,
      { active: 0 },
      { userId: null, deviceId: null },
      m.clock(),
    )
    const v = m.history.currentVersion()
    expect(m.history.variance(item(data(m, burrata, { catalog_version: v })))).toMatch(/impuesto/)
  })

  it('en el hub: el ítem con precio distinto se acepta y queda como conflicto', () => {
    const m = setup()
    const hub = new HubSync(new SqliteStore(m.db, m.restaurantId), {
      restaurantId: m.restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock: m.clock,
      access: {
        verify: () => ({ ok: true, authorizedById: null, authorizationId: null }),
        recordUse: () => {},
      },
      prices: revisorPrecios(m.db, m.restaurantId),
    })
    const { connection } = m.emparejar('waiter')
    const order = newId()
    const burrata = m.product('Burrata Spritz')
    const envelope = (type: string, d: unknown, base_sequence: number) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data: d,
      session_id: null,
      user_id: newId(),
      device_id: connection.deviceId,
      authorization_id: null,
      reason: null,
      device_time: m.clock(),
      hub_estimated_time: m.clock(),
      base_sequence,
    })
    const r = hub.receiveBatch(connection, [
      envelope('OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 }, 0),
      envelope('ItemAdded', data(m, burrata), 1),
      envelope('ItemAdded', data(m, burrata, { unit_price: 1_000 }), 1),
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(r.results.map((x) => (x as { conflict?: string | null }).conflict ?? null)).toEqual([
      null,
      null,
      'price_mismatch',
    ])
    expect(hub.conflicts()).toEqual([
      expect.objectContaining({
        type: 'price_mismatch',
        description: expect.stringMatching(/\$1\.000/),
      }),
    ])
  })
})
