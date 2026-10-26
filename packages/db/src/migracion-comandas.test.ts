import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { COLUMNAS_COMUNES, TABLAS_LOCALES, TABLAS_VERSIONADAS } from './esquema'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, huellaSql, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado, sembrar } from './pruebas/utiles'
import type { BaseSqlite, ValorSql } from './sqlite'

// Migración 6 (tarea 1.4, ADR-015): impresoras, cola de impresión y pantallas de cocina.

const HASTA_5 = MIGRACIONES.filter((m) => m.version <= 5)
const HASTA_6 = MIGRACIONES.filter((m) => m.version <= 6)

/** Una base real de la versión 5, con un salón, personal, un equipo y una sesión ya andando. */
function baseVersion5() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_5)
  const s = sembrar(db)
  const role = insertarVersionado(db, 'roles', s.restaurant, { name: 'Mesero', system: 1 })
  const rolCocina = insertarVersionado(db, 'roles', s.restaurant, { name: 'Cocina' })
  const ana = insertarVersionado(db, 'users', s.restaurant, { name: 'Ana', role_id: role })
  const luis = insertarVersionado(db, 'users', s.restaurant, {
    name: 'Luis',
    role_id: rolCocina,
    active: 0,
  })
  const device = insertarVersionado(db, 'devices', s.restaurant, {
    location_id: s.location,
    name: 'Celular de Ana',
    type: 'waiter',
  })
  const screen = insertarVersionado(db, 'devices', s.restaurant, {
    location_id: s.location,
    name: 'Tablet vieja',
    type: 'kds',
    revoked_at: AHORA,
  })
  const station = insertarVersionado(db, 'stations', s.restaurant, { name: 'Cocina' })
  insertarEnTabla(db, 'sessions', {
    id: newId(),
    restaurant_id: s.restaurant,
    user_id: ana,
    device_id: device,
    secret_hash: 'h',
    start: AHORA,
    last_used: AHORA,
  })
  return { db, ...s, role, rolCocina, ana, luis, device, screen, station }
}

const migrada = () => {
  const base = baseVersion5()
  aplicarMigraciones(base.db, HASTA_6)
  return base
}

const contar = (db: BaseSqlite, tabla: string) =>
  Number(db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get()?.n)

const TABLAS_ANTES = [
  'restaurants',
  'locations',
  'zones',
  'taxes',
  'categories',
  'products',
  'roles',
  'users',
  'devices',
  'stations',
  'sessions',
  'counters',
  'migrations',
] as const

/** Una impresora de red con todo en regla; `campos` cambia lo que se quiera probar. */
function printer(
  db: BaseSqlite,
  restaurant: string,
  fields: Record<string, ValorSql> = {},
  id: string = newId(),
) {
  return insertarVersionado(
    db,
    'printers',
    restaurant,
    {
      name: 'Cocina',
      connection: 'network',
      address: '192.168.1.50',
      port: 9100,
      width: 80,
      ...fields,
    },
    id,
  )
}

function trabajo(
  db: BaseSqlite,
  restaurant: string,
  impresoraId: string,
  fields: Record<string, ValorSql> = {},
) {
  const id = newId()
  insertarEnTabla(db, 'print_jobs', {
    id,
    restaurant_id: restaurant,
    printer_id: impresoraId,
    type: 'ticket',
    content: '{"station":"Cocina"}',
    created_at: AHORA,
    ...fields,
  })
  return id
}

describe('migración 6: ficha', () => {
  it('es la 6, se llama comandas y aplica sobre la 5 sin tocar nada más', () => {
    const { db } = baseVersion5()
    expect(MIGRACIONES.find((m) => m.version === 6)?.name).toBe('tickets')
    expect(versionActual(db)).toBe(5)
    expect(aplicarMigraciones(db, HASTA_6)).toEqual([6])
    expect(versionActual(db)).toBe(6)
    const registro = db.prepare('SELECT * FROM migrations WHERE version = 6').get()
    expect(registro).toMatchObject({
      name: 'tickets',
      hash: huellaSql(MIGRACIONES[5]?.sql as string),
    })
  })

  it('repetirla no hace nada, y editarla después de aplicada se rechaza por su huella', () => {
    const { db } = migrada()
    expect(aplicarMigraciones(db, HASTA_6)).toEqual([])
    const editada = [
      ...HASTA_6.slice(0, 5),
      { ...(HASTA_6[5] as object), sql: `${MIGRACIONES[5]?.sql}\n-- x` },
    ]
    expect(() => aplicarMigraciones(db, editada as never)).toThrow(/cambió después de aplicarse/)
  })

  it('las dos tablas nuevas son STRICT y quedan en su categoría', () => {
    const { db } = migrada()
    const sqlTables = db.prepare('PRAGMA table_list').all()
    for (const name of ['printers', 'print_jobs'])
      expect(sqlTables.find((t) => t.name === name)).toMatchObject({ strict: 1 })
    expect(TABLAS_VERSIONADAS).toContain('printers')
    expect(TABLAS_LOCALES).toContain('print_jobs')
    const columnas = db
      .prepare("SELECT name FROM pragma_table_info('printers')")
      .all()
      .map((c) => c.name)
    for (const common of COLUMNAS_COMUNES) expect(columnas).toContain(common)
  })
})

