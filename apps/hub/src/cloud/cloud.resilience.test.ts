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
import { readLink } from './link'
import { flush, jsonResponse, manualTimers } from './testing'
import { STUCK_RETRY_MS } from './uploader'

// The real hub (SQLite, signed events) against the real cloud API (embedded Postgres), with the
// internet and the cloud failing in the ways that happen (task 1.11, ADR-016): thousands of
// events, big batches, a cut in the middle, the answer lost after the cloud saved, the hub
// restarted, strange answers, an event the cloud cannot save and a revoked register PC.

let cloud: World
beforeAll(async () => {
  cloud = await createWorld()
})

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})

interface Seen {
  method: string
  route: string
  sequences: number[]
  bytes: number
}

/** A `fetch` to the cloud's `handle` that can be unplugged, cut, made to lie or to corrupt. */
function internet() {
  const state = {
    up: true,
    loseNextAnswers: 0,
    /** Goes down after this many POSTs reach the cloud. */
    downAfterPosts: Number.POSITIVE_INFINITY,
    /** The cloud answers 413 to a batch with more events than this. */
    maxEvents: Number.POSITIVE_INFINITY,
    /** The cloud receives this sequence with a business day it cannot accept. */
    corruptSequence: null as number | null,
    /** Every POST is delivered twice (a retry nobody noticed). */
    duplicatePosts: false,
    /** Answers queued for the next requests instead of going to the cloud. */
    replies: [] as (Response | Error)[],
    /** Runs after the cloud handled each POST (with how many there have been). */
    afterPost: null as ((posts: number) => Promise<void>) | null,
    posts: 0,
  }
  const seen: Seen[] = []
  const toCloud = (input: unknown, init?: RequestInit) =>
    handle(new Request(String(input), init), {
      sql: cloud.sql,
      adminToken: ADMIN,
      clock: () => cloud.clock.now,
    })
  const fetchCloud: typeof fetch = async (input, init) => {
    if (!state.up) throw new TypeError('fetch failed')
    let body = init?.body ? String(init.body) : undefined
    const parsed = body ? (JSON.parse(body) as { events?: { sequence: number }[] }) : null
    const method = init?.method ?? 'GET'
    const route = new URL(String(input)).pathname
    const uploads = route === '/v1/events' && method === 'POST'
    const entry: Seen = {
      method,
      route,
      sequences: parsed?.events?.map((e) => e.sequence) ?? [],
      bytes: body ? new TextEncoder().encode(body).length : 0,
    }
    seen.push(entry)
    const queued = state.replies.shift()
    if (queued instanceof Error) throw queued
    if (queued) return queued
    if (parsed?.events) {
      if (parsed.events.length > state.maxEvents) {
        // Refused before it reached the cloud: nothing of it counts as sent.
        entry.sequences = []
        return jsonResponse({ error: 'batch_too_large' }, 413)
      }
      if (state.corruptSequence !== null) {
        body = JSON.stringify({
          events: parsed.events.map((e) =>
            e.sequence === state.corruptSequence ? { ...e, business_day: 'nunca' } : e,
          ),
        })
      }
    }
    const request = { ...init, body }
    const r = await toCloud(input, request)
    if (uploads) {
      state.posts += 1
      await state.afterPost?.(state.posts)
      if (state.duplicatePosts) await toCloud(input, request)
      if (state.loseNextAnswers > 0) {
        state.loseNextAnswers -= 1
        throw new TypeError('the answer was lost')
      }
      if (state.posts >= state.downAfterPosts) state.up = false
    }
    return r
  }
  return {
    state,
    seen,
    fetchCloud,
    posts: () => seen.filter((s) => s.method === 'POST' && s.route === '/v1/events'),
    gets: () => seen.filter((s) => s.method === 'GET'),
    sent: () => seen.flatMap((s) => s.sequences),
  }
}

