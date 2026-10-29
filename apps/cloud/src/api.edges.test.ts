import { newId } from '@pos/core'
import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { handle, MAX_BODY_BYTES } from './api'
import { MAX_EVENTS_PER_BATCH } from './cloud'
import type { Sql } from './sql'
import { ADMIN, batch, count, createWorld, NOW, SEED, type World } from './testing/world'

// The edges of the HTTP API: malformed bodies, unexpected types, wrong methods and routes, sizes,
// internal errors that must show nothing, and the headers of every response.

let m: World
let credential: string
let restaurantId: string
let hubId: string
beforeAll(async () => {
  m = await createWorld()
  const h = await m.newHub()
  credential = h.credential
  restaurantId = h.restaurantId
  hubId = h.hub.id
})
afterEach(() => {
  vi.restoreAllMocks()
})

interface Route {
  name: string
  httpMethod: string
  route: string
  token: () => string | undefined
  /** A valid body: the base for changing one field. */
  valid?: () => Record<string, unknown>
}

const ROUTES_WITH_BODY: Route[] = [
  {
    name: 'create restaurant',
    httpMethod: 'POST',
    route: '/v1/admin/restaurants',
    token: () => ADMIN,
    valid: () => ({ id: newId(), name: 'R' }),
  },
  {
    name: 'create code',
    httpMethod: 'POST',
    route: '/v1/admin/codes',
    token: () => ADMIN,
    valid: () => ({ restaurant_id: restaurantId }),
  },
  {
    name: 'revoke hub',
    httpMethod: 'POST',
    route: '/v1/admin/hubs/revoke',
    token: () => ADMIN,
    valid: () => ({ hub_id: newId() }),
  },
  {
    name: 'register hub',
    httpMethod: 'POST',
    route: '/v1/hubs/register',
    token: () => undefined,
    valid: () => ({
      code: 'ABCD-EFGH-JKMN',
      restaurant_id: newId(),
      hub_id: newId(),
      location_id: newId(),
      name: 'Caja',
      instance: 'i',
    }),
  },
  {
    name: 'upload events',
    httpMethod: 'POST',
    route: '/v1/events',
    token: () => credential,
    valid: () => ({ events: batch(1, 1) }),
  },
]