describe('migración 6: no se pierde nada', () => {
  it('ninguna fila de las tablas anteriores desaparece ni cambia', () => {
    const base = baseVersion5()
    const before = Object.fromEntries(TABLAS_ANTES.map((t) => [t, contar(base.db, t)]))
    const filasAntes = base.db.prepare('SELECT * FROM users ORDER BY id').all()
    const dispositivosAntes = base.db.prepare('SELECT * FROM devices ORDER BY id').all()
    const rolesAntes = base.db.prepare('SELECT * FROM roles ORDER BY id').all()
    expect(before.users).toBe(2)
    expect(before.devices).toBe(2)
    aplicarMigraciones(base.db, HASTA_6)
    // `migracion` crece en una fila (la 6); el resto queda igual.
    for (const t of TABLAS_ANTES)
      expect(contar(base.db, t)).toBe(t === 'migrations' ? 6 : before[t])
    const sinColumnaNueva = (rows: Record<string, ValorSql>[], newOne: string) =>
      rows.map(({ [newOne]: _, ...rest }) => rest)
    expect(
      sinColumnaNueva(base.db.prepare('SELECT * FROM users ORDER BY id').all(), 'screen'),
    ).toEqual(filasAntes)
    expect(
      sinColumnaNueva(base.db.prepare('SELECT * FROM devices ORDER BY id').all(), 'station_ids'),
    ).toEqual(dispositivosAntes)
    expect(
      sinColumnaNueva(base.db.prepare('SELECT * FROM roles ORDER BY id').all(), 'hidden'),
    ).toEqual(rolesAntes)
  })

  it('lo que ya existía queda como antes: personas reales, roles visibles, equipos sin estaciones', () => {
    const { db } = migrada()
    expect(db.prepare('SELECT DISTINCT screen FROM users').all()).toEqual([{ screen: 0 }])
    expect(db.prepare('SELECT DISTINCT hidden FROM roles').all()).toEqual([{ hidden: 0 }])
    expect(db.prepare('SELECT DISTINCT station_ids FROM devices').all()).toEqual([
      { station_ids: null },
    ])
    expect(contar(db, 'printers')).toBe(0)
    expect(contar(db, 'print_jobs')).toBe(0)
  })

  it('la base queda íntegra: sin referencias rotas', () => {
    const { db } = migrada()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })

  it('un equipo que ya era pantalla (kds) sigue siendo kds y puede recibir estaciones', () => {
    const { db, screen, station } = migrada()
    expect(db.prepare('SELECT type FROM devices WHERE id = ?').get(screen)).toEqual({
      type: 'kds',
    })
    db.prepare('UPDATE devices SET station_ids = ? WHERE id = ?').run(
      JSON.stringify([station]),
      screen,
    )
    expect(db.prepare('SELECT station_ids FROM devices WHERE id = ?').get(screen)).toEqual({
      station_ids: JSON.stringify([station]),
    })
  })

  it('una migración que falla a medias deja la base en la 5 (todo o nada)', () => {
    const { db } = baseVersion5()
    const broken = {
      version: 6,
      name: 'tickets',
      sql: `${MIGRACIONES[5]?.sql}
CREATE TABLE printers (x TEXT) STRICT;`,
    }
    expect(() => aplicarMigraciones(db, [...HASTA_5, broken])).toThrow()
    expect(versionActual(db)).toBe(5)
    const names = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((t) => t.name)
    expect(names).not.toContain('printers')
    expect(names).not.toContain('print_jobs')
    const columnas = db.prepare("SELECT name FROM pragma_table_info('users')").all()
    expect(columnas.map((c) => c.name)).not.toContain('screen')
  })
})

