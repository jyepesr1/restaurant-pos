import { configCompleta } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { leerCatalogo } from '../catalogo'
import { type Equipo, montarImpresion } from './montaje-impresion'

// `POST /api/cocina/cursos`: prender o apagar los cursos (entrada, fuerte, postre) en todo el
// restaurante. Solo con administrar_dispositivos. La versión del catálogo sube únicamente si el
// valor cambia (así los equipos no vuelven a pedir la carta por gusto).

type Json = Record<string, unknown>

function mundo() {
  const t = montarImpresion()
  const admin = t.equipo('admin', 'caja')
  const cajero = t.equipo('cajero', 'caja')
  const gerente = t.equipo('gerente', 'caja')
  const mesero = t.equipo('mesero')
  const llamar = (e: Equipo, url: string, extra: Json = {}) =>
    t.post(url, { ...e.cuerpoSesion, ...extra }, e.token)
  const cursos = (usar: unknown, e: Equipo = admin) => llamar(e, '/api/cocina/cursos', { usar })
  const catalogo = () => leerCatalogo(t.db, t.restauranteId)
  const config = async () => (await llamar(admin, '/api/cocina/configuracion')).json()
  const configGuardada = () =>
    JSON.parse(
      String(
        t.db.prepare('SELECT config FROM restaurante WHERE id = ?').get(t.restauranteId)?.config,
      ),
    ) as Record<string, unknown>
  return { t, admin, cajero, gerente, mesero, llamar, cursos, catalogo, config, configGuardada }
}

describe('POST /api/cocina/cursos: quién puede', () => {
  it('sin token responde 401, aunque el cuerpo sea basura', async () => {
    const { t } = mundo()
    for (const cuerpo of [{}, { usar: true }, 'texto', [1]]) {
      const r = await t.post('/api/cocina/cursos', cuerpo)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'token_invalido' })
    }
  })

  it('con un token inventado responde 401', async () => {
    const { t, admin } = mundo()
    const r = await t.post('/api/cocina/cursos', { ...admin.cuerpoSesion, usar: true }, 'inventado')
    expect(r.statusCode).toBe(401)
  })

  it('con una sesión inventada o con otro secreto responde 401 y no cambia nada', async () => {
    const m = mundo()
    for (const sesion of [
      { sesion_id: '01JB0000000000000000000000', secreto: 'inventado' },
      { sesion_id: m.admin.cuerpoSesion.sesion_id, secreto: 'otro-secreto' },
    ]) {
      const r = await m.t.post('/api/cocina/cursos', { ...sesion, usar: true }, m.admin.token)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'sesion_invalida' })
    }
    expect(m.catalogo().restaurante.usarCursos).toBe(false)
  })

  it('sin los datos de la sesión responde 400', async () => {
    const m = mundo()
    const r = await m.t.post('/api/cocina/cursos', { usar: true }, m.admin.token)
    expect(r.statusCode).toBe(400)
  })

  it('la sesión de otro equipo no sirve (401)', async () => {
    const m = mundo()
    const r = await m.t.post(
      '/api/cocina/cursos',
      { ...m.admin.cuerpoSesion, usar: true },
      m.mesero.token,
    )
    expect(r.statusCode).toBe(401)
  })

  it.each(['cajero', 'gerente', 'mesero'] as const)(
    '%s no tiene administrar_dispositivos: 403 y no cambia nada',
    async (quien) => {
      const m = mundo()
      const antes = m.catalogo().version
      const r = await m.cursos(true, m[quien])
      expect(r.statusCode).toBe(403)
      expect(r.json()).toMatchObject({ error: 'sin_permiso' })
      expect(m.catalogo().restaurante.usarCursos).toBe(false)
      expect(m.catalogo().version).toBe(antes)
      expect(m.t.cambiosCatalogo).toEqual([])
    },
  )

  it('un equipo retirado pierde el acceso', async () => {
    const m = mundo()
    await m.t.post(
      `/api/dispositivos/${m.mesero.conexion.dispositivoId}/revocar`,
      m.admin.cuerpoSesion,
      m.admin.token,
    )
    const r = await m.t.post(
      '/api/cocina/cursos',
      { ...m.mesero.cuerpoSesion, usar: true },
      m.mesero.token,
    )
    expect(r.statusCode).toBe(401)
  })

  it('una sesión cerrada se rechaza con 401', async () => {
    const m = mundo()
    await m.t.post('/api/sesiones/cerrar', m.admin.cuerpoSesion, m.admin.token)
    expect((await m.cursos(true)).statusCode).toBe(401)
  })
})

