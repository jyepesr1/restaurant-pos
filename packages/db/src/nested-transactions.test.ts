import { describe, expect, it } from 'vitest'
import { openDatabase } from './node'
import { inTransaction } from './sqlite'

// Nested `inTransaction` (task 1.3b): the inner work joins the outer transaction.

function base() {
  const db = openDatabase(':memory:')
  db.exec('CREATE TABLE t (x INTEGER PRIMARY KEY) STRICT')
  const xs = () =>
    db
      .prepare('SELECT x FROM t ORDER BY x')
      .all()
      .map((f) => f.x)
  const put = (...v: number[]) => {
    for (const n of v) db.prepare('INSERT INTO t VALUES (?)').run(n)
  }
  return { db, xs, put }
}

describe('nested transactions', () => {
  it('three levels that complete: everything stays, and the database leaves the transaction', () => {
    const { db, xs, put } = base()
    inTransaction(db, () => {
      put(1)
      inTransaction(db, () => {
        put(2)
        inTransaction(db, () => put(3))
      })
    })
    expect(xs()).toEqual([1, 2, 3])
    // If it were left "inside" a transaction, a direct BEGIN would fail.
    expect(() => {
      db.exec('BEGIN IMMEDIATE')
      db.exec('ROLLBACK')
    }).not.toThrow()
  })

  it('the deepest level fails and the error propagates uncaught: nothing from any level stays', () => {
    const { db, xs, put } = base()
    expect(() =>
      inTransaction(db, () => {
        put(1)
        inTransaction(db, () => {
          put(2)
          inTransaction(db, () => {
            put(3)
            put(3) // duplicate key halfway
          })
        })
      }),
    ).toThrow(/UNIQUE/)
    expect(xs()).toEqual([])
  })

  it('the middle level fails after the deepest one finished: everything is rolled back', () => {
    const { db, xs, put } = base()
    expect(() =>
      inTransaction(db, () => {
        inTransaction(db, () => {
          inTransaction(db, () => put(1))
          throw new Error('fails in the middle')
        })
        put(2)
      }),
    ).toThrow('fails in the middle')
    expect(xs()).toEqual([])
  })

  it('the outer one fails after the inner one "finished": the inner work does not stay either', () => {
    const { db, xs, put } = base()
    expect(() =>
      inTransaction(db, () => {
        inTransaction(db, () => put(1))
        throw new Error('fails outside')
      }),
    ).toThrow('fails outside')
    expect(xs()).toEqual([])
  })

  it('returns the value of each level', () => {
    const { db } = base()
    const r = inTransaction(db, () => inTransaction(db, () => 7) + 1)
    expect(r).toBe(8)
  })

  it('after a nested failure the next transaction starts clean (the "in progress" mark is cleared)', () => {
    const { db, xs, put } = base()
    for (let i = 0; i < 3; i++)
      expect(() =>
        inTransaction(db, () =>
          inTransaction(db, () => {
            put(9)
            throw new Error('x')
          }),
        ),
      ).toThrow('x')
    inTransaction(db, () => put(1))
    expect(xs()).toEqual([1])
    // And it is a real transaction: if it fails, it is rolled back.
    expect(() =>
      inTransaction(db, () => {
        put(2)
        throw new Error('y')
      }),
    ).toThrow('y')
    expect(xs()).toEqual([1])
  })

  it('two different databases do not share the mark: a transaction in A does not make the one in B "nested"', () => {
    const a = base()
    const b = base()
    expect(() =>
      inTransaction(a.db, () => {
        a.put(1)
        inTransaction(b.db, () => b.put(1))
        // B already committed on its own even though A is still open.
        expect(b.xs()).toEqual([1])
        throw new Error('A fails')
      }),
    ).toThrow('A fails')
    expect(a.xs()).toEqual([])
    expect(b.xs()).toEqual([1])
  })

  it('async work is rejected at the outer level, and what was done is rolled back', () => {
    const { db, xs, put } = base()
    expect(() =>
      inTransaction(db, async () => {
        put(1)
      }),
    ).toThrow(/asíncronas/)
    expect(xs()).toEqual([])
  })

  // This used to be a BUG: the nested one returned the promise without warning.
  it('a nested async function is rejected too', () => {
    const { db } = base()
    expect(() =>
      inTransaction(db, () => {
        inTransaction(db, async () => 1)
      }),
    ).toThrow(/asíncronas/)
  })

  // BUG (latent): there is no SAVEPOINT. If an inner level fails and the outer one catches the
  // error and continues, whatever the inner one managed to write is committed anyway: it "failed"
  // but left a trace. Expected the failing level to roll back on its own.
  it.fails('BUG: if the nested one fails and the caller continues, what it managed to write is rolled back', () => {
    const { db, xs, put } = base()
    inTransaction(db, () => {
      try {
        inTransaction(db, () => {
          put(1)
          throw new Error('fails halfway')
        })
      } catch {
        // the caller decides to continue
      }
      put(2)
    })
    expect(xs()).toEqual([2])
  })

  it('a constraint violation inside the nested one that SQLite resolves with ROLLBACK keeps the original error', () => {
    const { db, xs } = base()
    db.exec(
      "CREATE TRIGGER t_rb BEFORE INSERT ON t WHEN NEW.x = 99 BEGIN SELECT RAISE(ROLLBACK, 'error original'); END",
    )
    expect(() =>
      inTransaction(db, () => {
        db.prepare('INSERT INTO t VALUES (1)').run()
        inTransaction(db, () => db.prepare('INSERT INTO t VALUES (99)').run())
      }),
    ).toThrow(/error original/)
    expect(xs()).toEqual([])
    inTransaction(db, () => db.prepare('INSERT INTO t VALUES (5)').run())
    expect(xs()).toEqual([5])
  })
})