describe('migración 6: columnas nuevas de equipo, persona y rol', () => {
  it.each([
    ['users', 'screen'],
    ['roles', 'hidden'],
  ])('%s.%s solo acepta 0 y 1', (tabla, columna) => {
    const { db, ana, role } = migrada()
    const id = tabla === 'users' ? ana : role
    expect(() =>
      db.prepare(`UPDATE ${tabla} SET ${columna} = 1 WHERE id = ?`).run(id),
    ).not.toThrow()
    expect(() =>
      db.prepare(`UPDATE ${tabla} SET ${columna} = 0 WHERE id = ?`).run(id),
    ).not.toThrow()
    for (const badCase of [2, -1])
      expect(() =>
        db.prepare(`UPDATE ${tabla} SET ${columna} = ? WHERE id = ?`).run(badCase, id),
      ).toThrow(/CHECK/)
    expect(() => db.prepare(`UPDATE ${tabla} SET ${columna} = NULL WHERE id = ?`).run(id)).toThrow()
  })

  it('dispositivo.estacion_ids acepta NULL y JSON, y rechaza texto que no es JSON', () => {
    const { db, device } = migrada()
    const poner = (v: string | null) =>
      db.prepare('UPDATE devices SET station_ids = ? WHERE id = ?').run(v, device)
    expect(() => poner(null)).not.toThrow()
    expect(() => poner('[]')).not.toThrow()
    expect(() => poner('["a","b"]')).not.toThrow()
    expect(() => poner('[a,')).toThrow(/CHECK/)
    expect(() => poner('no es json')).toThrow(/CHECK/)
  })
})

describe('migración 6: tabla impresora', () => {
  it('una impresora de red con sus valores de fábrica', () => {
    const { db, restaurant } = migrada()
    const id = printer(db, restaurant)
    expect(db.prepare('SELECT * FROM printers WHERE id = ?').get(id)).toMatchObject({
      active: 1,
      code_page: 'pc850',
      station_ids: '[]',
      fallback_id: null,
      port: 9100,
    })
  })

  it('una impresora USB no lleva puerto', () => {
    const { db, restaurant } = migrada()
    expect(() =>
      printer(db, restaurant, { connection: 'usb', address: 'POS-80', port: null }),
    ).not.toThrow()
  })

  it.each([
    ['conexión desconocida', { connection: 'bluetooth' }],
    ['ancho 57', { width: 57 }],
    ['ancho 0', { width: 0 }],
    ['página de códigos inventada', { code_page: 'utf8' }],
    ['nombre vacío', { name: '' }],
    ['nombre de 61', { name: 'a'.repeat(61) }],
    ['dirección vacía', { address: '' }],
    ['dirección de 256', { address: 'a'.repeat(256) }],
    ['puerto 0', { port: 0 }],
    ['puerto 65536', { port: 65536 }],
    ['puerto negativo', { port: -1 }],
    ['estaciones que no son JSON', { station_ids: '[Cocina' }],
    ['activo 2', { active: 2 }],
    ['versión negativa', { version: -1 }],
  ])('rechaza %s', (_, fields) => {
    const { db, restaurant } = migrada()
    expect(() => printer(db, restaurant, fields as Record<string, ValorSql>)).toThrow()
  })

  it.each([
    ['nombre de 1', { name: 'a' }],
    ['nombre de 60', { name: 'a'.repeat(60) }],
    ['dirección de 255', { address: 'a'.repeat(255) }],
    ['puerto 1', { port: 1 }],
    ['puerto 65535', { port: 65535 }],
    ['ancho 58', { width: 58 }],
    ['página wpc1252', { code_page: 'wpc1252' }],
    ['página no_accents', { code_page: 'no_accents' }],
    ['sin puerto', { port: null }],
  ])('acepta %s', (_, fields) => {
    const { db, restaurant } = migrada()
    expect(() => printer(db, restaurant, fields as Record<string, ValorSql>)).not.toThrow()
  })

  it('el id debe ser un ULID de 26 caracteres', () => {
    const { db, restaurant } = migrada()
    expect(() => printer(db, restaurant, {}, 'corto')).toThrow(/CHECK/)
  })

  it('una impresora no puede ser su propio respaldo, ni apuntar a una que no existe', () => {
    const { db, restaurant } = migrada()
    const id = newId()
    expect(() => printer(db, restaurant, { fallback_id: id }, id)).toThrow(/CHECK/)
    expect(() => printer(db, restaurant, { fallback_id: newId() })).toThrow(/FOREIGN KEY/)
    const another = printer(db, restaurant)
    expect(() => printer(db, restaurant, { fallback_id: another })).not.toThrow()
    // Cambiarse a sí misma como respaldo después tampoco.
    expect(() =>
      db.prepare('UPDATE printers SET fallback_id = id WHERE id = ?').run(another),
    ).toThrow(/CHECK/)
  })

  it('no se borra: se archiva', () => {
    const { db, restaurant } = migrada()
    const id = printer(db, restaurant)
    expect(() => db.prepare('DELETE FROM printers WHERE id = ?').run(id)).toThrow(/se archiva/)
    expect(() => db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(id)).not.toThrow()
    expect(contar(db, 'printers')).toBe(1)
  })

  it('exige un restaurante que exista', () => {
    const { db } = migrada()
    expect(() => printer(db, newId())).toThrow(/FOREIGN KEY/)
  })
})

