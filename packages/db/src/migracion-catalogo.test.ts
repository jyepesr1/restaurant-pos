import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado } from './pruebas/utiles'
import type { BaseSqlite } from './sqlite'

// La migración 3 sobre una base real de la versión 2: el historial del catálogo (`catalogo_cambio`)
// queda con una fila por registro y no se puede reescribir.

const HASTA_V2 = MIGRACIONES.filter((m) => m.version <= 2)
// Hasta la 3: las pruebas de esta migración no dependen de las que vengan después.
const HASTA_V3 = MIGRACIONES.filter((m) => m.version <= 3)
const TABLAS_CATALOGO = [
  'impuesto',
  'estacion',
  'categoria',
  'producto',
  'variante',
  'grupo_modificador',
  'producto_grupo_modificador',
  'modificador',
  'producto_estacion',
] as const

/** Una base en la versión 2 con un restaurante cuyo catálogo tiene un registro en cada tabla. */
function baseVersion2() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_V2)
  const restaurante = nuevoId()
  let version = 0
  // Como el hub: cada registro toma el siguiente valor del contador.
  const v = (campos: Record<string, string | number | null> = {}) => ({
    version: ++version,
    actualizado_en: `2026-10-24T15:00:${String(version).padStart(2, '0')}.000Z`,
    ...campos,
  })
  insertarVersionado(
    db,
    'restaurante',
    restaurante,
    { nombre: 'Prueba', config: '{}' },
    restaurante,
  )
  const registrar = (tabla: string, campos: Record<string, string | number | null>) =>
    insertarVersionado(db, tabla, restaurante, v(campos))

  const impuesto = registrar('impuesto', { nombre: 'INC 8 %', tipo: 'inc', tarifa: 800 })
  const exento = registrar('impuesto', { nombre: 'Exento', tipo: 'exento', tarifa: 0 })
  const estacion = registrar('estacion', { nombre: 'Cocina', orden: 1 })
  const categoria = registrar('categoria', {
    nombre: 'Pizzas',
    orden: 2,
    estacion_id: estacion,
    foto: 'pizzas.jpg',
    usuario_id: nuevoId(),
    dispositivo_id: nuevoId(),
  })
  const producto = registrar('producto', {
    categoria_id: categoria,
    nombre: 'Margarita',
    descripcion: null,
    precio: 40_900,
    impuesto_id: impuesto,
    favorito: 1,
  })
  // Archivado: también entra al historial, con activo = 0.
  const archivado = registrar('producto', {
    categoria_id: categoria,
    nombre: 'Vieja',
    precio: 1_000,
    impuesto_id: exento,
    activo: 0,
  })
  const variante = registrar('variante', {
    producto_id: producto,
    nombre: 'Grande',
    precio: 50_000,
    orden: 1,
  })
  const grupo = registrar('grupo_modificador', { nombre: 'Extras', minimo: 0, maximo: 3 })
  registrar('producto_grupo_modificador', { producto_id: producto, grupo_id: grupo, orden: 0 })
  registrar('modificador', { grupo_id: grupo, nombre: 'Queso', precio_extra: 3_000, orden: 0 })
  registrar('producto_estacion', { producto_id: producto, estacion_id: estacion })
  // El contador global del catálogo, como lo deja el hub.
  db.prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', ?)").run(
    restaurante,
    version,
  )
  return { db, restaurante, producto, archivado, variante, categoria, ultimaVersion: version }
}

const historial = (db: BaseSqlite) =>
  db.prepare('SELECT * FROM catalogo_cambio ORDER BY version').all()

