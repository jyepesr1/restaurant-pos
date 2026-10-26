import { fullConfig, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertVersioned, SISTEMA } from '../acceso/registros'
import { leerCatalogo } from '../catalogo'
import { type Equipo, montarImpresion } from './montaje-impresion'

// Las rutas de la tarea 1.6: `/api/caja/precuenta`, `/api/caja/configuracion`, `/api/caja/medios`,
// `/api/caja/propina` y `/api/datafonos`, y lo que la carta dice del cobro. Todas piden un equipo
// con token y una sesión con `manage_devices`.

type Json = Record<string, unknown>

function mundo() {
  const t = montarImpresion()
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const manager = t.device('manager', 'register')
  const waiter = t.device('waiter')
  const llamar = (e: Equipo, url: string, extra: Json = {}) =>
    t.post(url, { ...e.cuerpoSesion, ...extra }, e.token)
  const catalog = () => leerCatalogo(t.db, t.restaurantId)
  const configGuardada = () =>
    fullConfig(
      JSON.parse(
        String(
          t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(t.restaurantId)?.config,
        ),
      ),
    )
  const preBill = (printer_id: unknown, e: Equipo = admin) =>
    llamar(e, '/api/register/pre-bill', { printer_id })
  const methods = (m: unknown, e: Equipo = admin) =>
    llamar(e, '/api/register/payment-methods', { methods: m })
  const tip = (puntos: unknown, e: Equipo = admin) => llamar(e, '/api/register/tip', { puntos })
  const cardTerminal = (d: Json, e: Equipo = admin) =>
    llamar(e, '/api/card-terminals', { cardTerminal: d })
  const settings = async (e: Equipo = admin) =>
    (await llamar(e, '/api/register/config')).json() as {
      payment_methods: string[]
      suggested_tip: number
      cardTerminals: { id: string; name: string; provider: string; active: boolean }[]
    }
  /** Un restaurante ajeno en la misma base, con una impresora y un datáfono suyos. */
  const outsider = () => {
    const other = newId()
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(other, other, new Date(t.clock()).toISOString(), new Date(t.clock()).toISOString())
    t.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    const printer = insertVersioned(
      t.db,
      'printers',
      other,
      { name: 'Barra ajena', connection: 'network', address: '10.9.9.9', port: 9100, width: 80 },
      SISTEMA,
      new Date(t.clock()).toISOString(),
    )
    const datafonoId = insertVersioned(
      t.db,
      'card_terminals',
      other,
      { name: 'Bold ajeno', provider: 'bold' },
      SISTEMA,
      new Date(t.clock()).toISOString(),
    )
    return { other, printer, datafonoId }
  }
  return {
    t,
    admin,
    cashier,
    manager,
    waiter,
    llamar,
    catalog,
    configGuardada,
    preBill,
    methods,
    tip,
    cardTerminal,
    settings,
    outsider,
  }
}

type Mundo = ReturnType<typeof mundo>

