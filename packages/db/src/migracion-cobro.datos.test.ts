import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado, sembrar } from './pruebas/utiles'
import type { BaseSqlite } from './sqlite'

// Migración 7 con datos reales de una base 6: la cola de impresión se reconstruye (SQLite no deja
// cambiar un CHECK) y no puede perder ni mover nada de lo que ya estaba.

const HASTA_6 = MIGRACIONES.filter((m) => m.version <= 6)
// Hasta la 7: las que vienen después tienen sus propias pruebas.
const HASTA_7 = MIGRACIONES.filter((m) => m.version <= 7)

function baseVersion6() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_6)
  const s = sembrar(db)
  const printer = (name: string, width = 80) =>
    insertarVersionado(db, 'printers', s.restaurant, {
      name,
      connection: 'network',
      address: '192.168.1.50',
      port: 9100,
      width,
    })
  const bar = printer('Barra')
  const kitchen = printer('Cocina', 58)
  const role = insertarVersionado(db, 'roles', s.restaurant, { name: 'Cajero' })
  const user = insertarVersionado(db, 'users', s.restaurant, { name: 'Caja', role_id: role })
  const device = insertarVersionado(db, 'devices', s.restaurant, {
    location_id: s.location,
    name: 'Caja 1',
    type: 'register',
  })
  const trabajo = (fields: Record<string, string | number | null>) => {
    const id = newId()
    insertarEnTabla(db, 'print_jobs', {
      id,
      restaurant_id: s.restaurant,
      printer_id: bar,
      type: 'ticket',
      content: '{"station":"Barra","lines":["1 x Garden Margarita"]}',
      created_at: AHORA,
      ...fields,
    })
    return id
  }
  return { db, ...s, bar, kitchen, user, device, trabajo }
}

const rows = (db: BaseSqlite) => db.prepare('SELECT * FROM print_jobs ORDER BY id').all()

/** Una cola con un trabajo de cada estado y con todas las columnas llenas. */
function conCola() {
  const base = baseVersion6()
  const { trabajo, kitchen, bar, user, device } = base
  const pending = trabajo({
    event_id: newId(),
    ticket_id: newId(),
    printer_id: kitchen,
    attempts: 4,
    last_error: 'ECONNREFUSED 192.168.1.50:9100',
  })
  const printed = trabajo({
    status: 'printed',
    finished_at: AHORA,
    printed_on_id: kitchen,
    attempts: 2,
    event_id: newId(),
    ticket_id: newId(),
  })
  const discardedJob = trabajo({
    status: 'discarded',
    finished_at: AHORA,
    discarded_by_id: user,
    discarded_device_id: device,
    last_error: 'sin papel',
    attempts: 7,
    printer_id: bar,
  })
  const mockPrinter = trabajo({ type: 'test', content: '{"mockPrinter":true}' })
  return { ...base, pending, printed, discardedJob, mockPrinter }
}

