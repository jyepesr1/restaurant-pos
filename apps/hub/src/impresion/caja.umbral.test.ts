import { configCompleta, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { leerCatalogo } from '../catalogo'
import { type Equipo, montarImpresion } from './montaje-impresion'

// `POST /api/caja/umbral` y lo que `/api/caja/configuracion` y la carta dicen del umbral de
// diferencia del cierre de caja (tarea 1.7), más la zona horaria y el inicio del día en la carta.

type Json = Record<string, unknown>

function mundo(zonaHoraria?: string) {
  const t = montarImpresion(zonaHoraria ? { zonaHoraria } : {})
  const admin = t.equipo('admin', 'caja')
  const cajero = t.equipo('cajero', 'caja')
  const mesero = t.equipo('mesero')
  const llamar = (e: Equipo, url: string, extra: Json = {}) =>
    t.post(url, { ...e.cuerpoSesion, ...extra }, e.token)
  const umbral = (pesos: unknown, e: Equipo = admin) => llamar(e, '/api/caja/umbral', { pesos })
  const catalogo = () => leerCatalogo(t.db, t.restauranteId)
  const guardada = () =>
    configCompleta(
      JSON.parse(
        String(
          t.db.prepare('SELECT config FROM restaurante WHERE id = ?').get(t.restauranteId)?.config,
        ),
      ),
    )
  const ajustes = async (e: Equipo = admin) =>
    (await llamar(e, '/api/caja/configuracion')).json() as { umbral_diferencia_caja: number }
  return { t, admin, cajero, mesero, llamar, umbral, catalogo, guardada, ajustes }
}

describe('POST /api/caja/umbral', () => {
  it.each([0, 1, 1000, 25_000, 1_000_000])(
    'guarda $%i: 204, queda en la configuración y la carta',
    async (pesos) => {
      const m = mundo()
      const r = await m.umbral(pesos)
      expect(r.statusCode).toBe(204)
      expect(r.body).toBe('')
      expect(m.guardada().umbral_diferencia_caja).toBe(pesos)
      expect(m.catalogo().restaurante.cobro?.umbralDiferencia).toBe(pesos)
      expect((await m.ajustes()).umbral_diferencia_caja).toBe(pesos)
    },
  )

  it('de fábrica es $1.000, en la configuración y en la carta', async () => {
    const m = mundo()
    expect((await m.ajustes()).umbral_diferencia_caja).toBe(1000)
    expect(m.catalogo().restaurante.cobro?.umbralDiferencia).toBe(1000)
  })

  it('avisa del cambio (sube la versión de la carta) y deja el autor', async () => {
    const m = mundo()
    const antes = m.catalogo().version
    await m.umbral(2_000)
    expect(m.catalogo().version).toBeGreaterThan(antes)
    expect(m.t.cambiosCatalogo).toEqual([m.catalogo().version])
    const fila = m.t.db
      .prepare('SELECT usuario_id, dispositivo_id FROM restaurante WHERE id = ?')
      .get(m.t.restauranteId)
    expect(fila).toEqual({
      usuario_id: m.t.personas.admin.usuarioId,
      dispositivo_id: m.admin.conexion.dispositivoId,
    })
  })

  it('el mismo valor no sube la versión ni avisa', async () => {
    const m = mundo()
    const v = m.catalogo().version
    await m.umbral(1000)
    expect(m.catalogo().version).toBe(v)
    expect(m.t.cambiosCatalogo).toEqual([])
  })

  it('no toca el resto de la configuración', async () => {
    const m = mundo()
    const antes = { ...m.guardada(), umbral_diferencia_caja: 0 }
    await m.umbral(0)
    expect(m.guardada()).toEqual(antes)
  })

  it.each([
    ['negativo', -1],
    ['sobre el tope', 1_000_001],
    ['con decimales', 500.5],
    ['texto', '1000'],
    ['null', null],
    ['NaN como texto', 'NaN'],
    ['arreglo', [1000]],
    ['ausente', undefined],
  ])('rechaza %s con 400 y no cambia nada', async (_, pesos) => {
    const m = mundo()
    const r = await m.umbral(pesos)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      error: 'datos_invalidos',
      mensaje: 'Escribe un valor entre 0 y 1.000.000',
    })
    expect(m.guardada().umbral_diferencia_caja).toBe(1000)
    expect(m.t.cambiosCatalogo).toEqual([])
  })

  it('con campos de más: 400', async () => {
    const m = mundo()
    const r = await m.llamar(m.admin, '/api/caja/umbral', { pesos: 500, otro: 1 })
    expect(r.statusCode).toBe(400)
    expect(m.guardada().umbral_diferencia_caja).toBe(1000)
  })

  it('sin token: 401; token inventado: 401; sin sesión: 400', async () => {
    const m = mundo()
    expect((await m.t.post('/api/caja/umbral', { pesos: 1 })).statusCode).toBe(401)
    expect(
      (await m.t.post('/api/caja/umbral', { ...m.admin.cuerpoSesion, pesos: 1 }, 'inventado'))
        .statusCode,
    ).toBe(401)
    expect((await m.t.post('/api/caja/umbral', { pesos: 1 }, m.admin.token)).statusCode).toBe(400)
  })

  it('sesión inventada o con otro secreto: 401', async () => {
    const m = mundo()
    for (const sesion of [
      { sesion_id: nuevoId(), secreto: 'inventado' },
      { sesion_id: m.admin.cuerpoSesion.sesion_id, secreto: 'otro' },
    ]) {
      const r = await m.t.post('/api/caja/umbral', { ...sesion, pesos: 1 }, m.admin.token)
      expect(r.statusCode).toBe(401)
    }
  })

  it('la sesión de otro equipo no sirve (401)', async () => {
    const m = mundo()
    const r = await m.t.post(
      '/api/caja/umbral',
      { ...m.admin.cuerpoSesion, pesos: 1 },
      m.mesero.token,
    )
    expect(r.statusCode).toBe(401)
  })

  it('el cajero y el mesero, que no administran dispositivos: 403 y no cambian nada', async () => {
    for (const quien of ['cajero', 'mesero'] as const) {
      const m = mundo()
      const r = await m.umbral(5_000, m[quien])
      expect(r.statusCode, quien).toBe(403)
      expect(m.guardada().umbral_diferencia_caja).toBe(1000)
      expect(m.t.cambiosCatalogo).toEqual([])
    }
  })

  it('una sesión cerrada: 401', async () => {
    const m = mundo()
    await m.t.post('/api/sesiones/cerrar', m.admin.cuerpoSesion, m.admin.token)
    expect((await m.umbral(5_000)).statusCode).toBe(401)
  })

  it('un equipo retirado pierde el acceso', async () => {
    const m = mundo()
    await m.t.post(
      `/api/dispositivos/${m.mesero.conexion.dispositivoId}/revocar`,
      m.admin.cuerpoSesion,
      m.admin.token,
    )
    expect((await m.umbral(5_000, m.mesero)).statusCode).toBe(401)
  })

  it('el umbral de un restaurante no cambia el de otro', async () => {
    const m = mundo()
    const otro = nuevoId()
    m.t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otro, otro, new Date(m.t.reloj()).toISOString(), new Date(m.t.reloj()).toISOString())
    m.t.db
      .prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)")
      .run(otro)
    await m.umbral(7_000)
    expect(leerCatalogo(m.t.db, otro).restaurante.cobro?.umbralDiferencia).toBe(1000)
    expect(m.catalogo().restaurante.cobro?.umbralDiferencia).toBe(7_000)
  })
})

