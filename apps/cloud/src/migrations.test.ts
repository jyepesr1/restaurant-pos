import { describe, expect, it } from 'vitest'
import { CLOUD_MIGRATIONS, type CloudMigration, migrate, sqlFingerprint } from './migrations'
import { emptyDatabase, testDatabase } from './testing/pglite'

// The cloud migrations (ADR-016): applied once, in order; repeating does nothing; one already
// applied is not edited; the numbering is 1, 2, 3…

const m1 = CLOUD_MIGRATIONS[0] as CloudMigration
const m2: CloudMigration = {
  version: 2,
  name: 'things',
  sql: 'CREATE TABLE thing (id integer PRIMARY KEY, v text); INSERT INTO thing VALUES (1, $$one$$);',
}
const m3: CloudMigration = {
  version: 3,
  name: 'more_stuff',
  // Fails if 2 was not applied first: the `thing` table would not exist.
  sql: 'ALTER TABLE thing ADD COLUMN extra text; UPDATE thing SET extra = $$two$$ WHERE id = 1;',
}

const sqlTables = async (db: ReturnType<typeof emptyDatabase>['db']) =>
  (
    await db.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    )
  ).rows.map((r) => r.t)

describe('apply', () => {
  it('on an empty database applies 1 and leaves the registry with its fingerprint', async () => {
    const { sql, db } = emptyDatabase()
    expect(await migrate(sql)).toEqual([1])
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

  it('repeating does nothing, neither the 2nd nor the 10th time', async () => {
    const { sql, db } = emptyDatabase()
    await migrate(sql)
    const before = (await db.query('SELECT * FROM migrations')).rows
    for (let i = 0; i < 10; i++) expect(await migrate(sql)).toEqual([])
    expect((await db.query('SELECT * FROM migrations')).rows).toEqual(before)
  })

  it('several migrations are applied in order, and only the missing ones', async () => {
    const { sql, db } = emptyDatabase()
    expect(await migrate(sql, [m1])).toEqual([1])
    expect(await migrate(sql, [m1, m2, m3])).toEqual([2, 3])
    expect(await migrate(sql, [m1, m2, m3])).toEqual([])
    // 3 depended on 2: if the order had failed, there would be no row with extra.
    expect((await db.query('SELECT id, v, extra FROM thing')).rows).toEqual([
      { id: 1, v: 'one', extra: 'two' },
    ])
    const versions = (
      await db.query<{ version: number }>(
        'SELECT version FROM migrations ORDER BY applied_at, version',
      )
    ).rows.map((r) => r.version)
    expect(versions).toEqual([1, 2, 3])
  })

  it('all at once from scratch apply in order', async () => {
    const { sql } = emptyDatabase()
    expect(await migrate(sql, [m1, m2, m3])).toEqual([1, 2, 3])
  })

  it('two processes migrating at once apply each migration only once', async () => {
    const { sql, db } = emptyDatabase()
    const results = await Promise.all([
      migrate(sql, [m1, m2]),
      migrate(sql, [m1, m2]),
      migrate(sql, [m1, m2]),
    ])
    expect(results.flat().sort()).toEqual([1, 2])
    expect((await db.query('SELECT version FROM migrations')).rows).toHaveLength(2)
    expect((await db.query('SELECT * FROM thing')).rows).toHaveLength(1)
  })

  it('if the faro_data role already exists on the server (another database), the migration neither fails nor duplicates it', async () => {
    const { sql, db } = emptyDatabase()
    await db.exec('CREATE ROLE faro_data NOLOGIN NOBYPASSRLS')
    await expect(migrate(sql)).resolves.toEqual([1])
    expect(
      (await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'faro_data'")).rows,
    ).toEqual([{ n: 1 }])
  })

  it('a database newer than the code (an applied version this code does not know) neither fails nor changes anything', async () => {
    const { sql, db } = emptyDatabase()
    await migrate(sql, [m1, m2])
    expect(await migrate(sql, [m1])).toEqual([])
    expect((await db.query('SELECT version FROM migrations')).rows).toHaveLength(2)
  })

  it('migration 1 leaves row-level security on and the role without extra privileges', async () => {
    const { db } = await testDatabase()
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
    const src = (tableName: string) => permissions.filter((x) => x.t === tableName).map((x) => x.p)
    expect(src('events')).toEqual(['INSERT', 'SELECT'])
    expect(src('divergent_events')).toEqual(['INSERT', 'SELECT'])
    expect(src('restaurants')).toEqual(['INSERT', 'SELECT'])
    expect(src('migrations')).toEqual([])
    for (const t of permissions) expect(['DELETE', 'TRUNCATE']).not.toContain(t.p)
  })
})

describe('an applied migration is not edited', () => {
  it('changing the SQL of 1 fails with a message that explains it', async () => {
    const { sql } = emptyDatabase()
    await migrate(sql)
    await expect(migrate(sql, [{ ...m1, sql: `${m1.sql}\n-- change` }])).rejects.toThrow(
      /migración 1 .* cambió después de aplicarse/,
    )
  })

  it('even an extra space counts as a change', async () => {
    const { sql } = emptyDatabase()
    await migrate(sql)
    await expect(migrate(sql, [{ ...m1, sql: `${m1.sql} ` }])).rejects.toThrow(/cambió/)
  })

  it('on detecting the edit it applies none of the new migrations that come with it', async () => {
    const { sql, db } = emptyDatabase()
    await migrate(sql)
    await expect(migrate(sql, [{ ...m1, sql: `${m1.sql}\n-- change` }, m2])).rejects.toThrow(
      /cambió/,
    )
    expect(await sqlTables(db)).not.toContain('thing')
    expect((await db.query('SELECT version FROM migrations')).rows).toHaveLength(1)
  })

  it('editing an applied one in the middle also fails', async () => {
    const { sql } = emptyDatabase()
    await migrate(sql, [m1, m2, m3])
    await expect(migrate(sql, [m1, { ...m2, sql: `${m2.sql} -- x` }, m3])).rejects.toThrow(
      /migración 2 .* cambió/,
    )
  })

  it('changing only the name is not an edit of the SQL', async () => {
    const { sql } = emptyDatabase()
    await migrate(sql)
    await expect(migrate(sql, [{ ...m1, name: 'other_name' }])).resolves.toEqual([])
  })

  it('the fingerprint changes with any character, accents included', () => {
    expect(sqlFingerprint('a')).not.toBe(sqlFingerprint('b'))
    expect(sqlFingerprint('é')).not.toBe(sqlFingerprint('e'))
    expect(sqlFingerprint('a b')).not.toBe(sqlFingerprint('a  b'))
    expect(sqlFingerprint('x')).toBe(sqlFingerprint('x'))
    expect(sqlFingerprint('')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('numbering', () => {
  const untouched = async (list: CloudMigration[]) => {
    const { sql, db } = emptyDatabase()
    await expect(migrate(sql, list)).rejects.toThrow(/numeradas 1, 2, 3/)
    // It failed before touching the database: not even the migrations registry exists.
    expect(await sqlTables(db)).toEqual([])
  }

  it('starting at 2 fails', () => untouched([{ ...m2, version: 2 }]))
  it('skipping one (1 and 3) fails', () => untouched([m1, { ...m3 }]))
  it('repeating a version (1 and 1) fails', () => untouched([m1, { ...m2, version: 1 }]))
  it('a swapped order (2 and 1) fails', () => untouched([{ ...m2 }, m1]))
  it('starting at 0 fails', () => untouched([{ ...m1, version: 0 }]))
  it('a negative or decimal version fails', async () => {
    await untouched([{ ...m1, version: -1 }])
    await untouched([{ ...m1, version: 1.5 }])
  })

  it('an empty list does nothing and does not fail', async () => {
    const { sql } = emptyDatabase()
    await expect(migrate(sql, [])).resolves.toEqual([])
  })
})

describe('a failing migration', () => {
  it('is rolled back entirely: neither its tables nor its registry row', async () => {
    const { sql, db } = emptyDatabase()
    await migrate(sql)
    const broken: CloudMigration = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE a (x integer); CREATE TABLE b (x integer); SELECT esto_no_existe();',
    }
    await expect(migrate(sql, [m1, broken])).rejects.toThrow()
    expect(await sqlTables(db)).not.toContain('a')
    expect(await sqlTables(db)).not.toContain('b')
    expect((await db.query('SELECT version FROM migrations')).rows).toHaveLength(1)
    // Once fixed, the same version applies without trouble.
    expect(await migrate(sql, [m1, m2])).toEqual([2])
  })

  it('the ones before the failing one stay applied', async () => {
    const { sql, db } = emptyDatabase()
    const broken: CloudMigration = { version: 3, name: 'broken', sql: 'SELECT esto_no_existe();' }
    await expect(migrate(sql, [m1, m2, broken])).rejects.toThrow()
    expect((await db.query('SELECT version FROM migrations ORDER BY 1')).rows).toEqual([
      { version: 1 },
      { version: 2 },
    ])
  })
})
