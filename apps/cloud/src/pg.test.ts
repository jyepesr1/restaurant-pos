import { PGlite } from '@electric-sql/pglite'
import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { event, itemCopy } from '../../../packages/core/src/testing/factory'
import { Cloud } from './cloud'
import { migrate } from './migrations'
import { sqlFromPg } from './pg'

// The `pg` connector (the one used by the Worker and the commands) over an embedded Postgres: a
// fake client that passes the queries to PGlite as node-postgres would with a real server.

function clientOf(db: PGlite) {
  return {
    async query(text: string, params?: unknown[]) {
      if (params === undefined) {
        // Like pg: without parameters, the text may contain several statements.
        const r = await db.exec(text)
        return { rows: r.at(-1)?.rows ?? [] }
      }
      return db.query(text, params)
    },
  }
}

describe('sqlFromPg', () => {
  it('migrates, registers a hub and saves a batch just like with PGlite directly', async () => {
    const db = new PGlite()
    const sql = sqlFromPg(clientOf(db) as never)
    expect(await migrate(sql)).toEqual([1])
    const cloud = new Cloud(sql, () => new Date('2026-10-26T15:00:00Z'))
    const restaurant = newId()
    await cloud.createRestaurant({ id: restaurant, name: 'R' })
    const code = await cloud.createCode(restaurant)
    if (!code) throw new Error('no code')
    const hubId = newId()
    const r = await cloud.registerHub({
      code: code.code,
      hub_id: hubId,
      location_id: newId(),
      name: 'Caja',
      instance: 'i',
    })
    if (!r.ok) throw new Error(r.reason)
    const hub = await cloud.authenticate(r.credential)
    if (!hub) throw new Error('no hub')
    const order = newId()
    const events = [
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 }),
      event(order, 'ItemAdded', itemCopy()),
    ]
    const results = await cloud.receiveEvents(hub, events)
    expect(results.map((x) => x.status)).toEqual(['saved', 'saved'])
    expect(await cloud.lastSequence(hub)).toBe(Math.max(...events.map((e) => e.sequence)))
  })

  it('if the job fails, the transaction is rolled back', async () => {
    const db = new PGlite()
    const sql = sqlFromPg(clientOf(db) as never)
    await migrate(sql)
    const id = newId()
    await expect(
      sql.transaction(async (tx) => {
        await tx.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [id, 'R'])
        throw new Error('it failed')
      }),
    ).rejects.toThrow('it failed')
    expect(await sql.query('SELECT 1 FROM restaurants WHERE id = $1', [id])).toEqual([])
  })
})
