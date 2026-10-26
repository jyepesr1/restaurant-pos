import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
import type { BaseSqlite } from '@pos/db'
import { afterEach, describe, expect, it } from 'vitest'
import { ABRIR, hubEnCarpeta, montarHub } from '../acceso/montaje-hub'
import { leerCarta } from './carta'
import { sembrar } from './sembrar'

// El pedido usa lo que sembró la tarea 0.8: cada ítem copia producto, precio, impuesto y
// modificadores del catálogo y viaja por el hub de sincronización con su `catalog_version`.

const TEXTO_CARTA = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const AHORA = '2026-10-24T20:00:00.000Z'

const makeOne = (db: BaseSqlite, sql: string, ...p: string[]) => {
  const fila = db.prepare(sql).get(...p)
  if (!fila) throw new Error(`Sin resultado: ${sql}`)
  return fila
}
const versionCatalogo = (db: BaseSqlite) =>
  Number(makeOne(db, "SELECT value FROM counters WHERE name = 'catalog'").value)

/** El ítem que armaría la app al tocar ese producto: todo copiado de la base sembrada. */
function itemDelCatalogo(
  db: BaseSqlite,
  product: string,
  options: { variant?: string; modifiers?: string[] } = {},
) {
  const p = makeOne(
    db,
    `SELECT p.id, p.name, p.price, i.type, i.rate FROM products p
     JOIN taxes i ON i.id = p.tax_id WHERE p.name = ? AND p.active = 1`,
    product,
  )
  const v = options.variant
    ? makeOne(
        db,
        'SELECT id, price FROM variants WHERE product_id = ? AND name = ?',
        String(p.id),
        options.variant,
      )
    : null
  const modifiers = (options.modifiers ?? []).map((name) => {
    const m = makeOne(
      db,
      `SELECT m.id, m.name, m.extra_price FROM modifiers m
       JOIN product_modifier_groups pg ON pg.group_id = m.group_id
       WHERE pg.product_id = ? AND m.name = ?`,
      String(p.id),
      name,
    )
    return {
      modifier_id: String(m.id),
      name: String(m.name),
      extra_price: Number(m.extra_price),
    }
  })
  return {
    item_id: newId(),
    product_id: String(p.id),
    variant_id: v ? String(v.id) : null,
    name: options.variant ? `${product} (${options.variant})` : product,
    unit_price: Number(v ? v.price : p.price),
    tax_type: String(p.type) as 'inc',
    rate: Number(p.rate),
    quantity: 1,
    guest: null,
    course: null,
    modifiers,
    notes: null,
    catalog_version: versionCatalogo(db),
    price_channel_id: null,
  }
}

function hubSembrado() {
  const m = montarHub()
  const r = sembrar(
    m.db,
    m.access,
    { restauranteId: m.restauranteId, roles: m.roles, menu: leerCarta(TEXTO_CARTA) },
    AHORA,
  )
  const pinMesero = r.pins.find((p) => p.name === 'Mesero 1')?.pin as string
  const { connection } = m.emparejar('waiter')
  const session = m.access.startSession(connection, pinMesero)
  if (!session.ok) throw new Error(session.message)
  return { m, connection, session, r }
}

