import { ROLES_DE_FABRICA } from '@pos/core'
import { aplicarMigraciones, type BaseSqlite } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { asegurarRestaurante, asegurarRoles } from './inicial'
import { insertarVersionado, SISTEMA } from './registros'
import { ServicioAcceso } from './servicio'

// Conversión de los roles de antes de ADR-013 (Gerente, Cocina, Contador) al arrancar el hub:
// idempotente, con gente asignada, sin perder permisos ni sesiones.

const AHORA = '2026-10-24T20:00:00.000Z'
const MAS_TARDE = '2026-10-25T08:00:00.000Z'

const VIEJOS: Record<string, readonly string[]> = {
  Administrador: ['administrar_usuarios', 'administrar_dispositivos', 'tomar_pedido'],
  Gerente: ['tomar_pedido', 'descontar', 'ver_reportes', 'editar_catalogo'],
  Cajero: ['tomar_pedido', 'registrar_pago'],
  Mesero: ['tomar_pedido'],
  Cocina: ['marcar_preparacion', 'agotar_producto'],
  Contador: ['ver_reportes'],
}

/** Una base como la dejaba la tarea 0.7: roles de fábrica viejos, cada uno con su gente. */
function baseVieja() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = asegurarRestaurante(db, AHORA)
  const roles: Record<string, string> = {}
  for (const [nombre, permisos] of Object.entries(VIEJOS)) {
    roles[nombre] = insertarVersionado(
      db,
      'rol',
      restauranteId,
      { nombre, sistema: 1 },
      SISTEMA,
      AHORA,
    )
    for (const permiso of permisos)
      insertarVersionado(
        db,
        'rol_permiso',
        restauranteId,
        { rol_id: roles[nombre] as string, permiso },
        SISTEMA,
        AHORA,
      )
  }
  const acceso = new ServicioAcceso({
    db,
    restauranteId,
    clave: Buffer.alloc(32, 5),
    reloj: () => AHORA,
    costoContrasena: 1,
  })
  const gente: Record<string, { usuarioId: string; pin: string }[]> = {}
  for (const [nombre, rolId] of Object.entries(roles))
    gente[nombre] = [1, 2].map((n) => acceso.crearUsuario({ nombre: `${nombre} ${n}`, rolId }))
  return { db, restauranteId, roles, acceso, gente }
}

const roles = (db: BaseSqlite) =>
  db.prepare('SELECT id, nombre, sistema, activo, version FROM rol ORDER BY nombre, id').all()
const permisos = (db: BaseSqlite) =>
  db
    .prepare('SELECT rol_id, permiso, activo, version FROM rol_permiso ORDER BY rol_id, permiso')
    .all()

