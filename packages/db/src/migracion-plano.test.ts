import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, huellaSql, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarVersionado } from './pruebas/utiles'
import type { BaseSqlite, ValorSql } from './sqlite'

// Las migraciones que siguen a la 4 se prueban aparte.
const HASTA_4 = MIGRACIONES.filter((m) => m.version <= 4)

// La migración 4 (tarea 1.2) sobre una base real de la versión 3: agrega `floor_plan_element` sin
// tocar nada de lo que ya había, con sus reglas (CHECK), su trigger contra borrados y sus claves.

const HASTA_V3 = MIGRACIONES.filter((m) => m.version <= 3)

/** Una base en la versión 3 con un salón: zona, mesas (una archivada) y una carta mínima. */
function baseVersion3() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_V3)
  const restaurant = newId()
  insertarVersionado(db, 'restaurants', restaurant, { name: 'Prueba', config: '{}' }, restaurant)
  const location = insertarVersionado(db, 'locations', restaurant, {
    name: 'Envigado',
    time_zone: 'America/Bogota',
  })
  const zone = insertarVersionado(db, 'zones', restaurant, {
    location_id: location,
    name: 'Salón',
    level: 1,
  })
  const table = (name: string, fields: Record<string, ValorSql> = {}) =>
    insertarVersionado(db, 'dining_tables', restaurant, {
      zone_id: zone,
      name,
      shape: 'square',
      x: 10,
      y: 20,
      width: 80,
      height: 80,
      rotation: 45,
      capacity: 4,
      ...fields,
    })
  const mesaActiva = table('1')
  const mesaArchivada = table('2', { active: 0 })
  const tax = insertarVersionado(db, 'taxes', restaurant, {
    name: 'INC 8 %',
    type: 'inc',
    rate: 800,
  })
  const category = insertarVersionado(db, 'categories', restaurant, { name: 'Pizzas' })
  const product = insertarVersionado(db, 'products', restaurant, {
    category_id: category,
    name: 'Margarita',
    price: 40_900,
    tax_id: tax,
  })
  // Un historial del catálogo ya escrito en la versión 3.
  db.prepare(
    `INSERT INTO catalog_changes (restaurant_id, version, entity, record_id, before, after, done_at)
     VALUES (?, 7, 'products', ?, NULL, '{"name":"Margarita"}', ?)`,
  ).run(restaurant, product, AHORA)
  db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 7)").run(
    restaurant,
  )
  return { db, restaurant, zone, mesaActiva, mesaArchivada, product }
}

const TABLAS = [
  'restaurants',
  'locations',
  'zones',
  'dining_tables',
  'taxes',
  'categories',
  'products',
  'catalog_changes',
  'counters',
]
const photo = (db: BaseSqlite) =>
  TABLAS.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()])

function migrada() {
  const base = baseVersion3()
  aplicarMigraciones(base.db)
  const element = (fields: Record<string, ValorSql> = {}) =>
    insertarVersionado(base.db, 'floor_plan_elements', base.restaurant, {
      zone_id: base.zone,
      type: 'wall',
      x: 0,
      y: 0,
      width: 300,
      height: 20,
      ...fields,
    })
  return { ...base, element }
}

