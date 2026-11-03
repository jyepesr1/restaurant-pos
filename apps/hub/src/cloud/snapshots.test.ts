import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PERMISSIONS } from '@pos/core'
import { fingerprint } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { setupAccess } from '../access/setup'
import { saveRole, saveStaffMember } from '../access/staff'
import { readCatalog } from '../catalog'
import { configOf } from '../reports/z-report'
import { CloudConnection } from './connection'
import { saveLink } from './link'
import {
  MAX_RETRY_AFTER_MS,
  readAccepted,
  readSnapshots,
  retryAfterMs,
  SNAPSHOT_KINDS,
  SNAPSHOTS_FILE,
  type SnapshotKind,
  type Snapshots,
  SnapshotUploader,
  type SnapshotUploaderOptions,
} from './snapshots'
import { fakeCloud, jsonResponse, manualTimers } from './testing'

// The snapshots for the owner's panel (task 1.11c, docs/PANEL.md#instantáneas): what each one
// carries, and that each goes up only when it changes, against a fake cloud that fails on command.

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-snapshots-'))
  folders.push(dir)
  return dir
}

const HUB = '01JBHUB0000000000000000000'
const ADMIN = { userId: null, deviceId: null }
const NOW = '2026-10-29T15:00:00.000Z'

describe('what each snapshot carries', () => {
  it('catalog and config are what the devices and the reports use', () => {
    const m = setupAccess()
    const s = readSnapshots(m.db, m.restaurantId)
    expect(s.catalog).toEqual(readCatalog(m.db, m.restaurantId))
    // The pre-bill header fields only go up when they say something (see the logo tests below).
    const {
      pre_bill_header: _header,
      print_logo: _logo,
      ...config
    } = configOf({
      db: m.db,
      restaurantId: m.restaurantId,
    })
    expect(s.config).toEqual({ config, time_zone: 'America/Bogota' })
  })

  describe('the pre-bill header in the config snapshot', () => {
    const logo = { width: 16, height: 2, data: Buffer.alloc(4, 0xa5).toString('base64') }
    const saveConfig = (m: ReturnType<typeof setupAccess>, config: object) =>
      m.db
        .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
        .run(JSON.stringify(config), m.restaurantId)
    const uploaded = (m: ReturnType<typeof setupAccess>) =>
      (readSnapshots(m.db, m.restaurantId).config as { config: Record<string, unknown> }).config

    it('a restaurant without a logo uploads neither field (a cloud that does not know them accepts it)', () => {
      const m = setupAccess()
      expect(uploaded(m)).not.toHaveProperty('pre_bill_header')
      expect(uploaded(m)).not.toHaveProperty('print_logo')
      saveConfig(m, { pre_bill_header: 'name', print_logo: null })
      expect(uploaded(m)).not.toHaveProperty('pre_bill_header')
      expect(uploaded(m)).not.toHaveProperty('print_logo')
    })

    it('with the logo chosen it uploads both, exactly as saved', () => {
      const m = setupAccess()
      saveConfig(m, { pre_bill_header: 'logo', print_logo: logo })
      expect(uploaded(m)).toMatchObject({ pre_bill_header: 'logo', print_logo: logo })
    })

    it('a saved logo with «name» uploads the logo but not the header', () => {
      const m = setupAccess()
      saveConfig(m, { pre_bill_header: 'name', print_logo: logo })
      expect(uploaded(m)).toMatchObject({ print_logo: logo })
      expect(uploaded(m)).not.toHaveProperty('pre_bill_header')
    })

    it('the rest of the config is the same as before', () => {
      const m = setupAccess()
      const {
        pre_bill_header: _h,
        print_logo: _l,
        ...rest
      } = configOf({
        db: m.db,
        restaurantId: m.restaurantId,
      })
      saveConfig(m, { pre_bill_header: 'logo', print_logo: logo })
      expect(uploaded(m)).toEqual({ ...rest, pre_bill_header: 'logo', print_logo: logo })
    })
  })

  it('people: everyone, archived too, with their role and nothing secret', () => {
    const m = setupAccess()
    saveStaffMember(
      m.db,
      m.restaurantId,
      m.access,
      { id: m.people.waiter2.userId, name: 'Luis', roleId: m.roles.waiter, active: false },
      ADMIN,
      NOW,
    )
    const people = readSnapshots(m.db, m.restaurantId).people as Record<string, unknown>[]
    expect(people).toContainEqual({
      id: m.people.waiter2.userId,
      name: 'Luis',
      role_id: m.roles.waiter,
      active: false,
    })
    expect(people).toContainEqual({
      id: m.people.admin.userId,
      name: 'Administrador',
      role_id: m.roles.admin,
      active: true,
    })
    for (const p of people)
      expect(Object.keys(p).sort()).toEqual(['active', 'id', 'name', 'role_id'])
  })

  it('roles: each with its active permissions', () => {
    const m = setupAccess()
    const roles = readSnapshots(m.db, m.restaurantId).roles as {
      id: string
      permissions: string[]
    }[]
    const admin = roles.find((r) => r.id === m.roles.admin)
    expect(admin).toEqual({
      id: m.roles.admin,
      name: 'Administrador',
      active: true,
      permissions: PERMISSIONS.filter((p) => p !== 'view_own_reports').sort(),
    })
    expect(roles.find((r) => r.id === m.roles.kitchen)?.permissions).toEqual([
      'mark_preparation',
      'mark_product_sold_out',
    ])
  })

  it('remote_users: only active people with a password whose role has remote_access, with the stored hash', () => {
    const m = setupAccess()
    const users = readSnapshots(m.db, m.restaurantId).remote_users as {
      user_id: string
      username: string
      name: string
      verifier: string
      permissions: string[]
    }[]
    // Administrador and Gloria (Gerente, a custom role with everything but staff and devices).
    // Not Carlos (cashier, without remote_access) nor the waiters (PIN only).
    expect(users.map((u) => u.username).sort()).toEqual(['admin', 'gloria'])
    const stored = m.db
      .prepare('SELECT password_hash FROM user_credentials WHERE user_id = ?')
      .get(m.people.manager.userId)?.password_hash
    const gloria = users.find((u) => u.username === 'gloria')
    expect(gloria).toEqual({
      user_id: m.people.manager.userId,
      username: 'gloria',
      name: 'Gloria',
      verifier: stored,
      permissions: expect.arrayContaining(['remote_access', 'view_reports']),
    })
    expect(gloria?.verifier).toMatch(/^scrypt\$\d+\$8\$1\$[\w-]+\$[\w-]+$/)
  })

  it('remote_users follows the changes: permission removed, person archived, password changed', () => {
    const m = setupAccess()
    const usernames = () =>
      (readSnapshots(m.db, m.restaurantId).remote_users as { username: string }[])
        .map((u) => u.username)
        .sort()
    const verifierOf = (username: string) =>
      (
        readSnapshots(m.db, m.restaurantId).remote_users as {
          username: string
          verifier: string
        }[]
      ).find((u) => u.username === username)?.verifier
    const before = verifierOf('admin')
    m.access.assignPassword(m.people.admin.userId, 'admin', 'otra-clave-del-admin')
    expect(verifierOf('admin')).not.toBe(before)

    const managerPermissions = PERMISSIONS.filter(
      (p) => !['manage_users', 'manage_devices', 'view_own_reports', 'remote_access'].includes(p),
    )
    saveRole(
      m.db,
      m.restaurantId,
      m.access,
      { id: m.roles.manager, name: 'Gerente', permissions: managerPermissions },
      ADMIN,
      NOW,
    )
    expect(usernames()).toEqual(['admin'])

    // Given to the cashier's role: Carlos can enter now; archived, he cannot.
    const cashier = readSnapshots(m.db, m.restaurantId).roles as {
      id: string
      permissions: string[]
    }[]
    const cashierPermissions = cashier.find((r) => r.id === m.roles.cashier)?.permissions ?? []
    saveRole(
      m.db,
      m.restaurantId,
      m.access,
      {
        id: m.roles.cashier,
        name: 'Cajero',
        permissions: [...cashierPermissions, 'remote_access'],
      },
      ADMIN,
      NOW,
    )
    expect(usernames()).toEqual(['admin', 'carlos'])
    saveStaffMember(
      m.db,
      m.restaurantId,
      m.access,
      { id: m.people.cashier.userId, name: 'Carlos', roleId: m.roles.cashier, active: false },
      ADMIN,
      NOW,
    )
    expect(usernames()).toEqual(['admin'])
  })

  it('the same data gives the same fingerprint', () => {
    const m = setupAccess()
    const a = readSnapshots(m.db, m.restaurantId)
    const b = readSnapshots(m.db, m.restaurantId)
    for (const kind of SNAPSHOT_KINDS) expect(fingerprint(a[kind])).toBe(fingerprint(b[kind]))
  })
})

