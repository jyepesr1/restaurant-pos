import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, huellaSql, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarVersionado } from './pruebas/utiles'
import type { BaseSqlite, ValorSql } from './sqlite'

// Las migraciones que siguen a la 4 se prueban aparte.
const HASTA_4 = MIGRACIONES.filter((m) => m.version <= 4)

// La migración 4 (tarea 1.2) sobre una base real de la versión 3: agrega `elemento_plano` sin
// tocar nada de lo que ya había, con sus reglas (CHECK), su trigger contra borrados y sus claves.

const HASTA_V3 = MIGRACIONES.filter((m) => m.version <= 3)

/** Una base en la versión 3 con un salón: zona, mesas (una archivada) y una carta mínima. */
function baseVersion3() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_V3)
  const restaurante = nuevoId()
  insertarVersionado(
    db,
    'restaurante',
    restaurante,
    { nombre: 'Prueba', config: '{}' },
    restaurante,
  )
  const sede = insertarVersionado(db, 'sede', restaurante, {
    nombre: 'Envigado',
    zona_horaria: 'America/Bogota',
  })
  const zona = insertarVersionado(db, 'zona', restaurante, {
    sede_id: sede,
    nombre: 'Salón',
    piso: 1,
  })
  const mesa = (nombre: string, campos: Record<string, ValorSql> = {}) =>
    insertarVersionado(db, 'mesa', restaurante, {
      zona_id: zona,
      nombre,
      forma: 'cuadrada',
      x: 10,
      y: 20,
      ancho: 80,
      alto: 80,
      rotacion: 45,
      capacidad: 4,
      ...campos,
    })
  const mesaActiva = mesa('1')
  const mesaArchivada = mesa('2', { activo: 0 })
  const impuesto = insertarVersionado(db, 'impuesto', restaurante, {
    nombre: 'INC 8 %',
    tipo: 'inc',
    tarifa: 800,
  })
  const categoria = insertarVersionado(db, 'categoria', restaurante, { nombre: 'Pizzas' })
  const producto = insertarVersionado(db, 'producto', restaurante, {
    categoria_id: categoria,
    nombre: 'Margarita',
    precio: 40_900,
    impuesto_id: impuesto,
  })
  // Un historial del catálogo ya escrito en la versión 3.
  db.prepare(
    `INSERT INTO catalogo_cambio (restaurante_id, version, entidad, registro_id, antes, despues, hecho_en)
     VALUES (?, 7, 'producto', ?, NULL, '{"nombre":"Margarita"}', ?)`,
  ).run(restaurante, producto, AHORA)
  db.prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 7)").run(
    restaurante,
  )
  return { db, restaurante, zona, mesaActiva, mesaArchivada, producto }
}

const TABLAS = [
  'restaurante',
  'sede',
  'zona',
  'mesa',
  'impuesto',
  'categoria',
  'producto',
  'catalogo_cambio',
  'contador',
]
const foto = (db: BaseSqlite) =>
  TABLAS.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()])

function migrada() {
  const base = baseVersion3()
  aplicarMigraciones(base.db)
  const elemento = (campos: Record<string, ValorSql> = {}) =>
    insertarVersionado(base.db, 'elemento_plano', base.restaurante, {
      zona_id: base.zona,
      tipo: 'pared',
      x: 0,
      y: 0,
      ancho: 300,
      alto: 20,
      ...campos,
    })
  return { ...base, elemento }
}

