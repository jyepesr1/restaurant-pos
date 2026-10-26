import { newId } from '@pos/core'
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
  const printer = insertarVersionado(db, 'printers', s.restaurant, {
    name: 'Barra',
    connection: 'network',
    address: '192.168.1.50',
    port: 9100,
    width: 80,
  })
  const trabajo = (fields: Record<string, string | number | null>) => {
    const id = newId()
    insertarEnTabla(db, 'print_jobs', {
      id,
      restaurant_id: s.restaurant,
      printer_id: printer,
      type: 'ticket',
      content: '{"station":"Barra"}',
      created_at: AHORA,
      ...fields,
    })
    return id
  }
  trabajo({ event_id: newId(), ticket_id: newId() })
  trabajo({ type: 'test' })
  trabajo({ status: 'printed', finished_at: AHORA, printed_on_id: printer, attempts: 2 })
  return { db, ...s, printer, trabajo }
}

const rows = (db: BaseSqlite) => db.prepare('SELECT * FROM print_jobs ORDER BY id').all()

describe('migración 7: cobro', () => {
  it('es la 7, se llama cobro y aplica sobre la 6', () => {
    const { db } = baseVersion6()
    expect(MIGRACIONES.find((m) => m.version === 7)?.name).toBe('checkout')
    expect(aplicarMigraciones(db, HASTA_7)).toEqual([7])
    expect(versionActual(db)).toBe(7)
    expect(db.prepare('SELECT name, hash FROM migrations WHERE version = 7').get()).toEqual({
      name: 'checkout',
      hash: huellaSql(MIGRACIONES[6]?.sql as string),
    })
  })

  it('la cola de impresión conserva cada fila tal cual y ahora acepta precuentas', () => {
    const { db, trabajo } = baseVersion6()
    const before = rows(db)
    expect(before).toHaveLength(3)
    expect(() => trabajo({ type: 'preBill' })).toThrow()
    aplicarMigraciones(db, HASTA_7)
    expect(rows(db)).toEqual(before)
    expect(() => trabajo({ type: 'preBill' })).not.toThrow()
    expect(() => trabajo({ type: 'otra' })).toThrow()
  })

  it('la cola sigue sin dejar borrar, reemplazar ni duplicar un evento en la misma impresora', () => {
    const { db, trabajo, printer } = baseVersion6()
    aplicarMigraciones(db, HASTA_7)
    const id = trabajo({})
    expect(() => db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id)).toThrow(/no se borra/)
    expect(() =>
      db
        .prepare(
          'INSERT OR REPLACE INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at) SELECT id, restaurant_id, printer_id, type, content, created_at FROM print_jobs WHERE id = ?',
        )
        .run(id),
    ).toThrow(/no se reemplazan/)
    const event = newId()
    trabajo({ event_id: event, ticket_id: 'c' })
    expect(() => trabajo({ event_id: event, ticket_id: 'c' })).toThrow()
    const indices = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'print_jobs'")
      .all()
      .map((i) => i.name)
    expect(indices).toEqual(expect.arrayContaining(['print_jobs_pending', 'print_jobs_unique']))
    expect(printer).toBeTruthy()
  })

  it('datafono es STRICT, versionada, con las columnas comunes, y no se borra', () => {
    const { db, restaurant } = baseVersion6()
    aplicarMigraciones(db, HASTA_7)
    expect(TABLAS_VERSIONADAS).toContain('card_terminals')
    const tabla = db
      .prepare('PRAGMA table_list')
      .all()
      .find((t) => t.name === 'card_terminals')
    expect(tabla).toMatchObject({ strict: 1 })
    const columnas = db
      .prepare("SELECT name FROM pragma_table_info('card_terminals')")
      .all()
      .map((c) => c.name)
    for (const common of COLUMNAS_COMUNES) expect(columnas).toContain(common)
    const id = insertarVersionado(db, 'card_terminals', restaurant, {
      name: 'Bold 1',
      provider: 'bold',
    })
    expect(() =>
      insertarVersionado(db, 'card_terminals', restaurant, { name: 'X', provider: 'visa' }),
    ).toThrow()
    expect(() =>
      insertarVersionado(db, 'card_terminals', restaurant, { name: '', provider: 'bold' }),
    ).toThrow()
    expect(() => db.prepare('DELETE FROM card_terminals WHERE id = ?').run(id)).toThrow(
      /se archiva/,
    )
  })

  it('la base queda íntegra', () => {
    const { db } = baseVersion6()
    aplicarMigraciones(db, HASTA_7)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })
})