function hub(options: { autoWake?: boolean; maxBatchBytes?: number; hubClock?: () => Date } = {}) {
  cloud.clock.now = new Date('2026-10-26T15:00:00.000Z')
  const m = setupAccess()
  const dir = mkdtempSync(join(tmpdir(), 'hub-resilience-'))
  folders.push(dir)
  const register = m.pair('register')
  const waiter = m.pair('waiter')
  const session = m.signIn(register.connection, 'cashier')
  const received: HubMessage[] = []
  const waiterReceived: HubMessage[] = []
  let connection: CloudConnection | null = null
  const floor = prepareSync(m.db, dir, m.restaurantId, m.access, undefined, {
    onSave: () => {
      if (options.autoWake) setImmediate(() => connection?.uploader.wake())
    },
  })
  const hello = (token: string, into: HubMessage[]) => {
    const link = floor.connect((message) => into.push(JSON.parse(JSON.stringify(message))))
    link.receive({
      type: 'hello',
      token,
      hub_instance: null,
      until: 0,
      version_app: 'test',
    })
    return link
  }
  const link = hello(register.token, received)
  hello(waiter.token, waiterReceived)
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
  const timers = manualTimers()
  const statuses: CloudStatus[] = []
  const make = () => {
    const c = new CloudConnection({
      db: m.db,
      restaurantId: m.restaurantId,
      dataDir: dir,
      instance: 'instancia-de-prueba',
      url: 'https://cloud.faro.test',
      fetch: net.fetchCloud,
      clock: options.hubClock ?? (() => cloud.clock.now),
      onStatus: (s) => {
        statuses.push(s)
        floor.notifyCloud(s)
      },
      uploader: {
        timers: timers.timers,
        ...(options.maxBatchBytes ? { maxBatchBytes: options.maxBatchBytes } : {}),
      },
    })
    connection = c
    return c
  }
  let current = make()
  const settle = async () => {
    current.uploader.wake()
    await flush()
    await current.uploader.idle()
  }
  /** The hub is turned off and on again: same database, same data folder, new process. */
  const restart = () => {
    current.uploader.stop()
    current = make()
    return current
  }
  const inCloud = async () => {
    const r = await cloud.db.query<{ s: string }>(
      'SELECT hub_sequence::text AS s FROM events WHERE restaurant_id = $1 ORDER BY hub_sequence',
      [m.restaurantId],
    )
    return r.rows.map((x) => Number(x.s))
  }
  const confirmedCounter = () =>
    m.db
      .prepare('SELECT value FROM counters WHERE restaurant_id = ? AND name = ?')
      .get(m.restaurantId, 'cloud_confirmed')?.value
  const newCode = async () => {
    await cloud.cloud.createRestaurant({ id: m.restaurantId, name: 'La Spritzzería' })
    const c = await cloud.cloud.createCode(m.restaurantId)
    if (!c) throw new Error('no code')
    return c.code
  }
  const connect = async () => {
    const r = await current.register(await newCode())
    expect(r).toEqual({ ok: true })
  }
  return {
    m,
    dir,
    net,
    timers,
    statuses,
    received,
    waiterReceived,
    floor,
    openOrders,
    settle,
    restart,
    inCloud,
    confirmedCounter,
    newCode,
    connect,
    get connection() {
      return current
    },
  }
}

const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('a lot of events', () => {
  it('uploads more than 1000 events in batches, in order, once each', async () => {
    const h = hub()
    h.openOrders(1250)
    await h.connect()
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toEqual(upTo(1250))
    expect(h.net.posts().map((p) => p.sequences.length)).toEqual([500, 500, 250])
    expect(h.confirmedCounter()).toBe(1250)
  }, 60_000)

  it('big batches are split by bytes and arrive complete and in order', async () => {
    const h = hub({ maxBatchBytes: 3_000 })
    h.openOrders(60)
    await h.connect()
    await h.settle()
    const posts = h.net.posts()
    expect(posts.length).toBeGreaterThan(5)
    for (const p of posts) expect(p.bytes).toBeLessThanOrEqual(3_000 + 64)
    expect(await h.inCloud()).toEqual(upTo(60))
    expect(h.net.sent()).toEqual(upTo(60))
  })

  it('a 413 from the cloud shrinks the batch and the upload finishes without gaps or repeats', async () => {
    const h = hub()
    h.openOrders(300)
    h.net.state.maxEvents = 70
    await h.connect()
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toEqual(upTo(300))
    // 300 → 150 → 75 → 37: nothing was ever sent twice.
    expect(h.net.sent()).toEqual(upTo(300))
  })

  it('with the hub saving while it uploads (the real hook), everything ends up in the cloud', async () => {
    const h = hub({ autoWake: true })
    await h.connect()
    await h.settle()
    for (let i = 0; i < 5; i++) {
      h.openOrders(3)
      await flush()
      await h.connection.uploader.idle()
    }
    await h.settle()
    expect(await h.inCloud()).toEqual(upTo(15))
  })
})

