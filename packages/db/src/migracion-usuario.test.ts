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
  const { restaurante } = sembrar(db)
  const rol = insertarVersionado(db, 'rol', restaurante, { nombre: 'Mesero' })
  const persona = (nombre: string, pin: string) => {
    const id = insertarVersionado(db, 'usuario', restaurante, { nombre, rol_id: rol })
    insertarEnTabla(db, 'usuario_credencial', {
      usuario_id: id,
      restaurante_id: restaurante,
      pin_huella: pin,
      pin_generado_en: AHORA,
    })
    return id
  }
  const ana = persona('Ana', 'huella-ana')
  return { db, restaurante, persona, ana }
}

const conUsuario = (
  db: ReturnType<typeof abrirBase>,
  id: string,
  usuario: string | null,
  huella: string | null,
) =>
  db
    .prepare(
      'UPDATE usuario_credencial SET nombre_usuario = ?, contrasena_huella = ? WHERE usuario_id = ?',
    )
    .run(usuario, huella, id)

describe('migración 5: usuario y contraseña', () => {
  it('es la 5 y deja a quien tenía PIN sin usuario (sigue entrando con su PIN)', () => {
    const { db, ana } = baseVersion4()
    expect(MIGRACIONES.find((m) => m.version === 5)?.nombre).toBe('usuario_contrasena')
    expect(aplicarMigraciones(db, HASTA_5)).toEqual([5])
    expect(versionActual(db)).toBe(5)
    expect(
      db.prepare('SELECT * FROM usuario_credencial WHERE usuario_id = ?').get(ana),
    ).toMatchObject({ pin_huella: 'huella-ana', nombre_usuario: null, contrasena_huella: null })
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
    db.prepare('UPDATE usuario SET activo = 0 WHERE id = ?').run(ana)
    expect(() => conUsuario(db, luis, 'caja', 'scrypt$b')).not.toThrow()
  })

  it('el mismo usuario puede existir en dos restaurantes', () => {
    const { db, ana } = baseVersion4()
    aplicarMigraciones(db)
    const otro = sembrar(db).restaurante
    const rol = insertarVersionado(db, 'rol', otro, { nombre: 'Cajero' })
    const id = insertarVersionado(db, 'usuario', otro, { nombre: 'Ana', rol_id: rol })
    insertarEnTabla(db, 'usuario_credencial', {
      usuario_id: id,
      restaurante_id: otro,
      pin_huella: 'otra',
      pin_generado_en: AHORA,
      nombre_usuario: 'caja',
      contrasena_huella: 'scrypt$c',
    })
    expect(() => conUsuario(db, ana, 'caja', 'scrypt$a')).not.toThrow()
  })
})