describe('permisos: las cinco rutas piden administrar_dispositivos', () => {
  const rutas: [string, (m: Mundo, e: Equipo) => Promise<{ statusCode: number }>][] = [
    ['/api/register/pre-bill', (m, e) => m.preBill(null, e)],
    ['/api/register/config', (m, e) => m.llamar(e, '/api/register/config')],
    ['/api/register/payment-methods', (m, e) => m.methods(['cash', 'nequi'], e)],
    ['/api/register/tip', (m, e) => m.tip(500, e)],
    [
      '/api/card-terminals',
      (m, e) => m.cardTerminal({ name: 'Nuevo', provider: 'other', active: true }, e),
    ],
  ]
  /** El resto del cuerpo que cada ruta espera, para probar la sesión con datos válidos. */
  const CUERPO: Record<string, Json> = {
    '/api/register/pre-bill': { printer_id: null },
    '/api/register/config': {},
    '/api/register/payment-methods': { methods: ['cash'] },
    '/api/register/tip': { puntos: 500 },
    '/api/register/custom-methods': { method: { name: 'Sodexo', active: true } },
    '/api/card-terminals': { cardTerminal: { name: 'Nuevo', provider: 'other', active: true } },
  }

  it.each(rutas)('%s: sin token responde 401, aunque el cuerpo sea basura', async (url) => {
    const m = mundo()
    for (const cuerpo of [{}, 'text', [1], { methods: 1 }]) {
      const r = await m.t.post(url, cuerpo)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_token' })
    }
  })

  it.each(rutas)('%s: un token inventado, 401', async (url) => {
    const m = mundo()
    const r = await m.t.post(url, { ...m.admin.cuerpoSesion, ...CUERPO[url] }, 'inventado')
    expect(r.statusCode).toBe(401)
  })

  it.each(rutas)('%s: sesión inventada o con otro secreto, 401', async (url) => {
    const m = mundo()
    for (const session of [
      { session_id: '01JB0000000000000000000000', secret: 'inventado' },
      { session_id: m.admin.cuerpoSesion.session_id, secret: 'otro-secreto' },
    ]) {
      const r = await m.t.post(url, { ...session, ...CUERPO[url] }, m.admin.token)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_session' })
    }
  })

  it.each(rutas)('%s: la sesión de otro equipo no sirve', async (url, llamar) => {
    const m = mundo()
    const r = await m.t.post(url, { ...m.admin.cuerpoSesion, ...CUERPO[url] }, m.waiter.token)
    expect(r.statusCode).toBe(401)
    expect(llamar).toBeTypeOf('function')
  })

  it.each(rutas)('%s: sin los datos de la sesión, 400', async (url) => {
    const m = mundo()
    const { session_id: _s, secret: _x, ...sinSesion } = { ...m.admin.cuerpoSesion, ...CUERPO[url] }
    const r = await m.t.post(url, sinSesion, m.admin.token)
    expect(r.statusCode).toBe(400)
  })

  it.each(rutas)(
    '%s: cajero, gerente y mesero responden 403 y no cambian nada',
    async (url, llamar) => {
      for (const who of ['cashier', 'manager', 'waiter'] as const) {
        const m = mundo()
        const before = m.catalog().version
        const r = await llamar(m, m[who])
        expect(r.statusCode, `${url} · ${who}`).toBe(403)
        expect(m.catalog().version).toBe(before)
        expect(m.t.cambiosCatalogo).toEqual([])
        expect(m.configGuardada().payment_methods).toEqual(fullConfig().payment_methods)
      }
    },
  )

  it.each(rutas)('%s: una sesión cerrada, 401', async (url, llamar) => {
    const m = mundo()
    await m.t.post('/api/sessions/close', m.admin.cuerpoSesion, m.admin.token)
    expect((await llamar(m, m.admin)).statusCode, url).toBe(401)
  })

  it('un equipo retirado pierde el acceso a las rutas de caja', async () => {
    const m = mundo()
    await m.t.post(
      `/api/devices/${m.waiter.connection.deviceId}/revoke`,
      m.admin.cuerpoSesion,
      m.admin.token,
    )
    expect((await m.methods(['cash'], m.waiter)).statusCode).toBe(401)
  })
})

