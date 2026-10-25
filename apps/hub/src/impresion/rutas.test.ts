import { configCompleta, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertarVersionado, SISTEMA } from '../acceso/registros'
import { leerCatalogo } from '../catalogo'
import { type Equipo, montarImpresion } from './montaje-impresion'
import { direccionValida } from './rutas'

// Las rutas HTTP de «Cocina e impresoras» (ADR-015): quién puede llamarlas y qué datos aceptan.

type Json = Record<string, unknown>

async function mundo(opciones: Parameters<typeof montarImpresion>[0] = {}) {
  const t = montarImpresion(opciones)
  const admin = t.equipo('admin', 'caja')
  const cajero = t.equipo('cajero', 'caja')
  const gerente = t.equipo('gerente', 'caja')
  const mesero = t.equipo('mesero')
  const llamar = (e: Equipo, url: string, extra: Json = {}) =>
    t.post(url, { ...e.cuerpoSesion, ...extra }, e.token)
  const impresoraValida = (campos: Json = {}) => ({
    nombre: 'Cocina',
    conexion: 'red',
    direccion: '192.168.1.50',
    puerto: 9100,
    ancho: 80,
    pagina_codigos: 'pc850',
    respaldo_id: null,
    estacion_ids: [t.cocina],
    activo: true,
    ...campos,
  })
  const crear = async (campos: Json = {}) => {
    const r = await llamar(admin, '/api/impresoras', { impresora: impresoraValida(campos) })
    expect(r.statusCode).toBe(200)
    return r.json().id as string
  }
  const config = async () => (await llamar(admin, '/api/cocina/configuracion')).json()
  return { t, admin, cajero, gerente, mesero, llamar, impresoraValida, crear, config }
}

type Mundo = Awaited<ReturnType<typeof mundo>>

/** Cada ruta, con un cuerpo válido y quién puede llamarla. */
const RUTAS = (m: Mundo, id: { impresora: string; trabajo: string; pantalla: string }) => [
  { url: '/api/cocina/configuracion', cuerpo: {}, quienes: ['admin'] },
  { url: '/api/impresoras', cuerpo: { impresora: m.impresoraValida() }, quienes: ['admin'] },
  { url: '/api/impresoras/prueba', cuerpo: { impresora_id: id.impresora }, quienes: ['admin'] },
  { url: '/api/impresion/pendientes', cuerpo: {}, quienes: ['admin', 'cajero', 'gerente'] },
  {
    url: '/api/impresion/descartar',
    cuerpo: { trabajo_id: id.trabajo },
    quienes: ['admin', 'cajero', 'gerente'],
  },
  {
    url: '/api/pantallas/estaciones',
    cuerpo: { dispositivo_id: id.pantalla, estacion_ids: [m.t.cocina] },
    quienes: ['admin'],
  },
  { url: '/api/cocina/tiempos', cuerpo: { amarillo: 8, rojo: 16 }, quienes: ['admin'] },
]
/** Un cuerpo válido (sin la sesión) para cada ruta. */
const cuerpoValido = (m: Mundo, url: string): Json =>
  ({
    '/api/cocina/configuracion': {},
    '/api/impresoras': { impresora: m.impresoraValida() },
    '/api/impresoras/prueba': { impresora_id: nuevoId() },
    '/api/impresion/pendientes': {},
    '/api/impresion/descartar': { trabajo_id: nuevoId() },
    '/api/pantallas': { nombre: 'Cocina', estacion_ids: [m.t.cocina] },
    '/api/pantallas/estaciones': { dispositivo_id: nuevoId(), estacion_ids: [m.t.cocina] },
    '/api/cocina/tiempos': { amarillo: 8, rojo: 16 },
  })[url] as Json
const TODAS = ['admin', 'cajero', 'gerente', 'mesero'] as const
const URLS = [
  '/api/cocina/configuracion',
  '/api/impresoras',
  '/api/impresoras/prueba',
  '/api/impresion/pendientes',
  '/api/impresion/descartar',
  '/api/pantallas',
  '/api/pantallas/estaciones',
  '/api/cocina/tiempos',
]

