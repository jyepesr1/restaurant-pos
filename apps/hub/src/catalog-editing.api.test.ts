import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { setupServer } from './catalog-fixtures'
import { CatalogHistory } from './prices'

// The catalog editing API at its edges: large batches, repeated links, archiving and
// reactivating, who can edit and which data is rejected.

const product = (m: Awaited<ReturnType<typeof setupServer>>, fields = {}) => ({
  category_id: m.categoryId,
  name: 'Prosecco de la casa',
  description: null,
  price: 18_000,
  tax_id: m.taxId,
  favorite: false,
  active: true,
  ...fields,
})
const group = (fields = {}) => ({ name: 'Hielo', minimum: 0, maximum: 1, active: true, ...fields })
const burrataOf = (m: Awaited<ReturnType<typeof setupServer>>) => m.product('Burrata Spritz')

describe('a large batch', () => {
  it('a product with variants and groups, with 200 changes in one request, is applied in full', async () => {
    const m = await setupServer()
    const before = m.catalog().version
    const rowsBefore = m.history().length
    const p = newId()
    const g = newId()
    const changes: unknown[] = [
      { entity: 'products', id: p, data: product(m) },
      { entity: 'modifier_groups', id: g, data: group({ maximum: 5 }) },
      {
        entity: 'product_modifier_groups',
        id: newId(),
        data: { product_id: p, group_id: g, position: 0, active: true },
      },
      {
        entity: 'variants',
        id: newId(),
        data: { product_id: p, name: 'Copa', price: 18_000, position: 0, active: true },
      },
      {
        entity: 'variants',
        id: newId(),
        data: { product_id: p, name: 'Botella', price: 95_000, position: 1, active: true },
      },
    ]
    for (let i = 0; changes.length < 200; i++)
      changes.push({
        entity: 'modifiers',
        id: newId(),
        data: {
          group_id: g,
          name: `Opción ${i}`,
          extra_price: i * 100,
          position: i,
          active: true,
        },
      })
    expect(changes).toHaveLength(200)

    const r = await m.edit(m.sessionOf('manager'), changes)
    expect(r.code).toBe(200)
    // Each record took its own version and all of them ended up in the history.
    expect(r.body.version).toBe(before + 200)
    expect(m.history()).toHaveLength(rowsBefore + 200)
    expect(m.alerts).toEqual([before + 200])
    const fresh = m.products().find((x) => x.id === p)
    expect(fresh?.variants).toHaveLength(2)
    expect(fresh?.groups[0]?.options).toHaveLength(195)
    // A single alert per request, not one per change.
    expect(m.alerts).toHaveLength(1)
  })

  it('201 changes are rejected without applying anything', async () => {
    const m = await setupServer()
    const before = m.catalog().version
    const rows = m.history().length
    const changes = Array.from({ length: 201 }, (_, i) => ({
      entity: 'stations',
      id: newId(),
      data: { name: `E${i}`, position: i, active: true },
    }))
    const r = await m.edit(m.sessionOf('manager'), changes)
    expect(r.code).toBe(400)
    expect(m.catalog().version).toBe(before)
    expect(m.history()).toHaveLength(rows)
    expect(m.alerts).toEqual([])
  })

  it('if change 200 of 200 fails, none of the previous 199 remains', async () => {
    const m = await setupServer()
    const before = m.catalog().version
    const rows = m.history().length
    const changes: unknown[] = Array.from({ length: 199 }, (_, i) => ({
      entity: 'stations',
      id: newId(),
      data: { name: `E${i}`, position: i, active: true },
    }))
    changes.push({ entity: 'products', id: newId(), data: { name: 'incompleto' } })
    const r = await m.edit(m.sessionOf('manager'), changes)
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/Cambio 200/)
    expect(m.catalog().version).toBe(before)
    // Not even the version counter moved: the transaction was fully rolled back.
    expect(m.history()).toHaveLength(rows)
    expect(m.db.prepare("SELECT 1 FROM stations WHERE name = 'E0'").get()).toBeUndefined()
  })
})

