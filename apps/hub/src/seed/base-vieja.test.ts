import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { asegurarRestaurante, asegurarRoles } from '../acceso/inicial'
import { idEstable, insertarVersionado, SISTEMA } from '../acceso/registros'
import { ServicioAcceso } from '../acceso/servicio'
import { leerCarta } from './carta'
import { PERSONAL, sembrar } from './sembrar'

// Seed sobre una base de antes de ADR-013: «Caja» y «Reportes» ya existen con solo PIN y deben
// recibir usuario y contraseña sin que su PIN cambie ni se dupliquen.

const TEXTO_CARTA = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const AHORA = '2026-10-24T20:00:00.000Z'
const MAS_TARDE = '2026-10-25T09:00:00.000Z'

function hubViejo() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = asegurarRestaurante(db, AHORA)
  const roles = asegurarRoles(db, restauranteId, AHORA)
  const acceso = new ServicioAcceso({
    db,
    restauranteId,
    clave: Buffer.alloc(32, 3),
    reloj: () => AHORA,
    costoContrasena: 1,
  })
  // Lo que dejó el seed viejo: las mismas personas, con los mismos IDs, solo con PIN.
  const viejos: Record<string, { usuarioId: string; pin: string }> = {}
  for (const p of PERSONAL)
    viejos[p.clave] = acceso.insertarUsuario({
      id: idEstable(restauranteId, `usuario:${p.clave}`),
      nombre: p.nombre,
      rolId: roles[p.rol],
    })
  const cargar = (ahora = MAS_TARDE) =>
    sembrar(db, acceso, { restauranteId, roles, carta: leerCarta(TEXTO_CARTA) }, ahora)
  return { db, restauranteId, roles, acceso, viejos, cargar }
}

describe('seed sobre una base vieja con «Caja» y «Reportes» sin contraseña', () => {
  it('les da usuario y contraseña, sin PIN nuevo y sin duplicar personas', () => {
    const h = hubViejo()
    const pinsAntes = JSON.stringify(
      h.db
        .prepare('SELECT usuario_id, pin_huella FROM usuario_credencial ORDER BY usuario_id')
        .all(),
    )
    const usuariosAntes = Number(h.db.prepare('SELECT count(*) AS n FROM usuario').get()?.n)
    const r = h.cargar()

    const conUsuario = r.pines.filter((p) => p.usuario)
    expect(conUsuario.map((p) => p.usuario).sort()).toEqual(['caja', 'reportes'])
    for (const p of conUsuario) {
      expect(p.pin).toBeNull()
      expect(p.contrasena).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    }
    // Los meseros no reciben nada nuevo: siguen con su PIN de antes.
    expect(r.pines.filter((p) => !p.usuario)).toEqual([])
    expect(Number(h.db.prepare('SELECT count(*) AS n FROM usuario').get()?.n)).toBe(usuariosAntes)
    expect(
      JSON.stringify(
        h.db
          .prepare('SELECT usuario_id, pin_huella FROM usuario_credencial ORDER BY usuario_id')
          .all(),
      ),
    ).toBe(pinsAntes)
    // Entran con lo nuevo; el PIN de antes ya no abre sesión (solo autoriza).
    for (const p of conUsuario)
      expect(
        h.acceso.entrar(
          { usuario: p.usuario as string, contrasena: p.contrasena as string },
          null,
          '10.0.0.1',
        ),
      ).toMatchObject({ ok: true })
    expect(h.acceso.entrar({ pin: h.viejos.caja?.pin as string }, null, '10.0.0.2')).toMatchObject({
      ok: false,
    })
    expect(
      h.acceso.entrar({ pin: h.viejos['mesero-1']?.pin as string }, null, '10.0.0.3'),
    ).toMatchObject({ ok: true })
  })

  it('la segunda corrida ya no cambia contraseñas: lo entregado una vez queda como está', () => {
    const h = hubViejo()
    const primera = h.cargar()
    const clave = primera.pines.find((p) => p.usuario === 'caja')?.contrasena as string
    const huella = () =>
      h.db
        .prepare(
          "SELECT contrasena_huella AS h FROM usuario_credencial WHERE nombre_usuario = 'caja'",
        )
        .get()?.h
    const antes = huella()
    for (const hora of ['2026-10-26T00:00:00.000Z', '2026-10-27T00:00:00.000Z']) {
      expect(h.cargar(hora).pines).toEqual([])
    }
    expect(huella()).toBe(antes)
    expect(h.acceso.entrar({ usuario: 'caja', contrasena: clave }, null, '10.0.0.4')).toMatchObject(
      { ok: true },
    )
  })

  it('si el administrador ya le puso otro usuario a «Caja», el seed lo respeta', () => {
    const h = hubViejo()
    h.acceso.ponerContrasena(
      h.viejos.caja?.usuarioId as string,
      'caja.principal',
      'clave-puesta-por-admin',
    )
    const r = h.cargar()
    expect(r.pines.map((p) => p.usuario)).toEqual(['reportes'])
    expect(h.acceso.usuarioDe(h.viejos.caja?.usuarioId as string)).toBe('caja.principal')
  })

  // Lo encontró qa-pruebas en la 1.3b y ya está corregido: `sembrar` (sembrar.ts) le fija usuario y contraseña a una persona archivada y la
  // muestra en el resumen como si sirviera; esa cuenta no puede entrar. Esperaba que el seed no
  // anunciara una contraseña para quien está archivado (y no la revive: eso sí se cumple).
  it('si «Caja» está archivada, el seed no le inventa contraseña', () => {
    const h = hubViejo()
    h.acceso.archivarUsuario(h.viejos.caja?.usuarioId as string)
    const r = h.cargar()
    expect(r.pines.map((p) => p.usuario)).not.toContain('caja')
    expect(
      h.db
        .prepare('SELECT activo FROM usuario WHERE id = ?')
        .get(h.viejos.caja?.usuarioId as string),
    ).toEqual({ activo: 0 })
  })

  it('si otra persona ya usa «caja» como usuario, el seed falla entero y no deja nada a medias', () => {
    const h = hubViejo()
    const otra = insertarVersionado(
      h.db,
      'usuario',
      h.restauranteId,
      { nombre: 'Otra', rol_id: h.roles.cajero },
      SISTEMA,
      AHORA,
    )
    h.db
      .prepare(
        'INSERT INTO usuario_credencial (usuario_id, restaurante_id, pin_huella, pin_generado_en) VALUES (?, ?, ?, ?)',
      )
      .run(otra, h.restauranteId, 'huella-cualquiera', AHORA)
    h.acceso.ponerContrasena(otra, 'caja', 'clave-de-otra-caja')
    const productos = () => Number(h.db.prepare('SELECT count(*) AS n FROM producto').get()?.n)
    expect(() => h.cargar()).toThrow(/Ya hay alguien con el usuario/)
    expect(productos()).toBe(0)
    expect(h.acceso.usuarioDe(h.viejos.caja?.usuarioId as string)).toBeNull()
  })
})