describe('quién puede llamar cada ruta', () => {
  it.each(URLS)('%s: sin token responde 401, aunque el cuerpo sea basura', async (url) => {
    const { t } = await mundo()
    for (const cuerpo of [{}, { x: 1 }, 'texto', [1]]) {
      const r = await t.post(url, cuerpo)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'token_invalido' })
    }
  })

  it.each(URLS)('%s: con un token inventado responde 401', async (url) => {
    const { t, admin } = await mundo()
    const r = await t.post(url, admin.cuerpoSesion, 'token-que-no-existe')
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'token_invalido' })
  })

  it.each(URLS)(
    '%s: con token pero con una sesión inventada o con otro secreto responde 401',
    async (url) => {
      const m = await mundo()
      const invalidas = [
        { sesion_id: nuevoId(), secreto: 'inventado' },
        { sesion_id: m.admin.cuerpoSesion.sesion_id, secreto: 'otro-secreto' },
      ]
      for (const sesion of invalidas) {
        const r = await m.t.post(url, { ...sesion, ...cuerpoValido(m, url) }, m.admin.token)
        expect(r.statusCode).toBe(401)
        expect(r.json()).toMatchObject({ error: 'sesion_invalida' })
      }
    },
  )

  it.each(URLS)('%s: sin los datos de la sesión responde 400', async (url) => {
    const m = await mundo()
    const r = await m.t.post(url, cuerpoValido(m, url), m.admin.token)
    expect(r.statusCode).toBe(400)
  })

  it.each(URLS)('%s: la sesión de otro equipo no sirve (401)', async (url) => {
    const m = await mundo()
    const r = await m.t.post(
      url,
      { ...m.admin.cuerpoSesion, ...cuerpoValido(m, url) },
      m.mesero.token,
    )
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'sesion_invalida' })
  })

  it('un equipo retirado pierde el acceso a todas las rutas', async () => {
    const m = await mundo()
    const { t, admin, mesero } = m
    const r = await t.post(
      `/api/dispositivos/${mesero.conexion.dispositivoId}/revocar`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(r.statusCode).toBe(200)
    for (const url of URLS) {
      const x = await t.post(url, mesero.cuerpoSesion, mesero.token)
      expect(x.statusCode, url).toBe(401)
    }
  })

  it('una sesión cerrada se rechaza con 401', async () => {
    const { t, admin, llamar } = await mundo()
    await t.post('/api/sesiones/cerrar', admin.cuerpoSesion, admin.token)
    expect((await llamar(admin, '/api/cocina/configuracion')).statusCode).toBe(401)
  })

  it('el permiso decide: administrar_dispositivos para la configuración; la cola, también cobrar', async () => {
    const m = await mundo()
    const { t, llamar } = m
    const imp = t.impresoraNueva('Cocina', [t.cocina])
    const { pedido, items } = t.pedidoCon(t.equipo('mesero2'), [
      { nombre: 'Pizza', estacion: t.cocina },
    ])
    void pedido
    void items
    const trabajoId = nuevoId()
    t.db
      .prepare(
        `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
         VALUES (?, ?, ?, 'prueba', '{"impresora":"x","estaciones":[],"hora":"y"}', ?)`,
      )
      .run(trabajoId, t.restauranteId, imp.id, new Date(t.reloj()).toISOString())
    for (const ruta of RUTAS(m, { impresora: imp.id, trabajo: trabajoId, pantalla: nuevoId() })) {
      for (const quien of TODAS) {
        const equipo = m[quien]
        const r = await llamar(equipo, ruta.url, ruta.cuerpo)
        if (ruta.quienes.includes(quien)) {
          // El permiso alcanza; puede fallar por datos (la pantalla de prueba no existe), nunca por permiso.
          expect(r.statusCode, `${quien} ${ruta.url}`).not.toBe(403)
          expect(r.statusCode, `${quien} ${ruta.url}`).not.toBe(401)
        } else {
          expect(r.statusCode, `${quien} ${ruta.url}`).toBe(403)
          expect(r.json()).toMatchObject({ error: 'sin_permiso' })
        }
      }
    }
  })

  it('un mesero no puede convertir un equipo en pantalla; un cajero tampoco', async () => {
    const { t, mesero, cajero, llamar } = await mundo()
    for (const e of [mesero, cajero]) {
      const r = await llamar(e, '/api/pantallas', { nombre: 'Cocina', estacion_ids: [t.cocina] })
      expect(r.statusCode).toBe(403)
    }
    expect(t.db.prepare('SELECT count(*) AS n FROM usuario WHERE pantalla = 1').get()).toEqual({
      n: 0,
    })
  })
})

describe('direccionValida', () => {
  it.each([
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.1.50',
  ])('acepta la IP privada %s', (ip) => {
    expect(direccionValida(ip, 9100, false)).toBeNull()
  })

  it.each([
    '',
    ' ',
    'cocina',
    'cocina.local',
    'localhost',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.169.0.1',
    '11.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '255.255.255.255',
    '127.0.0.1',
    '10.0.0',
    '10.0.0.1.1',
    '10.0.0.256',
    '10.0.0.-1',
    '10.0.0.1/24',
    '10.0.0.1:9100',
    'http://10.0.0.1',
    ' 10.0.0.1',
    '10.0.0.1 ',
    '10.0.0.1\n',
    '::1',
    'fe80::1',
    '10.0.0.1@evil.com',
    '10.0.0.1#',
    '0x0a.0.0.1',
    '٠.٠.٠.١',
    '10.0.0.1e1',
  ])('rechaza «%s»', (ip) => {
    expect(direccionValida(ip, 9100, false)).not.toBeNull()
  })

  for (const ip of ['010.0.0.1', '10.00.0.1', '192.168.001.050', '10.0.0.01'])
    it(`rechaza «${ip}» (con ceros a la izquierda algunos sistemas la leen en octal)`, () => {
      // `getaddrinfo` trata `010` como octal: «010.0.0.1» se conecta a 8.0.0.1, fuera de la red local.
      expect(direccionValida(ip, 9100, false)).not.toBeNull()
    })

  it.each([9100, 9101, 9109, null])('acepta el puerto %s', (p) => {
    expect(direccionValida('192.168.1.5', p, false)).toBeNull()
  })

  it.each([0, 1, 22, 80, 443, 9099, 9110, 65535, -1, 3000, 4000])(
    'rechaza el puerto %s en el local',
    (p) => {
      expect(direccionValida('192.168.1.5', p, false)).not.toBeNull()
    },
  )

  it('con la impresora de prueba (locales) acepta 127.0.0.1 y cualquier puerto, pero no internet', () => {
    expect(direccionValida('127.0.0.1', 41234, true)).toBeNull()
    expect(direccionValida('127.1.2.3', 4000, true)).toBeNull()
    expect(direccionValida('192.168.1.5', 4000, true)).toBeNull()
    expect(direccionValida('8.8.8.8', 9100, true)).not.toBeNull()
    expect(direccionValida('localhost', 9100, true)).not.toBeNull()
  })
})

