import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { createAppServer } from '../server'
import { setupAccess } from './setup'

// The access API with bodies no honest client would send: the hub answers a clear 4xx,
// neither logs nor echoes what it received, and stays up for the next client.

function setupApi() {
  const m = setupAccess()
  const app = createAppServer({ access: m.access })
  const send = (
    url: string,
    options: {
      payload?: string | object
      token?: string
      type?: string
      httpMethod?: 'POST' | 'GET' | 'PUT'
    } = {},
  ) =>
    app.inject({
      method: options.httpMethod ?? 'POST',
      url,
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
      headers: {
        ...(options.type ? { 'content-type': options.type } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    })
  /** The same with hand-written JSON (for bodies JSON.stringify would not produce). */
  const raw = (url: string, body: string, token?: string) =>
    send(url, { payload: body, type: 'application/json', token })
  return { ...m, app, send, raw }
}

/** A waiter's phone as in the restaurant: signs in by PIN and the hub registers it (ADR-013). */
async function withPairedDevice() {
  const api = setupApi()
  const s = await api.send('/api/sign-in', { payload: { pin: api.people.waiter.pin } })
  const r = s.json() as { device: { token: string }; session_id: string; secret: string }
  return { ...api, token: r.device.token, session: { session_id: r.session_id, secret: r.secret } }
}

const ROUTES_WITH_TOKEN = ['/api/sessions', '/api/sessions/close', '/api/authorizations'] as const
const ROUTES_WITHOUT_TOKEN = ['/api/pairings', '/api/pair'] as const

async function stillAlive(api: { send: ReturnType<typeof setupApi>['send'] }) {
  const r = await api.send('/api/health', { httpMethod: 'GET' })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toMatchObject({ status: 'ok' })
}

describe('access API with odd bodies', () => {
  it('extra, missing or wrongly typed fields: 400 with the same error body, no echo of what was sent', async () => {
    const api = await withPairedDevice()
    const secret = 'SECRETO-QUE-NO-DEBE-VOLVER'
    const invalid: [string, unknown][] = [
      ['/api/pairings', { pin: '1234', name: 'X', type: 'register', extra: secret }],
      ['/api/pairings', { pin: 1234, name: 'X', type: 'register' }],
      ['/api/pairings', { pin: '1234', name: ['X'], type: 'register' }],
      ['/api/pairings', { pin: '1234', name: 'X' }],
      ['/api/pairings', { pin: null, name: null, type: null }],
      ['/api/pair', { code: 1 }],
      ['/api/pair', { code: { $ne: '' } }],
      ['/api/pair', { code: 'ABCDEFGH', extra: secret }],
      ['/api/pair', {}],
      ['/api/sessions', { pin: 1234 }],
      ['/api/sessions', { pin: ['1234'] }],
      ['/api/sessions', { pin: '1234', role: 'admin' }],
      ['/api/sessions', { pin: '1'.repeat(21) }],
      ['/api/sessions/close', { session_id: 'corto', secret: 'x' }],
      ['/api/sessions/close', { session_id: newId(), secret: '' }],
      ['/api/sessions/close', { session_id: newId(), secret: 'x'.repeat(101) }],
      ['/api/sessions/close', { session_id: newId(), secret: 7 }],
      [
        '/api/authorizations',
        {
          session_id: newId(),
          secret: 'x',
          pin: '1234',
          action: 'a'.repeat(51),
          aggregate_id: newId(),
          event_id: newId(),
        },
      ],
      [
        '/api/authorizations',
        {
          session_id: newId(),
          secret: 'x',
          pin: '1234',
          action: 'void_sent_item',
          aggregate_id: 'no',
          event_id: newId(),
        },
      ],
      [
        '/api/authorizations',
        {
          session_id: newId(),
          secret: 'x',
          pin: '1234',
          action: 'void_sent_item',
          aggregate_id: newId(),
        },
      ],
    ]
    for (const [url, body] of invalid) {
      const r = await api.send(url, { payload: body as object, token: api.token })
      expect(r.statusCode, `${url} ${JSON.stringify(body)}`).toBe(400)
      expect(r.json()).toEqual({
        error: 'invalid_data',
        message: 'Datos con formato inesperado',
      })
      expect(r.body).not.toContain(secret)
    }
    await stillAlive(api)
  })

  it('bodies that are not a JSON object: null, number, string, array, empty', async () => {
    const api = await withPairedDevice()
    for (const body of ['null', '123', '"texto"', '[]', '[{"pin":"1234"}]', 'true']) {
      for (const url of [...ROUTES_WITH_TOKEN, ...ROUTES_WITHOUT_TOKEN]) {
        const r = await api.raw(url, body, api.token)
        expect(r.statusCode, `${url} ${body}`).toBe(400)
      }
    }
    for (const url of [...ROUTES_WITH_TOKEN, ...ROUTES_WITHOUT_TOKEN]) {
      const withoutBody = await api.send(url, { token: api.token })
      expect(withoutBody.statusCode, url).toBe(400)
    }
    await stillAlive(api)
  })

  it('malformed JSON or another Content-Type: 4xx, never 5xx', async () => {
    const api = await withPairedDevice()
    const malformed = [
      '{',
      '{"pin":',
      '{"pin":"1234"',
      "{'pin':'1234'}",
      '\u0000',
      '{"pin":"1234"}}',
      '',
    ]
    for (const body of malformed) {
      const r = await api.raw('/api/sessions', body, api.token)
      expect(r.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, JSON.stringify(body)).toBeLessThan(500)
    }
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/xml',
      'multipart/form-data',
    ]) {
      const r = await api.send('/api/sessions', { payload: 'pin=1234', type, token: api.token })
      expect(r.statusCode, type).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, type).toBeLessThan(500)
    }
    await stillAlive(api)
  })

  it('huge bodies are cut with 413 without reading them fully, and the hub keeps serving', async () => {
    const api = await withPairedDevice()
    const huge = JSON.stringify({ pin: '1234', padding: 'x'.repeat(5 * 1024 * 1024) })
    for (const url of [...ROUTES_WITH_TOKEN, ...ROUTES_WITHOUT_TOKEN]) {
      const r = await api.raw(url, huge, api.token)
      expect(r.statusCode, url).toBe(413)
    }
    // And one within the Fastify limit but with a giant field: the schema stops it.
    const length = await api.raw(
      '/api/sessions',
      JSON.stringify({ pin: '9'.repeat(500_000) }),
      api.token,
    )
    expect(length.statusCode).toBe(400)
    const name = await api.raw(
      '/api/pairings',
      JSON.stringify({ pin: api.people.admin.pin, name: 'N'.repeat(500_000), type: 'register' }),
    )
    expect(name.statusCode).toBe(400)
    await stillAlive(api)
    // And a normal client gets in without trouble right after.
    const fine = await api.send('/api/sessions', {
      payload: { pin: api.people.waiter.pin },
      token: api.token,
    })
    expect(fine.statusCode).toBe(201)
  })

  it('deeply nested JSON or dangerous keys neither crash anything nor pollute objects', async () => {
    const api = await withPairedDevice()
    const deep = `${'['.repeat(50_000)}${']'.repeat(50_000)}`
    const nested = await api.raw('/api/sessions', deep, api.token)
    expect(nested.statusCode).toBeGreaterThanOrEqual(400)
    expect(nested.statusCode).toBeLessThan(500)

    for (const body of [
      '{"__proto__":{"admin":true},"pin":"1234"}',
      '{"constructor":{"prototype":{"x":1}},"pin":"1234"}',
      '{"pin":"1234","__proto__":null}',
    ]) {
      const r = await api.raw('/api/sessions', body, api.token)
      expect(r.statusCode, body).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, body).toBeLessThan(500)
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    await stillAlive(api)
  })

  it('text with Unicode, nulls, SQL and tags is stored as data, not as instructions', async () => {
    const api = await withPairedDevice()
    const oddNames = [
      "Caja'); DROP TABLE dispositivo;--",
      '<script>alert(1)</script>',
      'Cocina 🍕 ñandú',
      'a\u0000b',
      '‮oculto',
      '  espacios  ',
    ]
    // Only a kitchen screen is paired, from an already registered device (ADR-013).
    const token = api.token
    for (const name of oddNames) {
      const c = await api.send('/api/pairings', {
        payload: { pin: api.people.admin.pin, name, type: 'kds' },
        token,
      })
      expect(c.statusCode, name).toBe(201)
      const e = await api.send('/api/pair', { payload: { code: c.json().code } })
      expect(e.statusCode, name).toBe(201)
      expect(e.json().name).toBe(name.trim())
    }
    // Plus the phone from the setup.
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)).toBe(
      oddNames.length + 1,
    )
    // Spaces-only and names longer than 60 characters fail the service rule.
    for (const name of ['   ', 'x'.repeat(61)]) {
      const r = await api.send('/api/pairings', {
        payload: { pin: api.people.admin.pin, name, type: 'kds' },
        token,
      })
      expect(r.statusCode, name).toBe(400)
      expect(r.json().error).toBe('invalid_data')
    }
    await stillAlive(api)
  })

  it('made-up device type, Object property names, or a type that is not kitchen: 400', async () => {
    const api = await withPairedDevice()
    for (const type of [
      'tostadora',
      '',
      'CAJA',
      'toString',
      '__proto__',
      'constructor',
      'caja ',
      'register',
      'waiter',
    ])
      expect(
        (
          await api.send('/api/pairings', {
            payload: { pin: api.people.admin.pin, name: 'X', type },
            token: api.token,
          })
        ).statusCode,
        type,
      ).toBe(400)
  })

  it('malformed authorization token: 401, never 500', async () => {
    const api = setupApi()
    const headers = [
      'Bearer',
      'Bearer ',
      'Bearer  doble-espacio',
      'bearer minusculas',
      'Basic dXNlcjpwYXNz',
      'Bearer a b c',
      `Bearer ${'x'.repeat(8000)}`,
      'Bearer éè',
      "Bearer ' OR 1=1 --",
      '',
    ]
    for (const authorization of headers) {
      const r = await api.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { pin: '1234' },
        headers: { authorization: authorization },
      })
      expect(r.statusCode, authorization.slice(0, 30)).toBe(401)
    }
    await stillAlive(api)
  })

  it('a valid token does not work on a route for something else, and access routes only accept POST', async () => {
    const api = await withPairedDevice()
    for (const url of [...ROUTES_WITH_TOKEN, ...ROUTES_WITHOUT_TOKEN]) {
      for (const httpMethod of ['GET', 'PUT'] as const) {
        const r = await api.send(url, { httpMethod, token: api.token })
        expect(r.statusCode, `${httpMethod} ${url}`).toBe(404)
      }
    }
  })

  it('odd device ids on the revoke route: 4xx and the real device stays intact', async () => {
    const api = await withPairedDevice()
    // The register signs in with the admin password and the hub registers it.
    const admin = (
      await api.send('/api/sign-in', {
        payload: { user: api.people.admin.user, password: api.people.admin.password },
      })
    ).json()
    const token = admin.device.token as string
    const body = { session_id: admin.session_id, secret: admin.secret }

    for (const id of [
      'x',
      '%00',
      '%27%20OR%201%3D1',
      'a'.repeat(5000),
      '..%2f..%2fetc',
      newId(),
      '%E0%A4%A',
    ]) {
      const r = await api.send(`/api/devices/${id}/revoke`, { payload: body, token })
      expect(r.statusCode, id.slice(0, 20)).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, id.slice(0, 20)).toBeLessThan(500)
    }
    expect(
      api.db.prepare('SELECT count(*) AS n FROM devices WHERE revoked_at IS NOT NULL').get()?.n,
    ).toBe(0)
    // Without a body nothing is revoked either.
    const deviceId = (
      api.db.prepare("SELECT id FROM devices WHERE name = 'Equipo de Ana'").get() as {
        id: string
      }
    ).id
    const withoutBody = await api.send(`/api/devices/${deviceId}/revoke`, { token })
    expect(withoutBody.statusCode).toBe(400)
  })

  it("a waiter's session cannot remove devices, not even with its own token", async () => {
    const api = await withPairedDevice()
    const other = await api.send('/api/sign-in', {
      payload: { pin: api.people.waiter2.pin },
    })
    const target = other.json().device.device_id as string
    const r = await api.send(`/api/devices/${target}/revoke`, {
      payload: { session_id: api.session.session_id, secret: api.session.secret },
      token: api.token,
    })

    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ error: 'no_permission' })
    expect(api.revokedIds).toEqual([])
  })

  it('error responses do not reveal the PIN, the token or the session secret', async () => {
    const api = await withPairedDevice()
    const responses = [
      await api.send('/api/sessions', { payload: { pin: '0001' }, token: api.token }),
      await api.send('/api/sessions/close', {
        payload: { session_id: api.session.session_id, secret: 'y'.repeat(43) },
        token: api.token,
      }),
      await api.send('/api/authorizations', {
        payload: {
          ...api.session,
          pin: '0002',
          action: 'void_sent_item',
          aggregate_id: newId(),
          event_id: newId(),
        },
        token: api.token,
      }),
    ]
    for (const r of responses) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400)
      for (const secret of [api.token, api.session.secret, '0001', '0002', 'yyyy'])
        expect(r.body).not.toContain(secret)
    }
  })

  it('a flood of bad requests in a row does not stop the hub from answering good ones', async () => {
    const api = await withPairedDevice()
    const badRequests = []
    for (let i = 0; i < 200; i++)
      badRequests.push(
        api.raw(i % 2 ? '/api/sessions' : '/api/pair', i % 3 ? '{' : '[]', api.token),
      )
    const responses = await Promise.all(badRequests)

    expect(responses.every((r) => r.statusCode >= 400 && r.statusCode < 500)).toBe(true)
    const fine = await api.send('/api/sessions', {
      payload: { pin: api.people.waiter.pin },
      token: api.token,
    })
    expect(fine.statusCode).toBe(201)
  })

  it('requesting a pairing without a token or with a fake token: 401 without using up attempts', async () => {
    const api = await withPairedDevice()
    for (const token of [undefined, 'inventado', 'x'.repeat(2000)]) {
      for (let i = 0; i < 5; i++) {
        const r = await api.send('/api/pairings', {
          payload: { pin: '0001', name: 'X', type: 'kds' },
          token,
        })
        expect(r.statusCode).toBe(401)
        expect(r.json()).toMatchObject({ error: 'invalid_token' })
      }
    }
    // Someone who does have a device, with the right PIN, did not wait because of any of that.
    const fine = await api.send('/api/pairings', {
      payload: { pin: api.people.admin.pin, name: 'Cocina', type: 'kds' },
      token: api.token,
    })
    expect(fine.statusCode).toBe(201)
  })

  it('the authorization fingerprint: only 64 hexadecimal characters', async () => {
    const api = await withPairedDevice()
    const body = (fingerprint: unknown) => ({
      session_id: api.session.session_id,
      secret: api.session.secret,
      pin: api.people.manager.pin,
      action: 'void_sent_item',
      aggregate_id: newId(),
      event_id: newId(),
      fingerprint,
    })
    for (const fingerprint of [
      undefined,
      1,
      null,
      '',
      'abc',
      'g'.repeat(64),
      'A'.repeat(64),
      '0'.repeat(65),
    ]) {
      const r = await api.send('/api/authorizations', {
        payload: body(fingerprint) as object,
        token: api.token,
      })
      expect(r.statusCode, String(fingerprint)).toBe(400)
    }
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM authorizations').get()?.n)).toBe(0)
    const fine = await api.send('/api/authorizations', {
      payload: body('a'.repeat(64)) as object,
      token: api.token,
    })
    expect(fine.statusCode).toBe(201)
  })
})