describe('cuts and lost answers', () => {
  it('a cut in the middle of 1200 events keeps the first 500 and sends the rest later without repeats', async () => {
    const h = hub()
    h.openOrders(1200)
    h.net.state.downAfterPosts = 1
    await h.connect()
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'offline', pending: 700 })
    expect(await h.inCloud()).toEqual(upTo(500))
    expect(h.confirmedCounter()).toBe(500)
    h.net.state.up = true
    h.net.state.downAfterPosts = Number.POSITIVE_INFINITY
    h.timers.fire()
    await h.connection.uploader.idle()
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toEqual(upTo(1200))
    expect(h.net.sent()).toEqual(upTo(1200))
  }, 60_000)

  it('the answer lost after the cloud saved: the retry stores nothing twice', async () => {
    const h = hub()
    h.openOrders(40)
    await h.connect()
    await h.connection.uploader.idle()
    h.openOrders(10)
    h.net.state.loseNextAnswers = 1
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'offline', pending: 10 })
    // The cloud already has them.
    expect(await h.inCloud()).toEqual(upTo(50))
    h.timers.fire()
    await h.connection.uploader.idle()
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toEqual(upTo(50))
    expect(h.confirmedCounter()).toBe(50)
  })

  it('every batch delivered twice by the network does not duplicate anything', async () => {
    const h = hub()
    h.net.state.duplicatePosts = true
    h.openOrders(30)
    await h.connect()
    await h.settle()
    expect(await h.inCloud()).toEqual(upTo(30))
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
  })

  it('internet down for a long time: the dining room goes on and only one retry is ever scheduled', async () => {
    const h = hub({ autoWake: true })
    await h.connect()
    await h.settle()
    h.net.state.up = false
    for (let i = 0; i < 20; i++) {
      h.openOrders(1)
      await flush()
      await h.connection.uploader.idle()
    }
    expect(h.connection.status()).toMatchObject({ state: 'offline', pending: 20 })
    expect(h.timers.count()).toBe(1)
    h.net.state.up = true
    h.timers.fire()
    await h.connection.uploader.idle()
    expect(await h.inCloud()).toEqual(upTo(20))
  })

  it('the cloud answering 500, then a broken page, then fine: the hub keeps trying and ends up to date', async () => {
    const h = hub()
    h.openOrders(5)
    await h.connect()
    await h.connection.uploader.idle()
    h.openOrders(5)
    h.net.state.replies.push(
      jsonResponse({ error: 'internal_error' }, 500),
      new Response('<html>bad gateway</html>', { status: 502 }),
      new Response('{"last_', { status: 200 }),
    )
    await h.settle()
    for (let i = 0; i < 3; i++) {
      expect(h.connection.status().state).toBe('offline')
      h.timers.fire()
      await h.connection.uploader.idle()
    }
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toEqual(upTo(10))
  })

  it('a clock far off on the hub does not stop the upload or reorder anything', async () => {
    const h = hub({ hubClock: () => new Date('2031-01-01T00:00:00.000Z') })
    h.openOrders(8)
    await h.connect()
    await h.settle()
    expect(await h.inCloud()).toEqual(upTo(8))
    expect(h.connection.status().last_upload_at).toBe('2031-01-01T00:00:00.000Z')
  })
})