describe('POST /api/caja/precuenta', () => {
  const nuevaImpresora = (m: Mundo, extra: Record<string, string | number> = {}) =>
    m.t.impresoraNueva('Caja', [m.t.kitchen], extra)

  it('de fábrica no hay impresora de precuentas y la carta dice que no se imprime', () => {
    const m = mundo()
    expect(m.configGuardada().pre_bill_printer_id).toBeNull()
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
  })

  it('elegir una impresora activa: 204, la guarda, avisa y la carta dice que se imprime', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m)
    const before = m.catalog().version
    const r = await m.preBill(id)
    expect(r.statusCode).toBe(204)
    expect(r.body).toBe('')
    expect(m.configGuardada().pre_bill_printer_id).toBe(id)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(true)
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.cambiosCatalogo).toEqual([m.catalog().version])
  })

  it('el cambio queda a nombre de quien lo hizo', async () => {
    const m = mundo()
    await m.preBill(nuevaImpresora(m).id)
    const row = m.t.db
      .prepare('SELECT user_id, device_id FROM restaurants WHERE id = ?')
      .get(m.t.restaurantId)
    expect(row).toEqual({
      user_id: m.t.people.admin.userId,
      device_id: m.admin.connection.deviceId,
    })
  })

  it('quitarla (null) la deja sin impresora y repetirlo no sube la versión', async () => {
    const m = mundo()
    await m.preBill(nuevaImpresora(m).id)
    expect((await m.preBill(null)).statusCode).toBe(204)
    expect(m.configGuardada().pre_bill_printer_id).toBeNull()
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
    const v = m.catalog().version
    expect((await m.preBill(null)).statusCode).toBe(204)
    expect(m.catalog().version).toBe(v)
  })

  it('elegir la misma impresora otra vez no sube la versión ni avisa', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m)
    await m.preBill(id)
    const v = m.catalog().version
    const alerts = m.t.cambiosCatalogo.length
    await m.preBill(id)
    expect(m.catalog().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(alerts)
  })

  it('una impresora archivada se rechaza con 400', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m, { active: 0 })
    const r = await m.preBill(id)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      error: 'invalid_data',
      message: 'Esa impresora no existe o está archivada',
    })
    expect(m.configGuardada().pre_bill_printer_id).toBeNull()
  })

  it('una impresora que no existe se rechaza con 400', async () => {
    const m = mundo()
    expect((await m.preBill(newId())).statusCode).toBe(400)
    expect(m.configGuardada().pre_bill_printer_id).toBeNull()
  })

  it('la impresora de OTRO restaurante se rechaza con 400', async () => {
    const m = mundo()
    const { printer } = m.outsider()
    const r = await m.preBill(printer)
    expect(r.statusCode).toBe(400)
    expect(m.configGuardada().pre_bill_printer_id).toBeNull()
  })

  it.each([
    ['texto corto', 'abc'],
    ['cadena vacía', ''],
    ['número', 7],
    ['objeto', {}],
    ['arreglo', [newId()]],
    ['id de 27 caracteres', `${newId()}X`],
  ])('rechaza impresora_id = %s con 400', async (_, value) => {
    const m = mundo()
    expect((await m.preBill(value)).statusCode).toBe(400)
  })

  it('sin impresora_id y con campos de más, 400', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/register/pre-bill', {})).statusCode).toBe(400)
    expect(
      (await m.llamar(m.admin, '/api/register/pre-bill', { printer_id: null, other: 1 }))
        .statusCode,
    ).toBe(400)
  })

  it('archivar la impresora elegida apaga la impresión; volver a activarla la prende', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m)
    await m.preBill(id)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(true)
    m.t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(id)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
    // La elección no se pierde: sigue guardada en la configuración.
    expect(m.configGuardada().pre_bill_printer_id).toBe(id)
    m.t.db.prepare('UPDATE printers SET active = 1 WHERE id = ?').run(id)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(true)
  })

  it('la pantalla «Cocina e impresoras» devuelve la impresora de precuentas elegida', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m)
    await m.preBill(id)
    const r = await m.llamar(m.admin, '/api/kitchen/config')
    expect(r.json()).toMatchObject({ pre_bill_printer_id: id })
  })
})

describe('catálogo: restaurante.cobro y datafonos', () => {
  it('trae los valores de fábrica del cobro', () => {
    const { catalog } = mundo()
    expect(catalog().restaurant.checkout).toEqual({
      paymentMethods: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
      customMethods: [],
      archivedCustomMethods: [],
      suggestedTip: 1000,
      roundingMode: 'half_up',
      cashRounding: 100,
      cashRoundingMode: 'nearest_half_down',
      varianceThreshold: 1000,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      printsPreBill: false,
    })
    expect(catalog().cardTerminals).toEqual([])
  })

  it('refleja la configuración guardada del restaurante', () => {
    const m = mundo()
    m.t.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run(
      JSON.stringify({
        payment_methods: ['nequi', 'cash'],
        suggested_tip: 700,
        rounding_mode: 'half_even',
        cash_rounding: 50,
        cash_rounding_mode: 'up',
      }),
      m.t.restaurantId,
    )
    expect(m.catalog().restaurant.checkout).toMatchObject({
      paymentMethods: ['nequi', 'cash'],
      suggestedTip: 700,
      roundingMode: 'half_even',
      cashRounding: 50,
      cashRoundingMode: 'up',
    })
  })

  it('una configuración vieja, sin los campos nuevos, toma los valores de fábrica', () => {
    const m = mundo()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.paymentMethods).toEqual(fullConfig().payment_methods)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
  })

  it('imprimePrecuenta es falso si la impresora elegida es de otro restaurante', () => {
    const m = mundo()
    const { printer } = m.outsider()
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
  })

  it('imprimePrecuenta es falso si la impresora elegida ya no existe', () => {
    const m = mundo()
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: newId() }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.printsPreBill).toBe(false)
  })

  it('los datáfonos: solo los activos de este restaurante, por nombre', async () => {
    const m = mundo()
    const outsider = m.outsider()
    await m.cardTerminal({ name: 'Bold 2', provider: 'bold', active: true })
    await m.cardTerminal({ name: 'Bold 1', provider: 'bold', active: true })
    const archived = (
      await m.cardTerminal({ name: 'Viejo', provider: 'redeban', active: true })
    ).json() as { id: string }
    await m.cardTerminal({ id: archived.id, name: 'Viejo', provider: 'redeban', active: false })
    expect(m.catalog().cardTerminals?.map((d) => d.name)).toEqual(['Bold 1', 'Bold 2'])
    expect(m.catalog().cardTerminals?.map((d) => d.id)).not.toContain(outsider.datafonoId)
    // El catálogo dice id, nombre y proveedor: los de un mismo proveedor tienen un solo cierre, así
    // que al cobrar solo se elige el proveedor si hay varios.
    for (const d of m.catalog().cardTerminals ?? [])
      expect(Object.keys(d).sort()).toEqual(['id', 'name', 'provider'])
  })
})

