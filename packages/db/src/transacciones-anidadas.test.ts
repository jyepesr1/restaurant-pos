import { describe, expect, it } from 'vitest'
import { abrirBase } from './node'
import { enTransaccion } from './sqlite'

// `enTransaccion` anidada (tarea 1.3b): lo de adentro se suma a la transacción de afuera.

function base() {
  const db = abrirBase(':memory:')
  db.exec('CREATE TABLE t (x INTEGER PRIMARY KEY) STRICT')
  const xs = () =>
    db
      .prepare('SELECT x FROM t ORDER BY x')
      .all()
      .map((f) => f.x)
  const poner = (...v: number[]) => {
    for (const n of v) db.prepare('INSERT INTO t VALUES (?)').run(n)
  }
  return { db, xs, poner }
}

describe('transacciones anidadas', () => {
  it('tres niveles que se completan: todo queda, y la base sale de la transacción', () => {
    const { db, xs, poner } = base()
    enTransaccion(db, () => {
      poner(1)
      enTransaccion(db, () => {
        poner(2)
        enTransaccion(db, () => poner(3))
      })
    })
    expect(xs()).toEqual([1, 2, 3])
    // Si quedó «dentro» de una transacción, un BEGIN directo fallaría.
    expect(() => {
      db.exec('BEGIN IMMEDIATE')
      db.exec('ROLLBACK')
    }).not.toThrow()
  })

  it('falla el nivel más hondo y el error sube sin que nadie lo atrape: no queda nada de ningún nivel', () => {
    const { db, xs, poner } = base()
    expect(() =>
      enTransaccion(db, () => {
        poner(1)
        enTransaccion(db, () => {
          poner(2)
          enTransaccion(db, () => {
            poner(3)
            poner(3) // clave repetida a mitad
          })
        })
      }),
    ).toThrow(/UNIQUE/)
    expect(xs()).toEqual([])
  })

  it('falla el nivel de en medio después de que el hondo terminó: todo se deshace', () => {
    const { db, xs, poner } = base()
    expect(() =>
      enTransaccion(db, () => {
        enTransaccion(db, () => {
          enTransaccion(db, () => poner(1))
          throw new Error('falla en medio')
        })
        poner(2)
      }),
    ).toThrow('falla en medio')
    expect(xs()).toEqual([])
  })

  it('falla la de afuera después de que la de adentro "terminó": lo de adentro tampoco queda', () => {
    const { db, xs, poner } = base()
    expect(() =>
      enTransaccion(db, () => {
        enTransaccion(db, () => poner(1))
        throw new Error('falla afuera')
      }),
    ).toThrow('falla afuera')
    expect(xs()).toEqual([])
  })

  it('devuelve el valor de cada nivel', () => {
    const { db } = base()
    const r = enTransaccion(db, () => enTransaccion(db, () => 7) + 1)
    expect(r).toBe(8)
  })

  it('tras un fallo anidado la siguiente transacción empieza limpia (la marca de «en curso» se borra)', () => {
    const { db, xs, poner } = base()
    for (let i = 0; i < 3; i++)
      expect(() =>
        enTransaccion(db, () =>
          enTransaccion(db, () => {
            poner(9)
            throw new Error('x')
          }),
        ),
      ).toThrow('x')
    enTransaccion(db, () => poner(1))
    expect(xs()).toEqual([1])
    // Y es una transacción de verdad: si falla, se deshace.
    expect(() =>
      enTransaccion(db, () => {
        poner(2)
        throw new Error('y')
      }),
    ).toThrow('y')
    expect(xs()).toEqual([1])
  })

  it('dos bases distintas no comparten la marca: una transacción en A no vuelve «anidada» la de B', () => {
    const a = base()
    const b = base()
    expect(() =>
      enTransaccion(a.db, () => {
        a.poner(1)
        enTransaccion(b.db, () => b.poner(1))
        // B ya confirmó por su cuenta aunque A siga abierta.
        expect(b.xs()).toEqual([1])
        throw new Error('falla A')
      }),
    ).toThrow('falla A')
    expect(a.xs()).toEqual([])
    expect(b.xs()).toEqual([1])
  })

  it('el trabajo asíncrono se rechaza en el nivel de afuera, y deshace lo hecho', () => {
    const { db, xs, poner } = base()
    expect(() =>
      enTransaccion(db, async () => {
        poner(1)
      }),
    ).toThrow(/asíncronas/)
    expect(xs()).toEqual([])
  })

  // Antes era un BUG: la anidada devolvía la promesa sin avisar.
  it('una función asíncrona anidada también se rechaza', () => {
    const { db } = base()
    expect(() =>
      enTransaccion(db, () => {
        enTransaccion(db, async () => 1)
      }),
    ).toThrow(/asíncronas/)
  })

  // BUG (latente): no hay SAVEPOINT. Si un nivel interno falla y el de afuera atrapa el error y
  // sigue, lo que el interno alcanzó a escribir se confirma igual: «falló» pero dejó rastro.
  // Esperaba que el nivel que falla se deshiciera solo.
  it.fails('BUG: si lo anidado falla y quien llama sigue, lo que alcanzó a escribir se deshace', () => {
    const { db, xs, poner } = base()
    enTransaccion(db, () => {
      try {
        enTransaccion(db, () => {
          poner(1)
          throw new Error('falla a mitad')
        })
      } catch {
        // quien llama decide seguir
      }
      poner(2)
    })
    expect(xs()).toEqual([2])
  })

  it('una violación de restricción dentro de la anidada que SQLite resuelve con ROLLBACK conserva el error original', () => {
    const { db, xs } = base()
    db.exec(
      "CREATE TRIGGER t_rb BEFORE INSERT ON t WHEN NEW.x = 99 BEGIN SELECT RAISE(ROLLBACK, 'error original'); END",
    )
    expect(() =>
      enTransaccion(db, () => {
        db.prepare('INSERT INTO t VALUES (1)').run()
        enTransaccion(db, () => db.prepare('INSERT INTO t VALUES (99)').run())
      }),
    ).toThrow(/error original/)
    expect(xs()).toEqual([])
    enTransaccion(db, () => db.prepare('INSERT INTO t VALUES (5)').run())
    expect(xs()).toEqual([5])
  })
})
