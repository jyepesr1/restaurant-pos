import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { HistorialCatalogo } from './precios'
import { montarServidor } from './pruebas-catalogo'

// La API de edición del catálogo en sus bordes: lotes grandes, enlaces repetidos, archivar y
// reactivar, quién puede editar y qué datos se rechazan.

const product = (m: Awaited<ReturnType<typeof montarServidor>>, fields = {}) => ({
  category_id: m.categoriaId,
  name: 'Prosecco de la casa',
  description: null,
  price: 18_000,
  tax_id: m.impuestoId,
  favorite: false,
  active: true,
  ...fields,
})
const group = (fields = {}) => ({ name: 'Hielo', minimum: 0, maximum: 1, active: true, ...fields })
const burrataDe = (m: Awaited<ReturnType<typeof montarServidor>>) => m.product('Burrata Spritz')

describe('un lote grande', () => {
  it('un producto con variantes y grupos, con 200 cambios en un pedido, se aplica entero', async () => {
    const m = await montarServidor()
    const before = m.catalog().version
    const filasAntes = m.historial().length
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

    const r = await m.editar(m.sesionDe('manager'), changes)
    expect(r.code).toBe(200)
    // Cada registro tomó una versión propia y todas quedaron en el historial.
    expect(r.cuerpo.version).toBe(before + 200)
    expect(m.historial()).toHaveLength(filasAntes + 200)
    expect(m.avisos).toEqual([before + 200])
    const fresh = m.products().find((x) => x.id === p)
    expect(fresh?.variants).toHaveLength(2)
    expect(fresh?.groups[0]?.options).toHaveLength(195)
    // Un solo aviso por pedido, no uno por cambio.
    expect(m.avisos).toHaveLength(1)
  })

  it('201 cambios se rechazan sin aplicar nada', async () => {
    const m = await montarServidor()
    const before = m.catalog().version
    const rows = m.historial().length
    const changes = Array.from({ length: 201 }, (_, i) => ({
      entity: 'stations',
      id: newId(),
      data: { name: `E${i}`, position: i, active: true },
    }))
    const r = await m.editar(m.sesionDe('manager'), changes)
    expect(r.code).toBe(400)
    expect(m.catalog().version).toBe(before)
    expect(m.historial()).toHaveLength(rows)
    expect(m.avisos).toEqual([])
  })

  it('si falla el cambio 200 de 200, no queda ninguno de los 199 anteriores', async () => {
    const m = await montarServidor()
    const before = m.catalog().version
    const rows = m.historial().length
    const changes: unknown[] = Array.from({ length: 199 }, (_, i) => ({
      entity: 'stations',
      id: newId(),
      data: { name: `E${i}`, position: i, active: true },
    }))
    changes.push({ entity: 'products', id: newId(), data: { name: 'incompleto' } })
    const r = await m.editar(m.sesionDe('manager'), changes)
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/Cambio 200/)
    expect(m.catalog().version).toBe(before)
    // Ni siquiera el contador de versiones avanzó: la transacción se deshizo completa.
    expect(m.historial()).toHaveLength(rows)
    expect(m.db.prepare("SELECT 1 FROM stations WHERE name = 'E0'").get()).toBeUndefined()
  })
})