describe('POST /api/caja/medios', () => {
  it('de fábrica: efectivo, tarjeta, Nequi, Daviplata, Bre-B y transferencia, en ese orden', async () => {
    const m = mundo()
    expect((await m.settings()).payment_methods).toEqual([
      'cash',
      'card',
      'nequi',
      'daviplata',
      'breb',
      'transfer',
    ])
  })

  it('guarda los medios en el orden elegido, avisa y la carta los trae', async () => {
    const m = mundo()
    const before = m.catalog().version
    const r = await m.methods(['nequi', 'cash', 'card'])
    expect(r.statusCode).toBe(204)
    expect((await m.settings()).payment_methods).toEqual(['nequi', 'cash', 'card'])
    expect(m.catalog().restaurant.checkout?.paymentMethods).toEqual(['nequi', 'cash', 'card'])
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.cambiosCatalogo).toEqual([m.catalog().version])
  })

  it('solo efectivo es válido; el bono se puede agregar', async () => {
    const m = mundo()
    expect((await m.methods(['cash'])).statusCode).toBe(204)
    expect((await m.methods(['cash', 'voucher'])).statusCode).toBe(204)
    expect(m.configGuardada().payment_methods).toEqual(['cash', 'voucher'])
  })

  it('los repetidos se quitan y se queda el primero', async () => {
    const m = mundo()
    expect((await m.methods(['card', 'cash', 'card', 'cash'])).statusCode).toBe(204)
    expect(m.configGuardada().payment_methods).toEqual(['card', 'cash'])
  })

  it('sin efectivo se rechaza con 400 y el mensaje lo explica', async () => {
    const m = mundo()
    const before = m.catalog().version
    const r = await m.methods(['card', 'nequi'])
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'El efectivo siempre se recibe' })
    expect(m.configGuardada().payment_methods).toEqual(fullConfig().payment_methods)
    expect(m.catalog().version).toBe(before)
  })

  it.each([
    ['lista vacía', []],
    ['un medio que no existe', ['cash', 'cheque']],
    ['mayúsculas', ['Efectivo']],
    ['no es lista', 'cash'],
    ['null', null],
    ['elemento no texto', ['cash', 3]],
    ['más de diez', Array(11).fill('cash')],
  ])('rechaza medios = %s con 400', async (_, value) => {
    const m = mundo()
    expect((await m.methods(value)).statusCode).toBe(400)
    expect(m.configGuardada().payment_methods).toEqual(fullConfig().payment_methods)
  })

  it('sin medios y con campos de más, 400', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/register/payment-methods', {})).statusCode).toBe(400)
    expect(
      (await m.llamar(m.admin, '/api/register/payment-methods', { methods: ['cash'], x: 1 }))
        .statusCode,
    ).toBe(400)
  })

  it('repetir la misma lista no sube la versión ni avisa', async () => {
    const m = mundo()
    await m.methods(['cash', 'card'])
    const v = m.catalog().version
    const alerts = m.t.cambiosCatalogo.length
    expect((await m.methods(['cash', 'card'])).statusCode).toBe(204)
    expect(m.catalog().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(alerts)
  })

  it('cambiar solo el orden sí es un cambio', async () => {
    const m = mundo()
    await m.methods(['cash', 'card'])
    const v = m.catalog().version
    await m.methods(['card', 'cash'])
    expect(m.catalog().version).toBeGreaterThan(v)
  })

  it('no toca el resto de la configuración del restaurante', async () => {
    const m = mundo()
    const before = { ...m.configGuardada(), payment_methods: undefined }
    await m.methods(['cash', 'nequi'])
    expect({ ...m.configGuardada(), payment_methods: undefined }).toEqual(before)
  })
})

