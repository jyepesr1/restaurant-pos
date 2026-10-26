import { newId } from '@pos/core'
import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { atender, MAX_BYTES_CUERPO } from './api'
import { MAX_EVENTOS_POR_LOTE } from './nube'
import { ADMIN, AHORA, batch, contar, crearMundo, type Mundo, SEMILLA } from './pruebas/mundo'
import type { Sql } from './sql'

// Los bordes de la API HTTP: cuerpos malformados, tipos inesperados, métodos y rutas que no son,
// tamaños, errores internos que no deben mostrar nada, y las cabeceras de toda respuesta.

let m: Mundo
let credential: string
let restauranteId: string
let hubId: string
beforeAll(async () => {
  m = await crearMundo()
  const h = await m.nuevoHub()
  credential = h.credential
  restauranteId = h.restauranteId
  hubId = h.hub.id
})
afterEach(() => {
  vi.restoreAllMocks()
})

interface Ruta {
  name: string
  metodo: string
  ruta: string
  token: () => string | undefined
  /** Un cuerpo válido: sirve de base para cambiarle un campo. */
  valid?: () => Record<string, unknown>
}

const RUTAS_CON_CUERPO: Ruta[] = [
  {
    name: 'crear restaurante',
    metodo: 'POST',
    ruta: '/v1/admin/restaurants',
    token: () => ADMIN,
    valid: () => ({ id: newId(), name: 'R' }),
  },
  {
    name: 'crear código',
    metodo: 'POST',
    ruta: '/v1/admin/codes',
    token: () => ADMIN,
    valid: () => ({ restaurant_id: restauranteId }),
  },
  {
    name: 'revocar hub',
    metodo: 'POST',
    ruta: '/v1/admin/hubs/revoke',
    token: () => ADMIN,
    valid: () => ({ hub_id: newId() }),
  },
  {
    name: 'registrar hub',
    metodo: 'POST',
    ruta: '/v1/hubs/register',
    token: () => undefined,
    valid: () => ({
      code: 'ABCD-EFGH-JKMN',
      hub_id: newId(),
      location_id: newId(),
      name: 'Caja',
      instancia: 'i',
    }),
  },
  {
    name: 'subir eventos',
    metodo: 'POST',
    ruta: '/v1/events',
    token: () => credential,
    valid: () => ({ events: batch(1, 1) }),
  },
]