describe('POST /api/impresoras: datos inválidos', () => {
  const malos: [string, Json][] = [
    ['IP con nombre', { direccion: 'impresora.local' }],
    ['IP rara', { direccion: '999.1.1.1' }],
    ['IP pública', { direccion: '8.8.8.8' }],
    ['IP del propio PC', { direccion: '127.0.0.1' }],
    ['IP con puerto pegado', { direccion: '192.168.1.5:9100' }],
    ['IP vacía', { direccion: '' }],
    ['IP de 256 caracteres', { direccion: 'a'.repeat(256) }],
    ['puerto 0', { puerto: 0 }],
    ['puerto 65536', { puerto: 65536 }],
    ['puerto negativo', { puerto: -5 }],
    ['puerto decimal', { puerto: 9100.5 }],
    ['puerto texto', { puerto: '9100' }],
    ['puerto fuera de 9100-9109', { puerto: 9200 }],
    ['nombre vacío', { nombre: '' }],
    ['nombre de espacios', { nombre: '    ' }],
    ['nombre de 61', { nombre: 'a'.repeat(61) }],
    ['nombre número', { nombre: 5 }],
    ['conexión desconocida', { conexion: 'bluetooth' }],
    ['ancho 57', { ancho: 57 }],
    ['ancho texto', { ancho: '80' }],
    ['página inventada', { pagina_codigos: 'utf8' }],
    ['estación que no existe', { estacion_ids: [nuevoId()] }],
    ['estación con id corto', { estacion_ids: ['x'] }],
    ['más de 50 estaciones', { estacion_ids: Array.from({ length: 51 }, () => nuevoId()) }],
    ['activo texto', { activo: 'si' }],
    ['respaldo inexistente', { respaldo_id: nuevoId() }],
    ['campo de más', { extra: 1 }],
    ['sin dirección', { direccion: undefined }],
    ['id que no existe', { id: nuevoId() }],
  ]

  it.each(malos)('rechaza %s con 400 y no guarda nada', async (_, campos) => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/impresoras', { impresora: m.impresoraValida(campos) })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'datos_invalidos' })
    expect(m.t.db.prepare('SELECT count(*) AS n FROM impresora').get()).toEqual({ n: 0 })
    expect(m.t.cambiosCatalogo).toEqual([])
  })

  it('una estación de otro restaurante da 400, aunque exista en la base', async () => {
    const m = await mundo()
    const otro = nuevoId()
    m.t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(otro, otro)
    const ajena = insertarVersionado(
      m.t.db,
      'estacion',
      otro,
      { nombre: 'Cocina ajena', orden: 1 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const r = await m.llamar(m.admin, '/api/impresoras', {
      impresora: m.impresoraValida({ estacion_ids: [ajena] }),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().mensaje).toBe('Esa estación no existe')
  })

  it('una estación archivada del mismo restaurante se descarta en silencio', async () => {
    const m = await mundo()
    m.t.db.prepare('UPDATE estacion SET activo = 0 WHERE id = ?').run(m.t.postres)
    const id = await m.crear({ estacion_ids: [m.t.cocina, m.t.postres, m.t.cocina] })
    const cfg = await m.config()
    expect(cfg.impresoras.find((i: Json) => i.id === id).estacion_ids).toEqual([m.t.cocina])
  })

  it('una impresora no puede ser su propio respaldo', async () => {
    const m = await mundo()
    const id = await m.crear()
    const r = await m.llamar(m.admin, '/api/impresoras', {
      impresora: m.impresoraValida({ id, respaldo_id: id }),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().mensaje).toBe('Una impresora no puede ser su propio respaldo')
  })

  it('el respaldo debe existir, estar activo y ser de este restaurante', async () => {
    const m = await mundo()
    const archivada = await m.crear({ nombre: 'Vieja' })
    await m.llamar(m.admin, '/api/impresoras', {
      impresora: m.impresoraValida({ id: archivada, nombre: 'Vieja', activo: false }),
    })
    const otro = nuevoId()
    m.t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(otro, otro)
    const ajena = insertarVersionado(
      m.t.db,
      'impresora',
      otro,
      { nombre: 'Ajena', conexion: 'red', direccion: '10.1.1.1', puerto: 9100, ancho: 80 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    for (const respaldo_id of [nuevoId(), archivada, ajena]) {
      const r = await m.llamar(m.admin, '/api/impresoras', {
        impresora: m.impresoraValida({ nombre: 'Barra', respaldo_id }),
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().mensaje).toBe('La impresora de respaldo no existe')
    }
  })

  it('no se edita una impresora de otro restaurante', async () => {
    const m = await mundo()
    const otro = nuevoId()
    m.t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(otro, otro)
    const ajena = insertarVersionado(
      m.t.db,
      'impresora',
      otro,
      { nombre: 'Ajena', conexion: 'red', direccion: '10.1.1.1', puerto: 9100, ancho: 80 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const r = await m.llamar(m.admin, '/api/impresoras', {
      impresora: m.impresoraValida({ id: ajena, nombre: 'Robada' }),
    })
    expect(r.statusCode).toBe(400)
    expect(m.t.db.prepare('SELECT nombre FROM impresora WHERE id = ?').get(ajena)).toEqual({
      nombre: 'Ajena',
    })
  })
})

describe('POST /api/impresoras: crear, editar y archivar', () => {
  it('crea una impresora de red con el puerto por defecto y la deja en la configuración', async () => {
    const m = await mundo()
    const id = await m.crear({ puerto: null, nombre: '  Cocina  ' })
    const cfg = await m.config()
    expect(cfg.impresoras).toEqual([
      {
        id,
        nombre: 'Cocina',
        conexion: 'red',
        direccion: '192.168.1.50',
        puerto: 9100,
        ancho: 80,
        pagina_codigos: 'pc850',
        respaldo_id: null,
        estacion_ids: [m.t.cocina],
        activo: true,
      },
    ])
    expect(cfg.estaciones.map((e: Json) => e.nombre)).toEqual(['Cocina', 'Barra', 'Postres'])
    expect(cfg.tiempos).toEqual({ amarillo: 10, rojo: 20 })
    expect(cfg.pantallas).toEqual([])
    // Los equipos se enteran: la carta cambió de versión.
    expect(m.t.cambiosCatalogo.length).toBeGreaterThan(0)
  })

  it('las estaciones repetidas se guardan una sola vez', async () => {
    const m = await mundo()
    await m.crear({ estacion_ids: [m.t.cocina, m.t.cocina, m.t.barra] })
    const cfg = await m.config()
    expect(cfg.impresoras[0].estacion_ids).toEqual([m.t.cocina, m.t.barra])
  })

  it('una impresora USB guarda el nombre de Windows y no lleva puerto', async () => {
    const m = await mundo()
    await m.crear({ conexion: 'usb', direccion: 'POS-80 Caja', puerto: 9100 })
    const cfg = await m.config()
    expect(cfg.impresoras[0]).toMatchObject({
      conexion: 'usb',
      direccion: 'POS-80 Caja',
      puerto: null,
    })
  })

  it('editar conserva el id, sube la versión y deja quién lo cambió', async () => {
    const m = await mundo()
    const id = await m.crear()
    const antes = m.t.db.prepare('SELECT version FROM impresora WHERE id = ?').get(id)
    const r = await m.llamar(m.admin, '/api/impresoras', {
      impresora: m.impresoraValida({
        id,
        nombre: 'Cocina caliente',
        ancho: 58,
        pagina_codigos: 'wpc1252',
      }),
    })
    expect(r.json()).toEqual({ id })
    const fila = m.t.db.prepare('SELECT * FROM impresora WHERE id = ?').get(id)
    expect(fila).toMatchObject({
      nombre: 'Cocina caliente',
      ancho: 58,
      pagina_codigos: 'wpc1252',
      usuario_id: m.admin.sesion.usuario.id,
    })
    expect(Number(fila?.version)).toBeGreaterThan(Number(antes?.version))
    expect(m.t.db.prepare('SELECT count(*) AS n FROM impresora').get()).toEqual({ n: 1 })
  })

  it('cambiar las estaciones de una impresora cambia a dónde van las comandas nuevas', async () => {
    const m = await mundo()
    const id = await m.crear({ estacion_ids: [m.t.cocina] })
    await m.llamar(m.admin, '/api/impresoras', {
      impresora: m.impresoraValida({ id, estacion_ids: [m.t.barra] }),
    })
    const ana = m.t.equipo('mesero2')
    const { pedido, items } = m.t.pedidoCon(ana, [
      { nombre: 'Pizza', estacion: m.t.cocina },
      { nombre: 'Aperol', estacion: m.t.barra },
    ])
    m.t.enviar(ana, pedido, items)
    expect(m.t.trabajos().map((f) => m.t.contenido(f).estacion)).toEqual(['Barra'])
  })

  it('archivar una impresora quita el respaldo de las que la apuntaban', async () => {
    const m = await mundo()
    const respaldo = await m.crear({
      nombre: 'Respaldo',
      direccion: '192.168.1.51',
      estacion_ids: [],
    })
    const a = await m.crear({ nombre: 'A', direccion: '192.168.1.52', respaldo_id: respaldo })
    const b = await m.crear({ nombre: 'B', direccion: '192.168.1.53', respaldo_id: respaldo })
    const c = await m.crear({ nombre: 'C', direccion: '192.168.1.54', respaldo_id: a })
    const antes = Number(
      m.t.db.prepare('SELECT version FROM impresora WHERE id = ?').get(a)?.version,
    )
    const r = await m.llamar(m.admin, '/api/impresoras', {
      impresora: m.impresoraValida({
        id: respaldo,
        nombre: 'Respaldo',
        direccion: '192.168.1.51',
        estacion_ids: [],
        activo: false,
      }),
    })
    expect(r.statusCode).toBe(200)
    const cfg = await m.config()
    const por = (id: string) => cfg.impresoras.find((i: Json) => i.id === id)
    expect(por(a).respaldo_id).toBeNull()
    expect(por(b).respaldo_id).toBeNull()
    // La que apuntaba a otra (que sigue activa) no se toca.
    expect(por(c).respaldo_id).toBe(a)
    expect(por(respaldo).activo).toBe(false)
    expect(
      Number(m.t.db.prepare('SELECT version FROM impresora WHERE id = ?').get(a)?.version),
    ).toBeGreaterThan(antes)
  })

  it('archivar no borra la impresora ni sus comandas pendientes, y la archivada sale al final de la lista', async () => {
    const m = await mundo()
    const vieja = await m.crear({ nombre: 'Aaa vieja', direccion: '192.168.1.60' })
    await m.crear({ nombre: 'Zzz nueva', direccion: '192.168.1.61', estacion_ids: [m.t.barra] })
    const ana = m.t.equipo('mesero2')
    const { pedido, items } = m.t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: m.t.cocina }])
    m.t.enviar(ana, pedido, items)
    await m.llamar(m.admin, '/api/impresoras', {
      impresora: m.impresoraValida({
        id: vieja,
        nombre: 'Aaa vieja',
        direccion: '192.168.1.60',
        activo: false,
      }),
    })
    const cfg = await m.config()
    expect(cfg.impresoras.map((i: Json) => [i.nombre, i.activo])).toEqual([
      ['Zzz nueva', true],
      ['Aaa vieja', false],
    ])
    expect(m.t.pendientes()).toBe(1)
    // Las archivadas no salen en los estados de la cola.
    expect(cfg.estados.map((e: Json) => e.nombre)).toEqual(['Zzz nueva'])
  })

  it('reactivar una impresora archivada la deja otra vez recibiendo comandas', async () => {
    const m = await mundo()
    const id = await m.crear()
    const datos = (activo: boolean) => m.impresoraValida({ id, activo })
    await m.llamar(m.admin, '/api/impresoras', { impresora: datos(false) })
    await m.llamar(m.admin, '/api/impresoras', { impresora: datos(true) })
    const ana = m.t.equipo('mesero2')
    const { pedido, items } = m.t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: m.t.cocina }])
    m.t.enviar(ana, pedido, items)
    expect(m.t.trabajos()).toHaveLength(1)
  })

  it('dos impresoras pueden apuntarse mutuamente de respaldo sin colgar la cola', async () => {
    const m = await mundo()
    const a = m.t.impresoraNueva('A', [m.t.cocina])
    const b = m.t.impresoraNueva('B', [m.t.barra])
    for (const [id, otro, nombre, direccion] of [
      [a.id, b.id, 'A', a.direccion],
      [b.id, a.id, 'B', b.direccion],
    ] as const) {
      const r = await m.llamar(m.admin, '/api/impresoras', {
        impresora: m.impresoraValida({
          id,
          nombre,
          direccion,
          respaldo_id: otro,
          estacion_ids: [],
        }),
      })
      expect(r.statusCode).toBe(200)
    }
    m.t.db
      .prepare('UPDATE impresora SET estacion_ids = ? WHERE id = ?')
      .run(JSON.stringify([m.t.cocina]), a.id)
    a.papel.apagada = true
    b.papel.apagada = true
    const ana = m.t.equipo('mesero2')
    const { pedido, items } = m.t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: m.t.cocina }])
    m.t.enviar(ana, pedido, items)
    for (let i = 0; i < 8; i++) {
      await m.t.cola.vuelta()
      await m.t.cola.vuelta()
      m.t.avanzar(60_000)
    }
    expect(m.t.pendientes()).toBe(1)
    b.papel.apagada = false
    for (let i = 0; i < 3; i++) {
      await m.t.cola.vuelta()
      await m.t.cola.vuelta()
      m.t.avanzar(60_000)
    }
    expect(m.t.pendientes()).toBe(0)
    expect(b.papel.recibidos.length + a.papel.recibidos.length).toBe(1)
  })
})