describe('the same product-group link', () => {
  const newLink = (p: string, g: string, id = newId()) => ({
    entity: 'product_modifier_groups',
    id,
    data: { product_id: p, group_id: g, position: 0, active: true },
  })

  it('twice with different ids in the same request: everything is rejected', async () => {
    const m = await setupServer()
    const before = m.catalog().version
    const rows = m.history().length
    const p = newId()
    const g = newId()
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: p, data: product(m) },
      { entity: 'modifier_groups', id: g, data: group() },
      newLink(p, g),
      newLink(p, g),
    ])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/Cambio 4/)
    // Neither the product nor the group was left half done.
    expect(m.products().some((x) => x.id === p)).toBe(false)
    expect(m.catalog().version).toBe(before)
    expect(m.history()).toHaveLength(rows)
  })

  it('twice with the same id: the second updates the first and a single link remains', async () => {
    const m = await setupServer()
    const p = newId()
    const g = newId()
    const link = newId()
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: p, data: product(m) },
      { entity: 'modifier_groups', id: g, data: group() },
      newLink(p, g, link),
      { entity: 'product_modifier_groups', id: link, data: { position: 3 } },
    ])
    expect(r.code).toBe(200)
    const rows = m.db
      .prepare('SELECT position FROM product_modifier_groups WHERE product_id = ?')
      .all(p)
    expect(rows).toEqual([{ position: 3 }])
    const history = m.db
      .prepare('SELECT count(*) AS n FROM catalog_changes WHERE record_id = ?')
      .get(link)
    expect(history?.n).toBe(2)
  })

  it('an existing link with a new id is rejected, also if the old one is archived', async () => {
    const m = await setupServer()
    const tagliata = m.product('Tagliata di Manzo')
    const groupId = tagliata.groups[0]?.id as string
    const session = m.sessionOf('manager')
    expect((await m.edit(session, [newLink(tagliata.id, groupId)])).code).toBe(400)

    const link = String(
      m.db
        .prepare('SELECT id FROM product_modifier_groups WHERE product_id = ? AND group_id = ?')
        .get(tagliata.id, groupId)?.id,
    )
    expect(
      (
        await m.edit(session, [
          { entity: 'product_modifier_groups', id: link, data: { active: false } },
        ])
      ).code,
    ).toBe(200)
    // The archived link must be reactivated, not another one created.
    expect((await m.edit(session, [newLink(tagliata.id, groupId)])).code).toBe(400)
    expect(
      (
        await m.edit(session, [
          { entity: 'product_modifier_groups', id: link, data: { active: true } },
        ])
      ).code,
    ).toBe(200)
    expect(m.product('Tagliata di Manzo').groups).toHaveLength(1)
  })

  it('a link to a nonexistent product or group is rejected', async () => {
    const m = await setupServer()
    const g = newId()
    const session = m.sessionOf('manager')
    expect((await m.edit(session, [newLink(newId(), g)])).code).toBe(400)
    const tagliata = m.product('Tagliata di Manzo')
    expect((await m.edit(session, [newLink(tagliata.id, newId())])).code).toBe(400)
  })

  it('referencing something created further down in the same request fails: order matters', async () => {
    const m = await setupServer()
    const p = newId()
    const r = await m.edit(m.sessionOf('manager'), [
      {
        entity: 'variants',
        id: newId(),
        data: { product_id: p, name: 'Copa', price: 1, position: 0, active: true },
      },
      { entity: 'products', id: p, data: product(m) },
    ])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/Cambio 1.*product_id no existe/)
  })
})

describe('archive and reactivate', () => {
  it('archiving removes the product from the menu and reactivating brings it back, with three history rows', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    const session = m.sessionOf('manager')
    const archive = await m.edit(session, [
      { entity: 'products', id: burrata.id, data: { active: false } },
    ])
    expect(archive.code).toBe(200)
    expect(m.products().some((x) => x.id === burrata.id)).toBe(false)

    const reactivate = await m.edit(session, [
      { entity: 'products', id: burrata.id, data: { active: true } },
    ])
    expect(reactivate.code).toBe(200)
    expect(reactivate.body.version).toBeGreaterThan(archive.body.version)
    expect(m.product('Burrata Spritz')).toEqual(burrata)

    const rows = m.db
      .prepare('SELECT version, after FROM catalog_changes WHERE record_id = ? ORDER BY version')
      .all(burrata.id)
    expect(rows.map((f) => JSON.parse(String(f.after)).active)).toEqual([1, 0, 1])
    const history = new CatalogHistory(m.db, m.restaurantId)
    expect(history.stateIn('products', burrata.id, archive.body.version)?.active).toBe(0)
    expect(history.stateIn('products', burrata.id, reactivate.body.version)?.active).toBe(1)
  })

  it('the editor sees archived items with active=false and current ones with active=true', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: burrata.id, data: { active: false } },
    ])
    const r = await m.editView()
    expect(r.statusCode).toBe(200)
    const body = r.json()
    const row = body.products.find((p: { id: string }) => p.id === burrata.id)
    expect(row.active).toBe(false)
    expect(typeof row.favorite).toBe('boolean')
    expect(body.products.some((p: { active: boolean }) => p.active)).toBe(true)
    expect(body.version).toBe(m.catalog().version)
    // The response does not include who or which restaurant.
    expect(row).not.toHaveProperty('restaurant_id')
    expect(row).not.toHaveProperty('user_id')
  })

  it('archiving and reactivating in a single request keeps the last word and two versions', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    const before = m.catalog().version
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: burrata.id, data: { active: false } },
      { entity: 'products', id: burrata.id, data: { active: true } },
    ])
    expect(r.code).toBe(200)
    expect(r.body.version).toBe(before + 2)
    expect(m.products().some((x) => x.id === burrata.id)).toBe(true)
  })

  it('archiving a variant removes it from the product and the menu; its history remains', async () => {
    const m = await setupServer()
    const wine = m.product('Ramón Bilbao Crianza')
    const bottle = wine.variants[1]
    if (!bottle) throw new Error('missing')
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'variants', id: bottle.id, data: { active: false } },
    ])
    expect(r.code).toBe(200)
    expect(m.product('Ramón Bilbao Crianza').variants.map((v) => v.id)).not.toContain(bottle.id)
    expect(
      m.db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE record_id = ?').get(bottle.id)
        ?.n,
    ).toBe(2)
  })

  it('nothing is deleted: the archived row stays in its table', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: burrata.id, data: { active: false } },
    ])
    expect(m.db.prepare('SELECT active FROM products WHERE id = ?').get(burrata.id)).toEqual({
      active: 0,
    })
  })
})

