import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado, sembrar } from './pruebas/utiles'

// Migración 8 (tarea 1.9), más allá de lo básico: lo que la reconstrucción de la tabla no puede
// perder (restricciones, disparadores, índices y llaves) y que repetirla no hace nada.

function base(hastaVersion: number) {
  const db = abrirBase(':memory:')
  aplicarMigraciones(
    db,
    MIGRACIONES.filter((m) => m.version <= hastaVersion),
  )
  const s = sembrar(db)
  const impresora = insertarVersionado(db, 'impresora', s.restaurante, {
    nombre: 'Caja',
    conexion: 'red',
    direccion: '192.168.1.60',
    puerto: 9100,
    ancho: 80,
  })
  const trabajo = (campos: Record<string, string | number | null> = {}) =>
    insertarEnTabla(db, 'trabajo_impresion', {
      id: nuevoId(),
      restaurante_id: s.restaurante,
      impresora_id: impresora,
      tipo: 'comanda',
      contenido: '{}',
      creado_en: AHORA,
      ...campos,
    })
  return { db, s, impresora, trabajo }
}

const lista = (db: ReturnType<typeof abrirBase>, tipo: string) =>
  db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? ORDER BY name')
    .all(tipo, 'trabajo_impresion')
    .map((f) => String(f.name))

describe('migración 8: lo que conserva', () => {
  it('repetirla no hace nada y la base queda sin llaves rotas', () => {
    const { db, trabajo } = base(7)
    trabajo()
    expect(aplicarMigraciones(db)).toEqual([8])
    expect(aplicarMigraciones(db)).toEqual([])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('SELECT count(*) AS n FROM trabajo_impresion').get()?.n).toBe(1)
  })

  it('conserva los índices y disparadores que tenía la tabla', () => {
    const antes = base(7)
    const indicesAntes = lista(antes.db, 'index').filter((n) => !n.startsWith('sqlite_'))
    const disparadoresAntes = lista(antes.db, 'trigger')
    aplicarMigraciones(antes.db)
    expect(lista(antes.db, 'index').filter((n) => !n.startsWith('sqlite_'))).toEqual(indicesAntes)
    expect(lista(antes.db, 'trigger')).toEqual(disparadoresAntes)
    expect(disparadoresAntes.length).toBeGreaterThanOrEqual(2)
  })

  it('la tabla sigue siendo STRICT y no queda la tabla temporal', () => {
    const { db } = base(7)
    aplicarMigraciones(db)
    const sql = String(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trabajo_impresion'").get()?.sql,
    )
    expect(sql).toMatch(/STRICT/)
    expect(sql).toContain("'informe'")
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'trabajo_impresion_nueva'").get(),
    ).toBeUndefined()
  })

  it('las demás restricciones siguen: estado, terminado y quien imprimió', () => {
    const { db, impresora, trabajo } = base(7)
    aplicarMigraciones(db)
    expect(() => trabajo({ tipo: 'informe', estado: 'raro' })).toThrow()
    // Pendiente con fecha de término, o terminado sin ella, no vale.
    expect(() => trabajo({ tipo: 'informe', terminado_en: AHORA })).toThrow()
    expect(() => trabajo({ tipo: 'informe', estado: 'descartado' })).toThrow()
    // Impreso sin decir en qué impresora, tampoco.
    expect(() => trabajo({ tipo: 'informe', estado: 'impreso', terminado_en: AHORA })).toThrow()
    expect(() =>
      trabajo({
        tipo: 'informe',
        estado: 'impreso',
        terminado_en: AHORA,
        impreso_en_id: impresora,
      }),
    ).not.toThrow()
    // El contenido es JSON.
    expect(() => trabajo({ tipo: 'informe', contenido: 'no es json' })).toThrow()
    // Una impresora que no existe.
    expect(() => trabajo({ tipo: 'informe', impresora_id: nuevoId() })).toThrow()
  })

  it('el mismo evento puede dar un cierre Z y una comanda en la misma impresora sin chocar', () => {
    const { db, trabajo } = base(8)
    const evento = nuevoId()
    trabajo({ tipo: 'informe', evento_id: evento, comanda_id: 'cierre' })
    trabajo({ tipo: 'comanda', evento_id: evento, comanda_id: nuevoId() })
    expect(() => trabajo({ tipo: 'informe', evento_id: evento, comanda_id: 'cierre' })).toThrow()
    // INSERT OR REPLACE no reescribe el registro (SQLite no dispara el borrado en ese caso).
    const id = nuevoId()
    trabajo({ id, tipo: 'informe', comanda_id: 'cierre' })
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
           SELECT id, restaurante_id, impresora_id, tipo, '{"otro":1}', creado_en FROM trabajo_impresion WHERE id = ?`,
        )
        .run(id),
    ).toThrow(/no se reemplazan|no se borra/)
  })

  it('las filas viejas conservan estado, intentos, errores y fechas exactamente', () => {
    const { db, impresora, trabajo } = base(7)
    trabajo({
      intentos: 3,
      ultimo_error: 'La impresora rechazó la conexión',
      tipo: 'precuenta',
      comanda_id: 'precuenta',
      evento_id: nuevoId(),
    })
    trabajo({
      estado: 'impreso',
      terminado_en: AHORA,
      impreso_en_id: impresora,
      intentos: 1,
      contenido: '{"a":[1,2,3]}',
    })
    const antes = db.prepare('SELECT * FROM trabajo_impresion ORDER BY id').all()
    aplicarMigraciones(db)
    expect(db.prepare('SELECT * FROM trabajo_impresion ORDER BY id').all()).toEqual(antes)
  })
})