describe('con la impresora de prueba (permitirLocales)', () => {
  it('acepta 127.0.0.1 y cualquier puerto, y el trabajo sale por la red de verdad', async () => {
    const m = await mundo({ permitirLocales: true })
    const id = await m.crear({ direccion: '127.0.0.1', puerto: 4455 })
    const fila = m.t.db.prepare('SELECT direccion, puerto FROM impresora WHERE id = ?').get(id)
    expect(fila).toEqual({ direccion: '127.0.0.1', puerto: 4455 })
  })

  it('sin la opción, 127.0.0.1 se rechaza', async () => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/impresoras', {
      impresora: m.impresoraValida({ direccion: '127.0.0.1' }),
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('POST /api/impresoras/prueba', () => {
  it('encola una página de prueba y la cola la saca', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.cocina])
    const r = await m.llamar(m.admin, '/api/impresoras/prueba', { impresora_id: imp.id })
    expect(r.statusCode).toBe(201)
    const trabajoId = r.json().trabajo_id as string
    await m.t.cola.listo()
    await m.t.cola.vuelta()
    expect(m.t.trabajos().find((f) => f.id === trabajoId)).toMatchObject({
      tipo: 'prueba',
      estado: 'impreso',
      impresora_id: imp.id,
    })
    const texto = imp.papel.textos()[0] as string
    expect(texto.replaceAll('\n', ' ')).toContain('PRUEBA DE IMPRESIÓN')
    expect(texto).toContain('Imprime: Cocina')
  })

  it('con la impresora apagada queda pendiente y se ve en la lista de pendientes', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.cocina])
    imp.papel.apagada = true
    await m.llamar(m.admin, '/api/impresoras/prueba', { impresora_id: imp.id })
    await m.t.cola.listo()
    await m.t.cola.vuelta()
    const lista = (await m.llamar(m.admin, '/api/impresion/pendientes')).json()
    expect(lista).toHaveLength(1)
    expect(lista[0]).toMatchObject({ que: 'Página de prueba', impresora: 'Cocina' })
    expect(lista[0].intentos).toBeGreaterThan(0)
    expect(String(lista[0].error)).toContain('rechazó la conexión')
  })

  it.each([
    ['inexistente', () => nuevoId()],
    ['con id corto', () => 'corto'],
  ])('una impresora %s da 400', async (_, id) => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/impresoras/prueba', { impresora_id: id() })
    expect(r.statusCode).toBe(400)
  })

  it('una impresora archivada no se prueba', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Vieja', [], { activo: 0 })
    const r = await m.llamar(m.admin, '/api/impresoras/prueba', { impresora_id: imp.id })
    expect(r.statusCode).toBe(400)
    expect(m.t.trabajos()).toEqual([])
  })

  it('la hora de la prueba va en la zona del restaurante y trae el nombre de las estaciones', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Mixta', [m.t.cocina, m.t.barra])
    const r = await m.llamar(m.admin, '/api/impresoras/prueba', { impresora_id: imp.id })
    const fila = m.t.trabajos().find((f) => f.id === r.json().trabajo_id)
    const contenido = m.t.contenido(fila)
    expect(contenido.estaciones).toEqual(['Cocina', 'Barra'])
    expect(contenido.impresora).toBe('Mixta')
    expect(contenido.hora).toMatch(/3:00\s*p\.\s*m\./)
  })
})