describe('POST /api/cocina/cursos: datos inválidos', () => {
  it.each([
    ['texto "true"', 'true'],
    ['número 1', 1],
    ['número 0', 0],
    ['null', null],
    ['arreglo', [true]],
    ['objeto', { usar: true }],
    ['cadena vacía', ''],
  ])('rechaza usar = %s con 400 y no cambia nada', async (_, valor) => {
    const m = mundo()
    const antes = m.catalogo().version
    const r = await m.cursos(valor)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'datos_invalidos' })
    expect(m.catalogo().restaurante.usarCursos).toBe(false)
    expect(m.catalogo().version).toBe(antes)
  })

  it('rechaza el cuerpo sin `usar` y con campos de más', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/cocina/cursos', {})).statusCode).toBe(400)
    expect(
      (await m.llamar(m.admin, '/api/cocina/cursos', { usar: true, otro: 1 })).statusCode,
    ).toBe(400)
    expect(m.catalogo().restaurante.usarCursos).toBe(false)
  })
})

describe('POST /api/cocina/cursos: efecto', () => {
  it('por defecto el restaurante no usa cursos, en la carta y en la configuración', async () => {
    const m = mundo()
    expect(m.catalogo().restaurante.usarCursos).toBe(false)
    expect((await m.config()).usar_cursos).toBe(false)
  })

  it('prender: 204, lo guarda, lo manda en la carta y avisa a los equipos', async () => {
    const m = mundo()
    const antes = m.catalogo().version
    const r = await m.cursos(true)
    expect(r.statusCode).toBe(204)
    expect(r.body).toBe('')
    expect(m.catalogo().restaurante.usarCursos).toBe(true)
    expect((await m.config()).usar_cursos).toBe(true)
    expect(m.catalogo().version).toBeGreaterThan(antes)
    expect(m.t.cambiosCatalogo).toEqual([m.catalogo().version])
  })

  it('prender y apagar de nuevo: cada cambio sube la versión', async () => {
    const m = mundo()
    await m.cursos(true)
    const v1 = m.catalogo().version
    await m.cursos(false)
    const v2 = m.catalogo().version
    expect(v2).toBeGreaterThan(v1)
    expect(m.catalogo().restaurante.usarCursos).toBe(false)
    expect(m.t.cambiosCatalogo).toHaveLength(2)
  })

  it('repetir el mismo valor responde 204 pero NO sube la versión ni avisa', async () => {
    const m = mundo()
    await m.cursos(true)
    const v = m.catalogo().version
    const avisos = m.t.cambiosCatalogo.length
    for (let i = 0; i < 3; i++) expect((await m.cursos(true)).statusCode).toBe(204)
    expect(m.catalogo().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(avisos)
  })

  it('apagar cuando ya está apagado (el de fábrica) no sube la versión', async () => {
    const m = mundo()
    const antes = m.catalogo().version
    expect((await m.cursos(false)).statusCode).toBe(204)
    expect(m.catalogo().version).toBe(antes)
    expect(m.t.cambiosCatalogo).toEqual([])
  })

  it('una configuración vieja sin el campo cuenta como apagado: apagar no cambia, prender sí', async () => {
    const m = mundo()
    const { usar_cursos: _, ...vieja } = configCompleta({})
    m.t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify(vieja), m.t.restauranteId)
    expect(m.catalogo().restaurante.usarCursos).toBe(false)
    const antes = m.catalogo().version
    await m.cursos(false)
    expect(m.catalogo().version).toBe(antes)
    await m.cursos(true)
    expect(m.catalogo().version).toBeGreaterThan(antes)
    expect(m.catalogo().restaurante.usarCursos).toBe(true)
  })

  it('con la configuración vacía ({}) la deja completa con los valores de fábrica', async () => {
    const m = mundo()
    m.t.db.prepare("UPDATE restaurante SET config = '{}' WHERE id = ?").run(m.t.restauranteId)
    await m.cursos(true)
    expect(m.configGuardada()).toMatchObject({
      usar_cursos: true,
      cocina_amarillo_min: 10,
      cocina_rojo_min: 20,
    })
  })

  it('conserva el resto de la configuración y deja quién lo cambió', async () => {
    const m = mundo()
    m.t.db.prepare('UPDATE restaurante SET config = ? WHERE id = ?').run(
      JSON.stringify({
        ...configCompleta({}),
        sesion_inactividad_min: 45,
        marca: 'la-spritzzeria',
      }),
      m.t.restauranteId,
    )
    await m.cursos(true)
    expect(m.configGuardada()).toMatchObject({
      sesion_inactividad_min: 45,
      marca: 'la-spritzzeria',
      usar_cursos: true,
    })
    const fila = m.t.db
      .prepare('SELECT usuario_id, dispositivo_id FROM restaurante WHERE id = ?')
      .get(m.t.restauranteId)
    expect(fila?.usuario_id).toBe(m.admin.sesion.usuario.id)
  })

  it('cambiar los tiempos no toca los cursos, y los cursos no tocan los tiempos', async () => {
    const m = mundo()
    await m.cursos(true)
    await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 7, rojo: 15 })
    expect(m.catalogo().restaurante).toMatchObject({
      usarCursos: true,
      cocinaAmarilloMin: 7,
      cocinaRojoMin: 15,
    })
    await m.cursos(false)
    expect(m.catalogo().restaurante).toMatchObject({
      usarCursos: false,
      cocinaAmarilloMin: 7,
      cocinaRojoMin: 15,
    })
  })

  it('dos administradores a la vez con valores distintos: gana el último y queda un solo valor', async () => {
    const m = mundo()
    const [a, b] = await Promise.all([m.cursos(true), m.cursos(false)])
    expect([a.statusCode, b.statusCode]).toEqual([204, 204])
    expect(typeof m.catalogo().restaurante.usarCursos).toBe('boolean')
    expect(m.configGuardada().usar_cursos).toBe(m.catalogo().restaurante.usarCursos)
  })
})