describe('migración 4 sobre una base de la versión 3', () => {
  it('es la migración 4 y se aplica sola', () => {
    const { db } = baseVersion3()
    expect(MIGRACIONES.find((m) => m.version === 4)?.name).toBe('floor_plan_elements')
    expect(versionActual(db)).toBe(3)
    expect(aplicarMigraciones(db, HASTA_4)).toEqual([4])
    expect(versionActual(db)).toBe(4)
    // Repetirla no hace nada.
    expect(aplicarMigraciones(db, HASTA_4)).toEqual([])
  })

  it('no toca ningún dato de la versión 3: salón, carta, historial ni contadores', () => {
    const { db } = baseVersion3()
    const before = photo(db)
    aplicarMigraciones(db)
    expect(photo(db)).toEqual(before)
  })

  it('las mesas y zonas de antes siguen, también la archivada, con su geometría', () => {
    const { db, mesaActiva, mesaArchivada } = baseVersion3()
    aplicarMigraciones(db)
    expect(db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(mesaActiva)).toMatchObject({
      x: 10,
      y: 20,
      width: 80,
      height: 80,
      rotation: 45,
      active: 1,
    })
    expect(
      db.prepare('SELECT active FROM dining_tables WHERE id = ?').get(mesaArchivada)?.active,
    ).toBe(0)
  })

  it('la tabla nace vacía, es STRICT y tiene las columnas comunes del registro versionado', () => {
    const { db } = migrada()
    expect(db.prepare('SELECT count(*) AS n FROM floor_plan_elements').get()?.n).toBe(0)
    const tableName = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'floor_plan_elements'")
      .get()
    expect(String(tableName?.sql)).toMatch(/STRICT/)
    const columns = db
      .prepare('PRAGMA table_info(floor_plan_elements)')
      .all()
      .map((c) => String(c.name))
    expect(columns).toEqual([
      'id',
      'restaurant_id',
      'created_at',
      'updated_at',
      'version',
      'user_id',
      'device_id',
      'active',
      'zone_id',
      'type',
      'text',
      'x',
      'y',
      'width',
      'height',
      'rotation',
    ])
  })

  it('crea los índices por versión y por zona, y el trigger contra borrados', () => {
    const { db } = migrada()
    const objetos = db
      .prepare("SELECT name, type FROM sqlite_master WHERE tbl_name = 'floor_plan_elements'")
      .all()
      .map((o) => `${o.type}:${o.name}`)
    expect(objetos).toEqual(
      expect.arrayContaining([
        'index:floor_plan_elements_by_version',
        'index:floor_plan_elements_by_zone',
        'trigger:floor_plan_elements_no_delete',
      ]),
    )
  })

  it('los triggers de lo anterior siguen en pie (historial del catálogo y borrados)', () => {
    const { db, restaurant, product, mesaActiva } = migrada()
    expect(() => db.prepare('DELETE FROM catalog_changes').run()).toThrow(/no se borran/)
    expect(() => db.prepare('UPDATE catalog_changes SET done_at = ?').run(AHORA)).toThrow(
      /no se modifican/,
    )
    expect(() => db.prepare('DELETE FROM dining_tables WHERE id = ?').run(mesaActiva)).toThrow(
      /archiva/,
    )
    expect(() => db.prepare('DELETE FROM products WHERE id = ?').run(product)).toThrow(/archiva/)
    expect(
      db
        .prepare('SELECT count(*) AS n FROM catalog_changes WHERE restaurant_id = ?')
        .get(restaurant)?.n,
    ).toBe(1)
  })

  it('la huella de la migración está en el registro: editarla después se detecta', () => {
    const { db } = migrada()
    const m4 = MIGRACIONES[3]
    expect(db.prepare('SELECT hash FROM migrations WHERE version = 4').get()?.hash).toBe(
      huellaSql(m4?.sql ?? ''),
    )
    const editadas = MIGRACIONES.map((m) =>
      m.version === 4 ? { ...m, sql: `${m.sql}\n-- editada` } : m,
    )
    expect(() => aplicarMigraciones(db, editadas)).toThrow(/cambió después de aplicarse/)
  })

  it('si la migración falla a medias, la base se queda en la versión 3 sin tabla', () => {
    const { db } = baseVersion3()
    const broken = HASTA_4.map((m) =>
      m.version === 4 ? { ...m, sql: `${m.sql}\nSELECT * FROM not_found;` } : m,
    )
    expect(() => aplicarMigraciones(db, broken)).toThrow()
    expect(versionActual(db)).toBe(3)
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'floor_plan_elements'").get(),
    ).toBeUndefined()
    // Y se puede volver a intentar con la buena.
    expect(aplicarMigraciones(db, HASTA_4)).toEqual([4])
  })
})