describe('migración 7: una base 6 con trabajos de impresión de todos los estados', () => {
  it('cada fila queda idéntica, columna por columna (nada se corre ni se pierde)', () => {
    const { db } = conCola()
    const before = rows(db)
    expect(before).toHaveLength(4)
    expect(aplicarMigraciones(db, HASTA_7)).toEqual([7])
    const after = rows(db)
    expect(after).toEqual(before)
    // Las columnas no cambiaron ni de nombre ni de orden.
    const columns = (tableName: string) =>
      db
        .prepare(`SELECT name FROM pragma_table_info('${tableName}')`)
        .all()
        .map((c) => c.name)
    expect(Object.keys(after[0] ?? {})).toEqual(columns('print_jobs'))
  })

  it('conserva los datos que importan de una persona: quién descartó, desde qué equipo y por qué', () => {
    const { db, discardedJob, user, device, bar } = conCola()
    aplicarMigraciones(db, HASTA_7)
    expect(db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(discardedJob)).toMatchObject({
      status: 'discarded',
      discarded_by_id: user,
      discarded_device_id: device,
      last_error: 'sin papel',
      attempts: 7,
      printer_id: bar,
      finished_at: AHORA,
    })
  })

  it('el contenido JSON, el evento y la comanda de un pendiente se mantienen', () => {
    const { db, pending } = conCola()
    const before = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(pending)
    aplicarMigraciones(db, HASTA_7)
    const after = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(pending)
    expect(after).toEqual(before)
    expect(JSON.parse(String(after?.content))).toEqual({
      station: 'Barra',
      lines: ['1 x Garden Margarita'],
    })
    expect(after).toMatchObject({ status: 'pending', attempts: 4, finished_at: null })
  })

  it('las demás tablas quedan intactas y las claves foráneas, sin referencias rotas', () => {
    const { db } = conCola()
    const sqlTables = ['restaurants', 'printers', 'users', 'devices', 'roles', 'products']
    const check = (t: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n)
    const before = sqlTables.map(check)
    aplicarMigraciones(db, HASTA_7)
    expect(sqlTables.map(check)).toEqual(before)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })

  it('las claves foráneas quedan encendidas y se siguen exigiendo en la cola nueva', () => {
    const { db, trabajo } = conCola()
    aplicarMigraciones(db, HASTA_7)
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(() => trabajo({ printer_id: newId() })).toThrow(/FOREIGN KEY/)
    expect(() =>
      trabajo({
        status: 'discarded',
        finished_at: AHORA,
        discarded_by_id: newId(),
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it('la tabla no deja restos: ni la temporal ni índices o disparadores duplicados', () => {
    const { db } = conCola()
    aplicarMigraciones(db, HASTA_7)
    const objetos = db
      .prepare(
        "SELECT type, name FROM sqlite_schema WHERE tbl_name LIKE 'print_jobs%' ORDER BY name",
      )
      .all()
      .map((o) => `${o.type}:${o.name}`)
    expect(objetos.filter((o) => o.includes('new'))).toEqual([])
    expect(objetos).toEqual(
      expect.arrayContaining([
        'index:print_jobs_pending',
        'index:print_jobs_unique',
        'trigger:print_jobs_no_delete',
        'trigger:print_jobs_no_replace',
        'table:print_jobs',
      ]),
    )
    expect(new Set(objetos).size).toBe(objetos.length)
    const tableName = db
      .prepare('PRAGMA table_list')
      .all()
      .find((t) => t.name === 'print_jobs')
    expect(tableName).toMatchObject({ strict: 1 })
  })

  it('las reglas de la tabla siguen vigentes con los trabajos migrados', () => {
    const { db, trabajo, pending, printed, bar } = conCola()
    aplicarMigraciones(db, HASTA_7)
    // No se borra ni se reemplaza uno que ya existía antes de migrar.
    expect(() => db.prepare('DELETE FROM print_jobs WHERE id = ?').run(pending)).toThrow(
      /no se borra/,
    )
    expect(() =>
      db.prepare("UPDATE print_jobs SET status = 'cualquiera' WHERE id = ?").run(printed),
    ).toThrow()
    // El estado pendiente va sin hora de término, y los terminados con ella.
    expect(() => trabajo({ status: 'pending', finished_at: AHORA })).toThrow()
    expect(() => trabajo({ status: 'printed' })).toThrow()
    // Impreso necesita decir en qué impresora salió.
    expect(() => trabajo({ status: 'printed', finished_at: AHORA })).toThrow()
    expect(() =>
      trabajo({ status: 'printed', finished_at: AHORA, printed_on_id: bar }),
    ).not.toThrow()
    expect(() => trabajo({ attempts: -1 })).toThrow()
    expect(() => trabajo({ content: 'no es json' })).toThrow()
  })

  it('el mismo evento con la misma comanda no se duplica en una impresora, ni tampoco migrado', () => {
    const { db, trabajo, pending, kitchen } = conCola()
    aplicarMigraciones(db, HASTA_7)
    const migrado = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(pending)
    expect(() =>
      trabajo({
        event_id: String(migrado?.event_id),
        ticket_id: String(migrado?.ticket_id),
        printer_id: kitchen,
      }),
    ).toThrow(/UNIQUE/)
    // Otra impresora o otra comanda del mismo evento sí.
    expect(() =>
      trabajo({
        event_id: String(migrado?.event_id),
        ticket_id: String(migrado?.ticket_id),
      }),
    ).not.toThrow()
    expect(() =>
      trabajo({
        event_id: String(migrado?.event_id),
        ticket_id: newId(),
        printer_id: kitchen,
      }),
    ).not.toThrow()
  })

  it('los trabajos sin evento (pruebas) pueden repetirse: el índice único los ignora', () => {
    const { db, trabajo } = conCola()
    aplicarMigraciones(db, HASTA_7)
    expect(() => {
      trabajo({ type: 'test' })
      trabajo({ type: 'test' })
      trabajo({ type: 'preBill' })
      trabajo({ type: 'preBill' })
    }).not.toThrow()
  })

  it('el índice de pendientes sigue sirviendo a la cola (restaurante, estado, creado_en)', () => {
    const { db } = conCola()
    aplicarMigraciones(db, HASTA_7)
    const columns = db
      .prepare("SELECT name FROM pragma_index_info('print_jobs_pending') ORDER BY seqno")
      .all()
      .map((c) => c.name)
    expect(columns).toEqual(['restaurant_id', 'status', 'created_at'])
  })

  it('una precuenta sin evento ni comanda se guarda y se consulta como pendiente', () => {
    const { db, trabajo } = conCola()
    aplicarMigraciones(db, HASTA_7)
    const id = trabajo({
      type: 'preBill',
      event_id: newId(),
      ticket_id: null,
      content: '{"table":"5"}',
    })
    expect(db.prepare('SELECT type, status FROM print_jobs WHERE id = ?').get(id)).toEqual({
      type: 'preBill',
      status: 'pending',
    })
    const pendingList = db
      .prepare("SELECT count(*) AS n FROM print_jobs WHERE status = 'pending'")
      .get()
    expect(pendingList).toEqual({ n: 3 })
  })
})

describe('migración 7: casos de borde', () => {
  it('con la cola vacía también aplica', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db, HASTA_6)
    sembrar(db)
    expect(aplicarMigraciones(db, HASTA_7)).toEqual([7])
    expect(rows(db)).toEqual([])
  })

  it('desde una base nueva se aplican las siete en orden', () => {
    const db = abrirBase(':memory:')
    expect(aplicarMigraciones(db, HASTA_7)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(versionActual(db)).toBe(7)
  })

  it('repetir la migración no hace nada y no toca los trabajos', () => {
    const { db } = conCola()
    aplicarMigraciones(db, HASTA_7)
    const before = rows(db)
    expect(aplicarMigraciones(db, HASTA_7)).toEqual([])
    expect(rows(db)).toEqual(before)
  })

  it('si hay una referencia rota, la migración falla entera: la base sigue en la 6 con su cola', () => {
    const { db, trabajo } = conCola()
    // Un trabajo con una impresora que no existe (se coló con las claves apagadas).
    db.exec('PRAGMA foreign_keys = OFF')
    trabajo({ printer_id: newId() })
    db.exec('PRAGMA foreign_keys = ON')
    const before = rows(db)
    expect(() => aplicarMigraciones(db, HASTA_7)).toThrow(/referencias rotas/)
    expect(versionActual(db)).toBe(6)
    expect(rows(db)).toEqual(before)
    // No quedó ninguna tabla a medias y la tabla vieja sigue aceptando comandas.
    const names = db
      .prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'print_jobs%'")
      .all()
      .map((o) => o.name)
    expect(names).not.toContain('print_jobs_new')
    expect(names).not.toContain('card_terminals')
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  it('un trabajo con un tipo que la 6 no conoce sigue sin poder entrar', () => {
    const { db, trabajo } = conCola()
    expect(() => trabajo({ type: 'preBill' })).toThrow()
    expect(() => trabajo({ type: 'receipt' })).toThrow()
    aplicarMigraciones(db, HASTA_7)
    expect(() => trabajo({ type: 'receipt' })).toThrow()
  })
})

describe('migración 7: datafono', () => {
  function migrada() {
    const base = baseVersion6()
    aplicarMigraciones(base.db, HASTA_7)
    const cardTerminal = (fields: Record<string, string | number | null> = {}) =>
      insertarVersionado(base.db, 'card_terminals', base.restaurant, {
        name: 'Bold 1',
        provider: 'bold',
        ...fields,
      })
    return { ...base, cardTerminal }
  }

  it.each(['bold', 'redeban', 'credibanco', 'other'])('acepta el proveedor %s', (provider) => {
    const { cardTerminal } = migrada()
    expect(() => cardTerminal({ provider })).not.toThrow()
  })

  it.each(['visa', '', 'BOLD', null])('rechaza el proveedor %s', (provider) => {
    const { cardTerminal } = migrada()
    expect(() => cardTerminal({ provider })).toThrow()
  })

  it('el nombre va de 1 a 60 caracteres', () => {
    const { cardTerminal } = migrada()
    expect(() => cardTerminal({ name: 'x' })).not.toThrow()
    expect(() => cardTerminal({ name: 'x'.repeat(60) })).not.toThrow()
    expect(() => cardTerminal({ name: 'x'.repeat(61) })).toThrow()
    expect(() => cardTerminal({ name: '' })).toThrow()
    expect(() => cardTerminal({ name: null })).toThrow()
  })

  it('nace activo, y activo solo vale 0 o 1', () => {
    const { db, cardTerminal } = migrada()
    const id = cardTerminal()
    expect(db.prepare('SELECT active FROM card_terminals WHERE id = ?').get(id)).toEqual({
      active: 1,
    })
    expect(() => cardTerminal({ active: 2 })).toThrow()
    expect(() => cardTerminal({ active: -1 })).toThrow()
  })

  it('se archiva con activo = 0 y se vuelve a usar; no se borra', () => {
    const { db, cardTerminal } = migrada()
    const id = cardTerminal()
    db.prepare('UPDATE card_terminals SET active = 0, version = version + 1 WHERE id = ?').run(id)
    expect(db.prepare('SELECT active, version FROM card_terminals WHERE id = ?').get(id)).toEqual({
      active: 0,
      version: 2,
    })
    db.prepare('UPDATE card_terminals SET active = 1, version = version + 1 WHERE id = ?').run(id)
    expect(db.prepare('SELECT active FROM card_terminals WHERE id = ?').get(id)).toEqual({
      active: 1,
    })
    expect(() => db.prepare('DELETE FROM card_terminals WHERE id = ?').run(id)).toThrow(
      /se archiva/,
    )
  })

  it('exige un restaurante que exista y un ULID de 26 caracteres', () => {
    const { db, cardTerminal } = migrada()
    expect(() =>
      insertarVersionado(db, 'card_terminals', newId(), { name: 'Huérfano', provider: 'bold' }),
    ).toThrow(/FOREIGN KEY/)
    expect(() =>
      insertarVersionado(
        db,
        'card_terminals',
        String(db.prepare('SELECT id FROM restaurants').get()?.id),
        { name: 'Corto', provider: 'bold' },
        'corto',
      ),
    ).toThrow()
    expect(() => cardTerminal()).not.toThrow()
  })

  it('la versión no puede ser negativa y el índice por versión sirve a la sincronización', () => {
    const { db, cardTerminal } = migrada()
    expect(() => cardTerminal({ version: -1 })).toThrow()
    const columns = db
      .prepare("SELECT name FROM pragma_index_info('card_terminals_by_version') ORDER BY seqno")
      .all()
      .map((c) => c.name)
    expect(columns).toEqual(['restaurant_id', 'version'])
  })

  it('cada restaurante tiene los suyos: dos pueden llamar igual a su datáfono', () => {
    const { db, cardTerminal } = migrada()
    const other = newId()
    insertarVersionado(db, 'restaurants', other, { name: 'Otro', config: '{}' }, other)
    cardTerminal()
    expect(() =>
      insertarVersionado(db, 'card_terminals', other, { name: 'Bold 1', provider: 'bold' }),
    ).not.toThrow()
    expect(
      db.prepare('SELECT count(*) AS n FROM card_terminals WHERE restaurant_id = ?').get(other),
    ).toEqual({ n: 1 })
  })
})
