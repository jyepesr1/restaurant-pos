import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handle } from '@pos/cloud/api'
import { ADMIN, createWorld, type World } from '@pos/cloud/testing'
import { newId } from '@pos/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { item } from '../access/hub-setup'
import { saveRole, saveStaffMember } from '../access/staff'
import { type Device, setupPrinting } from '../printing/printing-setup'
import { CloudConnection } from './connection'
import { readLink } from './link'
import { readAccepted, readSnapshots, SNAPSHOT_KINDS, SNAPSHOTS_FILE } from './snapshots'
import { manualTimers } from './testing'

// The real hub (its SQLite, its access and its reports) against the real cloud API on embedded
// Postgres, all in one process (task 1.11c-1): register the PC, upload events and snapshots, sign
// in to the panel with a register user, and see the panel give the same numbers as the hub's own
// /api/reports. Then what happens to the panel when the hub changes who can enter, and when the
// internet or the cloud fail while the snapshots go up.

const ORIGIN = 'https://cloud.faro.test'
const ADMIN_AUTHOR = { userId: null, deviceId: null }

let cloud: World
beforeAll(async () => {
  cloud = await createWorld()
})

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})

type Rule = (request: Request) => Response | 'cut' | 'lose' | undefined

/** The cloud's `fetch`, with the internet that goes down and answers the test forces. */
function internet(t: { clock: () => number }) {
  const state = {
    up: true,
    rule: null as Rule | null,
    log: [] as { method: string; path: string; outcome: number | 'cut' | 'lost' }[],
  }
  const fetchCloud: typeof fetch = async (input, init) => {
    const request = new Request(String(input), init)
    const path = new URL(request.url).pathname
    const log = (outcome: number | 'cut' | 'lost') =>
      state.log.push({ method: request.method, path, outcome })
    if (!state.up) {
      log('cut')
      throw new TypeError('fetch failed')
    }
    const ruled = state.rule?.(request)
    if (ruled === 'cut') {
      log('cut')
      throw new TypeError('fetch failed')
    }
    if (ruled instanceof Response) {
      log(ruled.status)
      return ruled
    }
    cloud.clock.now = new Date(Number(t.clock()))
    const r = await handle(request, {
      sql: cloud.sql,
      adminToken: ADMIN,
      clock: () => cloud.clock.now,
    })
    if (ruled === 'lose') {
      log('lost')
      throw new TypeError('the answer was lost')
    }
    log(r.status)
    return r
  }
  const puts = () => state.log.filter((c) => c.method === 'PUT')
  return { state, fetchCloud, puts }
}

const kindOf = (r: Request) => /\/v1\/snapshots\/([a-z_]+)$/.exec(r.url)?.[1]
const failing = (status: number) => new Response(JSON.stringify({ error: 'x' }), { status })