describe('permissions and sessions', () => {
  const change = (m: Awaited<ReturnType<typeof setupServer>>) => [
    { entity: 'products', id: burrataOf(m).id, data: { price: 12_345 } },
  ]
  const noChanges = (m: Awaited<ReturnType<typeof setupServer>>, before: number) => {
    expect(m.catalog().version).toBe(before)
    expect(m.alerts).toEqual([])
  }

  it('a session opened on another device is not valid on this one, even for a manager', async () => {
    const m = await setupServer()
    const other = m.pair('waiter', 'Celular')
    const before = m.catalog().version
    const otherSession = m.sessionOf('manager', other.connection)
    // With the register token and the phone session.
    const r = await m.send(otherSession, change(m), m.register.token)
    expect(r.code).toBe(401)
    expect(r.body.error).toBe('invalid_session')
    // With the phone token and the phone session, it is a manager.
    expect((await m.send(otherSession, change(m), other.token)).code).toBe(200)
    expect(m.catalog().version).toBeGreaterThan(before)
  })

  it('a closed session can no longer edit', async () => {
    const m = await setupServer()
    const before = m.catalog().version
    const s = m.signIn(m.register.connection, 'manager')
    m.access.closeSession(m.register.connection, { sessionId: s.sessionId, secret: s.secret })
    const r = await m.edit({ session_id: s.sessionId, secret: s.secret }, change(m))
    expect(r.code).toBe(401)
    noChanges(m, before)
  })

  it('when another person signs in on the device, the previous session stops being valid', async () => {
    const m = await setupServer()
    const before = m.catalog().version
    const manager = m.sessionOf('manager')
    m.sessionOf('waiter')
    expect((await m.edit(manager, change(m))).code).toBe(401)
    noChanges(m, before)
  })

  it('an archived manager loses the session', async () => {
    const m = await setupServer()
    const session = m.sessionOf('manager')
    m.access.archiveUser(m.people.manager.userId)
    const before = m.catalog().version
    expect((await m.edit(session, change(m))).code).toBe(401)
    noChanges(m, before)
  })

  it('with a secret from someone else or an empty one nothing is edited', async () => {
    const m = await setupServer()
    const before = m.catalog().version
    const s = m.sessionOf('manager')
    expect((await m.edit({ ...s, secret: 'other' }, change(m))).code).toBe(401)
    expect((await m.edit({ session_id: newId(), secret: s.secret }, change(m))).code).toBe(401)
    expect((await m.edit({ ...s, secret: '' }, change(m))).code).toBe(400)
    noChanges(m, before)
  })

  it('a retired device neither edits nor reads the catalog', async () => {
    const m = await setupServer()
    const admin = m.sessionOf('admin')
    const other = m.pair('waiter', 'Celular')
    const session = m.sessionOf('manager', other.connection)
    const withdrawal = m.access.revokeDevice(m.register.connection, {
      sessionId: admin.session_id,
      secret: admin.secret,
      deviceId: other.connection.deviceId,
    })
    expect(withdrawal.ok).toBe(true)
    const before = m.catalog().version
    expect((await m.send(session, change(m), other.token)).code).toBe(401)
    expect((await m.editView(other.token)).statusCode).toBe(401)
    noChanges(m, before)
  })

  it('without a token, or with a made-up one, nothing is edited or read', async () => {
    const m = await setupServer()
    const session = m.sessionOf('manager')
    expect((await m.send(session, change(m), 'inventado')).code).toBe(401)
    expect((await m.editView('inventado')).statusCode).toBe(401)
    const withoutHeader = await m.app.inject({ method: 'GET', url: '/api/catalog/editing' })
    expect(withoutHeader.statusCode).toBe(401)
    const otherSchema = await m.app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { authorization: `Basic ${m.register.token}` },
    })
    expect(otherSchema.statusCode).toBe(401)
  })

  it('the waiter, the cashier and waiter 2 get 403 and leave no trace', async () => {
    const m = await setupServer()
    const before = m.catalog().version
    const rows = m.history().length
    for (const who of ['waiter', 'waiter2', 'cashier'] as const) {
      const r = await m.edit(m.sessionOf(who), change(m))
      expect(r.code, who).toBe(403)
      expect(r.body.error).toBe('no_permission')
    }
    noChanges(m, before)
    expect(m.history()).toHaveLength(rows)
  })

  it('the manager and the admin can edit, and the history says who it was', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    for (const [who, price] of [
      ['manager', 20_000],
      ['admin', 21_000],
    ] as const) {
      const r = await m.edit(m.sessionOf(who), [
        { entity: 'products', id: burrata.id, data: { price } },
      ])
      expect(r.code, who).toBe(200)
      const latest = m.db
        .prepare('SELECT user_id, device_id FROM catalog_changes ORDER BY version DESC LIMIT 1')
        .get()
      expect(latest).toEqual({
        user_id: m.people[who].userId,
        device_id: m.register.connection.deviceId,
      })
    }
  })

  it('someone with only edit_prices cannot mix price with archiving', async () => {
    const m = await setupServer()
    const { insertVersioned } = await import('./access/records')
    insertVersioned(
      m.db,
      'role_permissions',
      m.restaurantId,
      { role_id: m.roles.cashier, permission: 'edit_prices' },
      { userId: null, deviceId: null },
      m.clock(),
    )
    const burrata = burrataOf(m)
    const session = m.sessionOf('cashier')
    const mix = await m.edit(session, [
      { entity: 'products', id: burrata.id, data: { price: 1_000, active: false } },
    ])
    expect(mix.code).toBe(403)
    // A price on a variant or a modifier is also price only.
    const wine = m.product('Ramón Bilbao Crianza')
    const bottle = wine.variants[1]
    const doneness = m.product('Tagliata di Manzo').groups[0]?.options[0]
    if (!bottle || !doneness) throw new Error('missing')
    const r = await m.edit(session, [
      { entity: 'variants', id: bottle.id, data: { price: bottle.price + 1_000 } },
      { entity: 'modifiers', id: doneness.id, data: { extra_price: 500 } },
    ])
    expect(r.code).toBe(200)
    // And cannot touch the price of something that is not a product, variant or modifier.
    const taxId = m.taxId
    expect((await m.edit(session, [{ entity: 'taxes', id: taxId, data: { rate: 1 } }])).code).toBe(
      403,
    )
  })
})

