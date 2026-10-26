import { describe, expect, it } from 'vitest'
import { huellaSql, MIGRACIONES_NUBE, type MigracionNube, migrar } from './migraciones'
import { baseDePrueba, baseVacia } from './pruebas/pglite'

// Las migraciones de la nube (ADR-016): se aplican una vez, en orden; repetir no hace nada; una
// ya aplicada no se edita; la numeración es 1, 2, 3…

const m1 = MIGRACIONES_NUBE[0] as MigracionNube
const m2: MigracionNube = {
  version: 2,
  nombre: 'cosas',
  sql: 'CREATE TABLE cosa (id integer PRIMARY KEY, v text); INSERT INTO cosa VALUES (1, $$uno$$);',
}
const m3: MigracionNube = {
  version: 3,
  nombre: 'mas_cosas',
  // Falla si la 2 no se aplicó antes: la tabla `cosa` no existiría.
  sql: 'ALTER TABLE cosa ADD COLUMN extra text; UPDATE cosa SET extra = $$dos$$ WHERE id = 1;',
}

const tablas = async (db: ReturnType<typeof baseVacia>['db']) =>
  (
    await db.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    )
  ).rows.map((r) => r.t)

describe('aplicar', () => {
  it('en una base vacía aplica la 1 y deja el registro con su huella', async () => {
    const { sql, db } = baseVacia()
    expect(await migrar(sql)).toEqual([1])
    const filas = (
      await db.query<{ version: number; nombre: string; huella: string }>(
        'SELECT version, nombre, huella FROM migracion',
      )
    ).rows
    expect(filas).toEqual([{ version: 1, nombre: 'inicial', huella: huellaSql(m1.sql) }])
    expect(await tablas(db)).toEqual(
      expect.arrayContaining([
        'restaurante',
        'codigo_registro',
        'hub',
        'evento',
        'evento_distinto',
      ]),
    )
  })

  it('repetir no hace nada, ni la 2.ª, ni la 10.ª vez', async () => {
    const { sql, db } = baseVacia()
    await migrar(sql)
    const antes = (await db.query('SELECT * FROM migracion')).rows
    for (let i = 0; i < 10; i++) expect(await migrar(sql)).toEqual([])
    expect((await db.query('SELECT * FROM migracion')).rows).toEqual(antes)
  })

  it('varias migraciones se aplican en orden, y solo las que faltan', async () => {
    const { sql, db } = baseVacia()
    expect(await migrar(sql, [m1])).toEqual([1])
    expect(await migrar(sql, [m1, m2, m3])).toEqual([2, 3])
    expect(await migrar(sql, [m1, m2, m3])).toEqual([])
    // La 3 dependía de la 2: si el orden hubiera fallado, no habría fila con extra.
    expect((await db.query('SELECT id, v, extra FROM cosa')).rows).toEqual([
      { id: 1, v: 'uno', extra: 'dos' },
    ])
    const versiones = (
      await db.query<{ version: number }>(
        'SELECT version FROM migracion ORDER BY aplicada_en, version',
      )
    ).rows.map((r) => r.version)
    expect(versiones).toEqual([1, 2, 3])
  })

  it('todas de una vez desde cero aplican en orden', async () => {
    const { sql } = baseVacia()
    expect(await migrar(sql, [m1, m2, m3])).toEqual([1, 2, 3])
  })

  it('dos procesos migrando a la vez aplican cada migración una sola vez', async () => {
    const { sql, db } = baseVacia()
    const resultados = await Promise.all([
      migrar(sql, [m1, m2]),
      migrar(sql, [m1, m2]),
      migrar(sql, [m1, m2]),
    ])
    expect(resultados.flat().sort()).toEqual([1, 2])
    expect((await db.query('SELECT version FROM migracion')).rows).toHaveLength(2)
    expect((await db.query('SELECT * FROM cosa')).rows).toHaveLength(1)
  })

  it('si el rol faro_datos ya existe en el servidor (otra base), la migración no falla ni lo duplica', async () => {
    const { sql, db } = baseVacia()
    await db.exec('CREATE ROLE faro_datos NOLOGIN NOBYPASSRLS')
    await expect(migrar(sql)).resolves.toEqual([1])
    expect(
      (await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'faro_datos'")).rows,
    ).toEqual([{ n: 1 }])
  })

  it('una base más nueva que el código (versión aplicada que este código no conoce) no falla ni cambia nada', async () => {
    const { sql, db } = baseVacia()
    await migrar(sql, [m1, m2])
    expect(await migrar(sql, [m1])).toEqual([])
    expect((await db.query('SELECT version FROM migracion')).rows).toHaveLength(2)
  })

  it('la migración 1 deja la seguridad por fila activa y el rol sin permisos de más', async () => {
    const { db } = await baseDePrueba()
    const rls = (
      await db.query<{ relname: string; relrowsecurity: boolean }>(
        "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('evento', 'evento_distinto') ORDER BY 1",
      )
    ).rows
    expect(rls).toEqual([
      { relname: 'evento', relrowsecurity: true },
      { relname: 'evento_distinto', relrowsecurity: true },
    ])
    const permisos = (
      await db.query<{ t: string; p: string }>(
        `SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
         WHERE grantee = 'faro_datos' AND table_schema = 'public' ORDER BY 1, 2`,
      )
    ).rows
    const de = (tabla: string) => permisos.filter((x) => x.t === tabla).map((x) => x.p)
    expect(de('evento')).toEqual(['INSERT', 'SELECT'])
    expect(de('evento_distinto')).toEqual(['INSERT', 'SELECT'])
    expect(de('restaurante')).toEqual(['INSERT', 'SELECT'])
    expect(de('migracion')).toEqual([])
    for (const t of permisos) expect(['DELETE', 'TRUNCATE']).not.toContain(t.p)
  })
})

describe('una migración ya aplicada no se edita', () => {
  it('cambiar el SQL de la 1 falla con un mensaje que lo explica', async () => {
    const { sql } = baseVacia()
    await migrar(sql)
    await expect(migrar(sql, [{ ...m1, sql: `${m1.sql}\n-- cambio` }])).rejects.toThrow(
      /migración 1 .* cambió después de aplicarse/,
    )
  })

  it('hasta un espacio de más cuenta como cambio', async () => {
    const { sql } = baseVacia()
    await migrar(sql)
    await expect(migrar(sql, [{ ...m1, sql: `${m1.sql} ` }])).rejects.toThrow(/cambió/)
  })

  it('al detectar la edición no aplica ninguna migración nueva que venga con ella', async () => {
    const { sql, db } = baseVacia()
    await migrar(sql)
    await expect(migrar(sql, [{ ...m1, sql: `${m1.sql}\n-- cambio` }, m2])).rejects.toThrow(
      /cambió/,
    )
    expect(await tablas(db)).not.toContain('cosa')
    expect((await db.query('SELECT version FROM migracion')).rows).toHaveLength(1)
  })

  it('editar una intermedia ya aplicada también falla', async () => {
    const { sql } = baseVacia()
    await migrar(sql, [m1, m2, m3])
    await expect(migrar(sql, [m1, { ...m2, sql: `${m2.sql} -- x` }, m3])).rejects.toThrow(
      /migración 2 .* cambió/,
    )
  })

  it('cambiar solo el nombre no es una edición del SQL', async () => {
    const { sql } = baseVacia()
    await migrar(sql)
    await expect(migrar(sql, [{ ...m1, nombre: 'otro_nombre' }])).resolves.toEqual([])
  })

  it('la huella cambia con cualquier carácter, incluidas las tildes', () => {
    expect(huellaSql('a')).not.toBe(huellaSql('b'))
    expect(huellaSql('é')).not.toBe(huellaSql('e'))
    expect(huellaSql('a b')).not.toBe(huellaSql('a  b'))
    expect(huellaSql('x')).toBe(huellaSql('x'))
    expect(huellaSql('')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('numeración', () => {
  const sinTocar = async (lista: MigracionNube[]) => {
    const { sql, db } = baseVacia()
    await expect(migrar(sql, lista)).rejects.toThrow(/numeradas 1, 2, 3/)
    // Falló antes de tocar la base: ni siquiera existe el registro de migraciones.
    expect(await tablas(db)).toEqual([])
  }

  it('empezar en 2 falla', () => sinTocar([{ ...m2, version: 2 }]))
  it('saltarse una (1 y 3) falla', () => sinTocar([m1, { ...m3 }]))
  it('repetir una versión (1 y 1) falla', () => sinTocar([m1, { ...m2, version: 1 }]))
  it('el orden cambiado (2 y 1) falla', () => sinTocar([{ ...m2 }, m1]))
  it('empezar en 0 falla', () => sinTocar([{ ...m1, version: 0 }]))
  it('una versión negativa o decimal falla', async () => {
    await sinTocar([{ ...m1, version: -1 }])
    await sinTocar([{ ...m1, version: 1.5 }])
  })

  it('una lista vacía no hace nada y no falla', async () => {
    const { sql } = baseVacia()
    await expect(migrar(sql, [])).resolves.toEqual([])
  })
})

describe('una migración que falla', () => {
  it('se deshace entera: ni sus tablas ni su fila en el registro', async () => {
    const { sql, db } = baseVacia()
    await migrar(sql)
    const rota: MigracionNube = {
      version: 2,
      nombre: 'rota',
      sql: 'CREATE TABLE a (x integer); CREATE TABLE b (x integer); SELECT esto_no_existe();',
    }
    await expect(migrar(sql, [m1, rota])).rejects.toThrow()
    expect(await tablas(db)).not.toContain('a')
    expect(await tablas(db)).not.toContain('b')
    expect((await db.query('SELECT version FROM migracion')).rows).toHaveLength(1)
    // Corregida, la misma versión se aplica sin problema.
    expect(await migrar(sql, [m1, m2])).toEqual([2])
  })

  it('las anteriores a la que falla se quedan aplicadas', async () => {
    const { sql, db } = baseVacia()
    const rota: MigracionNube = { version: 3, nombre: 'rota', sql: 'SELECT esto_no_existe();' }
    await expect(migrar(sql, [m1, m2, rota])).rejects.toThrow()
    expect((await db.query('SELECT version FROM migracion ORDER BY 1')).rows).toEqual([
      { version: 1 },
      { version: 2 },
    ])
  })
})
