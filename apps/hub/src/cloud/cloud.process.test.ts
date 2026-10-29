import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId, signEvent } from '@pos/core'
import type { CloudStatus, HubMessage } from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LINK_FILE, readLink } from './link'

// The real hub process (`src/main.ts`) with a made-up cloud on a local port (task 1.11): the
// wiring that only exists in `main.ts` (the cloud address from `CLOUD_URL`, the upload on every
// saved event, the status sent to the devices, the restart and the shutdown). Nothing waits for a
// fixed time: every wait is for something to happen, with a limit.

const DIR_HUB = fileURLToPath(new URL('../..', import.meta.url))

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

async function until(condition: () => boolean, what: string, limitMs = 8_000) {
  const end = Date.now() + limitMs
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Never happened: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A cloud that registers hubs, keeps events by sequence and can go down or hang. */
async function fakeCloud() {
  const state = {
    mode: 'up' as 'up' | 'down' | 'hang',
    credential: 'credencial-del-proceso',
    events: new Map<number, { id: string; sequence: number }>(),
    requests: [] as { method: string; url: string; authorization: string | null }[],
    registrations: [] as Record<string, unknown>[],
    /** Every sequence that reached the cloud in a batch, in the order they came. */
    sent: [] as number[],
  }
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      state.requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization ?? null,
      })
      if (state.mode === 'down') return req.socket.destroy()
      if (state.mode === 'hang') return
      const answer = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      if (req.url === '/v1/hubs/register') {
        state.registrations.push(body)
        return answer(201, { credential: state.credential, restaurant_id: body.restaurant_id })
      }
      if (req.headers.authorization !== `Bearer ${state.credential}`)
        return answer(401, { error: 'invalid_credential' })
      const contiguous = () => {
        let n = 0
        while (state.events.has(n + 1)) n += 1
        return n
      }
      if (req.url === '/v1/events/last') return answer(200, { last_sequence: contiguous() })
      if (req.url === '/v1/events') {
        for (const e of body.events) {
          state.sent.push(e.sequence)
          state.events.set(e.sequence, e)
        }
        return answer(200, { results: [], last_sequence: contiguous() })
      }
      answer(404, { error: 'not_found' })
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.once('close', () => sockets.delete(s))
  })
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  )
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    uploads: () => state.requests.filter((r) => r.method === 'POST' && r.url === '/v1/events'),
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

interface Started {
  child: ChildProcess
  exited: Promise<number | null>
  output: () => string
  stop: () => Promise<void>
}

function startHub(env: Record<string, string>): Promise<Started> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let text = ''
  const collect = (chunk: Buffer) => {
    text += String(chunk)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  )
  return new Promise((resolve, reject) => {
    const review = () => {
      if (text.includes('Hub en marcha')) {
        child.stdout?.off('data', review)
        resolve({
          child,
          exited,
          output: () => text,
          stop: async () => {
            child.kill('SIGKILL')
            await exited
          },
        })
      }
    }
    child.stdout?.on('data', review)
    child.once('exit', (code) => reject(new Error(`The hub exited with ${code}:\n${text}`)))
  })
}

let folder: string
let hub: Started | undefined
let cloud: Awaited<ReturnType<typeof fakeCloud>>
const sockets: WebSocket[] = []

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'pos-cloud-process-'))
  cloud = await fakeCloud()
})
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close()
  await hub?.stop()
  hub = undefined
  await cloud.close()
  rmSync(folder, { recursive: true, force: true })
})

const environment = async () => ({
  DATA_DIR: join(folder, 'data'),
  APP_DIR: join(folder, 'no-app'),
  PORT: String(await freePort()),
  CLOUD_URL: cloud.url,
})

interface Person {
  url: string
  token: string
  deviceId: string
  userId: string
  sessionId: string
  secret: string
}

async function signIn(env: Record<string, string>): Promise<Person> {
  const file = readFileSync(join(env.DATA_DIR as string, 'pin-administrador.txt'), 'utf8')
  const datum = (label: string) => new RegExp(`${label}:\\s+(\\S+)`).exec(file)?.[1] as string
  const url = `http://127.0.0.1:${env.PORT}`
  const r = await fetch(`${url}/api/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: datum('Usuario'), password: datum('Contraseña') }),
  })
  expect(r.status).toBe(201)
  const j = (await r.json()) as {
    device: { token: string; device_id: string }
    session_id: string
    secret: string
    user: { id: string }
  }
  return {
    url,
    token: j.device.token,
    deviceId: j.device.device_id,
    userId: j.user.id,
    sessionId: j.session_id,
    secret: j.secret,
  }
}

const call = (p: Person, route: string, body: object = {}) =>
  fetch(`${p.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
    body: JSON.stringify({ session_id: p.sessionId, secret: p.secret, ...body }),
  })

/** The WebSocket of the register, collecting what the hub sends. */
async function listen(p: Person) {
  const received: HubMessage[] = []
  const ws = new WebSocket(`ws://${p.url.replace('http://', '')}/api/sync/ws`)
  sockets.push(ws)
  ws.onmessage = (m) => received.push(JSON.parse(String(m.data)))
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('The WebSocket did not open'))
  })
  ws.send(
    JSON.stringify({
      type: 'hello',
      token: p.token,
      hub_instance: null,
      until: 0,
      version_app: 't',
    }),
  )
  let batch = 0
  const open = () => {
    batch += 1
    const now = new Date().toISOString()
    const event = {
      id: newId(),
      type: 'OrderOpened',
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: newId(),
      related: [],
      data: { channel: 'takeout', table_id: null, guests: 0 },
      session_id: p.sessionId,
      user_id: p.userId,
      device_id: p.deviceId,
      authorization_id: null,
      reason: null,
      device_time: now,
      hub_estimated_time: now,
      base_sequence: 0,
    }
    ws.send(
      JSON.stringify({
        type: 'push',
        batch_id: `b${batch}`,
        events: [{ ...event, signature: signEvent(event as never, p.secret) }],
      }),
    )
  }
  const clouds = () =>
    received.filter((m): m is Extract<HubMessage, { type: 'cloud' }> => m.type === 'cloud')
  const latest = (): CloudStatus | undefined => clouds().at(-1)?.cloud
  return { received, open, clouds, latest, ws }
}