describe('el mismo enlace producto-grupo', () => {
  const nuevoEnlace = (p: string, g: string, id = newId()) => ({
    entity: 'product_modifier_groups',
    id,
    data: { product_id: p, group_id: g, position: 0, active: true },
  })

  it('dos veces con ids distintos en el mismo pedido: se rechaza todo', async () => {
    const m = await montarServidor()
    const before = m.catalog().version
    const rows = m.historial().length
    const p = newId()
    const g = newId()
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: p, data: product(m) },
      { entity: 'modifier_groups', id: g, data: group() },
      nuevoEnlace(p, g),
      nuevoEnlace(p, g),
    ])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/Cambio 4/)
    // Ni el producto ni el grupo quedaron a medias.
    expect(m.products().some((x) => x.id === p)).toBe(false)
    expect(m.catalog().version).toBe(before)
    expect(m.historial()).toHaveLength(rows)
  })

  it('dos veces con el mismo id: la segunda actualiza a la primera y queda un solo enlace', async () => {
    const m = await montarServidor()
    const p = newId()
    const g = newId()
    const enlace = newId()
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: p, data: product(m) },
      { entity: 'modifier_groups', id: g, data: group() },
      nuevoEnlace(p, g, enlace),
      { entity: 'product_modifier_groups', id: enlace, data: { position: 3 } },
    ])
    expect(r.code).toBe(200)
    const rows = m.db
      .prepare('SELECT position FROM product_modifier_groups WHERE product_id = ?')
      .all(p)
    expect(rows).toEqual([{ position: 3 }])
    const historial = m.db
      .prepare('SELECT count(*) AS n FROM catalog_changes WHERE record_id = ?')
      .get(enlace)
    expect(historial?.n).toBe(2)
  })

  it('un enlace ya existente con un id nuevo se rechaza, también si el viejo está archivado', async () => {
    const m = await montarServidor()
    const tagliata = m.product('Tagliata di Manzo')
    const grupoId = tagliata.groups[0]?.id as string
    const session = m.sesionDe('manager')
    expect((await m.editar(session, [nuevoEnlace(tagliata.id, grupoId)])).code).toBe(400)

    const enlace = String(
      m.db
        .prepare('SELECT id FROM product_modifier_groups WHERE product_id = ? AND group_id = ?')
        .get(tagliata.id, grupoId)?.id,
    )
    expect(
      (
        await m.editar(session, [
          { entity: 'product_modifier_groups', id: enlace, data: { active: false } },
        ])
      ).code,
    ).toBe(200)
    // Hay que reactivar el enlace archivado, no crear otro.
    expect((await m.editar(session, [nuevoEnlace(tagliata.id, grupoId)])).code).toBe(400)
    expect(
      (
        await m.editar(session, [
          { entity: 'product_modifier_groups', id: enlace, data: { active: true } },
        ])
      ).code,
    ).toBe(200)
    expect(m.product('Tagliata di Manzo').groups).toHaveLength(1)
  })

  it('un enlace a un producto o un grupo que no existe se rechaza', async () => {
    const m = await montarServidor()
    const g = newId()
    const session = m.sesionDe('manager')
    expect((await m.editar(session, [nuevoEnlace(newId(), g)])).code).toBe(400)
    const tagliata = m.product('Tagliata di Manzo')
    expect((await m.editar(session, [nuevoEnlace(tagliata.id, newId())])).code).toBe(400)
  })

  it('referenciar algo creado más abajo en el mismo pedido falla: el orden importa', async () => {
    const m = await montarServidor()
    const p = newId()
    const r = await m.editar(m.sesionDe('manager'), [
      {
        entity: 'variants',
        id: newId(),
        data: { product_id: p, name: 'Copa', price: 1, position: 0, active: true },
      },
      { entity: 'products', id: p, data: product(m) },
    ])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/Cambio 1.*product_id no existe/)
  })
})

describe('archivar y reactivar', () => {
  it('archivar saca el producto de la carta y reactivarlo lo devuelve, con tres filas de historial', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const session = m.sesionDe('manager')
    const archive = await m.editar(session, [
      { entity: 'products', id: burrata.id, data: { active: false } },
    ])
    expect(archive.code).toBe(200)
    expect(m.products().some((x) => x.id === burrata.id)).toBe(false)

    const reactivar = await m.editar(session, [
      { entity: 'products', id: burrata.id, data: { active: true } },
    ])
    expect(reactivar.code).toBe(200)
    expect(reactivar.cuerpo.version).toBeGreaterThan(archive.cuerpo.version)
    expect(m.product('Burrata Spritz')).toEqual(burrata)

    const rows = m.db
      .prepare('SELECT version, after FROM catalog_changes WHERE record_id = ? ORDER BY version')
      .all(burrata.id)
    expect(rows.map((f) => JSON.parse(String(f.after)).active)).toEqual([1, 0, 1])
    const historial = new HistorialCatalogo(m.db, m.restauranteId)
    expect(historial.estadoEn('products', burrata.id, archive.cuerpo.version)?.active).toBe(0)
    expect(historial.estadoEn('products', burrata.id, reactivar.cuerpo.version)?.active).toBe(1)
  })

  it('el editor ve lo archivado con activo=false y lo vigente con activo=true', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: burrata.id, data: { active: false } },
    ])
    const r = await m.edicion()
    expect(r.statusCode).toBe(200)
    const cuerpo = r.json()
    const row = cuerpo.products.find((p: { id: string }) => p.id === burrata.id)
    expect(row.active).toBe(false)
    expect(typeof row.favorite).toBe('boolean')
    expect(cuerpo.products.some((p: { active: boolean }) => p.active)).toBe(true)
    expect(cuerpo.version).toBe(m.catalog().version)
    // La respuesta no trae quién ni de qué restaurante.
    expect(row).not.toHaveProperty('restaurant_id')
    expect(row).not.toHaveProperty('user_id')
  })

  it('archivar y reactivar en un solo pedido deja la última palabra y dos versiones', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const before = m.catalog().version
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: burrata.id, data: { active: false } },
      { entity: 'products', id: burrata.id, data: { active: true } },
    ])
    expect(r.code).toBe(200)
    expect(r.cuerpo.version).toBe(before + 2)
    expect(m.products().some((x) => x.id === burrata.id)).toBe(true)
  })

  it('archivar una variante la quita del producto y de la carta; su historial queda', async () => {
    const m = await montarServidor()
    const vino = m.product('Ramón Bilbao Crianza')
    const bottle = vino.variants[1]
    if (!bottle) throw new Error('falta')
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'variants', id: bottle.id, data: { active: false } },
    ])
    expect(r.code).toBe(200)
    expect(m.product('Ramón Bilbao Crianza').variants.map((v) => v.id)).not.toContain(bottle.id)
    expect(
      m.db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE record_id = ?').get(bottle.id)
        ?.n,
    ).toBe(2)
  })

  it('nada se borra: la fila archivada sigue en su tabla', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: burrata.id, data: { active: false } },
    ])
    expect(m.db.prepare('SELECT active FROM products WHERE id = ?').get(burrata.id)).toEqual({
      active: 0,
    })
  })
})

