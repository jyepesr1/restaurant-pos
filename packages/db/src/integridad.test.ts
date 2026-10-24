import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nuevoId } from '@pos/core'
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
  it.each(TABLAS_VERSIONADAS)('%s no admite DELETE: se archiva', (tabla) => {
    const db = baseMigrada()
    const disparadores = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
      .all(tabla)
      .map((fila) => String(fila.name))

    expect(disparadores).toContain(`${tabla}_sin_delete`)
  })

  it('borrar un producto falla y archivarlo funciona', () => {
    const db = baseMigrada()
    const { producto } = sembrar(db)

    expect(() => db.prepare('DELETE FROM producto WHERE id = ?').run(producto)).toThrow(
      /se archiva/,
    )
    expect(() =>
      db.prepare('UPDATE producto SET activo = 0 WHERE id = ?').run(producto),
    ).not.toThrow()
  })

  it('archivar un usuario libera su PIN y reactivarlo lo vuelve a tomar', () => {
    const db = baseMigrada()
    const { restaurante } = sembrar(db)
    const rol = insertarVersionado(db, 'rol', restaurante, { nombre: 'mesero' })
    const usuario = () =>
      insertarVersionado(db, 'usuario', restaurante, { nombre: 'X', rol_id: rol })
    const credencial = (usuarioId: string) =>
      insertarEnTabla(db, 'usuario_credencial', {
        usuario_id: usuarioId,
        restaurante_id: restaurante,
        pin_huella: 'huella-1',
        pin_generado_en: AHORA,
      })

    const ana = usuario()
    credencial(ana)
    db.prepare('UPDATE usuario SET activo = 0 WHERE id = ?').run(ana)
    expect(
      db.prepare('SELECT vigente FROM usuario_credencial WHERE usuario_id = ?').get(ana)?.vigente,
    ).toBe(0)

    const luis = usuario()
    expect(() => credencial(luis)).not.toThrow()
    // Ana no puede volver con el mismo PIN mientras Luis lo tenga.
    expect(() => db.prepare('UPDATE usuario SET activo = 1 WHERE id = ?').run(ana)).toThrow(
      /UNIQUE/,
    )
  })
})

