import { PGlite } from '@electric-sql/pglite'
import { nuevoId } from '@pos/core'
import { describe, expect, it, vi } from 'vitest'
import { migrar } from './migraciones'
import { sqlDePg, sqlPerezoso } from './pg'
import type { Sql } from './sql'

// El conector de `pg` en los casos difíciles: transacciones anidadas, errores a mitad de camino,
// una conexión que se cae y la conexión perezosa del Worker.

type Llamada = { texto: string; parametros: unknown[] | undefined }

/** Un cliente que anota todo y que puede fallar en una sentencia concreta. */
function clienteDeMentira(
  fallaEn: (texto: string, parametros: unknown[] | undefined) => unknown = () => undefined,
) {
  const llamadas: Llamada[] = []
  return {
    llamadas,
    textos: () => llamadas.map((l) => l.texto),
    cliente: {
      async query(texto: string, parametros?: unknown[]) {
        llamadas.push({ texto, parametros })
        const error = fallaEn(texto, parametros)
        if (error !== undefined) throw error
        return { rows: [{ ok: true }] }
      },
    },
  }
}

/** Un cliente sobre PGlite, como en pg.test.ts. */
function clienteSobrePglite(db: PGlite) {
  return {
    async query(texto: string, parametros?: unknown[]) {
      if (parametros === undefined) {
        const r = await db.exec(texto)
        return { rows: r.at(-1)?.rows ?? [] }
      }
      return db.query(texto, parametros)
    },
  }
}