describe('permisos y sesiones', () => {
  const change = (m: Awaited<ReturnType<typeof montarServidor>>) => [
    { entity: 'products', id: burrataDe(m).id, data: { price: 12_345 } },
  ]
  const sinCambios = (m: Awaited<ReturnType<typeof montarServidor>>, before: number) => {
    expect(m.catalog().version).toBe(before)
    expect(m.avisos).toEqual([])
  }

  it('la sesión abierta en otro equipo no vale en este, aunque sea de un gerente', async () => {
    const m = await montarServidor()
    const other = m.emparejar('waiter', 'Celular')
    const before = m.catalog().version
    const sesionDelOtro = m.sesionDe('manager', other.connection)
    // Con el token de la caja y la sesión del celular.
    const r = await m.send(sesionDelOtro, change(m), m.register.token)
    expect(r.code).toBe(401)
    expect(r.cuerpo.error).toBe('invalid_session')
    // Con el token del celular y la sesión del celular, sí es un gerente.
    expect((await m.send(sesionDelOtro, change(m), other.token)).code).toBe(200)
    expect(m.catalog().version).toBeGreaterThan(before)
  })

  it('una sesión cerrada ya no edita', async () => {
    const m = await montarServidor()
    const before = m.catalog().version
    const s = m.entrar(m.register.connection, 'manager')
    m.access.cerrarSesion(m.register.connection, { sesionId: s.sesionId, secret: s.secret })
    const r = await m.editar({ session_id: s.sesionId, secret: s.secret }, change(m))
    expect(r.code).toBe(401)
    sinCambios(m, before)
  })

  it('al entrar otra persona en el equipo, la sesión anterior deja de valer', async () => {
    const m = await montarServidor()
    const before = m.catalog().version
    const manager = m.sesionDe('manager')
    m.sesionDe('waiter')
    expect((await m.editar(manager, change(m))).code).toBe(401)
    sinCambios(m, before)
  })

  it('un gerente archivado pierde la sesión', async () => {
    const m = await montarServidor()
    const session = m.sesionDe('manager')
    m.access.archivarUsuario(m.people.manager.userId)
    const before = m.catalog().version
    expect((await m.editar(session, change(m))).code).toBe(401)
    sinCambios(m, before)
  })

  it('con un secreto ajeno o vacío no se edita', async () => {
    const m = await montarServidor()
    const before = m.catalog().version
    const s = m.sesionDe('manager')
    expect((await m.editar({ ...s, secret: 'other' }, change(m))).code).toBe(401)
    expect((await m.editar({ session_id: newId(), secret: s.secret }, change(m))).code).toBe(401)
    expect((await m.editar({ ...s, secret: '' }, change(m))).code).toBe(400)
    sinCambios(m, before)
  })

  it('un equipo retirado no edita ni lee el catálogo', async () => {
    const m = await montarServidor()
    const admin = m.sesionDe('admin')
    const other = m.emparejar('waiter', 'Celular')
    const session = m.sesionDe('manager', other.connection)
    const withdrawal = m.access.revocarDispositivo(m.register.connection, {
      sesionId: admin.session_id,
      secret: admin.secret,
      dispositivoId: other.connection.dispositivoId,
    })
    expect(withdrawal.ok).toBe(true)
    const before = m.catalog().version
    expect((await m.send(session, change(m), other.token)).code).toBe(401)
    expect((await m.edicion(other.token)).statusCode).toBe(401)
    sinCambios(m, before)
  })

  it('sin token, o con uno inventado, nada se edita ni se lee', async () => {
    const m = await montarServidor()
    const session = m.sesionDe('manager')
    expect((await m.send(session, change(m), 'inventado')).code).toBe(401)
    expect((await m.edicion('inventado')).statusCode).toBe(401)
    const sinEncabezado = await m.app.inject({ method: 'GET', url: '/api/catalog/editing' })
    expect(sinEncabezado.statusCode).toBe(401)
    const otroEsquema = await m.app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { authorization: `Basic ${m.register.token}` },
    })
    expect(otroEsquema.statusCode).toBe(401)
  })

  it('el mesero, el cajero y el mesero 2 reciben 403 y no queda rastro', async () => {
    const m = await montarServidor()
    const before = m.catalog().version
    const rows = m.historial().length
    for (const quien of ['waiter', 'waiter2', 'cashier'] as const) {
      const r = await m.editar(m.sesionDe(quien), change(m))
      expect(r.code, quien).toBe(403)
      expect(r.cuerpo.error).toBe('no_permission')
    }
    sinCambios(m, before)
    expect(m.historial()).toHaveLength(rows)
  })

  it('el gerente y el administrador sí editan, y el historial dice quién fue', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    for (const [quien, price] of [
      ['manager', 20_000],
      ['admin', 21_000],
    ] as const) {
      const r = await m.editar(m.sesionDe(quien), [
        { entity: 'products', id: burrata.id, data: { price } },
      ])
      expect(r.code, quien).toBe(200)
      const latest = m.db
        .prepare('SELECT user_id, device_id FROM catalog_changes ORDER BY version DESC LIMIT 1')
        .get()
      expect(latest).toEqual({
        user_id: m.people[quien].userId,
        device_id: m.register.connection.dispositivoId,
      })
    }
  })

  it('quien tiene solo editar_precios no puede mezclar precio con archivar', async () => {
    const m = await montarServidor()
    const { insertarVersionado } = await import('./acceso/registros')
    insertarVersionado(
      m.db,
      'role_permissions',
      m.restauranteId,
      { role_id: m.roles.cashier, permission: 'edit_prices' },
      { userId: null, dispositivoId: null },
      m.clock(),
    )
    const burrata = burrataDe(m)
    const session = m.sesionDe('cashier')
    const mezcla = await m.editar(session, [
      { entity: 'products', id: burrata.id, data: { price: 1_000, active: false } },
    ])
    expect(mezcla.code).toBe(403)
    // Un precio en una variante o un modificador también es solo precio.
    const vino = m.product('Ramón Bilbao Crianza')
    const bottle = vino.variants[1]
    const termino = m.product('Tagliata di Manzo').groups[0]?.options[0]
    if (!bottle || !termino) throw new Error('falta')
    const r = await m.editar(session, [
      { entity: 'variants', id: bottle.id, data: { price: bottle.price + 1_000 } },
      { entity: 'modifiers', id: termino.id, data: { extra_price: 500 } },
    ])
    expect(r.code).toBe(200)
    // Y no puede tocar el precio de algo que no es producto, variante o modificador.
    const impuestoId = m.impuestoId
    expect(
      (await m.editar(session, [{ entity: 'taxes', id: impuestoId, data: { rate: 1 } }])).code,
    ).toBe(403)
  })
})

