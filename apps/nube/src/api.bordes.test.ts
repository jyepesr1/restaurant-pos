import { nuevoId } from '@pos/core'
import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { atender, MAX_BYTES_CUERPO } from './api'
import { MAX_EVENTOS_POR_LOTE } from './nube'
import { ADMIN, AHORA, contar, crearMundo, lote, type Mundo, SEMILLA } from './pruebas/mundo'
import type { Sql } from './sql'

// Los bordes de la API HTTP: cuerpos malformados, tipos inesperados, métodos y rutas que no son,
// tamaños, errores internos que no deben mostrar nada, y las cabeceras de toda respuesta.

let m: Mundo
let credencial: string
let restauranteId: string
let hubId: string
beforeAll(async () => {
  m = await crearMundo()
  const h = await m.nuevoHub()
  credencial = h.credencial
  restauranteId = h.restauranteId
  hubId = h.hub.id
})
afterEach(() => {
  vi.restoreAllMocks()
})

interface Ruta {
  nombre: string
  metodo: string
  ruta: string
  token: () => string | undefined
  /** Un cuerpo válido: sirve de base para cambiarle un campo. */
  valido?: () => Record<string, unknown>
}

const RUTAS_CON_CUERPO: Ruta[] = [
  {
    nombre: 'crear restaurante',
    metodo: 'POST',
    ruta: '/v1/admin/restaurantes',
    token: () => ADMIN,
    valido: () => ({ id: nuevoId(), nombre: 'R' }),
  },
  {
    nombre: 'crear código',
    metodo: 'POST',
    ruta: '/v1/admin/codigos',
    token: () => ADMIN,
    valido: () => ({ restaurante_id: restauranteId }),
  },
  {
    nombre: 'revocar hub',
    metodo: 'POST',
    ruta: '/v1/admin/hubs/revocar',
    token: () => ADMIN,
    valido: () => ({ hub_id: nuevoId() }),
  },
  {
    nombre: 'registrar hub',
    metodo: 'POST',
    ruta: '/v1/hubs/registro',
    token: () => undefined,
    valido: () => ({
      codigo: 'ABCD-EFGH-JKMN',
      hub_id: nuevoId(),
      sede_id: nuevoId(),
      nombre: 'Caja',
      instancia: 'i',
    }),
  },
  {
    nombre: 'subir eventos',
    metodo: 'POST',
    ruta: '/v1/eventos',
    token: () => credencial,
    valido: () => ({ eventos: lote(1, 1) }),
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
    it(`${r.nombre}: responde 400 y nunca 500 ante cuerpos que no sirven`, async () => {
      for (const c of cuerpos) {
        const res = await m.pedir(r.metodo, r.ruta, c, r.token())
        expect(res.status, JSON.stringify(c)).toBe(400)
        expect(await res.json()).toMatchObject({ error: 'datos_invalidos' })
      }
    })

  for (const r of RUTAS_CON_CUERPO)
    it(`${r.nombre}: sin cuerpo (sin body ni content-type) es 400`, async () => {
      const res = await m.pedir(r.metodo, r.ruta, undefined, r.token())
      expect(res.status).toBe(400)
    })

  it('el tipo de contenido no importa: un JSON válido como text/plain se entiende igual', async () => {
    const res = await atender(
      new Request('https://nube.faro.test/v1/eventos', {
        method: 'POST',
        headers: { authorization: `Bearer ${credencial}`, 'content-type': 'text/plain' },
        body: JSON.stringify({ eventos: lote(900, 1) }),
      }),
      { sql: m.sql },
    )
    expect(res.status).toBe(200)
  })

  it('un cuerpo que no es UTF-8 válido no rompe: es 400', async () => {
    const res = await atender(
      new Request('https://nube.faro.test/v1/eventos', {
        method: 'POST',
        headers: { authorization: `Bearer ${credencial}` },
        body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
      }),
      { sql: m.sql },
    )
    expect(res.status).toBe(400)
  })

  it('propiedad: cualquier JSON arbitrario en cualquier ruta con cuerpo da 400, nunca 500', async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.constantFrom(...RUTAS_CON_CUERPO), async (valor, r) => {
        const res = await m.pedir(r.metodo, r.ruta, JSON.stringify(valor), r.token())
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
        async (texto, r) => {
          const res = await m.pedir(r.metodo, r.ruta, texto === '' ? ' ' : texto, r.token())
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
    it(`${r.nombre}: cada campo con un valor de otro tipo o fuera de rango es 400`, async () => {
      const base = r.valido?.() ?? {}
      for (const campo of Object.keys(base))
        for (const malo of valoresMalos) {
          // Una lista con cualquier cosa dentro es un lote válido (cada elemento se juzga solo).
          if (campo === 'eventos' && Array.isArray(malo) && malo.length > 0) continue
          const res = await m.pedir(r.metodo, r.ruta, { ...base, [campo]: malo }, r.token())
          expect(res.status, `${campo}=${JSON.stringify(malo)}`.slice(0, 80)).toBe(400)
        }
    })

    it(`${r.nombre}: un campo de más es 400 (los cuerpos son estrictos)`, async () => {
      const res = await m.pedir(r.metodo, r.ruta, { ...(r.valido?.() ?? {}), de_mas: 1 }, r.token())
      expect(res.status).toBe(400)
    })

    it(`${r.nombre}: faltando cada campo es 400`, async () => {
      const base = r.valido?.() ?? {}
      for (const campo of Object.keys(base)) {
        const { [campo]: _quitado, ...resto } = base
        expect((await m.pedir(r.metodo, r.ruta, resto, r.token())).status, campo).toBe(400)
      }
    })
  }

  it('el nombre del restaurante se recorta y no puede quedar vacío ni pasar de 120 caracteres', async () => {
    const pedir = (nombre: string) =>
      m.pedir('POST', '/v1/admin/restaurantes', { id: nuevoId(), nombre }, ADMIN)
    expect((await pedir('   ')).status).toBe(400)
    expect((await pedir('x'.repeat(121))).status).toBe(400)
    expect((await pedir('x'.repeat(120))).status).toBe(201)
  })

  it('el lote: eventos que no es lista, o lista de más de 500, o vacía', async () => {
    for (const eventos of ['x', null, {}, 1, true, []])
      expect((await m.pedir('POST', '/v1/eventos', { eventos }, credencial)).status).toBe(400)
    const justo = Array.from({ length: MAX_EVENTOS_POR_LOTE }, () => 1)
    const r = await m.pedir('POST', '/v1/eventos', { eventos: justo }, credencial)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { resultados: unknown[] }).resultados).toHaveLength(
      MAX_EVENTOS_POR_LOTE,
    )
    expect(
      (await m.pedir('POST', '/v1/eventos', { eventos: [...justo, 1] }, credencial)).status,
    ).toBe(400)
  })

  it('un lote con elementos que no son eventos responde 200 con todos inválidos', async () => {
    const r = await m.pedir('POST', '/v1/eventos', { eventos: [1, 'x', null, [], {}] }, credencial)
    expect(r.status).toBe(200)
    const cuerpo = (await r.json()) as { resultados: { estado: string }[] }
    expect(cuerpo.resultados.map((x) => x.estado)).toEqual(Array(5).fill('invalido'))
  })
})

