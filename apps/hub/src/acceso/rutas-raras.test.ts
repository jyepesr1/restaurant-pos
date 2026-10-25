import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { crearServidor } from '../servidor'
import { montarAcceso } from './montaje'

// La API de acceso con cuerpos que ningún cliente honesto mandaría: el hub responde un 4xx
// claro, no registra ni devuelve lo recibido, y sigue en pie para el siguiente cliente.

function montarApi() {
  const m = montarAcceso()
  const app = crearServidor({ acceso: m.acceso })
  const enviar = (
    url: string,
    opciones: {
      payload?: string | object
      token?: string
      tipo?: string
      metodo?: 'POST' | 'GET' | 'PUT'
    } = {},
  ) =>
    app.inject({
      method: opciones.metodo ?? 'POST',
      url,
      ...(opciones.payload === undefined ? {} : { payload: opciones.payload as object }),
      headers: {
        ...(opciones.tipo ? { 'content-type': opciones.tipo } : {}),
        ...(opciones.token ? { authorization: `Bearer ${opciones.token}` } : {}),
      },
    })
  /** Lo mismo con el JSON ya escrito a mano (para cuerpos que JSON.stringify no produciría). */
  const crudo = (url: string, cuerpo: string, token?: string) =>
    enviar(url, { payload: cuerpo, tipo: 'application/json', token })
  return { ...m, app, enviar, crudo }
}

/** Un celular de mesero como en el restaurante: entra con su PIN y el hub lo registra (ADR-013). */
async function conDispositivo() {
  const api = montarApi()
  const s = await api.enviar('/api/entrar', { payload: { pin: api.personas.mesero.pin } })
  const r = s.json() as { equipo: { token: string }; sesion_id: string; secreto: string }
  return { ...api, token: r.equipo.token, sesion: { sesion_id: r.sesion_id, secreto: r.secreto } }
}

const RUTAS_CON_TOKEN = ['/api/sesiones', '/api/sesiones/cerrar', '/api/autorizaciones'] as const
const RUTAS_SIN_TOKEN = ['/api/emparejamientos', '/api/emparejar'] as const

async function sigueVivo(api: { enviar: ReturnType<typeof montarApi>['enviar'] }) {
  const r = await api.enviar('/api/salud', { metodo: 'GET' })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toMatchObject({ estado: 'ok' })
}

