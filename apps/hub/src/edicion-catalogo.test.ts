import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { insertarVersionado } from './acceso/registros'
import { leerCatalogo } from './catalogo'
import { HistorialCatalogo } from './precios'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Edición del catálogo desde la caja: permisos, todo o nada, historial y aviso a los equipos.

const CARTA = leerCarta(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

async function montar() {
  const m = montarAcceso()
  sembrar(
    m.db,
    m.access,
    { restauranteId: m.restauranteId, roles: m.roles, menu: CARTA, sinPersonal: true },
    m.clock(),
  )
  const avisos: number[] = []
  const app = crearServidor({
    access: m.access,
    catalog: {
      db: m.db,
      restauranteId: m.restauranteId,
      access: m.access,
      onChange: (v) => avisos.push(v),
      clock: m.clock,
    },
  })
  await app.ready()
  const register = m.emparejar('register')
  const sesionDe = (quien: keyof typeof m.people) => {
    const s = m.entrar(register.connection, quien)
    return { session_id: s.sesionId, secret: s.secret }
  }
  const editar = async (session: { session_id: string; secret: string }, changes: unknown[]) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${register.token}` },
      payload: { ...session, changes },
    })
    return { code: r.statusCode, cuerpo: r.json() }
  }
  const catalog = () => leerCatalogo(m.db, m.restauranteId)
  const products = () => catalog().categories.flatMap((c) => c.products)
  const impuestoId = String(m.db.prepare('SELECT id FROM taxes LIMIT 1').get()?.id)
  const categoriaId = catalog().categories[0]?.id as string
  return {
    ...m,
    app,
    avisos,
    register,
    sesionDe,
    editar,
    catalog,
    products,
    impuestoId,
    categoriaId,
  }
}

describe('POST /api/catalogo/cambios', () => {
  it('el gerente crea un producto con copa y botella y un grupo de opciones, en un solo paso', async () => {
    const m = await montar()
    const before = m.catalog().version
    const product = newId()
    const group = newId()
    const r = await m.editar(m.sesionDe('manager'), [
      {
        entity: 'products',
        id: product,
        data: {
          category_id: m.categoriaId,
          name: 'Prosecco de la casa',
          description: null,
          price: 18_000,
          tax_id: m.impuestoId,
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
    expect(r.cuerpo.version).toBeGreaterThan(before)
    expect(m.avisos).toEqual([r.cuerpo.version])
    const fresh = m.products().find((p) => p.id === product)
    expect(fresh?.variants.map((v) => [v.name, v.price])).toEqual([
      ['Copa', 18_000],
      ['Botella', 95_000],
    ])
    expect(fresh?.groups.map((g) => g.name)).toEqual(['Hielo'])
    // Quedó en el historial con quién lo hizo.
    const change = m.db
      .prepare('SELECT user_id, before FROM catalog_changes WHERE record_id = ?')
      .get(product)
    expect(change).toEqual({ user_id: m.people.manager.userId, before: null })
  })

  it('cambiar un precio sube la versión y el historial guarda el de antes', async () => {
    const m = await montar()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    const before = m.catalog().version
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: burrata.id, data: { price: burrata.price + 1_000 } },
    ])
    expect(r.code).toBe(200)
    const historial = new HistorialCatalogo(m.db, m.restauranteId)
    expect(historial.estadoEn('products', burrata.id, before)?.price).toBe(burrata.price)
    expect(historial.estadoEn('products', burrata.id, r.cuerpo.version)?.price).toBe(
      burrata.price + 1_000,
    )
  })

  it('archivar saca de la carta de los equipos, pero el editor lo sigue viendo', async () => {
    const m = await montar()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    expect(
      (
        await m.editar(m.sesionDe('manager'), [
          { entity: 'products', id: burrata.id, data: { active: false } },
        ])
      ).code,
    ).toBe(200)
    expect(m.products().some((p) => p.id === burrata.id)).toBe(false)
    const edicion = await m.app.inject({
      method: 'GET',
      url: '/api/catalog/editing',
      headers: { authorization: `Bearer ${m.register.token}` },
    })
    const archived = edicion.json().products.find((p: { id: string }) => p.id === burrata.id)
    expect(archived).toMatchObject({ active: false, price: burrata.price })
  })

  it('todo o nada: un cambio inválido no deja aplicado ninguno', async () => {
    const m = await montar()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    const before = m.catalog().version
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: burrata.id, data: { price: 1 } },
      {
        entity: 'modifier_groups',
        id: newId(),
        data: { name: 'Malo', minimum: 3, maximum: 1, active: true },
      },
    ])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/Cambio 2/)
    expect(m.catalog().version).toBe(before)
    expect(m.products().find((p) => p.id === burrata.id)?.price).toBe(burrata.price)
    expect(m.avisos).toEqual([])
  })

  it.each([
    ['precio con decimales', { price: 1000.5 }],
    ['precio negativo', { price: -1 }],
    ['campo desconocido', { costo: 5 }],
    ['categoría que no existe', { category_id: newId() }],
    ['nada que cambiar', {}],
  ])('rechaza %s', async (_case, data) => {
    const m = await montar()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    const r = await m.editar(m.sesionDe('manager'), [{ entity: 'products', id: burrata?.id, data }])
    expect(r.code).toBe(400)
  })

  it('un producto nuevo pide todos sus campos; un exento no lleva tarifa', async () => {
    const m = await montar()
    expect(
      (
        await m.editar(m.sesionDe('manager'), [
          { entity: 'products', id: newId(), data: { name: 'Sin precio' } },
        ])
      ).code,
    ).toBe(400)
    expect(
      (
        await m.editar(m.sesionDe('manager'), [
          {
            entity: 'taxes',
            id: newId(),
            data: { name: 'Exento', type: 'exempt', rate: 800, active: true },
          },
        ])
      ).code,
    ).toBe(400)
  })

  it('el mesero y el cajero no editan; sin sesión válida, 401', async () => {
    const m = await montar()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    const change = [{ entity: 'products', id: burrata?.id, data: { price: 1_000 } }]
    expect((await m.editar(m.sesionDe('waiter'), change)).code).toBe(403)
    expect((await m.editar(m.sesionDe('cashier'), change)).code).toBe(403)
    const session = m.sesionDe('manager')
    expect((await m.editar({ ...session, secret: 'x' }, change)).code).toBe(401)
    const sinToken = await m.app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      payload: { ...session, changes: change },
    })
    expect(sinToken.statusCode).toBe(401)
  })

  it('con solo `editar_precios` se cambian precios, nada más', async () => {
    const m = await montar()
    insertarVersionado(
      m.db,
      'role_permissions',
      m.restauranteId,
      { role_id: m.roles.cashier, permission: 'edit_prices' },
      { userId: null, dispositivoId: null },
      m.clock(),
    )
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    const session = m.sesionDe('cashier')
    expect(
      (await m.editar(session, [{ entity: 'products', id: burrata.id, data: { price: 50_000 } }]))
        .code,
    ).toBe(200)
    expect(
      (await m.editar(session, [{ entity: 'products', id: burrata.id, data: { name: 'Otra' } }]))
        .code,
    ).toBe(403)
    // Crear un producto no es "solo precios", aunque traiga precio.
    expect(
      (await m.editar(session, [{ entity: 'products', id: newId(), data: { price: 1 } }])).code,
    ).toBe(403)
  })

  it('el seed no pisa lo que editó una persona', async () => {
    const m = await montar()
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: burrata.id, data: { price: 77_000 } },
    ])
    sembrar(
      m.db,
      m.access,
      { restauranteId: m.restauranteId, roles: m.roles, menu: CARTA, sinPersonal: true },
      m.clock(),
    )
    expect(m.products().find((p) => p.id === burrata.id)?.price).toBe(77_000)
  })

  it('no deja apuntar a algo archivado ni archivar lo que está en uso', async () => {
    const m = await montar()
    const g = m.sesionDe('manager')
    const category = m.catalog().categories[0]
    if (!category) throw new Error('falta')
    // Archivar una categoría con productos activos: no (desaparecerían de la carta).
    const r1 = await m.editar(g, [
      { entity: 'categories', id: category.id, data: { active: false } },
    ])
    expect(r1.code).toBe(400)
    expect(r1.cuerpo.message).toMatch(/lo usan \d+ productos/)
    // Archivar el impuesto de todos: tampoco.
    const r2 = await m.editar(g, [{ entity: 'taxes', id: m.impuestoId, data: { active: false } }])
    expect(r2.code).toBe(400)
    // Sí, si en el mismo pedido se archivan antes sus productos.
    const r3 = await m.editar(g, [
      ...category.products.map((p) => ({
        entity: 'products',
        id: p.id,
        data: { active: false },
      })),
      { entity: 'categories', id: category.id, data: { active: false } },
    ])
    expect(r3.code).toBe(200)
    // Un producto nuevo en esa categoría archivada: no.
    const r4 = await m.editar(g, [
      {
        entity: 'products',
        id: newId(),
        data: {
          category_id: category.id,
          name: 'Nuevo',
          description: null,
          price: 1_000,
          tax_id: m.impuestoId,
          favorite: false,
          active: true,
        },
      },
    ])
    expect(r4.code).toBe(400)
    expect(r4.cuerpo.message).toMatch(/category está archivado/)
  })

  it('archivar un grupo lo quita de sus productos', async () => {
    const m = await montar()
    const tagliata = m.products().find((p) => p.name === 'Tagliata di Manzo')
    const group = tagliata?.groups[0]
    if (!group) throw new Error('falta')
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'modifier_groups', id: group.id, data: { active: false } },
    ])
    expect(r.code).toBe(200)
    expect(m.products().find((p) => p.name === 'Tagliata di Manzo')?.groups).toEqual([])
  })

  it('repetir lo mismo no sube la versión ni avisa; un padre no se cambia; un id no cambia de tipo', async () => {
    const m = await montar()
    const g = m.sesionDe('manager')
    const vino = m.products().find((p) => p.name === 'Ramón Bilbao Crianza')
    const glass = vino?.variants[0]
    const burrata = m.products().find((p) => p.name === 'Burrata Spritz')
    if (!vino || !glass || !burrata) throw new Error('falta')
    const before = m.catalog().version
    const equal = await m.editar(g, [
      { entity: 'products', id: vino.id, data: { price: vino.price } },
    ])
    expect(equal.cuerpo).toEqual({ version: before, cambiados: 0 })
    expect(m.avisos).toEqual([])
    const move = await m.editar(g, [
      { entity: 'variants', id: glass.id, data: { product_id: burrata.id } },
    ])
    expect(move.code).toBe(400)
    const disfrazado = await m.editar(g, [
      { entity: 'stations', id: glass.id, data: { name: 'X', position: 0, active: true } },
    ])
    expect(disfrazado.code).toBe(400)
    expect(disfrazado.cuerpo.message).toMatch(/otro tipo/)
  })

  it('las reglas de la base se dicen en palabras, sin el texto de SQLite', async () => {
    const m = await montar()
    const tagliata = m.products().find((p) => p.name === 'Tagliata di Manzo')
    const group = tagliata?.groups[0]
    if (!group) throw new Error('falta')
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'modifier_groups', id: group.id, data: { minimum: 3 } },
    ])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/máximo debe ser al menos 1 y no menor que el mínimo/)
    expect(r.cuerpo.message).not.toMatch(/constraint/i)
  })
})