describe('ids y datos inválidos', () => {
  const rejected = async (m: Awaited<ReturnType<typeof montarServidor>>, changes: unknown) => {
    const before = m.catalog().version
    const rows = m.historial().length
    const r = await m.send(m.sesionDe('manager'), changes)
    expect(r.code).toBe(400)
    expect(m.catalog().version).toBe(before)
    expect(m.historial()).toHaveLength(rows)
    expect(m.avisos).toEqual([])
    return r
  }
  const station = (id: unknown) => ({
    entity: 'stations',
    id,
    data: { name: 'X', position: 0, active: true },
  })

  it.each([
    ['vacío', ''],
    ['corto', 'ABC'],
    ['en minúsculas', newId().toLowerCase()],
    ['con letras que ULID no usa (I, L, O, U)', '01ARZ3NDEKTSV4RRFFQ69G5FAI'],
    ['de 27 caracteres', `${newId()}0`],
    ['con el primer carácter fuera de 0-7', `8${newId().slice(1)}`],
    ['un UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ['con espacios', ` ${newId().slice(1)}`],
    ['un número', 12345],
    ['null', null],
    ['un objeto', { $ne: null }],
    ['una lista', [newId()]],
    ['con comillas (SQL)', "01ARZ3NDEKTSV4RRFFQ69G5F'"],
  ])('el id del registro %s se rechaza', async (_case, id) => {
    const m = await montarServidor()
    await rejected(m, [station(id)])
  })

  it.each([
    ['category_id', 'category_id'],
    ['tax_id', 'tax_id'],
  ])('un %s que no es ULID se rechaza al crear un producto', async (_c, field) => {
    const m = await montarServidor()
    await rejected(m, [
      { entity: 'products', id: newId(), data: product(m, { [field]: 'no-es-id' }) },
    ])
  })

  it('una referencia que es un ULID válido pero de otra tabla no cuenta como existente', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    // La "categoría" es un producto.
    const r = await rejected(m, [
      { entity: 'products', id: newId(), data: product(m, { category_id: burrata.id }) },
    ])
    expect(r.cuerpo.message).toMatch(/category_id no existe/)
    // El "producto" de una variante es un impuesto.
    await rejected(m, [
      {
        entity: 'variants',
        id: newId(),
        data: { product_id: m.impuestoId, name: 'V', price: 1, position: 0, active: true },
      },
    ])
  })

  it('algo activo no puede apuntar a un registro archivado; algo archivado sí', async () => {
    const m = await montarServidor()
    const session = m.sesionDe('manager')
    const e = newId()
    await m.editar(session, [station(e)])
    await m.editar(session, [{ entity: 'stations', id: e, data: { active: false } }])
    const newOne = (active: boolean) => [
      {
        entity: 'categories',
        id: newId(),
        data: { name: 'Nueva', position: 0, station_id: e, active },
      },
    ]
    const avisos = m.avisos.length
    const r = await m.editar(session, newOne(true))
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/archivado/)
    expect(m.avisos).toHaveLength(avisos)
    expect((await m.editar(session, newOne(false))).code).toBe(200)
  })

  it('el id de un producto no se puede reusar como id de una variante', async () => {
    // Los ids son únicos en todo el catálogo (el historial busca por record_id sin entidad).
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const r = await m.send(m.sesionDe('manager'), [
      {
        entity: 'variants',
        id: burrata.id,
        data: { product_id: burrata.id, name: 'Doble', price: 99_000, position: 0, active: true },
      },
    ])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/otro tipo de registro/)
    expect(m.db.prepare('SELECT count(*) AS n FROM variants WHERE id = ?').get(burrata.id)?.n).toBe(
      0,
    )
  })

  it('una entidad que no se edita desde aquí se rechaza', async () => {
    const m = await montarServidor()
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
  ])('el campo «%s» dentro de datos se rechaza al actualizar', async (field) => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const value = field === 'version' ? 1 : field === 'photo' ? 'x.jpg' : newId()
    const r = await rejected(m, [
      { entity: 'products', id: burrata.id, data: { price: 5_000, [field]: value } },
    ])
    expect(r.cuerpo.message).toMatch(/Cambio 1/)
    expect(m.product('Burrata Spritz').price).toBe(burrata.price)
  })

  it.each(['version', 'restaurant_id', 'created_at', 'updated_at', 'user_id'])(
    'el campo «%s» dentro de datos se rechaza al crear',
    async (field) => {
      const m = await montarServidor()
      const id = newId()
      const value = field === 'version' ? 0 : newId()
      await rejected(m, [{ entity: 'products', id, data: product(m, { [field]: value }) }])
      expect(m.db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)).toBeUndefined()
    },
  )

  it('meter la versión en datos no deja saltarse el contador del hub', async () => {
    const m = await montarServidor()
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

  it('un restaurante_id en el cuerpo, en el cambio o con __proto__ se rechaza', async () => {
    const m = await montarServidor()
    const session = m.sesionDe('manager')
    const changes = [station(newId())]
    const before = m.catalog().version
    expect(
      (await m.send(session, changes, m.register.token, { restaurant_id: newId() })).code,
    ).toBe(400)
    expect((await m.send(session, [{ ...station(newId()), restaurant_id: newId() }])).code).toBe(
      400,
    )
    const crudo = await m.app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${m.register.token}`, 'content-type': 'application/json' },
      payload: `{"session_id":"${session.session_id}","secret":"${session.secret}","changes":[{"entity":"stations","id":"${newId()}","data":{"name":"X","position":0,"active":true,"__proto__":{"version":1}}}]}`,
    })
    expect(crudo.statusCode).toBe(400)
    expect(m.catalog().version).toBe(before)
  })

  it('el cuerpo sin cambios, con una lista vacía o que no es lista se rechaza', async () => {
    const m = await montarServidor()
    await rejected(m, [])
    await rejected(m, undefined)
    await rejected(m, 'changes')
    await rejected(m, { entity: 'stations' })
    await rejected(m, [null])
    await rejected(m, [{ entity: 'stations', id: newId() }])
    await rejected(m, [{ entity: 'stations', id: newId(), data: null }])
    await rejected(m, [{ entity: 'stations', id: newId(), data: [] }])
  })

  it('un cuerpo que no es JSON se rechaza sin romper el servidor', async () => {
    const m = await montarServidor()
    const r = await m.app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${m.register.token}`, 'content-type': 'application/json' },
      payload: '{roto',
    })
    expect(r.statusCode).toBe(400)
    expect((await m.edicion()).statusCode).toBe(200)
  })

  it.each([
    ['precio como texto', { price: '1000' }],
    ['precio con decimales', { price: 0.5 }],
    ['precio NaN como texto', { price: 'NaN' }],
    ['precio sobre el límite', { price: 100_000_001 }],
    ['precio negativo', { price: -1 }],
    ['precio nulo', { price: null }],
    ['activo como número', { active: 1 }],
    ['activo como texto', { active: 'true' }],
    ['favorito como número', { favorite: 1 }],
    ['nombre vacío', { name: '' }],
    ['nombre solo de espacios', { name: '   ' }],
    ['nombre de 81 caracteres', { name: 'a'.repeat(81) }],
    ['nombre que no es texto', { name: 42 }],
    ['descripción de 301 caracteres', { description: 'a'.repeat(301) }],
    ['tax_id nulo', { tax_id: null }],
  ])('%s se rechaza', async (_case, data) => {
    const m = await montarServidor()
    await rejected(m, [{ entity: 'products', id: burrataDe(m).id, data }])
  })

  it('el nombre se guarda sin espacios de los lados', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: burrata.id, data: { name: '  Burrata nueva  ' } },
    ])
    expect(r.code).toBe(200)
    expect(m.products().some((p) => p.name === 'Burrata nueva')).toBe(true)
  })

  it('en los extremos válidos sí se acepta: precio 0 y 100.000.000, nombre de 80', async () => {
    const m = await montarServidor()
    const session = m.sesionDe('manager')
    for (const price of [0, 100_000_000])
      expect(
        (await m.editar(session, [{ entity: 'products', id: burrataDe(m).id, data: { price } }]))
          .code,
      ).toBe(200)
    expect(
      (
        await m.editar(session, [
          { entity: 'products', id: burrataDe(m).id, data: { name: 'a'.repeat(80) } },
        ])
      ).code,
    ).toBe(200)
  })

  it('reglas de impuestos y grupos: exento sin tarifa, tarifa máxima, mínimo y máximo', async () => {
    const m = await montarServidor()
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
    const session = m.sesionDe('manager')
    expect((await m.editar(session, imp({ type: 'exempt', rate: 0 }))).code).toBe(200)
    expect((await m.editar(session, imp({ type: 'iva', rate: 1_900 }))).code).toBe(200)
    expect((await m.editar(session, grp({ minimum: 1, maximum: 1 }))).code).toBe(200)
  })

  it('subir el mínimo de un grupo por encima de su máximo se rechaza al actualizar', async () => {
    const m = await montarServidor()
    const termino = m.product('Tagliata di Manzo').groups[0]
    if (!termino) throw new Error('falta')
    const r = await rejected(m, [
      { entity: 'modifier_groups', id: termino.id, data: { minimum: termino.maximum + 1 } },
    ])
    expect(r.cuerpo.message).toMatch(/Cambio 1/)
  })

  it('un cambio que no cambia nada (datos vacíos) se rechaza', async () => {
    const m = await montarServidor()
    await rejected(m, [{ entity: 'products', id: burrataDe(m).id, data: {} }])
  })

  it('un error en el mensaje no revela datos internos', async () => {
    const m = await montarServidor()
    const r = await rejected(m, [
      { entity: 'products', id: burrataDe(m).id, data: { category_id: newId() } },
    ])
    expect(JSON.stringify(r.cuerpo)).not.toMatch(/SELECT|INSERT|sqlite|at .*\.ts/i)
  })
})