/** A hub with its history, connected to the cloud, and the panel pointed at the same cloud. */
async function world() {
  const t = setupPrinting()
  const dir = mkdtempSync(join(tmpdir(), 'hub-panel-'))
  folders.push(dir)
  const net = internet(t)
  const timers = manualTimers()
  const failures: unknown[] = []
  // `t.clock()` is the hub's manual clock in milliseconds.
  const hubNow = () => Number(t.clock())
  const hubIso = () => new Date(hubNow()).toISOString()

  const connect = (folder = dir) =>
    new CloudConnection({
      db: t.db,
      restaurantId: t.restaurantId,
      dataDir: folder,
      instance: 'instancia-de-prueba',
      url: ORIGIN,
      fetch: net.fetchCloud,
      clock: () => new Date(hubNow()),
      onFailure: (e) => failures.push(e),
      uploader: { timers: timers.timers },
      snapshots: () => readSnapshots(t.db, t.restaurantId),
      snapshotOptions: { now: hubNow, refusedRetryMs: 5 * 60_000 },
    })
  let connection = connect()
  const settle = async () => {
    connection.uploader.wake()
    await new Promise((r) => setTimeout(r, 0))
    await connection.idle()
  }
  /** The hub restarts: a new process with the same data folder. */
  const restart = () => {
    connection.stop()
    connection = connect()
  }

  const registerPc = async () => {
    cloud.clock.now = new Date(hubNow())
    const created = await cloud.cloud.createRestaurant({
      id: t.restaurantId,
      name: 'La Spritzzería',
    })
    const code = await cloud.cloud.createCode(t.restaurantId)
    if (!code) throw new Error('no code')
    const r = await connection.register(code.code)
    await settle()
    return { result: r, slug: 'slug' in created ? (created.slug as string) : '' }
  }
  const newCode = async () => {
    cloud.clock.now = new Date(hubNow())
    const code = await cloud.cloud.createCode(t.restaurantId)
    if (!code) throw new Error('no code')
    return code.code
  }

  // ── The panel ──
  const panel = (
    method: string,
    route: string,
    o: { cookie?: string | null; body?: unknown; origin?: string | null } = {},
  ) => {
    cloud.clock.now = new Date(Number(t.clock()))
    const origin = o.origin === undefined ? ORIGIN : o.origin
    return handle(
      new Request(`${ORIGIN}${route}`, {
        method,
        headers: {
          ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(origin ? { origin } : {}),
          ...(o.cookie ? { cookie: `__Host-faro_panel=${o.cookie}` } : {}),
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      }),
      { sql: cloud.sql, clock: () => cloud.clock.now },
    )
  }
  let slug = ''
  const enter = async (username: string, password: string) => {
    const r = await panel('POST', '/v1/panel/sign-in', {
      body: { restaurant: slug, username, password },
    })
    const cookie = /__Host-faro_panel=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? null
    return { status: r.status, cookie, response: r }
  }
  const asAdmin = () => enter('admin', t.people.admin.password as string)
  const status = async (route: string, cookie: string | null) =>
    (await panel('GET', route, { cookie })).status
  const json = async <T = Record<string, unknown>>(route: string, cookie: string | null) =>
    (await (await panel('GET', route, { cookie })).json()) as T

  // ── The hub's own reports ──
  const register = t.device('admin', 'register')
  const hubReport = async (from?: string, until?: string) => {
    const r = await t.post(
      '/api/reports',
      { ...register.sessionBody, ...(from ? { from, until: until ?? from } : {}) },
      register.token,
    )
    expect(r.statusCode).toBe(200)
    return r.json()
  }

  // ── History: two Saturdays, a week apart ──
  const sale = (reg: Device, waiter: Device, shift: string, price: number, tip: number) => {
    const order = t.open(waiter)
    expect(waiter.submit(order, 'ItemAdded', { ...item(), unit_price: price }).status).toBe(
      'confirmed',
    )
    expect(
      reg.submit(order, 'PaymentRecorded', {
        payment_id: newId(),
        check_id: null,
        register_shift_id: shift,
        method: 'cash',
        amount: price,
        tip,
        tendered: price + tip,
        change: 0,
        rounding_adjustment: 0,
        rounding: { multiple: 100, mode: 'nearest_half_down' },
        cardTerminal: null,
        charge_reference: null,
      }).status,
    ).toBe('confirmed')
    expect(reg.submit(order, 'OrderClosed', {}).status).toBe('confirmed')
  }
  const openShift = (reg: Device) => {
    const shift = newId()
    expect(
      reg.submit(
        shift,
        'ShiftOpened',
        { register_id: reg.connection.deviceId, base: 100_000 },
        { aggregate_type: 'register_shift' },
      ).status,
    ).toBe('confirmed')
    return shift
  }
  const closeShift = (reg: Device, shift: string, counted: number) => {
    const cashCount = newId()
    reg.submit(
      shift,
      'CashCountRecorded',
      {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: counted / 1_000 }],
        counted_cash: counted,
      },
      { aggregate_type: 'register_shift' },
    )
    expect(
      reg.submit(
        shift,
        'ShiftClosed',
        {
          cash_count_id: cashCount,
          expected_cash: counted,
          counted_cash: counted,
          variance: 0,
          justification: null,
          other_methods: [],
        },
        { aggregate_type: 'register_shift' },
      ).status,
    ).toBe('confirmed')
  }

  /**
   * Saturday 24-oct: a shift with a 40.000 sale at 15:00 (Bogotá) and a 30.000 one at 18:00, closed.
   * Saturday 31-oct, 16:30: a shift still open with 60.000 and 25.000 sold. The hub's clock ends
   * there, so a week earlier at this hour only the first sale of the 24th had happened.
   */
  const history = () => {
    const cashier = t.device('admin', 'register')
    const ana = t.device('waiter')
    const shiftA = openShift(cashier)
    sale(cashier, ana, shiftA, 40_000, 4_000)
    t.advance(3 * 3_600_000)
    sale(cashier, ana, shiftA, 30_000, 0)
    closeShift(cashier, shiftA, 100_000 + 40_000 + 4_000 + 30_000)
    t.advance(7 * 86_400_000 - 90 * 60_000)
    // A week later the sessions of the devices expired: they sign in again.
    const cashier2 = t.device('admin', 'register')
    const ana2 = t.device('waiter')
    const shiftB = openShift(cashier2)
    sale(cashier2, ana2, shiftB, 60_000, 6_000)
    sale(cashier2, ana2, shiftB, 25_000, 0)
  }

  const cloudRows = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ) => (await cloud.db.query<T>(sql, [t.restaurantId, ...params])).rows

  return {
    t,
    dir,
    net,
    timers,
    failures,
    get connection() {
      return connection
    },
    settle,
    restart,
    registerPc,
    newCode,
    panel,
    enter,
    asAdmin,
    status,
    json,
    hubReport,
    history,
    cloudRows,
    setSlug: (s: string) => {
      slug = s
    },
    hubNow,
    hubIso,
  }
}

