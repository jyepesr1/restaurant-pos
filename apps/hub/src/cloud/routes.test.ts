import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setupAccess } from '../access/setup'
import { createAppServer } from '../server'
import { CloudConnection } from './connection'
import { readLink } from './link'
import { jsonResponse, manualTimers } from './testing'

// The two routes to connect the register PC to the cloud (task 1.11): who can call them, what
// they accept, how each outcome answers, and that the credential never leaves in an answer.

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})

type Json = Record<string, unknown>

function world() {
  const m = setupAccess()
  const dir = mkdtempSync(join(tmpdir(), 'hub-routes-'))
  folders.push(dir)
  const answers: (Response | Error)[] = []
  const t = manualTimers()
  const cloud = new CloudConnection({
    db: m.db,
    restaurantId: m.restaurantId,
    dataDir: dir,
    instance: 'instancia',
    url: 'https://cloud.faro.test',
    fetch: async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next ?? jsonResponse({ error: 'unexpected' }, 500)
    },
    uploader: { timers: t.timers },
  })
  const app = createAppServer({ access: m.access, cloud: { access: m.access, cloud } })
  const post = (url: string, body: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: body as object,
      remoteAddress: '10.0.0.20',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  const device = (who: keyof typeof m.people, type: 'waiter' | 'register' = 'register') => {
    const { token, connection } = m.pair(type)
    const session = m.signIn(connection, who)
    return {
      token,
      connection,
      body: { session_id: session.sessionId, secret: session.secret } as Json,
    }
  }
  const created = (credential = 'credencial-ultra-secreta') =>
    jsonResponse({ credential, restaurant_id: m.restaurantId }, 201)
  return { m, dir, app, post, device, answers, cloud, created, t }
}

const URLS = ['/api/cloud/status', '/api/cloud/register'] as const
const withCode = (body: Json) => ({ ...body, code: 'AAAA-BBBB-CCCC' })
/** A valid body for that route: the status takes only the session; the registration, also the code. */
const bodyFor = (url: string, session: Json) =>
  url.endsWith('status') ? session : withCode(session)

describe('who can call', () => {
  it.each(URLS)('%s without a device token is refused before reading anything', async (url) => {
    const w = world()
    const admin = w.device('admin')
    expect((await w.post(url, bodyFor(url, admin.body))).statusCode).toBe(401)
    expect((await w.post(url, 'cualquier cosa')).statusCode).toBe(401)
  })

  it.each(URLS)('%s with an invented device token is refused', async (url) => {
    const w = world()
    const admin = w.device('admin')
    expect((await w.post(url, bodyFor(url, admin.body), 'token-inventado')).statusCode).toBe(401)
  })

  it.each(URLS)('%s with a bad authorization scheme is refused', async (url) => {
    const w = world()
    const admin = w.device('admin')
    const r = await w.app.inject({
      method: 'POST',
      url,
      payload: bodyFor(url, admin.body),
      headers: { authorization: `Basic ${admin.token}` },
    })
    expect(r.statusCode).toBe(401)
  })

  it.each(URLS)('%s from a revoked device is refused', async (url) => {
    const w = world()
    const admin = w.device('admin')
    w.m.db
      .prepare('UPDATE devices SET revoked_at = ? WHERE id = ?')
      .run(w.m.clock(), admin.connection.deviceId)
    expect((await w.post(url, bodyFor(url, admin.body), admin.token)).statusCode).toBe(401)
  })

  it.each(URLS)('%s with the device but without a session is a bad request', async (url) => {
    const w = world()
    const admin = w.device('admin')
    expect((await w.post(url, { code: 'AAAA-BBBB-CCCC' }, admin.token)).statusCode).toBe(400)
    expect((await w.post(url, {}, admin.token)).statusCode).toBe(400)
  })

  it.each(URLS)('%s with a wrong session secret is refused', async (url) => {
    const w = world()
    const admin = w.device('admin')
    const r = await w.post(url, bodyFor(url, { ...admin.body, secret: 'no-es' }), admin.token)
    expect(r.statusCode).toBe(401)
  })

  it.each(URLS)('%s with a session of another device is refused', async (url) => {
    const w = world()
    const admin = w.device('admin')
    const other = w.device('admin')
    const r = await w.post(url, bodyFor(url, admin.body), other.token)
    expect([401, 403]).toContain(r.statusCode)
    expect(w.answers).toHaveLength(0)
  })

  for (const who of ['waiter', 'waiter2', 'cashier', 'manager'] as const)
    it.each(URLS)(`%s with the ${who} role (no manage_devices) is forbidden`, async (url) => {
      const w = world()
      const person = w.device(who, who === 'waiter' || who === 'waiter2' ? 'waiter' : 'register')
      const r = await w.post(url, bodyFor(url, person.body), person.token)
      expect(r.statusCode).toBe(403)
      expect(r.json()).toMatchObject({ error: 'no_permission' })
      // The forbidden call never reached the cloud.
      expect(w.answers).toHaveLength(0)
      expect(readLink(w.dir)).toBeNull()
    })

  it('the admin can read the status and register', async () => {
    const w = world()
    const admin = w.device('admin')
    expect((await w.post('/api/cloud/status', admin.body, admin.token)).statusCode).toBe(200)
    w.answers.push(w.created())
    expect(
      (await w.post('/api/cloud/register', withCode(admin.body), admin.token)).statusCode,
    ).toBe(200)
  })

  it('a forbidden attempt does not consume a pending connection', async () => {
    const w = world()
    const cashier = w.device('cashier')
    await w.post('/api/cloud/register', withCode(cashier.body), cashier.token)
    expect(w.cloud.status().state).toBe('not_connected')
  })
})

