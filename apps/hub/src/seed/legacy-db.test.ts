import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { ensureRestaurant, ensureRoles } from '../access/initial'
import { insertVersioned, SYSTEM, stableId } from '../access/records'
import { AccessService } from '../access/service'
import { readMenu } from './menu'
import { STAFF, seed } from './seed'

// Seed on a database from before ADR-013: «Caja» and «Reportes» already exist with only a PIN and
// must get a username and password without their PIN changing or being duplicated.

const MENU_TEXT = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const NOW = '2026-10-24T20:00:00.000Z'
const LATER = '2026-10-25T09:00:00.000Z'

function oldHub() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurantId = ensureRestaurant(db, NOW)
  const roles = ensureRoles(db, restaurantId, NOW)
  const access = new AccessService({
    db,
    restaurantId,
    key: Buffer.alloc(32, 3),
    clock: () => NOW,
    passwordCost: 1,
  })
  // What the old seed left: the same people, with the same IDs, PIN only.
  const oldEntries: Record<string, { userId: string; pin: string }> = {}
  for (const p of STAFF)
    oldEntries[p.key] = access.insertUser({
      id: stableId(restaurantId, `user:${p.key}`),
      name: p.name,
      roleId: roles[p.role],
    })
  const load = (now = LATER) =>
    seed(db, access, { restaurantId, roles, menu: readMenu(MENU_TEXT) }, now)
  return { db, restaurantId, roles, access, oldEntries, load }
}

describe('seed on an old database with «Caja» and «Reportes» without a password', () => {
  it('gives them username and password, without a new PIN and without duplicating people', () => {
    const h = oldHub()
    const pinsBefore = JSON.stringify(
      h.db.prepare('SELECT user_id, pin_hash FROM user_credentials ORDER BY user_id').all(),
    )
    const usersBefore = Number(h.db.prepare('SELECT count(*) AS n FROM users').get()?.n)
    const r = h.load()

    const withUser = r.pins.filter((p) => p.user)
    expect(withUser.map((p) => p.user).sort()).toEqual(['caja', 'reportes'])
    for (const p of withUser) {
      expect(p.pin).toBeNull()
      expect(p.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    }
    // Waiters get nothing new: they keep their old PIN.
    expect(r.pins.filter((p) => !p.user)).toEqual([])
    expect(Number(h.db.prepare('SELECT count(*) AS n FROM users').get()?.n)).toBe(usersBefore)
    expect(
      JSON.stringify(
        h.db.prepare('SELECT user_id, pin_hash FROM user_credentials ORDER BY user_id').all(),
      ),
    ).toBe(pinsBefore)
    // They sign in with the new credentials; the old PIN no longer opens a session (it only
    // authorizes).
    for (const p of withUser)
      expect(
        h.access.signIn(
          { user: p.user as string, password: p.password as string },
          null,
          '10.0.0.1',
        ),
      ).toMatchObject({ ok: true })
    expect(
      h.access.signIn({ pin: h.oldEntries.caja?.pin as string }, null, '10.0.0.2'),
    ).toMatchObject({
      ok: false,
    })
    expect(
      h.access.signIn({ pin: h.oldEntries['mesero-1']?.pin as string }, null, '10.0.0.3'),
    ).toMatchObject({ ok: true })
  })

  it('the second run no longer changes passwords: what was handed out once stays as is', () => {
    const h = oldHub()
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
    expect(h.access.signIn({ user: 'caja', password: key }, null, '10.0.0.4')).toMatchObject({
      ok: true,
    })
  })

  it('if the admin already gave «Caja» another username, the seed respects it', () => {
    const h = oldHub()
    h.access.assignPassword(
      h.oldEntries.caja?.userId as string,
      'caja.principal',
      'clave-puesta-por-admin',
    )
    const r = h.load()
    expect(r.pins.map((p) => p.user)).toEqual(['reportes'])
    expect(h.access.userOf(h.oldEntries.caja?.userId as string)).toBe('caja.principal')
  })

  // Found by qa-pruebas in 1.3b and already fixed: `seed` (seed.ts) set a username and password
  // on an archived person and showed them in the summary as if they worked; that account cannot
  // sign in. The expectation was that the seed does not announce a password for someone archived
  // (and does not revive them: that part already held).
  it('if «Caja» is archived, the seed does not make up a password for it', () => {
    const h = oldHub()
    h.access.archiveUser(h.oldEntries.caja?.userId as string)
    const r = h.load()
    expect(r.pins.map((p) => p.user)).not.toContain('caja')
    expect(
      h.db
        .prepare('SELECT active FROM users WHERE id = ?')
        .get(h.oldEntries.caja?.userId as string),
    ).toEqual({ active: 0 })
  })

  it('if someone else already uses «caja» as username, the whole seed fails and leaves nothing half done', () => {
    const h = oldHub()
    const another = insertVersioned(
      h.db,
      'users',
      h.restaurantId,
      { name: 'Otra', role_id: h.roles.cashier },
      SYSTEM,
      NOW,
    )
    h.db
      .prepare(
        'INSERT INTO user_credentials (user_id, restaurant_id, pin_hash, pin_generated_at) VALUES (?, ?, ?, ?)',
      )
      .run(another, h.restaurantId, 'huella-cualquiera', NOW)
    h.access.assignPassword(another, 'caja', 'clave-de-otra-caja')
    const products = () => Number(h.db.prepare('SELECT count(*) AS n FROM products').get()?.n)
    expect(() => h.load()).toThrow(/Ya hay alguien con el usuario/)
    expect(products()).toBe(0)
    expect(h.access.userOf(h.oldEntries.caja?.userId as string)).toBeNull()
  })
})
