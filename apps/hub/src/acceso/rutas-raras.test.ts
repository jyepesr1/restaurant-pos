import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { crearServidor } from '../servidor'
import { montarAcceso } from './montaje'

// La API de acceso con cuerpos que ningún cliente honesto mandaría: el hub responde un 4xx
// claro, no registra ni devuelve lo recibido, y sigue en pie para el siguiente cliente.

function montarApi() {
  const m = montarAcceso()
  const app = crearServidor({ access: m.access })
  const send = (
    url: string,
    options: {
      payload?: string | object
      token?: string
      type?: string
      metodo?: 'POST' | 'GET' | 'PUT'
    } = {},
  ) =>
    app.inject({
      method: options.metodo ?? 'POST',
      url,
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
      headers: {
        ...(options.type ? { 'content-type': options.type } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    })
  /** Lo mismo con el JSON ya escrito a mano (para cuerpos que JSON.stringify no produciría). */
  const raw = (url: string, cuerpo: string, token?: string) =>
    send(url, { payload: cuerpo, type: 'application/json', token })
  return { ...m, app, send, raw }
}

/** Un celular de mesero como en el restaurante: entra con su PIN y el hub lo registra (ADR-013). */
async function conDispositivo() {
  const api = montarApi()
  const s = await api.send('/api/sign-in', { payload: { pin: api.people.waiter.pin } })
  const r = s.json() as { device: { token: string }; session_id: string; secret: string }
  return { ...api, token: r.device.token, session: { session_id: r.session_id, secret: r.secret } }
}

const RUTAS_CON_TOKEN = ['/api/sessions', '/api/sessions/close', '/api/authorizations'] as const
const RUTAS_SIN_TOKEN = ['/api/pairings', '/api/pair'] as const

async function sigueVivo(api: { send: ReturnType<typeof montarApi>['send'] }) {
  const r = await api.send('/api/health', { metodo: 'GET' })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toMatchObject({ status: 'ok' })
}

describe('API de acceso con cuerpos raros', () => {
  it('campos de más, de menos o de otro tipo: 400 con el mismo cuerpo de error, sin eco de lo enviado', async () => {
    const api = await conDispositivo()
    const secret = 'SECRETO-QUE-NO-DEBE-VOLVER'
    const badOnes: [string, unknown][] = [
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
    for (const [url, cuerpo] of badOnes) {
      const r = await api.send(url, { payload: cuerpo as object, token: api.token })
      expect(r.statusCode, `${url} ${JSON.stringify(cuerpo)}`).toBe(400)
      expect(r.json()).toEqual({
        error: 'invalid_data',
        message: 'Datos con formato inesperado',
      })
      expect(r.body).not.toContain(secret)
    }
    await sigueVivo(api)
  })

  it('cuerpos que no son un objeto JSON: null, número, texto, lista, vacío', async () => {
    const api = await conDispositivo()
    for (const cuerpo of ['null', '123', '"texto"', '[]', '[{"pin":"1234"}]', 'true']) {
      for (const url of [...RUTAS_CON_TOKEN, ...RUTAS_SIN_TOKEN]) {
        const r = await api.raw(url, cuerpo, api.token)
        expect(r.statusCode, `${url} ${cuerpo}`).toBe(400)
      }
    }
    for (const url of [...RUTAS_CON_TOKEN, ...RUTAS_SIN_TOKEN]) {
      const sinCuerpo = await api.send(url, { token: api.token })
      expect(sinCuerpo.statusCode, url).toBe(400)
    }
    await sigueVivo(api)
  })

  it('JSON mal formado o con otro Content-Type: 4xx, nunca 5xx', async () => {
    const api = await conDispositivo()
    const rotos = [
      '{',
      '{"pin":',
      '{"pin":"1234"',
      "{'pin':'1234'}",
      '\u0000',
      '{"pin":"1234"}}',
      '',
    ]
    for (const cuerpo of rotos) {
      const r = await api.raw('/api/sessions', cuerpo, api.token)
      expect(r.statusCode, JSON.stringify(cuerpo)).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, JSON.stringify(cuerpo)).toBeLessThan(500)
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
    await sigueVivo(api)
  })

  it('cuerpos enormes se cortan con 413 sin leerlos enteros, y el hub sigue sirviendo', async () => {
    const api = await conDispositivo()
    const enorme = JSON.stringify({ pin: '1234', padding: 'x'.repeat(5 * 1024 * 1024) })
    for (const url of [...RUTAS_CON_TOKEN, ...RUTAS_SIN_TOKEN]) {
      const r = await api.raw(url, enorme, api.token)
      expect(r.statusCode, url).toBe(413)
    }
    // Y uno dentro del límite de Fastify pero con un campo gigante: lo para el esquema.
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
    await sigueVivo(api)
    // Y un cliente normal entra sin problema justo después.
    const fine = await api.send('/api/sessions', {
      payload: { pin: api.people.waiter.pin },
      token: api.token,
    })
    expect(fine.statusCode).toBe(201)
  })

  it('JSON profundamente anidado o con claves peligrosas no tumba nada ni contamina objetos', async () => {
    const api = await conDispositivo()
    const profundo = `${'['.repeat(50_000)}${']'.repeat(50_000)}`
    const nested = await api.raw('/api/sessions', profundo, api.token)
    expect(nested.statusCode).toBeGreaterThanOrEqual(400)
    expect(nested.statusCode).toBeLessThan(500)

    for (const cuerpo of [
      '{"__proto__":{"admin":true},"pin":"1234"}',
      '{"constructor":{"prototype":{"x":1}},"pin":"1234"}',
      '{"pin":"1234","__proto__":null}',
    ]) {
      const r = await api.raw('/api/sessions', cuerpo, api.token)
      expect(r.statusCode, cuerpo).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, cuerpo).toBeLessThan(500)
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    await sigueVivo(api)
  })

  it('texto con Unicode, ceros, SQL y etiquetas se guarda como dato y no como instrucción', async () => {
    const api = await conDispositivo()
    const raros = [
      "Caja'); DROP TABLE dispositivo;--",
      '<script>alert(1)</script>',
      'Cocina 🍕 ñandú',
      'a\u0000b',
      '‮oculto',
      '  espacios  ',
    ]
    // Solo una pantalla de cocina se empareja, desde un equipo ya registrado (ADR-013).
    const token = api.token
    for (const name of raros) {
      const c = await api.send('/api/pairings', {
        payload: { pin: api.people.admin.pin, name, type: 'kds' },
        token,
      })
      expect(c.statusCode, name).toBe(201)
      const e = await api.send('/api/pair', { payload: { code: c.json().code } })
      expect(e.statusCode, name).toBe(201)
      expect(e.json().name).toBe(name.trim())
    }
    // Más el celular del montaje.
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)).toBe(
      raros.length + 1,
    )
    // Solo-espacios y nombres de más de 60 caracteres no pasan la regla del servicio.
    for (const name of ['   ', 'x'.repeat(61)]) {
      const r = await api.send('/api/pairings', {
        payload: { pin: api.people.admin.pin, name, type: 'kds' },
        token,
      })
      expect(r.statusCode, name).toBe(400)
      expect(r.json().error).toBe('invalid_data')
    }
    await sigueVivo(api)
  })

  it('tipo de equipo inventado, con nombres de propiedades de Object o que no es de cocina: 400', async () => {
    const api = await conDispositivo()
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

  it('el token de autorización mal formado: 401, nunca 500', async () => {
    const api = montarApi()
    const cabeceras = [
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
    for (const authorization of cabeceras) {
      const r = await api.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { pin: '1234' },
        headers: { authorization: authorization },
      })
      expect(r.statusCode, authorization.slice(0, 30)).toBe(401)
    }
    await sigueVivo(api)
  })

  it('un token válido no sirve en la ruta de otra cosa, y las rutas de acceso solo aceptan POST', async () => {
    const api = await conDispositivo()
    for (const url of [...RUTAS_CON_TOKEN, ...RUTAS_SIN_TOKEN]) {
      for (const metodo of ['GET', 'PUT'] as const) {
        const r = await api.send(url, { metodo, token: api.token })
        expect(r.statusCode, `${metodo} ${url}`).toBe(404)
      }
    }
  })

  it('ids de equipo raros en la ruta de revocar: 4xx y el equipo real queda intacto', async () => {
    const api = await conDispositivo()
    // La caja entra con la contraseña del administrador y el hub la registra.
    const admin = (
      await api.send('/api/sign-in', {
        payload: { user: api.people.admin.user, password: api.people.admin.password },
      })
    ).json()
    const token = admin.device.token as string
    const cuerpo = { session_id: admin.session_id, secret: admin.secret }

    for (const id of [
      'x',
      '%00',
      '%27%20OR%201%3D1',
      'a'.repeat(5000),
      '..%2f..%2fetc',
      newId(),
      '%E0%A4%A',
    ]) {
      const r = await api.send(`/api/devices/${id}/revoke`, { payload: cuerpo, token })
      expect(r.statusCode, id.slice(0, 20)).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, id.slice(0, 20)).toBeLessThan(500)
    }
    expect(
      api.db.prepare('SELECT count(*) AS n FROM devices WHERE revoked_at IS NOT NULL').get()?.n,
    ).toBe(0)
    // Sin cuerpo tampoco se revoca nada.
    const deviceId = (
      api.db.prepare("SELECT id FROM devices WHERE name = 'Equipo de Ana'").get() as {
        id: string
      }
    ).id
    const sinCuerpo = await api.send(`/api/devices/${deviceId}/revoke`, { token })
    expect(sinCuerpo.statusCode).toBe(400)
  })

  it('la sesión de un mesero no puede retirar equipos, ni con su propio token', async () => {
    const api = await conDispositivo()
    const other = await api.send('/api/sign-in', {
      payload: { pin: api.people.waiter2.pin },
    })
    const objetivo = other.json().device.device_id as string
    const r = await api.send(`/api/devices/${objetivo}/revoke`, {
      payload: { session_id: api.session.session_id, secret: api.session.secret },
      token: api.token,
    })

    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ error: 'no_permission' })
    expect(api.revocados).toEqual([])
  })

  it('las respuestas de error no revelan el PIN, el token ni el secreto de sesión', async () => {
    const api = await conDispositivo()
    const respuestas = [
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
    for (const r of respuestas) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400)
      for (const secret of [api.token, api.session.secret, '0001', '0002', 'yyyy'])
        expect(r.body).not.toContain(secret)
    }
  })

  it('un aluvión de peticiones malas seguidas no deja al hub sin responder a las buenas', async () => {
    const api = await conDispositivo()
    const malas = []
    for (let i = 0; i < 200; i++)
      malas.push(api.raw(i % 2 ? '/api/sessions' : '/api/pair', i % 3 ? '{' : '[]', api.token))
    const respuestas = await Promise.all(malas)

    expect(respuestas.every((r) => r.statusCode >= 400 && r.statusCode < 500)).toBe(true)
    const fine = await api.send('/api/sessions', {
      payload: { pin: api.people.waiter.pin },
      token: api.token,
    })
    expect(fine.statusCode).toBe(201)
  })

  it('pedir un emparejamiento sin token o con un token falso: 401 sin gastar intentos', async () => {
    const api = await conDispositivo()
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
    // Quien sí tiene un equipo, con el PIN bueno, no esperó por nada de eso.
    const fine = await api.send('/api/pairings', {
      payload: { pin: api.people.admin.pin, name: 'Cocina', type: 'kds' },
      token: api.token,
    })
    expect(fine.statusCode).toBe(201)
  })

  it('la huella de la autorización: solo 64 caracteres hexadecimales', async () => {
    const api = await conDispositivo()
    const cuerpo = (fingerprint: unknown) => ({
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
        payload: cuerpo(fingerprint) as object,
        token: api.token,
      })
      expect(r.statusCode, String(fingerprint)).toBe(400)
    }
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM authorizations').get()?.n)).toBe(0)
    const fine = await api.send('/api/authorizations', {
      payload: cuerpo('a'.repeat(64)) as object,
      token: api.token,
    })
    expect(fine.statusCode).toBe(201)
  })
})