describe('migración 3 sobre una base de la versión 2', () => {
  it('es la migración 3 y crea el historial', () => {
    const { db } = baseVersion2()
    expect(MIGRACIONES.find((m) => m.version === 3)?.nombre).toBe('catalogo_cambio')
    expect(versionActual(db)).toBe(2)
    expect(aplicarMigraciones(db, HASTA_V3)).toEqual([3])
    expect(versionActual(db)).toBe(3)
  })

  it('deja una fila por registro del catálogo, también los archivados', () => {
    const { db, restaurante } = baseVersion2()
    const antes: Record<string, number> = {}
    for (const t of TABLAS_CATALOGO)
      antes[t] = Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n)

    aplicarMigraciones(db)

    for (const t of TABLAS_CATALOGO) {
      const n = Number(
        db.prepare('SELECT count(*) AS n FROM catalogo_cambio WHERE entidad = ?').get(t)?.n,
      )
      expect(n, t).toBe(antes[t])
    }
    expect(historial(db)).toHaveLength(Object.values(antes).reduce((a, b) => a + b, 0))
    expect(historial(db)).toHaveLength(11)
    // Solo del catálogo: ni el restaurante ni nada más entra.
    expect(db.prepare("SELECT 1 FROM catalogo_cambio WHERE entidad = 'restaurante'").get()).toBe(
      undefined,
    )
    expect(historial(db).every((f) => f.restaurante_id === restaurante)).toBe(true)
  })

  it('cada fila conserva la versión, el autor y la hora del registro, sin estado anterior', () => {
    const { db, categoria } = baseVersion2()
    const fila = db.prepare('SELECT * FROM categoria WHERE id = ?').get(categoria)
    aplicarMigraciones(db)

    const cambio = db.prepare('SELECT * FROM catalogo_cambio WHERE registro_id = ?').get(categoria)
    expect(cambio).toMatchObject({
      version: fila?.version,
      entidad: 'categoria',
      antes: null,
      usuario_id: fila?.usuario_id,
      dispositivo_id: fila?.dispositivo_id,
      hecho_en: fila?.actualizado_en,
    })
    expect(JSON.parse(String(cambio?.despues))).toEqual(fila)
  })

  it('el estado guardado trae todas las columnas de cada tabla, ni una más ni una menos', () => {
    const { db } = baseVersion2()
    aplicarMigraciones(db)
    for (const tabla of TABLAS_CATALOGO) {
      const columnas = db
        .prepare(`PRAGMA table_info(${tabla})`)
        .all()
        .map((c) => String(c.name))
        .sort()
      const cambio = db.prepare('SELECT despues FROM catalogo_cambio WHERE entidad = ?').get(tabla)
      expect(Object.keys(JSON.parse(String(cambio?.despues))).sort(), tabla).toEqual(columnas)
    }
  })

  it('el estado guardado es igual a la fila de la tabla (valores y tipos)', () => {
    const { db } = baseVersion2()
    aplicarMigraciones(db)
    for (const tabla of TABLAS_CATALOGO) {
      for (const fila of db.prepare(`SELECT * FROM ${tabla}`).all()) {
        const cambio = db
          .prepare('SELECT despues FROM catalogo_cambio WHERE registro_id = ?')
          .get(fila.id ?? '')
        expect(JSON.parse(String(cambio?.despues)), `${tabla} ${fila.id}`).toEqual(fila)
      }
    }
  })

  it('no toca los datos de la versión 2', () => {
    const { db } = baseVersion2()
    const foto = () =>
      TABLAS_CATALOGO.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())
    const antes = foto()
    aplicarMigraciones(db)
    expect(foto()).toEqual(antes)
  })

  it('anota desde qué versión hay historial: la última del contador al migrar', () => {
    const { db, restaurante, ultimaVersion } = baseVersion2()
    aplicarMigraciones(db)
    const contador = (nombre: string) =>
      db
        .prepare('SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = ?')
        .get(restaurante, nombre)?.valor
    expect(contador('historial_desde')).toBe(ultimaVersion)
    expect(contador('catalogo')).toBe(ultimaVersion)
    // Una migración repetida no lo mueve.
    aplicarMigraciones(db)
    expect(contador('historial_desde')).toBe(ultimaVersion)
  })

  it('sin contador de catálogo (base sin ediciones) no inventa historial_desde', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db, HASTA_V2)
    const r = nuevoId()
    insertarVersionado(db, 'restaurante', r, { nombre: 'P', config: '{}' }, r)
    aplicarMigraciones(db)
    expect(db.prepare("SELECT 1 FROM contador WHERE nombre = 'historial_desde'").get()).toBe(
      undefined,
    )
  })

  it('una base de la versión 2 sin catálogo migra con el historial vacío', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db, HASTA_V2)
    expect(aplicarMigraciones(db, HASTA_V3)).toEqual([3])
    expect(historial(db)).toEqual([])
  })

  it('repetir la migración no duplica el historial', () => {
    const { db } = baseVersion2()
    aplicarMigraciones(db)
    const n = historial(db).length
    expect(aplicarMigraciones(db)).toEqual([])
    expect(historial(db)).toHaveLength(n)
  })

  it('con dos restaurantes en la misma base, cada uno conserva su propio historial', () => {
    const { db, restaurante } = baseVersion2()
    const otro = nuevoId()
    insertarVersionado(db, 'restaurante', otro, { nombre: 'Otro', config: '{}' }, otro)
    // Las mismas versiones que el primero: la llave es (restaurante, versión).
    insertarVersionado(db, 'estacion', otro, { nombre: 'Barra', version: 1 })
    aplicarMigraciones(db)
    const por = (r: string) =>
      Number(
        db.prepare('SELECT count(*) AS n FROM catalogo_cambio WHERE restaurante_id = ?').get(r)?.n,
      )
    expect(por(restaurante)).toBe(11)
    expect(por(otro)).toBe(1)
  })

  it('si dos registros comparten versión la migración falla entera y la base sigue en la 2', () => {
    // Nunca pasa con el contador del hub; si pasara, mejor frenar que perder historia.
    const { db, restaurante } = baseVersion2()
    insertarVersionado(db, 'estacion', restaurante, { nombre: 'Repetida', version: 1 })
    expect(() => aplicarMigraciones(db)).toThrow()
    expect(versionActual(db)).toBe(2)
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'catalogo_cambio'").get()).toBe(
      undefined,
    )
  })
})

