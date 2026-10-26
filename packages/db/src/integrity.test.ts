import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from './migrate'
import { MIGRATIONS } from './migrations'
import { DatabaseBusyError, openDatabase } from './node'
import { VERSIONED_TABLES } from './schema'
import { inTransaction, type SqliteDatabase, type SqlValue } from './sqlite'
import {
  insertIntoTable,
  insertItem,
  insertOrder,
  insertVersioned,
  NOW,
  seed,
} from './testing/utils'

function migratedDatabase(): SqliteDatabase {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  return db
}

describe('catalog archiving', () => {
  it.each(VERSIONED_TABLES)('%s does not allow DELETE: it is archived', (tableName) => {
    const db = migratedDatabase()
    const triggers = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
      .all(tableName)
      .map((row) => String(row.name))

    expect(triggers).toContain(`${tableName}_no_delete`)
  })

  it('deleting a product fails and archiving it works', () => {
    const db = migratedDatabase()
    const { product } = seed(db)

    expect(() => db.prepare('DELETE FROM products WHERE id = ?').run(product)).toThrow(/se archiva/)
    expect(() =>
      db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(product),
    ).not.toThrow()
  })

  it('archiving a user frees their PIN and reactivating takes it again', () => {
    const db = migratedDatabase()
    const { restaurant } = seed(db)
    const role = insertVersioned(db, 'roles', restaurant, { name: 'mesero' })
    const user = () => insertVersioned(db, 'users', restaurant, { name: 'X', role_id: role })
    const credential = (userId: string) =>
      insertIntoTable(db, 'user_credentials', {
        user_id: userId,
        restaurant_id: restaurant,
        pin_hash: 'huella-1',
        pin_generated_at: NOW,
      })

    const ana = user()
    credential(ana)
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ana)
    expect(
      db.prepare('SELECT current FROM user_credentials WHERE user_id = ?').get(ana)?.current,
    ).toBe(0)

    const luis = user()
    expect(() => credential(luis)).not.toThrow()
    // Ana cannot come back with the same PIN while Luis has it.
    expect(() => db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(ana)).toThrow(/UNIQUE/)
  })
})

describe('money in every column', () => {
  let db: SqliteDatabase
  let base: ReturnType<typeof seed>
  let order: string

  beforeEach(() => {
    db = migratedDatabase()
    base = seed(db)
    order = insertOrder(db, base.restaurant)
  })

  const group = () =>
    insertVersioned(db, 'modifier_groups', base.restaurant, {
      name: 'Adicionales',
      maximum: 3,
    })

  // Each column with the way to insert a value into it.
  const columns: Record<string, (value: SqlValue) => unknown> = {
    'products.price': (price) =>
      insertVersioned(db, 'products', base.restaurant, {
        category_id: base.category,
        name: 'P',
        price,
        tax_id: base.tax,
      }),
    'variants.price': (price) =>
      insertVersioned(db, 'variants', base.restaurant, {
        product_id: base.product,
        name: 'Copa',
        price,
      }),
    'modifiers.extra_price': (extra_price) =>
      insertVersioned(db, 'modifiers', base.restaurant, {
        group_id: group(),
        name: 'Extra burrata',
        extra_price,
      }),
    'order_items.unit_price': (unit_price) =>
      insertItem(db, base.restaurant, order, { unit_price }),
    'order_item_modifiers.extra_price': (extra_price) =>
      insertIntoTable(db, 'order_item_modifiers', {
        order_item_id: insertItem(db, base.restaurant, order),
        modifier_id: newId(),
        name: 'Extra',
        extra_price,
      }),
  }

  describe.each(Object.entries(columns))('%s', (_column, insert) => {
    it.each([0, 40900, 100_000_000])('accepts %d', (value) => {
      expect(() => insert(value)).not.toThrow()
    })
    it('rejects decimals', () => {
      expect(() => insert(40900.5)).toThrow(/REAL/)
    })
    it.each([-1, 100_000_001])('rejects %d', (value) => {
      expect(() => insert(value)).toThrow(/CHECK/)
    })
  })

  it.each([0, 800, 10_000])('accepts the rate %d in an item', (rate) => {
    expect(() => insertItem(db, base.restaurant, order, { rate })).not.toThrow()
  })

  it.each([
    [-1, /CHECK/],
    [10_001, /CHECK/],
    [8.5, /REAL/],
  ] as const)('rejects the rate %d in an item and in the catalog', (rate, error) => {
    expect(() => insertItem(db, base.restaurant, order, { rate })).toThrow(error)
    expect(() =>
      insertVersioned(db, 'taxes', base.restaurant, { name: 'X', type: 'iva', rate }),
    ).toThrow(error)
  })

  it.each([1, 999])('accepts the quantity %d', (quantity) => {
    expect(() => insertItem(db, base.restaurant, order, { quantity })).not.toThrow()
  })

  it.each([
    [-1, /CHECK/],
    [1.5, /REAL/],
  ] as const)('rejects the quantity %d', (quantity, error) => {
    expect(() => insertItem(db, base.restaurant, order, { quantity })).toThrow(error)
  })

  it('the voided quantity goes from 0 to the item quantity', () => {
    expect(() =>
      insertItem(db, base.restaurant, order, { quantity: 3, voided_quantity: 1 }),
    ).not.toThrow()
    expect(() =>
      insertItem(db, base.restaurant, order, { quantity: 3, voided_quantity: 4 }),
    ).toThrow(/CHECK/)
  })

  it('an exempt tax cannot have a rate', () => {
    expect(() =>
      insertVersioned(db, 'taxes', base.restaurant, {
        name: 'E',
        type: 'exempt',
        rate: 800,
      }),
    ).toThrow(/CHECK/)
    expect(() => insertItem(db, base.restaurant, order, { tax_type: 'exempt', rate: 800 })).toThrow(
      /CHECK/,
    )
    expect(() =>
      insertItem(db, base.restaurant, order, { tax_type: 'exempt', rate: 0 }),
    ).not.toThrow()
  })
})

