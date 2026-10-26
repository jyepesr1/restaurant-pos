import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { TABLAS_VERSIONADAS } from './esquema'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones } from './migrar'
import { abrirBase, BaseOcupadaError } from './node'
import {
  AHORA,
  insertarEnTabla,
  insertarItem,
  insertarPedido,
  insertarVersionado,
  sembrar,
} from './pruebas/utiles'
import { type BaseSqlite, enTransaccion, type ValorSql } from './sqlite'

function baseMigrada(): BaseSqlite {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  return db
}

describe('archivado del catálogo', () => {
  it.each(TABLAS_VERSIONADAS)('%s no admite DELETE: se archiva', (tableName) => {
    const db = baseMigrada()
    const disparadores = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
      .all(tableName)
      .map((row) => String(row.name))

    expect(disparadores).toContain(`${tableName}_no_delete`)
  })

  it('borrar un producto falla y archivarlo funciona', () => {
    const db = baseMigrada()
    const { product } = sembrar(db)

    expect(() => db.prepare('DELETE FROM products WHERE id = ?').run(product)).toThrow(/se archiva/)
    expect(() =>
      db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(product),
    ).not.toThrow()
  })

  it('archivar un usuario libera su PIN y reactivarlo lo vuelve a tomar', () => {
    const db = baseMigrada()
    const { restaurant } = sembrar(db)
    const role = insertarVersionado(db, 'roles', restaurant, { name: 'mesero' })
    const user = () => insertarVersionado(db, 'users', restaurant, { name: 'X', role_id: role })
    const credential = (userId: string) =>
      insertarEnTabla(db, 'user_credentials', {
        user_id: userId,
        restaurant_id: restaurant,
        pin_hash: 'huella-1',
        pin_generated_at: AHORA,
      })

    const ana = user()
    credential(ana)
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ana)
    expect(
      db.prepare('SELECT current FROM user_credentials WHERE user_id = ?').get(ana)?.current,
    ).toBe(0)

    const luis = user()
    expect(() => credential(luis)).not.toThrow()
    // Ana no puede volver con el mismo PIN mientras Luis lo tenga.
    expect(() => db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(ana)).toThrow(/UNIQUE/)
  })
})

describe('dinero en todas las columnas', () => {
  let db: BaseSqlite
  let base: ReturnType<typeof sembrar>
  let order: string

  beforeEach(() => {
    db = baseMigrada()
    base = sembrar(db)
    order = insertarPedido(db, base.restaurant)
  })

  const group = () =>
    insertarVersionado(db, 'modifier_groups', base.restaurant, {
      name: 'Adicionales',
      maximum: 3,
    })

  // Cada columna con la forma de insertar un valor en ella.
  const columns: Record<string, (value: ValorSql) => unknown> = {
    'products.price': (price) =>
      insertarVersionado(db, 'products', base.restaurant, {
        category_id: base.category,
        name: 'P',
        price,
        tax_id: base.tax,
      }),
    'variants.price': (price) =>
      insertarVersionado(db, 'variants', base.restaurant, {
        product_id: base.product,
        name: 'Copa',
        price,
      }),
    'modifiers.extra_price': (extra_price) =>
      insertarVersionado(db, 'modifiers', base.restaurant, {
        group_id: group(),
        name: 'Extra burrata',
        extra_price,
      }),
    'order_items.unit_price': (unit_price) =>
      insertarItem(db, base.restaurant, order, { unit_price }),
    'order_item_modifiers.extra_price': (extra_price) =>
      insertarEnTabla(db, 'order_item_modifiers', {
        order_item_id: insertarItem(db, base.restaurant, order),
        modifier_id: newId(),
        name: 'Extra',
        extra_price,
      }),
  }

  describe.each(Object.entries(columns))('%s', (_columna, insertar) => {
    it.each([0, 40900, 100_000_000])('acepta %d', (value) => {
      expect(() => insertar(value)).not.toThrow()
    })
    it('rechaza decimales', () => {
      expect(() => insertar(40900.5)).toThrow(/REAL/)
    })
    it.each([-1, 100_000_001])('rechaza %d', (value) => {
      expect(() => insertar(value)).toThrow(/CHECK/)
    })
  })

  it.each([0, 800, 10_000])('acepta la tarifa %d en un ítem', (rate) => {
    expect(() => insertarItem(db, base.restaurant, order, { rate })).not.toThrow()
  })

  it.each([
    [-1, /CHECK/],
    [10_001, /CHECK/],
    [8.5, /REAL/],
  ] as const)('rechaza la tarifa %d en un ítem y en el catálogo', (rate, error) => {
    expect(() => insertarItem(db, base.restaurant, order, { rate })).toThrow(error)
    expect(() =>
      insertarVersionado(db, 'taxes', base.restaurant, { name: 'X', type: 'iva', rate }),
    ).toThrow(error)
  })

  it.each([1, 999])('acepta la cantidad %d', (quantity) => {
    expect(() => insertarItem(db, base.restaurant, order, { quantity })).not.toThrow()
  })

  it.each([
    [-1, /CHECK/],
    [1.5, /REAL/],
  ] as const)('rechaza la cantidad %d', (quantity, error) => {
    expect(() => insertarItem(db, base.restaurant, order, { quantity })).toThrow(error)
  })

  it('la cantidad anulada va de 0 a la cantidad del ítem', () => {
    expect(() =>
      insertarItem(db, base.restaurant, order, { quantity: 3, voided_quantity: 1 }),
    ).not.toThrow()
    expect(() =>
      insertarItem(db, base.restaurant, order, { quantity: 3, voided_quantity: 4 }),
    ).toThrow(/CHECK/)
  })

  it('un impuesto exento no puede tener tarifa', () => {
    expect(() =>
      insertarVersionado(db, 'taxes', base.restaurant, {
        name: 'E',
        type: 'exempt',
        rate: 800,
      }),
    ).toThrow(/CHECK/)
    expect(() =>
      insertarItem(db, base.restaurant, order, { tax_type: 'exempt', rate: 800 }),
    ).toThrow(/CHECK/)
    expect(() =>
      insertarItem(db, base.restaurant, order, { tax_type: 'exempt', rate: 0 }),
    ).not.toThrow()
  })
})