describe('invalid ids and data', () => {
  const rejected = async (m: Awaited<ReturnType<typeof setupServer>>, changes: unknown) => {
    const before = m.catalog().version
    const rows = m.history().length
    const r = await m.send(m.sessionOf('manager'), changes)
    expect(r.code).toBe(400)
    expect(m.catalog().version).toBe(before)
    expect(m.history()).toHaveLength(rows)
    expect(m.alerts).toEqual([])
    return r
  }
  const station = (id: unknown) => ({
    entity: 'stations',
    id,
    data: { name: 'X', position: 0, active: true },
  })

  it.each([
    ['empty', ''],
    ['short', 'ABC'],
    ['lowercase', newId().toLowerCase()],
    ['with letters ULID does not use (I, L, O, U)', '01ARZ3NDEKTSV4RRFFQ69G5FAI'],
    ['of 27 characters', `${newId()}0`],
    ['with the first character outside 0-7', `8${newId().slice(1)}`],
    ['a UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ['with spaces', ` ${newId().slice(1)}`],
    ['a number', 12345],
    ['null', null],
    ['an object', { $ne: null }],
    ['a list', [newId()]],
    ['with quotes (SQL)', "01ARZ3NDEKTSV4RRFFQ69G5F'"],
  ])('a record id that is %s is rejected', async (_case, id) => {
    const m = await setupServer()
    await rejected(m, [station(id)])
  })

  it.each([
    ['category_id', 'category_id'],
    ['tax_id', 'tax_id'],
  ])('a %s that is not a ULID is rejected when creating a product', async (_c, field) => {
    const m = await setupServer()
    await rejected(m, [
      { entity: 'products', id: newId(), data: product(m, { [field]: 'no-es-id' }) },
    ])
  })

  it('a reference that is a valid ULID but from another table does not count as existing', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    // The "category" is a product.
    const r = await rejected(m, [
      { entity: 'products', id: newId(), data: product(m, { category_id: burrata.id }) },
    ])
    expect(r.body.message).toMatch(/category_id no existe/)
    // The "product" of a variant is a tax.
    await rejected(m, [
      {
        entity: 'variants',
        id: newId(),
        data: { product_id: m.taxId, name: 'V', price: 1, position: 0, active: true },
      },
    ])
  })

  it('something active cannot point to an archived record; something archived can', async () => {
    const m = await setupServer()
    const session = m.sessionOf('manager')
    const e = newId()
    await m.edit(session, [station(e)])
    await m.edit(session, [{ entity: 'stations', id: e, data: { active: false } }])
    const newOne = (active: boolean) => [
      {
        entity: 'categories',
        id: newId(),
        data: { name: 'Nueva', position: 0, station_id: e, active },
      },
    ]
    const alerts = m.alerts.length
    const r = await m.edit(session, newOne(true))
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/archivado/)
    expect(m.alerts).toHaveLength(alerts)
    expect((await m.edit(session, newOne(false))).code).toBe(200)
  })

  it('a product id cannot be reused as a variant id', async () => {
    // Ids are unique across the whole catalog (the history looks up by record_id without entity).
    const m = await setupServer()
    const burrata = burrataOf(m)
    const r = await m.send(m.sessionOf('manager'), [
      {
        entity: 'variants',
        id: burrata.id,
        data: { product_id: burrata.id, name: 'Doble', price: 99_000, position: 0, active: true },
      },
    ])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/otro tipo de registro/)
    expect(m.db.prepare('SELECT count(*) AS n FROM variants WHERE id = ?').get(burrata.id)?.n).toBe(
      0,
    )
  })

  it('an entity not editable from here is rejected', async () => {
    const m = await setupServer()
    for (const entity of [
      'users',
      'roles',
      'dining_tables',
      'restaurants',
      'product_stations',
      'events',
      '',
      'PRODUCTS',
    ])
      await rejected(m, [{ entity, id: newId(), data: { name: 'X' } }])
  })

  it.each([
    'version',
    'restaurant_id',
    'id',
    'created_at',
    'updated_at',
    'user_id',
    'device_id',
    'photo',
    'sequence',
  ])('the «%s» field inside data is rejected on update', async (field) => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    const value = field === 'version' ? 1 : field === 'photo' ? 'x.jpg' : newId()
    const r = await rejected(m, [
      { entity: 'products', id: burrata.id, data: { price: 5_000, [field]: value } },
    ])
    expect(r.body.message).toMatch(/Cambio 1/)
    expect(m.product('Burrata Spritz').price).toBe(burrata.price)
  })

  it.each(['version', 'restaurant_id', 'created_at', 'updated_at', 'user_id'])(
    'the «%s» field inside data is rejected on create',
    async (field) => {
      const m = await setupServer()
      const id = newId()
      const value = field === 'version' ? 0 : newId()
      await rejected(m, [{ entity: 'products', id, data: product(m, { [field]: value }) }])
      expect(m.db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)).toBeUndefined()
    },
  )

  it('putting the version in data does not let it skip the hub counter', async () => {
    const m = await setupServer()
    const before = m.catalog().version
    await rejected(m, [
      {
        entity: 'stations',
        id: newId(),
        data: { name: 'X', position: 0, active: true, version: 0 },
      },
    ])
    await rejected(m, [
      {
        entity: 'stations',
        id: newId(),
        data: { name: 'X', position: 0, active: true, version: before + 1_000 },
      },
    ])
  })

  it('a restaurant_id in the body, in the change or with __proto__ is rejected', async () => {
    const m = await setupServer()
    const session = m.sessionOf('manager')
    const changes = [station(newId())]
    const before = m.catalog().version
    expect(
      (await m.send(session, changes, m.register.token, { restaurant_id: newId() })).code,
    ).toBe(400)
    expect((await m.send(session, [{ ...station(newId()), restaurant_id: newId() }])).code).toBe(
      400,
    )
    const raw = await m.app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${m.register.token}`, 'content-type': 'application/json' },
      payload: `{"session_id":"${session.session_id}","secret":"${session.secret}","changes":[{"entity":"stations","id":"${newId()}","data":{"name":"X","position":0,"active":true,"__proto__":{"version":1}}}]}`,
    })
    expect(raw.statusCode).toBe(400)
    expect(m.catalog().version).toBe(before)
  })

  it('a body without changes, with an empty list or not a list is rejected', async () => {
    const m = await setupServer()
    await rejected(m, [])
    await rejected(m, undefined)
    await rejected(m, 'changes')
    await rejected(m, { entity: 'stations' })
    await rejected(m, [null])
    await rejected(m, [{ entity: 'stations', id: newId() }])
    await rejected(m, [{ entity: 'stations', id: newId(), data: null }])
    await rejected(m, [{ entity: 'stations', id: newId(), data: [] }])
  })

  it('a body that is not JSON is rejected without breaking the server', async () => {
    const m = await setupServer()
    const r = await m.app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${m.register.token}`, 'content-type': 'application/json' },
      payload: '{roto',
    })
    expect(r.statusCode).toBe(400)
    expect((await m.editView()).statusCode).toBe(200)
  })

  it.each([
    ['price as text', { price: '1000' }],
    ['price with decimals', { price: 0.5 }],
    ['price NaN as text', { price: 'NaN' }],
    ['price over the limit', { price: 100_000_001 }],
    ['negative price', { price: -1 }],
    ['null price', { price: null }],
    ['active as a number', { active: 1 }],
    ['active as text', { active: 'true' }],
    ['favorite as a number', { favorite: 1 }],
    ['empty name', { name: '' }],
    ['name of only spaces', { name: '   ' }],
    ['name of 81 characters', { name: 'a'.repeat(81) }],
    ['name that is not text', { name: 42 }],
    ['description of 301 characters', { description: 'a'.repeat(301) }],
    ['null tax_id', { tax_id: null }],
  ])('%s is rejected', async (_case, data) => {
    const m = await setupServer()
    await rejected(m, [{ entity: 'products', id: burrataOf(m).id, data }])
  })

  it('the name is saved without leading or trailing spaces', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: burrata.id, data: { name: '  Burrata nueva  ' } },
    ])
    expect(r.code).toBe(200)
    expect(m.products().some((p) => p.name === 'Burrata nueva')).toBe(true)
  })

  it('at the valid extremes it is accepted: price 0 and 100.000.000, name of 80', async () => {
    const m = await setupServer()
    const session = m.sessionOf('manager')
    for (const price of [0, 100_000_000])
      expect(
        (await m.edit(session, [{ entity: 'products', id: burrataOf(m).id, data: { price } }]))
          .code,
      ).toBe(200)
    expect(
      (
        await m.edit(session, [
          { entity: 'products', id: burrataOf(m).id, data: { name: 'a'.repeat(80) } },
        ])
      ).code,
    ).toBe(200)
  })

  it('tax and group rules: exempt without rate, maximum rate, minimum and maximum', async () => {
    const m = await setupServer()
    const imp = (data: object) => [
      { entity: 'taxes', id: newId(), data: { name: 'I', active: true, ...data } },
    ]
    await rejected(m, imp({ type: 'exempt', rate: 1 }))
    await rejected(m, imp({ type: 'inc', rate: 10_001 }))
    await rejected(m, imp({ type: 'inc', rate: -1 }))
    await rejected(m, imp({ type: 'inc', rate: 8.5 }))
    await rejected(m, imp({ type: 'other', rate: 8 }))
    const grp = (data: object) => [
      {
        entity: 'modifier_groups',
        id: newId(),
        data: { name: 'G', active: true, ...data },
      },
    ]
    await rejected(m, grp({ minimum: 2, maximum: 1 }))
    await rejected(m, grp({ minimum: 0, maximum: 0 }))
    await rejected(m, grp({ minimum: -1, maximum: 1 }))
    await rejected(m, grp({ minimum: 0, maximum: 21 }))
    const session = m.sessionOf('manager')
    expect((await m.edit(session, imp({ type: 'exempt', rate: 0 }))).code).toBe(200)
    expect((await m.edit(session, imp({ type: 'iva', rate: 1_900 }))).code).toBe(200)
    expect((await m.edit(session, grp({ minimum: 1, maximum: 1 }))).code).toBe(200)
  })

  it('raising a group minimum above its maximum is rejected on update', async () => {
    const m = await setupServer()
    const doneness = m.product('Tagliata di Manzo').groups[0]
    if (!doneness) throw new Error('missing')
    const r = await rejected(m, [
      { entity: 'modifier_groups', id: doneness.id, data: { minimum: doneness.maximum + 1 } },
    ])
    expect(r.body.message).toMatch(/Cambio 1/)
  })

  it('a change that changes nothing (empty data) is rejected', async () => {
    const m = await setupServer()
    await rejected(m, [{ entity: 'products', id: burrataOf(m).id, data: {} }])
  })

  it('an error message does not reveal internal data', async () => {
    const m = await setupServer()
    const r = await rejected(m, [
      { entity: 'products', id: burrataOf(m).id, data: { category_id: newId() } },
    ])
    expect(JSON.stringify(r.body)).not.toMatch(/SELECT|INSERT|sqlite|at .*\.ts/i)
  })
})

