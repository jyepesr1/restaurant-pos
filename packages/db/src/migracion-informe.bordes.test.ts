import { newId } from '@pos/core'
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
  const printer = insertarVersionado(db, 'printers', s.restaurant, {
    name: 'Caja',
    connection: 'network',
    address: '192.168.1.60',
    port: 9100,
    width: 80,
  })
  const trabajo = (fields: Record<string, string | number | null> = {}) =>
    insertarEnTabla(db, 'print_jobs', {
      id: newId(),
      restaurant_id: s.restaurant,
      printer_id: printer,
      type: 'ticket',
      content: '{}',
      created_at: AHORA,
      ...fields,
    })
  return { db, s, printer, trabajo }
}

const list = (db: ReturnType<typeof abrirBase>, type: string) =>
  db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? ORDER BY name')
    .all(type, 'print_jobs')
    .map((f) => String(f.name))

describe('migración 8: lo que conserva', () => {
  it('repetirla no hace nada y la base queda sin llaves rotas', () => {
    const { db, trabajo } = base(7)
    trabajo()
    expect(aplicarMigraciones(db)).toEqual([8])
    expect(aplicarMigraciones(db)).toEqual([])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('SELECT count(*) AS n FROM print_jobs').get()?.n).toBe(1)
  })

  it('conserva los índices y disparadores que tenía la tabla', () => {
    const before = base(7)
    const indicesAntes = list(before.db, 'index').filter((n) => !n.startsWith('sqlite_'))
    const disparadoresAntes = list(before.db, 'trigger')
    aplicarMigraciones(before.db)
    expect(list(before.db, 'index').filter((n) => !n.startsWith('sqlite_'))).toEqual(indicesAntes)
    expect(list(before.db, 'trigger')).toEqual(disparadoresAntes)
    expect(disparadoresAntes.length).toBeGreaterThanOrEqual(2)
  })

  it('la tabla sigue siendo STRICT y no queda la tabla temporal', () => {
    const { db } = base(7)
    aplicarMigraciones(db)
    const sql = String(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'print_jobs'").get()?.sql,
    )
    expect(sql).toMatch(/STRICT/)
    expect(sql).toContain("'report'")
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'print_jobs_new'").get(),
    ).toBeUndefined()
  })

  it('las demás restricciones siguen: estado, terminado y quien imprimió', () => {
    const { db, printer, trabajo } = base(7)
    aplicarMigraciones(db)
    expect(() => trabajo({ type: 'report', status: 'raro' })).toThrow()
    // Pendiente con fecha de término, o terminado sin ella, no vale.
    expect(() => trabajo({ type: 'report', finished_at: AHORA })).toThrow()
    expect(() => trabajo({ type: 'report', status: 'discarded' })).toThrow()
    // Impreso sin decir en qué impresora, tampoco.
    expect(() => trabajo({ type: 'report', status: 'printed', finished_at: AHORA })).toThrow()
    expect(() =>
      trabajo({
        type: 'report',
        status: 'printed',
        finished_at: AHORA,
        printed_on_id: printer,
      }),
    ).not.toThrow()
    // El contenido es JSON.
    expect(() => trabajo({ type: 'report', content: 'no es json' })).toThrow()
    // Una impresora que no existe.
    expect(() => trabajo({ type: 'report', printer_id: newId() })).toThrow()
  })

  it('el mismo evento puede dar un cierre Z y una comanda en la misma impresora sin chocar', () => {
    const { db, trabajo } = base(8)
    const event = newId()
    trabajo({ type: 'report', event_id: event, ticket_id: 'closeout' })
    trabajo({ type: 'ticket', event_id: event, ticket_id: newId() })
    expect(() => trabajo({ type: 'report', event_id: event, ticket_id: 'closeout' })).toThrow()
    // INSERT OR REPLACE no reescribe el registro (SQLite no dispara el borrado en ese caso).
    const id = newId()
    trabajo({ id, type: 'report', ticket_id: 'closeout' })
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
           SELECT id, restaurant_id, printer_id, type, '{"other":1}', created_at FROM print_jobs WHERE id = ?`,
        )
        .run(id),
    ).toThrow(/no se reemplazan|no se borra/)
  })

  it('las filas viejas conservan estado, intentos, errores y fechas exactamente', () => {
    const { db, printer, trabajo } = base(7)
    trabajo({
      attempts: 3,
      last_error: 'La impresora rechazó la conexión',
      type: 'preBill',
      ticket_id: 'preBill',
      event_id: newId(),
    })
    trabajo({
      status: 'printed',
      finished_at: AHORA,
      printed_on_id: printer,
      attempts: 1,
      content: '{"a":[1,2,3]}',
    })
    const before = db.prepare('SELECT * FROM print_jobs ORDER BY id').all()
    aplicarMigraciones(db)
    expect(db.prepare('SELECT * FROM print_jobs ORDER BY id').all()).toEqual(before)
  })
})