describe('API de acceso con cuerpos raros', () => {
  it('campos de más, de menos o de otro tipo: 400 con el mismo cuerpo de error, sin eco de lo enviado', async () => {
    const api = await conDispositivo()
    const secreto = 'SECRETO-QUE-NO-DEBE-VOLVER'
    const malos: [string, unknown][] = [
      ['/api/emparejamientos', { pin: '1234', nombre: 'X', tipo: 'caja', extra: secreto }],
      ['/api/emparejamientos', { pin: 1234, nombre: 'X', tipo: 'caja' }],
      ['/api/emparejamientos', { pin: '1234', nombre: ['X'], tipo: 'caja' }],
      ['/api/emparejamientos', { pin: '1234', nombre: 'X' }],
      ['/api/emparejamientos', { pin: null, nombre: null, tipo: null }],
      ['/api/emparejar', { codigo: 1 }],
      ['/api/emparejar', { codigo: { $ne: '' } }],
      ['/api/emparejar', { codigo: 'ABCDEFGH', extra: secreto }],
      ['/api/emparejar', {}],
      ['/api/sesiones', { pin: 1234 }],
      ['/api/sesiones', { pin: ['1234'] }],
      ['/api/sesiones', { pin: '1234', rol: 'admin' }],
      ['/api/sesiones', { pin: '1'.repeat(21) }],
      ['/api/sesiones/cerrar', { sesion_id: 'corto', secreto: 'x' }],
      ['/api/sesiones/cerrar', { sesion_id: nuevoId(), secreto: '' }],
      ['/api/sesiones/cerrar', { sesion_id: nuevoId(), secreto: 'x'.repeat(101) }],
      ['/api/sesiones/cerrar', { sesion_id: nuevoId(), secreto: 7 }],
      [
        '/api/autorizaciones',
        {
          sesion_id: nuevoId(),
          secreto: 'x',
          pin: '1234',
          accion: 'a'.repeat(51),
          agregado_id: nuevoId(),
          evento_id: nuevoId(),
        },
      ],
      [
        '/api/autorizaciones',
        {
          sesion_id: nuevoId(),
          secreto: 'x',
          pin: '1234',
          accion: 'anular_item_enviado',
          agregado_id: 'no',
          evento_id: nuevoId(),
        },
      ],
      [
        '/api/autorizaciones',
        {
          sesion_id: nuevoId(),
          secreto: 'x',
          pin: '1234',
          accion: 'anular_item_enviado',
          agregado_id: nuevoId(),
        },
      ],
    ]
    for (const [url, cuerpo] of malos) {
      const r = await api.enviar(url, { payload: cuerpo as object, token: api.token })
      expect(r.statusCode, `${url} ${JSON.stringify(cuerpo)}`).toBe(400)
      expect(r.json()).toEqual({
        error: 'datos_invalidos',
        mensaje: 'Datos con formato inesperado',
      })
      expect(r.body).not.toContain(secreto)
    }
    await sigueVivo(api)
  })

  it('cuerpos que no son un objeto JSON: null, número, texto, lista, vacío', async () => {
    const api = await conDispositivo()
    for (const cuerpo of ['null', '123', '"texto"', '[]', '[{"pin":"1234"}]', 'true']) {
      for (const url of [...RUTAS_CON_TOKEN, ...RUTAS_SIN_TOKEN]) {
        const r = await api.crudo(url, cuerpo, api.token)
        expect(r.statusCode, `${url} ${cuerpo}`).toBe(400)
      }
    }
    for (const url of [...RUTAS_CON_TOKEN, ...RUTAS_SIN_TOKEN]) {
      const sinCuerpo = await api.enviar(url, { token: api.token })
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
      const r = await api.crudo('/api/sesiones', cuerpo, api.token)
      expect(r.statusCode, JSON.stringify(cuerpo)).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, JSON.stringify(cuerpo)).toBeLessThan(500)
    }
    for (const tipo of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/xml',
      'multipart/form-data',
    ]) {
      const r = await api.enviar('/api/sesiones', { payload: 'pin=1234', tipo, token: api.token })
      expect(r.statusCode, tipo).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, tipo).toBeLessThan(500)
    }
    await sigueVivo(api)
  })

  it('cuerpos enormes se cortan con 413 sin leerlos enteros, y el hub sigue sirviendo', async () => {
    const api = await conDispositivo()
    const enorme = JSON.stringify({ pin: '1234', relleno: 'x'.repeat(5 * 1024 * 1024) })
    for (const url of [...RUTAS_CON_TOKEN, ...RUTAS_SIN_TOKEN]) {
      const r = await api.crudo(url, enorme, api.token)
      expect(r.statusCode, url).toBe(413)
    }
    // Y uno dentro del límite de Fastify pero con un campo gigante: lo para el esquema.
    const largo = await api.crudo(
      '/api/sesiones',
      JSON.stringify({ pin: '9'.repeat(500_000) }),
      api.token,
    )
    expect(largo.statusCode).toBe(400)
    const nombre = await api.crudo(
      '/api/emparejamientos',
      JSON.stringify({ pin: api.personas.admin.pin, nombre: 'N'.repeat(500_000), tipo: 'caja' }),
    )
    expect(nombre.statusCode).toBe(400)
    await sigueVivo(api)
    // Y un cliente normal entra sin problema justo después.
    const bien = await api.enviar('/api/sesiones', {
      payload: { pin: api.personas.mesero.pin },
      token: api.token,
    })
    expect(bien.statusCode).toBe(201)
  })

  it('JSON profundamente anidado o con claves peligrosas no tumba nada ni contamina objetos', async () => {
    const api = await conDispositivo()
    const profundo = `${'['.repeat(50_000)}${']'.repeat(50_000)}`
    const anidado = await api.crudo('/api/sesiones', profundo, api.token)
    expect(anidado.statusCode).toBeGreaterThanOrEqual(400)
    expect(anidado.statusCode).toBeLessThan(500)

    for (const cuerpo of [
      '{"__proto__":{"admin":true},"pin":"1234"}',
      '{"constructor":{"prototype":{"x":1}},"pin":"1234"}',
      '{"pin":"1234","__proto__":null}',
    ]) {
      const r = await api.crudo('/api/sesiones', cuerpo, api.token)
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
    for (const nombre of raros) {
      const c = await api.enviar('/api/emparejamientos', {
        payload: { pin: api.personas.admin.pin, nombre, tipo: 'kds' },
        token,
      })
      expect(c.statusCode, nombre).toBe(201)
      const e = await api.enviar('/api/emparejar', { payload: { codigo: c.json().codigo } })
      expect(e.statusCode, nombre).toBe(201)
      expect(e.json().nombre).toBe(nombre.trim())
    }
    // Más el celular del montaje.
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM dispositivo').get()?.n)).toBe(
      raros.length + 1,
    )
    // Solo-espacios y nombres de más de 60 caracteres no pasan la regla del servicio.
    for (const nombre of ['   ', 'x'.repeat(61)]) {
      const r = await api.enviar('/api/emparejamientos', {
        payload: { pin: api.personas.admin.pin, nombre, tipo: 'kds' },
        token,
      })
      expect(r.statusCode, nombre).toBe(400)
      expect(r.json().error).toBe('datos_invalidos')
    }
    await sigueVivo(api)
  })

  it('tipo de equipo inventado, con nombres de propiedades de Object o que no es de cocina: 400', async () => {
    const api = await conDispositivo()
    for (const tipo of [
      'tostadora',
      '',
      'CAJA',
      'toString',
      '__proto__',
      'constructor',
      'caja ',
      'caja',
      'mesero',
    ])
      expect(
        (
          await api.enviar('/api/emparejamientos', {
            payload: { pin: api.personas.admin.pin, nombre: 'X', tipo },
            token: api.token,
          })
        ).statusCode,
        tipo,
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
    for (const autorizacion of cabeceras) {
      const r = await api.app.inject({
        method: 'POST',
        url: '/api/sesiones',
        payload: { pin: '1234' },
        headers: { authorization: autorizacion },
      })
      expect(r.statusCode, autorizacion.slice(0, 30)).toBe(401)
    }
    await sigueVivo(api)
  })

  it('un token válido no sirve en la ruta de otra cosa, y las rutas de acceso solo aceptan POST', async () => {
    const api = await conDispositivo()
    for (const url of [...RUTAS_CON_TOKEN, ...RUTAS_SIN_TOKEN]) {
      for (const metodo of ['GET', 'PUT'] as const) {
        const r = await api.enviar(url, { metodo, token: api.token })
        expect(r.statusCode, `${metodo} ${url}`).toBe(404)
      }
    }
  })

  it('ids de equipo raros en la ruta de revocar: 4xx y el equipo real queda intacto', async () => {
    const api = await conDispositivo()
    // La caja entra con la contraseña del administrador y el hub la registra.
    const admin = (
      await api.enviar('/api/entrar', {
        payload: { usuario: api.personas.admin.usuario, contrasena: api.personas.admin.contrasena },
      })
    ).json()
    const token = admin.equipo.token as string
    const cuerpo = { sesion_id: admin.sesion_id, secreto: admin.secreto }

    for (const id of [
      'x',
      '%00',
      '%27%20OR%201%3D1',
      'a'.repeat(5000),
      '..%2f..%2fetc',
      nuevoId(),
      '%E0%A4%A',
    ]) {
      const r = await api.enviar(`/api/dispositivos/${id}/revocar`, { payload: cuerpo, token })
      expect(r.statusCode, id.slice(0, 20)).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, id.slice(0, 20)).toBeLessThan(500)
    }
    expect(
      api.db.prepare('SELECT count(*) AS n FROM dispositivo WHERE revocado_en IS NOT NULL').get()
        ?.n,
    ).toBe(0)
    // Sin cuerpo tampoco se revoca nada.
    const dispositivoId = (
      api.db.prepare("SELECT id FROM dispositivo WHERE nombre = 'Equipo de Ana'").get() as {
        id: string
      }
    ).id
    const sinCuerpo = await api.enviar(`/api/dispositivos/${dispositivoId}/revocar`, { token })
    expect(sinCuerpo.statusCode).toBe(400)
  })

  it('la sesión de un mesero no puede retirar equipos, ni con su propio token', async () => {
    const api = await conDispositivo()
    const otro = await api.enviar('/api/entrar', {
      payload: { pin: api.personas.mesero2.pin },
    })
    const objetivo = otro.json().equipo.dispositivo_id as string
    const r = await api.enviar(`/api/dispositivos/${objetivo}/revocar`, {
      payload: { sesion_id: api.sesion.sesion_id, secreto: api.sesion.secreto },
      token: api.token,
    })

    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ error: 'sin_permiso' })
    expect(api.revocados).toEqual([])
  })

  it('las respuestas de error no revelan el PIN, el token ni el secreto de sesión', async () => {
    const api = await conDispositivo()
    const respuestas = [
      await api.enviar('/api/sesiones', { payload: { pin: '0001' }, token: api.token }),
      await api.enviar('/api/sesiones/cerrar', {
        payload: { sesion_id: api.sesion.sesion_id, secreto: 'y'.repeat(43) },
        token: api.token,
      }),
      await api.enviar('/api/autorizaciones', {
        payload: {
          ...api.sesion,
          pin: '0002',
          accion: 'anular_item_enviado',
          agregado_id: nuevoId(),
          evento_id: nuevoId(),
        },
        token: api.token,
      }),
    ]
    for (const r of respuestas) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400)
      for (const secreto of [api.token, api.sesion.secreto, '0001', '0002', 'yyyy'])
        expect(r.body).not.toContain(secreto)
    }
  })

  it('un aluvión de peticiones malas seguidas no deja al hub sin responder a las buenas', async () => {
    const api = await conDispositivo()
    const malas = []
    for (let i = 0; i < 200; i++)
      malas.push(
        api.crudo(i % 2 ? '/api/sesiones' : '/api/emparejar', i % 3 ? '{' : '[]', api.token),
      )
    const respuestas = await Promise.all(malas)

    expect(respuestas.every((r) => r.statusCode >= 400 && r.statusCode < 500)).toBe(true)
    const bien = await api.enviar('/api/sesiones', {
      payload: { pin: api.personas.mesero.pin },
      token: api.token,
    })
    expect(bien.statusCode).toBe(201)
  })

  it('pedir un emparejamiento sin token o con un token falso: 401 sin gastar intentos', async () => {
    const api = await conDispositivo()
    for (const token of [undefined, 'inventado', 'x'.repeat(2000)]) {
      for (let i = 0; i < 5; i++) {
        const r = await api.enviar('/api/emparejamientos', {
          payload: { pin: '0001', nombre: 'X', tipo: 'kds' },
          token,
        })
        expect(r.statusCode).toBe(401)
        expect(r.json()).toMatchObject({ error: 'token_invalido' })
      }
    }
    // Quien sí tiene un equipo, con el PIN bueno, no esperó por nada de eso.
    const bien = await api.enviar('/api/emparejamientos', {
      payload: { pin: api.personas.admin.pin, nombre: 'Cocina', tipo: 'kds' },
      token: api.token,
    })
    expect(bien.statusCode).toBe(201)
  })

  it('la huella de la autorización: solo 64 caracteres hexadecimales', async () => {
    const api = await conDispositivo()
    const cuerpo = (huella: unknown) => ({
      sesion_id: api.sesion.sesion_id,
      secreto: api.sesion.secreto,
      pin: api.personas.gerente.pin,
      accion: 'anular_item_enviado',
      agregado_id: nuevoId(),
      evento_id: nuevoId(),
      huella,
    })
    for (const huella of [
      undefined,
      1,
      null,
      '',
      'abc',
      'g'.repeat(64),
      'A'.repeat(64),
      '0'.repeat(65),
    ]) {
      const r = await api.enviar('/api/autorizaciones', {
        payload: cuerpo(huella) as object,
        token: api.token,
      })
      expect(r.statusCode, String(huella)).toBe(400)
    }
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM autorizacion').get()?.n)).toBe(0)
    const bien = await api.enviar('/api/autorizaciones', {
      payload: cuerpo('a'.repeat(64)) as object,
      token: api.token,
    })
    expect(bien.statusCode).toBe(201)
  })
})
