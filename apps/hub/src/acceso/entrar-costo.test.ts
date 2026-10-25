import { beforeEach, describe, expect, it, vi } from 'vitest'

// Tiempos parecidos entre «el usuario no existe» y «la contraseña está mal», sin medir relojes: se
// mira cuánto trabajo de scrypt (el parámetro N) hace el hub en cada caso. Si el trabajo es
// distinto, el tiempo lo es y se puede adivinar quién existe.

const llamadas: number[] = []
vi.mock('node:crypto', async (importar) => {
  const real = await importar<typeof import('node:crypto')>()
  return {
    ...real,
    scryptSync: (...args: Parameters<typeof real.scryptSync>) => {
      llamadas.push(Number((args[3] as { N: number }).N))
      return real.scryptSync(...args)
    },
  }
})

const { aplicarMigraciones } = await import('@pos/db')
const { abrirBase } = await import('@pos/db/node')
const { asegurarRestaurante, asegurarRoles } = await import('./inicial')
const { ServicioAcceso } = await import('./servicio')
const { COSTO_CONTRASENA } = await import('./secretos')

function hub() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const ahora = '2026-10-24T20:00:00.000Z'
  const restauranteId = asegurarRestaurante(db, ahora)
  const roles = asegurarRoles(db, restauranteId, ahora)
  // El costo real de producción: así se ve la diferencia que habría en una instalación.
  const acceso = new ServicioAcceso({
    db,
    restauranteId,
    clave: Buffer.alloc(32, 9),
    reloj: () => ahora,
  })
  acceso.crearUsuario({
    nombre: 'Caja',
    rolId: roles.cajero,
    usuario: 'caja',
    contrasena: 'clave-de-la-caja',
  })
  // Calienta el relleno (se calcula en el primer intento con un usuario que no existe).
  acceso.entrar({ usuario: 'calentar', contrasena: 'no-importa-xx' }, null, '10.9.0.1')
  llamadas.length = 0
  return acceso
}

/** El trabajo de scrypt que hizo un intento fallido (cada intento, desde una IP nueva). */
let n = 0
function trabajoDe(acceso: ReturnType<typeof hub>, usuario: string, contrasena: string) {
  llamadas.length = 0
  const r = acceso.entrar({ usuario, contrasena }, null, `10.0.0.${++n}`)
  expect(r).toMatchObject({ ok: false, codigo: 'credenciales_incorrectas' })
  return [...llamadas]
}

describe('el costo de comprobar una contraseña no delata si el usuario existe', () => {
  beforeEach(() => {
    llamadas.length = 0
  })

  it('un usuario real con la contraseña errada hace un scrypt de costo completo', () => {
    const acceso = hub()
    expect(trabajoDe(acceso, 'caja', 'no-es-la-clave')).toEqual([2 ** COSTO_CONTRASENA])
  })

  // Antes era un BUG: el relleno se calculaba con costo 1 y delataba qué usuarios existen.
  it('un usuario inexistente hace el mismo trabajo de scrypt que uno real', () => {
    const acceso = hub()
    const real = trabajoDe(acceso, 'caja', 'no-es-la-clave')
    const inexistente = trabajoDe(acceso, 'fantasma', 'no-es-la-clave')
    expect(inexistente).toEqual(real)
  })

  it('un usuario con formato inválido, o archivado, tampoco hace menos trabajo', () => {
    const acceso = hub()
    const real = trabajoDe(acceso, 'caja', 'no-es-la-clave')
    expect(trabajoDe(acceso, 'con espacio', 'no-es-la-clave')).toEqual(real)
    expect(trabajoDe(acceso, '', '')).toEqual(real)
    const vieja = acceso.crearUsuario({
      nombre: 'Vieja',
      // biome-ignore lint/suspicious/noExplicitAny: respuesta JSON de prueba, sin tipo
      rolId: (acceso as any).db.prepare("SELECT id FROM rol WHERE nombre = 'Cajero'").get().id,
      usuario: 'vieja',
      contrasena: 'clave-de-la-vieja',
    })
    acceso.archivarUsuario(vieja.usuarioId)
    expect(trabajoDe(acceso, 'vieja', 'clave-de-la-vieja')).toEqual(real)
  })

  it('en todos los casos se hace exactamente un scrypt por intento (nunca cero ni dos)', () => {
    const acceso = hub()
    for (const usuario of ['caja', 'fantasma', 'con espacio', '', 'x'.repeat(100)])
      expect(trabajoDe(acceso, usuario, 'no-es-la-clave')).toHaveLength(1)
  })

  it('la contraseña vacía, o larguísima, también hace un solo scrypt y falla', () => {
    const acceso = hub()
    expect(trabajoDe(acceso, 'caja', '')).toHaveLength(1)
    expect(trabajoDe(acceso, 'caja', 'z'.repeat(100_000))).toHaveLength(1)
  })

  it('durante la espera por fallos no se hace ningún scrypt: el atacante no gasta el CPU del hub', () => {
    const acceso = hub()
    for (let i = 0; i < 3; i++) trabajoDe(acceso, 'caja', `mala-${i}-xxxxxxx`)
    llamadas.length = 0
    for (let i = 0; i < 50; i++) {
      const r = acceso.entrar({ usuario: 'caja', contrasena: 'otra-mala-xx' }, null, `10.9.9.${i}`)
      expect(r).toMatchObject({ ok: false, codigo: 'espera' })
    }
    expect(llamadas).toEqual([])
  })
})
