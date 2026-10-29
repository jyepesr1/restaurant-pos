import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SNAPSHOT_KINDS, SNAPSHOTS_FILE } from './snapshots'

// The real hub process (`src/main.ts`) uploading the owner's panel snapshots to a made-up cloud on a
// local port (task 1.11c-1): the wiring that only exists in `main.ts`. Registering the PC sends
// everything, a staff change made through the hub's own API sends the staff right away, the
// heartbeat carries how far the hub is, a restart does not send again what the cloud has, and a
// cloud that does not know the route yet does not bother the hub. No fixed waits: every wait is for
// something to happen, with a limit.

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

async function until(condition: () => boolean, what: string, limitMs = 10_000) {
  const end = Date.now() + limitMs
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Never happened: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface Put {
  kind: string
  fingerprint: string
  content: unknown
  raw: string
  authorization: string | null
}

/** A cloud that registers hubs, keeps events and snapshots, and can refuse the snapshot route. */
async function fakeCloud() {
  const state = {
    credential: 'credencial-del-proceso',
    events: new Map<number, unknown>(),
    puts: [] as Put[],
    heartbeats: [] as (string | null)[],
    snapshotStatus: 204,
  }
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const answer = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body === undefined ? undefined : JSON.stringify(body))
      }
      const raw = Buffer.concat(chunks).toString()
      const body = raw ? JSON.parse(raw) : null
      if (req.url === '/v1/hubs/register')
        return answer(201, { credential: state.credential, restaurant_id: body.restaurant_id })
      if (req.headers.authorization !== `Bearer ${state.credential}`)
        return answer(401, { error: 'invalid_credential' })
      const contiguous = () => {
        let n = 0
        while (state.events.has(n + 1)) n += 1
        return n
      }
      if (req.url === '/v1/events/last') {
        state.heartbeats.push(String(req.headers['x-faro-hub-max'] ?? ''))
        return answer(200, { last_sequence: contiguous() })
      }
      if (req.url === '/v1/events') {
        for (const e of body.events) state.events.set(e.sequence, e)
        return answer(200, { results: [], last_sequence: contiguous() })
      }
      const kind = /^\/v1\/snapshots\/([a-z_]+)$/.exec(req.url ?? '')?.[1]
      if (kind && req.method === 'PUT') {
        state.puts.push({
          kind,
          fingerprint: body.fingerprint,
          content: body.content,
          raw,
          authorization: req.headers.authorization ?? null,
        })
        res.writeHead(state.snapshotStatus)
        return res.end()
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
    kinds: () => state.puts.map((p) => p.kind),
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

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'pos-snapshots-process-'))
  cloud = await fakeCloud()
})
afterEach(async () => {
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
  sessionId: string
  secret: string
  pin: string
  password: string
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
  const j = (await r.json()) as { device: { token: string }; session_id: string; secret: string }
  return {
    url,
    token: j.device.token,
    sessionId: j.session_id,
    secret: j.secret,
    pin: datum('PIN para autorizar'),
    password: datum('Contraseña'),
  }
}

const call = (p: Person, route: string, body: object = {}) =>
  fetch(`${p.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
    body: JSON.stringify({ session_id: p.sessionId, secret: p.secret, ...body }),
  })

const lastOf = (kind: string) => cloud.state.puts.filter((p) => p.kind === kind).at(-1)

describe('the hub process uploads the snapshots for the panel', () => {
  it('registering the PC sends the five, remote_users first, with the credential and without any secret', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    expect(cloud.state.puts).toEqual([])
    expect((await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })).status).toBe(200)
    await until(() => new Set(cloud.kinds()).size === SNAPSHOT_KINDS.length, 'all five snapshots')

    expect(cloud.kinds().slice(0, 5)).toEqual([...SNAPSHOT_KINDS])
    expect(cloud.kinds()[0]).toBe('remote_users')
    for (const p of cloud.state.puts)
      expect(p.authorization, p.kind).toBe(`Bearer ${cloud.state.credential}`)
    const users = lastOf('remote_users')?.content as {
      username: string
      verifier: string
      permissions: string[]
    }[]
    expect(users.map((u) => u.username)).toEqual(['admin'])
    expect(users[0]?.verifier).toMatch(/^scrypt\$15\$8\$1\$[\w-]+\$[\w-]+$/)
    expect(users[0]?.permissions).toContain('remote_access')

    // Neither the PIN nor the password in clear travel anywhere, in any snapshot.
    const everything = cloud.state.puts.map((p) => p.raw).join('\n')
    expect(everything).not.toContain(admin.pin)
    expect(everything).not.toContain(admin.password)
    expect(everything).not.toMatch(/pin_hash|"pin"|"password"/)
    // Nor does the hub's output show a hash.
    expect(hub.output()).not.toContain('scrypt$')
  })

  it('a person created from the hub’s staff screen reaches the cloud right away, not at the next routine check', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })
    await until(() => new Set(cloud.kinds()).size === SNAPSHOT_KINDS.length, 'the first snapshots')

    const staff = (await (await call(admin, '/api/staff/read')).json()) as {
      roles: { id: string; name: string }[]
    }
    const role = staff.roles.find((r) => r.name === 'Administrador')?.id as string
    const before = cloud.state.puts.length
    const saved = await call(admin, '/api/staff/people', {
      person: {
        name: 'Gerente Nuevo',
        role_id: role,
        access: { type: 'password', user: 'gerente', password: 'clave-larga-de-gerente' },
      },
    })
    expect(saved.status).toBe(200)
    await until(
      () => (lastOf('remote_users')?.content as unknown[] | undefined)?.length === 2,
      'the new person in remote_users',
    )
    const users = lastOf('remote_users')?.content as { username: string }[]
    expect(users.map((u) => u.username).sort()).toEqual(['admin', 'gerente'])
    // The users go first (they are what takes access away); the people follow in the same check.
    await until(
      () =>
        (lastOf('people')?.content as { name: string }[] | undefined)?.some(
          (p) => p.name === 'Gerente Nuevo',
        ) === true,
      'the new person in people',
    )
    const people = lastOf('people')?.content as { name: string }[]
    expect(cloud.state.puts.length).toBeGreaterThan(before)
    // The password in clear never travelled.
    expect(cloud.state.puts.map((p) => p.raw).join('\n')).not.toContain('clave-larga-de-gerente')

    // Archiving them takes them out of remote_users right away too.
    const id = (people as unknown as { id: string; name: string }[]).find(
      (p) => p.name === 'Gerente Nuevo',
    )?.id
    const archived = await call(admin, '/api/staff/people', {
      person: { id, name: 'Gerente Nuevo', role_id: role, active: false },
    })
    expect(archived.status).toBe(200)
    await until(
      () => (lastOf('remote_users')?.content as unknown[] | undefined)?.length === 1,
      'the archived person leaving remote_users',
    )
  })

  it('the heartbeat of an up-to-date hub carries how far it has', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })
    await until(() => cloud.state.heartbeats.length > 0, 'the first question to the cloud')
    expect(cloud.state.heartbeats.every((h) => /^\d+$/.test(h ?? ''))).toBe(true)
  })

  it('a restarted hub does not send again what the cloud already has', async () => {
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })
    await until(() => new Set(cloud.kinds()).size === SNAPSHOT_KINDS.length, 'the first snapshots')
    expect(existsSync(join(env.DATA_DIR as string, SNAPSHOTS_FILE))).toBe(true)
    await hub.stop()

    const sent = cloud.state.puts.length
    hub = await startHub(env)
    const again = await signIn(env)
    // A barrier instead of a wait: a new person (PIN only) changes `people` and the catalog's
    // version, and the checks go one at a time, so once that arrives, any earlier check is done.
    const staff = (await (await call(again, '/api/staff/read')).json()) as {
      roles: { id: string; name: string }[]
    }
    const waiter = staff.roles.find((r) => r.name === 'Mesero')?.id as string
    const saved = await call(again, '/api/staff/people', {
      person: { name: 'Barrera', role_id: waiter },
    })
    expect(saved.status, await saved.clone().text()).toBe(200)
    await until(
      () =>
        cloud.state.puts
          .slice(sent)
          .some(
            (p) =>
              p.kind === 'people' &&
              (p.content as { name: string }[]).some((x) => x.name === 'Barrera'),
          ),
      'the barrier reaching the cloud',
    )
    // Nothing else was sent again: not the users, nor the roles, nor the configuration.
    expect(new Set(cloud.kinds().slice(sent))).toEqual(new Set(['people', 'catalog']))
  })

  it('a cloud that does not know the route yet (404) does not bother the hub: events keep going up and it logs once', async () => {
    cloud.state.snapshotStatus = 404
    const env = await environment()
    hub = await startHub(env)
    const admin = await signIn(env)
    await call(admin, '/api/cloud/register', { code: 'AAAA-BBBB-CCCC' })
    await until(() => new Set(cloud.kinds()).size === SNAPSHOT_KINDS.length, 'the attempts')
    const status = (await (await call(admin, '/api/cloud/status')).json()) as { state: string }
    expect(status.state).toBe('up_to_date')
    await until(
      () => (hub?.output().match(/La nube no aceptó la instantánea/g) ?? []).length === 5,
      'one line per snapshot in the log',
    )
    // The file of fingerprints only keeps what the cloud accepted: nothing.
    const file = join(env.DATA_DIR as string, SNAPSHOTS_FILE)
    if (existsSync(file)) expect(JSON.parse(readFileSync(file, 'utf8')).accepted).toEqual({})
    // The log never carries a verifier.
    expect(hub.output()).not.toContain('scrypt$')
  })
})
