import { PGlite } from '@electric-sql/pglite'
import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { event, itemCopy } from '../../../packages/core/src/testing/factory'
import { migrar } from './migraciones'
import { Nube } from './nube'
import { sqlDePg } from './pg'

// El conector de `pg` (el del Worker y los comandos) sobre un Postgres embebido: un cliente de
// mentira que pasa las consultas a PGlite como lo haría node-postgres con un servidor real.

function clienteDe(db: PGlite) {
  return {
    async query(text: string, parametros?: unknown[]) {
      if (parametros === undefined) {
        // Como pg: sin parámetros, el texto puede traer varias sentencias.
        const r = await db.exec(text)
        return { rows: r.at(-1)?.rows ?? [] }
      }
      return db.query(text, parametros)
    },
  }
}

describe('sqlDePg', () => {
  it('migra, registra un hub y guarda un lote como con PGlite directo', async () => {
    const db = new PGlite()
    const sql = sqlDePg(clienteDe(db) as never)
    expect(await migrar(sql)).toEqual([1])
    const nube = new Nube(sql, () => new Date('2026-10-26T15:00:00Z'))
    const restaurant = newId()
    await nube.crearRestaurante({ id: restaurant, name: 'R' })
    const code = await nube.crearCodigo(restaurant)
    if (!code) throw new Error('sin código')
    const hubId = newId()
    const r = await nube.registrarHub({
      code: code.code,
      hub_id: hubId,
      location_id: newId(),
      name: 'Caja',
      instancia: 'i',
    })
    if (!r.ok) throw new Error(r.reason)
    const hub = await nube.authenticate(r.credential)
    if (!hub) throw new Error('sin hub')
    const order = newId()
    const events = [
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 }),
      event(order, 'ItemAdded', itemCopy()),
    ]
    const resultados = await nube.recibirEventos(hub, events)
    expect(resultados.map((x) => x.status)).toEqual(['saved', 'saved'])
    expect(await nube.lastSequence(hub)).toBe(Math.max(...events.map((e) => e.sequence)))
  })

  it('si el trabajo falla, la transacción se deshace', async () => {
    const db = new PGlite()
    const sql = sqlDePg(clienteDe(db) as never)
    await migrar(sql)
    const id = newId()
    await expect(
      sql.transaccion(async (tx) => {
        await tx.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [id, 'R'])
        throw new Error('se cayó')
      }),
    ).rejects.toThrow('se cayó')
    expect(await sql.query('SELECT 1 FROM restaurants WHERE id = $1', [id])).toEqual([])
  })
})
