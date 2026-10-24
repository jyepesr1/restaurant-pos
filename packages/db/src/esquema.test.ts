import { nuevoId } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COLUMNAS_COMUNES,
  TABLAS_INMUTABLES,
  TABLAS_LOCALES,
  TABLAS_PROYECCION,
  TABLAS_VERSIONADAS,
} from './esquema'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones } from './migrar'
import { abrirBase } from './node'
import type { BaseSqlite, ValorSql } from './sqlite'

const AHORA = '2026-10-24T15:00:00.000Z'

function nombresDeTablas(db: BaseSqlite): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((fila) => String(fila.name))
}

/** Inserta una fila con las columnas comunes de un registro versionado. */
function insertarVersionado(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  campos: Record<string, ValorSql>,
  id = nuevoId(),
): string {
  const fila: Record<string, ValorSql> = {
    id,
    restaurante_id: restauranteId,
    creado_en: AHORA,
    actualizado_en: AHORA,
    version: 1,
    ...campos,
  }
  const columnas = Object.keys(fila)
  db.prepare(
    `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
  ).run(...Object.values(fila))
  return id
}

/** Restaurante con lo mínimo para crear productos. */
function sembrarMinimo(db: BaseSqlite) {
  const restaurante = nuevoId()
  insertarVersionado(
    db,
    'restaurante',
    restaurante,
    { nombre: 'Prueba', config: '{}' },
    restaurante,
  )
  const impuesto = insertarVersionado(db, 'impuesto', restaurante, {
    nombre: 'INC 8 %',
    tipo: 'inc',
    tarifa: 800,
  })
  const categoria = insertarVersionado(db, 'categoria', restaurante, { nombre: 'Pizzas' })
  return { restaurante, impuesto, categoria }
}

function insertarEvento(
  db: BaseSqlite,
  restaurante: string,
  campos: Record<string, ValorSql> = {},
) {
  const fila: Record<string, ValorSql> = {
    restaurante_id: restaurante,
    id: nuevoId(),
    tipo: 'PedidoAbierto',
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: nuevoId(),
    datos: '{"canal":"salon"}',
    usuario_id: nuevoId(),
    dispositivo_id: nuevoId(),
    hora_dispositivo: AHORA,
    hora_estimada_hub: AHORA,
    secuencia_base: 0,
    secuencia: 1,
    recibido_en: AHORA,
    dia_operativo: '2026-10-24',
    contenido_hash: 'abc',
    ...campos,
  }
  const columnas = Object.keys(fila)
  db.prepare(
    `INSERT INTO evento (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
  ).run(...Object.values(fila))
  return fila
}

describe('migraciones', () => {
  it('crean la base desde cero y no repiten nada en una segunda corrida', () => {
    const db = abrirBase(':memory:')

    expect(aplicarMigraciones(db)).toEqual(MIGRACIONES.map((m) => m.version))
    expect(aplicarMigraciones(db)).toEqual([])
  })

  it('se niegan a abrir una base más nueva que la aplicación', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db)
    db.prepare(
      "INSERT INTO migracion (version, nombre, hash, aplicada_en) VALUES (99, 'futura', 'x', ?)",
    ).run(AHORA)

    expect(() => aplicarMigraciones(db)).toThrow(/más nueva que esta aplicación/)
  })

  it('si una migración falla, la base queda en la versión anterior', () => {
    const db = abrirBase(':memory:')
    const migraciones = [
      { version: 1, nombre: 'buena', sql: 'CREATE TABLE a (x INTEGER) STRICT;' },
      {
        version: 2,
        nombre: 'rota',
        sql: 'CREATE TABLE b (x INTEGER) STRICT; SELECT * FROM no_existe;',
      },
    ]

    expect(() => aplicarMigraciones(db, migraciones)).toThrow()
    expect(nombresDeTablas(db)).toContain('a')
    expect(nombresDeTablas(db)).not.toContain('b')
    expect(db.prepare('SELECT max(version) AS v FROM migracion').get()?.v).toBe(1)
  })

  it('exigen numeración consecutiva', () => {
    const db = abrirBase(':memory:')
    const migraciones = [{ version: 2, nombre: 'salta', sql: 'SELECT 1;' }]

    expect(() => aplicarMigraciones(db, migraciones)).toThrow(/numeradas/)
  })
})

