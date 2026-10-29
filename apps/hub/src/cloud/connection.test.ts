import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudStatus } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { setupAccess } from '../access/setup'
import { CloudConnection, DEFAULT_CLOUD_URL } from './connection'
import { LINK_FILE, readLink, saveLink } from './link'
import { jsonResponse, manualTimers } from './testing'

// Registering this register PC with the cloud's single-use code, against a scripted cloud
// (task 1.11). The real cloud is in `cloud.integration.test.ts`; here every answer the cloud could
// give, including the odd ones, is made up on purpose.

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})

interface Sent {
  url: string
  body: Record<string, unknown>
}

type Answer = Response | Error | Promise<Response> | ((sent: Sent) => Response | Promise<Response>)

function setup() {
  const m = setupAccess()
  const dir = mkdtempSync(join(tmpdir(), 'hub-conn-'))
  folders.push(dir)
  const sent: Sent[] = []
  const answers: Answer[] = []
  const statuses: CloudStatus[] = []
  const failures: unknown[] = []
  const t = manualTimers()
  const fetchCloud: typeof fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const call = { url: String(input), body }
    sent.push(call)
    // The upload's own requests are not registrations: they get the default «unauthorized».
    const next = answers.shift()
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(call)
    return next ?? jsonResponse({ error: 'unexpected' }, 500)
  }
  const make = () =>
    new CloudConnection({
      db: m.db,
      restaurantId: m.restaurantId,
      dataDir: dir,
      instance: 'instancia-de-prueba',
      url: 'https://cloud.faro.test/',
      fetch: fetchCloud,
      clock: () => new Date('2026-10-29T15:00:00.000Z'),
      onStatus: (s) => statuses.push(s),
      onFailure: (e) => failures.push(e),
      uploader: { timers: t.timers },
    })
  const connection = make()
  const created = (credential = 'credencial-nueva', restaurantId = m.restaurantId) =>
    jsonResponse({ credential, restaurant_id: restaurantId }, 201)
  const registrations = () => sent.filter((s) => s.url.endsWith('/v1/hubs/register'))
  return { m, dir, sent, answers, statuses, failures, t, connection, make, created, registrations }
}