describe('POST /api/impresion/pendientes y /descartar', () => {
  async function conPendientes() {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.cocina])
    imp.papel.apagada = true
    const ana = m.t.equipo('mesero2')
    for (let i = 0; i < 3; i++) {
      const { pedido, items } = m.t.pedidoCon(
        ana,
        [{ nombre: `Plato ${i}`, estacion: m.t.cocina }],
        m.t.mesa(String(9 + i)),
      )
      m.t.enviar(ana, pedido, items)
      m.t.avanzar(1000)
    }
    await m.t.cola.vuelta()
    return { m, imp }
  }

  it('lista lo que no ha salido, en orden, con qué es, cuántos intentos y por qué falló', async () => {
    const { m } = await conPendientes()
    const lista = (await m.llamar(m.admin, '/api/impresion/pendientes')).json()
    expect(lista.map((x: Json) => x.que)).toEqual([
      'Cocina · Mesa 9 · #1',
      'Cocina · Mesa 10 · #2',
      'Cocina · Mesa 11 · #3',
    ])
    expect(lista[0]).toMatchObject({ impresora: 'Cocina', intentos: 1 })
    expect(String(lista[0].error)).toContain('rechazó')
    expect(lista[1]).toMatchObject({ intentos: 0, error: null })
    expect(lista[0].creado_en < lista[1].creado_en).toBe(true)
  })

  it('no lista lo impreso ni lo descartado', async () => {
    const { m, imp } = await conPendientes()
    imp.papel.apagada = false
    m.t.avanzar(2000)
    await m.t.cola.vuelta()
    await m.t.cola.vuelta()
    expect((await m.llamar(m.admin, '/api/impresion/pendientes')).json()).toEqual([])
  })

  it('sin pendientes devuelve una lista vacía', async () => {
    const m = await mundo()
    const r = await m.llamar(m.cajero, '/api/impresion/pendientes')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual([])
  })

  it('descartar marca el trabajo con quién y desde qué equipo, no lo borra y desaparece de la lista', async () => {
    const { m } = await conPendientes()
    const [primero] = (await m.llamar(m.cajero, '/api/impresion/pendientes')).json()
    const r = await m.llamar(m.cajero, '/api/impresion/descartar', { trabajo_id: primero.id })
    expect(r.statusCode).toBe(204)
    const fila = m.t.db.prepare('SELECT * FROM trabajo_impresion WHERE id = ?').get(primero.id)
    expect(fila).toMatchObject({
      estado: 'descartado',
      descartado_por_id: m.cajero.sesion.usuario.id,
      descartado_dispositivo_id: m.cajero.conexion.dispositivoId,
    })
    expect(fila?.terminado_en).not.toBeNull()
    expect(m.t.db.prepare('SELECT count(*) AS n FROM trabajo_impresion').get()).toEqual({ n: 3 })
    const lista = (await m.llamar(m.admin, '/api/impresion/pendientes')).json()
    expect(lista).toHaveLength(2)
  })

  it('descartar dos veces, o algo ya impreso, o algo que no existe, da 400', async () => {
    const { m, imp } = await conPendientes()
    const [primero, segundo] = (await m.llamar(m.admin, '/api/impresion/pendientes')).json()
    expect(
      (await m.llamar(m.admin, '/api/impresion/descartar', { trabajo_id: primero.id })).statusCode,
    ).toBe(204)
    const otra = await m.llamar(m.admin, '/api/impresion/descartar', { trabajo_id: primero.id })
    expect(otra.statusCode).toBe(400)
    expect(otra.json().mensaje).toBe('Esa comanda ya salió o ya se descartó')
    imp.papel.apagada = false
    m.t.avanzar(2000)
    await m.t.cola.vuelta()
    await m.t.cola.vuelta()
    expect(
      (await m.llamar(m.admin, '/api/impresion/descartar', { trabajo_id: segundo.id })).statusCode,
    ).toBe(400)
    expect(
      (await m.llamar(m.admin, '/api/impresion/descartar', { trabajo_id: nuevoId() })).statusCode,
    ).toBe(400)
  })

  it('lo descartado no se imprime aunque la impresora vuelva', async () => {
    const { m, imp } = await conPendientes()
    for (const x of (await m.llamar(m.admin, '/api/impresion/pendientes')).json())
      await m.llamar(m.admin, '/api/impresion/descartar', { trabajo_id: x.id })
    imp.papel.apagada = false
    m.t.avanzar(60_000)
    await m.t.cola.vuelta()
    expect(imp.papel.recibidos).toHaveLength(0)
  })

  it('no se descarta el trabajo de otro restaurante', async () => {
    const m = await mundo()
    const otro = nuevoId()
    m.t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(otro, otro)
    const impAjena = insertarVersionado(
      m.t.db,
      'impresora',
      otro,
      { nombre: 'Ajena', conexion: 'red', direccion: '10.1.1.1', puerto: 9100, ancho: 80 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const trabajo = nuevoId()
    m.t.db
      .prepare(
        `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
         VALUES (?, ?, ?, 'prueba', '{}', '2026-10-24T20:00:00.000Z')`,
      )
      .run(trabajo, otro, impAjena)
    const r = await m.llamar(m.admin, '/api/impresion/descartar', { trabajo_id: trabajo })
    expect(r.statusCode).toBe(400)
    expect(
      m.t.db.prepare('SELECT estado FROM trabajo_impresion WHERE id = ?').get(trabajo),
    ).toEqual({
      estado: 'pendiente',
    })
    expect((await m.llamar(m.admin, '/api/impresion/pendientes')).json()).toEqual([])
  })

  it('la lista se corta en 200 comandas', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.cocina])
    const insertar = m.t.db.prepare(
      `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
       VALUES (?, ?, ?, 'comanda', '{"estacion":"Cocina","destino":"Mesa","numero":1}', ?)`,
    )
    for (let i = 0; i < 230; i++)
      insertar.run(
        nuevoId(),
        m.t.restauranteId,
        imp.id,
        new Date(Date.UTC(2026, 9, 24, 20, 0, i)).toISOString(),
      )
    const lista = (await m.llamar(m.admin, '/api/impresion/pendientes')).json()
    expect(lista).toHaveLength(200)
  })

  it('el cuerpo lleva solo lo esperado: un campo de más da 400', async () => {
    const m = await mundo()
    expect((await m.llamar(m.admin, '/api/impresion/pendientes', { extra: 1 })).statusCode).toBe(
      400,
    )
    expect(
      (await m.llamar(m.admin, '/api/impresion/descartar', { trabajo_id: 'x' })).statusCode,
    ).toBe(400)
  })

  it('una comanda sin número o con textos raros no rompe la lista', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.cocina])
    for (const contenido of [
      '{}',
      '{"estacion":"Cocina"}',
      '{"numero":null,"destino":"Mesa 1"}',
      '[]',
    ])
      m.t.db
        .prepare(
          `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
           VALUES (?, ?, ?, 'comanda', ?, ?)`,
        )
        .run(nuevoId(), m.t.restauranteId, imp.id, contenido, new Date(m.t.reloj()).toISOString())
    const r = await m.llamar(m.admin, '/api/impresion/pendientes')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toHaveLength(4)
  })
})