describe('migración 4 sobre una base de la versión 3', () => {
  it('es la migración 4 y se aplica sola', () => {
    const { db } = baseVersion3()
    expect(MIGRACIONES.find((m) => m.version === 4)?.nombre).toBe('elemento_plano')
    expect(versionActual(db)).toBe(3)
    expect(aplicarMigraciones(db, HASTA_4)).toEqual([4])
    expect(versionActual(db)).toBe(4)
    // Repetirla no hace nada.
    expect(aplicarMigraciones(db, HASTA_4)).toEqual([])
  })

  it('no toca ningún dato de la versión 3: salón, carta, historial ni contadores', () => {
    const { db } = baseVersion3()
    const antes = foto(db)
    aplicarMigraciones(db)
    expect(foto(db)).toEqual(antes)
  })

  it('las mesas y zonas de antes siguen, también la archivada, con su geometría', () => {
    const { db, mesaActiva, mesaArchivada } = baseVersion3()
    aplicarMigraciones(db)
    expect(db.prepare('SELECT * FROM mesa WHERE id = ?').get(mesaActiva)).toMatchObject({
      x: 10,
      y: 20,
      ancho: 80,
      alto: 80,
      rotacion: 45,
      activo: 1,
    })
    expect(db.prepare('SELECT activo FROM mesa WHERE id = ?').get(mesaArchivada)?.activo).toBe(0)
  })

  it('la tabla nace vacía, es STRICT y tiene las columnas comunes del registro versionado', () => {
    const { db } = migrada()
    expect(db.prepare('SELECT count(*) AS n FROM elemento_plano').get()?.n).toBe(0)
    const tabla = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'elemento_plano'").get()
    expect(String(tabla?.sql)).toMatch(/STRICT/)
    const columnas = db
      .prepare('PRAGMA table_info(elemento_plano)')
      .all()
      .map((c) => String(c.name))
    expect(columnas).toEqual([
      'id',
      'restaurante_id',
      'creado_en',
      'actualizado_en',
      'version',
      'usuario_id',
      'dispositivo_id',
      'activo',
      'zona_id',
      'tipo',
      'texto',
      'x',
      'y',
      'ancho',
      'alto',
      'rotacion',
    ])
  })

  it('crea los índices por versión y por zona, y el trigger contra borrados', () => {
    const { db } = migrada()
    const objetos = db
      .prepare("SELECT name, type FROM sqlite_master WHERE tbl_name = 'elemento_plano'")
      .all()
      .map((o) => `${o.type}:${o.name}`)
    expect(objetos).toEqual(
      expect.arrayContaining([
        'index:elemento_plano_por_version',
        'index:elemento_plano_por_zona',
        'trigger:elemento_plano_sin_delete',
      ]),
    )
  })

  it('los triggers de lo anterior siguen en pie (historial del catálogo y borrados)', () => {
    const { db, restaurante, producto, mesaActiva } = migrada()
    expect(() => db.prepare('DELETE FROM catalogo_cambio').run()).toThrow(/no se borran/)
    expect(() => db.prepare('UPDATE catalogo_cambio SET hecho_en = ?').run(AHORA)).toThrow(
      /no se modifican/,
    )
    expect(() => db.prepare('DELETE FROM mesa WHERE id = ?').run(mesaActiva)).toThrow(/archiva/)
    expect(() => db.prepare('DELETE FROM producto WHERE id = ?').run(producto)).toThrow(/archiva/)
    expect(
      db
        .prepare('SELECT count(*) AS n FROM catalogo_cambio WHERE restaurante_id = ?')
        .get(restaurante)?.n,
    ).toBe(1)
  })

  it('la huella de la migración está en el registro: editarla después se detecta', () => {
    const { db } = migrada()
    const m4 = MIGRACIONES[3]
    expect(db.prepare('SELECT hash FROM migracion WHERE version = 4').get()?.hash).toBe(
      huellaSql(m4?.sql ?? ''),
    )
    const editadas = MIGRACIONES.map((m) =>
      m.version === 4 ? { ...m, sql: `${m.sql}\n-- editada` } : m,
    )
    expect(() => aplicarMigraciones(db, editadas)).toThrow(/cambió después de aplicarse/)
  })

  it('si la migración falla a medias, la base se queda en la versión 3 sin tabla', () => {
    const { db } = baseVersion3()
    const rota = HASTA_4.map((m) =>
      m.version === 4 ? { ...m, sql: `${m.sql}\nSELECT * FROM no_existe;` } : m,
    )
    expect(() => aplicarMigraciones(db, rota)).toThrow()
    expect(versionActual(db)).toBe(3)
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'elemento_plano'").get(),
    ).toBeUndefined()
    // Y se puede volver a intentar con la buena.
    expect(aplicarMigraciones(db, HASTA_4)).toEqual([4])
  })
})

