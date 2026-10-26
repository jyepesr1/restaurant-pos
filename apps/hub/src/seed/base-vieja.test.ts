import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { asegurarRestaurante, asegurarRoles } from '../acceso/inicial'
import { idEstable, insertVersioned, SISTEMA } from '../acceso/registros'
import { ServicioAcceso } from '../acceso/servicio'
import { leerCarta } from './carta'
import { PERSONAL, seed } from './sembrar'

// Seed sobre una base de antes de ADR-013: «Caja» y «Reportes» ya existen con solo PIN y deben
// recibir usuario y contraseña sin que su PIN cambie ni se dupliquen.

const TEXTO_CARTA = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const NOW = '2026-10-24T20:00:00.000Z'
const MAS_TARDE = '2026-10-25T09:00:00.000Z'

function hubViejo() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurantId = asegurarRestaurante(db, NOW)
  const roles = asegurarRoles(db, restaurantId, NOW)
  const access = new ServicioAcceso({
    db,
    restaurantId,
    key: Buffer.alloc(32, 3),
    clock: () => NOW,
    costoContrasena: 1,
  })
  // Lo que dejó el seed viejo: las mismas personas, con los mismos IDs, solo con PIN.
  const oldEntries: Record<string, { userId: string; pin: string }> = {}
  for (const p of PERSONAL)
    oldEntries[p.key] = access.insertUser({
      id: idEstable(restaurantId, `usuario:${p.key}`),
      name: p.name,
      rolId: roles[p.role],
    })
  const load = (now = MAS_TARDE) =>
    seed(db, access, { restaurantId, roles, menu: leerCarta(TEXTO_CARTA) }, now)
  return { db, restaurantId, roles, access, oldEntries, load }
}

describe('seed sobre una base vieja con «Caja» y «Reportes» sin contraseña', () => {
  it('les da usuario y contraseña, sin PIN nuevo y sin duplicar personas', () => {
    const h = hubViejo()
    const pinsAntes = JSON.stringify(
      h.db.prepare('SELECT user_id, pin_hash FROM user_credentials ORDER BY user_id').all(),
    )
    const usuariosAntes = Number(h.db.prepare('SELECT count(*) AS n FROM users').get()?.n)
    const r = h.load()

    const withUser = r.pins.filter((p) => p.user)
    expect(withUser.map((p) => p.user).sort()).toEqual(['caja', 'reportes'])
    for (const p of withUser) {
      expect(p.pin).toBeNull()
      expect(p.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    }
    // Los meseros no reciben nada nuevo: siguen con su PIN de antes.
    expect(r.pins.filter((p) => !p.user)).toEqual([])
    expect(Number(h.db.prepare('SELECT count(*) AS n FROM users').get()?.n)).toBe(usuariosAntes)
    expect(
      JSON.stringify(
        h.db.prepare('SELECT user_id, pin_hash FROM user_credentials ORDER BY user_id').all(),
      ),
    ).toBe(pinsAntes)
    // Entran con lo nuevo; el PIN de antes ya no abre sesión (solo autoriza).
    for (const p of withUser)
      expect(
        h.access.entrar(
          { user: p.user as string, password: p.password as string },
          null,
          '10.0.0.1',
        ),
      ).toMatchObject({ ok: true })
    expect(
      h.access.entrar({ pin: h.oldEntries.caja?.pin as string }, null, '10.0.0.2'),
    ).toMatchObject({
      ok: false,
    })
    expect(
      h.access.entrar({ pin: h.oldEntries['mesero-1']?.pin as string }, null, '10.0.0.3'),
    ).toMatchObject({ ok: true })
  })

  it('la segunda corrida ya no cambia contraseñas: lo entregado una vez queda como está', () => {
    const h = hubViejo()
    const first = h.load()
    const key = first.pins.find((p) => p.user === 'caja')?.password as string
    const fingerprint = () =>
      h.db.prepare("SELECT password_hash AS h FROM user_credentials WHERE username = 'caja'").get()
        ?.h
    const before = fingerprint()
    for (const time of ['2026-10-26T00:00:00.000Z', '2026-10-27T00:00:00.000Z']) {
      expect(h.load(time).pins).toEqual([])
    }
    expect(fingerprint()).toBe(before)
    expect(h.access.entrar({ user: 'caja', password: key }, null, '10.0.0.4')).toMatchObject({
      ok: true,
    })
  })

  it('si el administrador ya le puso otro usuario a «Caja», el seed lo respeta', () => {
    const h = hubViejo()
    h.access.ponerContrasena(
      h.oldEntries.caja?.userId as string,
      'caja.principal',
      'clave-puesta-por-admin',
    )
    const r = h.load()
    expect(r.pins.map((p) => p.user)).toEqual(['reportes'])
    expect(h.access.usuarioDe(h.oldEntries.caja?.userId as string)).toBe('caja.principal')
  })

  // Lo encontró qa-pruebas en la 1.3b y ya está corregido: `sembrar` (sembrar.ts) le fija usuario y contraseña a una persona archivada y la
  // muestra en el resumen como si sirviera; esa cuenta no puede entrar. Esperaba que el seed no
  // anunciara una contraseña para quien está archivado (y no la revive: eso sí se cumple).
  it('si «Caja» está archivada, el seed no le inventa contraseña', () => {
    const h = hubViejo()
    h.access.archivarUsuario(h.oldEntries.caja?.userId as string)
    const r = h.load()
    expect(r.pins.map((p) => p.user)).not.toContain('caja')
    expect(
      h.db
        .prepare('SELECT active FROM users WHERE id = ?')
        .get(h.oldEntries.caja?.userId as string),
    ).toEqual({ active: 0 })
  })

  it('si otra persona ya usa «caja» como usuario, el seed falla entero y no deja nada a medias', () => {
    const h = hubViejo()
    const another = insertVersioned(
      h.db,
      'users',
      h.restaurantId,
      { name: 'Otra', role_id: h.roles.cashier },
      SISTEMA,
      NOW,
    )
    h.db
      .prepare(
        'INSERT INTO user_credentials (user_id, restaurant_id, pin_hash, pin_generated_at) VALUES (?, ?, ?, ?)',
      )
      .run(another, h.restaurantId, 'huella-cualquiera', NOW)
    h.access.ponerContrasena(another, 'caja', 'clave-de-otra-caja')
    const products = () => Number(h.db.prepare('SELECT count(*) AS n FROM products').get()?.n)
    expect(() => h.load()).toThrow(/Ya hay alguien con el usuario/)
    expect(products()).toBe(0)
    expect(h.access.usuarioDe(h.oldEntries.caja?.userId as string)).toBeNull()
  })
})