/** The world with its PC registered and everything up in the cloud, ready to sign in. */
async function connected(withHistory = true) {
  const w = await world()
  if (withHistory) w.history()
  const { result, slug } = await w.registerPc()
  expect(result).toEqual({ ok: true })
  w.setSlug(slug)
  expect(w.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
  return w
}

const norm = (v: unknown) => JSON.parse(JSON.stringify(v))

describe('the panel gives the same numbers as the hub', () => {
  it('reports of one day, a week and the whole history match /api/reports of the hub', async () => {
    const w = await connected()
    const session = await w.asAdmin()
    expect(session.status).toBe(200)
    const periods: [string, string][] = [
      ['2026-10-24', '2026-10-24'],
      ['2026-10-31', '2026-10-31'],
      ['2026-10-24', '2026-10-31'],
      ['2026-10-25', '2026-10-30'],
    ]
    for (const [from, until] of periods) {
      const fromPanel = await w.json(
        `/v1/panel/reports?from=${from}&until=${until}`,
        session.cookie,
      )
      const fromHub = await w.hubReport(from, until)
      expect(fromPanel, `${from} → ${until}`).toEqual({ ...norm(fromHub), printer: false })
    }
    // The figures are not trivially empty.
    const week = (await w.json(
      '/v1/panel/reports?from=2026-10-24&until=2026-10-31',
      session.cookie,
    )) as {
      report: { sales: { net: number; checks: number; tips: number } }
      closings: unknown[]
    }
    expect(week.report.sales).toMatchObject({ net: 155_000, checks: 4, tips: 10_000 })
    expect(week.closings).toHaveLength(1)
    // Without dates: today's business day, as the hub.
    expect(await w.json('/v1/panel/reports', session.cookie)).toEqual({
      ...norm(await w.hubReport()),
      printer: false,
    })
  })

  it('the dashboard: today, and the same Saturday a week ago up to now and the whole day', async () => {
    const w = await connected()
    const session = await w.asAdmin()
    const summary = await w.json<{
      today: string
      report: unknown
      users: Record<string, string>
      last_week: {
        day: string
        report_until_now: { sales: { net: number; checks: number } }
        report_full: unknown
      }
      local: { last_seen_at: string | null; last_event_at: string | null; pending: number }
    }>('/v1/panel/summary', session.cookie)
    expect(summary.today).toBe('2026-10-31')
    expect(summary.last_week.day).toBe('2026-10-24')
    expect(summary.report).toEqual(norm((await w.hubReport('2026-10-31')).report))
    expect(summary.last_week.report_full).toEqual(norm((await w.hubReport('2026-10-24')).report))
    // A week ago at this hour (16:30) the second sale (18:00) and the close had not happened.
    expect(summary.last_week.report_until_now.sales).toMatchObject({ net: 40_000, checks: 1 })
    expect(summary.local.pending).toBe(0)
    expect(summary.local.last_seen_at).toBe(new Date(w.hubNow()).toISOString())
    // The names are the hub's.
    expect(Object.values(summary.users)).toContain('Ana')
  })

  it('the archived waiter keeps their name in both', async () => {
    const w = await connected()
    const ana = w.t.people.waiter.userId
    saveStaffMember(
      w.t.db,
      w.t.restaurantId,
      w.t.access,
      { id: ana, name: 'Ana', roleId: w.t.roles.waiter, active: false },
      ADMIN_AUTHOR,
      w.hubIso(),
    )
    w.connection.checkSnapshots()
    await w.settle()
    const session = await w.asAdmin()
    const fromPanel = await w.json<{ users: Record<string, string> }>(
      '/v1/panel/reports?from=2026-10-24&until=2026-10-31',
      session.cookie,
    )
    const fromHub = await w.hubReport('2026-10-24', '2026-10-31')
    expect(fromPanel.users).toEqual(norm(fromHub.users))
    expect(Object.values(fromPanel.users)).toContain('Ana')
  })
})

describe('what the hub changes ends the panel session', () => {
  /** Gives Carlos (the cashier) the permission to enter from outside, with or without reports. */
  const grant = (w: Awaited<ReturnType<typeof connected>>, extra: string[]) => {
    const roles = readSnapshots(w.t.db, w.t.restaurantId).roles as {
      id: string
      permissions: string[]
    }[]
    const current = roles.find((r) => r.id === w.t.roles.cashier)?.permissions ?? []
    saveRole(
      w.t.db,
      w.t.restaurantId,
      w.t.access,
      {
        id: w.t.roles.cashier,
        name: 'Cajero',
        permissions: [...new Set([...current.filter((p) => p !== 'remote_access'), ...extra])],
      },
      ADMIN_AUTHOR,
      w.hubIso(),
    )
    w.connection.checkSnapshots()
  }
  const carlos = (w: Awaited<ReturnType<typeof connected>>) =>
    w.enter('carlos', w.t.people.cashier.password as string)

  it('a register user enters only once their role has remote_access', async () => {
    const w = await connected(false)
    expect((await carlos(w)).status).toBe(401)
    grant(w, ['remote_access', 'view_reports'])
    await w.settle()
    const session = await carlos(w)
    expect(session.status).toBe(200)
    expect(await w.status('/v1/panel/summary', session.cookie)).toBe(200)
    // Another user's password is no use for his username.
    expect((await w.enter('carlos', w.t.people.manager.password as string)).status).toBe(401)
  })

  it('without view_reports they enter but see neither the dashboard nor the reports', async () => {
    const w = await connected(false)
    grant(w, ['remote_access'])
    await w.settle()
    const session = await carlos(w)
    expect(session.status).toBe(200)
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)
    expect(await w.status('/v1/panel/summary', session.cookie)).toBe(403)
    expect(await w.status('/v1/panel/reports', session.cookie)).toBe(403)
  })

  it('taking away remote_access ends the session at the next snapshot, and giving it back does not revive it', async () => {
    const w = await connected(false)
    grant(w, ['remote_access', 'view_reports'])
    await w.settle()
    const session = await carlos(w)
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)

    grant(w, ['view_reports'])
    await w.settle()
    const dead = await w.panel('GET', '/v1/panel/me', { cookie: session.cookie })
    expect(dead.status).toBe(401)
    expect(dead.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await carlos(w)).status).toBe(401)

    grant(w, ['remote_access', 'view_reports'])
    await w.settle()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
    expect((await carlos(w)).status).toBe(200)
  })

  it('changing the password ends the session; the old one no longer works and the new one does', async () => {
    const w = await connected(false)
    grant(w, ['remote_access', 'view_reports'])
    await w.settle()
    const session = await carlos(w)
    expect(session.status).toBe(200)

    w.t.access.assignPassword(w.t.people.cashier.userId, 'carlos', 'otra-clave-de-carlos')
    w.connection.checkSnapshots()
    await w.settle()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
    expect((await carlos(w)).status).toBe(401)
    expect((await w.enter('carlos', 'otra-clave-de-carlos')).status).toBe(200)
  })

  it('archiving the person ends the session and blocks the sign-in', async () => {
    const w = await connected(false)
    grant(w, ['remote_access', 'view_reports'])
    await w.settle()
    const session = await carlos(w)
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)

    saveStaffMember(
      w.t.db,
      w.t.restaurantId,
      w.t.access,
      { id: w.t.people.cashier.userId, name: 'Carlos', roleId: w.t.roles.cashier, active: false },
      ADMIN_AUTHOR,
      w.hubIso(),
    )
    w.connection.checkSnapshots()
    await w.settle()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
    expect((await carlos(w)).status).toBe(401)
    // The administrator, untouched, still enters.
    expect((await w.asAdmin()).status).toBe(200)
  })

  it('archiving the role does the same (the hub leaves its people out)', async () => {
    const w = await connected(false)
    const session = await w.enter('gloria', w.t.people.manager.password as string)
    expect(session.status).toBe(200)
    w.t.db
      .prepare('UPDATE roles SET active = 0 WHERE restaurant_id = ? AND id = ?')
      .run(w.t.restaurantId, w.t.roles.manager)
    w.connection.checkSnapshots()
    await w.settle()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
  })

  it('a change nobody announced (no staff screen) reaches the panel in the next routine check, within a minute', async () => {
    const w = await connected(false)
    const session = await w.asAdmin()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)

    w.t.access.assignPassword(w.t.people.admin.userId, 'admin', 'clave-nueva-del-admin')
    // Same minute: nothing is asked yet.
    await w.settle()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)
    // The routine check goes with the 30 s heartbeat.
    w.t.advance(31_000)
    w.timers.fire()
    await w.settle()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
    expect((await w.enter('admin', 'clave-nueva-del-admin')).status).toBe(200)
  })
})