describe('POST /api/caja/propina', () => {
  it.each([0, 1, 500, 750, 1000])('guarda %i puntos básicos', async (puntos) => {
    const m = mundo()
    expect((await m.tip(puntos)).statusCode).toBe(204)
    expect(m.configGuardada().suggested_tip).toBe(puntos)
    expect(m.catalog().restaurant.checkout?.suggestedTip).toBe(puntos)
    expect((await m.settings()).suggested_tip).toBe(puntos)
  })

  it.each([
    ['negative', -1],
    ['sobre el tope legal del 10 %', 1001],
    ['con decimales', 10.5],
    ['text', '1000'],
    ['null', null],
    ['NaN como texto', 'NaN'],
  ])('rechaza %s con 400 y el mensaje explica el rango', async (_, puntos) => {
    const m = mundo()
    const r = await m.tip(puntos)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'La propina sugerida va de 0 % a 10 %' })
    expect(m.configGuardada().suggested_tip).toBe(1000)
  })

  it('el mismo valor no sube la versión', async () => {
    const m = mundo()
    const v = m.catalog().version
    await m.tip(1000)
    expect(m.catalog().version).toBe(v)
  })
})

describe('POST /api/caja/configuracion', () => {
  it('devuelve los medios, la propina sugerida y los datáfonos (activos primero)', async () => {
    const m = mundo()
    const a = (await m.cardTerminal({ name: 'Zeta', provider: 'other', active: true })).json() as {
      id: string
    }
    await m.cardTerminal({ name: 'Bold 1', provider: 'bold', active: true })
    await m.cardTerminal({ id: a.id, name: 'Zeta', provider: 'other', active: false })
    const r = await m.settings()
    expect(r.payment_methods).toEqual(fullConfig().payment_methods)
    expect(r.suggested_tip).toBe(1000)
    expect(r.cardTerminals.map((d) => [d.name, d.provider, d.active])).toEqual([
      ['Bold 1', 'bold', true],
      ['Zeta', 'other', false],
    ])
  })

  it('no muestra los datáfonos de otro restaurante', async () => {
    const m = mundo()
    m.outsider()
    expect((await m.settings()).cardTerminals).toEqual([])
  })

  it('con campos de más, 400', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/register/config', { x: 1 })).statusCode).toBe(400)
  })
})

