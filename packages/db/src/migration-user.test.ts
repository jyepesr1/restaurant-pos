import { describe, expect, it } from 'vitest'
import { applyMigrations, currentVersion } from './migrate'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './node'
import { insertIntoTable, insertVersioned, NOW, seed } from './testing/utils'

// Username and password in the hub credential (task 1.3b, ADR-013).

/** A migrated database with a person who only has a PIN. */
function migratedDatabase() {
  const db = openDatabase(':memory:')
  const applied = applyMigrations(db)
  const { restaurant } = seed(db)
  const role = insertVersioned(db, 'roles', restaurant, { name: 'Mesero' })
  const person = (name: string, pin: string) => {
    const id = insertVersioned(db, 'users', restaurant, { name, role_id: role })
    insertIntoTable(db, 'user_credentials', {
      user_id: id,
      restaurant_id: restaurant,
      pin_hash: pin,
      pin_generated_at: NOW,
    })
    return id
  }
  const ana = person('Ana', 'huella-ana')
  return { db, applied, restaurant, person, ana }
}

const withUser = (
  db: ReturnType<typeof openDatabase>,
  id: string,
  user: string | null,
  fingerprint: string | null,
) =>
  db
    .prepare('UPDATE user_credentials SET username = ?, password_hash = ? WHERE user_id = ?')
    .run(user, fingerprint, id)

describe('username and password', () => {
  it('someone with only a PIN has no username (still signs in with the PIN), also after re-running', () => {
    const { db, applied, ana } = migratedDatabase()
    expect(MIGRATIONS[0]?.name).toBe('initial')
    expect(applied).toEqual([1])
    expect(currentVersion(db)).toBe(1)
    const credential = () => db.prepare('SELECT * FROM user_credentials WHERE user_id = ?').get(ana)
    expect(credential()).toMatchObject({
      pin_hash: 'huella-ana',
      username: null,
      password_hash: null,
    })
    const before = credential()
    expect(applyMigrations(db)).toEqual([])
    expect(credential()).toEqual(before)
  })

  it('username and password go together', () => {
    const { db, ana } = migratedDatabase()
    expect(() => withUser(db, ana, 'ana', null)).toThrow(/van juntos/)
    expect(() => withUser(db, ana, null, 'scrypt$x')).toThrow(/van juntos/)
    expect(() => withUser(db, ana, 'ana', 'scrypt$x')).not.toThrow()
    expect(() => withUser(db, ana, null, null)).not.toThrow()
  })

  it.each(['Ana', 'an', 'a'.repeat(41)])('rejects the username «%s» (uppercase or length)', (u) => {
    const { db, ana } = migratedDatabase()
    expect(() => withUser(db, ana, u, 'scrypt$x')).toThrow(/CHECK/)
  })

  it('the username is unique among current users; once archived, it is free', () => {
    const { db, ana, person } = migratedDatabase()
    const luis = person('Luis', 'huella-luis')
    withUser(db, ana, 'caja', 'scrypt$a')
    expect(() => withUser(db, luis, 'caja', 'scrypt$b')).toThrow(/UNIQUE/)
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ana)
    expect(() => withUser(db, luis, 'caja', 'scrypt$b')).not.toThrow()
  })

  it('the same username can exist in two restaurants', () => {
    const { db, ana } = migratedDatabase()
    const other = seed(db).restaurant
    const role = insertVersioned(db, 'roles', other, { name: 'Cajero' })
    const id = insertVersioned(db, 'users', other, { name: 'Ana', role_id: role })
    insertIntoTable(db, 'user_credentials', {
      user_id: id,
      restaurant_id: other,
      pin_hash: 'otra',
      pin_generated_at: NOW,
      username: 'caja',
      password_hash: 'scrypt$c',
    })
    expect(() => withUser(db, ana, 'caja', 'scrypt$a')).not.toThrow()
  })
})
