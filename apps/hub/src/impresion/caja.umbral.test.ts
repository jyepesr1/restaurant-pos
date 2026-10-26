import { fullConfig, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { leerCatalogo } from '../catalogo'
import { type Equipo, montarImpresion } from './montaje-impresion'

// `POST /api/caja/umbral` y lo que `/api/caja/configuracion` y la carta dicen del umbral de
// diferencia del cierre de caja (tarea 1.7), más la zona horaria y el inicio del día en la carta.

type Json = Record<string, unknown>

function mundo(timeZone?: string) {
  const t = montarImpresion(timeZone ? { timeZone } : {})
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const waiter = t.device('waiter')
  const llamar = (e: Equipo, url: string, extra: Json = {}) =>
    t.post(url, { ...e.cuerpoSesion, ...extra }, e.token)
  const threshold = (pesos: unknown, e: Equipo = admin) =>
    llamar(e, '/api/register/threshold', { pesos })
  const catalog = () => leerCatalogo(t.db, t.restaurantId)
  const guardada = () =>
    fullConfig(
      JSON.parse(
        String(
          t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(t.restaurantId)?.config,
        ),
      ),
    )
  const settings = async (e: Equipo = admin) =>
    (await llamar(e, '/api/register/config')).json() as { register_variance_threshold: number }
  return { t, admin, cashier, waiter, llamar, threshold, catalog, guardada, settings }
}

describe('POST /api/caja/umbral', () => {
  it.each([0, 1, 1000, 25_000, 1_000_000])(
    'guarda $%i: 204, queda en la configuración y la carta',
    async (pesos) => {
      const m = mundo()
      const r = await m.threshold(pesos)
      expect(r.statusCode).toBe(204)
      expect(r.body).toBe('')
      expect(m.guardada().register_variance_threshold).toBe(pesos)
      expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(pesos)
      expect((await m.settings()).register_variance_threshold).toBe(pesos)
    },
  )

  it('de fábrica es $1.000, en la configuración y en la carta', async () => {
    const m = mundo()
    expect((await m.settings()).register_variance_threshold).toBe(1000)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(1000)
  })

  it('avisa del cambio (sube la versión de la carta) y deja el autor', async () => {
    const m = mundo()
    const before = m.catalog().version
    await m.threshold(2_000)
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.cambiosCatalogo).toEqual([m.catalog().version])
    const row = m.t.db
      .prepare('SELECT user_id, device_id FROM restaurants WHERE id = ?')
      .get(m.t.restaurantId)
    expect(row).toEqual({
      user_id: m.t.people.admin.userId,
      device_id: m.admin.connection.deviceId,
    })
  })

  it('el mismo valor no sube la versión ni avisa', async () => {
    const m = mundo()
    const v = m.catalog().version
    await m.threshold(1000)
    expect(m.catalog().version).toBe(v)
    expect(m.t.cambiosCatalogo).toEqual([])
  })

  it('no toca el resto de la configuración', async () => {
    const m = mundo()
    const before = { ...m.guardada(), register_variance_threshold: 0 }
    await m.threshold(0)
    expect(m.guardada()).toEqual(before)
  })

  it.each([
    ['negative', -1],
    ['sobre el tope', 1_000_001],
    ['con decimales', 500.5],
    ['text', '1000'],
    ['null', null],
    ['NaN como texto', 'NaN'],
    ['arreglo', [1000]],
    ['ausente', undefined],
  ])('rechaza %s con 400 y no cambia nada', async (_, pesos) => {
    const m = mundo()
    const r = await m.threshold(pesos)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      error: 'invalid_data',
      message: 'Escribe un valor entre 0 y 1.000.000',
    })
    expect(m.guardada().register_variance_threshold).toBe(1000)
    expect(m.t.cambiosCatalogo).toEqual([])
  })

  it('con campos de más: 400', async () => {
    const m = mundo()
    const r = await m.llamar(m.admin, '/api/register/threshold', { pesos: 500, other: 1 })
    expect(r.statusCode).toBe(400)
    expect(m.guardada().register_variance_threshold).toBe(1000)
  })

  it('sin token: 401; token inventado: 401; sin sesión: 400', async () => {
    const m = mundo()
    expect((await m.t.post('/api/register/threshold', { pesos: 1 })).statusCode).toBe(401)
    expect(
      (
        await m.t.post(
          '/api/register/threshold',
          { ...m.admin.cuerpoSesion, pesos: 1 },
          'inventado',
        )
      ).statusCode,
    ).toBe(401)
    expect(
      (await m.t.post('/api/register/threshold', { pesos: 1 }, m.admin.token)).statusCode,
    ).toBe(400)
  })

  it('sesión inventada o con otro secreto: 401', async () => {
    const m = mundo()
    for (const session of [
      { session_id: newId(), secret: 'inventado' },
      { session_id: m.admin.cuerpoSesion.session_id, secret: 'other' },
    ]) {
      const r = await m.t.post('/api/register/threshold', { ...session, pesos: 1 }, m.admin.token)
      expect(r.statusCode).toBe(401)
    }
  })

  it('la sesión de otro equipo no sirve (401)', async () => {
    const m = mundo()
    const r = await m.t.post(
      '/api/register/threshold',
      { ...m.admin.cuerpoSesion, pesos: 1 },
      m.waiter.token,
    )
    expect(r.statusCode).toBe(401)
  })

  it('el cajero y el mesero, que no administran dispositivos: 403 y no cambian nada', async () => {
    for (const who of ['cashier', 'waiter'] as const) {
      const m = mundo()
      const r = await m.threshold(5_000, m[who])
      expect(r.statusCode, who).toBe(403)
      expect(m.guardada().register_variance_threshold).toBe(1000)
      expect(m.t.cambiosCatalogo).toEqual([])
    }
  })

  it('una sesión cerrada: 401', async () => {
    const m = mundo()
    await m.t.post('/api/sessions/close', m.admin.cuerpoSesion, m.admin.token)
    expect((await m.threshold(5_000)).statusCode).toBe(401)
  })

  it('un equipo retirado pierde el acceso', async () => {
    const m = mundo()
    await m.t.post(
      `/api/devices/${m.waiter.connection.deviceId}/revoke`,
      m.admin.cuerpoSesion,
      m.admin.token,
    )
    expect((await m.threshold(5_000, m.waiter)).statusCode).toBe(401)
  })

  it('el umbral de un restaurante no cambia el de otro', async () => {
    const m = mundo()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(other, other, new Date(m.t.clock()).toISOString(), new Date(m.t.clock()).toISOString())
    m.t.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    await m.threshold(7_000)
    expect(leerCatalogo(m.t.db, other).restaurant.checkout?.varianceThreshold).toBe(1000)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(7_000)
  })
})