describe('what they accept', () => {
  const session = (w: ReturnType<typeof world>) => w.device('admin')

  it.each([
    ['an array', () => []],
    ['a string', () => 'texto'],
    ['a number', () => 5],
    ['null', () => null],
  ])('status with %s as the body is a bad request', async (_, body) => {
    const w = world()
    const admin = session(w)
    const r = await w.app.inject({
      method: 'POST',
      url: '/api/cloud/status',
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body()),
    })
    expect(r.statusCode).toBe(400)
  })

  it('a body that is not JSON is a bad request', async () => {
    const w = world()
    const admin = session(w)
    const r = await w.app.inject({
      method: 'POST',
      url: '/api/cloud/register',
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
      payload: '{"code": ',
    })
    expect(r.statusCode).toBe(400)
  })

  it('status with an extra field is a bad request (the bodies are strict)', async () => {
    const w = world()
    const admin = session(w)
    const r = await w.post('/api/cloud/status', { ...admin.body, extra: 1 }, admin.token)
    expect(r.statusCode).toBe(400)
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['41 characters', 'A'.repeat(41)],
    ['a number', 12345],
    ['null', null],
    ['an object', { a: 1 }],
    ['an array', ['AAAA']],
    ['a boolean', true],
  ])('register with the code %s is a bad request and never reaches the cloud', async (_, code) => {
    const w = world()
    const admin = session(w)
    const body = code === undefined ? admin.body : { ...admin.body, code }
    const r = await w.post('/api/cloud/register', body, admin.token)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'invalid_data' })
    expect(readLink(w.dir)).toBeNull()
  })

  it('register with an extra field is a bad request, so a restaurant id cannot be slipped in', async () => {
    const w = world()
    const admin = session(w)
    const r = await w.post(
      '/api/cloud/register',
      withCode({ ...admin.body, restaurant_id: 'OTRO', hub_id: 'X' }),
      admin.token,
    )
    expect(r.statusCode).toBe(400)
    expect(readLink(w.dir)).toBeNull()
  })

  it('a code of exactly 40 characters is accepted by the route', async () => {
    const w = world()
    const admin = session(w)
    w.answers.push(jsonResponse({ error: 'invalid_code' }, 403))
    const r = await w.post(
      '/api/cloud/register',
      { ...admin.body, code: 'A'.repeat(40) },
      admin.token,
    )
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'invalid_code' })
  })

  it('a GET on these routes does not exist', async () => {
    const w = world()
    for (const url of URLS)
      expect((await w.app.inject({ method: 'GET', url })).statusCode).toBe(404)
  })
})

