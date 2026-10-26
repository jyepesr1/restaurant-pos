import { describe, expect, it } from 'vitest'
import { MIGRACIONES_NUBE, type MigracionNube, migrar, sqlFingerprint } from './migraciones'
import { baseDePrueba, baseVacia } from './pruebas/pglite'

// Las migraciones de la nube (ADR-016): se aplican una vez, en orden; repetir no hace nada; una
// ya aplicada no se edita; la numeración es 1, 2, 3…

const m1 = MIGRACIONES_NUBE[0] as MigracionNube
const m2: MigracionNube = {
  version: 2,
  name: 'cosas',
  sql: 'CREATE TABLE cosa (id integer PRIMARY KEY, v text); INSERT INTO cosa VALUES (1, $$uno$$);',
}
const m3: MigracionNube = {
  version: 3,
  name: 'more_stuff',
  // Falla si la 2 no se aplicó antes: la tabla `cosa` no existiría.
  sql: 'ALTER TABLE cosa ADD COLUMN extra text; UPDATE cosa SET extra = $$dos$$ WHERE id = 1;',
}

const sqlTables = async (db: ReturnType<typeof baseVacia>['db']) =>
  (
    await db.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    )
  ).rows.map((r) => r.t)

describe('aplicar', () => {
  it('en una base vacía aplica la 1 y deja el registro con su huella', async () => {
    const { sql, db } = baseVacia()
    expect(await migrar(sql)).toEqual([1])
    const rows = (
      await db.query<{ version: number; name: string; fingerprint: string }>(
        'SELECT version, name, fingerprint FROM migrations',
      )
    ).rows
    expect(rows).toEqual([{ version: 1, name: 'initial', fingerprint: sqlFingerprint(m1.sql) }])
    expect(await sqlTables(db)).toEqual(
      expect.arrayContaining([
        'restaurants',
        'registration_codes',
        'hubs',
        'events',
        'divergent_events',
      ]),
    )
  })

  it('repetir no hace nada, ni la 2.ª, ni la 10.ª vez', async () => {
    const { sql, db } = baseVacia()
    await migrar(sql)
    const before = (await db.query('SELECT * FROM migrations')).rows
    for (let i = 0; i < 10; i++) expect(await migrar(sql)).toEqual([])
    expect((await db.query('SELECT * FROM migrations')).rows).toEqual(before)
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
        'SELECT version FROM migrations ORDER BY applied_at, version',
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
    const results = await Promise.all([
      migrar(sql, [m1, m2]),
      migrar(sql, [m1, m2]),
      migrar(sql, [m1, m2]),
    ])
    expect(results.flat().sort()).toEqual([1, 2])
    expect((await db.query('SELECT version FROM migrations')).rows).toHaveLength(2)
    expect((await db.query('SELECT * FROM cosa')).rows).toHaveLength(1)
  })

  it('si el rol faro_datos ya existe en el servidor (otra base), la migración no falla ni lo duplica', async () => {
    const { sql, db } = baseVacia()
    await db.exec('CREATE ROLE faro_data NOLOGIN NOBYPASSRLS')
    await expect(migrar(sql)).resolves.toEqual([1])
    expect(
      (await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'faro_data'")).rows,
    ).toEqual([{ n: 1 }])
  })

  it('una base más nueva que el código (versión aplicada que este código no conoce) no falla ni cambia nada', async () => {
    const { sql, db } = baseVacia()
    await migrar(sql, [m1, m2])
    expect(await migrar(sql, [m1])).toEqual([])
    expect((await db.query('SELECT version FROM migrations')).rows).toHaveLength(2)
  })

  it('la migración 1 deja la seguridad por fila activa y el rol sin permisos de más', async () => {
    const { db } = await baseDePrueba()
    const rls = (
      await db.query<{ relname: string; relrowsecurity: boolean }>(
        "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('events', 'divergent_events') ORDER BY 1",
      )
    ).rows
    expect(rls).toEqual([
      { relname: 'divergent_events', relrowsecurity: true },
      { relname: 'events', relrowsecurity: true },
    ])
    const permissions = (
      await db.query<{ t: string; p: string }>(
        `SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
         WHERE grantee = 'faro_data' AND table_schema = 'public' ORDER BY 1, 2`,
      )
    ).rows
    const de = (tableName: string) => permissions.filter((x) => x.t === tableName).map((x) => x.p)
    expect(de('events')).toEqual(['INSERT', 'SELECT'])
    expect(de('divergent_events')).toEqual(['INSERT', 'SELECT'])
    expect(de('restaurants')).toEqual(['INSERT', 'SELECT'])
    expect(de('migrations')).toEqual([])
    for (const t of permissions) expect(['DELETE', 'TRUNCATE']).not.toContain(t.p)
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
    expect(await sqlTables(db)).not.toContain('cosa')
    expect((await db.query('SELECT version FROM migrations')).rows).toHaveLength(1)
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
    await expect(migrar(sql, [{ ...m1, name: 'other_name' }])).resolves.toEqual([])
  })

  it('la huella cambia con cualquier carácter, incluidas las tildes', () => {
    expect(sqlFingerprint('a')).not.toBe(sqlFingerprint('b'))
    expect(sqlFingerprint('é')).not.toBe(sqlFingerprint('e'))
    expect(sqlFingerprint('a b')).not.toBe(sqlFingerprint('a  b'))
    expect(sqlFingerprint('x')).toBe(sqlFingerprint('x'))
    expect(sqlFingerprint('')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('numeración', () => {
  const sinTocar = async (list: MigracionNube[]) => {
    const { sql, db } = baseVacia()
    await expect(migrar(sql, list)).rejects.toThrow(/numeradas 1, 2, 3/)
    // Falló antes de tocar la base: ni siquiera existe el registro de migraciones.
    expect(await sqlTables(db)).toEqual([])
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
    const broken: MigracionNube = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE a (x integer); CREATE TABLE b (x integer); SELECT esto_no_existe();',
    }
    await expect(migrar(sql, [m1, broken])).rejects.toThrow()
    expect(await sqlTables(db)).not.toContain('a')
    expect(await sqlTables(db)).not.toContain('b')
    expect((await db.query('SELECT version FROM migrations')).rows).toHaveLength(1)
    // Corregida, la misma versión se aplica sin problema.
    expect(await migrar(sql, [m1, m2])).toEqual([2])
  })

  it('las anteriores a la que falla se quedan aplicadas', async () => {
    const { sql, db } = baseVacia()
    const broken: MigracionNube = { version: 3, name: 'broken', sql: 'SELECT esto_no_existe();' }
    await expect(migrar(sql, [m1, m2, broken])).rejects.toThrow()
    expect((await db.query('SELECT version FROM migrations ORDER BY 1')).rows).toEqual([
      { version: 1 },
      { version: 2 },
    ])
  })
})