describe('cuts and refusals while the snapshots go up', () => {
  it('a cut: what can go up goes up, the person-removing snapshot waits and is retried, and the revocation arrives when the internet does', async () => {
    const w = await connected(false)
    const session = await w.asAdmin()
    // A role (moves catalog, roles and remote_users) and a password change, with the cloud
    // unreachable exactly for `remote_users`.
    saveRole(
      w.t.db,
      w.t.restaurantId,
      w.t.access,
      { id: w.t.roles.kitchen, name: 'Cocina', permissions: ['mark_preparation'] },
      ADMIN_AUTHOR,
      w.hubIso(),
    )
    w.t.access.assignPassword(w.t.people.admin.userId, 'admin', 'clave-nueva-del-admin')
    const before = w.net.puts().length
    w.net.state.rule = (r) =>
      r.method === 'PUT' && kindOf(r) === 'remote_users' ? 'cut' : undefined
    w.connection.checkSnapshots()
    await w.settle()
    const outcomes = Object.fromEntries(
      w.net
        .puts()
        .slice(before)
        .map((c) => [c.path.replace('/v1/snapshots/', ''), c.outcome]),
    )
    expect(outcomes).toEqual({ remote_users: 'cut', roles: 204, catalog: 204 })
    // The one that takes access away is tried first (docs: «remote_users first»).
    expect(w.net.puts()[before]?.path).toBe('/v1/snapshots/remote_users')
    // While it is cut the cloud still has the old verifier: the old session and password live.
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)
    expect((await w.enter('admin', 'clave-nueva-del-admin')).status).toBe(401)

    w.net.state.rule = null
    // Whatever the wait after a failure is, six minutes cover it.
    w.t.advance(6 * 60_000)
    w.connection.checkSnapshots()
    await w.settle()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
    expect((await w.enter('admin', 'clave-nueva-del-admin')).status).toBe(200)
    // Everything the hub has is up there now, and nothing is left to send.
    const accepted = readAccepted(w.dir, readLink(w.dir)?.hubId as string)
    expect(Object.keys(accepted).sort()).toEqual([...SNAPSHOT_KINDS].sort())
    const sent = w.net.puts().length
    w.connection.checkSnapshots()
    await w.settle()
    expect(w.net.puts()).toHaveLength(sent)
  })

  it('the answer is lost after the cloud saved: the hub sends it again and nothing is duplicated', async () => {
    const w = await connected(false)
    w.t.access.assignPassword(w.t.people.admin.userId, 'admin', 'clave-nueva-del-admin')
    w.net.state.rule = (r) =>
      r.method === 'PUT' && kindOf(r) === 'remote_users' ? 'lose' : undefined
    w.connection.checkSnapshots()
    await w.settle()
    expect(w.net.puts().some((c) => c.outcome === 'lost')).toBe(true)
    w.net.state.rule = null
    w.connection.checkSnapshots()
    await w.settle()
    const users = await w.cloudRows<{ username: string }>(
      'SELECT username FROM remote_users WHERE restaurant_id = $1 ORDER BY username',
    )
    expect(users.map((u) => u.username)).toEqual(['admin', 'gloria'])
    expect((await w.enter('admin', 'clave-nueva-del-admin')).status).toBe(200)
  })

  it('a cloud that answers 500 keeps the previous state, is tried again and recovers', async () => {
    const w = await connected(false)
    const session = await w.asAdmin()
    w.t.access.assignPassword(w.t.people.admin.userId, 'admin', 'clave-nueva-del-admin')
    w.net.state.rule = (r) => (r.method === 'PUT' ? failing(500) : undefined)
    w.connection.checkSnapshots()
    await w.settle()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)
    // Events keep going up independently of the snapshots.
    expect(w.connection.status().state).toBe('up_to_date')

    w.net.state.rule = null
    w.t.advance(31_000)
    w.timers.fire()
    await w.settle()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
    expect(w.failures).toEqual([])
  })

  it('a 413 is logged without any password hash, is not sent again, and the events go on', async () => {
    const w = await connected(false)
    const session = await w.asAdmin()
    w.t.access.assignPassword(w.t.people.admin.userId, 'admin', 'clave-nueva-del-admin')
    w.net.state.rule = (r) =>
      r.method === 'PUT' && kindOf(r) === 'remote_users' ? failing(413) : undefined
    w.connection.checkSnapshots()
    await w.settle()
    const attempts = w.net.puts().filter((c) => c.path.endsWith('/remote_users'))
    expect(attempts.at(-1)?.outcome).toBe(413)
    expect(w.failures).toHaveLength(1)
    const log = String((w.failures[0] as Error).message)
    expect(log).toContain('remote_users')
    expect(log).not.toMatch(/scrypt/)
    expect(JSON.stringify(w.failures)).not.toContain(
      String(
        w.t.db
          .prepare('SELECT password_hash FROM user_credentials WHERE user_id = ? AND current = 1')
          .get(w.t.people.admin.userId)?.password_hash,
      ),
    )
    // Not sent again with the same content.
    const sent = attempts.length
    w.connection.checkSnapshots()
    await w.settle()
    expect(w.net.puts().filter((c) => c.path.endsWith('/remote_users'))).toHaveLength(sent)
    expect(w.failures).toHaveLength(1)
    // The old session still lives; the events are not affected.
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)
    expect(w.connection.status().state).toBe('up_to_date')
  })

  it('a 404 (a cloud without the route yet) is asked again after five minutes, not before', async () => {
    const w = await connected(false)
    const session = await w.asAdmin()
    w.t.access.assignPassword(w.t.people.admin.userId, 'admin', 'clave-nueva-del-admin')
    w.net.state.rule = (r) =>
      r.method === 'PUT' && kindOf(r) === 'remote_users' ? failing(404) : undefined
    w.connection.checkSnapshots()
    await w.settle()
    const count = () => w.net.puts().filter((c) => c.path.endsWith('/remote_users')).length
    const first = count()
    w.t.advance(4 * 60_000)
    w.connection.checkSnapshots()
    await w.settle()
    expect(count()).toBe(first)
    w.net.state.rule = null
    w.t.advance(61_000)
    w.connection.checkSnapshots()
    await w.settle()
    expect(count()).toBe(first + 1)
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
  })

  it('a revoked PC uploads nothing, and revoking it closes the panel for its location until a PC is registered again', async () => {
    const w = await connected()
    const session = await w.asAdmin()
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)
    await cloud.cloud.revokeHub(readLink(w.dir)?.hubId as string)
    // The cloud no longer lists who can enter, and the sessions of those people ended.
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
    expect((await w.asAdmin()).status).toBe(401)

    w.t.advance(60_000)
    w.t.access.assignPassword(w.t.people.admin.userId, 'admin', 'clave-nueva-del-admin')
    const before = w.net.puts().length
    w.connection.checkSnapshots()
    w.timers.fire()
    await w.settle()
    expect(w.connection.status().state).toBe('revoked')
    // The revoked credential is refused (or not even used): nothing reaches the cloud.
    expect(
      w.net
        .puts()
        .slice(before)
        .every((c) => c.outcome === 401),
    ).toBe(true)
    expect((await w.enter('admin', 'clave-nueva-del-admin')).status).toBe(401)
    expect(await w.cloudRows('SELECT 1 FROM remote_users WHERE restaurant_id = $1')).toEqual([])

    // A new PC registration brings them back, with the password the hub has now.
    expect(await w.connection.register(await w.newCode())).toEqual({ ok: true })
    await w.settle()
    expect((await w.enter('admin', 'clave-nueva-del-admin')).status).toBe(200)
    // The session that was closed stays closed.
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
  })
})

