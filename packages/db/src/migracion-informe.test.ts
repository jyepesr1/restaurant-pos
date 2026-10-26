import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado, sembrar } from './pruebas/utiles'

// Migración 8 (tarea 1.9): `trabajo_impresion` acepta el cierre Z (`informe`) sin perder filas.

const HASTA_7 = MIGRACIONES.filter((m) => m.version <= 7)

function baseVersion7() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_7)
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
  return { db, trabajo }
}

const filas = (db: ReturnType<typeof abrirBase>) =>
  db.prepare('SELECT * FROM trabajo_impresion ORDER BY id').all()

describe('migración 8: informe', () => {
  it('es la 8, aplica sobre la 7 y deja las filas idénticas', () => {
    const { db, trabajo } = baseVersion7()
    trabajo()
    trabajo({ tipo: 'precuenta', evento_id: nuevoId(), comanda_id: 'precuenta' })
    trabajo({ tipo: 'prueba', estado: 'descartado', terminado_en: AHORA })
    const antes = filas(db)
    expect(MIGRACIONES.find((m) => m.version === 8)?.nombre).toBe('informe')
    expect(aplicarMigraciones(db)).toEqual([8])
    expect(versionActual(db)).toBe(8)
    expect(filas(db)).toEqual(antes)
  })

  it('antes no acepta el tipo informe; después sí, y no se reemplaza ni se borra', () => {
    const { db, trabajo } = baseVersion7()
    expect(() => trabajo({ tipo: 'informe' })).toThrow()
    aplicarMigraciones(db)
    const evento = nuevoId()
    trabajo({ tipo: 'informe', evento_id: evento, comanda_id: 'cierre' })
    // El mismo cierre en la misma impresora no se duplica (índice único).
    expect(() => trabajo({ tipo: 'informe', evento_id: evento, comanda_id: 'cierre' })).toThrow()
    // Una reimpresión va sin evento: puede haber varias.
    trabajo({ tipo: 'informe', comanda_id: 'cierre' })
    trabajo({ tipo: 'informe', comanda_id: 'cierre' })
    expect(() => db.prepare('DELETE FROM trabajo_impresion').run()).toThrow(/no se borra/)
    expect(() => trabajo({ tipo: 'otro' })).toThrow()
  })
})