describe('el pedido usa lo sembrado', () => {
  it('el mesero del seed entra con su PIN y agrega vino por botella, un plato sin opciones y un sabor', () => {
    const { m, connection, session } = hubSembrado()
    const order = newId()
    const bottle = itemDelCatalogo(m.db, 'Ramón Bilbao Crianza', { variant: 'Botella' })
    const glass = itemDelCatalogo(m.db, 'Ramón Bilbao Crianza', { variant: 'Copa' })
    const pizza = itemDelCatalogo(m.db, 'Quattro Formaggi')
    const te = itemDelCatalogo(m.db, 'Té Hatsu', { modifiers: ['Rojo'] })
    expect([bottle.unit_price, glass.unit_price, pizza.unit_price]).toEqual([
      129_900, 30_900, 44_900,
    ])
    expect(te.modifiers).toHaveLength(1)

    const en = { aggregate_id: order }
    const r = m.hub.recibirLote(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, en),
      ...[bottle, glass, pizza, te].map((it, i) =>
        m.event(connection, session, 'ItemAdded', it, { ...en, base_sequence: i + 1 }),
      ),
    ])
    expect(r.resultados.map((x) => x.status)).toEqual(Array(5).fill('confirmed'))

    const items = m.hub.order(order)?.items ?? {}
    expect(items[bottle.item_id]).toMatchObject({
      variantId: bottle.variant_id,
      unitPrice: 129_900,
      taxType: 'inc',
      rate: 800,
    })
    expect(items[pizza.item_id]).toMatchObject({
      productId: pizza.product_id,
      unitPrice: 44_900,
    })
    expect(items[te.item_id]?.modifiers).toEqual([
      expect.objectContaining({ name: 'Rojo', extraPrice: 0 }),
    ])
  })

  it('un plato con término lleva el término elegido como modificador sin costo', () => {
    const { m, connection, session } = hubSembrado()
    const order = newId()
    const burger = itemDelCatalogo(m.db, 'Spritz Burguer', { modifiers: ['Tres cuartos'] })
    const r = m.hub.recibirLote(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, { aggregate_id: order }),
      m.event(connection, session, 'ItemAdded', burger, {
        aggregate_id: order,
        base_sequence: 1,
      }),
    ])
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(m.hub.order(order)?.items[burger.item_id]?.modifiers[0]).toMatchObject({
      name: 'Tres cuartos',
      extraPrice: 0,
    })
  })

  it('el evento guardado conserva el `catalogo_version` con que se agregó, y una carta nueva no lo cambia', () => {
    const { m, connection, session } = hubSembrado()
    const order = newId()
    const before = itemDelCatalogo(m.db, 'Quattro Formaggi')
    m.hub.recibirLote(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, { aggregate_id: order }),
      m.event(connection, session, 'ItemAdded', before, { aggregate_id: order, base_sequence: 1 }),
    ])

    // El restaurante sube el precio: el seed corre otra vez y el contador avanza.
    sembrar(
      m.db,
      m.access,
      {
        restauranteId: m.restauranteId,
        roles: m.roles,
        menu: leerCarta(TEXTO_CARTA.replace('precio: 44900', 'precio: 46900')),
      },
      '2026-10-25T09:00:00.000Z',
    )
    const after = itemDelCatalogo(m.db, 'Quattro Formaggi')
    expect(after.catalog_version).toBeGreaterThan(before.catalog_version)
    expect(after.unit_price).toBe(46_900)
    expect(after.product_id).toBe(before.product_id)

    const r = m.hub.recibirLote(connection, [
      m.event(connection, session, 'ItemAdded', after, {
        aggregate_id: order,
        base_sequence: 2,
      }),
    ])
    expect(r.resultados[0]?.status).toBe('confirmed')

    const guardados = m.db
      .prepare("SELECT data FROM events WHERE type = 'ItemAdded' ORDER BY sequence")
      .all()
      .map((f) => JSON.parse(String(f.data)))
    expect(guardados.map((d) => [d.catalog_version, d.unit_price])).toEqual([
      [before.catalog_version, 44_900],
      [after.catalog_version, 46_900],
    ])
    // El ítem viejo conserva su precio: lo cobrado es lo que vio el cliente al pedir.
    expect(m.hub.order(order)?.items[before.item_id]?.unitPrice).toBe(44_900)
  })

  it('un ítem con precio de variante distinto al de otra variante no se mezcla: cada una lleva su ID', () => {
    const { m } = hubSembrado()
    const bottle = itemDelCatalogo(m.db, 'Ramón Bilbao Verdejo', { variant: 'Botella' })
    const glass = itemDelCatalogo(m.db, 'Ramón Bilbao Verdejo', { variant: 'Copa' })
    expect(bottle.product_id).toBe(glass.product_id)
    expect(bottle.variant_id).not.toBe(glass.variant_id)
    expect(bottle.unit_price).toBeGreaterThan(glass.unit_price)
  })
})

describe('el hub arranca después del seed', () => {
  let carpeta = ''
  afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

  it('reabrir la carpeta de datos deja todo intacto: mismo restaurante, mismos PIN y un seed sin cambios', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-seed-hub-'))
    const hubs = hubEnCarpeta(join(carpeta, 'data'))
    try {
      const a = hubs.spinUp()
      const r = sembrar(
        a.db,
        a.access,
        { restauranteId: a.restauranteId, roles: a.roles, menu: leerCarta(TEXTO_CARTA) },
        hubs.clock(),
      )
      const code = a.access.crearEmparejamiento(
        { pin: a.admin.pin as string, name: 'Celular', type: 'waiter' },
        null,
      )
      if (!code.ok) throw new Error(code.message)
      const emparejado = a.access.emparejar(code.code, '10.0.0.9')
      if (!emparejado.ok) throw new Error(emparejado.message)
      const token = emparejado.token
      const products = makeOne(a.db, 'SELECT count(*) AS n FROM products').n
      const versiones = versionCatalogo(a.db)
      hubs.apagar()
      hubs.avanzar(60_000)

      const b = hubs.spinUp()
      expect(b.restauranteId).toBe(a.restauranteId)
      expect(b.admin).toEqual({ pin: null, user: null, password: null, avisos: [] })
      expect(b.claveNueva).toBe(false)
      expect(makeOne(b.db, 'SELECT count(*) AS n FROM products').n).toBe(products)
      expect(makeOne(b.db, 'SELECT count(*) AS n FROM users WHERE active = 1').n).toBe(6)
      expect(makeOne(b.db, 'SELECT name FROM restaurants').name).toBe('La Spritzzería')
      expect(versionCatalogo(b.db)).toBe(versiones)

      // El equipo emparejado y el PIN de un mesero del seed siguen valiendo con el hub reiniciado.
      const connection = b.access.authenticate(token)
      expect(connection).not.toBeNull()
      const waiter = r.pins.find((p) => p.name === 'Mesero 2')?.pin as string
      expect(
        b.access.startSession(connection as NonNullable<typeof connection>, waiter),
      ).toMatchObject({
        ok: true,
      })

      // Y un seed nuevo no cambia nada.
      const another = sembrar(
        b.db,
        b.access,
        { restauranteId: b.restauranteId, roles: b.roles, menu: leerCarta(TEXTO_CARTA) },
        hubs.clock(),
      )
      for (const [tabla, changes] of Object.entries(another.sqlTables))
        expect({ tabla, created: changes.created, updated: changes.updated }).toEqual({
          tabla,
          created: 0,
          updated: 0,
        })
      expect(another.pins).toEqual([])
      expect(versionCatalogo(b.db)).toBe(versiones)
    } finally {
      hubs.apagar()
    }
  })
})