describe('tamaño del cuerpo', () => {
  const envoltura = (relleno: string) => `{"eventos":["${relleno}"]}`
  const bytes = (t: string) => new TextEncoder().encode(t).length

  it('un content-length falso muy grande se rechaza con 413 sin leer el cuerpo', async () => {
    for (const largo of [String(MAX_BYTES_CUERPO + 1), '999999999999', '1e9']) {
      const res = await atender(
        new Request('https://nube.faro.test/v1/eventos', {
          method: 'POST',
          headers: { authorization: `Bearer ${credencial}`, 'content-length': largo },
          body: JSON.stringify({ eventos: lote(1, 1) }),
        }),
        { sql: m.sql },
      )
      expect([200, 413], largo).toContain(res.status)
      if (largo !== '1e9') expect(res.status, largo).toBe(413)
    }
  })

  it('un content-length falso muy chico no deja pasar un cuerpo que de verdad es grande', async () => {
    const res = await atender(
      new Request('https://nube.faro.test/v1/eventos', {
        method: 'POST',
        headers: { authorization: `Bearer ${credencial}`, 'content-length': '10' },
        body: envoltura('x'.repeat(MAX_BYTES_CUERPO)),
      }),
      { sql: m.sql },
    )
    expect(res.status).toBe(413)
  })

  it('un content-length ilegible o negativo no rompe nada', async () => {
    for (const largo of ['abc', '-5', '', ' ']) {
      const res = await atender(
        new Request('https://nube.faro.test/v1/eventos', {
          method: 'POST',
          headers: { authorization: `Bearer ${credencial}`, 'content-length': largo },
          body: JSON.stringify({ eventos: lote(950, 1) }),
        }),
        { sql: m.sql },
      )
      expect(res.status, JSON.stringify(largo)).toBeLessThan(500)
    }
  })

  it('el límite es exacto: MAX_BYTES_CUERPO pasa, un byte más es 413', async () => {
    const vacio = bytes(envoltura(''))
    const justo = envoltura('x'.repeat(MAX_BYTES_CUERPO - vacio))
    expect(bytes(justo)).toBe(MAX_BYTES_CUERPO)
    expect((await m.pedir('POST', '/v1/eventos', justo, credencial)).status).toBe(200)
    const demas = envoltura('x'.repeat(MAX_BYTES_CUERPO - vacio + 1))
    const r = await m.pedir('POST', '/v1/eventos', demas, credencial)
    expect(r.status).toBe(413)
    expect(await r.json()).toMatchObject({ error: 'lote_grande' })
  })

  it('el límite se mide en bytes: caracteres de varios bytes se pasan antes', async () => {
    const texto = envoltura('ñ'.repeat(MAX_BYTES_CUERPO / 2))
    expect(texto.length).toBeLessThan(MAX_BYTES_CUERPO)
    expect((await m.pedir('POST', '/v1/eventos', texto, credencial)).status).toBe(413)
  })

  it('sin content-length (flujo), deja de leer al pasarse del límite', async () => {
    const trozo = new Uint8Array(1024 * 1024).fill(0x20)
    let leidos = 0
    const flujo = new ReadableStream<Uint8Array>({
      pull(control) {
        leidos++
        if (leidos > 40) control.close()
        else control.enqueue(trozo)
      },
    })
    const res = await atender(
      new Request('https://nube.faro.test/v1/eventos', {
        method: 'POST',
        headers: { authorization: `Bearer ${credencial}` },
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
      new Request('https://nube.faro.test/v1/eventos', {
        method: 'POST',
        headers: { authorization: 'Bearer inventada' },
        body: flujo,
        duplex: 'half',
      } as RequestInit),
      { sql: m.sql },
    )
    expect(res.status).toBe(401)
    const admin = await m.pedir('POST', '/v1/admin/restaurantes', 'x'.repeat(MAX_BYTES_CUERPO + 5))
    expect(admin.status).toBe(401)
  })

  it('en las rutas de administración y de registro también hay 413', async () => {
    const grande = `{"a":"${'x'.repeat(MAX_BYTES_CUERPO)}"}`
    expect((await m.pedir('POST', '/v1/admin/restaurantes', grande, ADMIN)).status).toBe(413)
    expect((await m.pedir('POST', '/v1/admin/codigos', grande, ADMIN)).status).toBe(413)
    expect((await m.pedir('POST', '/v1/admin/hubs/revocar', grande, ADMIN)).status).toBe(413)
    expect((await m.pedir('POST', '/v1/hubs/registro', grande)).status).toBe(413)
  })
})

describe('método y ruta', () => {
  const equivocados: [string, string][] = [
    ['GET', '/v1/eventos'],
    ['PUT', '/v1/eventos'],
    ['PATCH', '/v1/eventos'],
    ['DELETE', '/v1/eventos'],
    ['POST', '/v1/eventos/ultima'],
    ['DELETE', '/v1/eventos/ultima'],
    ['GET', '/v1/hubs/registro'],
    ['PUT', '/v1/hubs/registro'],
    ['GET', '/v1/admin/restaurantes'],
    ['DELETE', '/v1/admin/restaurantes'],
    ['GET', '/v1/admin/codigos'],
    ['PUT', '/v1/admin/hubs/revocar'],
    ['DELETE', '/v1/admin/hubs/revocar'],
    ['POST', '/v1/salud'],
    ['DELETE', '/v1/salud'],
  ]
  it.each(equivocados)('%s %s no hace nada (404 o 405) ni cambia datos', async (metodo, ruta) => {
    const cuerpo = metodo === 'GET' ? undefined : { eventos: lote(700, 3), hub_id: hubId }
    const antes = [
      await contar(m.db, 'evento'),
      await contar(m.db, 'hub'),
      await contar(m.db, 'restaurante'),
      await contar(m.db, 'codigo_registro'),
    ]
    for (const token of [credencial, ADMIN, undefined]) {
      const r = await m.pedir(metodo, ruta, cuerpo, token)
      expect([401, 404, 405], `${metodo} ${ruta}`).toContain(r.status)
    }
    expect([
      await contar(m.db, 'evento'),
      await contar(m.db, 'hub'),
      await contar(m.db, 'restaurante'),
      await contar(m.db, 'codigo_registro'),
    ]).toEqual(antes)
  })

  const inexistentes = [
    '/',
    '/v1',
    '/v1/',
    '/v2/salud',
    '/V1/salud',
    '/v1/salud/',
    '//v1/salud',
    '/v1/eventos/',
    '/v1/eventos/ultima/',
    '/v1/eventos/ultima/x',
    '/v1/eventos/otra',
    '/v1/%65ventos',
    '/v1/eventos/%2e%2e/salud',
    '/v1/hubs',
    '/v1/hubs/registro/',
    '/v1/admin',
    '/v1/administrador',
    '/v1/nada',
    '/favicon.ico',
    '/.env',
    '/v1/admin/../salud',
  ]
  it.each(inexistentes)(
    '%s no existe: 404 (o 401 si es la zona de administración)',
    async (ruta) => {
      for (const metodo of ['GET', 'POST']) {
        const r = await m.pedir(metodo, ruta, metodo === 'POST' ? {} : undefined, credencial)
        // Las rutas que normaliza la URL a una real (por ejemplo /v1/admin/../salud) pueden dar 200.
        expect([200, 400, 401, 404], `${metodo} ${ruta}`).toContain(r.status)
        if (r.status === 404) expect(await r.json()).toMatchObject({ error: 'no_existe' })
      }
    },
  )

  it('la zona de administración no revela qué rutas existen: sin token todo es 401', async () => {
    for (const ruta of ['/v1/admin/', '/v1/admin/nada', '/v1/admin/restaurantes', '/v1/admin/x/y'])
      expect((await m.pedir('POST', ruta, {})).status, ruta).toBe(401)
    expect((await m.pedir('POST', '/v1/admin/nada', {}, ADMIN)).status).toBe(404)
  })

  it('la cadena de consulta no cambia la ruta, y la salud no pide nada', async () => {
    expect((await m.pedir('GET', '/v1/salud?x=1&y=2')).status).toBe(200)
    expect(
      (await m.pedir('GET', '/v1/eventos/ultima?hub=otro', undefined, credencial)).status,
    ).toBe(200)
    expect(await (await m.pedir('GET', '/v1/salud')).json()).toEqual({ ok: true })
  })

  it('el resultado de ultima trae solo la secuencia del hub que pregunta', async () => {
    const r = await m.pedir('GET', '/v1/eventos/ultima', undefined, credencial)
    expect(Object.keys((await r.json()) as object)).toEqual(['ultima_secuencia'])
  })
})

describe('un error interno nunca devuelve detalles', () => {
  const SECRETO =
    'password=hunter2 INSERT INTO hub VALUES (secreto-12345) en /srv/faro/src/nube.ts:99'

  function sqlQueLanza(quePasa: () => unknown, soloTransacciones = false): Sql {
    const lanzar = async (): Promise<never> => {
      throw quePasa()
    }
    return {
      query: soloTransacciones ? m.sql.query.bind(m.sql) : lanzar,
      ejecutar: lanzar,
      transaccion: lanzar,
    }
  }

  const errores: [string, () => unknown][] = [
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
    ['un objeto cualquiera', () => ({ secreto: SECRETO })],
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
      new Request(`https://nube.faro.test${ruta}`, {
        method: metodo,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      }),
      { sql, tokenAdmin: ADMIN, reloj: () => AHORA },
    )
  }

  const rutasHttp = (): [string, string, string, unknown, string | undefined][] => [
    ['crear restaurante', 'POST', '/v1/admin/restaurantes', { id: nuevoId(), nombre: 'R' }, ADMIN],
    ['crear código', 'POST', '/v1/admin/codigos', { restaurante_id: nuevoId() }, ADMIN],
    ['revocar', 'POST', '/v1/admin/hubs/revocar', { hub_id: nuevoId() }, ADMIN],
    [
      'registrar',
      'POST',
      '/v1/hubs/registro',
      {
        codigo: 'ABCD-EFGH-JKMN',
        hub_id: nuevoId(),
        sede_id: nuevoId(),
        nombre: 'C',
        instancia: 'i',
      },
      undefined,
    ],
    ['subir eventos', 'POST', '/v1/eventos', { eventos: lote(1, 1) }, credencial],
    ['ultima secuencia', 'GET', '/v1/eventos/ultima', undefined, credencial],
  ]

  for (const [nombreError, hacer] of errores)
    it(`${nombreError}: 500 genérico, sin SQL, rutas, claves ni pila`, async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      for (const [nombre, metodo, ruta, cuerpo, token] of rutasHttp()) {
        // Las rutas de hub llegan a su consulta de autenticación con el mismo error.
        const r = await pedirCon(sqlQueLanza(hacer), metodo, ruta, cuerpo, token)
        const texto = await r.text()
        expect(r.status, nombre).toBe(500)
        expect(r.headers.get('content-type'), nombre).toContain('application/json')
        expect(JSON.parse(texto), nombre).toEqual({
          error: 'error_interno',
          mensaje: expect.any(String),
        })
        for (const prohibido of [
          'hunter2',
          'INSERT',
          'secreto',
          '/srv/',
          'stack',
          'password',
          'detail',
          'at ',
        ])
          expect(texto, `${nombre}: ${prohibido}`).not.toContain(prohibido)
      }
      expect(log).toHaveBeenCalled()
    })

  it('el registro del error no vuelca el objeto completo (consulta, parámetros, pila)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const raro = Object.assign(new Error('falló'), {
      code: '22P02',
      query: 'SELECT secreto',
      parameters: ['clave-super-secreta'],
    })
    await pedirCon(
      sqlQueLanza(() => raro),
      'POST',
      '/v1/admin/restaurantes',
      { id: nuevoId(), nombre: 'R' },
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
      ejecutar: m.sql.ejecutar.bind(m.sql),
      transaccion: async () => {
        throw new Error(SECRETO)
      },
    }
    const antes = await contar(m.db, 'evento')
    const r = await pedirCon(sql, 'POST', '/v1/eventos', { eventos: lote(800, 3) }, credencial)
    expect(r.status).toBe(500)
    expect(await r.text()).not.toContain('hunter2')
    expect(await contar(m.db, 'evento')).toBe(antes)
  })

  it('un choque de clave única al registrar (dos registros a la vez) se contesta 409, no 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sql: Sql = {
      query: m.sql.query.bind(m.sql),
      ejecutar: m.sql.ejecutar.bind(m.sql),
      transaccion: async () => {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "hub_pkey"'),
          {
            code: '23505',
          },
        )
      },
    }
    const r = await pedirCon(sql, 'POST', '/v1/hubs/registro', {
      codigo: 'ABCD-EFGH-JKMN',
      hub_id: nuevoId(),
      sede_id: nuevoId(),
      nombre: 'C',
      instancia: 'i',
    })
    expect(r.status).toBe(409)
  })

  it('un error real de Postgres (no simulado) tampoco filtra detalles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await m.pedir(
      'POST',
      '/v1/eventos',
      { eventos: [{ ...lote(1, 1)[0], recibido_en: '0000-01-01T00:00:00Z' }] },
      credencial,
    )
    const texto = await r.text()
    for (const prohibido of ['date/time', 'out of range', 'jsonb_to_recordset', 'INSERT'])
      expect(texto).not.toContain(prohibido)
  })

  it('la salud no toca la base: responde aunque la base esté caída', async () => {
    const r = await pedirCon(
      sqlQueLanza(() => new Error('caída')),
      'GET',
      '/v1/salud',
      undefined,
    )
    expect(r.status).toBe(200)
  })

  it('rutas que no existen o sin credencial no usan la base más de lo necesario', async () => {
    const r = await pedirCon(
      sqlQueLanza(() => new Error('caída')),
      'GET',
      '/v1/nada',
      undefined,
    )
    // Sin credencial no hay consulta: 404 limpio aunque la base esté caída.
    expect(r.status).toBe(404)
  })
})

