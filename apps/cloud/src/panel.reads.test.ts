import { newId, type OrderEvent } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { type ApiEnv, handle } from './api'
import { clearLastWeekCache, Panel, type PanelSession } from './panel'
import type { Sql } from './sql'
import { panelRequest } from './testing/panel'
import { person, publish, signInAs } from './testing/session'
import { createWorld, type TestHub, type World } from './testing/world'

// How the panel reads (review 1.11c-2): every read is one snapshot of the database and writes
// nothing (point 3); last week's day on the dashboard is read once it cannot change, with the same
// numbers (point 7); and the hub's heartbeat tells the panels «back» once, and never for a hub that
// is gone (point 12).

let m: World
let hub: TestHub
let cookie: string

beforeEach(async () => {
  clearLastWeekCache()
  m = await createWorld()
  hub = await m.newHub()
  const owner = person(['remote_access', 'view_reports'], 'Dueña')
  await publish(m, hub, [owner])
  cookie = await signInAs(m, hub, owner)
})

/** An `Sql` that writes down every statement, transaction by transaction. */
function recording(sql: Sql) {
  const transactions: string[][] = []
  const wrap = (inner: Sql, log: string[] | null): Sql => ({
    query: (text, params) => {
      log?.push(text)
      return inner.query(text, params)
    },
    execute: (script) => inner.execute(script),
    transaction: (job) =>
      inner.transaction((tx) => {
        const list: string[] = []
        transactions.push(list)
        return job(wrap(tx, list))
      }),
  })
  return { sql: wrap(sql, null), transactions }
}

const sessionOf = async (): Promise<PanelSession> => {
  const s = await new Panel(m.sql, () => m.clock.now).session(cookie)
  if (!s) throw new Error('no session')
  return s
}

const READ_ONLY = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'

describe('every read of the panel is one snapshot and writes nothing', () => {
  it('me, summary, reports, floor, register and alerts open their transaction read-only first', async () => {
    const session = await sessionOf()
    const r = recording(m.sql)
    const panel = new Panel(r.sql, () => m.clock.now)
    await panel.me(session)
    await panel.summary(session)
    await panel.report(session)
    await panel.floor(session, null)
    await panel.register(session)
    await panel.alerts(session)
    expect(r.transactions).toHaveLength(6)
    for (const statements of r.transactions) expect(statements[0]).toBe(READ_ONLY)
  })

  it('a write inside a panel read fails (READ ONLY is real, not a comment)', async () => {
    const { inRestaurant } = await import('./cloud')
    await expect(
      inRestaurant(
        m.sql,
        hub.restaurantId,
        (tx) => tx.query("UPDATE hubs SET name = 'x' WHERE id = $1", [hub.hub.id]),
        { readOnly: true },
      ),
    ).rejects.toThrow()
  })
})

// ── Last week's day on the dashboard ──

const TODAY = '2026-10-26'
const LAST_WEEK = '2026-10-19'

/** A paid and closed order of `day`, from sequence `from` on (4 events). */
function closedOrder(day: string, from: number, price = 40_000): OrderEvent[] {
  const order = newId()
  const at = { business_day: day, received_at: `${day}T14:00:00.000Z` }
  return [
    event(order, 'OrderOpened', { channel: 'takeout', table_id: null, guests: 1 }, at),
    event(order, 'ItemAdded', itemCopy({ unit_price: price }), at),
    event(order, 'PaymentRecorded', cashPaymentData(price), at),
    event(order, 'OrderClosed', {}, at),
  ].map((e, i) => ({ ...e, sequence: from + i }))
}