describe('esquema', () => {
  let db: BaseSqlite

  beforeEach(() => {
    db = abrirBase(':memory:')
    aplicarMigraciones(db)
  })

  it('toda tabla está en exactamente una categoría', () => {
    const clasificadas = [
      ...TABLAS_VERSIONADAS,
      ...TABLAS_INMUTABLES,
      ...TABLAS_PROYECCION,
      ...TABLAS_LOCALES,
    ]

    expect(new Set(clasificadas).size).toBe(clasificadas.length)
    expect(nombresDeTablas(db).sort()).toEqual([...clasificadas].sort())
  })

  it('todas las tablas son STRICT', () => {
    const noEstrictas = db
      .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND strict = 0")
      .all()
      .map((fila) => String(fila.name))
      .filter((nombre) => !nombre.startsWith('sqlite_'))

    expect(noEstrictas).toEqual([])
  })

  it.each(TABLAS_VERSIONADAS)('%s tiene las columnas comunes', (tabla) => {
    const columnas = db
      .prepare(`SELECT name FROM pragma_table_info('${tabla}')`)
      .all()
      .map((fila) => String(fila.name))

    expect(columnas).toEqual(expect.arrayContaining([...COLUMNAS_COMUNES]))
  })

  it('las claves foráneas están activas', () => {
    const { restaurante } = sembrarMinimo(db)

    expect(() =>
      insertarVersionado(db, 'mesa', restaurante, {
        zona_id: nuevoId(),
        nombre: '1',
        forma: 'redonda',
        x: 0,
        y: 0,
        ancho: 2,
        alto: 2,
        capacidad: 4,
      }),
    ).toThrow(/FOREIGN KEY/)
  })
})

describe('dinero en la base', () => {
  let db: BaseSqlite
  let base: ReturnType<typeof sembrarMinimo>

  beforeEach(() => {
    db = abrirBase(':memory:')
    aplicarMigraciones(db)
    base = sembrarMinimo(db)
  })

  const producto = (precio: ValorSql) =>
    insertarVersionado(db, 'producto', base.restaurante, {
      categoria_id: base.categoria,
      nombre: 'Garden Margarita',
      precio,
      impuesto_id: base.impuesto,
    })

  it('acepta precios enteros en pesos', () => {
    expect(() => producto(40900)).not.toThrow()
    expect(() => producto(0)).not.toThrow()
  })

  it('rechaza precios con decimales', () => {
    expect(() => producto(40900.5)).toThrow(/REAL/)
  })

  it.each([-1, 100_000_001])('rechaza el precio %d (fuera de rango)', (precio) => {
    expect(() => producto(precio)).toThrow(/CHECK/)
  })

  it.each([-1, 10_001, 8.5])('rechaza la tarifa de impuesto %d', (tarifa) => {
    expect(() =>
      insertarVersionado(db, 'impuesto', base.restaurante, { nombre: 'X', tipo: 'iva', tarifa }),
    ).toThrow()
  })

  it.each([0, 1000])('rechaza la cantidad %d en un ítem de pedido', (cantidad) => {
    const pedido = nuevoId()
    db.prepare(
      `INSERT INTO pedido (id, restaurante_id, canal, estado, abierto_en, ultima_secuencia)
       VALUES (?, ?, 'salon', 'abierto', ?, 1)`,
    ).run(pedido, base.restaurante, AHORA)

    expect(() =>
      db
        .prepare(
          `INSERT INTO pedido_item (id, restaurante_id, pedido_id, orden, producto_id, nombre,
             precio_unitario, impuesto_tipo, tarifa, cantidad, estado, agregado_por)
           VALUES (?, ?, ?, 1, ?, 'Pinsa', 20900, 'inc', 800, ?, 'pendiente', ?)`,
        )
        .run(nuevoId(), base.restaurante, pedido, nuevoId(), cantidad, nuevoId()),
    ).toThrow(/CHECK/)
  })
})