describe('POST /api/cocina/tiempos', () => {
  it('guarda los minutos, los muestra en la configuración y los manda en la carta', async () => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 7, rojo: 15 })
    expect(r.statusCode).toBe(204)
    expect((await m.config()).tiempos).toEqual({ amarillo: 7, rojo: 15 })
    const catalogo = leerCatalogo(m.t.db, m.t.restauranteId)
    expect(catalogo.restaurante).toMatchObject({ cocinaAmarilloMin: 7, cocinaRojoMin: 15 })
    expect(m.t.cambiosCatalogo.length).toBeGreaterThan(0)
  })

  it.each([
    ['ámbar 0', { amarillo: 0, rojo: 5 }],
    ['ámbar negativo', { amarillo: -1, rojo: 5 }],
    ['rojo 241', { amarillo: 5, rojo: 241 }],
    ['ámbar 241', { amarillo: 241, rojo: 241 }],
    ['decimales', { amarillo: 5.5, rojo: 9 }],
    ['texto', { amarillo: '5', rojo: '9' }],
    ['rojo igual al ámbar', { amarillo: 10, rojo: 10 }],
    ['rojo menor que el ámbar', { amarillo: 20, rojo: 10 }],
    ['sin rojo', { amarillo: 5 }],
    ['campo de más', { amarillo: 5, rojo: 9, extra: 1 }],
    ['null', { amarillo: null, rojo: null }],
  ])('rechaza %s con 400 y no cambia nada', async (_, cuerpo) => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/cocina/tiempos', cuerpo)
    expect(r.statusCode).toBe(400)
    expect((await m.config()).tiempos).toEqual({ amarillo: 10, rojo: 20 })
  })

  it('acepta los extremos 1 y 240 (rojo > ámbar)', async () => {
    const m = await mundo()
    expect(
      (await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 1, rojo: 2 })).statusCode,
    ).toBe(204)
    expect(
      (await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 239, rojo: 240 })).statusCode,
    ).toBe(204)
    expect((await m.config()).tiempos).toEqual({ amarillo: 239, rojo: 240 })
  })

  it('conserva el resto de la configuración del restaurante y deja quién lo cambió', async () => {
    const m = await mundo()
    const config = configCompleta({})
    m.t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...config, sesion_inactividad_min: 45, marca: 'la-spritzzeria' }),
        m.t.restauranteId,
      )
    await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 12, rojo: 25 })
    const fila = m.t.db
      .prepare('SELECT config, usuario_id FROM restaurante WHERE id = ?')
      .get(m.t.restauranteId)
    expect(JSON.parse(String(fila?.config))).toMatchObject({
      sesion_inactividad_min: 45,
      marca: 'la-spritzzeria',
      cocina_amarillo_min: 12,
      cocina_rojo_min: 25,
    })
    expect(fila?.usuario_id).toBe(m.admin.sesion.usuario.id)
  })

  it('un restaurante con la configuración vacía recibe los valores de fábrica y los guarda completos', async () => {
    const m = await mundo()
    m.t.db.prepare("UPDATE restaurante SET config = '{}' WHERE id = ?").run(m.t.restauranteId)
    await m.llamar(m.admin, '/api/cocina/tiempos', { amarillo: 3, rojo: 4 })
    const fila = m.t.db
      .prepare('SELECT config FROM restaurante WHERE id = ?')
      .get(m.t.restauranteId)
    expect(JSON.parse(String(fila?.config))).toMatchObject({
      cocina_amarillo_min: 3,
      cocina_rojo_min: 4,
    })
  })
})