describe('POST /api/caja/configuracion: el umbral', () => {
  it('lo trae junto con los medios, la propina y los datáfonos', async () => {
    const m = mundo()
    await m.umbral(3_000)
    const r = (await m.llamar(m.admin, '/api/caja/configuracion')).json() as Json
    expect(r).toMatchObject({ umbral_diferencia_caja: 3_000, propina_sugerida: 1000 })
    expect(Object.keys(r)).toEqual(
      expect.arrayContaining(['medios_pago', 'medios_propios', 'datafonos']),
    )
  })

  it('con una configuración vieja sin el campo, $1.000', async () => {
    const m = mundo()
    m.t.db.prepare("UPDATE restaurante SET config = '{}' WHERE id = ?").run(m.t.restauranteId)
    expect((await m.ajustes()).umbral_diferencia_caja).toBe(1000)
  })

  it('el cajero no la ve (403)', async () => {
    const m = mundo()
    expect((await m.llamar(m.cajero, '/api/caja/configuracion')).statusCode).toBe(403)
  })
})

describe('catálogo: cobro.umbralDiferencia, zonaHoraria e inicioDiaOperativo', () => {
  it('trae el umbral de la configuración guardada', () => {
    const m = mundo()
    m.t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify({ umbral_diferencia_caja: 250 }), m.t.restauranteId)
    expect(m.catalogo().restaurante.cobro?.umbralDiferencia).toBe(250)
  })

  it('un umbral de $0 llega como 0 (no se confunde con «sin umbral»)', () => {
    const m = mundo()
    m.t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify({ umbral_diferencia_caja: 0 }), m.t.restauranteId)
    expect(m.catalogo().restaurante.cobro?.umbralDiferencia).toBe(0)
  })

  it('una configuración vieja sin el campo trae $1.000', () => {
    const m = mundo()
    m.t.db.prepare("UPDATE restaurante SET config = '{}' WHERE id = ?").run(m.t.restauranteId)
    expect(m.catalogo().restaurante.cobro?.umbralDiferencia).toBe(1000)
  })

  it('trae la zona horaria de la sede y el inicio del día operativo de la configuración', () => {
    const m = mundo()
    expect(m.catalogo().restaurante.cobro).toMatchObject({
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
    })
    m.t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify({ inicio_dia_operativo: '04:30' }), m.t.restauranteId)
    expect(m.catalogo().restaurante.cobro?.inicioDiaOperativo).toBe('04:30')
  })

  it('la zona horaria sigue a la sede activa del restaurante', () => {
    const m = mundo()
    m.t.db
      .prepare('UPDATE sede SET zona_horaria = ? WHERE restaurante_id = ?')
      .run('America/Mexico_City', m.t.restauranteId)
    expect(m.catalogo().restaurante.cobro?.zonaHoraria).toBe('America/Mexico_City')
  })

  it('el restaurante sin sede cae en America/Bogota', () => {
    const m = mundo()
    const otro = nuevoId()
    m.t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Sin sede', '{}')`,
      )
      .run(otro, otro, new Date(m.t.reloj()).toISOString(), new Date(m.t.reloj()).toISOString())
    m.t.db
      .prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)")
      .run(otro)
    expect(leerCatalogo(m.t.db, otro).restaurante.cobro?.zonaHoraria).toBe('America/Bogota')
  })
})
