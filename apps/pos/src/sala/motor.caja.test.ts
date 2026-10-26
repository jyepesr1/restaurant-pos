import 'fake-indexeddb/auto'
import { type NewEvent, newId, signEvent, validateNewEvent } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { turnoDeCaja } from './cuentas'
import { type Device, Sala, type Session } from './motor'
import { catalogoDePrueba } from './pruebas'

// «Caja y pagos» y abrir turno en el motor (tarea 1.6): cada método llama a su ruta con el token del
// equipo y la sesión, y los errores del hub llegan tal cual.

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of bases.splice(0)) await b.delete()
})

const sinRed = (): Channel => ({ send: () => {}, close: () => {} })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  body: Record<string, unknown> | null
  token: string | null
  httpMethod: string
}

function hubFalso(responder: (l: Call) => Response = () => new Response(null, { status: 204 })) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const llamada: Call = {
        url,
        httpMethod: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      calls.push(llamada)
      if (url === '/api/catalog') return json(catalogoDePrueba({ version: 9 }))
      return responder(llamada)
    }),
  )
  return calls
}

const device: Device = {
  deviceId: newId(),
  token: 'token-caja',
  name: 'Caja 1',
  type: 'register',
}
const session = (): Session => ({
  sessionId: newId(),
  secret: 'secreto-carlos',
  user: { id: newId(), name: 'Carlos', role: 'Cajero' },
  permissions: ['record_payment', 'open_register_shift', 'manage_devices'],
  lastUsed: Date.now(),
})