describe('POST /api/caja/configuracion: el umbral', () => {
  it('lo trae junto con los medios, la propina y los datáfonos', async () => {
    const m = mundo()
    await m.threshold(3_000)
    const r = (await m.llamar(m.admin, '/api/register/config')).json() as Json
    expect(r).toMatchObject({ register_variance_threshold: 3_000, suggested_tip: 1000 })
    expect(Object.keys(r)).toEqual(
      expect.arrayContaining(['payment_methods', 'custom_methods', 'cardTerminals']),
    )
  })

  it('con una configuración vieja sin el campo, $1.000', async () => {
    const m = mundo()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restaurantId)
    expect((await m.settings()).register_variance_threshold).toBe(1000)
  })

  it('el cajero no la ve (403)', async () => {
    const m = mundo()
    expect((await m.llamar(m.cashier, '/api/register/config')).statusCode).toBe(403)
  })
})

describe('catálogo: cobro.umbralDiferencia, zonaHoraria e inicioDiaOperativo', () => {
  it('trae el umbral de la configuración guardada', () => {
    const m = mundo()
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ register_variance_threshold: 250 }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(250)
  })

  it('un umbral de $0 llega como 0 (no se confunde con «sin umbral»)', () => {
    const m = mundo()
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ register_variance_threshold: 0 }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(0)
  })

  it('una configuración vieja sin el campo trae $1.000', () => {
    const m = mundo()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(1000)
  })

  it('trae la zona horaria de la sede y el inicio del día operativo de la configuración', () => {
    const m = mundo()
    expect(m.catalog().restaurant.checkout).toMatchObject({
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
    })
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ business_day_start: '04:30' }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.businessDayStart).toBe('04:30')
  })

  it('la zona horaria sigue a la sede activa del restaurante', () => {
    const m = mundo()
    m.t.db
      .prepare('UPDATE locations SET time_zone = ? WHERE restaurant_id = ?')
      .run('America/Mexico_City', m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.timeZone).toBe('America/Mexico_City')
  })

  it('el restaurante sin sede cae en America/Bogota', () => {
    const m = mundo()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Sin sede', '{}')`,
      )
      .run(other, other, new Date(m.t.clock()).toISOString(), new Date(m.t.clock()).toISOString())
    m.t.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    expect(leerCatalogo(m.t.db, other).restaurant.checkout?.timeZone).toBe('America/Bogota')
  })
})