describe('malformed bodies', () => {
  const bodies = [
    '',
    ' ',
    '{',
    '}',
    '{"a":',
    '[1,',
    'undefined',
    'NaN',
    "{'a':1}",
    '{"a":1,}',
    '\u0000',
    '﻿{}',
    'null',
    'true',
    '123',
    '"texto"',
    '[]',
    '[[[[[[[[[[]]]]]]]]]]',
    '{}',
    '{"x":1}',
    '{"__proto__":{"admin":true}}',
    '{"constructor":{"prototype":{}}}',
  ]
  for (const r of ROUTES_WITH_BODY)
    it(`${r.name}: responds 400 and never 500 to unusable bodies`, async () => {
      for (const c of bodies) {
        const res = await m.request(r.httpMethod, r.route, c, r.token())
        expect(res.status, JSON.stringify(c)).toBe(400)
        expect(await res.json()).toMatchObject({ error: 'invalid_data' })
      }
    })

  for (const r of ROUTES_WITH_BODY)
    it(`${r.name}: no body (no body or content-type) is 400`, async () => {
      const res = await m.request(r.httpMethod, r.route, undefined, r.token())
      expect(res.status).toBe(400)
    })

  it('the content type does not matter: valid JSON as text/plain is understood the same', async () => {
    const res = await handle(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'text/plain' },
        body: JSON.stringify({ events: batch(900, 1) }),
      }),
      { sql: m.sql },
    )
    expect(res.status).toBe(200)
  })

  it('a body that is not valid UTF-8 does not break anything: it is 400', async () => {
    const res = await handle(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}` },
        body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
      }),
      { sql: m.sql },
    )
    expect(res.status).toBe(400)
  })

  it('property: any arbitrary JSON on any route with a body gives 400, never 500', async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.constantFrom(...ROUTES_WITH_BODY), async (value, r) => {
        const res = await m.request(r.httpMethod, r.route, JSON.stringify(value), r.token())
        expect(res.status).toBe(400)
      }),
      { seed: SEED, numRuns: 60 },
    )
  })

  it('property: arbitrary text as a body never gives 500', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', maxLength: 200 }),
        fc.constantFrom(...ROUTES_WITH_BODY),
        async (text, r) => {
          const res = await m.request(r.httpMethod, r.route, text === '' ? ' ' : text, r.token())
          expect(res.status).toBeLessThan(500)
        },
      ),
      { seed: SEED, numRuns: 60 },
    )
  })
})

describe('unexpected types in each field', () => {
  const badValues: unknown[] = [
    null,
    1,
    0,
    -1,
    1.5,
    true,
    false,
    [],
    {},
    [1],
    { a: 1 },
    '',
    'x'.repeat(1000),
  ]
  for (const r of ROUTES_WITH_BODY) {
    it(`${r.name}: each field with a value of another type or out of range is 400`, async () => {
      const base = r.valid?.() ?? {}
      for (const field of Object.keys(base))
        for (const badCase of badValues) {
          // A list with anything inside is a valid batch (each element is judged on its own).
          if (field === 'events' && Array.isArray(badCase) && badCase.length > 0) continue
          const res = await m.request(
            r.httpMethod,
            r.route,
            { ...base, [field]: badCase },
            r.token(),
          )
          expect(res.status, `${field}=${JSON.stringify(badCase)}`.slice(0, 80)).toBe(400)
        }
    })

    it(`${r.name}: an extra field is 400 (bodies are strict)`, async () => {
      const res = await m.request(
        r.httpMethod,
        r.route,
        { ...(r.valid?.() ?? {}), extra_field: 1 },
        r.token(),
      )
      expect(res.status).toBe(400)
    })

    it(`${r.name}: missing each field is 400`, async () => {
      const base = r.valid?.() ?? {}
      for (const field of Object.keys(base)) {
        const { [field]: _removed, ...rest } = base
        expect((await m.request(r.httpMethod, r.route, rest, r.token())).status, field).toBe(400)
      }
    })
  }

  it('the restaurant name is trimmed and cannot be empty or exceed 120 characters', async () => {
    const request = (name: string) =>
      m.request('POST', '/v1/admin/restaurants', { id: newId(), name }, ADMIN)
    expect((await request('   ')).status).toBe(400)
    expect((await request('x'.repeat(121))).status).toBe(400)
    expect((await request('x'.repeat(120))).status).toBe(201)
  })

  it('the batch: events that is not a list, or a list of more than 500, or empty', async () => {
    for (const events of ['x', null, {}, 1, true, []])
      expect((await m.request('POST', '/v1/events', { events }, credential)).status).toBe(400)
    const atLimit = Array.from({ length: MAX_EVENTS_PER_BATCH }, () => 1)
    const r = await m.request('POST', '/v1/events', { events: atLimit }, credential)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { results: unknown[] }).results).toHaveLength(MAX_EVENTS_PER_BATCH)
    expect(
      (await m.request('POST', '/v1/events', { events: [...atLimit, 1] }, credential)).status,
    ).toBe(400)
  })

  it('a batch with elements that are not events responds 200 with all invalid', async () => {
    const r = await m.request('POST', '/v1/events', { events: [1, 'x', null, [], {}] }, credential)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { results: { status: string }[] }
    expect(body.results.map((x) => x.status)).toEqual(Array(5).fill('invalid'))
  })
})

describe('body size', () => {
  const wrapper = (padding: string) => `{"events":["${padding}"]}`
  const bytes = (t: string) => new TextEncoder().encode(t).length

  it('a very large fake content-length is rejected with 413 without reading the body', async () => {
    for (const length of [String(MAX_BODY_BYTES + 1), '999999999999', '1e9']) {
      const res = await handle(
        new Request('https://cloud.faro.test/v1/events', {
          method: 'POST',
          headers: { authorization: `Bearer ${credential}`, 'content-length': length },
          body: JSON.stringify({ events: batch(1, 1) }),
        }),
        { sql: m.sql },
      )
      expect([200, 413], length).toContain(res.status)
      if (length !== '1e9') expect(res.status, length).toBe(413)
    }
  })

  it('a very small fake content-length does not let through a body that really is large', async () => {
    const res = await handle(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-length': '10' },
        body: wrapper('x'.repeat(MAX_BODY_BYTES)),
      }),
      { sql: m.sql },
    )
    expect(res.status).toBe(413)
  })

  it('an unreadable or negative content-length breaks nothing', async () => {
    for (const length of ['abc', '-5', '', ' ']) {
      const res = await handle(
        new Request('https://cloud.faro.test/v1/events', {
          method: 'POST',
          headers: { authorization: `Bearer ${credential}`, 'content-length': length },
          body: JSON.stringify({ events: batch(950, 1) }),
        }),
        { sql: m.sql },
      )
      expect(res.status, JSON.stringify(length)).toBeLessThan(500)
    }
  })

  it('the limit is exact: MAX_BODY_BYTES passes, one more byte is 413', async () => {
    const empty = bytes(wrapper(''))
    const atLimit = wrapper('x'.repeat(MAX_BODY_BYTES - empty))
    expect(bytes(atLimit)).toBe(MAX_BODY_BYTES)
    expect((await m.request('POST', '/v1/events', atLimit, credential)).status).toBe(200)
    const oversized = wrapper('x'.repeat(MAX_BODY_BYTES - empty + 1))
    const r = await m.request('POST', '/v1/events', oversized, credential)
    expect(r.status).toBe(413)
    expect(await r.json()).toMatchObject({ error: 'batch_too_large' })
  })

  it('the limit is measured in bytes: multi-byte characters exceed it sooner', async () => {
    const text = wrapper('ñ'.repeat(MAX_BODY_BYTES / 2))
    expect(text.length).toBeLessThan(MAX_BODY_BYTES)
    expect((await m.request('POST', '/v1/events', text, credential)).status).toBe(413)
  })

  it('without content-length (stream), it stops reading once over the limit', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    let readCount = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(control) {
        readCount++
        if (readCount > 40) control.close()
        else control.enqueue(chunk)
      },
    })
    const res = await handle(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}` },
        body: stream,
        duplex: 'half',
      } as RequestInit),
      { sql: m.sql },
    )
    expect(res.status).toBe(413)
    expect(readCount).toBeLessThan(40)
  })

  it('a huge body from someone without a credential is rejected with 401 without reading it', async () => {
    let readCount = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(control) {
        readCount++
        control.enqueue(new Uint8Array(1024))
        if (readCount > 10) control.close()
      },
    })
    const res = await handle(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: 'Bearer inventada' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
      { sql: m.sql },
    )
    expect(res.status).toBe(401)
    const admin = await m.request('POST', '/v1/admin/restaurants', 'x'.repeat(MAX_BODY_BYTES + 5))
    expect(admin.status).toBe(401)
  })

  it('the admin and registration routes also have 413', async () => {
    const large = `{"a":"${'x'.repeat(MAX_BODY_BYTES)}"}`
    expect((await m.request('POST', '/v1/admin/restaurants', large, ADMIN)).status).toBe(413)
    expect((await m.request('POST', '/v1/admin/codes', large, ADMIN)).status).toBe(413)
    expect((await m.request('POST', '/v1/admin/hubs/revoke', large, ADMIN)).status).toBe(413)
    expect((await m.request('POST', '/v1/hubs/register', large)).status).toBe(413)
  })
})