describe('restarting the hub', () => {
  const putsAfter = async (w: Awaited<ReturnType<typeof connected>>) => {
    const before = w.net.puts().length
    w.restart()
    await w.settle()
    return w.net.puts().slice(before)
  }

  it('with its file of fingerprints intact it uploads no snapshot again', async () => {
    const w = await connected(false)
    expect(await putsAfter(w)).toEqual([])
  })

  it.each([
    ['not JSON', 'esto no es json {'],
    ['cut in half', '{"hub_id":"01J'],
    ['empty', ''],
    ['the wrong shape', JSON.stringify({ hub_id: 1, accepted: [] })],
    ['an array', '[]'],
    [
      'from a hub that does not exist',
      JSON.stringify({ hub_id: 'otro', accepted: { catalog: 'x' } }),
    ],
  ])(
    'a damaged file (%s): everything goes up again, the cloud keeps the same and the session lives',
    async (_name, content) => {
      const w = await connected(false)
      const session = await w.asAdmin()
      const rowsBefore = await w.cloudRows(
        'SELECT kind, fingerprint, uploaded_at FROM snapshots WHERE restaurant_id = $1 ORDER BY kind',
      )
      writeFileSync(join(w.dir, SNAPSHOTS_FILE), content)
      const puts = await putsAfter(w)
      expect(puts.map((c) => c.path.replace('/v1/snapshots/', '')).sort()).toEqual(
        [...SNAPSHOT_KINDS].sort(),
      )
      expect(puts.every((c) => c.outcome === 204)).toBe(true)
      // Same fingerprints in the cloud (it did not even rewrite them).
      expect(
        await w.cloudRows(
          'SELECT kind, fingerprint, uploaded_at FROM snapshots WHERE restaurant_id = $1 ORDER BY kind',
        ),
      ).toEqual(rowsBefore)
      expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)
      // And the file was written again, valid.
      const hubId = readLink(w.dir)?.hubId as string
      expect(Object.keys(readAccepted(w.dir, hubId)).sort()).toEqual([...SNAPSHOT_KINDS].sort())
    },
  )

  it('a missing file is the same as a new registration: everything goes up again', async () => {
    const w = await connected(false)
    rmSync(join(w.dir, SNAPSHOTS_FILE))
    expect(await putsAfter(w)).toHaveLength(SNAPSHOT_KINDS.length)
  })

  it('the file of another registration (other hub id) is not trusted', async () => {
    const w = await connected(false)
    const saved = JSON.parse(readFileSync(join(w.dir, SNAPSHOTS_FILE), 'utf8')) as {
      hub_id: string
      accepted: Record<string, string>
    }
    writeFileSync(join(w.dir, SNAPSHOTS_FILE), JSON.stringify({ ...saved, hub_id: newId() }))
    expect(await putsAfter(w)).toHaveLength(SNAPSHOT_KINDS.length)
  })

  it('changes made while the hub was off go up on start', async () => {
    const w = await connected(false)
    const session = await w.asAdmin()
    w.connection.stop()
    w.t.access.assignPassword(w.t.people.admin.userId, 'admin', 'clave-nueva-del-admin')
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(200)
    w.restart()
    await w.settle()
    // The start checks them once the events are up to date.
    expect(await w.status('/v1/panel/me', session.cookie)).toBe(401)
  })
})