describe('sqlDePg: transacciones', () => {
  it('abre BEGIN, hace el trabajo y confirma con COMMIT, en ese orden', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    const r = await sql.transaccion(async (tx) => {
      await tx.query('SELECT 1')
      return 'listo'
    })
    expect(r).toBe('listo')
    expect(f.textos()).toEqual(['BEGIN', 'SELECT 1', 'COMMIT'])
  })

  it('una transacción anidada no abre otra: un solo BEGIN y un solo COMMIT', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    await sql.transaccion(async (externa) => {
      await externa.query('SELECT 1')
      await externa.transaccion(async (interna) => {
        await interna.query('SELECT 2')
        await interna.transaccion(async (muyInterna) => {
          await muyInterna.query('SELECT 3')
        })
      })
      await externa.query('SELECT 4')
    })
    expect(f.textos()).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4', 'COMMIT'])
  })

  it('la anidada devuelve su valor a quien la llamó', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    const r = await sql.transaccion((tx) => tx.transaccion(async () => 42))
    expect(r).toBe(42)
  })

  it('si falla la anidada y el error sube, se deshace todo: un solo ROLLBACK y ningún COMMIT', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    const error = new Error('falló adentro')
    await expect(
      sql.transaccion(async (externa) => {
        await externa.query('SELECT 1')
        await externa.transaccion(async (interna) => {
          await interna.query('SELECT 2')
          throw error
        })
      }),
    ).rejects.toBe(error)
    expect(f.textos()).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'ROLLBACK'])
  })

  it('con datos reales: si falla la anidada, no queda nada de lo escrito antes ni dentro', async () => {
    const db = new PGlite()
    const sql = sqlDePg(clienteSobrePglite(db) as never)
    await migrar(sql)
    const [a, b] = [nuevoId(), nuevoId()]
    await expect(
      sql.transaccion(async (externa) => {
        await externa.query('INSERT INTO restaurante (id, nombre) VALUES ($1, $2)', [a, 'A'])
        await externa.transaccion(async (interna) => {
          await interna.query('INSERT INTO restaurante (id, nombre) VALUES ($1, $2)', [b, 'B'])
          throw new Error('se cayó')
        })
      }),
    ).rejects.toThrow('se cayó')
    expect((await db.query('SELECT 1 FROM restaurante')).rows).toEqual([])
  })

  it('con datos reales: un error de SQL a mitad de la transacción la deshace, y la conexión sigue sirviendo', async () => {
    const db = new PGlite()
    const sql = sqlDePg(clienteSobrePglite(db) as never)
    await migrar(sql)
    const id = nuevoId()
    await expect(
      sql.transaccion(async (tx) => {
        await tx.query('INSERT INTO restaurante (id, nombre) VALUES ($1, $2)', [id, 'A'])
        // Viola la restricción de largo del id: Postgres aborta la transacción.
        await tx.query('INSERT INTO restaurante (id, nombre) VALUES ($1, $2)', ['corto', 'B'])
      }),
    ).rejects.toThrow(/check|violates/i)
    expect(await sql.query('SELECT 1 FROM restaurante')).toEqual([])
    // Una transacción nueva funciona normal después del fallo.
    await sql.transaccion((tx) =>
      tx.query('INSERT INTO restaurante (id, nombre) VALUES ($1, $2)', [id, 'A']),
    )
    expect(await sql.query('SELECT 1 FROM restaurante')).toHaveLength(1)
  })

  it('con datos reales: dos transacciones seguidas (la segunda tras un rollback) no se contaminan', async () => {
    const db = new PGlite()
    const sql = sqlDePg(clienteSobrePglite(db) as never)
    await migrar(sql)
    for (let i = 0; i < 3; i++) {
      await expect(
        sql.transaccion(async (tx) => {
          await tx.query('INSERT INTO restaurante (id, nombre) VALUES ($1, $2)', [nuevoId(), 'x'])
          throw new Error(`vuelta ${i}`)
        }),
      ).rejects.toThrow(`vuelta ${i}`)
    }
    expect(await sql.query('SELECT 1 FROM restaurante')).toEqual([])
  })

  it('al terminar una transacción, el mismo Sql abre una nueva en la siguiente (no se queda «dentro»)', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    await sql.transaccion(async () => {})
    await sql.transaccion(async () => {})
    expect(f.textos()).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
  })

  it('tras un rollback, la siguiente transacción vuelve a abrir BEGIN', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    await expect(sql.transaccion(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await sql.transaccion(async () => {})
    expect(f.textos()).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT'])
  })

  it('un trabajo que lanza un valor que no es Error se relanza tal cual', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    const raro = { codigo: 7 }
    await expect(sql.transaccion(async () => Promise.reject(raro))).rejects.toBe(raro)
    await expect(sql.transaccion(async () => Promise.reject('texto'))).rejects.toBe('texto')
    expect(f.textos().filter((t) => t === 'ROLLBACK')).toHaveLength(2)
  })

  it('si falla el COMMIT, se intenta deshacer y el error que sube es el del COMMIT', async () => {
    const error = new Error('no se pudo confirmar')
    const f = clienteDeMentira((t) => (t === 'COMMIT' ? error : undefined))
    const sql = sqlDePg(f.cliente as never)
    await expect(sql.transaccion(async (tx) => tx.query('SELECT 1'))).rejects.toBe(error)
    expect(f.textos()).toEqual(['BEGIN', 'SELECT 1', 'COMMIT', 'ROLLBACK'])
  })

  it('si falla el BEGIN, no se corre el trabajo ni se hace ROLLBACK', async () => {
    const error = new Error('sin conexión')
    const f = clienteDeMentira((t) => (t === 'BEGIN' ? error : undefined))
    const sql = sqlDePg(f.cliente as never)
    const trabajo = vi.fn()
    await expect(sql.transaccion(trabajo)).rejects.toBe(error)
    expect(trabajo).not.toHaveBeenCalled()
    expect(f.textos()).toEqual(['BEGIN'])
  })

  it('si la conexión se cae a mitad (el ROLLBACK también falla), sube el error original', async () => {
    const original = new Error('Connection terminated unexpectedly')
    const f = clienteDeMentira((t) => {
      if (t === 'SELECT 2') return original
      if (t === 'ROLLBACK') return new Error('Client was closed and is not queryable')
      return undefined
    })
    const sql = sqlDePg(f.cliente as never)
    await expect(
      sql.transaccion(async (tx) => {
        await tx.query('SELECT 1')
        await tx.query('SELECT 2')
      }),
    ).rejects.toBe(original)
  })

  it('el valor que devuelve el trabajo llega aunque sea undefined, null o 0', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    expect(await sql.transaccion(async () => undefined)).toBeUndefined()
    expect(await sql.transaccion(async () => null)).toBeNull()
    expect(await sql.transaccion(async () => 0)).toBe(0)
  })
})