describe('runner de migraciones', () => {
  it('detecta una migración editada después de aplicarse', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db)
    const editadas = MIGRACIONES.map((m, i) => (i === 0 ? { ...m, sql: `${m.sql} ` } : m))

    expect(() => aplicarMigraciones(db, editadas)).toThrow(/cambió después de aplicarse/)
  })

  it('puede reconstruir una tabla con claves foráneas apagadas y las vuelve a encender', () => {
    const db = abrirBase(':memory:')
    const migraciones = [
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
        sinClavesForaneas: true,
        sql: `CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT) STRICT;
              INSERT INTO parent_new (id) SELECT id FROM parent;
              DROP TABLE parent;
              ALTER TABLE parent_new RENAME TO parent;`,
      },
    ]

    expect(aplicarMigraciones(db, migraciones)).toEqual([1, 2])
    expect(db.prepare('SELECT count(*) AS n FROM hijo').get()?.n).toBe(1)
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
  })

  it('una reconstrucción que deja referencias rotas no se aplica', () => {
    const db = abrirBase(':memory:')
    const migraciones = [
      {
        version: 1,
        name: 'tablas',
        sql: `CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
              CREATE TABLE hijo (id INTEGER PRIMARY KEY, padre_id INTEGER REFERENCES parent (id)) STRICT;
              INSERT INTO parent VALUES (1); INSERT INTO hijo VALUES (1, 1);`,
      },
      { version: 2, name: 'rompe', sinClavesForaneas: true, sql: 'DELETE FROM parent;' },
    ]

    expect(() => aplicarMigraciones(db, migraciones)).toThrow(/referencias rotas/)
    expect(db.prepare('SELECT count(*) AS n FROM parent').get()?.n).toBe(1)
  })
})

describe('transacciones', () => {
  it('no admiten funciones asíncronas', () => {
    const db = baseMigrada()

    expect(() => enTransaccion(db, async () => 1)).toThrow(/asíncronas/)
  })

  it('una dentro de otra se suma a la de afuera: si algo falla, no queda nada', () => {
    const db = abrirBase(':memory:')
    db.exec('CREATE TABLE t (x INTEGER) STRICT')
    const contar = () => db.prepare('SELECT count(*) AS n FROM t').get()?.n
    enTransaccion(db, () => {
      db.exec('INSERT INTO t VALUES (1)')
      enTransaccion(db, () => db.exec('INSERT INTO t VALUES (2)'))
    })
    expect(contar()).toBe(2)
    expect(() =>
      enTransaccion(db, () => {
        enTransaccion(db, () => db.exec('INSERT INTO t VALUES (3)'))
        throw new Error('falla después')
      }),
    ).toThrow('falla después')
    expect(contar()).toBe(2)
    // Y la base queda lista para la siguiente.
    enTransaccion(db, () => db.exec('INSERT INTO t VALUES (4)'))
    expect(contar()).toBe(3)
  })

  it('si SQLite ya deshizo la transacción, conservan el error original', () => {
    const db = abrirBase(':memory:')
    db.exec(`CREATE TABLE t (x INTEGER) STRICT;
             CREATE TRIGGER t_rollback BEFORE INSERT ON t BEGIN SELECT RAISE(ROLLBACK, 'error original'); END;`)

    expect(() => enTransaccion(db, () => db.exec('INSERT INTO t VALUES (1)'))).toThrow(
      /error original/,
    )
  })
})

describe('apertura exclusiva', () => {
  it('un segundo hub no puede abrir la misma base', () => {
    const ruta = join(mkdtempSync(join(tmpdir(), 'pos-exclusiva-')), 'pos.sqlite')
    const first = abrirBase(ruta, { exclusiva: true })

    expect(() => abrirBase(ruta, { exclusiva: true, esperaMs: 50 })).toThrow(BaseOcupadaError)
    first.close()
    expect(() => abrirBase(ruta, { exclusiva: true, esperaMs: 50 }).close()).not.toThrow()
  })
})