describe('how each outcome answers', () => {
  async function register(w: ReturnType<typeof world>, answer?: Response | Error) {
    const admin = w.device('admin')
    if (answer) w.answers.push(answer)
    return w.post('/api/cloud/register', withCode(admin.body), admin.token)
  }

  it('status: the three fields and nothing else', async () => {
    const w = world()
    const admin = w.device('admin')
    const r = await w.post('/api/cloud/status', admin.body, admin.token)
    expect(r.json()).toEqual({ state: 'not_connected', pending: 0, last_upload_at: null })
  })

  it('a code accepted answers with the status, not the credential nor the hub id', async () => {
    const w = world()
    const r = await register(w, w.created('credencial-ultra-secreta'))
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(Object.keys(body).sort()).toEqual(['last_upload_at', 'pending', 'state'])
    const link = readLink(w.dir)
    expect(r.body).not.toContain('credencial-ultra-secreta')
    expect(r.body).not.toContain(link?.hubId as string)
    expect(JSON.stringify(r.headers)).not.toContain('credencial-ultra-secreta')
  })

  it('«another restaurant» is a 400 with its own message', async () => {
    const w = world()
    const r = await register(w, jsonResponse({ error: 'other_restaurant' }, 403))
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'other_restaurant' })
    expect(r.json().message).toMatch(/otro restaurante/)
  })

  it('an invalid, used or expired code is a 400', async () => {
    const w = world()
    const r = await register(w, jsonResponse({ error: 'invalid_code' }, 403))
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'invalid_code' })
  })

  it('without internet it is a 503 «offline»', async () => {
    const w = world()
    const r = await register(w, new TypeError('fetch failed'))
    expect(r.statusCode).toBe(503)
    expect(r.json()).toMatchObject({ error: 'offline' })
  })

  it('a cloud failure is a 503 «cloud_error»', async () => {
    const w = world()
    const r = await register(w, jsonResponse({ error: 'internal_error' }, 500))
    expect(r.statusCode).toBe(503)
    expect(r.json()).toMatchObject({ error: 'cloud_error' })
  })

  it('already connected is a 409, and the status route shows the connection', async () => {
    const w = world()
    await register(w, w.created())
    const again = await register(w)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: 'already_connected' })
    const admin = w.device('admin')
    const status = await w.post('/api/cloud/status', admin.body, admin.token)
    expect(status.json().state).not.toBe('not_connected')
  })

  it('no answer from any route ever contains the credential', async () => {
    const w = world()
    const admin = w.device('admin')
    const bodies: string[] = []
    const record = (r: { body: string }) => bodies.push(r.body)
    w.answers.push(w.created('credencial-ultra-secreta'))
    record(await w.post('/api/cloud/register', withCode(admin.body), admin.token))
    record(await w.post('/api/cloud/register', withCode(admin.body), admin.token))
    record(await w.post('/api/cloud/status', admin.body, admin.token))
    record(await w.post('/api/cloud/status', { ...admin.body, extra: 1 }, admin.token))
    record(await w.post('/api/cloud/register', { ...admin.body, code: 5 }, admin.token))
    record(await w.post('/api/cloud/status', admin.body))
    for (const b of bodies) expect(b).not.toContain('credencial-ultra-secreta')
  })

  it('without the option, the routes do not exist', async () => {
    const m = setupAccess()
    const app = createAppServer({ access: m.access })
    const r = await app.inject({ method: 'POST', url: '/api/cloud/status', payload: {} })
    expect(r.statusCode).toBe(404)
  })
})