describe('the hub process with the cloud', () => {
  it('connects with the code, uploads each event as it is saved and tells the devices', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    const screen = await listen(admin)
    await until(() => screen.latest()?.state === 'not_connected', 'the first status')

    const r = await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })
    expect(r.status).toBe(200)
    expect(Object.keys((await r.json()) as object).sort()).toEqual([
      'last_upload_at',
      'pending',
      'state',
    ])
    // The registration carries the restaurant of this hub, so the cloud can refuse another's code.
    expect(cloud.state.registrations[0]).toMatchObject({ code: 'AAAA-BBBB-CCCC' })
    expect(cloud.state.registrations[0]?.restaurant_id).toHaveLength(26)

    screen.open()
    await until(() => cloud.state.events.size === 1, 'the event reaching the cloud')
    await until(
      () => screen.latest()?.state === 'up_to_date' && screen.latest()?.pending === 0,
      'the up-to-date status',
    )
    screen.open()
    screen.open()
    await until(() => cloud.state.events.size === 3, 'the next events reaching the cloud')
    expect([...cloud.state.events.keys()]).toEqual([1, 2, 3])
  })

  it('the credential stays in a 0600 file and never reaches an answer or a message', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    const screen = await listen(admin)
    const answers: string[] = []
    answers.push(
      await (await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })).text(),
    )
    answers.push(await (await call(admin, '/api/cloud/status')).text())
    answers.push(
      await (await call(admin, '/api/cloud/register', { code: 'DDDD-EEEE-FFFF' })).text(),
    )
    screen.open()
    await until(() => cloud.state.events.size === 1, 'the upload')
    const file = join(env.DATA_DIR as string, LINK_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const credential = readLink(env.DATA_DIR as string)?.credential
    expect(credential).toBe(cloud.state.credential)
    for (const text of [...answers, JSON.stringify(screen.received), hub.output()])
      expect(text).not.toContain(cloud.state.credential)
  })

  it('a restarted hub keeps the link, shows what is pending while the cloud is unreachable and catches up', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    let screen = await listen(admin)
    await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })
    screen.open()
    await until(() => cloud.state.events.size === 1, 'the first event in the cloud')
    screen.ws.close()

    // The PC loses power and the internet at the same time.
    await hub.stop()
    cloud.state.mode = 'down'
    hub = await startHub(env)
    screen = await listen(admin)
    await until(() => screen.latest()?.state === 'offline', 'the offline status after restarting')
    expect(screen.latest()).toMatchObject({ state: 'offline', pending: 0 })
    screen.open()
    screen.open()
    await until(() => screen.latest()?.pending === 2, 'the pending count to grow')
    expect(cloud.state.events.size).toBe(1)

    // Internet comes back: the hub's own retry takes it from the cloud's last sequence.
    cloud.state.mode = 'up'
    await until(() => cloud.state.events.size === 3, 'the pending events reaching the cloud')
    await until(() => screen.latest()?.state === 'up_to_date', 'the up-to-date status')
    // Nothing already in the cloud was sent again.
    expect(cloud.state.sent).toEqual([1, 2, 3])
  })

  it('a device that connects later is told the status right after the welcome', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })
    const late = await listen(admin)
    await until(() => late.latest() !== undefined, 'the status on connect')
    const types = late.received.map((m) => m.type)
    expect(types.indexOf('welcome')).toBeLessThan(types.indexOf('cloud'))
  })

  it('a device cannot send the cloud message itself', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    const screen = await listen(admin)
    await until(() => screen.latest() !== undefined, 'the first status')
    screen.ws.send(
      JSON.stringify({
        type: 'cloud',
        cloud: { state: 'up_to_date', pending: 0, last_upload_at: null },
      }),
    )
    await until(
      () => screen.received.some((m) => m.type === 'error' && m.code === 'invalid_message'),
      'the error answer',
    )
  })

  it('without CLOUD_URL it uses the production address and the hub still starts and serves', async () => {
    const env = { ...(await environment()), CLOUD_URL: '' }
    hub = await startHub(env)
    const admin = await signIn(env)
    const r = await call(admin, '/api/cloud/status')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ state: 'not_connected' })
  })

  it('stopping the hub with a signal while the cloud hangs does not wait for the request to time out', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    const screen = await listen(admin)
    await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })
    await until(() => screen.latest()?.state === 'up_to_date', 'the connection')
    cloud.state.mode = 'hang'
    screen.open()
    await until(() => cloud.uploads().length > 0, 'the request that hangs')
    hub.child.kill('SIGTERM')
    const timeout = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), 5_000))
    expect(await Promise.race([hub.exited, timeout])).toBe(0)
  })
})
