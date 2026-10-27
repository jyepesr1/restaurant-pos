import { PGlite } from '@electric-sql/pglite'
import { newId } from '@pos/core'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from './migrations'
import { lazySql, sqlFromPg } from './pg'
import type { Sql } from './sql'

// The `pg` connector in the hard cases: nested transactions, errors midway, a connection that
// drops and the Worker's lazy connection.

type Call = { text: string; params: unknown[] | undefined }

/** A client that records everything and can fail on a specific statement. */
function fakeClient(
  failsAt: (text: string, params: unknown[] | undefined) => unknown = () => undefined,
) {
  const calls: Call[] = []
  return {
    calls,
    texts: () => calls.map((l) => l.text),
    client: {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params })
        const error = failsAt(text, params)
        if (error !== undefined) throw error
        return { rows: [{ ok: true }] }
      },
    },
  }
}

/** A client over PGlite, as in pg.test.ts. */
function clientOverPglite(db: PGlite) {
  return {
    async query(text: string, params?: unknown[]) {
      if (params === undefined) {
        const r = await db.exec(text)
        return { rows: r.at(-1)?.rows ?? [] }
      }
      return db.query(text, params)
    },
  }
}

describe('sqlFromPg: transactions', () => {
  it('opens BEGIN, does the job and commits with COMMIT, in that order', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    const r = await sql.transaction(async (tx) => {
      await tx.query('SELECT 1')
      return 'ready'
    })
    expect(r).toBe('ready')
    expect(f.texts()).toEqual(['BEGIN', 'SELECT 1', 'COMMIT'])
  })

  it('a nested transaction does not open another: a single BEGIN and a single COMMIT', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    await sql.transaction(async (outer) => {
      await outer.query('SELECT 1')
      await outer.transaction(async (inner) => {
        await inner.query('SELECT 2')
        await inner.transaction(async (innermost) => {
          await innermost.query('SELECT 3')
        })
      })
      await outer.query('SELECT 4')
    })
    expect(f.texts()).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4', 'COMMIT'])
  })

  it('the nested one returns its value to its caller', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    const r = await sql.transaction((tx) => tx.transaction(async () => 42))
    expect(r).toBe(42)
  })

  it('if the nested one fails and the error propagates, everything is rolled back: a single ROLLBACK and no COMMIT', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    const error = new Error('failed inside')
    await expect(
      sql.transaction(async (outer) => {
        await outer.query('SELECT 1')
        await outer.transaction(async (inner) => {
          await inner.query('SELECT 2')
          throw error
        })
      }),
    ).rejects.toBe(error)
    expect(f.texts()).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'ROLLBACK'])
  })

  it('with real data: if the nested one fails, nothing written before or inside remains', async () => {
    const db = new PGlite()
    const sql = sqlFromPg(clientOverPglite(db) as never)
    await migrate(sql)
    const [a, b] = [newId(), newId()]
    await expect(
      sql.transaction(async (outer) => {
        await outer.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [a, 'A'])
        await outer.transaction(async (inner) => {
          await inner.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [b, 'B'])
          throw new Error('it failed')
        })
      }),
    ).rejects.toThrow('it failed')
    expect((await db.query('SELECT 1 FROM restaurants')).rows).toEqual([])
  })

  it('with real data: an SQL error midway through the transaction rolls it back, and the connection keeps working', async () => {
    const db = new PGlite()
    const sql = sqlFromPg(clientOverPglite(db) as never)
    await migrate(sql)
    const id = newId()
    await expect(
      sql.transaction(async (tx) => {
        await tx.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [id, 'A'])
        // Violates the id length constraint: Postgres aborts the transaction.
        await tx.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', ['corto', 'B'])
      }),
    ).rejects.toThrow(/check|violates/i)
    expect(await sql.query('SELECT 1 FROM restaurants')).toEqual([])
    // A new transaction works normally after the failure.
    await sql.transaction((tx) =>
      tx.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [id, 'A']),
    )
    expect(await sql.query('SELECT 1 FROM restaurants')).toHaveLength(1)
  })

  it('with real data: two transactions in a row (the second after a rollback) do not contaminate each other', async () => {
    const db = new PGlite()
    const sql = sqlFromPg(clientOverPglite(db) as never)
    await migrate(sql)
    for (let i = 0; i < 3; i++) {
      await expect(
        sql.transaction(async (tx) => {
          await tx.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [newId(), 'x'])
          throw new Error(`round ${i}`)
        }),
      ).rejects.toThrow(`round ${i}`)
    }
    expect(await sql.query('SELECT 1 FROM restaurants')).toEqual([])
  })

  it('after a transaction ends, the same Sql opens a new one on the next (it does not stay "inside")', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    await sql.transaction(async () => {})
    await sql.transaction(async () => {})
    expect(f.texts()).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
  })

  it('after a rollback, the next transaction opens BEGIN again', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    await expect(sql.transaction(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await sql.transaction(async () => {})
    expect(f.texts()).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT'])
  })

  it('a job that throws a non-Error value is rethrown as is', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    const odd = { code: 7 }
    await expect(sql.transaction(async () => Promise.reject(odd))).rejects.toBe(odd)
    await expect(sql.transaction(async () => Promise.reject('text'))).rejects.toBe('text')
    expect(f.texts().filter((t) => t === 'ROLLBACK')).toHaveLength(2)
  })

  it('if COMMIT fails, a rollback is attempted and the error that propagates is the COMMIT one', async () => {
    const error = new Error('could not commit')
    const f = fakeClient((t) => (t === 'COMMIT' ? error : undefined))
    const sql = sqlFromPg(f.client as never)
    await expect(sql.transaction(async (tx) => tx.query('SELECT 1'))).rejects.toBe(error)
    expect(f.texts()).toEqual(['BEGIN', 'SELECT 1', 'COMMIT', 'ROLLBACK'])
  })

  it('if BEGIN fails, the job does not run and there is no ROLLBACK', async () => {
    const error = new Error('no connection')
    const f = fakeClient((t) => (t === 'BEGIN' ? error : undefined))
    const sql = sqlFromPg(f.client as never)
    const job = vi.fn()
    await expect(sql.transaction(job)).rejects.toBe(error)
    expect(job).not.toHaveBeenCalled()
    expect(f.texts()).toEqual(['BEGIN'])
  })

  it('if the connection drops midway (the ROLLBACK fails too), the original error propagates', async () => {
    const original = new Error('Connection terminated unexpectedly')
    const f = fakeClient((t) => {
      if (t === 'SELECT 2') return original
      if (t === 'ROLLBACK') return new Error('Client was closed and is not queryable')
      return undefined
    })
    const sql = sqlFromPg(f.client as never)
    await expect(
      sql.transaction(async (tx) => {
        await tx.query('SELECT 1')
        await tx.query('SELECT 2')
      }),
    ).rejects.toBe(original)
  })

  it('the value the job returns arrives even if it is undefined, null or 0', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    expect(await sql.transaction(async () => undefined)).toBeUndefined()
    expect(await sql.transaction(async () => null)).toBeNull()
    expect(await sql.transaction(async () => 0)).toBe(0)
  })
})

