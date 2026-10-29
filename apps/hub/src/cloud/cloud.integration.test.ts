import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handle } from '@pos/cloud/api'
import { ADMIN, createWorld, type World } from '@pos/cloud/testing'
import type { CloudStatus, HubMessage } from '@pos/sync'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupAccess } from '../access/setup'
import { prepareSync } from '../startup'
import { CloudConnection } from './connection'
import { LINK_FILE, readLink } from './link'

// The real hub uploading to the real cloud API (on embedded Postgres): registering with the code,
// the upload in order, an internet cut and coming back, and a revoked register PC connected again
// (task 1.11).

let cloud: World
beforeAll(async () => {
  cloud = await createWorld()
})

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})

/** A `fetch` that goes to the cloud's `handle`, and can be "unplugged" like the internet. */
function internet() {
  const state = { up: true, calls: 0, loseNextAnswer: false }
  const fetchCloud: typeof fetch = async (input, init) => {
    state.calls += 1
    if (!state.up) throw new TypeError('fetch failed')
    const r = await handle(new Request(String(input), init), {
      sql: cloud.sql,
      adminToken: ADMIN,
      clock: () => cloud.clock.now,
    })
    if (state.loseNextAnswer) {
      state.loseNextAnswer = false
      throw new TypeError('the answer was lost')
    }
    return r
  }
  return { state, fetchCloud }
}

/** Timers run by hand: the test decides when the retry happens. */
function manualTimers() {
  const pending = new Map<number, { job: () => void; ms: number }>()
  let next = 0
  return {
    timers: {
      set: (job: () => void, ms: number) => {
        next += 1
        pending.set(next, { job, ms })
        return next
      },
      clear: (h: unknown) => pending.delete(h as number),
    },
    waits: () => [...pending.values()].map((p) => p.ms),
    fire: () => {
      const jobs = [...pending.values()]
      pending.clear()
      for (const p of jobs) p.job()
    },
  }
}

function hub() {
  const m = setupAccess()
  const dir = mkdtempSync(join(tmpdir(), 'hub-cloud-'))
  folders.push(dir)
  const floor = prepareSync(m.db, dir, m.restaurantId, m.access)
  const register = m.pair('register')
  const session = m.signIn(register.connection, 'cashier')
  const received: HubMessage[] = []
  const link = floor.connect((message) => received.push(message))
  link.receive({
    type: 'hello',
    token: register.token,
    hub_instance: null,
    until: 0,
    version_app: 'test',
  })
  let batch = 0
  const openOrders = (howMany: number) => {
    for (let i = 0; i < howMany; i++) {
      batch += 1
      link.receive({
        type: 'push',
        batch_id: `batch-${batch}`,
        events: [
          m.event(register.connection, session, 'OrderOpened', {
            channel: 'takeout',
            table_id: null,
            guests: 0,
          }),
        ],
      })
    }
  }
  const net = internet()
  const t = manualTimers()
  const statuses: CloudStatus[] = []
  const connection = new CloudConnection({
    db: m.db,
    restaurantId: m.restaurantId,
    dataDir: dir,
    instance: 'instancia-de-prueba',
    url: 'https://cloud.faro.test',
    fetch: net.fetchCloud,
    clock: () => cloud.clock.now,
    onStatus: (s) => statuses.push(s),
    uploader: { timers: t.timers },
  })
  const settle = async () => {
    connection.uploader.wake()
    await new Promise((r) => setTimeout(r, 0))
    await connection.uploader.idle()
  }
  const inCloud = async () =>
    Number(
      (
        await cloud.db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM events WHERE restaurant_id = $1',
          [m.restaurantId],
        )
      ).rows[0]?.n,
    )
  const newCode = async () => {
    await cloud.cloud.createRestaurant({ id: m.restaurantId, name: 'La Spritzzería' })
    const c = await cloud.cloud.createCode(m.restaurantId)
    if (!c) throw new Error('no code')
    return c.code
  }
  return { m, dir, connection, net, t, statuses, openOrders, settle, inCloud, newCode, received }
}