describe('sqlDePg: consultas', () => {
  it('query manda los parámetros en una copia y devuelve las filas', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    const parametros = Object.freeze(['a', 1]) as readonly unknown[]
    expect(await sql.query('SELECT $1, $2', parametros)).toEqual([{ ok: true }])
    expect(f.llamadas[0]?.parametros).toEqual(['a', 1])
    expect(f.llamadas[0]?.parametros).not.toBe(parametros)
  })

  it('ejecutar manda el guion entero sin parámetros (varias sentencias en una)', async () => {
    const f = clienteDeMentira()
    const sql = sqlDePg(f.cliente as never)
    await sql.ejecutar('CREATE TABLE a (x int); CREATE TABLE b (x int);')
    expect(f.llamadas).toEqual([
      { texto: 'CREATE TABLE a (x int); CREATE TABLE b (x int);', parametros: undefined },
    ])
  })

  it('un error de una consulta suelta (fuera de transacción) sube sin cambios y sin ROLLBACK', async () => {
    const error = new Error('sintaxis')
    const f = clienteDeMentira(() => error)
    const sql = sqlDePg(f.cliente as never)
    await expect(sql.query('SELECT')).rejects.toBe(error)
    expect(f.textos()).toEqual(['SELECT'])
  })

  it('las consultas dentro de una transacción pasan por el mismo cliente, en orden', async () => {
    const db = new PGlite()
    const sql = sqlDePg(clienteSobrePglite(db) as never)
    await migrar(sql)
    const id = nuevoId()
    await sql.transaccion(async (tx) => {
      await tx.query('INSERT INTO restaurante (id, nombre) VALUES ($1, $2)', [id, 'R'])
      // Lo escrito se ve dentro de la misma transacción.
      expect(await tx.query('SELECT nombre FROM restaurante WHERE id = $1', [id])).toEqual([
        { nombre: 'R' },
      ])
    })
    expect(await sql.query('SELECT nombre FROM restaurante WHERE id = $1', [id])).toEqual([
      { nombre: 'R' },
    ])
  })
})

describe('sqlPerezoso', () => {
  const sqlFalso = (): Sql & { consultas: string[] } => {
    const consultas: string[] = []
    return {
      consultas,
      query: async (t) => {
        consultas.push(t)
        return [{ n: 1 }] as never
      },
      ejecutar: async (t) => {
        consultas.push(t)
      },
      transaccion: async (trabajo) => trabajo(sqlFalso()),
    }
  }

  it('no conecta hasta la primera consulta', () => {
    const conectar = vi.fn(async () => sqlFalso())
    sqlPerezoso(conectar)
    expect(conectar).not.toHaveBeenCalled()
  })

  it('conecta una sola vez aunque haya muchas consultas, también a la vez', async () => {
    const conectar = vi.fn(async () => sqlFalso())
    const sql = sqlPerezoso(conectar)
    await Promise.all([
      sql.query('a'),
      sql.query('b'),
      sql.ejecutar('c'),
      sql.transaccion(async () => 1),
    ])
    await sql.query('d')
    expect(conectar).toHaveBeenCalledTimes(1)
  })

  it('pasa texto y parámetros tal cual, y devuelve lo que responde la base', async () => {
    const real = {
      query: vi.fn(async () => [{ x: 1 }]),
      ejecutar: vi.fn(),
      transaccion: vi.fn(async (t) => t(real)),
    }
    const sql = sqlPerezoso(async () => real as never)
    expect(await sql.query('SELECT $1', [7])).toEqual([{ x: 1 }])
    expect(real.query).toHaveBeenCalledWith('SELECT $1', [7])
    await sql.ejecutar('guion')
    expect(real.ejecutar).toHaveBeenCalledWith('guion')
    expect(await sql.transaccion(async (tx) => tx === real)).toBe(true)
  })

  it('si no se pudo conectar, cada consulta falla con ese error (no se queda colgada)', async () => {
    const error = new Error('sin red')
    const sql = sqlPerezoso(async () => {
      throw error
    })
    await expect(sql.query('a')).rejects.toBe(error)
    await expect(sql.ejecutar('b')).rejects.toBe(error)
    await expect(sql.transaccion(async () => 1)).rejects.toBe(error)
  })
})
