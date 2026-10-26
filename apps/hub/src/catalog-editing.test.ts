import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertVersioned } from './access/records'
import { setupAccess } from './access/setup'
import { readCatalog } from './catalog'
import { CatalogHistory } from './prices'
import { readMenu } from './seed/menu'
import { seed } from './seed/seed'
import { createAppServer } from './server'

// Editing the catalog from the register: permissions, all or nothing, history and device alerts.

const MENU = readMenu(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

async function setup() {
  const m = setupAccess()
  seed(
    m.db,
    m.access,
    { restaurantId: m.restaurantId, roles: m.roles, menu: MENU, withoutStaff: true },
    m.clock(),
  )
  const alerts: number[] = []
  const app = createAppServer({
    access: m.access,
    catalog: {
      db: m.db,
      restaurantId: m.restaurantId,
      access: m.access,
      onChange: (v) => alerts.push(v),
      clock: m.clock,
    },
  })
  await app.ready()
  const register = m.pair('register')
  const sessionOf = (who: keyof typeof m.people) => {
    const s = m.signIn(register.connection, who)
    return { session_id: s.sessionId, secret: s.secret }
  }
  const edit = async (session: { session_id: string; secret: string }, changes: unknown[]) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${register.token}` },
      payload: { ...session, changes },
    })
    return { code: r.statusCode, body: r.json() }
  }
  const catalog = () => readCatalog(m.db, m.restaurantId)
  const products = () => catalog().categories.flatMap((c) => c.products)
  const taxId = String(m.db.prepare('SELECT id FROM taxes LIMIT 1').get()?.id)
  const categoryId = catalog().categories[0]?.id as string
  return {
    ...m,
    app,
    alerts,
    register,
    sessionOf,
    edit,
    catalog,
    products,
    taxId,
    categoryId,
  }
}

describe('POST /api/catalog/changes', () => {
  it('the manager creates a product with glass and bottle and a modifier group, in a single step', async () => {
    const m = await setup()
    const before = m.catalog().version
    const product = newId()
    const group = newId()
    const r = await m.edit(m.sessionOf('manager'), [
      {
        entity: 'products',
        id: product,
        data: {
          category_id: m.categoryId,
          name: 'Prosecco de la casa',
          description: null,
          price: 18_000,
          tax_id: m.taxId,
          favorite: false,
          active: true,
        },
      },
      {
        entity: 'variants',
        id: newId(),
        data: { product_id: product, name: 'Copa', price: 18_000, position: 0, active: true },
      },
      {
        entity: 'variants',
        id: newId(),
        data: { product_id: product, name: 'Botella', price: 95_000, position: 1, active: true },
      },
      {
        entity: 'modifier_groups',
        id: group,
        data: { name: 'Hielo', minimum: 0, maximum: 1, active: true },
      },
      {
        entity: 'modifiers',
        id: newId(),
        data: { group_id: group, name: 'Con hielo', extra_price: 0, position: 0, active: true },
      },
      {
        entity: 'product_modifier_groups',
        id: newId(),
        data: { product_id: product, group_id: group, position: 0, active: true },
      },
    ])
    expect(r.code).toBe(200)
    expect(r.body.version).toBeGreaterThan(before)
    expect(m.alerts).toEqual([r.body.version])
    const fresh = m.products().find((p) => p.id === product)
    expect(fresh?.variants.map((v) => [v.name, v.price])).toEqual([
      ['Copa', 18_000],
      ['Botella', 95_000],
    ])
    expect(fresh?.groups.map((g) => g.name)).toEqual(['Hielo'])
    // It went into the history with who did it.
    const change = m.db
      .prepare('SELECT user_id, before FROM catalog_changes WHERE record_id = ?')
      .get(product)
    expect(change).toEqual({ user_id: m.people.manager.userId, before: null })
  })

  it('changing a price bumps the version and the history keeps the previous one', async () => {
    const m = await setup()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('missing')
    const before = m.catalog().version
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: burrata.id, data: { price: burrata.price + 1_000 } },
    ])
    expect(r.code).toBe(200)
    const history = new CatalogHistory(m.db, m.restaurantId)
    expect(history.stateIn('products', burrata.id, before)?.price).toBe(burrata.price)
    expect(history.stateIn('products', burrata.id, r.body.version)?.price).toBe(
      burrata.price + 1_000,
    )
  })

  it("archiving removes it from the devices' menu, but the editor still sees it", async () => {
    const m = await setup()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('missing')
    expect(
      (
        await m.edit(m.sessionOf('manager'), [
          { entity: 'products', id: burrata.id, data: { active: false } },
        ])
      ).code,
    ).toBe(200)
    expect(m.products().some((p) => p.id === burrata.id)).toBe(false)
    const editView = await m.app.inject({
      method: 'GET',
      url: '/api/catalog/editing',
      headers: { authorization: `Bearer ${m.register.token}` },
    })
    const archived = editView.json().products.find((p: { id: string }) => p.id === burrata.id)
    expect(archived).toMatchObject({ active: false, price: burrata.price })
  })

  it('all or nothing: one invalid change leaves none applied', async () => {
    const m = await setup()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('missing')
    const before = m.catalog().version
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: burrata.id, data: { price: 1 } },
      {
        entity: 'modifier_groups',
        id: newId(),
        data: { name: 'Malo', minimum: 3, maximum: 1, active: true },
      },
    ])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/Cambio 2/)
    expect(m.catalog().version).toBe(before)
    expect(m.products().find((p) => p.id === burrata.id)?.price).toBe(burrata.price)
    expect(m.alerts).toEqual([])
  })

  it.each([
    ['price with decimals', { price: 1000.5 }],
    ['negative price', { price: -1 }],
    ['unknown field', { cost: 5 }],
    ['category that does not exist', { category_id: newId() }],
    ['nothing to change', {}],
  ])('rejects %s', async (_case, data) => {
    const m = await setup()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    const r = await m.edit(m.sessionOf('manager'), [{ entity: 'products', id: burrata?.id, data }])
    expect(r.code).toBe(400)
  })

  it('a new product requires all its fields; an exempt tax has no rate', async () => {
    const m = await setup()
    expect(
      (
        await m.edit(m.sessionOf('manager'), [
          { entity: 'products', id: newId(), data: { name: 'Sin precio' } },
        ])
      ).code,
    ).toBe(400)
    expect(
      (
        await m.edit(m.sessionOf('manager'), [
          {
            entity: 'taxes',
            id: newId(),
            data: { name: 'Exento', type: 'exempt', rate: 800, active: true },
          },
        ])
      ).code,
    ).toBe(400)
  })

  it('the waiter and the cashier do not edit; without a valid session, 401', async () => {
    const m = await setup()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    const change = [{ entity: 'products', id: burrata?.id, data: { price: 1_000 } }]
    expect((await m.edit(m.sessionOf('waiter'), change)).code).toBe(403)
    expect((await m.edit(m.sessionOf('cashier'), change)).code).toBe(403)
    const session = m.sessionOf('manager')
    expect((await m.edit({ ...session, secret: 'x' }, change)).code).toBe(401)
    const withoutToken = await m.app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      payload: { ...session, changes: change },
    })
    expect(withoutToken.statusCode).toBe(401)
  })

  it('with only `edit_prices`, prices change and nothing else', async () => {
    const m = await setup()
    insertVersioned(
      m.db,
      'role_permissions',
      m.restaurantId,
      { role_id: m.roles.cashier, permission: 'edit_prices' },
      { userId: null, deviceId: null },
      m.clock(),
    )
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('missing')
    const session = m.sessionOf('cashier')
    expect(
      (await m.edit(session, [{ entity: 'products', id: burrata.id, data: { price: 50_000 } }]))
        .code,
    ).toBe(200)
    expect(
      (await m.edit(session, [{ entity: 'products', id: burrata.id, data: { name: 'Otra' } }]))
        .code,
    ).toBe(403)
    // Creating a product is not "prices only", even if it has a price.
    expect(
      (await m.edit(session, [{ entity: 'products', id: newId(), data: { price: 1 } }])).code,
    ).toBe(403)
  })

  it('the seed does not overwrite what a person edited', async () => {
    const m = await setup()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('missing')
    await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: burrata.id, data: { price: 77_000 } },
    ])
    seed(
      m.db,
      m.access,
      { restaurantId: m.restaurantId, roles: m.roles, menu: MENU, withoutStaff: true },
      m.clock(),
    )
    expect(m.products().find((p) => p.id === burrata.id)?.price).toBe(77_000)
  })

  it('it does not allow pointing to something archived or archiving what is in use', async () => {
    const m = await setup()
    const g = m.sessionOf('manager')
    const category = m.catalog().categories[0]
    if (!category) throw new Error('missing')
    // Archiving a category with active products: no (they would disappear from the menu).
    const r1 = await m.edit(g, [{ entity: 'categories', id: category.id, data: { active: false } }])
    expect(r1.code).toBe(400)
    expect(r1.body.message).toMatch(/lo usan \d+ productos/)
    // Archiving everyone's tax: not that either.
    const r2 = await m.edit(g, [{ entity: 'taxes', id: m.taxId, data: { active: false } }])
    expect(r2.code).toBe(400)
    // Yes, if its products are archived first in the same request.
    const r3 = await m.edit(g, [
      ...category.products.map((p) => ({
        entity: 'products',
        id: p.id,
        data: { active: false },
      })),
      { entity: 'categories', id: category.id, data: { active: false } },
    ])
    expect(r3.code).toBe(200)
    // A new product in that archived category: no.
    const r4 = await m.edit(g, [
      {
        entity: 'products',
        id: newId(),
        data: {
          category_id: category.id,
          name: 'Nuevo',
          description: null,
          price: 1_000,
          tax_id: m.taxId,
          favorite: false,
          active: true,
        },
      },
    ])
    expect(r4.code).toBe(400)
    expect(r4.body.message).toMatch(/category está archivado/)
  })

  it('archiving a group removes it from its products', async () => {
    const m = await setup()
    const tagliata = m.products().find((p) => p.name === 'Tagliata di Manzo')
    const group = tagliata?.groups[0]
    if (!group) throw new Error('missing')
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'modifier_groups', id: group.id, data: { active: false } },
    ])
    expect(r.code).toBe(200)
    expect(m.products().find((p) => p.name === 'Tagliata di Manzo')?.groups).toEqual([])
  })

  it('repeating the same thing neither bumps the version nor alerts; a parent does not change; an id does not change type', async () => {
    const m = await setup()
    const g = m.sessionOf('manager')
    const wine = m.products().find((p) => p.name === 'Ramón Bilbao Crianza')
    const glass = wine?.variants[0]
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!wine || !glass || !burrata) throw new Error('missing')
    const before = m.catalog().version
    const equal = await m.edit(g, [
      { entity: 'products', id: wine.id, data: { price: wine.price } },
    ])
    expect(equal.body).toEqual({ version: before, changedCount: 0 })
    expect(m.alerts).toEqual([])
    const move = await m.edit(g, [
      { entity: 'variants', id: glass.id, data: { product_id: burrata.id } },
    ])
    expect(move.code).toBe(400)
    const disguised = await m.edit(g, [
      { entity: 'stations', id: glass.id, data: { name: 'X', position: 0, active: true } },
    ])
    expect(disguised.code).toBe(400)
    expect(disguised.body.message).toMatch(/otro tipo/)
  })

  it('database rules are explained in words, without the SQLite text', async () => {
    const m = await setup()
    const tagliata = m.products().find((p) => p.name === 'Tagliata di Manzo')
    const group = tagliata?.groups[0]
    if (!group) throw new Error('missing')
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'modifier_groups', id: group.id, data: { minimum: 3 } },
    ])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/máximo debe ser al menos 1 y no menor que el mínimo/)
    expect(r.body.message).not.toMatch(/constraint/i)
  })
})