describe('connecting the register PC to the cloud', () => {
  it('without connecting it, nothing goes out: the events wait and are counted', async () => {
    const h = hub()
    h.openOrders(3)
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'not_connected', pending: 3 })
    expect(h.net.state.calls).toBe(0)
  })

  it('with the code it connects and uploads everything already in the hub, in order', async () => {
    const h = hub()
    h.openOrders(5)
    expect(await h.connection.register(await h.newCode())).toEqual({ ok: true })
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toBe(5)
    // Each new event goes up right away.
    h.openOrders(2)
    await h.settle()
    expect(await h.inCloud()).toBe(7)
    expect(h.connection.status().pending).toBe(0)
  })

  it('the credential stays in a file only the hub can read and never reaches the status', async () => {
    const h = hub()
    await h.connection.register(await h.newCode())
    const link = readLink(h.dir)
    expect(link?.credential).toBeTruthy()
    expect(statSync(join(h.dir, LINK_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(h.connection.status())).not.toContain(link?.credential as string)
    expect(JSON.stringify(h.statuses)).not.toContain(link?.credential as string)
  })

  it('a code of another restaurant is refused and does not connect it', async () => {
    const h = hub()
    const other = hub()
    const code = await other.newCode()
    await h.newCode()
    const r = await h.connection.register(code)
    expect(r).toMatchObject({ ok: false, code: 'other_restaurant' })
    expect(h.connection.status().state).toBe('not_connected')
    // The other restaurant can still use it.
    expect(await other.connection.register(code)).toEqual({ ok: true })
  })

  it('a wrong code says so; without internet it says so too', async () => {
    const h = hub()
    await h.newCode()
    expect(await h.connection.register('AAAA-BBBB-CCCC')).toMatchObject({
      ok: false,
      code: 'invalid_code',
    })
    h.net.state.up = false
    expect(await h.connection.register(await h.newCode())).toMatchObject({
      ok: false,
      code: 'offline',
    })
  })

  it('if the answer is lost, the same code works again', async () => {
    const h = hub()
    const code = await h.newCode()
    h.net.state.loseNextAnswer = true
    expect((await h.connection.register(code)).ok).toBe(false)
    expect(await h.connection.register(code)).toEqual({ ok: true })
  })

  it('already connected, another code is not accepted', async () => {
    const h = hub()
    await h.connection.register(await h.newCode())
    expect(await h.connection.register(await h.newCode())).toMatchObject({
      ok: false,
      code: 'already_connected',
    })
  })
})

describe('without internet', () => {
  it('the dining room goes on, the pending count grows and everything goes up when it returns', async () => {
    const h = hub()
    await h.connection.register(await h.newCode())
    await h.settle()
    h.net.state.up = false
    h.openOrders(4)
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'offline', pending: 4 })
    // While it waits, new events do not knock on the cloud's door every time.
    const calls = h.net.state.calls
    h.openOrders(2)
    await h.settle()
    expect(h.net.state.calls).toBe(calls)
    expect(h.connection.status().pending).toBe(6)
    h.net.state.up = true
    h.t.fire()
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toBe(6)
  })

  it('waits longer after each failure, up to 30 seconds', async () => {
    const h = hub()
    await h.connection.register(await h.newCode())
    await h.settle()
    h.net.state.up = false
    h.openOrders(1)
    const waits: number[] = []
    for (let i = 0; i < 8; i++) {
      h.t.fire()
      await h.settle()
      waits.push(...h.t.waits())
    }
    expect(waits).toEqual([1000, 2000, 5000, 10_000, 20_000, 30_000, 30_000, 30_000])
  })
})

describe('revoked', () => {
  it('stops uploading; a new code connects it again and it catches up without duplicating', async () => {
    const h = hub()
    h.openOrders(3)
    await h.connection.register(await h.newCode())
    await h.settle()
    const first = readLink(h.dir)?.hubId as string
    await cloud.cloud.revokeHub(first)
    h.openOrders(2)
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'revoked', pending: 2 })
    expect(await h.connection.register(await h.newCode())).toEqual({ ok: true })
    await h.settle()
    expect(readLink(h.dir)?.hubId).not.toBe(first)
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toBe(5)
  })
})
