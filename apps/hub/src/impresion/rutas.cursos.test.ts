import { fullConfig } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { leerCatalogo } from '../catalogo'
import { type Equipo, montarImpresion } from './montaje-impresion'

// `POST /api/cocina/cursos`: prender o apagar los cursos (entrada, fuerte, postre) en todo el
// restaurante. Solo con manage_devices. La versión del catálogo sube únicamente si el
// valor cambia (así los equipos no vuelven a pedir la carta por gusto).

type Json = Record<string, unknown>

function mundo() {
  const t = montarImpresion()
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const manager = t.device('manager', 'register')
  const waiter = t.device('waiter')
  const llamar = (e: Equipo, url: string, extra: Json = {}) =>
    t.post(url, { ...e.cuerpoSesion, ...extra }, e.token)
  const cursos = (usar: unknown, e: Equipo = admin) => llamar(e, '/api/kitchen/courses', { usar })
  const catalog = () => leerCatalogo(t.db, t.restaurantId)
  const config = async () => (await llamar(admin, '/api/kitchen/config')).json()
  const configGuardada = () =>
    JSON.parse(
      String(
        t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(t.restaurantId)?.config,
      ),
    ) as Record<string, unknown>
  return { t, admin, cashier, manager, waiter, llamar, cursos, catalog, config, configGuardada }
}

describe('POST /api/cocina/cursos: quién puede', () => {
  it('sin token responde 401, aunque el cuerpo sea basura', async () => {
    const { t } = mundo()
    for (const cuerpo of [{}, { usar: true }, 'text', [1]]) {
      const r = await t.post('/api/kitchen/courses', cuerpo)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_token' })
    }
  })

  it('con un token inventado responde 401', async () => {
    const { t, admin } = mundo()
    const r = await t.post(
      '/api/kitchen/courses',
      { ...admin.cuerpoSesion, usar: true },
      'inventado',
    )
    expect(r.statusCode).toBe(401)
  })

  it('con una sesión inventada o con otro secreto responde 401 y no cambia nada', async () => {
    const m = mundo()
    for (const session of [
      { session_id: '01JB0000000000000000000000', secret: 'inventado' },
      { session_id: m.admin.cuerpoSesion.session_id, secret: 'otro-secreto' },
    ]) {
      const r = await m.t.post('/api/kitchen/courses', { ...session, usar: true }, m.admin.token)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_session' })
    }
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
  })

  it('sin los datos de la sesión responde 400', async () => {
    const m = mundo()
    const r = await m.t.post('/api/kitchen/courses', { usar: true }, m.admin.token)
    expect(r.statusCode).toBe(400)
  })

  it('la sesión de otro equipo no sirve (401)', async () => {
    const m = mundo()
    const r = await m.t.post(
      '/api/kitchen/courses',
      { ...m.admin.cuerpoSesion, usar: true },
      m.waiter.token,
    )
    expect(r.statusCode).toBe(401)
  })

  it.each(['cashier', 'manager', 'waiter'] as const)(
    '%s no tiene administrar_dispositivos: 403 y no cambia nada',
    async (who) => {
      const m = mundo()
      const before = m.catalog().version
      const r = await m.cursos(true, m[who])
      expect(r.statusCode).toBe(403)
      expect(r.json()).toMatchObject({ error: 'no_permission' })
      expect(m.catalog().restaurant.coursesEnabled).toBe(false)
      expect(m.catalog().version).toBe(before)
      expect(m.t.cambiosCatalogo).toEqual([])
    },
  )

  it('un equipo retirado pierde el acceso', async () => {
    const m = mundo()
    await m.t.post(
      `/api/devices/${m.waiter.connection.deviceId}/revoke`,
      m.admin.cuerpoSesion,
      m.admin.token,
    )
    const r = await m.t.post(
      '/api/kitchen/courses',
      { ...m.waiter.cuerpoSesion, usar: true },
      m.waiter.token,
    )
    expect(r.statusCode).toBe(401)
  })

  it('una sesión cerrada se rechaza con 401', async () => {
    const m = mundo()
    await m.t.post('/api/sessions/close', m.admin.cuerpoSesion, m.admin.token)
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
  ])('rechaza usar = %s con 400 y no cambia nada', async (_, value) => {
    const m = mundo()
    const before = m.catalog().version
    const r = await m.cursos(value)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'invalid_data' })
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
    expect(m.catalog().version).toBe(before)
  })

  it('rechaza el cuerpo sin `usar` y con campos de más', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/kitchen/courses', {})).statusCode).toBe(400)
    expect(
      (await m.llamar(m.admin, '/api/kitchen/courses', { usar: true, other: 1 })).statusCode,
    ).toBe(400)
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
  })
})