describe('cuerpos malformados', () => {
  const cuerpos = [
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
  for (const r of RUTAS_CON_CUERPO)
    it(`${r.name}: responde 400 y nunca 500 ante cuerpos que no sirven`, async () => {
      for (const c of cuerpos) {
        const res = await m.request(r.metodo, r.ruta, c, r.token())
        expect(res.status, JSON.stringify(c)).toBe(400)
        expect(await res.json()).toMatchObject({ error: 'invalid_data' })
      }
    })

  for (const r of RUTAS_CON_CUERPO)
    it(`${r.name}: sin cuerpo (sin body ni content-type) es 400`, async () => {
      const res = await m.request(r.metodo, r.ruta, undefined, r.token())
      expect(res.status).toBe(400)
    })

  it('el tipo de contenido no importa: un JSON válido como text/plain se entiende igual', async () => {
    const res = await atender(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'text/plain' },
        body: JSON.stringify({ events: batch(900, 1) }),
      }),
      { sql: m.sql },
    )
    expect(res.status).toBe(200)
  })

  it('un cuerpo que no es UTF-8 válido no rompe: es 400', async () => {
    const res = await atender(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}` },
        body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
      }),
      { sql: m.sql },
    )
    expect(res.status).toBe(400)
  })

  it('propiedad: cualquier JSON arbitrario en cualquier ruta con cuerpo da 400, nunca 500', async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.constantFrom(...RUTAS_CON_CUERPO), async (value, r) => {
        const res = await m.request(r.metodo, r.ruta, JSON.stringify(value), r.token())
        expect(res.status).toBe(400)
      }),
      { seed: SEMILLA, numRuns: 60 },
    )
  })

  it('propiedad: texto cualquiera como cuerpo nunca da 500', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', maxLength: 200 }),
        fc.constantFrom(...RUTAS_CON_CUERPO),
        async (text, r) => {
          const res = await m.request(r.metodo, r.ruta, text === '' ? ' ' : text, r.token())
          expect(res.status).toBeLessThan(500)
        },
      ),
      { seed: SEMILLA, numRuns: 60 },
    )
  })
})

describe('tipos inesperados en cada campo', () => {
  const valoresMalos: unknown[] = [
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
  for (const r of RUTAS_CON_CUERPO) {
    it(`${r.name}: cada campo con un valor de otro tipo o fuera de rango es 400`, async () => {
      const base = r.valid?.() ?? {}
      for (const field of Object.keys(base))
        for (const badCase of valoresMalos) {
          // Una lista con cualquier cosa dentro es un lote válido (cada elemento se juzga solo).
          if (field === 'events' && Array.isArray(badCase) && badCase.length > 0) continue
          const res = await m.request(r.metodo, r.ruta, { ...base, [field]: badCase }, r.token())
          expect(res.status, `${field}=${JSON.stringify(badCase)}`.slice(0, 80)).toBe(400)
        }
    })

    it(`${r.name}: un campo de más es 400 (los cuerpos son estrictos)`, async () => {
      const res = await m.request(
        r.metodo,
        r.ruta,
        { ...(r.valid?.() ?? {}), de_mas: 1 },
        r.token(),
      )
      expect(res.status).toBe(400)
    })

    it(`${r.name}: faltando cada campo es 400`, async () => {
      const base = r.valid?.() ?? {}
      for (const field of Object.keys(base)) {
        const { [field]: _removed, ...rest } = base
        expect((await m.request(r.metodo, r.ruta, rest, r.token())).status, field).toBe(400)
      }
    })
  }

  it('el nombre del restaurante se recorta y no puede quedar vacío ni pasar de 120 caracteres', async () => {
    const request = (name: string) =>
      m.request('POST', '/v1/admin/restaurants', { id: newId(), name }, ADMIN)
    expect((await request('   ')).status).toBe(400)
    expect((await request('x'.repeat(121))).status).toBe(400)
    expect((await request('x'.repeat(120))).status).toBe(201)
  })

  it('el lote: eventos que no es lista, o lista de más de 500, o vacía', async () => {
    for (const events of ['x', null, {}, 1, true, []])
      expect((await m.request('POST', '/v1/events', { events }, credential)).status).toBe(400)
    const justo = Array.from({ length: MAX_EVENTOS_POR_LOTE }, () => 1)
    const r = await m.request('POST', '/v1/events', { events: justo }, credential)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { resultados: unknown[] }).resultados).toHaveLength(
      MAX_EVENTOS_POR_LOTE,
    )
    expect(
      (await m.request('POST', '/v1/events', { events: [...justo, 1] }, credential)).status,
    ).toBe(400)
  })

  it('un lote con elementos que no son eventos responde 200 con todos inválidos', async () => {
    const r = await m.request('POST', '/v1/events', { events: [1, 'x', null, [], {}] }, credential)
    expect(r.status).toBe(200)
    const cuerpo = (await r.json()) as { resultados: { status: string }[] }
    expect(cuerpo.resultados.map((x) => x.status)).toEqual(Array(5).fill('invalid'))
  })
})

describe('tamaño del cuerpo', () => {
  const envoltura = (relleno: string) => `{"events":["${relleno}"]}`
  const bytes = (t: string) => new TextEncoder().encode(t).length

  it('un content-length falso muy grande se rechaza con 413 sin leer el cuerpo', async () => {
    for (const length of [String(MAX_BYTES_CUERPO + 1), '999999999999', '1e9']) {
      const res = await atender(
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

  it('un content-length falso muy chico no deja pasar un cuerpo que de verdad es grande', async () => {
    const res = await atender(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-length': '10' },
        body: envoltura('x'.repeat(MAX_BYTES_CUERPO)),
      }),
      { sql: m.sql },
    )
    expect(res.status).toBe(413)
  })

  it('un content-length ilegible o negativo no rompe nada', async () => {
    for (const length of ['abc', '-5', '', ' ']) {
      const res = await atender(
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

  it('el límite es exacto: MAX_BYTES_CUERPO pasa, un byte más es 413', async () => {
    const empty = bytes(envoltura(''))
    const justo = envoltura('x'.repeat(MAX_BYTES_CUERPO - empty))
    expect(bytes(justo)).toBe(MAX_BYTES_CUERPO)
    expect((await m.request('POST', '/v1/events', justo, credential)).status).toBe(200)
    const demas = envoltura('x'.repeat(MAX_BYTES_CUERPO - empty + 1))
    const r = await m.request('POST', '/v1/events', demas, credential)
    expect(r.status).toBe(413)
    expect(await r.json()).toMatchObject({ error: 'batch_too_large' })
  })

  it('el límite se mide en bytes: caracteres de varios bytes se pasan antes', async () => {
    const text = envoltura('ñ'.repeat(MAX_BYTES_CUERPO / 2))
    expect(text.length).toBeLessThan(MAX_BYTES_CUERPO)
    expect((await m.request('POST', '/v1/events', text, credential)).status).toBe(413)
  })

  it('sin content-length (flujo), deja de leer al pasarse del límite', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    let leidos = 0
    const flujo = new ReadableStream<Uint8Array>({
      pull(control) {
        leidos++
        if (leidos > 40) control.close()
        else control.enqueue(chunk)
      },
    })
    const res = await atender(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}` },
        body: flujo,
        duplex: 'half',
      } as RequestInit),
      { sql: m.sql },
    )
    expect(res.status).toBe(413)
    expect(leidos).toBeLessThan(40)
  })

  it('un cuerpo enorme de alguien sin credencial se rechaza con 401 sin leerlo', async () => {
    let leidos = 0
    const flujo = new ReadableStream<Uint8Array>({
      pull(control) {
        leidos++
        control.enqueue(new Uint8Array(1024))
        if (leidos > 10) control.close()
      },
    })
    const res = await atender(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: 'Bearer inventada' },
        body: flujo,
        duplex: 'half',
      } as RequestInit),
      { sql: m.sql },
    )
    expect(res.status).toBe(401)
    const admin = await m.request('POST', '/v1/admin/restaurants', 'x'.repeat(MAX_BYTES_CUERPO + 5))
    expect(admin.status).toBe(401)
  })

  it('en las rutas de administración y de registro también hay 413', async () => {
    const large = `{"a":"${'x'.repeat(MAX_BYTES_CUERPO)}"}`
    expect((await m.request('POST', '/v1/admin/restaurants', large, ADMIN)).status).toBe(413)
    expect((await m.request('POST', '/v1/admin/codes', large, ADMIN)).status).toBe(413)
    expect((await m.request('POST', '/v1/admin/hubs/revoke', large, ADMIN)).status).toBe(413)
    expect((await m.request('POST', '/v1/hubs/register', large)).status).toBe(413)
  })
})