describe('cambios que no cambian nada', () => {
  it('repetir el mismo pedido no sube la versión, no escribe historial ni avisa', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const session = m.sesionDe('manager')
    const order = [{ entity: 'products', id: burrata.id, data: { price: burrata.price + 700 } }]
    const firstOne = await m.editar(session, order)
    expect(firstOne.cuerpo.cambiados).toBe(1)
    const rows = m.historial().length
    const secondOne = await m.editar(session, order)
    expect(secondOne.code).toBe(200)
    expect(secondOne.cuerpo).toEqual({ version: firstOne.cuerpo.version, cambiados: 0 })
    expect(m.historial()).toHaveLength(rows)
    expect(m.avisos).toEqual([firstOne.cuerpo.version])
  })

  it('con un campo igual y otro distinto solo cuenta el distinto', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: burrata.id, data: { price: burrata.price, favorite: true } },
    ])
    expect(r.cuerpo.cambiados).toBe(1)
    const latest = m.db
      .prepare('SELECT before, after FROM catalog_changes ORDER BY version DESC LIMIT 1')
      .get()
    expect(JSON.parse(String(latest?.before)).favorite).toBe(0)
    expect(JSON.parse(String(latest?.after)).favorite).toBe(1)
  })

  it('el mismo registro dos veces con el mismo cambio cuenta una sola vez', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const before = m.catalog().version
    const change = { entity: 'products', id: burrata.id, data: { price: 33_333 } }
    const r = await m.editar(m.sesionDe('manager'), [change, change])
    expect(r.cuerpo).toEqual({ version: before + 1, cambiados: 1 })
  })

  it('un cambio sin efecto sigue validándose: un valor inválido no pasa por ser igual', async () => {
    const m = await montarServidor()
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: burrataDe(m).id, data: { category_id: 'x' } },
    ])
    expect(r.code).toBe(400)
  })
})

