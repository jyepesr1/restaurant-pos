import { beforeEach, describe, expect, it, vi } from 'vitest'

// Similar timing between «the user does not exist» and «the password is wrong», without measuring
// clocks: it checks how much scrypt work (the N parameter) the hub does in each case. If the work
// differs, so does the time, and one can guess who exists.

const calls: number[] = []
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>()
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
const { ensureRestaurant, ensureRoles } = await import('./initial')
const { AccessService } = await import('./service')
const { PASSWORD_COST } = await import('./secrets')

function hub() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const now = '2026-10-24T20:00:00.000Z'
  const restaurantId = ensureRestaurant(db, now)
  const roles = ensureRoles(db, restaurantId, now)
  // The real production cost: this shows the difference an installation would have.
  const access = new AccessService({
    db,
    restaurantId,
    key: Buffer.alloc(32, 9),
    clock: () => now,
  })
  access.createUser({
    name: 'Caja',
    roleId: roles.cashier,
    user: 'caja',
    password: 'clave-de-la-caja',
  })
  // Warms up the dummy hash (computed on the first attempt with a user that does not exist).
  access.signIn({ user: 'calentar', password: 'no-importa-xx' }, null, '10.9.0.1')
  calls.length = 0
  return access
}

/** The scrypt work done by a failed attempt (each attempt from a new IP). */
let n = 0
function workOf(access: ReturnType<typeof hub>, user: string, password: string) {
  calls.length = 0
  const r = access.signIn({ user, password }, null, `10.0.0.${++n}`)
  expect(r).toMatchObject({ ok: false, code: 'invalid_credentials' })
  return [...calls]
}

describe('the cost of checking a password does not reveal whether the user exists', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('a real user with the wrong password runs a full-cost scrypt', () => {
    const access = hub()
    expect(workOf(access, 'caja', 'no-es-la-clave')).toEqual([2 ** PASSWORD_COST])
  })

  // This used to be a BUG: the dummy hash used cost 1 and revealed which users exist.
  it('a nonexistent user does the same scrypt work as a real one', () => {
    const access = hub()
    const real = workOf(access, 'caja', 'no-es-la-clave')
    const nonexistent = workOf(access, 'fantasma', 'no-es-la-clave')
    expect(nonexistent).toEqual(real)
  })

  it('a malformed or archived user does not do less work either', () => {
    const access = hub()
    const real = workOf(access, 'caja', 'no-es-la-clave')
    expect(workOf(access, 'con espacio', 'no-es-la-clave')).toEqual(real)
    expect(workOf(access, '', '')).toEqual(real)
    const old = access.createUser({
      name: 'Vieja',
      // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON response
      roleId: (access as any).db.prepare("SELECT id FROM roles WHERE name = 'Cajero'").get().id,
      user: 'vieja',
      password: 'clave-de-la-vieja',
    })
    access.archiveUser(old.userId)
    expect(workOf(access, 'vieja', 'clave-de-la-vieja')).toEqual(real)
  })

  it('every case runs exactly one scrypt per attempt (never zero or two)', () => {
    const access = hub()
    for (const user of ['caja', 'fantasma', 'con espacio', '', 'x'.repeat(100)])
      expect(workOf(access, user, 'no-es-la-clave')).toHaveLength(1)
  })

  it('an empty or very long password also runs a single scrypt and fails', () => {
    const access = hub()
    expect(workOf(access, 'caja', '')).toHaveLength(1)
    expect(workOf(access, 'caja', 'z'.repeat(100_000))).toHaveLength(1)
  })

  it("no scrypt runs during the failure wait: the attacker does not burn the hub's CPU", () => {
    const access = hub()
    for (let i = 0; i < 3; i++) workOf(access, 'caja', `mala-${i}-xxxxxxx`)
    calls.length = 0
    for (let i = 0; i < 50; i++) {
      const r = access.signIn({ user: 'caja', password: 'otra-mala-xx' }, null, `10.9.9.${i}`)
      expect(r).toMatchObject({ ok: false, code: 'wait' })
    }
    expect(calls).toEqual([])
  })
})