describe('restarting the hub', () => {
  it('without internet the pending count is right as soon as it starts', async () => {
    const h = hub()
    h.openOrders(10)
    await h.connect()
    await h.settle()
    h.openOrders(4)
    h.net.state.up = false
    await h.settle()
    const restarted = h.restart()
    expect(restarted.status()).toEqual({ state: 'offline', pending: 4, last_upload_at: null })
    await h.settle()
    expect(restarted.status()).toMatchObject({ state: 'offline', pending: 4 })
    expect(h.confirmedCounter()).toBe(10)
  })

  it('when internet returns it asks the cloud and sends only what is missing', async () => {
    const h = hub()
    h.openOrders(10)
    await h.connect()
    await h.settle()
    h.openOrders(4)
    h.net.state.up = false
    await h.settle()
    h.restart()
    h.net.state.up = true
    const before = h.net.seen.length
    await h.settle()
    const after = h.net.seen.slice(before)
    expect(after.filter((s) => s.method === 'GET')).toHaveLength(1)
    expect(after.flatMap((s) => s.sequences)).toEqual([11, 12, 13, 14])
    expect(await h.inCloud()).toEqual(upTo(14))
  })

  it('everything already in the cloud and a counter that was not saved: it asks and sends nothing', async () => {
    const h = hub()
    h.openOrders(25)
    await h.connect()
    await h.settle()
    // The hub went down after the cloud saved but before it wrote its counter.
    h.m.db
      .prepare('UPDATE counters SET value = 0 WHERE restaurant_id = ? AND name = ?')
      .run(h.m.restaurantId, 'cloud_confirmed')
    const restarted = h.restart()
    expect(restarted.status().pending).toBe(25)
    const before = h.net.posts().length
    await h.settle()
    expect(h.net.posts()).toHaveLength(before)
    expect(restarted.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(h.confirmedCounter()).toBe(25)
  })

  it('a counter row that is missing is the same as zero: it asks the cloud and resends nothing extra', async () => {
    const h = hub()
    h.openOrders(12)
    await h.connect()
    await h.settle()
    h.m.db
      .prepare('DELETE FROM counters WHERE restaurant_id = ? AND name = ?')
      .run(h.m.restaurantId, 'cloud_confirmed')
    const restarted = h.restart()
    expect(restarted.status().pending).toBe(12)
    const before = h.net.posts().length
    await h.settle()
    expect(h.net.posts()).toHaveLength(before)
    expect(h.confirmedCounter()).toBe(12)
    expect(await h.inCloud()).toEqual(upTo(12))
  })

  it('the hub stopped in the middle of an upload continues where the cloud has it, once each', async () => {
    const h = hub()
    h.openOrders(1100)
    h.net.state.downAfterPosts = 1
    await h.connect()
    await h.settle()
    expect(await h.inCloud()).toEqual(upTo(500))
    // The process dies here; the new one starts with internet.
    h.net.state.up = true
    h.net.state.downAfterPosts = Number.POSITIVE_INFINITY
    h.restart()
    await h.settle()
    expect(await h.inCloud()).toEqual(upTo(1100))
    expect(h.net.sent()).toEqual(upTo(1100))
  }, 60_000)

  it('the link survives the restart: no new code is needed', async () => {
    const h = hub()
    h.openOrders(3)
    await h.connect()
    await h.settle()
    const hubId = readLink(h.dir)?.hubId
    const restarted = h.restart()
    h.openOrders(2)
    await h.settle()
    expect(readLink(h.dir)?.hubId).toBe(hubId)
    expect(restarted.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toEqual(upTo(5))
  })

  it('a cloud that claims more than the hub has is stuck, and the hub sends nothing', async () => {
    const h = hub()
    h.openOrders(20)
    await h.connect()
    await h.settle()
    h.net.state.replies.push(jsonResponse({ last_sequence: 999 }))
    const restarted = h.restart()
    const before = h.net.posts().length
    await h.settle()
    expect(restarted.status().state).toBe('stuck')
    expect(h.net.posts()).toHaveLength(before)
    expect(h.timers.waits()).toEqual([STUCK_RETRY_MS])
  })
})

describe('an event the cloud cannot save', () => {
  it('stays stuck at that event, keeps the ones before it, and retries only every 5 minutes', async () => {
    const h = hub()
    h.openOrders(10)
    h.net.state.corruptSequence = 4
    await h.connect()
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'stuck', pending: 7 })
    // The cloud keeps the valid ones after it, but the confirmed sequence stops at 3.
    expect(await h.inCloud()).not.toContain(4)
    expect(h.confirmedCounter()).toBe(3)
    expect(h.timers.waits()).toEqual([STUCK_RETRY_MS])
    // New events and wakes do not hit the cloud.
    const calls = h.net.seen.length
    for (let i = 0; i < 10; i++) {
      h.openOrders(1)
      await h.settle()
    }
    expect(h.net.seen).toHaveLength(calls)
    expect(h.connection.status()).toMatchObject({ state: 'stuck', pending: 17 })
  })

  it('each 5-minute retry is a single request, and once the cloud accepts the event it goes on', async () => {
    const h = hub()
    h.openOrders(10)
    h.net.state.corruptSequence = 4
    await h.connect()
    await h.settle()
    const before = h.net.posts().length
    h.timers.fire()
    await h.connection.uploader.idle()
    expect(h.net.posts()).toHaveLength(before + 1)
    expect(h.connection.status().state).toBe('stuck')
    h.net.state.corruptSequence = null
    h.timers.fire()
    await h.connection.uploader.idle()
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toEqual(upTo(10))
  })

  it('the stuck state reaches the register screens with the pending count', async () => {
    const h = hub()
    h.openOrders(6)
    h.net.state.corruptSequence = 2
    await h.connect()
    await h.settle()
    const last = h.received.filter((r) => r.type === 'cloud').at(-1)
    expect(last).toMatchObject({ type: 'cloud', cloud: { state: 'stuck', pending: 5 } })
  })
})

