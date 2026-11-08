import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handle } from '@pos/cloud/api'
import { ADMIN, createWorld, type World } from '@pos/cloud/testing'
import { RestaurantConfig } from '@pos/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupPrinting } from '../printing/printing-setup'
import { CloudConnection } from './connection'
import { readSnapshots } from './snapshots'
import { manualTimers } from './testing'

// Task 1.13: the cash drawer choice goes from the hub's «Caja y pagos» route to the cloud's
// config snapshot (the real cloud API on embedded Postgres), and only when it says something.

const ORIGIN = 'https://cloud.faro.test'

let cloud: World
beforeAll(async () => {
  cloud = await createWorld()
})

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})

async function connected() {
  const t = setupPrinting()
  const dir = mkdtempSync(join(tmpdir(), 'hub-drawer-cloud-'))
  folders.push(dir)
  const puts: { kind: string; status: number }[] = []
  const hubNow = () => Number(t.clock())
  const fetchCloud: typeof fetch = async (input, init) => {
    const request = new Request(String(input), init)
    cloud.clock.now = new Date(hubNow())
    const r = await handle(request, {
      sql: cloud.sql,
      adminToken: ADMIN,
      clock: () => cloud.clock.now,
    })
    if (request.method === 'PUT')
      puts.push({
        kind: new URL(request.url).pathname.split('/').pop() as string,
        status: r.status,
      })
    return r
  }
  const timers = manualTimers()
  const failures: unknown[] = []
  const connection = new CloudConnection({
    db: t.db,
    restaurantId: t.restaurantId,
    dataDir: dir,
    instance: 'instancia-de-prueba',
    url: ORIGIN,
    fetch: fetchCloud,
    clock: () => new Date(hubNow()),
    onFailure: (e) => failures.push(e),
    uploader: { timers: timers.timers },
    snapshots: () => readSnapshots(t.db, t.restaurantId),
    snapshotOptions: { now: hubNow, refusedRetryMs: 5 * 60_000 },
  })
  const settle = async () => {
    connection.uploader.wake()
    await new Promise((r) => setTimeout(r, 0))
    await connection.idle()
  }
  cloud.clock.now = new Date(hubNow())
  await cloud.cloud.createRestaurant({ id: t.restaurantId, name: 'La Spritzzería' })
  const code = await cloud.cloud.createCode(t.restaurantId)
  if (!code) throw new Error('no code')
  await connection.register(code.code)
  await settle()
  const admin = t.device('admin', 'register')
  const choose = async (printerId: string | null) => {
    const r = await t.post(
      '/api/register/cash-drawer',
      { ...admin.sessionBody, printer_id: printerId },
      admin.token,
    )
    expect(r.statusCode).toBe(204)
    connection.checkSnapshots()
    await settle()
  }
  const stored = async () =>
    (
      await cloud.db.query<{ content: { config: Record<string, unknown> }; fingerprint: string }>(
        "SELECT content, fingerprint FROM snapshots WHERE restaurant_id = $1 AND kind = 'config'",
        [t.restaurantId],
      )
    ).rows[0]
  return { t, connection, puts, failures, choose, stored, settle }
}

describe('the drawer choice reaches the cloud', () => {
  it('chosen: the config snapshot goes up with it and the cloud keeps it; removed: it goes up without it', async () => {
    const w = await connected()
    const before = await w.stored()
    expect(before?.content.config).not.toHaveProperty('cash_drawer_printer_id')
    const printer = w.t.newPrinter('Caja', [])

    await w.choose(printer.id)
    const chosen = await w.stored()
    expect(chosen?.content.config.cash_drawer_printer_id).toBe(printer.id)
    expect(chosen?.fingerprint).not.toBe(before?.fingerprint)
    expect(w.puts.every((p) => p.status === 204)).toBe(true)

    await w.choose(null)
    const removed = await w.stored()
    expect(removed?.content.config).not.toHaveProperty('cash_drawer_printer_id')
    // The same bytes as before the drawer existed: nothing changes for a restaurant without one.
    expect(removed?.fingerprint).toBe(before?.fingerprint)
    expect(w.failures).toEqual([])
  })

  it('the config goes up (with the catalog, whose version moves) and the staff does not', async () => {
    const w = await connected()
    const printer = w.t.newPrinter('Caja', [])
    const before = w.puts.length
    await w.choose(printer.id)
    const kinds = w.puts.slice(before).map((p) => p.kind)
    expect(kinds).toContain('config')
    for (const untouched of ['people', 'roles', 'remote_users'])
      expect(kinds).not.toContain(untouched)
  })

  it('choosing the same printer twice uploads once', async () => {
    const w = await connected()
    const printer = w.t.newPrinter('Caja', [])
    await w.choose(printer.id)
    const count = w.puts.length
    await w.choose(printer.id)
    expect(w.puts).toHaveLength(count)
  })

  it('archiving the drawer’s printer keeps the choice in the snapshot (the hub just stops opening it)', async () => {
    const w = await connected()
    const printer = w.t.newPrinter('Caja', [])
    await w.choose(printer.id)
    w.t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(printer.id)
    w.connection.checkSnapshots()
    await w.settle()
    expect((await w.stored())?.content.config.cash_drawer_printer_id).toBe(printer.id)
  })

  it('what the hub uploads is always something the strict config schema accepts', async () => {
    const w = await connected()
    const printer = w.t.newPrinter('Caja', [])
    for (const id of [null, printer.id, null]) {
      await w.choose(id)
      const snapshot = readSnapshots(w.t.db, w.t.restaurantId).config as { config: unknown }
      expect(RestaurantConfig.safeParse(snapshot.config).success).toBe(true)
    }
  })
})