const upload = (events: readonly OrderEvent[], credential = hub.credential) =>
  handle(
    new Request('https://cloud.faro.test/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    }),
    { sql: m.sql, clock: () => m.clock.now },
  )

const summary = async () => {
  const r = await panelRequest(m, 'GET', '/v1/panel/summary', { cookie })
  expect(r.status).toBe(200)
  return (await r.json()) as {
    last_week: {
      report_until_now: { sales: { net: number } }
      report_full: { sales: { net: number } }
    }
  }
}

describe('the dashboard reads last week’s day once it cannot change', () => {
  it('the same numbers, with fewer reads; a late event of that day is counted at once', async () => {
    await upload([...closedOrder(LAST_WEEK, 1), ...closedOrder(TODAY, 5)])
    const first = await summary()
    expect(first.last_week.report_full.sales.net).toBe(40_000)

    const session = await sessionOf()
    const counted = async () => {
      const r = recording(m.sql)
      const s = await new Panel(r.sql, () => m.clock.now).summary(session)
      return { s, statements: r.transactions.flat().length }
    }
    clearLastWeekCache()
    const cold = await counted()
    const warm = await counted()
    expect({ ...warm.s, server_now: null }).toEqual({ ...cold.s, server_now: null })
    expect(warm.statements).toBeLessThan(cold.statements)

    // An offline device's event that the hub put in last week's day arrives now (a new sequence).
    await upload(closedOrder(LAST_WEEK, 9, 10_000))
    const after = await summary()
    expect(after.last_week.report_full.sales.net).toBe(50_000)
    // The same as without anything kept.
    clearLastWeekCache()
    expect(await summary()).toEqual({ ...after, server_now: expect.any(String) })
  })

  it('while that day is not complete in the cloud (a gap), it is read every time', async () => {
    // Sequences 1..4 and 9..12 of last week: 5..8 never arrived.
    await upload([...closedOrder(LAST_WEEK, 1), ...closedOrder(LAST_WEEK, 9, 10_000)])
    expect((await summary()).last_week.report_full.sales.net).toBe(50_000)
    // The gap arrives: another sale of that day.
    await upload(closedOrder(LAST_WEEK, 5, 5_000))
    expect((await summary()).last_week.report_full.sales.net).toBe(55_000)
  })
})

// ── The heartbeat ──

describe('the hub’s heartbeat', () => {
  const notices: { room: string; reason: string }[] = []
  const environment: Partial<ApiEnv> = {
    live: {
      connect: async () => new Response(null, { status: 500 }),
      notify: async (room, reason) => {
        notices.push({ room, reason })
      },
      closeSession: async () => 0,
    },
    waitUntil: () => {},
  }
  const last = (credential = hub.credential) =>
    handle(
      new Request('https://cloud.faro.test/v1/events/last', {
        headers: { authorization: `Bearer ${credential}` },
      }),
      { sql: m.sql, clock: () => m.clock.now, ...environment },
    )

  beforeEach(() => {
    notices.length = 0
  })

  it('two calls at the same time after a silence: only one «back_online»', async () => {
    await Promise.all([last(), last()])
    await new Promise((r) => setTimeout(r, 0))
    expect(notices.map((n) => n.reason)).toEqual(['back_online'])
  })

  it('a hub revoked between its credential check and its heartbeat: nothing written, nobody told', async () => {
    const authenticated = await m.cloud.authenticate(hub.credential)
    if (!authenticated) throw new Error('no hub')
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(true)
    expect(await m.cloud.heartbeat(authenticated, 10)).toBeNull()
    const [row] = (
      await m.db.query<{ last_seen_at: unknown; hub_max_sequence: unknown }>(
        'SELECT last_seen_at, hub_max_sequence FROM hubs WHERE id = $1',
        [hub.hub.id],
      )
    ).rows
    expect(row?.hub_max_sequence).not.toBe(10)
  })

  it('the first call of its life is «back»; a call with no silence before is not', async () => {
    const fresh = await m.newHub()
    expect(await m.cloud.heartbeat(fresh.hub, null)).toEqual({ previous: null })
    const again = await m.cloud.heartbeat(fresh.hub, null)
    expect(again?.previous).toEqual(m.clock.now)
  })
})
