import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { COLUMNAS_COMUNES, TABLAS_VERSIONADAS } from './esquema'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, huellaSql, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado, sembrar } from './pruebas/utiles'
import type { BaseSqlite } from './sqlite'

// Migración 7 (tarea 1.6): datáfonos y precuentas en la cola de impresión.

const HASTA_6 = MIGRACIONES.filter((m) => m.version <= 6)
// Hasta la 7: las que vienen después tienen sus propias pruebas.
const HASTA_7 = MIGRACIONES.filter((m) => m.version <= 7)

/** Una base de la versión 6 con una impresora y trabajos de impresión de cada estado. */
function baseVersion6() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_6)
  const s = sembrar(db)
  const impresora = insertarVersionado(db, 'impresora', s.restaurante, {
    nombre: 'Barra',
    conexion: 'red',
    direccion: '192.168.1.50',
    puerto: 9100,
    ancho: 80,
  })
  const trabajo = (campos: Record<string, string | number | null>) => {
    const id = nuevoId()
    insertarEnTabla(db, 'trabajo_impresion', {
      id,
      restaurante_id: s.restaurante,
      impresora_id: impresora,
      tipo: 'comanda',
      contenido: '{"estacion":"Barra"}',
      creado_en: AHORA,
      ...campos,
    })
    return id
  }
  trabajo({ evento_id: nuevoId(), comanda_id: nuevoId() })
  trabajo({ tipo: 'prueba' })
  trabajo({ estado: 'impreso', terminado_en: AHORA, impreso_en_id: impresora, intentos: 2 })
  return { db, ...s, impresora, trabajo }
}

const filas = (db: BaseSqlite) => db.prepare('SELECT * FROM trabajo_impresion ORDER BY id').all()

describe('migración 7: cobro', () => {
  it('es la 7, se llama cobro y aplica sobre la 6', () => {
    const { db } = baseVersion6()
    expect(MIGRACIONES.find((m) => m.version === 7)?.nombre).toBe('cobro')
    expect(aplicarMigraciones(db, HASTA_7)).toEqual([7])
    expect(versionActual(db)).toBe(7)
    expect(db.prepare('SELECT nombre, hash FROM migracion WHERE version = 7').get()).toEqual({
      nombre: 'cobro',
      hash: huellaSql(MIGRACIONES[6]?.sql as string),
    })
  })

  it('la cola de impresión conserva cada fila tal cual y ahora acepta precuentas', () => {
    const { db, trabajo } = baseVersion6()
    const antes = filas(db)
    expect(antes).toHaveLength(3)
    expect(() => trabajo({ tipo: 'precuenta' })).toThrow()
    aplicarMigraciones(db, HASTA_7)
    expect(filas(db)).toEqual(antes)
    expect(() => trabajo({ tipo: 'precuenta' })).not.toThrow()
    expect(() => trabajo({ tipo: 'otra' })).toThrow()
  })

  it('la cola sigue sin dejar borrar, reemplazar ni duplicar un evento en la misma impresora', () => {
    const { db, trabajo, impresora } = baseVersion6()
    aplicarMigraciones(db, HASTA_7)
    const id = trabajo({})
    expect(() => db.prepare('DELETE FROM trabajo_impresion WHERE id = ?').run(id)).toThrow(
      /no se borra/,
    )
    expect(() =>
      db
        .prepare(
          'INSERT OR REPLACE INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en) SELECT id, restaurante_id, impresora_id, tipo, contenido, creado_en FROM trabajo_impresion WHERE id = ?',
        )
        .run(id),
    ).toThrow(/no se reemplazan/)
    const evento = nuevoId()
    trabajo({ evento_id: evento, comanda_id: 'c' })
    expect(() => trabajo({ evento_id: evento, comanda_id: 'c' })).toThrow()
    const indices = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'trabajo_impresion'",
      )
      .all()
      .map((i) => i.name)
    expect(indices).toEqual(
      expect.arrayContaining(['trabajo_impresion_pendiente', 'trabajo_impresion_unico']),
    )
    expect(impresora).toBeTruthy()
  })

  it('datafono es STRICT, versionada, con las columnas comunes, y no se borra', () => {
    const { db, restaurante } = baseVersion6()
    aplicarMigraciones(db, HASTA_7)
    expect(TABLAS_VERSIONADAS).toContain('datafono')
    const tabla = db
      .prepare('PRAGMA table_list')
      .all()
      .find((t) => t.name === 'datafono')
    expect(tabla).toMatchObject({ strict: 1 })
    const columnas = db
      .prepare("SELECT name FROM pragma_table_info('datafono')")
      .all()
      .map((c) => c.name)
    for (const comun of COLUMNAS_COMUNES) expect(columnas).toContain(comun)
    const id = insertarVersionado(db, 'datafono', restaurante, {
      nombre: 'Bold 1',
      proveedor: 'bold',
    })
    expect(() =>
      insertarVersionado(db, 'datafono', restaurante, { nombre: 'X', proveedor: 'visa' }),
    ).toThrow()
    expect(() =>
      insertarVersionado(db, 'datafono', restaurante, { nombre: '', proveedor: 'bold' }),
    ).toThrow()
    expect(() => db.prepare('DELETE FROM datafono WHERE id = ?').run(id)).toThrow(/se archiva/)
  })

  it('la base queda íntegra', () => {
    const { db } = baseVersion6()
    aplicarMigraciones(db, HASTA_7)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })
})