/** Snapshots made by hand: the test changes them at will. */
function contents(): Snapshots {
  return {
    catalog: { version: 1, products: ['Spritz'] },
    config: { config: { business_day_start: '06:00' }, time_zone: 'America/Bogota' },
    people: [{ id: 'U1', name: 'Ana', role_id: 'R1', active: true }],
    roles: [{ id: 'R1', name: 'Administrador', permissions: ['remote_access'], active: true }],
    remote_users: [
      {
        user_id: 'U1',
        username: 'ana',
        name: 'Ana',
        verifier: 'scrypt$32768$8$1$SAL-SECRETA$HUELLA-SECRETA',
        permissions: ['remote_access'],
      },
    ],
  }
}

function setup(options: Partial<SnapshotUploaderOptions> = {}) {
  const cloud = fakeCloud()
  const dir = folder()
  const data = { current: contents() }
  const failures: unknown[] = []
  const clock = { ms: 1_000_000 }
  const state = { credential: cloud.credential as string | null, hubId: HUB, builds: 0 }
  const make = () =>
    new SnapshotUploader({
      url: 'https://cloud.faro.test',
      credential: () => state.credential,
      hubId: () => state.hubId,
      build: () => {
        state.builds += 1
        return data.current
      },
      dataDir: dir,
      onFailure: (e) => failures.push(e),
      fetch: cloud.fetch,
      now: () => clock.ms,
      ...options,
    })
  const uploader = make()
  const check = async (force = true, u = uploader) => {
    u.check({ force })
    await u.idle()
  }
  const putKinds = () => cloud.puts().map((c) => c.route.replace('/v1/snapshots/', ''))
  const change = (kind: SnapshotKind, value: unknown) => {
    data.current = { ...data.current, [kind]: value }
  }
  return { cloud, dir, data, failures, clock, state, uploader, make, check, putKinds, change }
}