describe('changes that change nothing', () => {
  it('repeating the same request does not bump the version, write history or alert', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    const session = m.sessionOf('manager')
    const order = [{ entity: 'products', id: burrata.id, data: { price: burrata.price + 700 } }]
    const firstOne = await m.edit(session, order)
    expect(firstOne.body.changedCount).toBe(1)
    const rows = m.history().length
    const secondOne = await m.edit(session, order)
    expect(secondOne.code).toBe(200)
    expect(secondOne.body).toEqual({ version: firstOne.body.version, changedCount: 0 })
    expect(m.history()).toHaveLength(rows)
    expect(m.alerts).toEqual([firstOne.body.version])
  })

  it('with one field equal and another different only the different one counts', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: burrata.id, data: { price: burrata.price, favorite: true } },
    ])
    expect(r.body.changedCount).toBe(1)
    const latest = m.db
      .prepare('SELECT before, after FROM catalog_changes ORDER BY version DESC LIMIT 1')
      .get()
    expect(JSON.parse(String(latest?.before)).favorite).toBe(0)
    expect(JSON.parse(String(latest?.after)).favorite).toBe(1)
  })

  it('the same record twice with the same change counts only once', async () => {
    const m = await setupServer()
    const burrata = burrataOf(m)
    const before = m.catalog().version
    const change = { entity: 'products', id: burrata.id, data: { price: 33_333 } }
    const r = await m.edit(m.sessionOf('manager'), [change, change])
    expect(r.body).toEqual({ version: before + 1, changedCount: 1 })
  })

  it('a no-op change is still validated: an invalid value does not pass for being equal', async () => {
    const m = await setupServer()
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: burrataOf(m).id, data: { category_id: 'x' } },
    ])
    expect(r.code).toBe(400)
  })
})