describe('POST /api/cocina/tiempos: sin cambios no sube la versión', () => {
  it('repetir los mismos minutos responde 204 y no sube la versión ni avisa', async () => {
    const m = mundo()
    await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 7, rojo: 15 })
    const v = m.catalogo().version
    const avisos = m.t.cambiosCatalogo.length
    const r = await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 7, rojo: 15 })
    expect(r.statusCode).toBe(204)
    expect(m.catalogo().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(avisos)
  })

  it('mandar los valores de fábrica (10 y 20) a un restaurante nuevo no sube la versión', async () => {
    const m = mundo()
    const v = m.catalogo().version
    expect(
      (await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 10, rojo: 20 })).statusCode,
    ).toBe(204)
    expect(m.catalogo().version).toBe(v)
  })

  it('cambiar un solo minuto sí la sube', async () => {
    const m = mundo()
    const v = m.catalogo().version
    await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 11, rojo: 20 })
    expect(m.catalogo().version).toBeGreaterThan(v)
  })

  it('«rojo ≤ ámbar» da 400 con el mensaje nuevo y no cambia nada', async () => {
    const m = mundo()
    const v = m.catalogo().version
    const r = await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 10, rojo: 10 })
    expect(r.statusCode).toBe(400)
    expect(r.json().mensaje).toBe('«Muy demorada» debe llegar después de «demorada»')
    expect(m.catalogo().version).toBe(v)
  })
})