describe('el padre de un registro no cambia', () => {
  it('una variante no pasa a otro producto, una opción no pasa a otro grupo', async () => {
    const m = await montarServidor()
    const session = m.sesionDe('manager')
    const vino = m.product('Ramón Bilbao Crianza')
    const other = burrataDe(m)
    const variant = vino.variants[0]
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    const otroGrupo = m.db
      .prepare('SELECT id FROM modifier_groups WHERE id <> ? LIMIT 1')
      .get(tagliata.groups[0]?.id ?? '')
    if (!variant || !option) throw new Error('falta')
    const before = m.catalog().version
    const r1 = await m.editar(session, [
      { entity: 'variants', id: variant.id, data: { product_id: other.id } },
    ])
    expect(r1.code).toBe(400)
    expect(r1.cuerpo.message).toMatch(/otro product/)
    if (otroGrupo) {
      const r2 = await m.editar(session, [
        { entity: 'modifiers', id: option.id, data: { group_id: String(otroGrupo.id) } },
      ])
      expect(r2.code).toBe(400)
      expect(r2.cuerpo.message).toMatch(/otro group/)
    }
    const enlace = String(m.db.prepare('SELECT id FROM product_modifier_groups LIMIT 1').get()?.id)
    const r3 = await m.editar(session, [
      { entity: 'product_modifier_groups', id: enlace, data: { product_id: other.id } },
    ])
    expect(r3.code).toBe(400)
    expect(m.catalog().version).toBe(before)
  })

  it('mandar el mismo padre que ya tiene no es un error', async () => {
    const m = await montarServidor()
    const vino = m.product('Ramón Bilbao Crianza')
    const variant = vino.variants[0]
    if (!variant) throw new Error('falta')
    const r = await m.editar(m.sesionDe('manager'), [
      {
        entity: 'variants',
        id: variant.id,
        data: { product_id: vino.id, name: 'Copa grande' },
      },
    ])
    expect(r.code).toBe(200)
    expect(r.cuerpo.cambiados).toBe(1)
  })
})

