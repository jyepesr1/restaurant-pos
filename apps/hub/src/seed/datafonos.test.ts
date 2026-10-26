import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isValidId, newId } from '@pos/core'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from '../acceso/inicial'
import { actualizarVersionado, idEstable, insertVersioned } from '../acceso/registros'
import { ServicioAcceso } from '../acceso/servicio'
import { leerCarta } from './carta'
import { seed } from './sembrar'

// Los datáfonos del piloto (tarea 1.6): el seed crea «Bold 1» y «Bold 2» y después los respeta:
// lo que el administrador renombre, archive o agregue en «Caja y pagos» no se toca.

const TEXTO_CARTA = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const NOW = '2026-10-24T20:00:00.000Z'
const MAS_TARDE = '2026-10-25T09:30:00.000Z'

function hub() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurantId = asegurarRestaurante(db, NOW)
  const roles = asegurarRoles(db, restaurantId, NOW)
  const access = new ServicioAcceso({
    db,
    restaurantId,
    key: Buffer.alloc(32, 3),
    clock: () => NOW,
  })
  asegurarAdministrador(db, access, roles.admin, false)
  const load = (now = NOW, sinPersonal = true) =>
    seed(db, access, { restaurantId, roles, menu: leerCarta(TEXTO_CARTA), sinPersonal }, now)
  const cardTerminals = () =>
    db
      .prepare('SELECT * FROM card_terminals WHERE restaurant_id = ? ORDER BY name')
      .all(restaurantId)
  const admin = () => {
    const u = db.prepare("SELECT id FROM users WHERE name = 'Administrador'").get()
    return { userId: String(u?.id), deviceId: null }
  }
  return { db, restaurantId, load, cardTerminals, admin }
}

describe('el seed crea dos datáfonos Bold', () => {
  it('«Bold 1» y «Bold 2», proveedor bold, activos, del sistema y con id válido y estable', () => {
    const h = hub()
    h.load()
    const rows = h.cardTerminals()
    expect(rows.map((f) => [f.name, f.provider, f.active])).toEqual([
      ['Bold 1', 'bold', 1],
      ['Bold 2', 'bold', 1],
    ])
    for (const f of rows) {
      expect(isValidId(String(f.id))).toBe(true)
      expect(f.user_id).toBeNull()
      expect(f.device_id).toBeNull()
    }
    expect(rows.map((f) => f.id)).toEqual([
      idEstable(h.restaurantId, 'datafono:bold-1'),
      idEstable(h.restaurantId, 'datafono:bold-2'),
    ])
  })

  it('el resumen los cuenta como creados', () => {
    const r = hub().load()
    expect(r.sqlTables.card_terminals).toEqual({
      created: 2,
      updated: 0,
      equal: 0,
      respected: 0,
      archived: 0,
    })
  })

  it('con el personal de ejemplo también se crean (el seed completo)', () => {
    const h = hub()
    h.load(NOW, false)
    expect(h.cardTerminals()).toHaveLength(2)
  })

  it('cada datáfono sube la versión del catálogo: los equipos lo reciben con la carta', () => {
    const h = hub()
    h.load()
    const versiones = h.cardTerminals().map((f) => Number(f.version))
    expect(new Set(versiones).size).toBe(2)
    for (const v of versiones) expect(v).toBeGreaterThan(0)
    const counter = Number(
      h.db
        .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
        .get(h.restaurantId)?.value,
    )
    expect(counter).toBeGreaterThanOrEqual(Math.max(...versiones))
  })
})