describe('sqlFromPg: queries', () => {
  it('query sends a copy of the parameters and returns the rows', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    const params = Object.freeze(['a', 1]) as readonly unknown[]
    expect(await sql.query('SELECT $1, $2', params)).toEqual([{ ok: true }])
    expect(f.calls[0]?.params).toEqual(['a', 1])
    expect(f.calls[0]?.params).not.toBe(params)
  })

  it('execute sends the whole script without parameters (several statements in one)', async () => {
    const f = fakeClient()
    const sql = sqlFromPg(f.client as never)
    await sql.execute('CREATE TABLE a (x int); CREATE TABLE b (x int);')
    expect(f.calls).toEqual([
      { text: 'CREATE TABLE a (x int); CREATE TABLE b (x int);', params: undefined },
    ])
  })

  it('an error in a standalone query (outside a transaction) propagates unchanged and without ROLLBACK', async () => {
    const error = new Error('syntax')
    const f = fakeClient(() => error)
    const sql = sqlFromPg(f.client as never)
    await expect(sql.query('SELECT')).rejects.toBe(error)
    expect(f.texts()).toEqual(['SELECT'])
  })

  it('queries inside a transaction go through the same client, in order', async () => {
    const db = new PGlite()
    const sql = sqlFromPg(clientOverPglite(db) as never)
    await migrate(sql)
    const id = newId()
    await sql.transaction(async (tx) => {
      await tx.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [id, 'R'])
      // What was written is visible inside the same transaction.
      expect(await tx.query('SELECT name FROM restaurants WHERE id = $1', [id])).toEqual([
        { name: 'R' },
      ])
    })
    expect(await sql.query('SELECT name FROM restaurants WHERE id = $1', [id])).toEqual([
      { name: 'R' },
    ])
  })
})

describe('lazySql', () => {
  const fakeSql = (): Sql & { queries: string[] } => {
    const queries: string[] = []
    return {
      queries,
      query: async (t) => {
        queries.push(t)
        return [{ n: 1 }] as never
      },
      execute: async (t) => {
        queries.push(t)
      },
      transaction: async (job) => job(fakeSql()),
    }
  }

  it('does not connect until the first query', () => {
    const connect = vi.fn(async () => fakeSql())
    lazySql(connect)
    expect(connect).not.toHaveBeenCalled()
  })

  it('connects only once even with many queries, concurrent ones too', async () => {
    const connect = vi.fn(async () => fakeSql())
    const sql = lazySql(connect)
    await Promise.all([
      sql.query('a'),
      sql.query('b'),
      sql.execute('c'),
      sql.transaction(async () => 1),
    ])
    await sql.query('d')
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('passes text and parameters as is, and returns what the database responds', async () => {
    const real = {
      query: vi.fn(async () => [{ x: 1 }]),
      execute: vi.fn(),
      transaction: vi.fn(async (t) => t(real)),
    }
    const sql = lazySql(async () => real as never)
    expect(await sql.query('SELECT $1', [7])).toEqual([{ x: 1 }])
    expect(real.query).toHaveBeenCalledWith('SELECT $1', [7])
    await sql.execute('script')
    expect(real.execute).toHaveBeenCalledWith('script')
    expect(await sql.transaction(async (tx) => tx === real)).toBe(true)
  })

  it('if it could not connect, each query fails with that error (it does not hang)', async () => {
    const error = new Error('no network')
    const sql = lazySql(async () => {
      throw error
    })
    await expect(sql.query('a')).rejects.toBe(error)
    await expect(sql.execute('b')).rejects.toBe(error)
    await expect(sql.transaction(async () => 1)).rejects.toBe(error)
  })
})