describe('el historial del catálogo es de solo agregar', () => {
  function migrada() {
    const m = baseVersion2()
    aplicarMigraciones(m.db)
    const fila = historial(m.db)[0]
    return { ...m, fila }
  }

  it('rechaza UPDATE', () => {
    const { db } = migrada()
    expect(() => db.exec("UPDATE catalogo_cambio SET despues = '{}'")).toThrow(/no se modifican/)
    expect(() => db.exec('UPDATE catalogo_cambio SET usuario_id = NULL')).toThrow(/no se modifican/)
  })

  it('rechaza DELETE', () => {
    const { db } = migrada()
    const n = historial(db).length
    expect(() => db.exec('DELETE FROM catalogo_cambio')).toThrow(/no se borran/)
    expect(() => db.exec('DELETE FROM catalogo_cambio WHERE version = 1')).toThrow(/no se borran/)
    expect(historial(db)).toHaveLength(n)
  })

  it('rechaza INSERT OR REPLACE y REPLACE INTO sobre una versión existente', () => {
    const { db, restaurante, fila } = migrada()
    const antes = historial(db)
    const reemplazo = (verbo: string) =>
      db
        .prepare(
          `${verbo} INTO catalogo_cambio (restaurante_id, version, entidad, registro_id, despues, hecho_en)
           VALUES (?, ?, 'producto', ?, '{"falso":true}', ?)`,
        )
        .run(restaurante, Number(fila?.version), nuevoId(), AHORA)
    expect(() => reemplazo('INSERT OR REPLACE')).toThrow(/no se reemplazan/)
    expect(() => reemplazo('REPLACE')).toThrow(/no se reemplazan/)
    expect(() => reemplazo('INSERT')).toThrow(/no se reemplazan/)
    expect(historial(db)).toEqual(antes)
  })

  it('INSERT OR IGNORE sobre una versión existente tampoco cambia nada', () => {
    const { db, restaurante, fila } = migrada()
    const antes = historial(db)
    try {
      db.prepare(
        `INSERT OR IGNORE INTO catalogo_cambio (restaurante_id, version, entidad, registro_id, despues, hecho_en)
         VALUES (?, ?, 'producto', ?, '{}', ?)`,
      ).run(restaurante, Number(fila?.version), nuevoId(), AHORA)
    } catch {
      // Abortar también está bien: lo que importa es que la historia no cambie.
    }
    expect(historial(db)).toEqual(antes)
  })

  it('sí deja agregar una versión nueva, incluso del mismo registro (muchos cambios)', () => {
    const { db, restaurante, producto, ultimaVersion } = migrada()
    for (let i = 1; i <= 50; i++)
      db.prepare(
        `INSERT INTO catalogo_cambio (restaurante_id, version, entidad, registro_id, antes, despues, hecho_en)
         VALUES (?, ?, 'producto', ?, NULL, ?, ?)`,
      ).run(restaurante, ultimaVersion + i, producto, JSON.stringify({ precio: i }), AHORA)
    const n = Number(
      db.prepare('SELECT count(*) AS n FROM catalogo_cambio WHERE registro_id = ?').get(producto)
        ?.n,
    )
    expect(n).toBe(51)
  })

  it('valida lo que se agrega: entidad, id, JSON y restaurante', () => {
    const { db, restaurante, ultimaVersion } = migrada()
    const insertar = (campos: {
      entidad?: string
      registro?: string
      antes?: string | null
      despues?: string
      restaurante?: string
      version?: number
    }) =>
      db
        .prepare(
          `INSERT INTO catalogo_cambio (restaurante_id, version, entidad, registro_id, antes, despues, hecho_en)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          campos.restaurante ?? restaurante,
          campos.version ?? ultimaVersion + 1,
          campos.entidad ?? 'producto',
          campos.registro ?? nuevoId(),
          campos.antes ?? null,
          campos.despues ?? '{}',
          AHORA,
        )
    expect(() => insertar({ entidad: 'mesa' })).toThrow()
    expect(() => insertar({ entidad: 'restaurante' })).toThrow()
    expect(() => insertar({ registro: 'corto' })).toThrow()
    expect(() => insertar({ despues: 'no es json' })).toThrow()
    expect(() => insertar({ antes: '{roto' })).toThrow()
    expect(() => insertar({ restaurante: nuevoId() })).toThrow()
    expect(() => insertar({ version: -1 })).toThrow()
    expect(() => insertar({})).not.toThrow()
  })

  it('la tabla está declarada como inmutable en el esquema', async () => {
    const { TABLAS_INMUTABLES } = await import('./esquema')
    expect(TABLAS_INMUTABLES).toContain('catalogo_cambio')
  })

  it('insertar directo en el catálogo no escribe el historial (eso lo hace el hub)', () => {
    // Insertar directo en el catálogo (sin pasar por el hub) no escribe el historial: eso lo hace
    // el hub, no la base.
    const { db, restaurante } = migrada()
    const n = historial(db).length
    insertarEnTabla(db, 'estacion', {
      id: nuevoId(),
      restaurante_id: restaurante,
      creado_en: AHORA,
      actualizado_en: AHORA,
      version: 999,
      nombre: 'Nueva',
      orden: 0,
    })
    expect(historial(db)).toHaveLength(n)
  })
})