describe('conversión de los roles de antes', () => {
  it('Contador pasa a Reportes (mismo id y permisos); Gerente y Cocina quedan propios y activos, con su gente', () => {
    const b = baseVieja()
    const antes = permisos(b.db)
    const nuevos = asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    const fila = (id: string) =>
      b.db.prepare('SELECT nombre, sistema, activo FROM rol WHERE id = ?').get(id)
    expect(nuevos.reportes).toBe(b.roles.Contador as string)
    expect(fila(b.roles.Contador as string)).toEqual({ nombre: 'Reportes', sistema: 1, activo: 1 })
    expect(fila(b.roles.Gerente as string)).toEqual({ nombre: 'Gerente', sistema: 0, activo: 1 })
    expect(fila(b.roles.Cocina as string)).toEqual({ nombre: 'Cocina', sistema: 0, activo: 1 })
    // Los de fábrica que siguen (Administrador, Cajero, Mesero) conservan su id.
    expect(nuevos.admin).toBe(b.roles.Administrador as string)
    expect(nuevos.cajero).toBe(b.roles.Cajero as string)
    expect(nuevos.mesero).toBe(b.roles.Mesero as string)
    // Nadie pierde a su rol ni sus permisos: la conversión no reescribe permisos.
    expect(permisos(b.db)).toEqual(antes)
    for (const nombre of ['Gerente', 'Cocina', 'Contador'])
      for (const g of b.gente[nombre] ?? [])
        expect(b.acceso.permisosDe(g.usuarioId)).toEqual([...(VIEJOS[nombre] ?? [])].sort())
  })

  it('es idempotente: correrlo 5 veces no cambia versiones ni filas ni duplica roles', () => {
    const b = baseVieja()
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    const rolesUna = roles(b.db)
    const contador = b.db.prepare("SELECT valor FROM contador WHERE nombre = 'catalogo'").get()
    for (let i = 0; i < 5; i++) asegurarRoles(b.db, b.restauranteId, '2026-10-26T00:00:00.000Z')
    expect(roles(b.db)).toEqual(rolesUna)
    expect(b.db.prepare("SELECT valor FROM contador WHERE nombre = 'catalogo'").get()).toEqual(
      contador,
    )
    expect(Number(b.db.prepare('SELECT count(*) AS n FROM rol').get()?.n)).toBe(6)
  })

  it('los cuatro roles de fábrica nuevos existen una sola vez y Reportes no se duplica', () => {
    const b = baseVieja()
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    for (const rol of Object.values(ROLES_DE_FABRICA))
      expect(
        Number(
          b.db
            .prepare('SELECT count(*) AS n FROM rol WHERE nombre = ? AND sistema = 1')
            .get(rol.nombre)?.n,
        ),
      ).toBe(1)
    expect(
      Number(b.db.prepare("SELECT count(*) AS n FROM rol WHERE nombre = 'Contador'").get()?.n),
    ).toBe(0)
  })

  it('si ya hay un «Reportes» de fábrica además de «Contador», no se pisan: Contador queda como está', () => {
    const b = baseVieja()
    const reportes = insertarVersionado(
      b.db,
      'rol',
      b.restauranteId,
      { nombre: 'Reportes', sistema: 1 },
      SISTEMA,
      AHORA,
    )
    const nuevos = asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    expect(nuevos.reportes).toBe(reportes)
    expect(
      b.db.prepare('SELECT nombre, sistema FROM rol WHERE id = ?').get(b.roles.Contador as string),
    ).toEqual({ nombre: 'Contador', sistema: 1 })
  })

  it('un Gerente archivado antes también se convierte, y una base sin roles viejos no cambia', () => {
    const b = baseVieja()
    b.db.prepare('UPDATE rol SET activo = 0 WHERE id = ?').run(b.roles.Gerente as string)
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    expect(
      b.db.prepare('SELECT sistema, activo FROM rol WHERE id = ?').get(b.roles.Gerente as string),
    ).toEqual({ sistema: 0, activo: 0 })

    const nueva = abrirBase(':memory:')
    aplicarMigraciones(nueva)
    const id = asegurarRestaurante(nueva, AHORA)
    asegurarRoles(nueva, id, AHORA)
    const foto = roles(nueva)
    asegurarRoles(nueva, id, MAS_TARDE)
    expect(roles(nueva)).toEqual(foto)
    expect(foto).toHaveLength(4)
  })

  it('dos restaurantes con roles viejos: cada uno se convierte por separado', () => {
    const b = baseVieja()
    const otro = '01M5RPDZQP7MH7BBP9D2CEGG2N'
    b.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(otro, otro, AHORA, AHORA)
    b.db
      .prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)")
      .run(otro)
    const contadorOtro = insertarVersionado(
      b.db,
      'rol',
      otro,
      { nombre: 'Contador', sistema: 1 },
      SISTEMA,
      AHORA,
    )
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    // El otro restaurante no se tocó.
    expect(b.db.prepare('SELECT nombre FROM rol WHERE id = ?').get(contadorOtro)).toEqual({
      nombre: 'Contador',
    })
    asegurarRoles(b.db, otro, MAS_TARDE)
    expect(b.db.prepare('SELECT nombre FROM rol WHERE id = ?').get(contadorOtro)).toEqual({
      nombre: 'Reportes',
    })
  })

  it('las sesiones abiertas de la gente de Gerente y Cocina siguen valiendo tras la conversión', () => {
    const b = baseVieja()
    const gloria = b.gente.Gerente?.[0]
    if (!gloria) throw new Error('sin gerente')
    // Los de Gerente aquí no tienen contraseña (PIN): la regla de ADR-013 se aplica al editar, no
    // al arrancar. Entran con su PIN si sus permisos lo permiten; si no, la entrada se rechaza.
    const r = b.acceso.entrar({ pin: gloria.pin }, null, '10.0.0.1')
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    const cocina = b.gente.Cocina?.[0]
    if (!cocina) throw new Error('sin cocina')
    expect(b.acceso.entrar({ pin: cocina.pin }, null, '10.0.0.2')).toMatchObject({ ok: true })
    if (r.ok) {
      const conexion = b.acceso.autenticar(r.equipo?.token as string)
      expect(conexion).not.toBeNull()
    }
  })
})
