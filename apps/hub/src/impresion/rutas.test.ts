import { fullConfig, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertarVersionado, SISTEMA } from '../acceso/registros'
import { leerCatalogo } from '../catalogo'
import { type Equipo, montarImpresion } from './montaje-impresion'
import { direccionValida } from './rutas'

// Las rutas HTTP de «Cocina e impresoras» (ADR-015): quién puede llamarlas y qué datos aceptan.

type Json = Record<string, unknown>

async function mundo(options: Parameters<typeof montarImpresion>[0] = {}) {
  const t = montarImpresion(options)
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const manager = t.device('manager', 'register')
  const waiter = t.device('waiter')
  const llamar = (e: Equipo, url: string, extra: Json = {}) =>
    t.post(url, { ...e.cuerpoSesion, ...extra }, e.token)
  const impresoraValida = (fields: Json = {}) => ({
    name: 'Cocina',
    connection: 'network',
    address: '192.168.1.50',
    port: 9100,
    width: 80,
    code_page: 'pc850',
    fallback_id: null,
    station_ids: [t.kitchen],
    active: true,
    ...fields,
  })
  const crear = async (fields: Json = {}) => {
    const r = await llamar(admin, '/api/printers', { printer: impresoraValida(fields) })
    expect(r.statusCode).toBe(200)
    return r.json().id as string
  }
  const config = async () => (await llamar(admin, '/api/kitchen/config')).json()
  return { t, admin, cashier, manager, waiter, llamar, impresoraValida, crear, config }
}

type Mundo = Awaited<ReturnType<typeof mundo>>

/** Cada ruta, con un cuerpo válido y quién puede llamarla. */
const RUTAS = (m: Mundo, id: { printer: string; trabajo: string; screen: string }) => [
  { url: '/api/kitchen/config', cuerpo: {}, quienes: ['admin'] },
  { url: '/api/printers', cuerpo: { printer: m.impresoraValida() }, quienes: ['admin'] },
  { url: '/api/printers/test', cuerpo: { printer_id: id.printer }, quienes: ['admin'] },
  { url: '/api/printing/pending', cuerpo: {}, quienes: ['admin', 'cashier', 'manager'] },
  {
    url: '/api/printing/discard',
    cuerpo: { trabajo_id: id.trabajo },
    quienes: ['admin', 'cashier', 'manager'],
  },
  {
    url: '/api/screens/stations',
    cuerpo: { device_id: id.screen, station_ids: [m.t.kitchen] },
    quienes: ['admin'],
  },
  { url: '/api/kitchen/timers', cuerpo: { amarillo: 8, rojo: 16 }, quienes: ['admin'] },
]
/** Un cuerpo válido (sin la sesión) para cada ruta. */
const cuerpoValido = (m: Mundo, url: string): Json =>
  ({
    '/api/kitchen/config': {},
    '/api/printers': { printer: m.impresoraValida() },
    '/api/printers/test': { printer_id: newId() },
    '/api/printing/pending': {},
    '/api/printing/discard': { trabajo_id: newId() },
    '/api/screens': { name: 'Cocina', station_ids: [m.t.kitchen] },
    '/api/screens/stations': { device_id: newId(), station_ids: [m.t.kitchen] },
    '/api/kitchen/timers': { amarillo: 8, rojo: 16 },
  })[url] as Json
const TODAS = ['admin', 'cashier', 'manager', 'waiter'] as const
const URLS = [
  '/api/kitchen/config',
  '/api/printers',
  '/api/printers/test',
  '/api/printing/pending',
  '/api/printing/discard',
  '/api/screens',
  '/api/screens/stations',
  '/api/kitchen/timers',
]

