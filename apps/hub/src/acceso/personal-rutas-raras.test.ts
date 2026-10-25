import { describe, expect, it } from 'vitest'
import { montarApi } from './montaje-api'

// La API de personal con datos raros y sin permiso (tarea 1.3b): siempre un 4xx claro, nunca un
// 500; lo rechazado no cambia la base, no avisa a los equipos y no repite secretos.

async function admin() {
  const api = montarApi()
  const { token, sesion } = await api.entrarAdmin()
  const persona = (p: unknown, extra: object = {}) =>
    api.post('/api/personal/personas', { ...sesion, persona: p, ...extra }, { token })
  const rol = (r: unknown) => api.post('/api/personal/roles', { ...sesion, rol: r }, { token })
  const version = () =>
    Number(api.db.prepare("SELECT valor FROM contador WHERE nombre = 'catalogo'").get()?.valor)
  return { api, token, sesion, persona, rol, version }
}

const valida = (rolId: string) => ({ nombre: 'Bruno', rol_id: rolId })

describe('personas con datos raros', () => {
  it('campos de más, de menos o de otro tipo: 400 y la base no cambia ni avisa', async () => {
    const { api, persona, version } = await admin()
    const v = version()
    const raros: unknown[] = [
      null,
      42,
      'texto',
      [],
      {},
      { nombre: 'X' },
      { rol_id: api.roles.mesero },
      { ...valida(api.roles.mesero), extra: 1 },
      { ...valida(api.roles.mesero), nombre: 7 },
      { ...valida(api.roles.mesero), rol_id: 7 },
      { ...valida(api.roles.mesero), rol_id: 'corto' },
      { ...valida(api.roles.mesero), rol_id: 'x'.repeat(27) },
      { ...valida(api.roles.mesero), id: 'no-es-ulid' },
      { ...valida(api.roles.mesero), activo: 'si' },
      { ...valida(api.roles.mesero), regenerar_pin: 1 },
      { ...valida(api.roles.mesero), acceso: 'pin' },
      { ...valida(api.roles.mesero), acceso: { tipo: 'otro' } },
      { ...valida(api.roles.mesero), acceso: { tipo: 'pin', usuario: 'x' } },
      { ...valida(api.roles.mesero), acceso: { tipo: 'contrasena' } },
      { ...valida(api.roles.mesero), acceso: { tipo: 'contrasena', usuario: 5 } },
      {
        ...valida(api.roles.mesero),
        acceso: { tipo: 'contrasena', usuario: 'u'.repeat(101), contrasena: 'clave-larga-1' },
      },
      {
        ...valida(api.roles.mesero),
        acceso: { tipo: 'contrasena', usuario: 'bruno', contrasena: 'c'.repeat(201) },
      },
      { ...valida(api.roles.mesero), nombre: 'n'.repeat(101) },
    ]
    for (const p of raros) {
      const r = await persona(p)
      expect(r.statusCode, JSON.stringify(p)).toBe(400)
    }
    expect(version()).toBe(v)
    expect(api.cambiosCatalogo).toEqual([])
  })

  it('nombres del servicio: vacío, solo espacios, 61 letras; y el mensaje es claro', async () => {
    const { api, persona } = await admin()
    for (const nombre of ['', '   ', '\t\n', 'n'.repeat(61)]) {
      const r = await persona({ nombre, rol_id: api.roles.mesero })
      expect(r.statusCode, JSON.stringify(nombre)).toBe(400)
      expect(r.json().mensaje).toMatch(/entre 1 y 60/)
    }
    expect((await persona({ nombre: 'n'.repeat(60), rol_id: api.roles.mesero })).statusCode).toBe(
      200,
    )
  })

  it('nombres con Unicode, emoji, HTML o SQL se guardan como texto y vuelven iguales', async () => {
    const { api, persona, sesion, token } = await admin()
    const nombres = [
      'María José Peña',
      '李小龍',
      '👩‍🍳 Chef',
      '<img src=x onerror=alert(1)>',
      "Robert'); DROP TABLE usuario;--",
      'مرحبا',
    ]
    for (const nombre of nombres)
      expect((await persona({ nombre, rol_id: api.roles.mesero })).statusCode, nombre).toBe(200)
    const leido = (await api.post('/api/personal/leer', sesion, { token })).json()
    const guardados = leido.personas.map((p: { nombre: string }) => p.nombre)
    for (const nombre of nombres) expect(guardados).toContain(nombre.trim())
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM usuario').get()?.n)).toBeGreaterThan(
      nombres.length,
    )
  })

  it('un nombre con un carácter nulo no rompe nada: se guarda o se rechaza, pero no hay 500', async () => {
    const { api, persona } = await admin()
    const r = await persona({ nombre: 'a\u0000b', rol_id: api.roles.mesero })
    expect(r.statusCode).toBeLessThan(500)
  })

  it('rol que no existe, de otro tipo de id o archivado: 400 con mensaje', async () => {
    const { api, persona, rol } = await admin()
    const vacio = (await rol({ nombre: 'Temporal', permisos: ['tomar_pedido'] })).json().id
    await rol({ id: vacio, nombre: 'Temporal', permisos: [], activo: false })
    const inexistente = '0'.repeat(26)
    expect((await persona({ nombre: 'Bruno', rol_id: inexistente })).json().mensaje).toMatch(
      /Ese rol no existe/,
    )
    expect((await persona({ nombre: 'Bruno', rol_id: vacio })).json().mensaje).toMatch(/archivado/)
    expect(
      (await persona({ id: inexistente, nombre: 'Bruno', rol_id: api.roles.mesero })).json()
        .mensaje,
    ).toMatch(/no existe/)
  })

  it('una contraseña nueva exigida y corta: mensajes claros; y nunca se repite en la respuesta', async () => {
    const { api, persona } = await admin()
    const sinClave = await persona({
      nombre: 'Carla',
      rol_id: api.roles.cajero,
      acceso: { tipo: 'contrasena', usuario: 'carla' },
    })
    expect(sinClave.statusCode).toBe(400)
    expect(sinClave.json().mensaje).toMatch(/contraseña/)
    const corta = await persona({
      nombre: 'Carla',
      rol_id: api.roles.cajero,
      acceso: { tipo: 'contrasena', usuario: 'carla', contrasena: 'corta' },
    })
    expect(corta.statusCode).toBe(400)
    expect(corta.body).not.toContain('"corta"')
    const ok = await persona({
      nombre: 'Carla',
      rol_id: api.roles.cajero,
      acceso: { tipo: 'contrasena', usuario: 'carla', contrasena: 'esta-es-la-clave-1' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).not.toContain('esta-es-la-clave-1')
    expect(ok.body).not.toMatch(/scrypt|huella/)
  })

  it('con PIN solo no se puede dar un rol que cobra o administra: error claro y nada guardado', async () => {
    const { api, persona, version } = await admin()
    const v = version()
    const r = await persona({
      nombre: 'Cajero sin clave',
      rol_id: api.roles.cajero,
      acceso: { tipo: 'pin' },
    })
    expect(r.statusCode).toBe(400)
    expect(version()).toBe(v)
    expect(
      Number(
        api.db.prepare("SELECT count(*) AS n FROM usuario WHERE nombre = 'Cajero sin clave'").get()
          ?.n,
      ),
    ).toBe(0)
  })

  it('leer personal no devuelve PIN, huellas ni contraseñas', async () => {
    const { api, sesion, token } = await admin()
    const cuerpo = (await api.post('/api/personal/leer', sesion, { token })).body
    expect(cuerpo).not.toMatch(/huella|scrypt|pin_huella/)
    for (const p of Object.values(api.personas))
      expect(cuerpo).not.toContain(p.contrasena ?? 'sin-contrasena')
  })
})

describe('roles con datos raros', () => {
  it('permisos desconocidos, repetidos, demasiados o con nombres de Object: 400 o se limpian', async () => {
    const { api, rol, version } = await admin()
    const v = version()
    for (const permisos of [
      ['borrar_todo'],
      ['__proto__'],
      ['constructor'],
      ['tomar_pedido', 'toString'],
      Array.from({ length: 101 }, () => 'tomar_pedido'),
      [1],
      'tomar_pedido',
    ])
      expect(
        (await rol({ nombre: 'Raro', permisos })).statusCode,
        JSON.stringify(permisos).slice(0, 40),
      ).toBe(400)
    expect(version()).toBe(v)
    const repetidos = await rol({
      nombre: 'Repetidos',
      permisos: ['tomar_pedido', 'tomar_pedido', 'cortesia'],
    })
    expect(repetidos.statusCode).toBe(200)
    expect(
      Number(
        api.db
          .prepare('SELECT count(*) AS n FROM rol_permiso WHERE rol_id = ?')
          .get(repetidos.json().id)?.n,
      ),
    ).toBe(2)
  })

  it('nombres de rol: vacío, de 61, repetido con otra mayúscula o tilde distinta, y el de fábrica no se renombra', async () => {
    const { api, rol } = await admin()
    expect((await rol({ nombre: ' ', permisos: [] })).statusCode).toBe(400)
    expect((await rol({ nombre: 'r'.repeat(61), permisos: [] })).statusCode).toBe(400)
    expect((await rol({ nombre: 'MESERO', permisos: [] })).json().mensaje).toMatch(/Ya hay un rol/)
    expect(
      (await rol({ id: api.roles.mesero, nombre: 'Camarero', permisos: [] })).json().mensaje,
    ).toMatch(/no se renombran/)
    expect(
      (await rol({ id: api.roles.mesero, nombre: 'Mesero', permisos: [], activo: false })).json()
        .mensaje,
    ).toMatch(/no se archivan/)
    expect(
      (await rol({ id: '0'.repeat(26), nombre: 'Fantasma', permisos: [] })).json().mensaje,
    ).toMatch(/no existe/)
  })

  it('dar a un rol con gente por PIN un permiso que exige contraseña se rechaza y no cambia nada', async () => {
    const { api, rol, version } = await admin()
    const v = version()
    const r = await rol({
      id: api.roles.mesero,
      nombre: 'Mesero',
      permisos: ['tomar_pedido', 'registrar_pago'],
    })
    expect(r.statusCode).toBe(400)
    expect(version()).toBe(v)
  })

  it('un rol sin permisos es válido (y su gente no puede hacer nada)', async () => {
    const { api, rol, persona } = await admin()
    const id = (await rol({ nombre: 'Observadores', permisos: [] })).json().id
    expect((await persona({ nombre: 'Omar', rol_id: id })).statusCode).toBe(200)
    expect(
      api.acceso.permisosDe(
        (api.db.prepare("SELECT id FROM usuario WHERE nombre = 'Omar'").get() as { id: string }).id,
      ),
    ).toEqual([])
  })
})

describe('sin permiso, sin sesión o con credenciales ajenas', () => {
  async function conCajaYReportes() {
    const a = await admin()
    const { api, persona } = a
    await persona({
      nombre: 'Rita',
      rol_id: api.roles.reportes,
      acceso: { tipo: 'contrasena', usuario: 'rita', contrasena: 'clave-de-rita-1' },
    })
    const entrar = async (cuerpo: object, ip: string) => {
      const r = (await api.post('/api/entrar', cuerpo, { ip })).json()
      return {
        token: r.equipo.token as string,
        sesion: { sesion_id: r.sesion_id as string, secreto: r.secreto as string },
      }
    }
    return {
      ...a,
      cajero: await entrar({ usuario: 'carlos', contrasena: 'clave-de-carlos' }, '10.0.9.1'),
      reportes: await entrar({ usuario: 'rita', contrasena: 'clave-de-rita-1' }, '10.0.9.2'),
      mesero: await entrar({ pin: api.personas.mesero.pin }, '10.0.9.3'),
    }
  }
  const RUTAS = ['/api/personal/leer', '/api/personal/roles', '/api/personal/personas'] as const

  it('cajero, reportes y mesero: 403 en las tres rutas, sin efecto', async () => {
    const t = await conCajaYReportes()
    const antes = JSON.stringify(t.api.db.prepare('SELECT * FROM usuario ORDER BY id').all())
    for (const quien of [t.cajero, t.reportes, t.mesero])
      for (const url of RUTAS) {
        const cuerpo =
          url === '/api/personal/leer'
            ? quien.sesion
            : url === '/api/personal/roles'
              ? { ...quien.sesion, rol: { nombre: 'Colado', permisos: [] } }
              : { ...quien.sesion, persona: { nombre: 'Colado', rol_id: t.api.roles.mesero } }
        expect((await t.api.post(url, cuerpo, { token: quien.token })).statusCode, url).toBe(403)
      }
    expect(JSON.stringify(t.api.db.prepare('SELECT * FROM usuario ORDER BY id').all())).toBe(antes)
  })

  it('sin token, token inventado, sesión de otro equipo, secreto errado o sesión cerrada: 401', async () => {
    const t = await conCajaYReportes()
    const { token, sesion } = t
    const cuerpo = (url: string, s: object) =>
      url === '/api/personal/leer'
        ? s
        : url === '/api/personal/roles'
          ? { ...s, rol: { nombre: 'Colado', permisos: [] } }
          : { ...s, persona: { nombre: 'Colado', rol_id: t.api.roles.mesero } }
    for (const url of RUTAS) {
      const intentos: [string, object, string | undefined][] = [
        ['sin token', sesion, undefined],
        ['inventado', sesion, 'inventado'],
        ['otro equipo', sesion, t.mesero.token],
        ['secreto', { ...sesion, secreto: 'otro' }, token],
        ['sesión', { ...sesion, sesion_id: '0'.repeat(26) }, token],
      ]
      for (const [que, s, tk] of intentos)
        expect(
          (await t.api.post(url, cuerpo(url, s), { token: tk })).statusCode,
          `${url} ${que}`,
        ).toBe(401)
    }
    expect(
      Number(
        t.api.db.prepare("SELECT count(*) AS n FROM usuario WHERE nombre = 'Colado'").get()?.n,
      ),
    ).toBe(0)
    await t.api.post('/api/sesiones/cerrar', sesion, { token })
    expect((await t.api.post('/api/personal/leer', sesion, { token })).statusCode).toBe(401)
  })

  it('«Bearer» en minúsculas, esquemas raros y tokens con espacios no pasan', async () => {
    const t = await conCajaYReportes()
    for (const autorizacion of [
      `bearer ${t.token}`,
      `Basic ${t.token}`,
      t.token,
      `Bearer  ${t.token}`,
      `Bearer ${t.mesero.token}x`,
    ]) {
      const r = await t.api.post('/api/personal/leer', t.sesion, {
        cabeceras: { authorization: autorizacion },
      })
      expect(r.statusCode, autorizacion.slice(0, 20)).toBe(401)
    }
  })

  it('un equipo retirado ya no administra, aunque conserve su sesión', async () => {
    const t = await conCajaYReportes()
    const retirado = await t.api.post(
      '/api/entrar',
      { usuario: 'rita', contrasena: 'clave-de-rita-1' },
      { ip: '10.0.9.9' },
    )
    expect(retirado.statusCode).toBe(201)
    const id = retirado.json().equipo.dispositivo_id
    const revocar = await t.api.post(`/api/dispositivos/${id}/revocar`, t.sesion, {
      token: t.token,
    })
    expect(revocar.statusCode).toBe(200)
    const r = await t.api.post(
      '/api/personal/leer',
      { sesion_id: retirado.json().sesion_id, secreto: retirado.json().secreto },
      { token: retirado.json().equipo.token },
    )
    expect([401, 403]).toContain(r.statusCode)
  })

  it('una persona archivada con la sesión abierta ya no administra', async () => {
    const t = await conCajaYReportes()
    const jefa = await t.persona({
      nombre: 'Jefa',
      rol_id: t.api.roles.admin,
      acceso: { tipo: 'contrasena', usuario: 'jefa', contrasena: 'clave-de-la-jefa' },
    })
    const e = (
      await t.api.post(
        '/api/entrar',
        { usuario: 'jefa', contrasena: 'clave-de-la-jefa' },
        { ip: '10.0.9.10' },
      )
    ).json()
    const suya = { sesion_id: e.sesion_id, secreto: e.secreto }
    expect(
      (await t.api.post('/api/personal/leer', suya, { token: e.equipo.token })).statusCode,
    ).toBe(200)
    await t.persona({
      id: jefa.json().id,
      nombre: 'Jefa',
      rol_id: t.api.roles.admin,
      activo: false,
    })
    expect(
      (await t.api.post('/api/personal/leer', suya, { token: e.equipo.token })).statusCode,
    ).toBe(401)
  })

  it('JSON mal formado, vacío, con otro tipo de contenido o enorme: 4xx, nunca 5xx', async () => {
    const t = await conCajaYReportes()
    const enviar = (payload: string, tipo = 'application/json') =>
      t.api.app.inject({
        method: 'POST',
        url: '/api/personal/personas',
        payload,
        headers: { 'content-type': tipo, authorization: `Bearer ${t.token}` },
      })
    for (const [cuerpo, tipo] of [
      ['{', 'application/json'],
      ['', 'application/json'],
      ['nulo', 'text/plain'],
      ['x'.repeat(2_000_000), 'application/json'],
      ['[[[[[[[[[[[[[[[[[[[[', 'application/json'],
    ] as const) {
      const r = await enviar(cuerpo, tipo)
      expect(r.statusCode, `${cuerpo.slice(0, 10)} ${tipo}`).toBeGreaterThanOrEqual(400)
      expect(r.statusCode).toBeLessThan(500)
    }
    for (const metodo of ['GET', 'PUT', 'DELETE'] as const) {
      const r = await t.api.app.inject({ method: metodo, url: '/api/personal/leer' })
      expect(r.statusCode).toBeGreaterThanOrEqual(400)
      expect(r.statusCode).toBeLessThan(500)
    }
  })

  it('los errores de la API de personal no repiten la sesión, el token ni el secreto enviados', async () => {
    const t = await conCajaYReportes()
    const r = await t.api.post(
      '/api/personal/roles',
      { ...t.sesion, rol: { nombre: 5 } },
      { token: t.token },
    )
    for (const secreto of [t.sesion.secreto, t.token, t.sesion.sesion_id])
      expect(r.body).not.toContain(secreto)
    const mala = await t.api.post(
      '/api/personal/leer',
      { ...t.sesion, secreto: 'secreto-que-no-es' },
      { token: t.token },
    )
    expect(mala.body).not.toContain('secreto-que-no-es')
  })

  it('un aluvión de peticiones malas no tumba al hub: la buena después responde', async () => {
    const t = await conCajaYReportes()
    await Promise.all(Array.from({ length: 200 }, (_, i) => t.persona({ nombre: i, rol_id: 7 })))
    expect((await t.api.post('/api/personal/leer', t.sesion, { token: t.token })).statusCode).toBe(
      200,
    )
  })
})