describe('forma de toda respuesta', () => {
  it('es JSON con cache-control: no-store en cada código de estado', async () => {
    const restaurante = nuevoId()
    const matriz: [string, () => Promise<Response>][] = [
      ['200 salud', () => m.pedir('GET', '/v1/salud')],
      [
        '201 restaurante',
        () => m.pedir('POST', '/v1/admin/restaurantes', { id: restaurante, nombre: 'R' }, ADMIN),
      ],
      [
        '200 restaurante repetido',
        () => m.pedir('POST', '/v1/admin/restaurantes', { id: restaurante, nombre: 'R' }, ADMIN),
      ],
      [
        '201 código',
        () => m.pedir('POST', '/v1/admin/codigos', { restaurante_id: restaurante }, ADMIN),
      ],
      [
        '404 código',
        () => m.pedir('POST', '/v1/admin/codigos', { restaurante_id: nuevoId() }, ADMIN),
      ],
      [
        '404 revocar',
        () => m.pedir('POST', '/v1/admin/hubs/revocar', { hub_id: nuevoId() }, ADMIN),
      ],
      ['400', () => m.pedir('POST', '/v1/eventos', '{', credencial)],
      ['401', () => m.pedir('POST', '/v1/eventos', {}, 'inventada')],
      ['401 admin', () => m.pedir('POST', '/v1/admin/restaurantes', {})],
      [
        '403 registro',
        () =>
          m.pedir('POST', '/v1/hubs/registro', {
            codigo: 'NADA',
            hub_id: nuevoId(),
            sede_id: nuevoId(),
            nombre: 'C',
            instancia: 'i',
          }),
      ],
      ['404 ruta', () => m.pedir('GET', '/v1/nada')],
      [
        '413',
        () =>
          m.pedir(
            'POST',
            '/v1/eventos',
            `{"eventos":["${'x'.repeat(MAX_BYTES_CUERPO)}"]}`,
            credencial,
          ),
      ],
      ['200 eventos', () => m.pedir('POST', '/v1/eventos', { eventos: lote(1, 1) }, credencial)],
      ['200 ultima', () => m.pedir('GET', '/v1/eventos/ultima', undefined, credencial)],
    ]
    for (const [nombre, pedir] of matriz) {
      const r = await pedir()
      expect(r.headers.get('content-type'), nombre).toMatch(/^application\/json/)
      expect(r.headers.get('cache-control'), nombre).toBe('no-store')
      await expect(r.json(), nombre).resolves.toBeTypeOf('object')
    }
  })

  it('el 409 de registro y el 204 de revocar también llevan cache-control: no-store', async () => {
    const h = await m.nuevoHub()
    const codigo = await m.nube.crearCodigo(h.restauranteId)
    if (!codigo) throw new Error('sin código')
    const duplicado = await m.pedir('POST', '/v1/hubs/registro', {
      codigo: codigo.codigo,
      hub_id: h.hub.id,
      sede_id: nuevoId(),
      nombre: 'C',
      instancia: 'i',
    })
    expect(duplicado.status).toBe(409)
    expect(duplicado.headers.get('cache-control')).toBe('no-store')
    const revocado = await m.pedir('POST', '/v1/admin/hubs/revocar', { hub_id: h.hub.id }, ADMIN)
    expect(revocado.status).toBe(204)
    expect(await revocado.text()).toBe('')
    expect(revocado.headers.get('cache-control')).toBe('no-store')
  })

  it('los errores traen solo error y mensaje, en español, y no repiten lo que mandó el cliente', async () => {
    const dato = 'dato-que-mando-el-cliente-98765'
    for (const r of [
      await m.pedir('POST', '/v1/admin/restaurantes', { id: dato, nombre: dato }, ADMIN),
      await m.pedir('POST', '/v1/eventos', { eventos: [{ id: dato }], extra: dato }, credencial),
      await m.pedir('POST', '/v1/eventos', {}, dato),
      await m.pedir('POST', '/v1/hubs/registro', { codigo: dato, hub_id: dato }),
    ]) {
      const texto = await r.text()
      expect(texto).not.toContain(dato)
      const cuerpo = JSON.parse(texto) as Record<string, unknown>
      if (r.status >= 400) expect(Object.keys(cuerpo).sort()).toEqual(['error', 'mensaje'])
    }
  })
})