describe('migration runner', () => {
  it('detects a migration edited after being applied', () => {
    const db = openDatabase(':memory:')
    applyMigrations(db)
    const editedList = MIGRATIONS.map((m, i) => (i === 0 ? { ...m, sql: `${m.sql} ` } : m))

    expect(() => applyMigrations(db, editedList)).toThrow(/cambió después de aplicarse/)
  })

  it('can rebuild a table with foreign keys off and turns them back on', () => {
    const db = openDatabase(':memory:')
    const migrations = [
      {
        version: 1,
        name: 'tablas',
        sql: `CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
              CREATE TABLE hijo (id INTEGER PRIMARY KEY, padre_id INTEGER REFERENCES parent (id)) STRICT;
              INSERT INTO parent VALUES (1); INSERT INTO hijo VALUES (1, 1);`,
      },
      {
        version: 2,
        name: 'reconstruir padre',
        withoutForeignKeys: true,
        sql: `CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT) STRICT;
              INSERT INTO parent_new (id) SELECT id FROM parent;
              DROP TABLE parent;
              ALTER TABLE parent_new RENAME TO parent;`,
      },
    ]

    expect(applyMigrations(db, migrations)).toEqual([1, 2])
    expect(db.prepare('SELECT count(*) AS n FROM hijo').get()?.n).toBe(1)
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
  })

  it('a rebuild that leaves broken references is not applied', () => {
    const db = openDatabase(':memory:')
    const migrations = [
      {
        version: 1,
        name: 'tablas',
        sql: `CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
              CREATE TABLE hijo (id INTEGER PRIMARY KEY, padre_id INTEGER REFERENCES parent (id)) STRICT;
              INSERT INTO parent VALUES (1); INSERT INTO hijo VALUES (1, 1);`,
      },
      { version: 2, name: 'rompe', withoutForeignKeys: true, sql: 'DELETE FROM parent;' },
    ]

    expect(() => applyMigrations(db, migrations)).toThrow(/referencias rotas/)
    expect(db.prepare('SELECT count(*) AS n FROM parent').get()?.n).toBe(1)
  })
})

describe('transactions', () => {
  it('do not accept async functions', () => {
    const db = migratedDatabase()

    expect(() => inTransaction(db, async () => 1)).toThrow(/asíncronas/)
  })

  it('one inside another joins the outer one: if something fails, nothing is left', () => {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE t (x INTEGER) STRICT')
    const count = () => db.prepare('SELECT count(*) AS n FROM t').get()?.n
    inTransaction(db, () => {
      db.exec('INSERT INTO t VALUES (1)')
      inTransaction(db, () => db.exec('INSERT INTO t VALUES (2)'))
    })
    expect(count()).toBe(2)
    expect(() =>
      inTransaction(db, () => {
        inTransaction(db, () => db.exec('INSERT INTO t VALUES (3)'))
        throw new Error('fails afterwards')
      }),
    ).toThrow('fails afterwards')
    expect(count()).toBe(2)
    // And the database is ready for the next one.
    inTransaction(db, () => db.exec('INSERT INTO t VALUES (4)'))
    expect(count()).toBe(3)
  })

  it('if SQLite already rolled back the transaction, they keep the original error', () => {
    const db = openDatabase(':memory:')
    db.exec(`CREATE TABLE t (x INTEGER) STRICT;
             CREATE TRIGGER t_rollback BEFORE INSERT ON t BEGIN SELECT RAISE(ROLLBACK, 'error original'); END;`)

    expect(() => inTransaction(db, () => db.exec('INSERT INTO t VALUES (1)'))).toThrow(
      /error original/,
    )
  })
})

describe('exclusive open', () => {
  it('a second hub cannot open the same database', () => {
    const route = join(mkdtempSync(join(tmpdir(), 'pos-exclusiva-')), 'pos.sqlite')
    const first = openDatabase(route, { exclusive: true })

    expect(() => openDatabase(route, { exclusive: true, waitMs: 50 })).toThrow(DatabaseBusyError)
    first.close()
    expect(() => openDatabase(route, { exclusive: true, waitMs: 50 }).close()).not.toThrow()
  })
})