describe('eventos', () => {
  let db: BaseSqlite
  let restaurante: string

  beforeEach(() => {
    db = abrirBase(':memory:')
    aplicarMigraciones(db)
    restaurante = sembrarMinimo(db).restaurante
  })

  it('no se pueden modificar', () => {
    const evento = insertarEvento(db, restaurante)

    expect(() =>
      db.prepare("UPDATE evento SET datos = '{}' WHERE id = ?").run(evento.id ?? null),
    ).toThrow(/no se modifican/)
  })

  it('no se pueden borrar', () => {
    const evento = insertarEvento(db, restaurante)

    expect(() => db.prepare('DELETE FROM evento WHERE id = ?').run(evento.id ?? null)).toThrow(
      /no se borran/,
    )
  })

  it.each(TABLAS_INMUTABLES)('%s tiene bloqueados UPDATE y DELETE', (tabla) => {
    const disparadores = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
      .all(tabla)
      .map((fila) => String(fila.name))

    expect(disparadores).toEqual(
      expect.arrayContaining([
        `${tabla}_sin_delete`,
        `${tabla}_sin_reemplazo`,
        `${tabla}_sin_update`,
      ]),
    )
  })

  it('el mismo id no se guarda dos veces en un restaurante', () => {
    const evento = insertarEvento(db, restaurante)

    expect(() => insertarEvento(db, restaurante, { id: evento.id ?? null, secuencia: 2 })).toThrow(
      /no se reemplazan/,
    )
  })

  it('dos eventos no comparten secuencia', () => {
    insertarEvento(db, restaurante, { secuencia: 1 })

    expect(() => insertarEvento(db, restaurante, { secuencia: 1 })).toThrow(
      /no se reemplazan|sin huecos/,
    )
  })

  it('la secuencia es contigua: no admite huecos', () => {
    insertarEvento(db, restaurante, { secuencia: 1 })

    expect(() => insertarEvento(db, restaurante, { secuencia: 3 })).toThrow(/sin huecos/)
    expect(() => insertarEvento(db, restaurante, { secuencia: 2 })).not.toThrow()
  })

  it('INSERT OR REPLACE no puede reescribir un evento', () => {
    const evento = insertarEvento(db, restaurante, { datos: '{"a":1}' })
    const columnas = Object.keys(evento)
    const reemplazar = db.prepare(
      `INSERT OR REPLACE INTO evento (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
    )

    expect(() => reemplazar.run(...Object.values({ ...evento, datos: '{"a":2}' }))).toThrow(
      /no se reemplazan|sin huecos/,
    )
    expect(db.prepare('SELECT datos FROM evento').get()?.datos).toBe('{"a":1}')
  })

  it('rechaza datos que no son JSON y días operativos mal formados', () => {
    expect(() => insertarEvento(db, restaurante, { datos: 'no es json' })).toThrow(/CHECK/)
    expect(() => insertarEvento(db, restaurante, { dia_operativo: '24/10/2026' })).toThrow(/CHECK/)
  })

  it('las proyecciones sí se pueden borrar para reconstruirlas', () => {
    const pedido = nuevoId()
    db.prepare(
      `INSERT INTO pedido (id, restaurante_id, canal, estado, abierto_en, ultima_secuencia)
       VALUES (?, ?, 'salon', 'abierto', ?, 1)`,
    ).run(pedido, restaurante, AHORA)

    expect(() => db.exec('DELETE FROM pedido')).not.toThrow()
  })
})

describe('credenciales', () => {
  it('un PIN es único entre usuarios vigentes, pero se libera al desactivar', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db)
    const { restaurante } = sembrarMinimo(db)
    const rol = insertarVersionado(db, 'rol', restaurante, { nombre: 'mesero' })
    const usuario = () =>
      insertarVersionado(db, 'usuario', restaurante, { nombre: 'Ana', rol_id: rol })
    const credencial = db.prepare(
      `INSERT INTO usuario_credencial (usuario_id, restaurante_id, pin_huella, pin_generado_en, vigente)
       VALUES (?, ?, 'huella-1', ?, ?)`,
    )

    const ana = usuario()
    credencial.run(ana, restaurante, AHORA, 1)
    expect(() => credencial.run(usuario(), restaurante, AHORA, 1)).toThrow(/UNIQUE/)

    db.prepare('UPDATE usuario_credencial SET vigente = 0 WHERE usuario_id = ?').run(ana)
    expect(() => credencial.run(usuario(), restaurante, AHORA, 1)).not.toThrow()
  })
})