describe('POST /api/datafonos', () => {
  const bold = { name: 'Bold 1', provider: 'bold', active: true }

  it('crea un datáfono: devuelve su id y la lista, queda a nombre de quien lo creó y sube la versión', async () => {
    const m = mundo()
    const before = m.catalog().version
    const r = await m.cardTerminal(bold)
    expect(r.statusCode).toBe(200)
    const cuerpo = r.json() as { id: string; cardTerminals: { id: string; name: string }[] }
    expect(cuerpo.cardTerminals).toEqual([
      { id: cuerpo.id, name: 'Bold 1', provider: 'bold', active: true },
    ])
    expect(
      m.t.db.prepare('SELECT * FROM card_terminals WHERE id = ?').get(cuerpo.id),
    ).toMatchObject({
      user_id: m.t.people.admin.userId,
      device_id: m.admin.connection.deviceId,
      active: 1,
    })
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.cambiosCatalogo).toEqual([m.catalog().version])
    expect(m.catalog().cardTerminals).toEqual([{ id: cuerpo.id, name: 'Bold 1', provider: 'bold' }])
  })

  it.each(['bold', 'redeban', 'credibanco', 'other'])(
    'acepta el proveedor %s',
    async (provider) => {
      const m = mundo()
      expect((await m.cardTerminal({ ...bold, provider })).statusCode).toBe(200)
    },
  )

  it('el nombre se recorta, y a 60 caracteres pasa pero a 61 no', async () => {
    const m = mundo()
    const r = await m.cardTerminal({ ...bold, name: '   Bold   ' })
    expect((r.json() as { cardTerminals: { name: string }[] }).cardTerminals[0]?.name).toBe('Bold')
    expect((await m.cardTerminal({ ...bold, name: 'x'.repeat(60) })).statusCode).toBe(200)
    expect((await m.cardTerminal({ ...bold, name: 'y'.repeat(61) })).statusCode).toBe(400)
  })

  it.each([
    ['nombre vacío', { name: '' }],
    ['nombre de espacios', { name: '    ' }],
    ['nombre que no es texto', { name: 5 }],
    ['sin nombre', { name: undefined }],
    ['proveedor desconocido', { provider: 'visa' }],
    ['proveedor en mayúsculas', { provider: 'BOLD' }],
    ['sin proveedor', { provider: undefined }],
    ['activo como texto', { active: 'true' }],
    ['sin activo', { active: undefined }],
    ['id que no es ULID', { id: 'abc' }],
    ['campo de más', { color: 'rojo' }],
  ])('rechaza %s con 400 y no crea nada', async (_, change) => {
    const m = mundo()
    const r = await m.cardTerminal({ ...bold, ...change })
    expect(r.statusCode).toBe(400)
    expect((await m.settings()).cardTerminals).toEqual([])
  })

  it('sin el objeto datafono, 400', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/card-terminals', {})).statusCode).toBe(400)
    expect(
      (await m.llamar(m.admin, '/api/card-terminals', { cardTerminal: null })).statusCode,
    ).toBe(400)
  })

  it('nombre repetido entre activos: 400, sin importar mayúsculas ni tildes de más', async () => {
    const m = mundo()
    await m.cardTerminal(bold)
    for (const name of ['Bold 1', 'bold 1', 'BOLD 1']) {
      const r = await m.cardTerminal({ ...bold, name })
      expect(r.statusCode, name).toBe(400)
      expect(r.json()).toMatchObject({ message: 'Ya hay un datáfono con ese nombre' })
    }
    expect((await m.settings()).cardTerminals).toHaveLength(1)
  })

  it('dos nombres distintos conviven, y el mismo nombre en otro restaurante no cuenta', async () => {
    const m = mundo()
    m.outsider()
    expect((await m.cardTerminal({ ...bold, name: 'Bold bar' })).statusCode).toBe(200)
    expect((await m.cardTerminal({ ...bold, name: 'Bold ajeno' })).statusCode).toBe(200)
    expect((await m.settings()).cardTerminals).toHaveLength(2)
  })

  it('renombrar y guardar el mismo nombre del propio datáfono no cuenta como repetido', async () => {
    const m = mundo()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    expect((await m.cardTerminal({ ...bold, id })).statusCode).toBe(200)
    const r = await m.cardTerminal({ ...bold, id, name: 'Bold barra' })
    expect(r.statusCode).toBe(200)
    expect((await m.settings()).cardTerminals.map((d) => d.name)).toEqual(['Bold barra'])
  })

  it('renombrar a un nombre que ya tiene otro activo, 400', async () => {
    const m = mundo()
    await m.cardTerminal(bold)
    const { id } = (await m.cardTerminal({ ...bold, name: 'Bold 2' })).json() as { id: string }
    const r = await m.cardTerminal({ ...bold, id, name: 'bold 1' })
    expect(r.statusCode).toBe(400)
    expect((await m.settings()).cardTerminals.map((d) => d.name).sort()).toEqual([
      'Bold 1',
      'Bold 2',
    ])
  })

  it('editar sube la versión del datáfono y del contador; el id y la fecha de creación no cambian', async () => {
    const m = mundo()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    const before = m.t.db.prepare('SELECT * FROM card_terminals WHERE id = ?').get(id)
    m.t.advance(5000)
    await m.cardTerminal({ ...bold, id, name: 'Bold terraza', provider: 'redeban' })
    const after = m.t.db.prepare('SELECT * FROM card_terminals WHERE id = ?').get(id)
    expect(after).toMatchObject({ name: 'Bold terraza', provider: 'redeban', id })
    expect(Number(after?.version)).toBeGreaterThan(Number(before?.version))
    expect(after?.created_at).toBe(before?.created_at)
    expect(after?.updated_at).not.toBe(before?.updated_at)
  })

  it('archivar: activo false lo saca de la carta pero queda en la lista de caja, y no se borra', async () => {
    const m = mundo()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    const r = await m.cardTerminal({ ...bold, id, active: false })
    expect(r.statusCode).toBe(200)
    expect((await m.settings()).cardTerminals).toEqual([
      { id, name: 'Bold 1', provider: 'bold', active: false },
    ])
    expect(m.catalog().cardTerminals).toEqual([])
    expect(Number(m.t.db.prepare('SELECT count(*) AS n FROM card_terminals').get()?.n)).toBe(1)
  })

  it('volver a usar un archivado: activo true lo devuelve a la carta', async () => {
    const m = mundo()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    await m.cardTerminal({ ...bold, id, active: false })
    const r = await m.cardTerminal({ ...bold, id, active: true })
    expect(r.statusCode).toBe(200)
    expect(m.catalog().cardTerminals).toEqual([{ id, name: 'Bold 1', provider: 'bold' }])
  })

  it('un archivado no estorba el nombre: se puede crear otro con el mismo', async () => {
    const m = mundo()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    await m.cardTerminal({ ...bold, id, active: false })
    expect((await m.cardTerminal(bold)).statusCode).toBe(200)
  })

  it('pero reactivar el archivado cuando ya hay otro activo con ese nombre, 400', async () => {
    const m = mundo()
    const { id } = (await m.cardTerminal(bold)).json() as { id: string }
    await m.cardTerminal({ ...bold, id, active: false })
    await m.cardTerminal(bold)
    const r = await m.cardTerminal({ ...bold, id, active: true })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'Ya hay un datáfono con ese nombre' })
    expect((await m.settings()).cardTerminals.filter((d) => d.active)).toHaveLength(1)
  })

  it('renombrar un archivado a un nombre en uso se permite mientras siga archivado', async () => {
    const m = mundo()
    await m.cardTerminal(bold)
    const { id } = (await m.cardTerminal({ ...bold, name: 'Bold 2' })).json() as { id: string }
    await m.cardTerminal({ ...bold, name: 'Bold 2', id, active: false })
    expect((await m.cardTerminal({ ...bold, id, name: 'Bold 1', active: false })).statusCode).toBe(
      200,
    )
  })

  it('un id que no existe, 400 y no crea nada', async () => {
    const m = mundo()
    const r = await m.cardTerminal({ ...bold, id: newId() })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'Ese datáfono no existe' })
    expect((await m.settings()).cardTerminals).toEqual([])
  })

  it('el id de un datáfono de OTRO restaurante, 400, y el ajeno queda intacto', async () => {
    const m = mundo()
    const outsider = m.outsider()
    const before = m.t.db
      .prepare('SELECT * FROM card_terminals WHERE id = ?')
      .get(outsider.datafonoId)
    const r = await m.cardTerminal({ ...bold, id: outsider.datafonoId, name: 'Robado' })
    expect(r.statusCode).toBe(400)
    expect(
      m.t.db.prepare('SELECT * FROM card_terminals WHERE id = ?').get(outsider.datafonoId),
    ).toEqual(before)
    expect((await m.settings()).cardTerminals).toEqual([])
  })

  it('un rechazo no sube la versión del catálogo ni avisa a los equipos', async () => {
    const m = mundo()
    await m.cardTerminal(bold)
    const v = m.catalog().version
    const alerts = m.t.cambiosCatalogo.length
    await m.cardTerminal(bold)
    await m.cardTerminal({ ...bold, id: newId() })
    expect(m.catalog().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(alerts)
  })

  it('dos peticiones iguales a la vez no dejan dos datáfonos con el mismo nombre', async () => {
    const m = mundo()
    const [a, b] = await Promise.all([m.cardTerminal(bold), m.cardTerminal(bold)])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400])
    expect((await m.settings()).cardTerminals).toHaveLength(1)
  })
})

