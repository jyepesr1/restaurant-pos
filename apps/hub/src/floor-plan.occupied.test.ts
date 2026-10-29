import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId, signEvent } from '@pos/core'
import type { SqliteDatabase } from '@pos/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readMenu } from './seed/menu'
import { seed } from './seed/seed'
import { openData, prepareAccess } from './startup'

// The rule «a table with an open order is not archived» through the real path: the hub process
// (`src/main.ts`, which is what connects the floor with catalog editing), a real order opened
// over WebSocket and the editing over HTTP. Without this, a change in the `main.ts` wiring would
// leave the rule dead without any test noticing.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))
const MENU = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

interface StartedHub {
  child: ChildProcess
  output: () => string
  stop: () => Promise<void>
}

function start(env: Record<string, string>): Promise<StartedHub> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let text = ''
  const accumulate = (chunk: Buffer) => {
    text += String(chunk)
  }
  child.stdout?.on('data', accumulate)
  child.stderr?.on('data', accumulate)
  const finished = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return new Promise((resolve, reject) => {
    const review = () => {
      if (!text.includes('Hub en marcha')) return
      child.stdout?.off('data', review)
      resolve({
        child,
        output: () => text,
        stop: async () => {
          child.kill('SIGKILL')
          await finished
        },
      })
    }
    child.stdout?.on('data', review)
    child.once('exit', (code) =>
      reject(new Error(`The hub exited with code ${code} before starting:\n${text}`)),
    )
  })
}

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON responses.
type Json = Record<string, any>

/** A device connected over WebSocket: collects what arrives and lets you await a message. */
function connectWs(url: string, token: string) {
  const ws = new WebSocket(url)
  const received: Json[] = []
  const waiting: { meets: (m: Json) => boolean; resolve: (m: Json) => void }[] = []
  ws.addEventListener('message', (e) => {
    const message = JSON.parse(String(e.data)) as Json
    received.push(message)
    for (const [i, w] of waiting.entries())
      if (w.meets(message)) {
        waiting.splice(i, 1)
        w.resolve(message)
        break
      }
  })
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('The WebSocket did not open')))
  })
  const wait = (type: string, meets: (m: Json) => boolean = () => true) => {
    const already = received.find((m) => m.type === type && meets(m))
    if (already) return Promise.resolve(already)
    return new Promise<Json>((resolve) =>
      waiting.push({ meets: (m) => m.type === type && meets(m), resolve }),
    )
  }
  const send = (m: object) => ws.send(JSON.stringify(m))
  return {
    ws,
    received,
    wait,
    send,
    async sayHello() {
      await opened
      send({ type: 'hello', token, hub_instance: null, until: 0, version_app: 'test' })
      return wait('welcome')
    },
    close: () => ws.close(),
  }
}