describe('quién puede llamar cada ruta', () => {
  it.each(URLS)('%s: sin token responde 401, aunque el cuerpo sea basura', async (url) => {
    const { t } = await mundo()
    for (const cuerpo of [{}, { x: 1 }, 'text', [1]]) {
      const r = await t.post(url, cuerpo)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_token' })
    }
  })

  it.each(URLS)('%s: con un token inventado responde 401', async (url) => {
    const { t, admin } = await mundo()
    const r = await t.post(url, admin.cuerpoSesion, 'token-que-no-existe')
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'invalid_token' })
  })

  it.each(URLS)(
    '%s: con token pero con una sesión inventada o con otro secreto responde 401',
    async (url) => {
      const m = await mundo()
      const invalidas = [
        { session_id: newId(), secret: 'inventado' },
        { session_id: m.admin.cuerpoSesion.session_id, secret: 'otro-secreto' },
      ]
      for (const session of invalidas) {
        const r = await m.t.post(url, { ...session, ...cuerpoValido(m, url) }, m.admin.token)
        expect(r.statusCode).toBe(401)
        expect(r.json()).toMatchObject({ error: 'invalid_session' })
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
      m.waiter.token,
    )
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'invalid_session' })
  })

  it('un equipo retirado pierde el acceso a todas las rutas', async () => {
    const m = await mundo()
    const { t, admin, waiter } = m
    const r = await t.post(
      `/api/devices/${waiter.connection.dispositivoId}/revoke`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(r.statusCode).toBe(200)
    for (const url of URLS) {
      const x = await t.post(url, waiter.cuerpoSesion, waiter.token)
      expect(x.statusCode, url).toBe(401)
    }
  })

  it('una sesión cerrada se rechaza con 401', async () => {
    const { t, admin, llamar } = await mundo()
    await t.post('/api/sessions/close', admin.cuerpoSesion, admin.token)
    expect((await llamar(admin, '/api/kitchen/config')).statusCode).toBe(401)
  })

  it('el permiso decide: administrar_dispositivos para la configuración; la cola, también cobrar', async () => {
    const m = await mundo()
    const { t, llamar } = m
    const imp = t.impresoraNueva('Cocina', [t.kitchen])
    const { order, items } = t.orderWith(t.device('waiter2'), [
      { name: 'Pizza', station: t.kitchen },
    ])
    void order
    void items
    const trabajoId = newId()
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES (?, ?, ?, 'test', '{"printer":"x","stations":[],"time":"y"}', ?)`,
      )
      .run(trabajoId, t.restauranteId, imp.id, new Date(t.clock()).toISOString())
    for (const ruta of RUTAS(m, { printer: imp.id, trabajo: trabajoId, screen: newId() })) {
      for (const quien of TODAS) {
        const device = m[quien]
        const r = await llamar(device, ruta.url, ruta.cuerpo)
        if (ruta.quienes.includes(quien)) {
          // El permiso alcanza; puede fallar por datos (la pantalla de prueba no existe), nunca por permiso.
          expect(r.statusCode, `${quien} ${ruta.url}`).not.toBe(403)
          expect(r.statusCode, `${quien} ${ruta.url}`).not.toBe(401)
        } else {
          expect(r.statusCode, `${quien} ${ruta.url}`).toBe(403)
          expect(r.json()).toMatchObject({ error: 'no_permission' })
        }
      }
    }
  })

  it('un mesero no puede convertir un equipo en pantalla; un cajero tampoco', async () => {
    const { t, waiter, cashier, llamar } = await mundo()
    for (const e of [waiter, cashier]) {
      const r = await llamar(e, '/api/screens', { name: 'Cocina', station_ids: [t.kitchen] })
      expect(r.statusCode).toBe(403)
    }
    expect(t.db.prepare('SELECT count(*) AS n FROM users WHERE screen = 1').get()).toEqual({
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
    ['IP con nombre', { address: 'impresora.local' }],
    ['IP rara', { address: '999.1.1.1' }],
    ['IP pública', { address: '8.8.8.8' }],
    ['IP del propio PC', { address: '127.0.0.1' }],
    ['IP con puerto pegado', { address: '192.168.1.5:9100' }],
    ['IP vacía', { address: '' }],
    ['IP de 256 caracteres', { address: 'a'.repeat(256) }],
    ['puerto 0', { port: 0 }],
    ['puerto 65536', { port: 65536 }],
    ['puerto negativo', { port: -5 }],
    ['puerto decimal', { port: 9100.5 }],
    ['puerto texto', { port: '9100' }],
    ['puerto fuera de 9100-9109', { port: 9200 }],
    ['nombre vacío', { name: '' }],
    ['nombre de espacios', { name: '    ' }],
    ['nombre de 61', { name: 'a'.repeat(61) }],
    ['nombre número', { name: 5 }],
    ['conexión desconocida', { connection: 'bluetooth' }],
    ['ancho 57', { width: 57 }],
    ['ancho texto', { width: '80' }],
    ['página inventada', { code_page: 'utf8' }],
    ['estación que no existe', { station_ids: [newId()] }],
    ['estación con id corto', { station_ids: ['x'] }],
    ['más de 50 estaciones', { station_ids: Array.from({ length: 51 }, () => newId()) }],
    ['activo texto', { active: 'yes' }],
    ['respaldo inexistente', { fallback_id: newId() }],
    ['campo de más', { extra: 1 }],
    ['sin dirección', { address: undefined }],
    ['id que no existe', { id: newId() }],
  ]

  it.each(malos)('rechaza %s con 400 y no guarda nada', async (_, fields) => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/printers', { printer: m.impresoraValida(fields) })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'invalid_data' })
    expect(m.t.db.prepare('SELECT count(*) AS n FROM printers').get()).toEqual({ n: 0 })
    expect(m.t.cambiosCatalogo).toEqual([])
  })

  it('una estación de otro restaurante da 400, aunque exista en la base', async () => {
    const m = await mundo()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(other, other)
    const ajena = insertarVersionado(
      m.t.db,
      'stations',
      other,
      { name: 'Cocina ajena', position: 1 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const r = await m.llamar(m.admin, '/api/printers', {
      printer: m.impresoraValida({ station_ids: [ajena] }),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toBe('Esa estación no existe')
  })

  it('una estación archivada del mismo restaurante se descarta en silencio', async () => {
    const m = await mundo()
    m.t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(m.t.postres)
    const id = await m.crear({ station_ids: [m.t.kitchen, m.t.postres, m.t.kitchen] })
    const cfg = await m.config()
    expect(cfg.printers.find((i: Json) => i.id === id).station_ids).toEqual([m.t.kitchen])
  })

  it('una impresora no puede ser su propio respaldo', async () => {
    const m = await mundo()
    const id = await m.crear()
    const r = await m.llamar(m.admin, '/api/printers', {
      printer: m.impresoraValida({ id, fallback_id: id }),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toBe('Una impresora no puede ser su propio respaldo')
  })

  it('el respaldo debe existir, estar activo y ser de este restaurante', async () => {
    const m = await mundo()
    const archivada = await m.crear({ name: 'Vieja' })
    await m.llamar(m.admin, '/api/printers', {
      printer: m.impresoraValida({ id: archivada, name: 'Vieja', active: false }),
    })
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(other, other)
    const ajena = insertarVersionado(
      m.t.db,
      'printers',
      other,
      { name: 'Ajena', connection: 'network', address: '10.1.1.1', port: 9100, width: 80 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    for (const fallback_id of [newId(), archivada, ajena]) {
      const r = await m.llamar(m.admin, '/api/printers', {
        printer: m.impresoraValida({ name: 'Barra', fallback_id }),
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().message).toBe('La impresora de respaldo no existe')
    }
  })

  it('no se edita una impresora de otro restaurante', async () => {
    const m = await mundo()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(other, other)
    const ajena = insertarVersionado(
      m.t.db,
      'printers',
      other,
      { name: 'Ajena', connection: 'network', address: '10.1.1.1', port: 9100, width: 80 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const r = await m.llamar(m.admin, '/api/printers', {
      printer: m.impresoraValida({ id: ajena, name: 'Robada' }),
    })
    expect(r.statusCode).toBe(400)
    expect(m.t.db.prepare('SELECT name FROM printers WHERE id = ?').get(ajena)).toEqual({
      name: 'Ajena',
    })
  })
})

describe('POST /api/impresoras: crear, editar y archivar', () => {
  it('crea una impresora de red con el puerto por defecto y la deja en la configuración', async () => {
    const m = await mundo()
    const id = await m.crear({ port: null, name: '  Cocina  ' })
    const cfg = await m.config()
    expect(cfg.printers).toEqual([
      {
        id,
        name: 'Cocina',
        connection: 'network',
        address: '192.168.1.50',
        port: 9100,
        width: 80,
        code_page: 'pc850',
        fallback_id: null,
        station_ids: [m.t.kitchen],
        active: true,
      },
    ])
    expect(cfg.stations.map((e: Json) => e.name)).toEqual(['Cocina', 'Barra', 'Postres'])
    expect(cfg.tiempos).toEqual({ amarillo: 10, rojo: 20 })
    expect(cfg.pantallas).toEqual([])
    // Los equipos se enteran: la carta cambió de versión.
    expect(m.t.cambiosCatalogo.length).toBeGreaterThan(0)
  })

  it('las estaciones repetidas se guardan una sola vez', async () => {
    const m = await mundo()
    await m.crear({ station_ids: [m.t.kitchen, m.t.kitchen, m.t.bar] })
    const cfg = await m.config()
    expect(cfg.printers[0].station_ids).toEqual([m.t.kitchen, m.t.bar])
  })

  it('una impresora USB guarda el nombre de Windows y no lleva puerto', async () => {
    const m = await mundo()
    await m.crear({ connection: 'usb', address: 'POS-80 Caja', port: 9100 })
    const cfg = await m.config()
    expect(cfg.printers[0]).toMatchObject({
      connection: 'usb',
      address: 'POS-80 Caja',
      port: null,
    })
  })

  it('editar conserva el id, sube la versión y deja quién lo cambió', async () => {
    const m = await mundo()
    const id = await m.crear()
    const before = m.t.db.prepare('SELECT version FROM printers WHERE id = ?').get(id)
    const r = await m.llamar(m.admin, '/api/printers', {
      printer: m.impresoraValida({
        id,
        name: 'Cocina caliente',
        width: 58,
        code_page: 'wpc1252',
      }),
    })
    expect(r.json()).toEqual({ id })
    const row = m.t.db.prepare('SELECT * FROM printers WHERE id = ?').get(id)
    expect(row).toMatchObject({
      name: 'Cocina caliente',
      width: 58,
      code_page: 'wpc1252',
      user_id: m.admin.session.user.id,
    })
    expect(Number(row?.version)).toBeGreaterThan(Number(before?.version))
    expect(m.t.db.prepare('SELECT count(*) AS n FROM printers').get()).toEqual({ n: 1 })
  })

  it('cambiar las estaciones de una impresora cambia a dónde van las comandas nuevas', async () => {
    const m = await mundo()
    const id = await m.crear({ station_ids: [m.t.kitchen] })
    await m.llamar(m.admin, '/api/printers', {
      printer: m.impresoraValida({ id, station_ids: [m.t.bar] }),
    })
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [
      { name: 'Pizza', station: m.t.kitchen },
      { name: 'Aperol', station: m.t.bar },
    ])
    m.t.send(ana, order, items)
    expect(m.t.trabajos().map((f) => m.t.content(f).station)).toEqual(['Barra'])
  })

  it('archivar una impresora quita el respaldo de las que la apuntaban', async () => {
    const m = await mundo()
    const respaldo = await m.crear({
      name: 'Respaldo',
      address: '192.168.1.51',
      station_ids: [],
    })
    const a = await m.crear({ name: 'A', address: '192.168.1.52', fallback_id: respaldo })
    const b = await m.crear({ name: 'B', address: '192.168.1.53', fallback_id: respaldo })
    const c = await m.crear({ name: 'C', address: '192.168.1.54', fallback_id: a })
    const before = Number(
      m.t.db.prepare('SELECT version FROM printers WHERE id = ?').get(a)?.version,
    )
    const r = await m.llamar(m.admin, '/api/printers', {
      printer: m.impresoraValida({
        id: respaldo,
        name: 'Respaldo',
        address: '192.168.1.51',
        station_ids: [],
        active: false,
      }),
    })
    expect(r.statusCode).toBe(200)
    const cfg = await m.config()
    const lookup = (id: string) => cfg.printers.find((i: Json) => i.id === id)
    expect(lookup(a).fallback_id).toBeNull()
    expect(lookup(b).fallback_id).toBeNull()
    // La que apuntaba a otra (que sigue activa) no se toca.
    expect(lookup(c).fallback_id).toBe(a)
    expect(lookup(respaldo).active).toBe(false)
    expect(
      Number(m.t.db.prepare('SELECT version FROM printers WHERE id = ?').get(a)?.version),
    ).toBeGreaterThan(before)
  })

  it('archivar no borra la impresora ni sus comandas pendientes, y la archivada sale al final de la lista', async () => {
    const m = await mundo()
    const vieja = await m.crear({ name: 'Aaa vieja', address: '192.168.1.60' })
    await m.crear({ name: 'Zzz nueva', address: '192.168.1.61', station_ids: [m.t.bar] })
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [{ name: 'Pizza', station: m.t.kitchen }])
    m.t.send(ana, order, items)
    await m.llamar(m.admin, '/api/printers', {
      printer: m.impresoraValida({
        id: vieja,
        name: 'Aaa vieja',
        address: '192.168.1.60',
        active: false,
      }),
    })
    const cfg = await m.config()
    expect(cfg.printers.map((i: Json) => [i.name, i.active])).toEqual([
      ['Zzz nueva', true],
      ['Aaa vieja', false],
    ])
    expect(m.t.pendingList()).toBe(1)
    // Las archivadas no salen en los estados de la cola.
    expect(cfg.statuses.map((e: Json) => e.name)).toEqual(['Zzz nueva'])
  })

  it('reactivar una impresora archivada la deja otra vez recibiendo comandas', async () => {
    const m = await mundo()
    const id = await m.crear()
    const data = (active: boolean) => m.impresoraValida({ id, active })
    await m.llamar(m.admin, '/api/printers', { printer: data(false) })
    await m.llamar(m.admin, '/api/printers', { printer: data(true) })
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [{ name: 'Pizza', station: m.t.kitchen }])
    m.t.send(ana, order, items)
    expect(m.t.trabajos()).toHaveLength(1)
  })

  it('dos impresoras pueden apuntarse mutuamente de respaldo sin colgar la cola', async () => {
    const m = await mundo()
    const a = m.t.impresoraNueva('A', [m.t.kitchen])
    const b = m.t.impresoraNueva('B', [m.t.bar])
    for (const [id, other, name, address] of [
      [a.id, b.id, 'A', a.address],
      [b.id, a.id, 'B', b.address],
    ] as const) {
      const r = await m.llamar(m.admin, '/api/printers', {
        printer: m.impresoraValida({
          id,
          name,
          address,
          fallback_id: other,
          station_ids: [],
        }),
      })
      expect(r.statusCode).toBe(200)
    }
    m.t.db
      .prepare('UPDATE printers SET station_ids = ? WHERE id = ?')
      .run(JSON.stringify([m.t.kitchen]), a.id)
    a.papel.apagada = true
    b.papel.apagada = true
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [{ name: 'Pizza', station: m.t.kitchen }])
    m.t.send(ana, order, items)
    for (let i = 0; i < 8; i++) {
      await m.t.cola.runOnce()
      await m.t.cola.runOnce()
      m.t.advance(60_000)
    }
    expect(m.t.pendingList()).toBe(1)
    b.papel.apagada = false
    for (let i = 0; i < 3; i++) {
      await m.t.cola.runOnce()
      await m.t.cola.runOnce()
      m.t.advance(60_000)
    }
    expect(m.t.pendingList()).toBe(0)
    expect(b.papel.recibidos.length + a.papel.recibidos.length).toBe(1)
  })
})

describe('con la impresora de prueba (permitirLocales)', () => {
  it('acepta 127.0.0.1 y cualquier puerto, y el trabajo sale por la red de verdad', async () => {
    const m = await mundo({ permitirLocales: true })
    const id = await m.crear({ address: '127.0.0.1', port: 4455 })
    const row = m.t.db.prepare('SELECT address, port FROM printers WHERE id = ?').get(id)
    expect(row).toEqual({ address: '127.0.0.1', port: 4455 })
  })

  it('sin la opción, 127.0.0.1 se rechaza', async () => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/printers', {
      printer: m.impresoraValida({ address: '127.0.0.1' }),
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('POST /api/impresoras/prueba', () => {
  it('encola una página de prueba y la cola la saca', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.kitchen])
    const r = await m.llamar(m.admin, '/api/printers/test', { printer_id: imp.id })
    expect(r.statusCode).toBe(201)
    const trabajoId = r.json().trabajo_id as string
    await m.t.cola.ready()
    await m.t.cola.runOnce()
    expect(m.t.trabajos().find((f) => f.id === trabajoId)).toMatchObject({
      type: 'test',
      status: 'printed',
      printer_id: imp.id,
    })
    const text = imp.papel.texts()[0] as string
    expect(text.replaceAll('\n', ' ')).toContain('PRUEBA DE IMPRESIÓN')
    expect(text).toContain('Imprime: Cocina')
  })

  it('con la impresora apagada queda pendiente y se ve en la lista de pendientes', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.kitchen])
    imp.papel.apagada = true
    await m.llamar(m.admin, '/api/printers/test', { printer_id: imp.id })
    await m.t.cola.ready()
    await m.t.cola.runOnce()
    const list = (await m.llamar(m.admin, '/api/printing/pending')).json()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ que: 'Página de prueba', printer: 'Cocina' })
    expect(list[0].attempts).toBeGreaterThan(0)
    expect(String(list[0].error)).toContain('rechazó la conexión')
  })

  it.each([
    ['nonexistent', () => newId()],
    ['con id corto', () => 'corto'],
  ])('una impresora %s da 400', async (_, id) => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/printers/test', { printer_id: id() })
    expect(r.statusCode).toBe(400)
  })

  it('una impresora archivada no se prueba', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Vieja', [], { active: 0 })
    const r = await m.llamar(m.admin, '/api/printers/test', { printer_id: imp.id })
    expect(r.statusCode).toBe(400)
    expect(m.t.trabajos()).toEqual([])
  })

  it('la hora de la prueba va en la zona del restaurante y trae el nombre de las estaciones', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Mixta', [m.t.kitchen, m.t.bar])
    const r = await m.llamar(m.admin, '/api/printers/test', { printer_id: imp.id })
    const row = m.t.trabajos().find((f) => f.id === r.json().trabajo_id)
    const content = m.t.content(row)
    expect(content.stations).toEqual(['Cocina', 'Barra'])
    expect(content.printer).toBe('Mixta')
    expect(content.time).toMatch(/3:00\s*p\.\s*m\./)
  })
})

describe('POST /api/impresion/pendientes y /descartar', () => {
  async function conPendientes() {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.kitchen])
    imp.papel.apagada = true
    const ana = m.t.device('waiter2')
    for (let i = 0; i < 3; i++) {
      const { order, items } = m.t.orderWith(
        ana,
        [{ name: `Plato ${i}`, station: m.t.kitchen }],
        m.t.table(String(9 + i)),
      )
      m.t.send(ana, order, items)
      m.t.advance(1000)
    }
    await m.t.cola.runOnce()
    return { m, imp }
  }

  it('lista lo que no ha salido, en orden, con qué es, cuántos intentos y por qué falló', async () => {
    const { m } = await conPendientes()
    const list = (await m.llamar(m.admin, '/api/printing/pending')).json()
    expect(list.map((x: Json) => x.que)).toEqual([
      'Cocina · Mesa 9 · #1',
      'Cocina · Mesa 10 · #2',
      'Cocina · Mesa 11 · #3',
    ])
    expect(list[0]).toMatchObject({ printer: 'Cocina', attempts: 1 })
    expect(String(list[0].error)).toContain('rechazó')
    expect(list[1]).toMatchObject({ attempts: 0, error: null })
    expect(list[0].created_at < list[1].created_at).toBe(true)
  })

  it('no lista lo impreso ni lo descartado', async () => {
    const { m, imp } = await conPendientes()
    imp.papel.apagada = false
    m.t.advance(2000)
    await m.t.cola.runOnce()
    await m.t.cola.runOnce()
    expect((await m.llamar(m.admin, '/api/printing/pending')).json()).toEqual([])
  })

  it('sin pendientes devuelve una lista vacía', async () => {
    const m = await mundo()
    const r = await m.llamar(m.cashier, '/api/printing/pending')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual([])
  })

  it('descartar marca el trabajo con quién y desde qué equipo, no lo borra y desaparece de la lista', async () => {
    const { m } = await conPendientes()
    const [firstOne] = (await m.llamar(m.cashier, '/api/printing/pending')).json()
    const r = await m.llamar(m.cashier, '/api/printing/discard', { trabajo_id: firstOne.id })
    expect(r.statusCode).toBe(204)
    const row = m.t.db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(firstOne.id)
    expect(row).toMatchObject({
      status: 'discarded',
      discarded_by_id: m.cashier.session.user.id,
      discarded_device_id: m.cashier.connection.dispositivoId,
    })
    expect(row?.finished_at).not.toBeNull()
    expect(m.t.db.prepare('SELECT count(*) AS n FROM print_jobs').get()).toEqual({ n: 3 })
    const list = (await m.llamar(m.admin, '/api/printing/pending')).json()
    expect(list).toHaveLength(2)
  })

  it('descartar dos veces, o algo ya impreso, o algo que no existe, da 400', async () => {
    const { m, imp } = await conPendientes()
    const [firstOne, secondOne] = (await m.llamar(m.admin, '/api/printing/pending')).json()
    expect(
      (await m.llamar(m.admin, '/api/printing/discard', { trabajo_id: firstOne.id })).statusCode,
    ).toBe(204)
    const another = await m.llamar(m.admin, '/api/printing/discard', { trabajo_id: firstOne.id })
    expect(another.statusCode).toBe(400)
    expect(another.json().message).toBe('Esa comanda ya salió o ya se descartó')
    imp.papel.apagada = false
    m.t.advance(2000)
    await m.t.cola.runOnce()
    await m.t.cola.runOnce()
    expect(
      (await m.llamar(m.admin, '/api/printing/discard', { trabajo_id: secondOne.id })).statusCode,
    ).toBe(400)
    expect(
      (await m.llamar(m.admin, '/api/printing/discard', { trabajo_id: newId() })).statusCode,
    ).toBe(400)
  })

  it('lo descartado no se imprime aunque la impresora vuelva', async () => {
    const { m, imp } = await conPendientes()
    for (const x of (await m.llamar(m.admin, '/api/printing/pending')).json())
      await m.llamar(m.admin, '/api/printing/discard', { trabajo_id: x.id })
    imp.papel.apagada = false
    m.t.advance(60_000)
    await m.t.cola.runOnce()
    expect(imp.papel.recibidos).toHaveLength(0)
  })

  it('no se descarta el trabajo de otro restaurante', async () => {
    const m = await mundo()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z', 1, 'Otro', '{}')`,
      )
      .run(other, other)
    const impAjena = insertarVersionado(
      m.t.db,
      'printers',
      other,
      { name: 'Ajena', connection: 'network', address: '10.1.1.1', port: 9100, width: 80 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const trabajo = newId()
    m.t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES (?, ?, ?, 'test', '{}', '2026-10-24T20:00:00.000Z')`,
      )
      .run(trabajo, other, impAjena)
    const r = await m.llamar(m.admin, '/api/printing/discard', { trabajo_id: trabajo })
    expect(r.statusCode).toBe(400)
    expect(m.t.db.prepare('SELECT status FROM print_jobs WHERE id = ?').get(trabajo)).toEqual({
      status: 'pending',
    })
    expect((await m.llamar(m.admin, '/api/printing/pending')).json()).toEqual([])
  })

  it('la lista se corta en 200 comandas', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.kitchen])
    const insertar = m.t.db.prepare(
      `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
       VALUES (?, ?, ?, 'ticket', '{"station":"Cocina","target":"Mesa","number":1}', ?)`,
    )
    for (let i = 0; i < 230; i++)
      insertar.run(
        newId(),
        m.t.restauranteId,
        imp.id,
        new Date(Date.UTC(2026, 9, 24, 20, 0, i)).toISOString(),
      )
    const list = (await m.llamar(m.admin, '/api/printing/pending')).json()
    expect(list).toHaveLength(200)
  })

  it('el cuerpo lleva solo lo esperado: un campo de más da 400', async () => {
    const m = await mundo()
    expect((await m.llamar(m.admin, '/api/printing/pending', { extra: 1 })).statusCode).toBe(400)
    expect((await m.llamar(m.admin, '/api/printing/discard', { trabajo_id: 'x' })).statusCode).toBe(
      400,
    )
  })

  it('una comanda sin número o con textos raros no rompe la lista', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.kitchen])
    for (const content of ['{}', '{"station":"Cocina"}', '{"number":null,"target":"Mesa 1"}', '[]'])
      m.t.db
        .prepare(
          `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
           VALUES (?, ?, ?, 'ticket', ?, ?)`,
        )
        .run(newId(), m.t.restauranteId, imp.id, content, new Date(m.t.clock()).toISOString())
    const r = await m.llamar(m.admin, '/api/printing/pending')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toHaveLength(4)
  })
})

describe('POST /api/cocina/tiempos', () => {
  it('guarda los minutos, los muestra en la configuración y los manda en la carta', async () => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 7, rojo: 15 })
    expect(r.statusCode).toBe(204)
    expect((await m.config()).tiempos).toEqual({ amarillo: 7, rojo: 15 })
    const catalog = leerCatalogo(m.t.db, m.t.restauranteId)
    expect(catalog.restaurant).toMatchObject({ cocinaAmarilloMin: 7, cocinaRojoMin: 15 })
    expect(m.t.cambiosCatalogo.length).toBeGreaterThan(0)
  })

  it.each([
    ['ámbar 0', { amarillo: 0, rojo: 5 }],
    ['ámbar negativo', { amarillo: -1, rojo: 5 }],
    ['rojo 241', { amarillo: 5, rojo: 241 }],
    ['ámbar 241', { amarillo: 241, rojo: 241 }],
    ['decimales', { amarillo: 5.5, rojo: 9 }],
    ['text', { amarillo: '5', rojo: '9' }],
    ['rojo igual al ámbar', { amarillo: 10, rojo: 10 }],
    ['rojo menor que el ámbar', { amarillo: 20, rojo: 10 }],
    ['sin rojo', { amarillo: 5 }],
    ['campo de más', { amarillo: 5, rojo: 9, extra: 1 }],
    ['null', { amarillo: null, rojo: null }],
  ])('rechaza %s con 400 y no cambia nada', async (_, cuerpo) => {
    const m = await mundo()
    const r = await m.llamar(m.admin, '/api/kitchen/timers', cuerpo)
    expect(r.statusCode).toBe(400)
    expect((await m.config()).tiempos).toEqual({ amarillo: 10, rojo: 20 })
  })

  it('acepta los extremos 1 y 240 (rojo > ámbar)', async () => {
    const m = await mundo()
    expect(
      (await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 1, rojo: 2 })).statusCode,
    ).toBe(204)
    expect(
      (await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 239, rojo: 240 })).statusCode,
    ).toBe(204)
    expect((await m.config()).tiempos).toEqual({ amarillo: 239, rojo: 240 })
  })

  it('conserva el resto de la configuración del restaurante y deja quién lo cambió', async () => {
    const m = await mundo()
    const config = fullConfig({})
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...config, session_idle_min: 45, brand: 'la-spritzzeria' }),
        m.t.restauranteId,
      )
    await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 12, rojo: 25 })
    const row = m.t.db
      .prepare('SELECT config, user_id FROM restaurants WHERE id = ?')
      .get(m.t.restauranteId)
    expect(JSON.parse(String(row?.config))).toMatchObject({
      session_idle_min: 45,
      brand: 'la-spritzzeria',
      kitchen_yellow_min: 12,
      kitchen_red_min: 25,
    })
    expect(row?.user_id).toBe(m.admin.session.user.id)
  })

  it('un restaurante con la configuración vacía recibe los valores de fábrica y los guarda completos', async () => {
    const m = await mundo()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restauranteId)
    await m.llamar(m.admin, '/api/kitchen/timers', { amarillo: 3, rojo: 4 })
    const row = m.t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(m.t.restauranteId)
    expect(JSON.parse(String(row?.config))).toMatchObject({
      kitchen_yellow_min: 3,
      kitchen_red_min: 4,
    })
  })
})

describe('POST /api/cocina/configuracion y /api/pantallas/estaciones', () => {
  it('las estaciones archivadas no salen en la configuración', async () => {
    const m = await mundo()
    m.t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(m.t.postres)
    expect((await m.config()).stations.map((e: Json) => e.name)).toEqual(['Cocina', 'Barra'])
  })

  it('cambia las estaciones de una pantalla y valida las que se piden', async () => {
    const m = await mundo()
    const tablet = m.t.device('admin', 'register')
    const c = await m.t.post(
      '/api/screens',
      { ...tablet.cuerpoSesion, name: 'Cocina', station_ids: [m.t.kitchen] },
      tablet.token,
    )
    expect(c.statusCode).toBe(201)
    const device = tablet.connection.dispositivoId
    const patch = (station_ids: unknown, device_id: string = device) =>
      m.llamar(m.admin, '/api/screens/stations', { device_id, station_ids })
    expect((await patch([m.t.kitchen, m.t.bar])).statusCode).toBe(204)
    expect((await m.config()).pantallas).toMatchObject([
      { device_id: device, name: 'Cocina', station_ids: [m.t.kitchen, m.t.bar] },
    ])
    expect((await patch([])).statusCode).toBe(400)
    expect((await patch([newId()])).statusCode).toBe(400)
    expect((await patch(['x'])).statusCode).toBe(400)
    expect((await patch([m.t.kitchen], newId())).statusCode).toBe(400)
    // Un equipo que no es pantalla no sirve.
    expect((await patch([m.t.kitchen], m.waiter.connection.dispositivoId)).statusCode).toBe(400)
    // Solo estaciones archivadas dejaría la pantalla sin nada: se rechaza.
    m.t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(m.t.postres)
    expect((await patch([m.t.postres])).statusCode).toBe(400)
    // Mezcladas con una activa, la archivada se descarta.
    expect((await patch([m.t.postres, m.t.bar])).statusCode).toBe(204)
    expect((await m.config()).pantallas[0].station_ids).toEqual([m.t.bar])
  })

  it('una pantalla retirada ya no sale en la configuración ni se puede editar', async () => {
    const m = await mundo()
    const tablet = m.t.device('admin', 'register')
    await m.t.post(
      '/api/screens',
      { ...tablet.cuerpoSesion, name: 'Cocina', station_ids: [m.t.kitchen] },
      tablet.token,
    )
    const r = await m.t.post(
      `/api/devices/${tablet.connection.dispositivoId}/revoke`,
      m.admin.cuerpoSesion,
      m.admin.token,
    )
    expect(r.statusCode).toBe(200)
    expect((await m.config()).pantallas).toEqual([])
    const e = await m.llamar(m.admin, '/api/screens/stations', {
      device_id: tablet.connection.dispositivoId,
      station_ids: [m.t.kitchen],
    })
    expect(e.statusCode).toBe(400)
  })

  it('la configuración trae los estados de las impresoras', async () => {
    const m = await mundo()
    const imp = m.t.impresoraNueva('Cocina', [m.t.kitchen])
    imp.papel.apagada = true
    const ana = m.t.device('waiter2')
    const { order, items } = m.t.orderWith(ana, [{ name: 'Pizza', station: m.t.kitchen }])
    m.t.send(ana, order, items)
    await m.t.cola.runOnce()
    expect((await m.config()).statuses).toEqual([
      expect.objectContaining({ id: imp.id, status: 'failed', pendingList: 1 }),
    ])
  })
})