describe('a record parent does not change', () => {
  it('a variant does not move to another product, an option does not move to another group', async () => {
    const m = await setupServer()
    const session = m.sessionOf('manager')
    const wine = m.product('Ramón Bilbao Crianza')
    const other = burrataOf(m)
    const variant = wine.variants[0]
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    const otherGroup = m.db
      .prepare('SELECT id FROM modifier_groups WHERE id <> ? LIMIT 1')
      .get(tagliata.groups[0]?.id ?? '')
    if (!variant || !option) throw new Error('missing')
    const before = m.catalog().version
    const r1 = await m.edit(session, [
      { entity: 'variants', id: variant.id, data: { product_id: other.id } },
    ])
    expect(r1.code).toBe(400)
    expect(r1.body.message).toMatch(/otro product/)
    if (otherGroup) {
      const r2 = await m.edit(session, [
        { entity: 'modifiers', id: option.id, data: { group_id: String(otherGroup.id) } },
      ])
      expect(r2.code).toBe(400)
      expect(r2.body.message).toMatch(/otro group/)
    }
    const link = String(m.db.prepare('SELECT id FROM product_modifier_groups LIMIT 1').get()?.id)
    const r3 = await m.edit(session, [
      { entity: 'product_modifier_groups', id: link, data: { product_id: other.id } },
    ])
    expect(r3.code).toBe(400)
    expect(m.catalog().version).toBe(before)
  })

  it('sending the same parent it already has is not an error', async () => {
    const m = await setupServer()
    const wine = m.product('Ramón Bilbao Crianza')
    const variant = wine.variants[0]
    if (!variant) throw new Error('missing')
    const r = await m.edit(m.sessionOf('manager'), [
      {
        entity: 'variants',
        id: variant.id,
        data: { product_id: wine.id, name: 'Copa grande' },
      },
    ])
    expect(r.code).toBe(200)
    expect(r.body.changedCount).toBe(1)
  })
})