describe('occupied table through the real hub path (main.ts)', () => {
  let folder = ''
  let hub: StartedHub | undefined
  const openSockets: { close: () => void }[] = []

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pos-occupied-'))
  })
  afterEach(async () => {
    for (const c of openSockets.splice(0)) c.close()
    await hub?.stop()
    hub = undefined
    rmSync(folder, { recursive: true, force: true })
  })

  /** Seeds the dining room (with staff) and leaves the folder ready for the hub to start. */
  function prepareDir() {
    const dataDir = join(folder, 'data')
    const { db } = openData(dataDir)
    const access = prepareAccess(db, dataDir)
    const { pins } = seed(
      db,
      access.access,
      { restaurantId: access.restaurantId, roles: access.roles, menu: readMenu(MENU) },
      new Date().toISOString(),
    )
    ;(db as SqliteDatabase & { close(): void }).close()
    /** What each person signs in with: username and password if any (ADR-013), otherwise PIN. */
    const credentialsOf = (name: string) => {
      if (name === 'Administrador')
        return {
          user: access.admin.user as string,
          password: access.admin.password as string,
        }
      const p = pins.find((x) => x.name === name)
      return p?.user ? { user: p.user, password: p.password as string } : { pin: p?.pin as string }
    }
    return { dataDir, credentialsOf }
  }

  async function spinUp(dataDir: string, port: number) {
    hub = await start({
      DATA_DIR: dataDir,
      APP_DIR: join(folder, 'no-app'),
      PORT: String(port),
    })
  }

  async function scenario() {
    const { dataDir, credentialsOf } = prepareDir()
    const port = await freePort()
    await spinUp(dataDir, port)
    const url = `http://127.0.0.1:${port}`
    const post = async (route: string, body: object, token?: string) => {
      const r = await fetch(url + route, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })
      return { code: r.status, body: (await r.json()) as Json }
    }
    const get = async (route: string, token: string) =>
      (await (
        await fetch(url + route, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as Json

    // They sign in without pairing (ADR-013): the hub registers each device.
    const pair = async (type: 'register' | 'waiter', _name: string) => {
      const { body: r } = await post(
        '/api/sign-in',
        credentialsOf(type === 'register' ? 'Administrador' : 'Mesero 2'),
      )
      return r.device as { token: string; device_id: string }
    }
    const register = await pair('register', 'Caja')
    const phone = await pair('waiter', 'Celular')
    const session = async (device: { token: string }, name: string) =>
      (await post('/api/sign-in', credentialsOf(name), device.token)).body as Json
    const manager = await session(register, 'Administrador')
    const waiter = await session(phone, 'Mesero 1')

    const wsUrl = `${url.replace('http', 'ws')}/api/sync/ws`
    const onPhone = connectWs(wsUrl, phone.token)
    const atRegister = connectWs(wsUrl, register.token)
    openSockets.push(onPhone, atRegister)
    await onPhone.sayHello()
    await atRegister.sayHello()

    /** Signed event from a device; `base` is the latest that device knows from the hub. */
    const event = (
      who: { device_id: string },
      s: Json,
      order: string,
      type: string,
      data: object,
      base: number,
    ) => {
      const now = new Date().toISOString()
      const e = {
        id: newId(),
        type,
        schema_version: 1,
        aggregate_type: 'order',
        aggregate_id: order,
        related: [],
        data,
        session_id: s.session_id,
        user_id: s.user.id,
        device_id: who.device_id,
        authorization_id: null,
        reason: type === 'OrderCanceled' || type === 'OrderReopened' ? 'Prueba' : null,
        device_time: now,
        hub_estimated_time: now,
        base_sequence: base,
      }
      return { ...e, signature: signEvent(e as never, s.secret) }
    }
    const push = async (ws: ReturnType<typeof connectWs>, e: Json): Promise<Json> => {
      const batch = newId()
      ws.send({ type: 'push', batch_id: batch, events: [e] })
      const r = await ws.wait('result', (m) => m.batch_id === batch)
      return r.results[0]
    }
    const edit = (changes: object[]) =>
      post(
        '/api/catalog/changes',
        { session_id: manager.session_id, secret: manager.secret, changes },
        register.token,
      )
    const catalog = () => get('/api/catalog', register.token)
    const tableByName = async (name: string) => {
      const c = await catalog()
      const m = (c.tables as Json[]).find((x) => x.name === name)
      if (!m) throw new Error(`Table ${name} not found`)
      return m.id as string
    }
    return {
      dataDir,
      port,
      post,
      register,
      phone,
      manager,
      waiter,
      atRegister,
      onPhone,
      event,
      push,
      edit,
      catalog,
      tableByName,
      session,
      wsUrl,
    }
  }

  const archive = (id: string) => [{ entity: 'dining_tables', id, data: { active: false } }]

  it('with an order open over WebSocket the table is not archived; once closed, it is', async () => {
    const e = await scenario()
    const table = await e.tableByName('5')
    const order = newId()
    const opened = await e.push(
      e.onPhone,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: table, guests: 2 },
        0,
      ),
    )
    expect(opened.status).toBe('confirmed')

    const blocked = await e.edit(archive(table))
    expect(blocked.code).toBe(400)
    expect(blocked.body.message).toMatch(/la mesa 5 tiene un pedido abierto/)
    expect(((await e.catalog()).tables as Json[]).some((m) => m.id === table)).toBe(true)

    // Archiving a free table along with the occupied one fails too: saving is all or nothing.
    const another = await e.tableByName('6')
    const combined = await e.edit([...archive(another), ...archive(table)])
    expect(combined.code).toBe(400)
    expect(((await e.catalog()).tables as Json[]).some((m) => m.id === another)).toBe(true)

    // The register closes the order (empty: balance 0) and then the table is free.
    const closed = await e.push(
      e.atRegister,
      e.event(e.register, e.manager, order, 'OrderClosed', {}, opened.acceptance.sequence),
    )
    expect(closed.status).toBe('confirmed')
    const free = await e.edit(archive(table))
    expect(free).toMatchObject({ code: 200, body: { changedCount: 1 } })
    expect(((await e.catalog()).tables as Json[]).some((m) => m.id === table)).toBe(false)
  })

  it('a canceled order also frees the table', async () => {
    const e = await scenario()
    const table = await e.tableByName('8')
    const order = newId()
    const opened = await e.push(
      e.onPhone,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: table, guests: 1 },
        0,
      ),
    )
    expect((await e.edit(archive(table))).code).toBe(400)
    const canceled = await e.push(
      e.atRegister,
      e.event(e.register, e.manager, order, 'OrderCanceled', {}, opened.acceptance.sequence),
    )
    expect(canceled.status).toBe('confirmed')
    expect((await e.edit(archive(table))).code).toBe(200)
  })

  it('when moving the order to another table, the old one is freed and the new one is protected', async () => {
    const e = await scenario()
    const source = await e.tableByName('1')
    const target = await e.tableByName('2')
    const order = newId()
    const opened = await e.push(
      e.onPhone,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: source, guests: 1 },
        0,
      ),
    )
    const moved = await e.push(
      e.onPhone,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderMovedTable',
        { target_table_id: target },
        opened.acceptance.sequence,
      ),
    )
    expect(moved.status).toBe('confirmed')
    expect((await e.edit(archive(target))).code).toBe(400)
    expect((await e.edit(archive(source))).code).toBe(200)
  })

  it('an edit that is applied alerts the connected devices over WebSocket with the new version', async () => {
    const e = await scenario()
    const table = await e.tableByName('10')
    const r = await e.edit([{ entity: 'dining_tables', id: table, data: { x: 900 } }])
    expect(r.code).toBe(200)
    const alert = await e.onPhone.wait('catalog', (m) => m.version === r.body.version)
    expect(alert.version).toBe(r.body.version)
    // A rejected edit does not alert: the next alert that arrives is the one for the good edit.
    const takenPath = await e.tableByName('11')
    const order = newId()
    await e.push(
      e.onPhone,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: takenPath, guests: 1 },
        0,
      ),
    )
    const before = e.onPhone.received.filter((m) => m.type === 'catalog').length
    expect((await e.edit(archive(takenPath))).code).toBe(400)
    expect(e.onPhone.received.filter((m) => m.type === 'catalog')).toHaveLength(before)
  })

  it('if the hub shuts down and comes back with the order open, the table stays protected', async () => {
    const e = await scenario()
    const table = await e.tableByName('12')
    const order = newId()
    const opened = await e.push(
      e.onPhone,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: table, guests: 3 },
        0,
      ),
    )
    expect(opened.status).toBe('confirmed')
    expect(e.port).toBeGreaterThan(0)

    // Outage: the process dies without warning and starts again with the same data folder.
    for (const c of openSockets.splice(0)) c.close()
    await hub?.stop()
    hub = undefined
    await spinUp(e.dataDir, e.port)

    // Devices stay paired and with their session: the hub keeps both.
    const r = await e.edit(archive(table))
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/tiene un pedido abierto/)
  })
})