describe('método y ruta', () => {
  const equivocados: [string, string][] = [
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
  it.each(equivocados)('%s %s no hace nada (404 o 405) ni cambia datos', async (metodo, ruta) => {
    const cuerpo = metodo === 'GET' ? undefined : { events: batch(700, 3), hub_id: hubId }
    const before = [
      await contar(m.db, 'events'),
      await contar(m.db, 'hubs'),
      await contar(m.db, 'restaurants'),
      await contar(m.db, 'registration_codes'),
    ]
    for (const token of [credential, ADMIN, undefined]) {
      const r = await m.request(metodo, ruta, cuerpo, token)
      expect([401, 404, 405], `${metodo} ${ruta}`).toContain(r.status)
    }
    expect([
      await contar(m.db, 'events'),
      await contar(m.db, 'hubs'),
      await contar(m.db, 'restaurants'),
      await contar(m.db, 'registration_codes'),
    ]).toEqual(before)
  })

  const inexistentes = [
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
  it.each(inexistentes)(
    '%s no existe: 404 (o 401 si es la zona de administración)',
    async (ruta) => {
      for (const metodo of ['GET', 'POST']) {
        const r = await m.request(metodo, ruta, metodo === 'POST' ? {} : undefined, credential)
        // Las rutas que normaliza la URL a una real (por ejemplo /v1/admin/../salud) pueden dar 200.
        expect([200, 400, 401, 404], `${metodo} ${ruta}`).toContain(r.status)
        if (r.status === 404) expect(await r.json()).toMatchObject({ error: 'not_found' })
      }
    },
  )

  it('la zona de administración no revela qué rutas existen: sin token todo es 401', async () => {
    for (const ruta of [
      '/v1/admin/',
      '/v1/admin/nothing',
      '/v1/admin/restaurants',
      '/v1/admin/x/y',
    ])
      expect((await m.request('POST', ruta, {})).status, ruta).toBe(401)
    expect((await m.request('POST', '/v1/admin/nothing', {}, ADMIN)).status).toBe(404)
  })

  it('la cadena de consulta no cambia la ruta, y la salud no pide nada', async () => {
    expect((await m.request('GET', '/v1/health?x=1&y=2')).status).toBe(200)
    expect(
      (await m.request('GET', '/v1/events/last?hub=other', undefined, credential)).status,
    ).toBe(200)
    expect(await (await m.request('GET', '/v1/health')).json()).toEqual({ ok: true })
  })

  it('el resultado de ultima trae solo la secuencia del hub que pregunta', async () => {
    const r = await m.request('GET', '/v1/events/last', undefined, credential)
    expect(Object.keys((await r.json()) as object)).toEqual(['last_sequence'])
  })
})

describe('un error interno nunca devuelve detalles', () => {
  const SECRETO =
    'password=hunter2 INSERT INTO hubs VALUES (secreto-12345) en /srv/faro/src/nube.ts:99'

  function sqlQueLanza(quePasa: () => unknown, soloTransacciones = false): Sql {
    const lanzar = async (): Promise<never> => {
      throw quePasa()
    }
    return {
      query: soloTransacciones ? m.sql.query.bind(m.sql) : lanzar,
      execute: lanzar,
      transaccion: lanzar,
    }
  }

  const errors: [string, () => unknown][] = [
    ['un Error con datos', () => new Error(SECRETO)],
    [
      'un error de Postgres con detalle y restricción',
      () =>
        Object.assign(new Error(SECRETO), {
          code: '22P02',
          detail: `Key (id)=(${SECRETO}) is duplicated`,
          constraint: 'hub_pkey',
          query: SECRETO,
          parameters: [SECRETO],
          stack: `Error: ${SECRETO}\n    at /srv/faro/x.ts:1`,
        }),
    ],
    ['un texto lanzado', () => SECRETO],
    ['un objeto cualquiera', () => ({ secret: SECRETO })],
    ['null', () => null],
    ['undefined', () => undefined],
    [
      'un objeto con toString que lanza',
      () => ({
        toString: () => {
          throw new Error(SECRETO)
        },
      }),
    ],
  ]

  function pedirCon(sql: Sql, metodo: string, ruta: string, cuerpo: unknown, token?: string) {
    return atender(
      new Request(`https://cloud.faro.test${ruta}`, {
        method: metodo,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      }),
      { sql, tokenAdmin: ADMIN, clock: () => AHORA },
    )
  }

  const rutasHttp = (): [string, string, string, unknown, string | undefined][] => [
    ['crear restaurante', 'POST', '/v1/admin/restaurants', { id: newId(), name: 'R' }, ADMIN],
    ['crear código', 'POST', '/v1/admin/codes', { restaurant_id: newId() }, ADMIN],
    ['revoke', 'POST', '/v1/admin/hubs/revoke', { hub_id: newId() }, ADMIN],
    [
      'registrar',
      'POST',
      '/v1/hubs/register',
      {
        code: 'ABCD-EFGH-JKMN',
        hub_id: newId(),
        location_id: newId(),
        name: 'C',
        instancia: 'i',
      },
      undefined,
    ],
    ['subir eventos', 'POST', '/v1/events', { events: batch(1, 1) }, credential],
    ['ultima secuencia', 'GET', '/v1/events/last', undefined, credential],
  ]

  for (const [nombreError, hacer] of errors)
    it(`${nombreError}: 500 genérico, sin SQL, rutas, claves ni pila`, async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      for (const [name, metodo, ruta, cuerpo, token] of rutasHttp()) {
        // Las rutas de hub llegan a su consulta de autenticación con el mismo error.
        const r = await pedirCon(sqlQueLanza(hacer), metodo, ruta, cuerpo, token)
        const text = await r.text()
        expect(r.status, name).toBe(500)
        expect(r.headers.get('content-type'), name).toContain('application/json')
        expect(JSON.parse(text), name).toEqual({
          error: 'internal_error',
          message: expect.any(String),
        })
        for (const prohibido of [
          'hunter2',
          'INSERT',
          'secret',
          '/srv/',
          'stack',
          'password',
          'detail',
          'at ',
        ])
          expect(text, `${name}: ${prohibido}`).not.toContain(prohibido)
      }
      expect(log).toHaveBeenCalled()
    })

  it('el registro del error no vuelca el objeto completo (consulta, parámetros, pila)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const odd = Object.assign(new Error('falló'), {
      code: '22P02',
      query: 'SELECT secreto',
      parameters: ['clave-super-secreta'],
    })
    await pedirCon(
      sqlQueLanza(() => odd),
      'POST',
      '/v1/admin/restaurants',
      { id: newId(), name: 'R' },
      ADMIN,
    )
    const volcado = JSON.stringify(log.mock.calls, (_k, v) =>
      v instanceof Error ? `ERROR:${v.message}` : v,
    )
    expect(volcado).not.toContain('clave-super-secreta')
    expect(volcado).not.toContain('SELECT secreto')
    for (const llamada of log.mock.calls)
      for (const arg of llamada) expect(arg).not.toBeInstanceOf(Error)
  })

  it('si la base falla en la transacción de guardar un lote, es 500 y no queda nada a medias', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sql: Sql = {
      query: m.sql.query.bind(m.sql),
      execute: m.sql.execute.bind(m.sql),
      transaccion: async () => {
        throw new Error(SECRETO)
      },
    }
    const before = await contar(m.db, 'events')
    const r = await pedirCon(sql, 'POST', '/v1/events', { events: batch(800, 3) }, credential)
    expect(r.status).toBe(500)
    expect(await r.text()).not.toContain('hunter2')
    expect(await contar(m.db, 'events')).toBe(before)
  })

  it('un choque de clave única al registrar (dos registros a la vez) se contesta 409, no 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sql: Sql = {
      query: m.sql.query.bind(m.sql),
      execute: m.sql.execute.bind(m.sql),
      transaccion: async () => {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "hub_pkey"'),
          {
            code: '23505',
          },
        )
      },
    }
    const r = await pedirCon(sql, 'POST', '/v1/hubs/register', {
      code: 'ABCD-EFGH-JKMN',
      hub_id: newId(),
      location_id: newId(),
      name: 'C',
      instancia: 'i',
    })
    expect(r.status).toBe(409)
  })

  it('un error real de Postgres (no simulado) tampoco filtra detalles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await m.request(
      'POST',
      '/v1/events',
      { events: [{ ...batch(1, 1)[0], received_at: '0000-01-01T00:00:00Z' }] },
      credential,
    )
    const text = await r.text()
    for (const prohibido of ['date/time', 'out of range', 'jsonb_to_recordset', 'INSERT'])
      expect(text).not.toContain(prohibido)
  })

  it('la salud no toca la base: responde aunque la base esté caída', async () => {
    const r = await pedirCon(
      sqlQueLanza(() => new Error('caída')),
      'GET',
      '/v1/health',
      undefined,
    )
    expect(r.status).toBe(200)
  })

  it('rutas que no existen o sin credencial no usan la base más de lo necesario', async () => {
    const r = await pedirCon(
      sqlQueLanza(() => new Error('caída')),
      'GET',
      '/v1/nothing',
      undefined,
    )
    // Sin credencial no hay consulta: 404 limpio aunque la base esté caída.
    expect(r.status).toBe(404)
  })
})

