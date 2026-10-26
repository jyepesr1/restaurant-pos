import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado, sembrar } from './pruebas/utiles'

// Migración 8 (tarea 1.9): `print_jobs` acepta el cierre Z (`informe`) sin perder filas.

const HASTA_7 = MIGRACIONES.filter((m) => m.version <= 7)

function baseVersion7() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_7)
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
  return { db, trabajo }
}

const rows = (db: ReturnType<typeof abrirBase>) =>
  db.prepare('SELECT * FROM print_jobs ORDER BY id').all()

describe('migración 8: informe', () => {
  it('es la 8, aplica sobre la 7 y deja las filas idénticas', () => {
    const { db, trabajo } = baseVersion7()
    trabajo()
    trabajo({ type: 'preBill', event_id: newId(), ticket_id: 'preBill' })
    trabajo({ type: 'test', status: 'discarded', finished_at: AHORA })
    const before = rows(db)
    expect(MIGRACIONES.find((m) => m.version === 8)?.name).toBe('report')
    expect(aplicarMigraciones(db)).toEqual([8])
    expect(versionActual(db)).toBe(8)
    expect(rows(db)).toEqual(before)
  })

  it('antes no acepta el tipo informe; después sí, y no se reemplaza ni se borra', () => {
    const { db, trabajo } = baseVersion7()
    expect(() => trabajo({ type: 'report' })).toThrow()
    aplicarMigraciones(db)
    const event = newId()
    trabajo({ type: 'report', event_id: event, ticket_id: 'closeout' })
    // El mismo cierre en la misma impresora no se duplica (índice único).
    expect(() => trabajo({ type: 'report', event_id: event, ticket_id: 'closeout' })).toThrow()
    // Una reimpresión va sin evento: puede haber varias.
    trabajo({ type: 'report', ticket_id: 'closeout' })
    trabajo({ type: 'report', ticket_id: 'closeout' })
    expect(() => db.prepare('DELETE FROM print_jobs').run()).toThrow(/no se borra/)
    expect(() => trabajo({ type: 'other' })).toThrow()
  })
})