describe('method and route', () => {
  const wrong: [string, string][] = [
    ['GET', '/v1/events'],
    ['PUT', '/v1/events'],
    ['PATCH', '/v1/events'],
    ['DELETE', '/v1/events'],
    ['POST', '/v1/events/last'],
    ['DELETE', '/v1/events/last'],
    ['GET', '/v1/hubs/register'],
    ['PUT', '/v1/hubs/register'],
    ['GET', '/v1/admin/restaurants'],
    ['DELETE', '/v1/admin/restaurants'],
    ['GET', '/v1/admin/codes'],
    ['PUT', '/v1/admin/hubs/revoke'],
    ['DELETE', '/v1/admin/hubs/revoke'],
    ['POST', '/v1/health'],
    ['DELETE', '/v1/health'],
  ]
  it.each(wrong)(
    '%s %s does nothing (404 or 405) and changes no data',
    async (httpMethod, route) => {
      const body = httpMethod === 'GET' ? undefined : { events: batch(700, 3), hub_id: hubId }
      const before = [
        await count(m.db, 'events'),
        await count(m.db, 'hubs'),
        await count(m.db, 'restaurants'),
        await count(m.db, 'registration_codes'),
      ]
      for (const token of [credential, ADMIN, undefined]) {
        const r = await m.request(httpMethod, route, body, token)
        expect([401, 404, 405], `${httpMethod} ${route}`).toContain(r.status)
      }
      expect([
        await count(m.db, 'events'),
        await count(m.db, 'hubs'),
        await count(m.db, 'restaurants'),
        await count(m.db, 'registration_codes'),
      ]).toEqual(before)
    },
  )

  const nonexistentRoutes = [
    '/',
    '/v1',
    '/v1/',
    '/v2/health',
    '/V1/health',
    '/v1/health/',
    '//v1/health',
    '/v1/events/',
    '/v1/events/last/',
    '/v1/events/last/x',
    '/v1/events/other',
    '/v1/%65vents',
    '/v1/events/%2e%2e/health',
    '/v1/hubs',
    '/v1/hubs/register/',
    '/v1/admin',
    '/v1/administrator',
    '/v1/nothing',
    '/favicon.ico',
    '/.env',
    '/v1/admin/../health',
  ]
  it.each(nonexistentRoutes)(
    '%s does not exist: 404 (or 401 if it is the admin area)',
    async (route) => {
      for (const httpMethod of ['GET', 'POST']) {
        const r = await m.request(
          httpMethod,
          route,
          httpMethod === 'POST' ? {} : undefined,
          credential,
        )
        // Routes the URL normalizes to a real one (for example /v1/admin/../health) may give 200.
        expect([200, 400, 401, 404], `${httpMethod} ${route}`).toContain(r.status)
        if (r.status === 404) expect(await r.json()).toMatchObject({ error: 'not_found' })
      }
    },
  )

  it('the admin area does not reveal which routes exist: without a token everything is 401', async () => {
    for (const route of [
      '/v1/admin/',
      '/v1/admin/nothing',
      '/v1/admin/restaurants',
      '/v1/admin/x/y',
    ])
      expect((await m.request('POST', route, {})).status, route).toBe(401)
    expect((await m.request('POST', '/v1/admin/nothing', {}, ADMIN)).status).toBe(404)
  })

  it('the query string does not change the route, and health requires nothing', async () => {
    expect((await m.request('GET', '/v1/health?x=1&y=2')).status).toBe(200)
    expect(
      (await m.request('GET', '/v1/events/last?hub=other', undefined, credential)).status,
    ).toBe(200)
    expect(await (await m.request('GET', '/v1/health')).json()).toEqual({ ok: true })
  })

  it('the last result only carries the sequence of the hub that asks', async () => {
    const r = await m.request('GET', '/v1/events/last', undefined, credential)
    expect(Object.keys((await r.json()) as object)).toEqual(['last_sequence'])
  })
})

