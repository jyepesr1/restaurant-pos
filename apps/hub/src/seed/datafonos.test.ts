import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isValidId, newId } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from '../acceso/inicial'
import { actualizarVersionado, idEstable, insertarVersionado } from '../acceso/registros'
import { ServicioAcceso } from '../acceso/servicio'
import { leerCarta } from './carta'
import { sembrar } from './sembrar'

// Los datáfonos del piloto (tarea 1.6): el seed crea «Bold 1» y «Bold 2» y después los respeta:
// lo que el administrador renombre, archive o agregue en «Caja y pagos» no se toca.

const TEXTO_CARTA = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const AHORA = '2026-10-24T20:00:00.000Z'
const MAS_TARDE = '2026-10-25T09:30:00.000Z'

function hub() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = asegurarRestaurante(db, AHORA)
  const roles = asegurarRoles(db, restauranteId, AHORA)
  const access = new ServicioAcceso({
    db,
    restauranteId,
    key: Buffer.alloc(32, 3),
    clock: () => AHORA,
  })
  asegurarAdministrador(db, access, roles.admin, false)
  const cargar = (ahora = AHORA, sinPersonal = true) =>
    sembrar(db, access, { restauranteId, roles, menu: leerCarta(TEXTO_CARTA), sinPersonal }, ahora)
  const cardTerminals = () =>
    db
      .prepare('SELECT * FROM card_terminals WHERE restaurant_id = ? ORDER BY name')
      .all(restauranteId)
  const admin = () => {
    const u = db.prepare("SELECT id FROM users WHERE name = 'Administrador'").get()
    return { userId: String(u?.id), dispositivoId: null }
  }
  return { db, restauranteId, cargar, cardTerminals, admin }
}

describe('el seed crea dos datáfonos Bold', () => {
  it('«Bold 1» y «Bold 2», proveedor bold, activos, del sistema y con id válido y estable', () => {
    const h = hub()
    h.cargar()
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
      idEstable(h.restauranteId, 'datafono:bold-1'),
      idEstable(h.restauranteId, 'datafono:bold-2'),
    ])
  })

  it('el resumen los cuenta como creados', () => {
    const r = hub().cargar()
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
    h.cargar(AHORA, false)
    expect(h.cardTerminals()).toHaveLength(2)
  })

  it('cada datáfono sube la versión del catálogo: los equipos lo reciben con la carta', () => {
    const h = hub()
    h.cargar()
    const versiones = h.cardTerminals().map((f) => Number(f.version))
    expect(new Set(versiones).size).toBe(2)
    for (const v of versiones) expect(v).toBeGreaterThan(0)
    const counter = Number(
      h.db
        .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
        .get(h.restauranteId)?.value,
    )
    expect(counter).toBeGreaterThanOrEqual(Math.max(...versiones))
  })
})

describe('repetir el seed', () => {
  it('no duplica ni toca los datáfonos: mismos ids, versiones y fechas', () => {
    const h = hub()
    h.cargar()
    const before = h.cardTerminals()
    const r = h.cargar(MAS_TARDE)
    expect(h.cardTerminals()).toEqual(before)
    expect(r.sqlTables.card_terminals).toEqual({
      created: 0,
      updated: 0,
      equal: 0,
      respected: 2,
      archived: 0,
    })
    h.cargar('2027-01-01T00:00:00.000Z')
    expect(h.cardTerminals()).toEqual(before)
  })

  it('el administrador renombra uno: el seed no lo pisa', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'datafono:bold-1')
    actualizarVersionado(
      h.db,
      'card_terminals',
      h.restauranteId,
      id,
      { name: 'Bold terraza', provider: 'redeban' },
      h.admin(),
      MAS_TARDE,
    )
    h.cargar(MAS_TARDE)
    h.cargar('2027-01-01T00:00:00.000Z')
    expect(h.cardTerminals().map((f) => [f.name, f.provider])).toEqual([
      ['Bold 2', 'bold'],
      ['Bold terraza', 'redeban'],
    ])
  })

  it('el administrador archiva uno: queda archivado, no vuelve ni se recrea', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'datafono:bold-2')
    actualizarVersionado(
      h.db,
      'card_terminals',
      h.restauranteId,
      id,
      { active: 0 },
      h.admin(),
      MAS_TARDE,
    )
    h.cargar(MAS_TARDE)
    expect(h.cardTerminals().map((f) => [f.name, f.active])).toEqual([
      ['Bold 1', 1],
      ['Bold 2', 0],
    ])
    expect(h.cardTerminals()).toHaveLength(2)
  })

  it('uno archivado a mano y reactivado por el administrador sigue como lo dejó', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'datafono:bold-1')
    actualizarVersionado(
      h.db,
      'card_terminals',
      h.restauranteId,
      id,
      { active: 0 },
      h.admin(),
      AHORA,
    )
    actualizarVersionado(
      h.db,
      'card_terminals',
      h.restauranteId,
      id,
      { active: 1 },
      h.admin(),
      AHORA,
    )
    const before = h.cardTerminals()
    h.cargar(MAS_TARDE)
    expect(h.cardTerminals()).toEqual(before)
  })

  it('un datáfono que agregó el administrador no se archiva aunque el seed no lo conozca', () => {
    const h = hub()
    h.cargar()
    const own = insertarVersionado(
      h.db,
      'card_terminals',
      h.restauranteId,
      { name: 'Redeban barra', provider: 'redeban' },
      h.admin(),
      MAS_TARDE,
    )
    const r = h.cargar(MAS_TARDE)
    const row = h.cardTerminals().find((f) => f.id === own)
    expect(row).toMatchObject({ active: 1, name: 'Redeban barra' })
    expect(r.sqlTables.card_terminals?.archived ?? 0).toBe(0)
    expect(h.cardTerminals()).toHaveLength(3)
  })

  it('varias corridas no repiten «Bold 1»', () => {
    const h = hub()
    const before = h.cargar()
    expect(before.sqlTables.card_terminals?.created).toBe(2)
    h.cargar(MAS_TARDE)
    expect(h.cardTerminals().filter((f) => f.name === 'Bold 1')).toHaveLength(1)
  })
})

describe('varios restaurantes', () => {
  it('los datáfonos del seed son de cada restaurante, con ids distintos', () => {
    const a = hub()
    const b = hub()
    a.cargar()
    b.cargar()
    expect(a.cardTerminals().map((f) => f.id)).not.toEqual(b.cardTerminals().map((f) => f.id))
    for (const f of a.cardTerminals()) expect(f.restaurant_id).toBe(a.restauranteId)
  })

  it('en una base compartida, el seed de uno no crea datáfonos en el otro', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db)
    const one = asegurarRestaurante(db, AHORA)
    const other = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(other, other, AHORA, AHORA)
    db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)").run(
      other,
    )
    const roles = asegurarRoles(db, one, AHORA)
    const access = new ServicioAcceso({
      db,
      restauranteId: one,
      key: Buffer.alloc(32, 3),
      clock: () => AHORA,
    })
    sembrar(
      db,
      access,
      { restauranteId: one, roles, menu: leerCarta(TEXTO_CARTA), sinPersonal: true },
      AHORA,
    )
    const check = (r: string) =>
      Number(
        db.prepare('SELECT count(*) AS n FROM card_terminals WHERE restaurant_id = ?').get(r)?.n,
      )
    expect(check(one)).toBe(2)
    expect(check(other)).toBe(0)
  })
})