describe('forma de toda respuesta', () => {
  it('es JSON con cache-control: no-store en cada código de estado', async () => {
    const restaurant = newId()
    const matriz: [string, () => Promise<Response>][] = [
      ['200 salud', () => m.request('GET', '/v1/health')],
      [
        '201 restaurante',
        () => m.request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'R' }, ADMIN),
      ],
      [
        '200 restaurante repetido',
        () => m.request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'R' }, ADMIN),
      ],
      [
        '201 código',
        () => m.request('POST', '/v1/admin/codes', { restaurant_id: restaurant }, ADMIN),
      ],
      ['404 código', () => m.request('POST', '/v1/admin/codes', { restaurant_id: newId() }, ADMIN)],
      ['404 revocar', () => m.request('POST', '/v1/admin/hubs/revoke', { hub_id: newId() }, ADMIN)],
      ['400', () => m.request('POST', '/v1/events', '{', credential)],
      ['401', () => m.request('POST', '/v1/events', {}, 'inventada')],
      ['401 admin', () => m.request('POST', '/v1/admin/restaurants', {})],
      [
        '403 registro',
        () =>
          m.request('POST', '/v1/hubs/register', {
            code: 'NADA',
            hub_id: newId(),
            location_id: newId(),
            name: 'C',
            instancia: 'i',
          }),
      ],
      ['404 ruta', () => m.request('GET', '/v1/nothing')],
      [
        '413',
        () =>
          m.request(
            'POST',
            '/v1/events',
            `{"events":["${'x'.repeat(MAX_BYTES_CUERPO)}"]}`,
            credential,
          ),
      ],
      ['200 eventos', () => m.request('POST', '/v1/events', { events: batch(1, 1) }, credential)],
      ['200 ultima', () => m.request('GET', '/v1/events/last', undefined, credential)],
    ]
    for (const [name, request] of matriz) {
      const r = await request()
      expect(r.headers.get('content-type'), name).toMatch(/^application\/json/)
      expect(r.headers.get('cache-control'), name).toBe('no-store')
      await expect(r.json(), name).resolves.toBeTypeOf('object')
    }
  })

  it('el 409 de registro y el 204 de revocar también llevan cache-control: no-store', async () => {
    const h = await m.nuevoHub()
    const code = await m.nube.crearCodigo(h.restauranteId)
    if (!code) throw new Error('sin código')
    const duplicado = await m.request('POST', '/v1/hubs/register', {
      code: code.code,
      hub_id: h.hub.id,
      location_id: newId(),
      name: 'C',
      instancia: 'i',
    })
    expect(duplicado.status).toBe(409)
    expect(duplicado.headers.get('cache-control')).toBe('no-store')
    const revocado = await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: h.hub.id }, ADMIN)
    expect(revocado.status).toBe(204)
    expect(await revocado.text()).toBe('')
    expect(revocado.headers.get('cache-control')).toBe('no-store')
  })

  it('los errores traen solo error y mensaje, en español, y no repiten lo que mandó el cliente', async () => {
    const dato = 'dato-que-mando-el-cliente-98765'
    for (const r of [
      await m.request('POST', '/v1/admin/restaurants', { id: dato, name: dato }, ADMIN),
      await m.request('POST', '/v1/events', { events: [{ id: dato }], extra: dato }, credential),
      await m.request('POST', '/v1/events', {}, dato),
      await m.request('POST', '/v1/hubs/register', { code: dato, hub_id: dato }),
    ]) {
      const text = await r.text()
      expect(text).not.toContain(dato)
      const cuerpo = JSON.parse(text) as Record<string, unknown>
      if (r.status >= 400) expect(Object.keys(cuerpo).sort()).toEqual(['error', 'message'])
    }
  })
})