describe('migración 6: cola de impresión (trabajo_impresion)', () => {
  it('un trabajo nuevo nace pendiente, sin intentos y sin hora de fin', () => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    const id = trabajo(db, restaurant, p)
    expect(db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      finished_at: null,
      last_error: null,
      printed_on_id: null,
      discarded_by_id: null,
    })
  })

  it.each([
    ['tipo desconocido', { type: 'factura' }],
    ['estado desconocido', { status: 'sent' }],
    ['intentos negativos', { attempts: -1 }],
    ['contenido que no es JSON', { content: 'comanda' }],
    ['pendiente con hora de fin', { finished_at: AHORA }],
    ['impreso sin hora de fin', { status: 'printed', printed_on_id: 'x' }],
    ['descartado sin hora de fin', { status: 'discarded' }],
    ['id corto', { id: 'corto' }],
  ])('rechaza %s', (_, fields) => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    expect(() => trabajo(db, restaurant, p, fields as Record<string, ValorSql>)).toThrow()
  })

  it('impreso exige decir en qué impresora salió', () => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    expect(() => trabajo(db, restaurant, p, { status: 'printed', finished_at: AHORA })).toThrow(
      /CHECK/,
    )
    expect(() =>
      trabajo(db, restaurant, p, { status: 'printed', finished_at: AHORA, printed_on_id: p }),
    ).not.toThrow()
  })

  it('descartado puede ser por una persona o por el hub (sin persona)', () => {
    const { db, restaurant, ana } = migrada()
    const p = printer(db, restaurant)
    expect(() =>
      trabajo(db, restaurant, p, {
        status: 'discarded',
        finished_at: AHORA,
        discarded_by_id: ana,
      }),
    ).not.toThrow()
    expect(() =>
      trabajo(db, restaurant, p, { status: 'discarded', finished_at: AHORA }),
    ).not.toThrow()
    expect(() =>
      trabajo(db, restaurant, p, {
        status: 'discarded',
        finished_at: AHORA,
        discarded_by_id: newId(),
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it('un trabajo pasa de pendiente a impreso, pero no vuelve a pendiente sin hora de fin', () => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    const id = trabajo(db, restaurant, p)
    db.prepare(
      "UPDATE print_jobs SET status = 'printed', finished_at = ?, printed_on_id = ? WHERE id = ?",
    ).run(AHORA, p, id)
    expect(() =>
      db.prepare("UPDATE print_jobs SET status = 'pending' WHERE id = ?").run(id),
    ).toThrow(/CHECK/)
  })

  it('apunta a impresoras que existen', () => {
    const { db, restaurant } = migrada()
    expect(() => trabajo(db, restaurant, newId())).toThrow(/FOREIGN KEY/)
    const p = printer(db, restaurant)
    expect(() =>
      trabajo(db, restaurant, p, {
        status: 'printed',
        finished_at: AHORA,
        printed_on_id: newId(),
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it('no se borra nunca: ni siquiera el impreso', () => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    const id = trabajo(db, restaurant, p, {
      status: 'printed',
      finished_at: AHORA,
      printed_on_id: p,
    })
    expect(() => db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id)).toThrow(/no se borra/)
    expect(() => db.prepare('DELETE FROM print_jobs').run()).toThrow(/no se borra/)
    expect(contar(db, 'print_jobs')).toBe(1)
  })

  it('archivar una impresora con trabajos no borra ni toca sus trabajos', () => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    trabajo(db, restaurant, p)
    trabajo(db, restaurant, p)
    db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(p)
    expect(contar(db, 'print_jobs')).toBe(2)
    expect(
      db.prepare("SELECT count(*) AS n FROM print_jobs WHERE status = 'pending'").get(),
    ).toEqual({ n: 2 })
  })
})

describe('migración 6: el índice único impide duplicar la comanda', () => {
  const event = newId()
  const ticket = newId()

  it('el mismo evento, la misma comanda y la misma impresora no se guardan dos veces', () => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    trabajo(db, restaurant, p, { event_id: event, ticket_id: ticket })
    expect(() => trabajo(db, restaurant, p, { event_id: event, ticket_id: ticket })).toThrow(
      /UNIQUE/,
    )
    expect(contar(db, 'print_jobs')).toBe(1)
  })

  it('con ON CONFLICT DO NOTHING (como lo usa el hub) el reintento se ignora sin error', () => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    const insertar = () =>
      db
        .prepare(
          `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, event_id, ticket_id, content, created_at)
           VALUES (?, ?, ?, 'ticket', ?, ?, '{}', ?) ON CONFLICT DO NOTHING`,
        )
        .run(newId(), restaurant, p, event, ticket, AHORA)
    expect(Number(insertar().changes)).toBe(1)
    expect(Number(insertar().changes)).toBe(0)
    expect(contar(db, 'print_jobs')).toBe(1)
  })

  it('también cuenta aunque el primero ya se imprimió o se descartó', () => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    trabajo(db, restaurant, p, {
      event_id: event,
      ticket_id: ticket,
      status: 'printed',
      finished_at: AHORA,
      printed_on_id: p,
    })
    expect(() => trabajo(db, restaurant, p, { event_id: event, ticket_id: ticket })).toThrow(
      /UNIQUE/,
    )
  })

  it('la misma comanda en otra impresora, u otra comanda del mismo evento, sí se guarda', () => {
    const { db, restaurant } = migrada()
    const p1 = printer(db, restaurant)
    const p2 = printer(db, restaurant, { name: 'Barra' })
    trabajo(db, restaurant, p1, { event_id: event, ticket_id: ticket })
    expect(() => trabajo(db, restaurant, p2, { event_id: event, ticket_id: ticket })).not.toThrow()
    expect(() => trabajo(db, restaurant, p1, { event_id: event, ticket_id: newId() })).not.toThrow()
    expect(() =>
      trabajo(db, restaurant, p1, { event_id: newId(), ticket_id: ticket }),
    ).not.toThrow()
    expect(contar(db, 'print_jobs')).toBe(4)
  })

  it('las páginas de prueba (sin evento) pueden repetirse todas las veces que se quiera', () => {
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    for (let i = 0; i < 3; i++) trabajo(db, restaurant, p, { type: 'test' })
    expect(contar(db, 'print_jobs')).toBe(3)
  })

  it('un trabajo sin comanda (comanda_id NULL) de un mismo evento no queda cubierto por el índice', () => {
    // Documenta el límite del índice: SQLite no compara NULL con NULL. El hub siempre manda
    // `ticket_id`, así que esto no pasa en uso normal.
    const { db, restaurant } = migrada()
    const p = printer(db, restaurant)
    trabajo(db, restaurant, p, { event_id: event })
    expect(() => trabajo(db, restaurant, p, { event_id: event })).not.toThrow()
  })

  it('el índice es parcial: existe con ese nombre y solo cubre trabajos con evento', () => {
    const { db } = migrada()
    const indice = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'print_jobs_unique'")
      .get()
    expect(String(indice?.sql)).toMatch(/UNIQUE/i)
    expect(String(indice?.sql)).toMatch(/WHERE event_id IS NOT NULL/i)
  })
})

describe('migración 6: varios restaurantes en la misma base', () => {
  it('cada restaurante tiene sus impresoras y su cola; los conteos no se cruzan', () => {
    const { db, restaurant } = migrada()
    const other = sembrar(db).restaurant
    const p1 = printer(db, restaurant)
    const p2 = printer(db, other)
    trabajo(db, restaurant, p1)
    trabajo(db, other, p2)
    trabajo(db, other, p2)
    const lookup = (r: string) =>
      Number(db.prepare('SELECT count(*) AS n FROM print_jobs WHERE restaurant_id = ?').get(r)?.n)
    expect(lookup(restaurant)).toBe(1)
    expect(lookup(other)).toBe(2)
    expect(
      Number(
        db.prepare('SELECT count(*) AS n FROM printers WHERE restaurant_id = ?').get(other)?.n,
      ),
    ).toBe(1)
  })
})
