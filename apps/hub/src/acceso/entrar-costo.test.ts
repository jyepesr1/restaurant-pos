import { beforeEach, describe, expect, it, vi } from 'vitest'

// Tiempos parecidos entre «el usuario no existe» y «la contraseña está mal», sin medir relojes: se
// mira cuánto trabajo de scrypt (el parámetro N) hace el hub en cada caso. Si el trabajo es
// distinto, el tiempo lo es y se puede adivinar quién existe.

const calls: number[] = []
vi.mock('node:crypto', async (importar) => {
  const real = await importar<typeof import('node:crypto')>()
  return {
    ...real,
    scryptSync: (...args: Parameters<typeof real.scryptSync>) => {
      calls.push(Number((args[3] as { N: number }).N))
      return real.scryptSync(...args)
    },
  }
})

const { applyMigrations } = await import('@pos/db')
const { openDatabase } = await import('@pos/db/node')
const { asegurarRestaurante, asegurarRoles } = await import('./inicial')
const { ServicioAcceso } = await import('./servicio')
const { COSTO_CONTRASENA } = await import('./secretos')

function hub() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const now = '2026-10-24T20:00:00.000Z'
  const restaurantId = asegurarRestaurante(db, now)
  const roles = asegurarRoles(db, restaurantId, now)
  // El costo real de producción: así se ve la diferencia que habría en una instalación.
  const access = new ServicioAcceso({
    db,
    restaurantId,
    key: Buffer.alloc(32, 9),
    clock: () => now,
  })
  access.crearUsuario({
    name: 'Caja',
    rolId: roles.cashier,
    user: 'caja',
    password: 'clave-de-la-caja',
  })
  // Calienta el relleno (se calcula en el primer intento con un usuario que no existe).
  access.entrar({ user: 'calentar', password: 'no-importa-xx' }, null, '10.9.0.1')
  calls.length = 0
  return access
}

/** El trabajo de scrypt que hizo un intento fallido (cada intento, desde una IP nueva). */
let n = 0
function trabajoDe(access: ReturnType<typeof hub>, user: string, password: string) {
  calls.length = 0
  const r = access.entrar({ user, password }, null, `10.0.0.${++n}`)
  expect(r).toMatchObject({ ok: false, code: 'invalid_credentials' })
  return [...calls]
}

describe('el costo de comprobar una contraseña no delata si el usuario existe', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('un usuario real con la contraseña errada hace un scrypt de costo completo', () => {
    const access = hub()
    expect(trabajoDe(access, 'caja', 'no-es-la-clave')).toEqual([2 ** COSTO_CONTRASENA])
  })

  // Antes era un BUG: el relleno se calculaba con costo 1 y delataba qué usuarios existen.
  it('un usuario inexistente hace el mismo trabajo de scrypt que uno real', () => {
    const access = hub()
    const real = trabajoDe(access, 'caja', 'no-es-la-clave')
    const nonexistent = trabajoDe(access, 'fantasma', 'no-es-la-clave')
    expect(nonexistent).toEqual(real)
  })

  it('un usuario con formato inválido, o archivado, tampoco hace menos trabajo', () => {
    const access = hub()
    const real = trabajoDe(access, 'caja', 'no-es-la-clave')
    expect(trabajoDe(access, 'con espacio', 'no-es-la-clave')).toEqual(real)
    expect(trabajoDe(access, '', '')).toEqual(real)
    const vieja = access.crearUsuario({
      name: 'Vieja',
      // biome-ignore lint/suspicious/noExplicitAny: respuesta JSON de prueba, sin tipo
      rolId: (access as any).db.prepare("SELECT id FROM roles WHERE name = 'Cajero'").get().id,
      user: 'vieja',
      password: 'clave-de-la-vieja',
    })
    access.archivarUsuario(vieja.userId)
    expect(trabajoDe(access, 'vieja', 'clave-de-la-vieja')).toEqual(real)
  })

  it('en todos los casos se hace exactamente un scrypt por intento (nunca cero ni dos)', () => {
    const access = hub()
    for (const user of ['caja', 'fantasma', 'con espacio', '', 'x'.repeat(100)])
      expect(trabajoDe(access, user, 'no-es-la-clave')).toHaveLength(1)
  })

  it('la contraseña vacía, o larguísima, también hace un solo scrypt y falla', () => {
    const access = hub()
    expect(trabajoDe(access, 'caja', '')).toHaveLength(1)
    expect(trabajoDe(access, 'caja', 'z'.repeat(100_000))).toHaveLength(1)
  })

  it('durante la espera por fallos no se hace ningún scrypt: el atacante no gasta el CPU del hub', () => {
    const access = hub()
    for (let i = 0; i < 3; i++) trabajoDe(access, 'caja', `mala-${i}-xxxxxxx`)
    calls.length = 0
    for (let i = 0; i < 50; i++) {
      const r = access.entrar({ user: 'caja', password: 'otra-mala-xx' }, null, `10.9.9.${i}`)
      expect(r).toMatchObject({ ok: false, code: 'wait' })
    }
    expect(calls).toEqual([])
  })
})
