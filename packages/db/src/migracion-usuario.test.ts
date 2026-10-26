import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado, sembrar } from './pruebas/utiles'

// Migración 5 (tarea 1.3b, ADR-013): usuario y contraseña en la credencial del hub.

const HASTA_4 = MIGRACIONES.filter((m) => m.version <= 4)
const HASTA_5 = MIGRACIONES.filter((m) => m.version <= 5)

/** Una base de la versión 4 con una persona que ya tenía PIN. */
function baseVersion4() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_4)
  const { restaurant } = sembrar(db)
  const role = insertarVersionado(db, 'roles', restaurant, { name: 'Mesero' })
  const persona = (name: string, pin: string) => {
    const id = insertarVersionado(db, 'users', restaurant, { name, role_id: role })
    insertarEnTabla(db, 'user_credentials', {
      user_id: id,
      restaurant_id: restaurant,
      pin_hash: pin,
      pin_generated_at: AHORA,
    })
    return id
  }
  const ana = persona('Ana', 'huella-ana')
  return { db, restaurant, persona, ana }
}

const conUsuario = (
  db: ReturnType<typeof abrirBase>,
  id: string,
  user: string | null,
  fingerprint: string | null,
) =>
  db
    .prepare('UPDATE user_credentials SET username = ?, password_hash = ? WHERE user_id = ?')
    .run(user, fingerprint, id)

describe('migración 5: usuario y contraseña', () => {
  it('es la 5 y deja a quien tenía PIN sin usuario (sigue entrando con su PIN)', () => {
    const { db, ana } = baseVersion4()
    expect(MIGRACIONES.find((m) => m.version === 5)?.name).toBe('user_password')
    expect(aplicarMigraciones(db, HASTA_5)).toEqual([5])
    expect(versionActual(db)).toBe(5)
    expect(db.prepare('SELECT * FROM user_credentials WHERE user_id = ?').get(ana)).toMatchObject({
      pin_hash: 'huella-ana',
      username: null,
      password_hash: null,
    })
  })

  it('usuario y contraseña van juntos', () => {
    const { db, ana } = baseVersion4()
    aplicarMigraciones(db)
    expect(() => conUsuario(db, ana, 'ana', null)).toThrow(/van juntos/)
    expect(() => conUsuario(db, ana, null, 'scrypt$x')).toThrow(/van juntos/)
    expect(() => conUsuario(db, ana, 'ana', 'scrypt$x')).not.toThrow()
    expect(() => conUsuario(db, ana, null, null)).not.toThrow()
  })

  it.each(['Ana', 'an', 'a'.repeat(41)])('rechaza el usuario «%s» (mayúsculas o largo)', (u) => {
    const { db, ana } = baseVersion4()
    aplicarMigraciones(db)
    expect(() => conUsuario(db, ana, u, 'scrypt$x')).toThrow(/CHECK/)
  })

  it('el usuario es único entre los vigentes; archivado, queda libre', () => {
    const { db, ana, persona } = baseVersion4()
    aplicarMigraciones(db)
    const luis = persona('Luis', 'huella-luis')
    conUsuario(db, ana, 'caja', 'scrypt$a')
    expect(() => conUsuario(db, luis, 'caja', 'scrypt$b')).toThrow(/UNIQUE/)
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ana)
    expect(() => conUsuario(db, luis, 'caja', 'scrypt$b')).not.toThrow()
  })

  it('el mismo usuario puede existir en dos restaurantes', () => {
    const { db, ana } = baseVersion4()
    aplicarMigraciones(db)
    const other = sembrar(db).restaurant
    const role = insertarVersionado(db, 'roles', other, { name: 'Cajero' })
    const id = insertarVersionado(db, 'users', other, { name: 'Ana', role_id: role })
    insertarEnTabla(db, 'user_credentials', {
      user_id: id,
      restaurant_id: other,
      pin_hash: 'otra',
      pin_generated_at: AHORA,
      username: 'caja',
      password_hash: 'scrypt$c',
    })
    expect(() => conUsuario(db, ana, 'caja', 'scrypt$a')).not.toThrow()
  })
})