describe('revoked and connected again', () => {
  it('revoked in the middle of a big upload: stops at the first 401, keeps the count and makes no more requests', async () => {
    const h = hub()
    h.openOrders(1200)
    // The cloud revokes this hub right after saving the first batch.
    h.net.state.afterPost = async (n) => {
      if (n === 1) await cloud.cloud.revokeHub(readLink(h.dir)?.hubId as string)
    }
    await h.connect()
    await h.connection.uploader.idle()
    expect(h.connection.status()).toMatchObject({ state: 'revoked', pending: 700 })
    expect(h.confirmedCounter()).toBe(500)
    const calls = h.net.seen.length
    for (let i = 0; i < 5; i++) {
      h.openOrders(1)
      await h.settle()
    }
    h.timers.fire()
    await h.connection.uploader.idle()
    expect(h.net.seen).toHaveLength(calls)
    expect(h.timers.count()).toBe(0)
    expect(h.connection.status()).toMatchObject({ state: 'revoked', pending: 705 })
  }, 60_000)

  it('connected again, it resends everything the cloud already had and the cloud stays without repeats', async () => {
    const h = hub()
    h.openOrders(600)
    await h.connect()
    await h.settle()
    await cloud.cloud.revokeHub(readLink(h.dir)?.hubId as string)
    h.openOrders(50)
    await h.settle()
    expect(h.connection.status().state).toBe('revoked')
    expect(await h.connection.register(await h.newCode())).toEqual({ ok: true })
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(await h.inCloud()).toEqual(upTo(650))
    expect(h.confirmedCounter()).toBe(650)
  }, 60_000)

  it('revoked while offline: it learns it when the internet returns and does not retry', async () => {
    const h = hub()
    h.openOrders(5)
    await h.connect()
    await h.settle()
    h.net.state.up = false
    h.openOrders(2)
    await h.settle()
    await cloud.cloud.revokeHub(readLink(h.dir)?.hubId as string)
    h.net.state.up = true
    h.timers.fire()
    await h.connection.uploader.idle()
    expect(h.connection.status()).toMatchObject({ state: 'revoked', pending: 2 })
    expect(h.timers.count()).toBe(0)
  })

  it('a hub restarted while revoked finds out at the first request', async () => {
    const h = hub()
    h.openOrders(5)
    await h.connect()
    await h.settle()
    await cloud.cloud.revokeHub(readLink(h.dir)?.hubId as string)
    const restarted = h.restart()
    expect(restarted.status().state).toBe('offline')
    await h.settle()
    expect(restarted.status().state).toBe('revoked')
    expect(await restarted.register(await h.newCode())).toEqual({ ok: true })
  })
})