describe('archivar lo que otros usan', () => {
  const archive = (entity: string, id: string) => [{ entity, id, data: { active: false } }]

  it('un impuesto o una categoría con productos activos no se archiva', async () => {
    const m = await montarServidor()
    const session = m.sesionDe('manager')
    const before = m.catalog().version
    const imp = await m.editar(session, archive('taxes', m.impuestoId))
    expect(imp.code).toBe(400)
    expect(imp.cuerpo.message).toMatch(/lo usan \d+ productos/)
    const cat = await m.editar(session, archive('categories', m.categoriaId))
    expect(cat.code).toBe(400)
    expect(m.catalog().version).toBe(before)
    expect(m.products().length).toBeGreaterThan(0)
  })

  it('una estación con categorías activas no se archiva', async () => {
    const m = await montarServidor()
    const estacionId = String(
      m.db
        .prepare(
          'SELECT station_id AS id FROM categories WHERE station_id IS NOT NULL AND active = 1 LIMIT 1',
        )
        .get()?.id,
    )
    const r = await m.editar(m.sesionDe('manager'), archive('stations', estacionId))
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/categorías/)
  })

  it('en el mismo pedido se puede archivar todo lo que depende y luego el padre', async () => {
    const m = await montarServidor()
    const session = m.sesionDe('manager')
    const category = String(
      m.db.prepare('SELECT id FROM categories WHERE active = 1 ORDER BY name LIMIT 1').get()?.id,
    )
    const products = m.db
      .prepare('SELECT id FROM products WHERE category_id = ? AND active = 1')
      .all(category)
      .map((p) => ({ entity: 'products', id: String(p.id), data: { active: false } }))
    // Primero la categoría sola: se rechaza.
    expect((await m.editar(session, archive('categories', category))).code).toBe(400)
    // Con sus productos archivados antes, pasa.
    const r = await m.editar(session, [...products, ...archive('categories', category)])
    expect(r.code).toBe(200)
    // Al revés (la categoría primero) también: se revisa con todo aplicado.
    expect(m.catalog().categories.some((c) => c.id === category)).toBe(false)
  })

  it('no se puede reactivar un producto cuya categoría sigue archivada', async () => {
    const m = await montarServidor()
    const session = m.sesionDe('manager')
    const category = String(
      m.db.prepare('SELECT id FROM categories WHERE active = 1 ORDER BY name LIMIT 1').get()?.id,
    )
    const products = m.db
      .prepare('SELECT id FROM products WHERE category_id = ? AND active = 1')
      .all(category)
      .map((p) => String(p.id))
    await m.editar(session, [
      ...products.map((id) => ({ entity: 'products', id, data: { active: false } })),
      ...archive('categories', category),
    ])
    const r = await m.editar(session, [
      { entity: 'products', id: products[0], data: { active: true } },
    ])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/category está archivado/)
  })

  it('archivar un grupo archiva sus enlaces y queda en el historial', async () => {
    const m = await montarServidor()
    const tagliata = m.product('Tagliata di Manzo')
    const group = tagliata.groups[0]
    if (!group) throw new Error('falta')
    const enlace = String(
      m.db.prepare('SELECT id FROM product_modifier_groups WHERE group_id = ?').get(group.id)?.id,
    )
    const r = await m.editar(m.sesionDe('manager'), archive('modifier_groups', group.id))
    expect(r.code).toBe(200)
    expect(
      m.db.prepare('SELECT active FROM product_modifier_groups WHERE id = ?').get(enlace),
    ).toEqual({ active: 0 })
    expect(m.product('Tagliata di Manzo').groups).toHaveLength(0)
    // El enlace archivado se anotó, con una versión propia.
    expect(
      m.db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE record_id = ?').get(enlace)?.n,
    ).toBe(2)
    expect(r.cuerpo.version).toBe(m.catalog().version)
  })

  it('el aviso a los equipos lleva la versión final, después de archivar los enlaces', async () => {
    const m = await montarServidor()
    const group = m.product('Tagliata di Manzo').groups[0]
    if (!group) throw new Error('falta')
    const r = await m.editar(m.sesionDe('manager'), archive('modifier_groups', group.id))
    expect(m.avisos).toEqual([r.cuerpo.version])
  })

  it('archivar un producto y tocar en el mismo pedido uno de sus tamaños activos se rechaza', async () => {
    // Lo que el editor de la carta no debe mandar junto (ver borradores.propiedades.test.ts).
    const m = await montarServidor()
    const vino = m.product('Ramón Bilbao Crianza')
    const glass = vino.variants[0]
    if (!glass) throw new Error('falta')
    const before = m.catalog().version
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'products', id: vino.id, data: { active: false } },
      { entity: 'variants', id: glass.id, data: { price: glass.price + 1_000 } },
    ])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/Cambio 2.*product está archivado/)
    expect(m.catalog().version).toBe(before)
    // Por separado, sí.
    expect(
      (
        await m.editar(m.sesionDe('manager'), [
          { entity: 'products', id: vino.id, data: { active: false } },
        ])
      ).code,
    ).toBe(200)
  })

  it('archivar un grupo y tocar en el mismo pedido una de sus opciones activas se rechaza', async () => {
    const m = await montarServidor()
    const group = m.product('Tagliata di Manzo').groups[0]
    const option = group?.options[0]
    if (!group || !option) throw new Error('falta')
    const r = await m.editar(m.sesionDe('manager'), [
      { entity: 'modifier_groups', id: group.id, data: { active: false } },
      { entity: 'modifiers', id: option.id, data: { extra_price: option.extraPrice + 500 } },
    ])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/Cambio 2.*group está archivado/)
  })
})