describe('POST /api/cocina/cursos: efecto', () => {
  it('por defecto el restaurante no usa cursos, en la carta y en la configuración', async () => {
    const m = mundo()
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
    expect((await m.config()).courses_enabled).toBe(false)
  })

  it('prender: 204, lo guarda, lo manda en la carta y avisa a los equipos', async () => {
    const m = mundo()
    const before = m.catalog().version
    const r = await m.cursos(true)
    expect(r.statusCode).toBe(204)
    expect(r.body).toBe('')
    expect(m.catalog().restaurant.coursesEnabled).toBe(true)
    expect((await m.config()).courses_enabled).toBe(true)
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.cambiosCatalogo).toEqual([m.catalog().version])
  })

  it('prender y apagar de nuevo: cada cambio sube la versión', async () => {
    const m = mundo()
    await m.cursos(true)
    const v1 = m.catalog().version
    await m.cursos(false)
    const v2 = m.catalog().version
    expect(v2).toBeGreaterThan(v1)
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
    expect(m.t.cambiosCatalogo).toHaveLength(2)
  })

  it('repetir el mismo valor responde 204 pero NO sube la versión ni avisa', async () => {
    const m = mundo()
    await m.cursos(true)
    const v = m.catalog().version
    const alerts = m.t.cambiosCatalogo.length
    for (let i = 0; i < 3; i++) expect((await m.cursos(true)).statusCode).toBe(204)
    expect(m.catalog().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(alerts)
  })

  it('apagar cuando ya está apagado (el de fábrica) no sube la versión', async () => {
    const m = mundo()
    const before = m.catalog().version
    expect((await m.cursos(false)).statusCode).toBe(204)
    expect(m.catalog().version).toBe(before)
    expect(m.t.cambiosCatalogo).toEqual([])
  })

  it('una configuración vieja sin el campo cuenta como apagado: apagar no cambia, prender sí', async () => {
    const m = mundo()
    const { courses_enabled: _, ...vieja } = fullConfig({})
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify(vieja), m.t.restaurantId)
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
    const before = m.catalog().version
    await m.cursos(false)
    expect(m.catalog().version).toBe(before)
    await m.cursos(true)
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.catalog().restaurant.coursesEnabled).toBe(true)
  })

  it('con la configuración vacía ({}) la deja completa con los valores de fábrica', async () => {
    const m = mundo()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restaurantId)
    await m.cursos(true)
    expect(m.configGuardada()).toMatchObject({
      courses_enabled: true,
      kitchen_yellow_min: 10,
      kitchen_red_min: 20,
    })
  })

  it('conserva el resto de la configuración y deja quién lo cambió', async () => {
    const m = mundo()
    m.t.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run(
      JSON.stringify({
        ...fullConfig({}),
        session_idle_min: 45,
        brand: 'la-spritzzeria',
      }),
      m.t.restaurantId,
    )
    await m.cursos(true)
    expect(m.configGuardada()).toMatchObject({
      session_idle_min: 45,
      brand: 'la-spritzzeria',
      courses_enabled: true,
    })
    const row = m.t.db
      .prepare('SELECT user_id, device_id FROM restaurants WHERE id = ?')
      .get(m.t.restaurantId)
    expect(row?.user_id).toBe(m.admin.session.user.id)
  })

  it('cambiar los tiempos no toca los cursos, y los cursos no tocan los tiempos', async () => {
    const m = mundo()
    await m.cursos(true)
    await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 7, rojo: 15 })
    expect(m.catalog().restaurant).toMatchObject({
      coursesEnabled: true,
      kitchenYellowMin: 7,
      kitchenRedMin: 15,
    })
    await m.cursos(false)
    expect(m.catalog().restaurant).toMatchObject({
      coursesEnabled: false,
      kitchenYellowMin: 7,
      kitchenRedMin: 15,
    })
  })

  it('dos administradores a la vez con valores distintos: gana el último y queda un solo valor', async () => {
    const m = mundo()
    const [a, b] = await Promise.all([m.cursos(true), m.cursos(false)])
    expect([a.statusCode, b.statusCode]).toEqual([204, 204])
    expect(typeof m.catalog().restaurant.coursesEnabled).toBe('boolean')
    expect(m.configGuardada().courses_enabled).toBe(m.catalog().restaurant.coursesEnabled)
  })
})

describe('POST /api/cocina/tiempos: sin cambios no sube la versión', () => {
  it('repetir los mismos minutos responde 204 y no sube la versión ni avisa', async () => {
    const m = mundo()
    await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 7, rojo: 15 })
    const v = m.catalog().version
    const alerts = m.t.cambiosCatalogo.length
    const r = await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 7, rojo: 15 })
    expect(r.statusCode).toBe(204)
    expect(m.catalog().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(alerts)
  })

  it('mandar los valores de fábrica (10 y 20) a un restaurante nuevo no sube la versión', async () => {
    const m = mundo()
    const v = m.catalog().version
    expect(
      (await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 10, rojo: 20 })).statusCode,
    ).toBe(204)
    expect(m.catalog().version).toBe(v)
  })

  it('cambiar un solo minuto sí la sube', async () => {
    const m = mundo()
    const v = m.catalog().version
    await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 11, rojo: 20 })
    expect(m.catalog().version).toBeGreaterThan(v)
  })

  it('«rojo ≤ ámbar» da 400 con el mensaje nuevo y no cambia nada', async () => {
    const m = mundo()
    const v = m.catalog().version
    const r = await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 10, rojo: 10 })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toBe('«Muy demorada» debe llegar después de «demorada»')
    expect(m.catalog().version).toBe(v)
  })
})