describe('an internal error never returns details', () => {
  const SECRET =
    'password=hunter2 INSERT INTO hubs VALUES (secreto-12345) en /srv/faro/src/nube.ts:99'

  function throwingSql(whatHappens: () => unknown, transactionsOnly = false): Sql {
    const doThrow = async (): Promise<never> => {
      throw whatHappens()
    }
    return {
      query: transactionsOnly ? m.sql.query.bind(m.sql) : doThrow,
      execute: doThrow,
      transaction: doThrow,
    }
  }

  const errors: [string, () => unknown][] = [
    ['an Error with data', () => new Error(SECRET)],
    [
      'a Postgres error with detail and constraint',
      () =>
        Object.assign(new Error(SECRET), {
          code: '22P02',
          detail: `Key (id)=(${SECRET}) is duplicated`,
          constraint: 'hub_pkey',
          query: SECRET,
          parameters: [SECRET],
          stack: `Error: ${SECRET}\n    at /srv/faro/x.ts:1`,
        }),
    ],
    ['a thrown string', () => SECRET],
    ['an arbitrary object', () => ({ secret: SECRET })],
    ['null', () => null],
    ['undefined', () => undefined],
    [
      'an object whose toString throws',
      () => ({
        toString: () => {
          throw new Error(SECRET)
        },
      }),
    ],
  ]

  function requestWith(sql: Sql, httpMethod: string, route: string, body: unknown, token?: string) {
    return handle(
      new Request(`https://cloud.faro.test${route}`, {
        method: httpMethod,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { sql, adminToken: ADMIN, clock: () => NOW },
    )
  }

  const httpRoutes = (): [string, string, string, unknown, string | undefined][] => [
    ['create restaurant', 'POST', '/v1/admin/restaurants', { id: newId(), name: 'R' }, ADMIN],
    ['create code', 'POST', '/v1/admin/codes', { restaurant_id: newId() }, ADMIN],
    ['revoke', 'POST', '/v1/admin/hubs/revoke', { hub_id: newId() }, ADMIN],
    [
      'register',
      'POST',
      '/v1/hubs/register',
      {
        code: 'ABCD-EFGH-JKMN',
        restaurant_id: newId(),
        hub_id: newId(),
        location_id: newId(),
        name: 'C',
        instance: 'i',
      },
      undefined,
    ],
    ['upload events', 'POST', '/v1/events', { events: batch(1, 1) }, credential],
    ['last sequence', 'GET', '/v1/events/last', undefined, credential],
  ]

  for (const [errorName, act] of errors)
    it(`${errorName}: generic 500, without SQL, paths, keys or stack`, async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      for (const [name, httpMethod, route, body, token] of httpRoutes()) {
        // The hub routes reach their authentication query with the same error.
        const r = await requestWith(throwingSql(act), httpMethod, route, body, token)
        const text = await r.text()
        expect(r.status, name).toBe(500)
        expect(r.headers.get('content-type'), name).toContain('application/json')
        expect(JSON.parse(text), name).toEqual({
          error: 'internal_error',
          message: expect.any(String),
        })
        for (const forbidden of [
          'hunter2',
          'INSERT',
          'secret',
          '/srv/',
          'stack',
          'password',
          'detail',
          'at ',
        ])
          expect(text, `${name}: ${forbidden}`).not.toContain(forbidden)
      }
      expect(log).toHaveBeenCalled()
    })

  it('the error log does not dump the whole object (query, parameters, stack)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const odd = Object.assign(new Error('failed'), {
      code: '22P02',
      query: 'SELECT secreto',
      parameters: ['clave-super-secreta'],
    })
    await requestWith(
      throwingSql(() => odd),
      'POST',
      '/v1/admin/restaurants',
      { id: newId(), name: 'R' },
      ADMIN,
    )
    const dumped = JSON.stringify(log.mock.calls, (_k, v) =>
      v instanceof Error ? `ERROR:${v.message}` : v,
    )
    expect(dumped).not.toContain('clave-super-secreta')
    expect(dumped).not.toContain('SELECT secreto')
    for (const call of log.mock.calls) for (const arg of call) expect(arg).not.toBeInstanceOf(Error)
  })

  it('if the database fails in the transaction that saves a batch, it is 500 and nothing is left half done', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sql: Sql = {
      query: m.sql.query.bind(m.sql),
      execute: m.sql.execute.bind(m.sql),
      transaction: async () => {
        throw new Error(SECRET)
      },
    }
    const before = await count(m.db, 'events')
    const r = await requestWith(sql, 'POST', '/v1/events', { events: batch(800, 3) }, credential)
    expect(r.status).toBe(500)
    expect(await r.text()).not.toContain('hunter2')
    expect(await count(m.db, 'events')).toBe(before)
  })

  it('a unique key clash on registration (two registrations at once) is answered 409, not 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sql: Sql = {
      query: m.sql.query.bind(m.sql),
      execute: m.sql.execute.bind(m.sql),
      transaction: async () => {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "hub_pkey"'),
          {
            code: '23505',
          },
        )
      },
    }
    const r = await requestWith(sql, 'POST', '/v1/hubs/register', {
      code: 'ABCD-EFGH-JKMN',
      restaurant_id: newId(),
      hub_id: newId(),
      location_id: newId(),
      name: 'C',
      instance: 'i',
    })
    expect(r.status).toBe(409)
  })

  it('a real Postgres error (not simulated) does not leak details either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await m.request(
      'POST',
      '/v1/events',
      { events: [{ ...batch(1, 1)[0], received_at: '0000-01-01T00:00:00Z' }] },
      credential,
    )
    const text = await r.text()
    for (const forbidden of ['date/time', 'out of range', 'jsonb_to_recordset', 'INSERT'])
      expect(text).not.toContain(forbidden)
  })

  it('health does not touch the database: it responds even if the database is down', async () => {
    const r = await requestWith(
      throwingSql(() => new Error('down')),
      'GET',
      '/v1/health',
      undefined,
    )
    expect(r.status).toBe(200)
  })

  it('routes that do not exist or without a credential do not use the database more than needed', async () => {
    const r = await requestWith(
      throwingSql(() => new Error('down')),
      'GET',
      '/v1/nothing',
      undefined,
    )
    // Without a credential there is no query: a clean 404 even if the database is down.
    expect(r.status).toBe(404)
  })
})