describe('the request to register', () => {
  it('sends the code, the restaurant, the hub id, the location and the name, to the cloud address', async () => {
    const h = setup()
    h.answers.push(h.created())
    expect(await h.connection.register('  abcd-efgh-jkmn  ')).toEqual({ ok: true })
    const r = h.registrations()[0] as Sent
    expect(r.url).toBe('https://cloud.faro.test/v1/hubs/register')
    const location = h.m.db
      .prepare('SELECT id, name FROM locations WHERE restaurant_id = ?')
      .get(h.m.restaurantId)
    expect(r.body).toEqual({
      code: 'abcd-efgh-jkmn',
      restaurant_id: h.m.restaurantId,
      hub_id: readLink(h.dir)?.hubId,
      location_id: location?.id,
      name: `Caja de ${location?.name}`.slice(0, 60),
      instance: 'instancia-de-prueba',
    })
  })

  it('uses the production address unless told otherwise', () => {
    expect(DEFAULT_CLOUD_URL).toMatch(/^https:\/\//)
  })

  it('a code of absurd length is cut before leaving the PC', async () => {
    const h = setup()
    h.answers.push(h.created())
    await h.connection.register('X'.repeat(500))
    expect(String(h.registrations()[0]?.body.code).length).toBeLessThanOrEqual(40)
  })

  it('a hub id is saved before asking, so a lost answer can be retried with the same one', async () => {
    const h = setup()
    h.answers.push(new TypeError('fetch failed'))
    await h.connection.register('AAAA-BBBB-CCCC')
    const first = readLink(h.dir)
    expect(first).toMatchObject({ credential: null, registeredAt: null })
    h.answers.push(h.created())
    await h.connection.register('AAAA-BBBB-CCCC')
    expect(h.registrations()[1]?.body.hub_id).toBe(first?.hubId)
    expect(readLink(h.dir)?.hubId).toBe(first?.hubId)
  })
})

describe('the cloud says no', () => {
  it('a code from another restaurant: its own message, nothing saved, not connected', async () => {
    const h = setup()
    h.answers.push(jsonResponse({ error: 'other_restaurant' }, 403))
    const r = await h.connection.register('AAAA-BBBB-CCCC')
    expect(r).toMatchObject({ ok: false, code: 'other_restaurant' })
    expect((r as { message: string }).message).toMatch(/otro restaurante/)
    expect(readLink(h.dir)?.credential).toBeNull()
    expect(h.connection.status().state).toBe('not_connected')
  })

  it.each([
    ['403 invalid_code (not found, used or expired)', 403, { error: 'invalid_code' }],
    ['400 invalid_data', 400, { error: 'invalid_data' }],
    ['403 without a body', 403, null],
  ])('%s: «invalid code», nothing saved', async (_, status, body) => {
    const h = setup()
    h.answers.push(body ? jsonResponse(body, status) : new Response(null, { status }))
    const r = await h.connection.register('AAAA-BBBB-CCCC')
    expect(r).toMatchObject({ ok: false, code: 'invalid_code' })
    expect(readLink(h.dir)?.credential).toBeNull()
    expect(h.connection.status().state).toBe('not_connected')
  })

  it.each([
    ['500', () => jsonResponse({ error: 'internal_error' }, 500)],
    ['502 with HTML', () => new Response('<html>', { status: 502 })],
    ['429', () => jsonResponse({ error: 'slow' }, 429)],
    ['401', () => jsonResponse({ error: 'no' }, 401)],
    ['404', () => jsonResponse({}, 404)],
  ])('%s: «the cloud had a problem», nothing saved, can try again', async (_, answer) => {
    const h = setup()
    h.answers.push(answer())
    expect(await h.connection.register('AAAA-BBBB-CCCC')).toMatchObject({
      ok: false,
      code: 'cloud_error',
    })
    expect(readLink(h.dir)?.credential).toBeNull()
    h.answers.push(h.created())
    expect(await h.connection.register('AAAA-BBBB-CCCC')).toEqual({ ok: true })
  })

  it.each<[string, (restaurantId: string) => Record<string, unknown>]>([
    ['201 without credential', (id) => ({ restaurant_id: id })],
    ['201 with a credential that is not text', (id) => ({ credential: 123, restaurant_id: id })],
    ['201 with an empty credential', (id) => ({ credential: '', restaurant_id: id })],
    ['201 without restaurant', () => ({ credential: 'c' })],
    ['201 of another restaurant', () => ({ credential: 'c', restaurant_id: 'OTRO-RESTAURANTE' })],
    ['201 with an empty object', () => ({})],
  ])('%s is not trusted: nothing saved, not connected', async (_, body) => {
    const h = setup()
    h.answers.push(jsonResponse(body(h.m.restaurantId), 201))
    const r = await h.connection.register('AAAA-BBBB-CCCC')
    expect(r).toMatchObject({ ok: false, code: 'cloud_error' })
    expect(readLink(h.dir)?.credential).toBeNull()
    expect(h.connection.status().state).toBe('not_connected')
  })

  it('a 201 that is not JSON is not trusted either', async () => {
    const h = setup()
    h.answers.push(new Response('no soy json', { status: 201 }))
    expect(await h.connection.register('AAAA-BBBB-CCCC')).toMatchObject({ code: 'cloud_error' })
    expect(readLink(h.dir)?.credential).toBeNull()
  })

  it('«hub already registered» (409) starts over with a new hub id and the same code', async () => {
    const h = setup()
    h.answers.push(jsonResponse({ error: 'hub_already_registered' }, 409), h.created())
    expect(await h.connection.register('AAAA-BBBB-CCCC')).toEqual({ ok: true })
    const [first, second] = h.registrations()
    expect(first?.body.hub_id).not.toBe(second?.body.hub_id)
    expect(second?.body.code).toBe(first?.body.code)
    expect(readLink(h.dir)?.hubId).toBe(second?.body.hub_id)
  })

  it('a second 409 is reported as a cloud problem, without looping', async () => {
    const h = setup()
    h.answers.push(
      jsonResponse({ error: 'hub_already_registered' }, 409),
      jsonResponse({ error: 'hub_already_registered' }, 409),
    )
    expect(await h.connection.register('AAAA-BBBB-CCCC')).toMatchObject({ code: 'cloud_error' })
    expect(h.registrations()).toHaveLength(2)
  })

  it('a 409 followed by an invalid code says the code is invalid', async () => {
    const h = setup()
    h.answers.push(
      jsonResponse({ error: 'hub_already_registered' }, 409),
      jsonResponse({ error: 'invalid_code' }, 403),
    )
    expect(await h.connection.register('AAAA-BBBB-CCCC')).toMatchObject({ code: 'invalid_code' })
  })
})

describe('without internet', () => {
  it.each([
    ['the connection fails', () => new TypeError('fetch failed')],
    ['the request times out', () => new DOMException('timed out', 'TimeoutError')],
    ['the request is aborted', () => new DOMException('aborted', 'AbortError')],
  ])('%s: «no internet», keeps the hub id and does not connect', async (_, failure) => {
    const h = setup()
    h.answers.push(failure())
    const r = await h.connection.register('AAAA-BBBB-CCCC')
    expect(r).toMatchObject({ ok: false, code: 'offline' })
    expect((r as { message: string }).message).toMatch(/internet/)
    expect(readLink(h.dir)).toMatchObject({ credential: null })
    expect(h.connection.status().state).toBe('not_connected')
  })

  it('the registering lock is released after a failure, so it can try again', async () => {
    const h = setup()
    h.answers.push(new TypeError('x'), h.created())
    await h.connection.register('AAAA-BBBB-CCCC')
    expect(await h.connection.register('AAAA-BBBB-CCCC')).toEqual({ ok: true })
  })

  it('the request is made with a timeout signal', async () => {
    const h = setup()
    let signal: AbortSignal | null | undefined
    const connection = new CloudConnection({
      db: h.m.db,
      restaurantId: h.m.restaurantId,
      dataDir: h.dir,
      instance: 'i',
      url: 'https://cloud.faro.test',
      fetch: async (_input, init) => {
        signal = init?.signal
        return h.created()
      },
      uploader: { timers: h.t.timers },
    })
    await connection.register('AAAA-BBBB-CCCC')
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})

describe('two at once and repeated registrations', () => {
  it('a second registration while the first is in flight is refused and does not reach the cloud', async () => {
    const h = setup()
    let release: (r: Response) => void = () => {}
    h.answers.push(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    const first = h.connection.register('AAAA-BBBB-CCCC')
    const second = await h.connection.register('DDDD-EEEE-FFFF')
    expect(second).toMatchObject({ ok: false, code: 'cloud_error' })
    expect((second as { message: string }).message).toMatch(/conectando/)
    release(h.created())
    expect(await first).toEqual({ ok: true })
    expect(h.registrations()).toHaveLength(1)
    // And afterwards it is simply connected.
    expect(await h.connection.register('DDDD-EEEE-FFFF')).toMatchObject({
      code: 'already_connected',
    })
  })

  it('ten registrations at once make a single request to the cloud', async () => {
    const h = setup()
    let release: (r: Response) => void = () => {}
    h.answers.push(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    const all = Array.from({ length: 10 }, () => h.connection.register('AAAA-BBBB-CCCC'))
    release(h.created())
    const results = await Promise.all(all)
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(h.registrations()).toHaveLength(1)
  })

  it('already connected: a new code is refused and the credential stays', async () => {
    const h = setup()
    h.answers.push(h.created('la-primera'))
    await h.connection.register('AAAA-BBBB-CCCC')
    expect(await h.connection.register('DDDD-EEEE-FFFF')).toMatchObject({
      ok: false,
      code: 'already_connected',
    })
    expect(readLink(h.dir)?.credential).toBe('la-primera')
    expect(h.registrations()).toHaveLength(1)
  })

  it('a failed attempt after a good registration does not erase the credential', async () => {
    const h = setup()
    h.answers.push(h.created('la-buena'))
    await h.connection.register('AAAA-BBBB-CCCC')
    await h.connection.register('DDDD-EEEE-FFFF')
    expect(readLink(h.dir)?.credential).toBe('la-buena')
  })
})

describe('a good registration', () => {
  it('saves the credential, resets the confirmed counter and starts uploading', async () => {
    const h = setup()
    h.m.db
      .prepare('INSERT INTO counters (restaurant_id, name, value) VALUES (?, ?, ?)')
      .run(h.m.restaurantId, 'cloud_confirmed', 77)
    h.answers.push(h.created('credencial-final'))
    // The upload that starts right after asks the cloud: it finds nothing scripted and backs off.
    expect(await h.connection.register('AAAA-BBBB-CCCC')).toEqual({ ok: true })
    expect(readLink(h.dir)).toMatchObject({
      credential: 'credencial-final',
      registeredAt: '2026-10-29T15:00:00.000Z',
    })
    expect(
      h.m.db
        .prepare('SELECT value FROM counters WHERE restaurant_id = ? AND name = ?')
        .get(h.m.restaurantId, 'cloud_confirmed')?.value,
    ).toBe(0)
    await h.connection.uploader.idle()
    expect(h.sent.some((s) => s.url.endsWith('/v1/events/last'))).toBe(true)
  })

  it('a hub restarted afterwards finds the credential and is connected without registering again', async () => {
    const h = setup()
    h.answers.push(h.created('credencial-final'))
    await h.connection.register('AAAA-BBBB-CCCC')
    await h.connection.uploader.idle()
    const restarted = h.make()
    expect(restarted.status().state).toBe('offline')
    expect(await restarted.register('DDDD-EEEE-FFFF')).toMatchObject({ code: 'already_connected' })
  })

  it('the credential never appears in the result, the status or any status sent out', async () => {
    const h = setup()
    h.answers.push(h.created('credencial-ultra-secreta'))
    const r = await h.connection.register('AAAA-BBBB-CCCC')
    await h.connection.uploader.idle()
    for (const visible of [r, h.connection.status(), h.statuses])
      expect(JSON.stringify(visible)).not.toContain('credencial-ultra-secreta')
    // Nor in the failures sent to the log.
    expect(JSON.stringify(h.failures)).not.toContain('credencial-ultra-secreta')
  })

  it('the credential never appears in any message of a failed registration', async () => {
    const h = setup()
    const results = []
    for (const a of [
      jsonResponse({ error: 'other_restaurant', credential: 'filtrada' }, 403),
      jsonResponse({ credential: 'filtrada', restaurant_id: 'otro' }, 201),
      jsonResponse({ credential: 'filtrada' }, 500),
      new TypeError('fetch failed with filtrada'),
    ]) {
      h.answers.push(a)
      results.push(await h.connection.register('AAAA-BBBB-CCCC'))
    }
    expect(JSON.stringify(results)).not.toContain('filtrada')
    expect(readFileSync(join(h.dir, LINK_FILE), 'utf8')).not.toContain('filtrada')
  })
})

describe('a revoked register PC', () => {
  async function revoked() {
    const h = setup()
    h.answers.push(h.created('la-vieja'))
    await h.connection.register('AAAA-BBBB-CCCC')
    await h.connection.uploader.idle()
    // From now on the cloud says the credential is no good.
    h.answers.push(jsonResponse({ error: 'invalid_credential' }, 401))
    h.connection.uploader.restart()
    await h.connection.uploader.idle()
    return h
  }

  it('can register again with a new code and gets a new hub id', async () => {
    const h = await revoked()
    expect(h.connection.status().state).toBe('revoked')
    const oldId = readLink(h.dir)?.hubId
    h.answers.push(h.created('la-nueva'))
    expect(await h.connection.register('DDDD-EEEE-FFFF')).toEqual({ ok: true })
    expect(readLink(h.dir)).toMatchObject({ credential: 'la-nueva' })
    expect(readLink(h.dir)?.hubId).not.toBe(oldId)
  })

  it('if the new registration fails, it stays revoked and can try again', async () => {
    const h = await revoked()
    h.answers.push(jsonResponse({ error: 'invalid_code' }, 403))
    expect(await h.connection.register('MAL-CODIGO')).toMatchObject({ code: 'invalid_code' })
    expect(h.connection.status().state).toBe('revoked')
    h.answers.push(h.created('la-nueva'))
    expect(await h.connection.register('DDDD-EEEE-FFFF')).toEqual({ ok: true })
  })
})

describe('the link file', () => {
  it('a damaged file is the same as never having connected: it can register and rewrites it', async () => {
    const h = setup()
    writeFileSync(join(h.dir, LINK_FILE), '{{{ dañado')
    const restarted = h.make()
    expect(restarted.status().state).toBe('not_connected')
    h.answers.push(h.created('credencial-sana'))
    expect(await restarted.register('AAAA-BBBB-CCCC')).toEqual({ ok: true })
    expect(readLink(h.dir)?.credential).toBe('credencial-sana')
  })

  it('a valid link with a credential is used at startup', () => {
    const h = setup()
    saveLink(h.dir, {
      hubId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      credential: 'guardada',
      registeredAt: '2026-10-29T15:00:00.000Z',
    })
    expect(h.make().status().state).toBe('offline')
  })

  it('a link without credential at startup is not connected', () => {
    const h = setup()
    saveLink(h.dir, {
      hubId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      credential: null,
      registeredAt: null,
    })
    expect(h.make().status().state).toBe('not_connected')
  })

  it('the pending count at startup counts every event when it was never connected', () => {
    const h = setup()
    expect(h.make().status()).toEqual({ state: 'not_connected', pending: 0, last_upload_at: null })
  })

  it('a folder where the link cannot be written reports a failure instead of connecting silently', async () => {
    const h = setup()
    rmSync(h.dir, { recursive: true, force: true })
    h.answers.push(h.created())
    // The hub id cannot even be saved before asking; nothing reaches the cloud.
    const r = await h.connection.register('AAAA-BBBB-CCCC')
    expect(r.ok).toBe(false)
    expect(h.registrations()).toHaveLength(0)
  })
})