describe('elemento_plano: reglas de la tabla', () => {
  it('acepta cada tipo de elemento, con texto o sin él, y las coordenadas negativas', () => {
    const { element } = migrada()
    for (const type of ['wall', 'door', 'plant', 'bar', 'text'])
      expect(() => element({ type })).not.toThrow()
    expect(() => element({ type: 'text', text: 'Baños' })).not.toThrow()
    expect(() => element({ x: -500, y: -10_000 })).not.toThrow()
  })

  it.each(['table', '', 'WALL', 'ventana'])('rechaza el tipo "%s"', (type) => {
    const { element } = migrada()
    expect(() => element({ type })).toThrow(/CHECK/)
  })

  it.each([0, -1, -100])('rechaza el ancho %d', (width) => {
    const { element } = migrada()
    expect(() => element({ width })).toThrow(/CHECK/)
  })

  it.each([0, -1])('rechaza el alto %d', (height) => {
    const { element } = migrada()
    expect(() => element({ height })).toThrow(/CHECK/)
  })

  it('acepta rotaciones de 0 a 359 y rechaza el resto', () => {
    const { element } = migrada()
    for (const rotation of [0, 1, 180, 359]) expect(() => element({ rotation })).not.toThrow()
    for (const rotation of [-1, 360, 720]) expect(() => element({ rotation })).toThrow(/CHECK/)
  })

  it('la rotación es 0 y está activo si no se dicen', () => {
    const { db, element } = migrada()
    const id = element()
    expect(
      db.prepare('SELECT rotation, active, text FROM floor_plan_elements WHERE id = ?').get(id),
    ).toEqual({ rotation: 0, active: 1, text: null })
  })

  it('rechaza activo fuera de 0 y 1, versión negativa e id que no mide 26', () => {
    const { db, restaurant, zone } = migrada()
    const base = { zone_id: zone, type: 'wall', x: 0, y: 0, width: 10, height: 10 }
    const crear = (fields: Record<string, ValorSql>, id?: string) =>
      insertarVersionado(db, 'floor_plan_elements', restaurant, { ...base, ...fields }, id)
    expect(() => crear({ active: 2 })).toThrow(/CHECK/)
    expect(() => crear({ active: -1 })).toThrow(/CHECK/)
    expect(() => crear({ version: -1 })).toThrow(/CHECK/)
    expect(() => crear({}, 'corto')).toThrow(/CHECK/)
    expect(() => crear({ version: 0 })).not.toThrow()
  })

  it('en la tabla STRICT no entran decimales ni texto en las medidas', () => {
    const { element } = migrada()
    expect(() => element({ x: 0.5 })).toThrow(/REAL|datatype|INTEGER/i)
    expect(() => element({ width: 10.5 })).toThrow(/REAL|datatype|INTEGER/i)
    expect(() => element({ y: 'up' })).toThrow(/datatype|INTEGER/i)
  })

  it('exige zona y restaurante que existan', () => {
    const { db, restaurant, element } = migrada()
    expect(() => element({ zone_id: newId() })).toThrow(/FOREIGN/)
    const fields = { zone_id: null, type: 'wall', x: 0, y: 0, width: 10, height: 10 }
    expect(() => insertarVersionado(db, 'floor_plan_elements', restaurant, fields)).toThrow(
      /NOT NULL/,
    )
    expect(() =>
      insertarVersionado(db, 'floor_plan_elements', newId(), {
        ...fields,
        zone_id: db.prepare('SELECT id FROM zones').get()?.id as string,
      }),
    ).toThrow(/FOREIGN/)
  })

  it('no se borra: ni suelto ni con todos a la vez; se archiva con activo = 0', () => {
    const { db, element } = migrada()
    const id = element()
    expect(() => db.prepare('DELETE FROM floor_plan_elements WHERE id = ?').run(id)).toThrow(
      /archiva/,
    )
    expect(() => db.prepare('DELETE FROM floor_plan_elements').run()).toThrow(/archiva/)
    db.prepare('UPDATE floor_plan_elements SET active = 0, version = 2 WHERE id = ?').run(id)
    expect(
      db.prepare('SELECT active, version FROM floor_plan_elements WHERE id = ?').get(id),
    ).toEqual({
      active: 0,
      version: 2,
    })
  })

  it('al actualizar vuelven a valer las reglas', () => {
    const { db, element } = migrada()
    const id = element()
    expect(() =>
      db.prepare('UPDATE floor_plan_elements SET rotation = 360 WHERE id = ?').run(id),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare('UPDATE floor_plan_elements SET width = 0 WHERE id = ?').run(id),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare('UPDATE floor_plan_elements SET zone_id = ? WHERE id = ?').run(newId(), id),
    ).toThrow(/FOREIGN/)
  })

  it('una zona con elementos no se puede borrar (la zona tampoco se borra)', () => {
    const { db, zone, element } = migrada()
    element()
    expect(() => db.prepare('DELETE FROM zones WHERE id = ?').run(zone)).toThrow()
  })
})