describe('a re-registered PC', () => {
  /** Revokes the PC and registers it again, as the owner would after reinstalling. */
  const reRegister = async (w: Awaited<ReturnType<typeof connected>>) => {
    const first = readLink(w.dir)?.hubId as string
    await cloud.cloud.revokeHub(first)
    w.t.advance(60_000)
    w.timers.fire()
    await w.settle()
    expect(w.connection.status().state).toBe('revoked')
    expect(await w.connection.register(await w.newCode())).toEqual({ ok: true })
    await w.settle()
    const second = readLink(w.dir)?.hubId as string
    expect(second).not.toBe(first)
    return { first, second }
  }

  it('the old session is closed, a new one sees the same reports, no event is duplicated and the local reads up to date', async () => {
    const w = await connected()
    const old = await w.asAdmin()
    const week = '/v1/panel/reports?from=2026-10-24&until=2026-10-31'
    const reportBefore = await w.json(week, old.cookie)
    const eventsBefore = await w.cloudRows<{ n: string }>(
      'SELECT count(*)::text AS n FROM events WHERE restaurant_id = $1',
    )
    await reRegister(w)

    expect(w.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(
      await w.cloudRows('SELECT count(*)::text AS n FROM events WHERE restaurant_id = $1'),
    ).toEqual(eventsBefore)
    expect(await w.status('/v1/panel/me', old.cookie)).toBe(401)
    const session = await w.asAdmin()
    expect(session.status).toBe(200)
    expect(await w.json(week, session.cookie)).toEqual(reportBefore)
    // The dashboard follows the new PC: nothing is left to upload.
    const summary = await w.json<{ local: { pending: number; last_seen_at: string } }>(
      '/v1/panel/summary',
      session.cookie,
    )
    expect(summary.local.pending).toBe(0)
    expect(summary.local.last_seen_at).toBe(new Date(w.hubNow()).toISOString())
    expect(
      await w.cloudRows('SELECT kind FROM snapshots WHERE restaurant_id = $1 ORDER BY kind'),
    ).toHaveLength(5)
  })

  it('new sales after the re-registration appear in the panel next to the old ones', async () => {
    const w = await connected()
    await reRegister(w)
    const session = await w.asAdmin()

    const cashier = w.t.device('admin', 'register')
    const ana = w.t.device('waiter')
    const order = w.t.open(ana)
    expect(ana.submit(order, 'ItemAdded', { ...item(), unit_price: 10_000 }).status).toBe(
      'confirmed',
    )
    const shift = newId()
    cashier.submit(
      shift,
      'ShiftOpened',
      { register_id: cashier.connection.deviceId, base: 0 },
      { aggregate_type: 'register_shift' },
    )
    expect(
      cashier.submit(order, 'PaymentRecorded', {
        payment_id: newId(),
        check_id: null,
        register_shift_id: shift,
        method: 'cash',
        amount: 10_000,
        tip: 0,
        tendered: 10_000,
        change: 0,
        rounding_adjustment: 0,
        rounding: { multiple: 100, mode: 'nearest_half_down' },
        cardTerminal: null,
        charge_reference: null,
      }).status,
    ).toBe('confirmed')
    cashier.submit(order, 'OrderClosed', {})
    await w.settle()
    const fromPanel = await w.json(
      '/v1/panel/reports?from=2026-10-24&until=2026-10-31',
      session.cookie,
    )
    expect(fromPanel).toEqual({
      ...norm(await w.hubReport('2026-10-24', '2026-10-31')),
      printer: false,
    })
  })
})

describe('the heartbeat', () => {
  it('the panel sees how much the hub still has to upload, and zero once it does', async () => {
    const w = await connected()
    const session = await w.asAdmin()
    // The register keeps selling while the cloud refuses events.
    const ana = w.t.device('waiter')
    w.net.state.rule = (r) =>
      r.method === 'POST' && r.url.endsWith('/v1/events') ? failing(500) : undefined
    for (let i = 0; i < 3; i++) w.t.open(ana)
    w.t.advance(31_000)
    w.timers.fire()
    await w.settle()
    expect(w.connection.status().pending).toBe(3)
    const behind = await w.json<{ local: { pending: number } }>('/v1/panel/summary', session.cookie)
    expect(behind.local.pending).toBe(3)

    w.net.state.rule = null
    w.timers.fire()
    await w.settle()
    expect(w.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    const done = await w.json<{ local: { pending: number } }>('/v1/panel/summary', session.cookie)
    expect(done.local.pending).toBe(0)
  })

  it('with the internet cut the time of the last news stands still, and moves again when it returns', async () => {
    const w = await connected()
    const session = await w.asAdmin()
    const seen = async () =>
      (await w.json<{ local: { last_seen_at: string } }>('/v1/panel/summary', session.cookie)).local
        .last_seen_at
    const first = await seen()
    w.net.state.up = false
    for (let i = 0; i < 3; i++) {
      w.t.advance(30_000)
      w.timers.fire()
      await w.settle()
    }
    expect(await seen()).toBe(first)
    w.net.state.up = true
    w.t.advance(30_000)
    w.timers.fire()
    await w.settle()
    expect(new Date(await seen()).getTime()).toBe(w.hubNow())
  })
})