describe('registering against the real cloud', () => {
  it('an expired code is refused and a new one works', async () => {
    const h = hub()
    const old = await h.newCode()
    cloud.clock.now = new Date(cloud.clock.now.getTime() + 25 * 60 * 60 * 1000)
    expect(await h.connection.register(old)).toMatchObject({ ok: false, code: 'invalid_code' })
    expect(h.connection.status().state).toBe('not_connected')
    const fresh = await cloud.cloud.createCode(h.m.restaurantId)
    expect(await h.connection.register(fresh?.code as string)).toEqual({ ok: true })
  })

  it('a code already used by another register PC of the restaurant is refused', async () => {
    const h = hub()
    const code = await h.newCode()
    const other = await cloud.cloud.registerHub({
      code,
      restaurant_id: h.m.restaurantId,
      hub_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      location_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      name: 'Otra caja',
      instance: 'otra',
    })
    expect(other.ok).toBe(true)
    expect(await h.connection.register(code)).toMatchObject({ ok: false, code: 'invalid_code' })
  })

  it('the code is written in lower case and with spaces around: it still works', async () => {
    const h = hub()
    const code = await h.newCode()
    expect(await h.connection.register(`  ${code.toLowerCase()}  `)).toEqual({ ok: true })
  })

  it('a code from another restaurant does not spend it: its owner can still connect', async () => {
    const mine = hub()
    const theirs = hub()
    await mine.newCode()
    const code = await theirs.newCode()
    expect(await mine.connection.register(code)).toMatchObject({ code: 'other_restaurant' })
    expect(await theirs.connection.register(code)).toEqual({ ok: true })
    expect(readLink(mine.dir)?.credential).toBeNull()
  })

  it('two register PCs of the same restaurant typing the same code at once: exactly one connects', async () => {
    const a = hub()
    const code = await a.newCode()
    // A second PC with the same restaurant database and its own data folder.
    const dir = mkdtempSync(join(tmpdir(), 'hub-second-'))
    folders.push(dir)
    const second = new CloudConnection({
      db: a.m.db,
      restaurantId: a.m.restaurantId,
      dataDir: dir,
      instance: 'otro-pc',
      url: 'https://cloud.faro.test',
      fetch: a.net.fetchCloud,
      clock: () => cloud.clock.now,
      uploader: { timers: manualTimers().timers },
    })
    const results = await Promise.all([a.connection.register(code), second.register(code)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)[0]).toMatchObject({ code: 'invalid_code' })
    second.uploader.stop()
  })

  it('without internet, registering says so and leaves the hub exactly as it was', async () => {
    const h = hub()
    h.openOrders(3)
    const code = await h.newCode()
    h.net.state.up = false
    expect(await h.connection.register(code)).toMatchObject({ ok: false, code: 'offline' })
    await h.settle()
    expect(h.connection.status()).toMatchObject({ state: 'not_connected', pending: 3 })
    h.net.state.up = true
    expect(await h.connection.register(code)).toEqual({ ok: true })
    await h.settle()
    expect(await h.inCloud()).toEqual(upTo(3))
  })
})

describe('what the devices are told', () => {
  it('every device (also a waiter) gets the status when it changes, and none contains the credential', async () => {
    const h = hub()
    h.openOrders(3)
    await h.connect()
    await h.settle()
    h.net.state.up = false
    h.openOrders(2)
    await h.settle()
    const credential = readLink(h.dir)?.credential as string
    expect(credential.length).toBeGreaterThan(10)
    for (const messages of [h.received, h.waiterReceived]) {
      const clouds = messages.filter((m) => m.type === 'cloud')
      expect(clouds.length).toBeGreaterThan(0)
      expect(clouds.at(-1)).toMatchObject({ cloud: { state: 'offline', pending: 2 } })
      expect(JSON.stringify(messages)).not.toContain(credential)
    }
    expect(JSON.stringify(h.statuses)).not.toContain(credential)
    expect(JSON.stringify(h.connection.status())).not.toContain(credential)
  })

  it('a device that connects later gets the latest status right after the welcome', async () => {
    const h = hub()
    h.openOrders(3)
    await h.connect()
    await h.settle()
    const late: HubMessage[] = []
    const link = h.floor.connect((message) => late.push(JSON.parse(JSON.stringify(message))))
    const register = h.m.pair('register')
    link.receive({
      type: 'hello',
      token: register.token,
      hub_instance: null,
      until: 0,
      version_app: 'test',
    })
    expect(late[0]?.type).toBe('welcome')
    expect(late[1]).toMatchObject({ cloud: { state: 'up_to_date', pending: 0 } })
  })

  it('the file with the credential is not readable by the group or others', async () => {
    const h = hub()
    await h.connect()
    expect(statSync(join(h.dir, 'cloud-link.json')).mode & 0o077).toBe(0)
  })
})