describe('dinero en todas las columnas', () => {
  let db: BaseSqlite
  let base: ReturnType<typeof sembrar>
  let pedido: string

  beforeEach(() => {
    db = baseMigrada()
    base = sembrar(db)
    pedido = insertarPedido(db, base.restaurante)
  })

  const grupo = () =>
    insertarVersionado(db, 'grupo_modificador', base.restaurante, {
      nombre: 'Adicionales',
      maximo: 3,
    })

  // Cada columna con la forma de insertar un valor en ella.
  const columnas: Record<string, (valor: ValorSql) => unknown> = {
    'producto.precio': (precio) =>
      insertarVersionado(db, 'producto', base.restaurante, {
        categoria_id: base.categoria,
        nombre: 'P',
        precio,
        impuesto_id: base.impuesto,
      }),
    'variante.precio': (precio) =>
      insertarVersionado(db, 'variante', base.restaurante, {
        producto_id: base.producto,
        nombre: 'Copa',
        precio,
      }),
    'modificador.precio_extra': (precio_extra) =>
      insertarVersionado(db, 'modificador', base.restaurante, {
        grupo_id: grupo(),
        nombre: 'Extra burrata',
        precio_extra,
      }),
    'pedido_item.precio_unitario': (precio_unitario) =>
      insertarItem(db, base.restaurante, pedido, { precio_unitario }),
    'pedido_item_modificador.precio_extra': (precio_extra) =>
      insertarEnTabla(db, 'pedido_item_modificador', {
        pedido_item_id: insertarItem(db, base.restaurante, pedido),
        modificador_id: nuevoId(),
        nombre: 'Extra',
        precio_extra,
      }),
  }

  describe.each(Object.entries(columnas))('%s', (_columna, insertar) => {
    it.each([0, 40900, 100_000_000])('acepta %d', (valor) => {
      expect(() => insertar(valor)).not.toThrow()
    })
    it('rechaza decimales', () => {
      expect(() => insertar(40900.5)).toThrow(/REAL/)
    })
    it.each([-1, 100_000_001])('rechaza %d', (valor) => {
      expect(() => insertar(valor)).toThrow(/CHECK/)
    })
  })

  it.each([0, 800, 10_000])('acepta la tarifa %d en un ítem', (tarifa) => {
    expect(() => insertarItem(db, base.restaurante, pedido, { tarifa })).not.toThrow()
  })

  it.each([
    [-1, /CHECK/],
    [10_001, /CHECK/],
    [8.5, /REAL/],
  ] as const)('rechaza la tarifa %d en un ítem y en el catálogo', (tarifa, error) => {
    expect(() => insertarItem(db, base.restaurante, pedido, { tarifa })).toThrow(error)
    expect(() =>
      insertarVersionado(db, 'impuesto', base.restaurante, { nombre: 'X', tipo: 'iva', tarifa }),
    ).toThrow(error)
  })

  it.each([1, 999])('acepta la cantidad %d', (cantidad) => {
    expect(() => insertarItem(db, base.restaurante, pedido, { cantidad })).not.toThrow()
  })

  it.each([
    [-1, /CHECK/],
    [1.5, /REAL/],
  ] as const)('rechaza la cantidad %d', (cantidad, error) => {
    expect(() => insertarItem(db, base.restaurante, pedido, { cantidad })).toThrow(error)
  })

  it('la cantidad anulada va de 0 a la cantidad del ítem', () => {
    expect(() =>
      insertarItem(db, base.restaurante, pedido, { cantidad: 3, cantidad_anulada: 1 }),
    ).not.toThrow()
    expect(() =>
      insertarItem(db, base.restaurante, pedido, { cantidad: 3, cantidad_anulada: 4 }),
    ).toThrow(/CHECK/)
  })

  it('un impuesto exento no puede tener tarifa', () => {
    expect(() =>
      insertarVersionado(db, 'impuesto', base.restaurante, {
        nombre: 'E',
        tipo: 'exento',
        tarifa: 800,
      }),
    ).toThrow(/CHECK/)
    expect(() =>
      insertarItem(db, base.restaurante, pedido, { impuesto_tipo: 'exento', tarifa: 800 }),
    ).toThrow(/CHECK/)
    expect(() =>
      insertarItem(db, base.restaurante, pedido, { impuesto_tipo: 'exento', tarifa: 0 }),
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
        nombre: 'tablas',
        sql: `CREATE TABLE padre (id INTEGER PRIMARY KEY) STRICT;
              CREATE TABLE hijo (id INTEGER PRIMARY KEY, padre_id INTEGER REFERENCES padre (id)) STRICT;
              INSERT INTO padre VALUES (1); INSERT INTO hijo VALUES (1, 1);`,
      },
      {
        version: 2,
        nombre: 'reconstruir padre',
        sinClavesForaneas: true,
        sql: `CREATE TABLE padre_nueva (id INTEGER PRIMARY KEY, nombre TEXT) STRICT;
              INSERT INTO padre_nueva (id) SELECT id FROM padre;
              DROP TABLE padre;
              ALTER TABLE padre_nueva RENAME TO padre;`,
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
        nombre: 'tablas',
        sql: `CREATE TABLE padre (id INTEGER PRIMARY KEY) STRICT;
              CREATE TABLE hijo (id INTEGER PRIMARY KEY, padre_id INTEGER REFERENCES padre (id)) STRICT;
              INSERT INTO padre VALUES (1); INSERT INTO hijo VALUES (1, 1);`,
      },
      { version: 2, nombre: 'rompe', sinClavesForaneas: true, sql: 'DELETE FROM padre;' },
    ]

    expect(() => aplicarMigraciones(db, migraciones)).toThrow(/referencias rotas/)
    expect(db.prepare('SELECT count(*) AS n FROM padre').get()?.n).toBe(1)
  })
})

describe('transacciones', () => {
  it('no admiten funciones asíncronas', () => {
    const db = baseMigrada()

    expect(() => enTransaccion(db, async () => 1)).toThrow(/asíncronas/)
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
    const primera = abrirBase(ruta, { exclusiva: true })

    expect(() => abrirBase(ruta, { exclusiva: true, esperaMs: 50 })).toThrow(BaseOcupadaError)
    primera.close()
    expect(() => abrirBase(ruta, { exclusiva: true, esperaMs: 50 }).close()).not.toThrow()
  })
})