describe('archive what others use', () => {
  const archive = (entity: string, id: string) => [{ entity, id, data: { active: false } }]

  it('a tax or a category with active products is not archived', async () => {
    const m = await setupServer()
    const session = m.sessionOf('manager')
    const before = m.catalog().version
    const imp = await m.edit(session, archive('taxes', m.taxId))
    expect(imp.code).toBe(400)
    expect(imp.body.message).toMatch(/lo usan \d+ productos/)
    const cat = await m.edit(session, archive('categories', m.categoryId))
    expect(cat.code).toBe(400)
    expect(m.catalog().version).toBe(before)
    expect(m.products().length).toBeGreaterThan(0)
  })

  it('a station with active categories is not archived', async () => {
    const m = await setupServer()
    const stationId = String(
      m.db
        .prepare(
          'SELECT station_id AS id FROM categories WHERE station_id IS NOT NULL AND active = 1 LIMIT 1',
        )
        .get()?.id,
    )
    const r = await m.edit(m.sessionOf('manager'), archive('stations', stationId))
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/categorías/)
  })

  it('in the same request everything that depends can be archived and then the parent', async () => {
    const m = await setupServer()
    const session = m.sessionOf('manager')
    const category = String(
      m.db.prepare('SELECT id FROM categories WHERE active = 1 ORDER BY name LIMIT 1').get()?.id,
    )
    const products = m.db
      .prepare('SELECT id FROM products WHERE category_id = ? AND active = 1')
      .all(category)
      .map((p) => ({ entity: 'products', id: String(p.id), data: { active: false } }))
    // First the category alone: it is rejected.
    expect((await m.edit(session, archive('categories', category))).code).toBe(400)
    // With its products archived first, it goes through.
    const r = await m.edit(session, [...products, ...archive('categories', category)])
    expect(r.code).toBe(200)
    // The other way around (category first) too: it is checked with everything applied.
    expect(m.catalog().categories.some((c) => c.id === category)).toBe(false)
  })

  it('a product whose category is still archived cannot be reactivated', async () => {
    const m = await setupServer()
    const session = m.sessionOf('manager')
    const category = String(
      m.db.prepare('SELECT id FROM categories WHERE active = 1 ORDER BY name LIMIT 1').get()?.id,
    )
    const products = m.db
      .prepare('SELECT id FROM products WHERE category_id = ? AND active = 1')
      .all(category)
      .map((p) => String(p.id))
    await m.edit(session, [
      ...products.map((id) => ({ entity: 'products', id, data: { active: false } })),
      ...archive('categories', category),
    ])
    const r = await m.edit(session, [
      { entity: 'products', id: products[0], data: { active: true } },
    ])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/category está archivado/)
  })

  it('archiving a group archives its links and stays in the history', async () => {
    const m = await setupServer()
    const tagliata = m.product('Tagliata di Manzo')
    const group = tagliata.groups[0]
    if (!group) throw new Error('missing')
    const link = String(
      m.db.prepare('SELECT id FROM product_modifier_groups WHERE group_id = ?').get(group.id)?.id,
    )
    const r = await m.edit(m.sessionOf('manager'), archive('modifier_groups', group.id))
    expect(r.code).toBe(200)
    expect(
      m.db.prepare('SELECT active FROM product_modifier_groups WHERE id = ?').get(link),
    ).toEqual({ active: 0 })
    expect(m.product('Tagliata di Manzo').groups).toHaveLength(0)
    // The archived link was recorded, with its own version.
    expect(
      m.db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE record_id = ?').get(link)?.n,
    ).toBe(2)
    expect(r.body.version).toBe(m.catalog().version)
  })

  it('the alert to devices carries the final version, after archiving the links', async () => {
    const m = await setupServer()
    const group = m.product('Tagliata di Manzo').groups[0]
    if (!group) throw new Error('missing')
    const r = await m.edit(m.sessionOf('manager'), archive('modifier_groups', group.id))
    expect(m.alerts).toEqual([r.body.version])
  })

  it('archiving a product and touching one of its active sizes in the same request is rejected', async () => {
    // What the menu editor must not send together (see borradores.propiedades.test.ts).
    const m = await setupServer()
    const wine = m.product('Ramón Bilbao Crianza')
    const glass = wine.variants[0]
    if (!glass) throw new Error('missing')
    const before = m.catalog().version
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'products', id: wine.id, data: { active: false } },
      { entity: 'variants', id: glass.id, data: { price: glass.price + 1_000 } },
    ])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/Cambio 2.*product está archivado/)
    expect(m.catalog().version).toBe(before)
    // Separately, yes.
    expect(
      (
        await m.edit(m.sessionOf('manager'), [
          { entity: 'products', id: wine.id, data: { active: false } },
        ])
      ).code,
    ).toBe(200)
  })

  it('archiving a group and touching one of its active options in the same request is rejected', async () => {
    const m = await setupServer()
    const group = m.product('Tagliata di Manzo').groups[0]
    const option = group?.options[0]
    if (!group || !option) throw new Error('missing')
    const r = await m.edit(m.sessionOf('manager'), [
      { entity: 'modifier_groups', id: group.id, data: { active: false } },
      { entity: 'modifiers', id: option.id, data: { extra_price: option.extraPrice + 500 } },
    ])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/Cambio 2.*group está archivado/)
  })
})