describe('uploading the snapshots', () => {
  it('the first time, all five go up with the credential, each with its fingerprint', async () => {
    const h = setup()
    await h.check()
    expect(h.putKinds()).toEqual([...SNAPSHOT_KINDS])
    for (const c of h.cloud.puts()) expect(c.authorization).toBe(`Bearer ${h.cloud.credential}`)
    for (const kind of SNAPSHOT_KINDS)
      expect(h.cloud.snapshots.get(kind)).toEqual({
        fingerprint: fingerprint(h.data.current[kind]),
        content: h.data.current[kind],
      })
    expect(readAccepted(h.dir, HUB)).toEqual(
      Object.fromEntries(SNAPSHOT_KINDS.map((k) => [k, fingerprint(h.data.current[k])])),
    )
    expect(h.failures).toEqual([])
  })

  it('nothing changed: nothing goes up, also after restarting the hub', async () => {
    const h = setup()
    await h.check()
    await h.check()
    expect(h.cloud.puts()).toHaveLength(5)
    await h.check(true, h.make())
    expect(h.cloud.puts()).toHaveLength(5)
  })

  it('only what changed goes up', async () => {
    const h = setup()
    await h.check()
    h.change('roles', [{ id: 'R1', name: 'Dueña', permissions: ['remote_access'], active: true }])
    await h.check()
    expect(h.putKinds().slice(5)).toEqual(['roles'])
    // The order of the keys does not change the fingerprint.
    h.change('config', { time_zone: 'America/Bogota', config: { business_day_start: '06:00' } })
    await h.check()
    expect(h.putKinds().slice(5)).toEqual(['roles'])
  })

  it('a new registration (another hub id) gets everything again', async () => {
    const h = setup()
    await h.check()
    h.state.hubId = '01JBHUB0000000000000000001'
    await h.check()
    expect(h.cloud.puts()).toHaveLength(10)
  })

  it('a damaged file only means uploading everything again', async () => {
    const h = setup()
    await h.check()
    writeFileSync(join(h.dir, SNAPSHOTS_FILE), '{ roto')
    await h.check()
    expect(h.cloud.puts()).toHaveLength(10)
    expect(JSON.parse(readFileSync(join(h.dir, SNAPSHOTS_FILE), 'utf8')).hub_id).toBe(HUB)
  })

  it('without a credential (not connected or revoked) it does nothing, not even build them', async () => {
    const h = setup()
    h.state.credential = null
    await h.check()
    expect(h.cloud.calls).toHaveLength(0)
    expect(h.state.builds).toBe(0)
  })

  it('remote_users goes up first: it is the one that takes access away', async () => {
    const h = setup()
    await h.check()
    expect(h.putKinds()[0]).toBe('remote_users')
  })

  it('one kind without an answer does not hold back the others; it waits and is tried again', async () => {
    const h = setup({ retryDelaysMs: [5000, 15_000] })
    // remote_users goes up, roles finds no internet, the rest go up.
    h.cloud.plan.push(() => undefined, new TypeError('no internet'))
    await h.check()
    expect(h.putKinds()).toEqual(['remote_users', 'roles', 'people', 'config', 'catalog'])
    expect(h.cloud.snapshots.has('roles')).toBe(false)
    expect(h.cloud.snapshots.size).toBe(4)
    expect(h.failures).toEqual([])
    // Before its wait, neither a routine nor a forced check sends it again.
    h.clock.ms += 4999
    await h.check(false)
    await h.check(true)
    expect(h.cloud.puts()).toHaveLength(5)
    h.clock.ms += 1
    await h.check(false)
    expect(h.putKinds().slice(5)).toEqual(['roles'])
    expect(h.cloud.snapshots.size).toBe(5)
  })

  it('a server error or «wait» from the cloud: the wait grows with each failure in a row', async () => {
    for (const status of [500, 503, 408, 429]) {
      const h = setup({ retryDelaysMs: [5000, 15_000] })
      const fail = () =>
        h.cloud.plan.push((call) =>
          call.route.endsWith('/catalog') ? jsonResponse({ error: 'x' }, status) : undefined,
        )
      for (let i = 0; i < 5; i++) fail()
      await h.check()
      expect(h.cloud.snapshots.size, String(status)).toBe(4)
      const catalogPuts = () => h.putKinds().filter((k) => k === 'catalog').length
      expect(catalogPuts()).toBe(1)
      h.clock.ms += 5000
      fail()
      await h.check()
      expect(catalogPuts()).toBe(2)
      // Second failure in a row: 15 s now, and the last wait repeats.
      h.clock.ms += 14_999
      await h.check()
      expect(catalogPuts()).toBe(2)
      h.clock.ms += 1
      await h.check()
      expect(catalogPuts()).toBe(3)
      expect(h.cloud.snapshots.has('catalog'), String(status)).toBe(true)
      expect(h.failures).toEqual([])
      h.cloud.plan.length = 0
    }
  })

  it('respects Retry-After when it asks for more than its own wait', async () => {
    const h = setup({ retryDelaysMs: [5000] })
    h.cloud.plan.push(new Response(null, { status: 503, headers: { 'retry-after': '120' } }))
    await h.check()
    expect(h.cloud.snapshots.has('remote_users')).toBe(false)
    h.clock.ms += 119_999
    await h.check()
    expect(h.cloud.snapshots.has('remote_users')).toBe(false)
    h.clock.ms += 1
    await h.check()
    expect(h.cloud.snapshots.has('remote_users')).toBe(true)
  })

  it('reads Retry-After in seconds or as a date, and caps it', () => {
    const now = Date.parse('2026-10-29T15:00:00.000Z')
    expect(retryAfterMs(null, now)).toBeNull()
    expect(retryAfterMs('', now)).toBeNull()
    expect(retryAfterMs('30', now)).toBe(30_000)
    expect(retryAfterMs('Thu, 29 Oct 2026 15:01:00 GMT', now)).toBe(60_000)
    expect(retryAfterMs('Thu, 29 Oct 2026 14:00:00 GMT', now)).toBe(0)
    expect(retryAfterMs('999999', now)).toBe(MAX_RETRY_AFTER_MS)
    expect(retryAfterMs('pronto', now)).toBeNull()
  })

  it('401: it stops there and does not log anything (the upload already says «revoked»)', async () => {
    const h = setup()
    h.cloud.plan.push(jsonResponse({ error: 'invalid_credential' }, 401))
    await h.check()
    expect(h.putKinds()).toEqual(['remote_users'])
    expect(h.failures).toEqual([])
  })

  it('413 or 400: logged without the content, and not sent again until it changes', async () => {
    for (const status of [413, 400]) {
      const h = setup()
      let refuse = true
      const original = h.cloud.fetch
      const u = new SnapshotUploader({
        url: 'https://cloud.faro.test',
        credential: () => h.cloud.credential,
        hubId: () => HUB,
        build: () => h.data.current,
        dataDir: h.dir,
        onFailure: (e) => h.failures.push(e),
        fetch: async (input, init) =>
          refuse && String(input).endsWith('/remote_users')
            ? jsonResponse({ error: 'x' }, status)
            : original(input, init),
      })
      await h.check(true, u)
      expect(h.failures).toHaveLength(1)
      const message = String(h.failures[0])
      expect(message).toContain('remote_users')
      expect(message).toContain(String(status))
      expect(message).not.toContain('SECRETA')
      expect(message).not.toContain('ana')
      // The others went up; this one is not sent again nor logged again.
      expect(h.cloud.snapshots.has('roles')).toBe(true)
      expect(h.cloud.snapshots.has('remote_users')).toBe(false)
      await h.check(true, u)
      expect(h.failures).toHaveLength(1)
      // Once it changes, it is tried again.
      refuse = false
      h.change('remote_users', [])
      await h.check(true, u)
      expect(h.cloud.snapshots.get('remote_users')?.content).toEqual([])
    }
  })

  it('a cloud that does not know the route yet (404) is asked again after a while, logged once', async () => {
    const h = setup({ refusedRetryMs: 60_000 })
    const answer404 = () => jsonResponse({ error: 'not_found' }, 404)
    for (let i = 0; i < 5; i++) h.cloud.plan.push(answer404())
    await h.check()
    expect(h.putKinds()).toHaveLength(5)
    expect(h.failures).toHaveLength(5)
    await h.check()
    expect(h.putKinds()).toHaveLength(5)
    h.clock.ms += 60_000
    await h.check()
    expect(h.putKinds()).toHaveLength(10)
    expect(h.cloud.snapshots.size).toBe(5)
    expect(h.failures).toHaveLength(5)
  })

  it('too big: not even sent, and logged', async () => {
    const h = setup({ maxBytes: 300 })
    h.change('catalog', { products: 'x'.repeat(400) })
    await h.check()
    expect(h.putKinds()).not.toContain('catalog')
    expect(h.putKinds()).toHaveLength(4)
    expect(String(h.failures[0])).toContain('catalog')
  })

  it('a routine check builds them at most every 30 s; a forced one, always', async () => {
    const h = setup()
    await h.check(false)
    expect(h.state.builds).toBe(1)
    await h.check(false)
    h.clock.ms += 29_000
    await h.check(false)
    expect(h.state.builds).toBe(1)
    await h.check(true)
    expect(h.state.builds).toBe(2)
    h.clock.ms += 30_000
    await h.check(false)
    expect(h.state.builds).toBe(3)
  })

  it('never two at the same time: checks asked meanwhile become a single one after it', async () => {
    const h = setup()
    for (let i = 0; i < 5; i++) h.uploader.check({ force: true })
    await h.uploader.idle()
    expect(h.cloud.state.maxInFlight).toBe(1)
    expect(h.state.builds).toBe(2)
    expect(h.cloud.puts()).toHaveLength(5)
  })

  it('a failure building them goes to the log and does not take anything down', async () => {
    const h = setup()
    const u = new SnapshotUploader({
      url: 'https://cloud.faro.test',
      credential: () => h.cloud.credential,
      hubId: () => HUB,
      build: () => {
        throw new Error('database is locked')
      },
      dataDir: h.dir,
      onFailure: (e) => h.failures.push(e),
      fetch: h.cloud.fetch,
    })
    await h.check(true, u)
    expect(h.failures.map(String)).toEqual(['Error: database is locked'])
    expect(h.cloud.calls).toHaveLength(0)
  })

  it('stopped, it does not upload anymore', async () => {
    const h = setup()
    h.uploader.stop()
    await h.check()
    expect(h.cloud.calls).toHaveLength(0)
  })
})