async function open(sinConexion = false) {
  const db = new BaseDispositivo(`register-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', device)
  const s = session()
  await db.saveSetting('session', s)
  await db.saveSetting('catalog', catalogoDePrueba())
  const floor = new Sala({ db, open: sinRed })
  salas.push(floor)
  if (sinConexion) floor.simularSinConexion(true)
  await floor.load()
  return { floor, session: s }
}

const deRuta = (l: Call[], route: string) => l.filter((x) => x.url === route)
const locals = async (s: Sala) => (await s.sync?.locals()) ?? []

describe('métodos de «Caja y pagos»: ruta, token y sesión', () => {
  it.each([
    ['registerConfig', '/api/register/config', (s: Sala) => s.registerConfig(), {}],
    [
      'savePaymentMethods',
      '/api/register/payment-methods',
      (s: Sala) => s.savePaymentMethods(['cash', 'nequi']),
      { methods: ['cash', 'nequi'] },
    ],
    ['suggestedTip', '/api/register/tip', (s: Sala) => s.suggestedTip(750), { points: 750 }],
    [
      'preBillPrinter',
      '/api/register/pre-bill',
      (s: Sala) => s.preBillPrinter('I'.repeat(26)),
      { printer_id: 'I'.repeat(26) },
    ],
    [
      'impresoraPrecuenta (quitar)',
      '/api/register/pre-bill',
      (s: Sala) => s.preBillPrinter(null),
      { printer_id: null },
    ],
  ])('%s llama a %s con el token del equipo y la sesión', async (_n, route, makeCall, extra) => {
    const calls = hubFalso(() =>
      json({ payment_methods: [], suggested_tip: 1000, custom_methods: [], cardTerminals: [] }),
    )
    const { floor, session: s } = await open()
    await makeCall(floor)
    const [l, ...otras] = deRuta(calls, route)
    expect(otras).toEqual([])
    expect(l).toMatchObject({
      httpMethod: 'POST',
      token: 'token-caja',
      body: { session_id: s.sessionId, secret: 'secreto-carlos', ...extra },
    })
  })

  it('configuracionCaja devuelve lo que contesta el hub', async () => {
    const response = {
      payment_methods: ['cash', 'nequi'],
      suggested_tip: 1000,
      custom_methods: [{ id: 'm', name: 'Sodexo', active: true }],
      cardTerminals: [{ id: 'd', name: 'Bold 1', provider: 'bold', active: true }],
    }
    hubFalso(() => json(response))
    const { floor } = await open()
    await expect(floor.registerConfig()).resolves.toEqual(response)
  })

  it('guardarDatafono manda el datáfono y devuelve la lista nueva', async () => {
    const list = [{ id: 'd'.repeat(26), name: 'Bold 1', provider: 'bold', active: true }]
    const calls = hubFalso(() => json({ id: list[0]?.id, cardTerminals: list }))
    const { floor } = await open()
    const cardTerminal = { name: 'Bold 1', provider: 'bold' as const, active: true }
    await expect(floor.guardarDatafono(cardTerminal)).resolves.toEqual(list)
    expect(deRuta(calls, '/api/card-terminals')[0]).toMatchObject({
      token: 'token-caja',
      body: { cardTerminal },
    })
  })

  it('guardarMedioPropio manda el medio y devuelve la lista nueva', async () => {
    const list = [{ id: 'm'.repeat(26), name: 'Sodexo', active: true }]
    const calls = hubFalso(() => json({ id: list[0]?.id, custom_methods: list }))
    const { floor } = await open()
    const method = { name: 'Sodexo', active: true }
    await expect(floor.guardarMedioPropio(method)).resolves.toEqual(list)
    expect(deRuta(calls, '/api/register/custom-methods')[0]).toMatchObject({
      token: 'token-caja',
      body: { method },
    })
  })

  it('un error del hub (sin permiso, nombre repetido) llega como error con su código', async () => {
    hubFalso(() => json({ error: 'no_permission', message: 'No tienes permiso' }, 403))
    const { floor } = await open()
    await expect(floor.savePaymentMethods(['cash'])).rejects.toMatchObject({
      code: 'no_permission',
    })
    await expect(floor.suggestedTip(500)).rejects.toMatchObject({ code: 'no_permission' })
    await expect(floor.registerConfig()).rejects.toMatchObject({ code: 'no_permission' })
    hubFalso(() =>
      json({ error: 'invalid_data', message: 'Ya hay un datáfono con ese nombre' }, 400),
    )
    const another = await open()
    await expect(
      another.floor.guardarDatafono({ name: 'Bold 1', provider: 'bold', active: true }),
    ).rejects.toMatchObject({
      code: 'invalid_data',
      message: 'Ya hay un datáfono con ese nombre',
    })
  })

  it('una sesión inválida cierra la sesión del equipo', async () => {
    hubFalso(() => json({ error: 'invalid_session', message: 'Vuelve a entrar' }, 401))
    const { floor } = await open()
    await expect(floor.registerConfig()).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.instantanea().session).toBeNull()
  })

  it('sin conexión con la caja, todos fallan con sin_conexion y no llaman al hub', async () => {
    const calls = hubFalso()
    const { floor } = await open(true)
    const before = calls.length
    for (const f of [
      () => floor.registerConfig(),
      () => floor.savePaymentMethods(['cash']),
      () => floor.suggestedTip(0),
      () => floor.preBillPrinter(null),
      () => floor.guardarDatafono({ name: 'B', provider: 'other', active: true }),
      () => floor.guardarMedioPropio({ name: 'S', active: true }),
    ])
      await expect(f()).rejects.toMatchObject({ code: 'offline' })
    expect(calls.length).toBe(before)
  })

  it('sin sesión fallan sin llamar al hub', async () => {
    const calls = hubFalso()
    const { floor } = await open()
    await floor.exit()
    const before = calls.length
    await expect(floor.registerConfig()).rejects.toThrow(/Sin sesión/)
    expect(calls.length).toBe(before)
  })
})

describe('Sala.abrirTurno', () => {
  it('guarda un TurnoAbierto firmado, del agregado turno_caja, con la caja de este equipo y la base', async () => {
    hubFalso()
    const { floor, session: s } = await open(true)
    const shiftId = await floor.openShift(200_000)
    const savedList = await locals(floor)
    expect(savedList).toHaveLength(1)
    const [l] = savedList
    const e = l?.event as NewEvent
    expect(l?.status).toBe('pending')
    expect(e).toMatchObject({
      type: 'ShiftOpened',
      aggregate_type: 'register_shift',
      aggregate_id: shiftId,
      data: { register_id: device.deviceId, base: 200_000 },
      device_id: device.deviceId,
      user_id: s.user.id,
      session_id: s.sessionId,
      related: [],
    })
    const { signature, ...unsigned } = e
    expect(signature).toBe(signEvent(unsigned as NewEvent, 'secreto-carlos'))
    expect(validateNewEvent(e).ok).toBe(true)
  })

  it('el turno se ve en la proyección (por confirmar) antes de que el hub responda', async () => {
    hubFalso()
    const { floor } = await open(true)
    const shiftId = await floor.openShift(50_000)
    expect(turnoDeCaja(await locals(floor), device.deviceId)).toMatchObject({
      id: shiftId,
      base: 50_000,
      porConfirmar: true,
    })
  })

  it('una base de $0 es válida; una negativa o con decimales no se guarda', async () => {
    hubFalso()
    const { floor } = await open(true)
    await expect(floor.openShift(0)).resolves.toBeTruthy()
    await expect(floor.openShift(-1)).rejects.toThrow(/Evento inválido/)
    await expect(floor.openShift(10.5)).rejects.toThrow(/Evento inválido/)
    expect(await locals(floor)).toHaveLength(1)
  })

  it('sin sesión no abre turno', async () => {
    hubFalso()
    const { floor } = await open(true)
    await floor.exit()
    await expect(floor.openShift(1_000)).rejects.toThrow(/Sin sesión/)
  })

  it('cada llamada es un turno nuevo con su propio id', async () => {
    hubFalso()
    const { floor } = await open(true)
    const a = await floor.openShift(1)
    const b = await floor.openShift(2)
    expect(a).not.toBe(b)
  })
})