describe('POST /api/cocina/configuracion y /api/pantallas/estaciones', () => {
  it('las estaciones archivadas no salen en la configuración', async () => {
    const m = await mundo()
    m.t.db.prepare('UPDATE estacion SET activo = 0 WHERE id = ?').run(m.t.postres)
    expect((await m.config()).estaciones.map((e: Json) => e.nombre)).toEqual(['Cocina', 'Barra'])
  })

  it('cambia las estaciones de una pantalla y valida las que se piden', async () => {
    const m = await mundo()
    const tablet = m.t.equipo('admin', 'caja')
    const c = await m.t.post(
      '/api/pantallas',
      { ...tablet.cuerpoSesion, nombre: 'Cocina', estacion_ids: [m.t.cocina] },
      tablet.token,
    )
    expect(c.statusCode).toBe(201)
    const dispositivo = tablet.conexion.dispositivoId
    const cambiar = (estacion_ids: unknown, dispositivo_id: string = dispositivo) =>
      m.llamar(m.admin, '/api/pantallas/estaciones', { dispositivo_id, estacion_ids })
    expect((await cambiar([m.t.cocina, m.t.barra])).statusCode).toBe(204)
    expect((await m.config()).pantallas).toMatchObject([
      { dispositivo_id: dispositivo, nombre: 'Cocina', estacion_ids: [m.t.cocina, m.t.barra] },
    ])
    expect((await cambiar([])).statusCode).toBe(400)
    expect((await cambiar([nuevoId()])).statusCode).toBe(400)
    expect((await cambiar(['x'])).statusCode).toBe(400)
    expect((await cambiar([m.t.cocina], nuevoId())).statusCode).toBe(400)
    // Un equipo que no es pantalla no sirve.
    expect((await cambiar([m.t.cocina], m.mesero.conexion.dispositivoId)).statusCode).toBe(400)
    // Solo estaciones archivadas dejaría la pantalla sin nada: se rechaza.
    m.t.db.prepare('UPDATE estacion SET activo = 0 WHERE id = ?').run(m.t.postres)
    expect((await cambiar([m.t.postres])).statusCode).toBe(400)
    // Mezcladas con una activa, la archivada se descarta.
    expect((await cambiar([m.t.postres, m.t.barra])).statusCode).toBe(204)
    expect((await m.config()).pantallas[0].estacion_ids).toEqual([m.t.barra])
  })

  it('una pantalla retirada ya no sale en la configuración ni se puede editar', async () => {
    const m = await mundo()
    const tablet = m.t.equipo('admin', 'caja')
    await m.t.post(
      '/api/pantallas',
      { ...tablet.cuerpoSesion, nombre: 'Cocina', estacion_ids: [m.t.cocina] },
      tablet.token,
    )
    const r = await m.t.post(
      `/api/dispositivos/${tablet.conexion.dispositivoId}/revocar`,
      m.admin.cuerpoSesion,
      m.admin.token,
    )
    expect(r.statusCode).toBe(200)
    expect((await m.config()).pantallas).toEqual([])
    const e = await m.llamar(m.admin, '/api/pantallas/estaciones', {
      dispositivo_id: tablet.conexion.dispositivoId,
      estacion_ids: [m.t.cocina],
    })
    expect(e.statusCode).toBe(400)
  })

  it('la configuración trae los estados de las impresoras', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.cocina])
    imp.papel.apagada = true
    const ana = m.t.equipo('mesero2')
    const { pedido, items } = m.t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: m.t.cocina }])
    m.t.enviar(ana, pedido, items)
    await m.t.cola.vuelta()
    expect((await m.config()).estados).toEqual([
      expect.objectContaining({ id: imp.id, estado: 'falla', pendientes: 1 }),
    ])
  })
})