describe('POST /api/caja/medios-propios', () => {
  type Respuesta = { id: string; custom_methods: { id: string; name: string; active: boolean }[] }
  const save = (m: Mundo, method: Json, e: Equipo = m.admin) =>
    m.llamar(e, '/api/register/custom-methods', { method })

  it('crea un medio: devuelve su id y la lista, queda en la configuración y en la carta', async () => {
    const m = mundo()
    const before = m.catalog().version
    const r = await save(m, { name: 'Sodexo', active: true })
    expect(r.statusCode).toBe(200)
    const cuerpo = r.json() as Respuesta
    expect(cuerpo.custom_methods).toEqual([{ id: cuerpo.id, name: 'Sodexo', active: true }])
    expect(m.configGuardada().custom_methods).toEqual(cuerpo.custom_methods)
    expect(m.catalog().restaurant.checkout?.customMethods).toEqual([
      { id: cuerpo.id, name: 'Sodexo' },
    ])
    expect(m.catalog().version).toBeGreaterThan(before)
    expect((await m.settings()) as unknown).toMatchObject({ custom_methods: cuerpo.custom_methods })
  })

  it('el nombre se recorta; vacío, de espacios o de más de 30 letras, 400', async () => {
    const m = mundo()
    const r = (await save(m, { name: '  QR  ', active: true })).json() as Respuesta
    expect(r.custom_methods[0]?.name).toBe('QR')
    for (const name of ['', '    ', 'x'.repeat(31), 5])
      expect((await save(m, { name, active: true })).statusCode, String(name)).toBe(400)
    expect((await save(m, { name: 'x'.repeat(30), active: true })).statusCode).toBe(200)
  })

  it('campos de más, sin activo o con un id que no es ULID, 400', async () => {
    const m = mundo()
    expect((await save(m, { name: 'A', active: true, color: 'r' })).statusCode).toBe(400)
    expect((await save(m, { name: 'A' })).statusCode).toBe(400)
    expect((await save(m, { id: 'abc', name: 'A', active: true })).statusCode).toBe(400)
    expect((await m.llamar(m.admin, '/api/register/custom-methods', {})).statusCode).toBe(400)
  })

  it('nombre repetido entre activos (sin importar mayúsculas), 400; un archivado no estorba', async () => {
    const m = mundo()
    const a = (await save(m, { name: 'Sodexo', active: true })).json() as Respuesta
    const r = await save(m, { name: 'SODEXO', active: true })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'Ya hay un medio con ese nombre' })
    await save(m, { id: a.id, name: 'Sodexo', active: false })
    expect((await save(m, { name: 'Sodexo', active: true })).statusCode).toBe(200)
    // Reactivar el archivado cuando ya hay uno activo con ese nombre.
    expect((await save(m, { id: a.id, name: 'Sodexo', active: true })).statusCode).toBe(400)
  })

  it('renombrar, archivar y volver a usar; el archivado sale de la carta pero queda en la configuración', async () => {
    const m = mundo()
    const a = (await save(m, { name: 'Sodexo', active: true })).json() as Respuesta
    await save(m, { id: a.id, name: 'Sodexo Pass', active: true })
    expect(m.catalog().restaurant.checkout?.customMethods?.[0]?.name).toBe('Sodexo Pass')
    await save(m, { id: a.id, name: 'Sodexo Pass', active: false })
    expect(m.catalog().restaurant.checkout?.customMethods).toEqual([])
    // El archivado ya no sale al cobrar, pero la carta lo manda para nombrar sus pagos (1.8).
    expect(m.catalog().restaurant.checkout?.archivedCustomMethods).toEqual([
      { id: a.id, name: 'Sodexo Pass' },
    ])
    expect(m.configGuardada().custom_methods).toEqual([
      { id: a.id, name: 'Sodexo Pass', active: false },
    ])
    await save(m, { id: a.id, name: 'Sodexo Pass', active: true })
    expect(m.catalog().restaurant.checkout?.customMethods).toHaveLength(1)
    expect(m.catalog().restaurant.checkout?.archivedCustomMethods).toEqual([])
  })

  it('un id que no existe, 400', async () => {
    const m = mundo()
    const r = await save(m, { id: newId(), name: 'A', active: true })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ message: 'Ese medio no existe' })
  })

  it('máximo 20 medios propios: el 21 se rechaza', async () => {
    const m = mundo()
    for (let i = 0; i < 20; i++)
      expect((await save(m, { name: `Medio ${i}`, active: true })).statusCode).toBe(200)
    const r = await save(m, { name: 'Uno más', active: true })
    expect(r.statusCode).toBe(400)
    expect(m.configGuardada().custom_methods).toHaveLength(20)
  })

  it('guardar los mismos datos de un medio existente no sube la versión', async () => {
    const m = mundo()
    const a = (await save(m, { name: 'Sodexo', active: true })).json() as Respuesta
    const v = m.catalog().version
    await save(m, { id: a.id, name: 'Sodexo', active: true })
    expect(m.catalog().version).toBe(v)
  })

  it('cajero, gerente y mesero, 403 y no crean nada', async () => {
    const m = mundo()
    for (const who of ['cashier', 'manager', 'waiter'] as const)
      expect((await save(m, { name: 'A', active: true }, m[who])).statusCode).toBe(403)
    expect(m.configGuardada().custom_methods).toEqual([])
  })

  it('los medios propios y los de fábrica conviven: cambiar uno no toca el otro', async () => {
    const m = mundo()
    await save(m, { name: 'Sodexo', active: true })
    await m.methods(['cash', 'nequi'])
    expect(m.configGuardada().custom_methods).toHaveLength(1)
    await save(m, { name: 'QR', active: true })
    expect(m.configGuardada().payment_methods).toEqual(['cash', 'nequi'])
  })

  // BUG: `/api/caja/medios` acepta «otro» en el esquema (z.array(PaymentMethod)) pero `fullConfig`
  // lo rechaza al guardar y la ruta responde 500 en vez de 400.
  // apps/hub/src/impresion/rutas.ts:561 (esquema de `medios` / `actualizarConfig`).
  it('/api/caja/medios rechaza «otro» con 400 (no con un error del servidor)', async () => {
    const m = mundo()
    const r = await m.methods(['cash', 'other'])
    expect(r.statusCode).toBe(400)
    expect(m.configGuardada().payment_methods).not.toContain('other')
  })
})