describe('elemento_plano: reglas de la tabla', () => {
  it('acepta cada tipo de elemento, con texto o sin él, y las coordenadas negativas', () => {
    const { elemento } = migrada()
    for (const tipo of ['pared', 'puerta', 'planta', 'barra', 'texto'])
      expect(() => elemento({ tipo })).not.toThrow()
    expect(() => elemento({ tipo: 'texto', texto: 'Baños' })).not.toThrow()
    expect(() => elemento({ x: -500, y: -10_000 })).not.toThrow()
  })

  it.each(['mesa', '', 'PARED', 'ventana'])('rechaza el tipo "%s"', (tipo) => {
    const { elemento } = migrada()
    expect(() => elemento({ tipo })).toThrow(/CHECK/)
  })

  it.each([0, -1, -100])('rechaza el ancho %d', (ancho) => {
    const { elemento } = migrada()
    expect(() => elemento({ ancho })).toThrow(/CHECK/)
  })

  it.each([0, -1])('rechaza el alto %d', (alto) => {
    const { elemento } = migrada()
    expect(() => elemento({ alto })).toThrow(/CHECK/)
  })

  it('acepta rotaciones de 0 a 359 y rechaza el resto', () => {
    const { elemento } = migrada()
    for (const rotacion of [0, 1, 180, 359]) expect(() => elemento({ rotacion })).not.toThrow()
    for (const rotacion of [-1, 360, 720]) expect(() => elemento({ rotacion })).toThrow(/CHECK/)
  })

  it('la rotación es 0 y está activo si no se dicen', () => {
    const { db, elemento } = migrada()
    const id = elemento()
    expect(
      db.prepare('SELECT rotacion, activo, texto FROM elemento_plano WHERE id = ?').get(id),
    ).toEqual({ rotacion: 0, activo: 1, texto: null })
  })

  it('rechaza activo fuera de 0 y 1, versión negativa e id que no mide 26', () => {
    const { db, restaurante, zona } = migrada()
    const base = { zona_id: zona, tipo: 'pared', x: 0, y: 0, ancho: 10, alto: 10 }
    const crear = (campos: Record<string, ValorSql>, id?: string) =>
      insertarVersionado(db, 'elemento_plano', restaurante, { ...base, ...campos }, id)
    expect(() => crear({ activo: 2 })).toThrow(/CHECK/)
    expect(() => crear({ activo: -1 })).toThrow(/CHECK/)
    expect(() => crear({ version: -1 })).toThrow(/CHECK/)
    expect(() => crear({}, 'corto')).toThrow(/CHECK/)
    expect(() => crear({ version: 0 })).not.toThrow()
  })

  it('en la tabla STRICT no entran decimales ni texto en las medidas', () => {
    const { elemento } = migrada()
    expect(() => elemento({ x: 0.5 })).toThrow(/REAL|datatype|INTEGER/i)
    expect(() => elemento({ ancho: 10.5 })).toThrow(/REAL|datatype|INTEGER/i)
    expect(() => elemento({ y: 'arriba' })).toThrow(/datatype|INTEGER/i)
  })

  it('exige zona y restaurante que existan', () => {
    const { db, restaurante, elemento } = migrada()
    expect(() => elemento({ zona_id: nuevoId() })).toThrow(/FOREIGN/)
    const campos = { zona_id: null, tipo: 'pared', x: 0, y: 0, ancho: 10, alto: 10 }
    expect(() => insertarVersionado(db, 'elemento_plano', restaurante, campos)).toThrow(/NOT NULL/)
    expect(() =>
      insertarVersionado(db, 'elemento_plano', nuevoId(), {
        ...campos,
        zona_id: db.prepare('SELECT id FROM zona').get()?.id as string,
      }),
    ).toThrow(/FOREIGN/)
  })

  it('no se borra: ni suelto ni con todos a la vez; se archiva con activo = 0', () => {
    const { db, elemento } = migrada()
    const id = elemento()
    expect(() => db.prepare('DELETE FROM elemento_plano WHERE id = ?').run(id)).toThrow(/archiva/)
    expect(() => db.prepare('DELETE FROM elemento_plano').run()).toThrow(/archiva/)
    db.prepare('UPDATE elemento_plano SET activo = 0, version = 2 WHERE id = ?').run(id)
    expect(db.prepare('SELECT activo, version FROM elemento_plano WHERE id = ?').get(id)).toEqual({
      activo: 0,
      version: 2,
    })
  })

  it('al actualizar vuelven a valer las reglas', () => {
    const { db, elemento } = migrada()
    const id = elemento()
    expect(() =>
      db.prepare('UPDATE elemento_plano SET rotacion = 360 WHERE id = ?').run(id),
    ).toThrow(/CHECK/)
    expect(() => db.prepare('UPDATE elemento_plano SET ancho = 0 WHERE id = ?').run(id)).toThrow(
      /CHECK/,
    )
    expect(() =>
      db.prepare('UPDATE elemento_plano SET zona_id = ? WHERE id = ?').run(nuevoId(), id),
    ).toThrow(/FOREIGN/)
  })

  it('una zona con elementos no se puede borrar (la zona tampoco se borra)', () => {
    const { db, zona, elemento } = migrada()
    elemento()
    expect(() => db.prepare('DELETE FROM zona WHERE id = ?').run(zona)).toThrow()
  })
})
