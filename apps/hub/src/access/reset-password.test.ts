import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hubInDir } from './hub-setup'
import { KEY_FILE, loadKey } from './secrets'
import { AccessService } from './service'

// Hub restart and lost PIN key (ADR-008, ADR-013): passwords do not depend on the key; PINs do,
// and they are regenerated.

describe('passwords after restarting the hub or losing the PIN key', () => {
  let folder = ''
  let hubs: ReturnType<typeof hubInDir>
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pos-reinicio-clave-'))
    hubs = hubInDir(join(folder, 'data'))
  })
  afterEach(() => {
    hubs.shutDown()
    rmSync(folder, { recursive: true, force: true })
  })

  function withPeople() {
    const h = hubs.spinUp()
    const cashier = h.access.createUser({
      name: 'Carlos',
      roleId: h.roles.cashier,
      user: 'carlos',
      password: 'clave-de-carlos',
    })
    const reports = h.access.createUser({
      name: 'Rita',
      roleId: h.roles.reports,
      user: 'rita',
      password: 'clave-de-rita-1',
    })
    const ana = h.access.createUser({ name: 'Ana', roleId: h.roles.waiter })
    return { h, cashier, reports, ana }
  }

  const signInMethod = (h: ReturnType<typeof hubs.spinUp>, user: string, password: string, n = 1) =>
    h.access.signIn({ user, password }, null, `10.0.0.${n}`)

  it('with the key lost, everyone who signs in with a password still signs in (admin, cashier and reports)', () => {
    const { h } = withPeople()
    const admin = { user: h.admin.user as string, password: h.admin.password as string }
    hubs.shutDown()
    rmSync(join(folder, 'data', KEY_FILE))

    const d = hubs.spinUp()
    expect(d.newKey).toBe(true)
    expect(signInMethod(d, admin.user, admin.password, 1)).toMatchObject({ ok: true })
    expect(signInMethod(d, 'carlos', 'clave-de-carlos', 2)).toMatchObject({
      ok: true,
      user: { name: 'Carlos' },
    })
    expect(signInMethod(d, 'rita', 'clave-de-rita-1', 3)).toMatchObject({
      ok: true,
      user: { name: 'Rita' },
    })
    // The admin got a new PIN to authorize and was not given another password.
    expect(d.admin.pin).toMatch(/^\d{4}$/)
    expect(d.admin.password).toBeNull()
    expect(d.admin.alerts.join(' ')).toMatch(/clave de los PIN/)
  })

  it('with the key lost, the waiter PIN and the cashier authorize PIN stop working until regenerated', () => {
    const { h, cashier, ana } = withPeople()
    hubs.shutDown()
    rmSync(join(folder, 'data', KEY_FILE))
    const d = hubs.spinUp()
    expect(d.access.signIn({ pin: ana.pin }, null, '10.0.1.1')).toMatchObject({
      ok: false,
      code: 'wrong_pin',
    })

    // The admin regenerates Ana's (signs in) and the cashier's (authorizes).
    const pinAna = d.access.regeneratePin(ana.userId)
    const pinCarlos = d.access.regeneratePin(cashier.userId)
    const anaSession = d.access.signIn({ pin: pinAna }, null, '10.0.1.2')
    if (!anaSession.ok || !anaSession.device) throw new Error('Ana did not sign in')
    const connection = d.access.authenticate(anaSession.device.token) as never
    const oldOne = d.access.authorize(connection, {
      sessionId: anaSession.sessionId,
      secret: anaSession.secret,
      pin: cashier.pin,
      action: 'void_sent_item',
      aggregateId: '0'.repeat(26),
      eventId: '1'.repeat(26),
      fingerprint: 'a'.repeat(64),
    })
    if (cashier.pin !== pinCarlos) expect(oldOne).toMatchObject({ ok: false })
    const fresh = d.access.authorize(connection, {
      sessionId: anaSession.sessionId,
      secret: anaSession.secret,
      pin: pinCarlos,
      action: 'void_sent_item',
      aggregateId: '0'.repeat(26),
      eventId: '2'.repeat(26),
      fingerprint: 'b'.repeat(64),
    })
    expect(fresh).toMatchObject({ ok: true, supervisor: { name: 'Carlos' } })
    void h
  })

  it('the lost key changes nothing in the stored passwords: the fingerprints stay identical', () => {
    const { h } = withPeople()
    const hashes = () =>
      JSON.stringify(
        h.db
          .prepare('SELECT user_id, username, password_hash FROM user_credentials ORDER BY user_id')
          .all(),
      )
    const before = hashes()
    hubs.shutDown()
    rmSync(join(folder, 'data', KEY_FILE))
    const d = hubs.spinUp()
    expect(
      JSON.stringify(
        d.db
          .prepare('SELECT user_id, username, password_hash FROM user_credentials ORDER BY user_id')
          .all(),
      ),
    ).toBe(before)
  })

  it('restarting many times without losing the key: the passwords and the admin stay and no new one appears', () => {
    withPeople()
    for (let i = 0; i < 4; i++) {
      hubs.shutDown()
      const d = hubs.spinUp()
      expect(d.newKey).toBe(false)
      expect(d.admin).toEqual({ pin: null, user: null, password: null, alerts: [] })
      expect(signInMethod(d, 'carlos', 'clave-de-carlos', i + 1)).toMatchObject({ ok: true })
    }
    const d = hubs.spinUp()
    expect(
      Number(d.db.prepare("SELECT count(*) AS n FROM users WHERE name = 'Administrador'").get()?.n),
    ).toBe(1)
  })

  it('a password stored with one cost still works if the hub changes the cost for new ones', () => {
    const { h } = withPeople()
    const { key } = loadKey(join(folder, 'data'))
    const more_expensive = new AccessService({
      db: h.db,
      restaurantId: h.restaurantId,
      key,
      passwordCost: 6,
    })
    expect(
      more_expensive.signIn({ user: 'carlos', password: 'clave-de-carlos' }, null, '10.0.2.1'),
    ).toMatchObject({ ok: true })
    // New ones are stored with the new cost, and coexist with the old ones.
    const newOne = more_expensive.createUser({
      name: 'Nueva',
      roleId: h.roles.reports,
      user: 'nueva',
      password: 'clave-de-nueva-1',
    })
    expect(
      h.db
        .prepare('SELECT password_hash AS h FROM user_credentials WHERE user_id = ?')
        .get(newOne.userId)?.h,
    ).toMatch(/^scrypt\$6\$/)
    expect(
      more_expensive.signIn({ user: 'nueva', password: 'clave-de-nueva-1' }, null, '10.0.2.2'),
    ).toMatchObject({ ok: true })
    expect(
      h.access.signIn({ user: 'nueva', password: 'clave-de-nueva-1' }, null, '10.0.2.3'),
    ).toMatchObject({ ok: true })
  })

  it('password failures are forgotten on restart (the wait lives in memory): the alert to the admin is not', () => {
    const { h } = withPeople()
    for (let i = 0; i < 4; i++) signInMethod(h, 'carlos', `mala-clave-${i}`, i + 1)
    expect(signInMethod(h, 'carlos', 'clave-de-carlos', 9)).toMatchObject({
      ok: false,
      code: 'wait',
    })
    hubs.shutDown()
    const d = hubs.spinUp()
    expect(signInMethod(d, 'carlos', 'clave-de-carlos', 9)).toMatchObject({ ok: true })
  })
})
