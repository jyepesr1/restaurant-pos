import 'fake-indexeddb/auto'
import { type NewEvent, newId, signEvent, validateNewEvent } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { turnoDeCaja } from './cuentas'
import { type Equipo, Sala, type Sesion } from './motor'
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
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

interface Llamada {
  url: string
  cuerpo: Record<string, unknown> | null
  token: string | null
  metodo: string
}

function hubFalso(responder: (l: Llamada) => Response = () => new Response(null, { status: 204 })) {
  const llamadas: Llamada[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const llamada: Llamada = {
        url,
        metodo: init?.method ?? 'GET',
        cuerpo: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      llamadas.push(llamada)
      if (url === '/api/catalog') return json(catalogoDePrueba({ version: 9 }))
      return responder(llamada)
    }),
  )
  return llamadas
}

const device: Equipo = {
  dispositivoId: newId(),
  token: 'token-caja',
  name: 'Caja 1',
  type: 'register',
}
const session = (): Sesion => ({
  sesionId: newId(),
  secret: 'secreto-carlos',
  user: { id: newId(), name: 'Carlos', role: 'Cajero' },
  permissions: ['record_payment', 'open_register_shift', 'manage_devices'],
  ultimoUso: Date.now(),
})

async function open(sinConexion = false) {
  const db = new BaseDispositivo(`register-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', device)
  const s = session()
  await db.saveSetting('session', s)
  await db.saveSetting('catalog', catalogoDePrueba())
  const sala = new Sala({ db, open: sinRed })
  salas.push(sala)
  if (sinConexion) sala.simularSinConexion(true)
  await sala.cargar()
  return { sala, session: s }
}

const deRuta = (l: Llamada[], ruta: string) => l.filter((x) => x.url === ruta)
const locales = async (s: Sala) => (await s.sync?.locales()) ?? []

describe('métodos de «Caja y pagos»: ruta, token y sesión', () => {
  it.each([
    ['registerConfig', '/api/register/config', (s: Sala) => s.registerConfig(), {}],
    [
      'savePaymentMethods',
      '/api/register/payment-methods',
      (s: Sala) => s.savePaymentMethods(['cash', 'nequi']),
      { medios: ['cash', 'nequi'] },
    ],
    ['suggestedTip', '/api/register/tip', (s: Sala) => s.suggestedTip(750), { puntos: 750 }],
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
  ])('%s llama a %s con el token del equipo y la sesión', async (_n, ruta, llamar, extra) => {
    const llamadas = hubFalso(() =>
      json({ payment_methods: [], suggested_tip: 1000, custom_methods: [], cardTerminals: [] }),
    )
    const { sala, session: s } = await open()
    await llamar(sala)
    const [l, ...otras] = deRuta(llamadas, ruta)
    expect(otras).toEqual([])
    expect(l).toMatchObject({
      metodo: 'POST',
      token: 'token-caja',
      cuerpo: { session_id: s.sesionId, secret: 'secreto-carlos', ...extra },
    })
  })

  it('configuracionCaja devuelve lo que contesta el hub', async () => {
    const respuesta = {
      payment_methods: ['cash', 'nequi'],
      suggested_tip: 1000,
      custom_methods: [{ id: 'm', name: 'Sodexo', active: true }],
      cardTerminals: [{ id: 'd', name: 'Bold 1', provider: 'bold', active: true }],
    }
    hubFalso(() => json(respuesta))
    const { sala } = await open()
    await expect(sala.registerConfig()).resolves.toEqual(respuesta)
  })

  it('guardarDatafono manda el datáfono y devuelve la lista nueva', async () => {
    const list = [{ id: 'd'.repeat(26), name: 'Bold 1', provider: 'bold', active: true }]
    const llamadas = hubFalso(() => json({ id: list[0]?.id, cardTerminals: list }))
    const { sala } = await open()
    const cardTerminal = { name: 'Bold 1', provider: 'bold' as const, active: true }
    await expect(sala.guardarDatafono(cardTerminal)).resolves.toEqual(list)
    expect(deRuta(llamadas, '/api/card-terminals')[0]).toMatchObject({
      token: 'token-caja',
      cuerpo: { cardTerminal },
    })
  })

  it('guardarMedioPropio manda el medio y devuelve la lista nueva', async () => {
    const list = [{ id: 'm'.repeat(26), name: 'Sodexo', active: true }]
    const llamadas = hubFalso(() => json({ id: list[0]?.id, custom_methods: list }))
    const { sala } = await open()
    const method = { name: 'Sodexo', active: true }
    await expect(sala.guardarMedioPropio(method)).resolves.toEqual(list)
    expect(deRuta(llamadas, '/api/register/custom-methods')[0]).toMatchObject({
      token: 'token-caja',
      cuerpo: { method },
    })
  })

  it('un error del hub (sin permiso, nombre repetido) llega como error con su código', async () => {
    hubFalso(() => json({ error: 'no_permission', message: 'No tienes permiso' }, 403))
    const { sala } = await open()
    await expect(sala.savePaymentMethods(['cash'])).rejects.toMatchObject({ code: 'no_permission' })
    await expect(sala.suggestedTip(500)).rejects.toMatchObject({ code: 'no_permission' })
    await expect(sala.registerConfig()).rejects.toMatchObject({ code: 'no_permission' })
    hubFalso(() =>
      json({ error: 'invalid_data', message: 'Ya hay un datáfono con ese nombre' }, 400),
    )
    const another = await open()
    await expect(
      another.sala.guardarDatafono({ name: 'Bold 1', provider: 'bold', active: true }),
    ).rejects.toMatchObject({
      code: 'invalid_data',
      message: 'Ya hay un datáfono con ese nombre',
    })
  })

  it('una sesión inválida cierra la sesión del equipo', async () => {
    hubFalso(() => json({ error: 'invalid_session', message: 'Vuelve a entrar' }, 401))
    const { sala } = await open()
    await expect(sala.registerConfig()).rejects.toMatchObject({ code: 'invalid_session' })
    expect(sala.instantanea().session).toBeNull()
  })

  it('sin conexión con la caja, todos fallan con sin_conexion y no llaman al hub', async () => {
    const llamadas = hubFalso()
    const { sala } = await open(true)
    const before = llamadas.length
    for (const f of [
      () => sala.registerConfig(),
      () => sala.savePaymentMethods(['cash']),
      () => sala.suggestedTip(0),
      () => sala.preBillPrinter(null),
      () => sala.guardarDatafono({ name: 'B', provider: 'other', active: true }),
      () => sala.guardarMedioPropio({ name: 'S', active: true }),
    ])
      await expect(f()).rejects.toMatchObject({ code: 'offline' })
    expect(llamadas.length).toBe(before)
  })

  it('sin sesión fallan sin llamar al hub', async () => {
    const llamadas = hubFalso()
    const { sala } = await open()
    await sala.exit()
    const before = llamadas.length
    await expect(sala.registerConfig()).rejects.toThrow(/Sin sesión/)
    expect(llamadas.length).toBe(before)
  })
})

describe('Sala.abrirTurno', () => {
  it('guarda un TurnoAbierto firmado, del agregado turno_caja, con la caja de este equipo y la base', async () => {
    hubFalso()
    const { sala, session: s } = await open(true)
    const shiftId = await sala.abrirTurno(200_000)
    const guardados = await locales(sala)
    expect(guardados).toHaveLength(1)
    const [l] = guardados
    const e = l?.event as NewEvent
    expect(l?.status).toBe('pending')
    expect(e).toMatchObject({
      type: 'ShiftOpened',
      aggregate_type: 'register_shift',
      aggregate_id: shiftId,
      data: { register_id: device.dispositivoId, base: 200_000 },
      device_id: device.dispositivoId,
      user_id: s.user.id,
      session_id: s.sesionId,
      related: [],
    })
    const { signature, ...sinFirma } = e
    expect(signature).toBe(signEvent(sinFirma as NewEvent, 'secreto-carlos'))
    expect(validateNewEvent(e).ok).toBe(true)
  })

  it('el turno se ve en la proyección (por confirmar) antes de que el hub responda', async () => {
    hubFalso()
    const { sala } = await open(true)
    const shiftId = await sala.abrirTurno(50_000)
    expect(turnoDeCaja(await locales(sala), device.dispositivoId)).toMatchObject({
      id: shiftId,
      base: 50_000,
      porConfirmar: true,
    })
  })

  it('una base de $0 es válida; una negativa o con decimales no se guarda', async () => {
    hubFalso()
    const { sala } = await open(true)
    await expect(sala.abrirTurno(0)).resolves.toBeTruthy()
    await expect(sala.abrirTurno(-1)).rejects.toThrow(/Evento inválido/)
    await expect(sala.abrirTurno(10.5)).rejects.toThrow(/Evento inválido/)
    expect(await locales(sala)).toHaveLength(1)
  })

  it('sin sesión no abre turno', async () => {
    hubFalso()
    const { sala } = await open(true)
    await sala.exit()
    await expect(sala.abrirTurno(1_000)).rejects.toThrow(/Sin sesión/)
  })

  it('cada llamada es un turno nuevo con su propio id', async () => {
    hubFalso()
    const { sala } = await open(true)
    const a = await sala.abrirTurno(1)
    const b = await sala.abrirTurno(2)
    expect(a).not.toBe(b)
  })
})