describe('with the cloud connection', () => {
  function connected(options: { registered?: boolean } = {}) {
    const m = setupAccess()
    const cloud = fakeCloud()
    const dir = folder()
    if (options.registered ?? true)
      saveLink(dir, { hubId: HUB, credential: cloud.credential, registeredAt: NOW })
    const failures: unknown[] = []
    const t = manualTimers()
    const connection = new CloudConnection({
      db: m.db,
      restaurantId: m.restaurantId,
      dataDir: dir,
      instance: 'instancia-de-prueba',
      url: 'https://cloud.faro.test',
      fetch: cloud.fetch,
      onFailure: (e) => failures.push(e),
      uploader: { timers: t.timers },
      snapshots: () => readSnapshots(m.db, m.restaurantId),
    })
    const settle = async () => {
      await connection.uploader.idle()
      await connection.idle()
    }
    return { m, cloud, dir, failures, t, connection, settle }
  }

  it('once the upload is up to date, the snapshots go up', async () => {
    const h = connected()
    h.connection.uploader.wake()
    await h.settle()
    expect(h.connection.status().state).toBe('up_to_date')
    expect([...h.cloud.snapshots.keys()].sort()).toEqual([...SNAPSHOT_KINDS].sort())
    const users = h.cloud.snapshots.get('remote_users')?.content as { username: string }[]
    expect(users.map((u) => u.username).sort()).toEqual(['admin', 'gloria'])
  })

  it('a role saved afterwards: only roles and remote_users go up again', async () => {
    const h = connected()
    h.connection.uploader.wake()
    await h.settle()
    const before = h.cloud.puts().length
    saveRole(
      h.m.db,
      h.m.restaurantId,
      h.m.access,
      { id: h.m.roles.manager, name: 'Gerente', permissions: ['view_reports'] },
      ADMIN,
      NOW,
    )
    h.connection.checkSnapshots()
    await h.settle()
    // The catalog carries the version counter, which every saved record moves.
    expect(
      h.cloud
        .puts()
        .slice(before)
        .map((c) => c.route.replace('/v1/snapshots/', ''))
        .sort(),
    ).toEqual(['catalog', 'remote_users', 'roles'])
  })

  it('right after registering the PC, they go up', async () => {
    const h = connected({ registered: false })
    h.cloud.plan.push(
      jsonResponse({ credential: h.cloud.credential, restaurant_id: h.m.restaurantId }, 201),
    )
    expect(await h.connection.register('abcd-efgh-jkmn')).toEqual({ ok: true })
    await h.settle()
    expect(h.cloud.snapshots.size).toBe(5)
  })

  it('revoked: nothing goes up, even if something changes', async () => {
    const h = connected()
    h.cloud.plan.push(jsonResponse({ error: 'invalid_credential' }, 401))
    h.connection.uploader.wake()
    await h.settle()
    expect(h.connection.status().state).toBe('revoked')
    h.connection.checkSnapshots()
    await h.settle()
    expect(h.cloud.puts()).toHaveLength(0)
  })

  it('not connected: nothing goes up', async () => {
    const h = connected({ registered: false })
    h.connection.uploader.wake()
    h.connection.checkSnapshots()
    await h.settle()
    expect(h.cloud.calls).toHaveLength(0)
  })
})