describe('repetir el seed', () => {
  it('no duplica ni toca los datáfonos: mismos ids, versiones y fechas', () => {
    const h = hub()
    h.load()
    const before = h.cardTerminals()
    const r = h.load(MAS_TARDE)
    expect(h.cardTerminals()).toEqual(before)
    expect(r.sqlTables.card_terminals).toEqual({
      created: 0,
      updated: 0,
      equal: 0,
      respected: 2,
      archived: 0,
    })
    h.load('2027-01-01T00:00:00.000Z')
    expect(h.cardTerminals()).toEqual(before)
  })

  it('el administrador renombra uno: el seed no lo pisa', () => {
    const h = hub()
    h.load()
    const id = idEstable(h.restaurantId, 'datafono:bold-1')
    actualizarVersionado(
      h.db,
      'card_terminals',
      h.restaurantId,
      id,
      { name: 'Bold terraza', provider: 'redeban' },
      h.admin(),
      MAS_TARDE,
    )
    h.load(MAS_TARDE)
    h.load('2027-01-01T00:00:00.000Z')
    expect(h.cardTerminals().map((f) => [f.name, f.provider])).toEqual([
      ['Bold 2', 'bold'],
      ['Bold terraza', 'redeban'],
    ])
  })

  it('el administrador archiva uno: queda archivado, no vuelve ni se recrea', () => {
    const h = hub()
    h.load()
    const id = idEstable(h.restaurantId, 'datafono:bold-2')
    actualizarVersionado(
      h.db,
      'card_terminals',
      h.restaurantId,
      id,
      { active: 0 },
      h.admin(),
      MAS_TARDE,
    )
    h.load(MAS_TARDE)
    expect(h.cardTerminals().map((f) => [f.name, f.active])).toEqual([
      ['Bold 1', 1],
      ['Bold 2', 0],
    ])
    expect(h.cardTerminals()).toHaveLength(2)
  })

  it('uno archivado a mano y reactivado por el administrador sigue como lo dejó', () => {
    const h = hub()
    h.load()
    const id = idEstable(h.restaurantId, 'datafono:bold-1')
    actualizarVersionado(h.db, 'card_terminals', h.restaurantId, id, { active: 0 }, h.admin(), NOW)
    actualizarVersionado(h.db, 'card_terminals', h.restaurantId, id, { active: 1 }, h.admin(), NOW)
    const before = h.cardTerminals()
    h.load(MAS_TARDE)
    expect(h.cardTerminals()).toEqual(before)
  })

  it('un datáfono que agregó el administrador no se archiva aunque el seed no lo conozca', () => {
    const h = hub()
    h.load()
    const own = insertVersioned(
      h.db,
      'card_terminals',
      h.restaurantId,
      { name: 'Redeban barra', provider: 'redeban' },
      h.admin(),
      MAS_TARDE,
    )
    const r = h.load(MAS_TARDE)
    const row = h.cardTerminals().find((f) => f.id === own)
    expect(row).toMatchObject({ active: 1, name: 'Redeban barra' })
    expect(r.sqlTables.card_terminals?.archived ?? 0).toBe(0)
    expect(h.cardTerminals()).toHaveLength(3)
  })

  it('varias corridas no repiten «Bold 1»', () => {
    const h = hub()
    const before = h.load()
    expect(before.sqlTables.card_terminals?.created).toBe(2)
    h.load(MAS_TARDE)
    expect(h.cardTerminals().filter((f) => f.name === 'Bold 1')).toHaveLength(1)
  })
})

describe('varios restaurantes', () => {
  it('los datáfonos del seed son de cada restaurante, con ids distintos', () => {
    const a = hub()
    const b = hub()
    a.load()
    b.load()
    expect(a.cardTerminals().map((f) => f.id)).not.toEqual(b.cardTerminals().map((f) => f.id))
    for (const f of a.cardTerminals()) expect(f.restaurant_id).toBe(a.restaurantId)
  })

  it('en una base compartida, el seed de uno no crea datáfonos en el otro', () => {
    const db = openDatabase(':memory:')
    applyMigrations(db)
    const one = asegurarRestaurante(db, NOW)
    const other = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(other, other, NOW, NOW)
    db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)").run(
      other,
    )
    const roles = asegurarRoles(db, one, NOW)
    const access = new ServicioAcceso({
      db,
      restaurantId: one,
      key: Buffer.alloc(32, 3),
      clock: () => NOW,
    })
    seed(
      db,
      access,
      { restaurantId: one, roles, menu: leerCarta(TEXTO_CARTA), sinPersonal: true },
      NOW,
    )
    const check = (r: string) =>
      Number(
        db.prepare('SELECT count(*) AS n FROM card_terminals WHERE restaurant_id = ?').get(r)?.n,
      )
    expect(check(one)).toBe(2)
    expect(check(other)).toBe(0)
  })
})