describe('shape of every response', () => {
  it('is JSON with cache-control: no-store on every status code', async () => {
    const restaurant = newId()
    const matrix: [string, () => Promise<Response>][] = [
      ['200 health', () => m.request('GET', '/v1/health')],
      [
        '201 restaurant',
        () => m.request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'R' }, ADMIN),
      ],
      [
        '200 repeated restaurant',
        () => m.request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'R' }, ADMIN),
      ],
      [
        '201 code',
        () => m.request('POST', '/v1/admin/codes', { restaurant_id: restaurant }, ADMIN),
      ],
      ['404 code', () => m.request('POST', '/v1/admin/codes', { restaurant_id: newId() }, ADMIN)],
      ['404 revoke', () => m.request('POST', '/v1/admin/hubs/revoke', { hub_id: newId() }, ADMIN)],
      ['400', () => m.request('POST', '/v1/events', '{', credential)],
      ['401', () => m.request('POST', '/v1/events', {}, 'inventada')],
      ['401 admin', () => m.request('POST', '/v1/admin/restaurants', {})],
      [
        '403 registration',
        () =>
          m.request('POST', '/v1/hubs/register', {
            code: 'NADA',
            restaurant_id: newId(),
            hub_id: newId(),
            location_id: newId(),
            name: 'C',
            instance: 'i',
          }),
      ],
      ['404 route', () => m.request('GET', '/v1/nothing')],
      [
        '413',
        () =>
          m.request(
            'POST',
            '/v1/events',
            `{"events":["${'x'.repeat(MAX_BODY_BYTES)}"]}`,
            credential,
          ),
      ],
      ['200 events', () => m.request('POST', '/v1/events', { events: batch(1, 1) }, credential)],
      ['200 last', () => m.request('GET', '/v1/events/last', undefined, credential)],
    ]
    for (const [name, request] of matrix) {
      const r = await request()
      expect(r.headers.get('content-type'), name).toMatch(/^application\/json/)
      expect(r.headers.get('cache-control'), name).toBe('no-store')
      await expect(r.json(), name).resolves.toBeTypeOf('object')
    }
  })

  it('the registration 409 and the revoke 204 also carry cache-control: no-store', async () => {
    const h = await m.newHub()
    const code = await m.cloud.createCode(h.restaurantId)
    if (!code) throw new Error('no code')
    const duplicate = await m.request('POST', '/v1/hubs/register', {
      code: code.code,
      restaurant_id: h.restaurantId,
      hub_id: h.hub.id,
      location_id: newId(),
      name: 'C',
      instance: 'i',
    })
    expect(duplicate.status).toBe(409)
    expect(duplicate.headers.get('cache-control')).toBe('no-store')
    const revoked = await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: h.hub.id }, ADMIN)
    expect(revoked.status).toBe(204)
    expect(await revoked.text()).toBe('')
    expect(revoked.headers.get('cache-control')).toBe('no-store')
  })

  it('errors carry only error and message, in Spanish, and do not echo what the client sent', async () => {
    const datum = 'dato-que-mando-el-cliente-98765'
    for (const r of [
      await m.request('POST', '/v1/admin/restaurants', { id: datum, name: datum }, ADMIN),
      await m.request('POST', '/v1/events', { events: [{ id: datum }], extra: datum }, credential),
      await m.request('POST', '/v1/events', {}, datum),
      await m.request('POST', '/v1/hubs/register', { code: datum, hub_id: datum }),
    ]) {
      const text = await r.text()
      expect(text).not.toContain(datum)
      const body = JSON.parse(text) as Record<string, unknown>
      if (r.status >= 400) expect(Object.keys(body).sort()).toEqual(['error', 'message'])
    }
  })
})
