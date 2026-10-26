import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { esIdValido, nuevoId } from '@pos/core'
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
  const acceso = new ServicioAcceso({
    db,
    restauranteId,
    clave: Buffer.alloc(32, 3),
    reloj: () => AHORA,
  })
  asegurarAdministrador(db, acceso, roles.admin, false)
  const cargar = (ahora = AHORA, sinPersonal = true) =>
    sembrar(db, acceso, { restauranteId, roles, carta: leerCarta(TEXTO_CARTA), sinPersonal }, ahora)
  const datafonos = () =>
    db.prepare('SELECT * FROM datafono WHERE restaurante_id = ? ORDER BY nombre').all(restauranteId)
  const admin = () => {
    const u = db.prepare("SELECT id FROM usuario WHERE nombre = 'Administrador'").get()
    return { usuarioId: String(u?.id), dispositivoId: null }
  }
  return { db, restauranteId, cargar, datafonos, admin }
}

describe('el seed crea dos datáfonos Bold', () => {
  it('«Bold 1» y «Bold 2», proveedor bold, activos, del sistema y con id válido y estable', () => {
    const h = hub()
    h.cargar()
    const filas = h.datafonos()
    expect(filas.map((f) => [f.nombre, f.proveedor, f.activo])).toEqual([
      ['Bold 1', 'bold', 1],
      ['Bold 2', 'bold', 1],
    ])
    for (const f of filas) {
      expect(esIdValido(String(f.id))).toBe(true)
      expect(f.usuario_id).toBeNull()
      expect(f.dispositivo_id).toBeNull()
    }
    expect(filas.map((f) => f.id)).toEqual([
      idEstable(h.restauranteId, 'datafono:bold-1'),
      idEstable(h.restauranteId, 'datafono:bold-2'),
    ])
  })

  it('el resumen los cuenta como creados', () => {
    const r = hub().cargar()
    expect(r.tablas.datafono).toEqual({
      creado: 2,
      actualizado: 0,
      igual: 0,
      respetado: 0,
      archivado: 0,
    })
  })

  it('con el personal de ejemplo también se crean (el seed completo)', () => {
    const h = hub()
    h.cargar(AHORA, false)
    expect(h.datafonos()).toHaveLength(2)
  })

  it('cada datáfono sube la versión del catálogo: los equipos lo reciben con la carta', () => {
    const h = hub()
    h.cargar()
    const versiones = h.datafonos().map((f) => Number(f.version))
    expect(new Set(versiones).size).toBe(2)
    for (const v of versiones) expect(v).toBeGreaterThan(0)
    const contador = Number(
      h.db
        .prepare("SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = 'catalogo'")
        .get(h.restauranteId)?.valor,
    )
    expect(contador).toBeGreaterThanOrEqual(Math.max(...versiones))
  })
})

describe('repetir el seed', () => {
  it('no duplica ni toca los datáfonos: mismos ids, versiones y fechas', () => {
    const h = hub()
    h.cargar()
    const antes = h.datafonos()
    const r = h.cargar(MAS_TARDE)
    expect(h.datafonos()).toEqual(antes)
    expect(r.tablas.datafono).toEqual({
      creado: 0,
      actualizado: 0,
      igual: 0,
      respetado: 2,
      archivado: 0,
    })
    h.cargar('2027-01-01T00:00:00.000Z')
    expect(h.datafonos()).toEqual(antes)
  })

  it('el administrador renombra uno: el seed no lo pisa', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'datafono:bold-1')
    actualizarVersionado(
      h.db,
      'datafono',
      h.restauranteId,
      id,
      { nombre: 'Bold terraza', proveedor: 'redeban' },
      h.admin(),
      MAS_TARDE,
    )
    h.cargar(MAS_TARDE)
    h.cargar('2027-01-01T00:00:00.000Z')
    expect(h.datafonos().map((f) => [f.nombre, f.proveedor])).toEqual([
      ['Bold 2', 'bold'],
      ['Bold terraza', 'redeban'],
    ])
  })

  it('el administrador archiva uno: queda archivado, no vuelve ni se recrea', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'datafono:bold-2')
    actualizarVersionado(h.db, 'datafono', h.restauranteId, id, { activo: 0 }, h.admin(), MAS_TARDE)
    h.cargar(MAS_TARDE)
    expect(h.datafonos().map((f) => [f.nombre, f.activo])).toEqual([
      ['Bold 1', 1],
      ['Bold 2', 0],
    ])
    expect(h.datafonos()).toHaveLength(2)
  })

  it('uno archivado a mano y reactivado por el administrador sigue como lo dejó', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'datafono:bold-1')
    actualizarVersionado(h.db, 'datafono', h.restauranteId, id, { activo: 0 }, h.admin(), AHORA)
    actualizarVersionado(h.db, 'datafono', h.restauranteId, id, { activo: 1 }, h.admin(), AHORA)
    const antes = h.datafonos()
    h.cargar(MAS_TARDE)
    expect(h.datafonos()).toEqual(antes)
  })

  it('un datáfono que agregó el administrador no se archiva aunque el seed no lo conozca', () => {
    const h = hub()
    h.cargar()
    const propio = insertarVersionado(
      h.db,
      'datafono',
      h.restauranteId,
      { nombre: 'Redeban barra', proveedor: 'redeban' },
      h.admin(),
      MAS_TARDE,
    )
    const r = h.cargar(MAS_TARDE)
    const fila = h.datafonos().find((f) => f.id === propio)
    expect(fila).toMatchObject({ activo: 1, nombre: 'Redeban barra' })
    expect(r.tablas.datafono?.archivado ?? 0).toBe(0)
    expect(h.datafonos()).toHaveLength(3)
  })

  it('varias corridas no repiten «Bold 1»', () => {
    const h = hub()
    const antes = h.cargar()
    expect(antes.tablas.datafono?.creado).toBe(2)
    h.cargar(MAS_TARDE)
    expect(h.datafonos().filter((f) => f.nombre === 'Bold 1')).toHaveLength(1)
  })
})

describe('varios restaurantes', () => {
  it('los datáfonos del seed son de cada restaurante, con ids distintos', () => {
    const a = hub()
    const b = hub()
    a.cargar()
    b.cargar()
    expect(a.datafonos().map((f) => f.id)).not.toEqual(b.datafonos().map((f) => f.id))
    for (const f of a.datafonos()) expect(f.restaurante_id).toBe(a.restauranteId)
  })

  it('en una base compartida, el seed de uno no crea datáfonos en el otro', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db)
    const uno = asegurarRestaurante(db, AHORA)
    const otro = nuevoId()
    db.prepare(
      `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(otro, otro, AHORA, AHORA)
    db.prepare(
      "INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)",
    ).run(otro)
    const roles = asegurarRoles(db, uno, AHORA)
    const acceso = new ServicioAcceso({
      db,
      restauranteId: uno,
      clave: Buffer.alloc(32, 3),
      reloj: () => AHORA,
    })
    sembrar(
      db,
      acceso,
      { restauranteId: uno, roles, carta: leerCarta(TEXTO_CARTA), sinPersonal: true },
      AHORA,
    )
    const cuenta = (r: string) =>
      Number(db.prepare('SELECT count(*) AS n FROM datafono WHERE restaurante_id = ?').get(r)?.n)
    expect(cuenta(uno)).toBe(2)
    expect(cuenta(otro)).toBe(0)
  })
})
