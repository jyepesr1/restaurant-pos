import 'fake-indexeddb/auto'
import { type NewEvent, newId, signEvent, validateNewEvent } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shiftOfRegister } from './checks'
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { testCatalog } from './testing'

// «Caja y pagos» and opening a shift in the engine (task 1.6): each method calls its route with the
// device token and the session, and the hub's errors arrive as they are.

const floors: Floor[] = []
const databases: DeviceDatabase[] = []
afterEach(async () => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of databases.splice(0)) await b.delete()
})

const noNetwork = (): Channel => ({ send: () => {}, close: () => {} })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  body: Record<string, unknown> | null
  token: string | null
  httpMethod: string
}

function fakeHub(respond: (l: Call) => Response = () => new Response(null, { status: 204 })) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const call: Call = {
        url,
        httpMethod: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      calls.push(call)
      if (url === '/api/catalog') return json(testCatalog({ version: 9 }))
      return respond(call)
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

async function open(noConnection = false) {
  const db = new DeviceDatabase(`register-${newId()}`)
  databases.push(db)
  await db.saveSetting('device', device)
  const s = session()
  await db.saveSetting('session', s)
  await db.saveSetting('catalog', testCatalog())
  const floor = new Floor({ db, open: noNetwork })
  floors.push(floor)
  if (noConnection) floor.simulateOffline(true)
  await floor.load()
  return { floor, session: s }
}

const forRoute = (l: Call[], route: string) => l.filter((x) => x.url === route)
const locals = async (s: Floor) => (await s.sync?.locals()) ?? []

describe('«Caja y pagos» methods: route, token and session', () => {
  it.each([
    ['registerConfig', '/api/register/config', (s: Floor) => s.registerConfig(), {}],
    [
      'savePaymentMethods',
      '/api/register/payment-methods',
      (s: Floor) => s.savePaymentMethods(['cash', 'nequi']),
      { methods: ['cash', 'nequi'] },
    ],
    ['suggestedTip', '/api/register/tip', (s: Floor) => s.suggestedTip(750), { points: 750 }],
    [
      'preBillPrinter',
      '/api/register/pre-bill',
      (s: Floor) => s.preBillPrinter('I'.repeat(26)),
      { printer_id: 'I'.repeat(26) },
    ],
    [
      'preBillPrinter (clear)',
      '/api/register/pre-bill',
      (s: Floor) => s.preBillPrinter(null),
      { printer_id: null },
    ],
  ])('%s calls %s with the device token and the session', async (_n, route, makeCall, extra) => {
    const calls = fakeHub(() =>
      json({ payment_methods: [], suggested_tip: 1000, custom_methods: [], cardTerminals: [] }),
    )
    const { floor, session: s } = await open()
    await makeCall(floor)
    const [l, ...others] = forRoute(calls, route)
    expect(others).toEqual([])
    expect(l).toMatchObject({
      httpMethod: 'POST',
      token: 'token-caja',
      body: { session_id: s.sessionId, secret: 'secreto-carlos', ...extra },
    })
  })

  it('registerConfig returns what the hub answers', async () => {
    const response = {
      payment_methods: ['cash', 'nequi'],
      suggested_tip: 1000,
      custom_methods: [{ id: 'm', name: 'Sodexo', active: true }],
      cardTerminals: [{ id: 'd', name: 'Bold 1', provider: 'bold', active: true }],
    }
    fakeHub(() => json(response))
    const { floor } = await open()
    await expect(floor.registerConfig()).resolves.toEqual(response)
  })

  it('saveCardTerminal sends the card terminal and returns the new list', async () => {
    const list = [{ id: 'd'.repeat(26), name: 'Bold 1', provider: 'bold', active: true }]
    const calls = fakeHub(() => json({ id: list[0]?.id, cardTerminals: list }))
    const { floor } = await open()
    const cardTerminal = { name: 'Bold 1', provider: 'bold' as const, active: true }
    await expect(floor.saveCardTerminal(cardTerminal)).resolves.toEqual(list)
    expect(forRoute(calls, '/api/card-terminals')[0]).toMatchObject({
      token: 'token-caja',
      body: { cardTerminal },
    })
  })

  it('saveCustomMethod sends the method and returns the new list', async () => {
    const list = [{ id: 'm'.repeat(26), name: 'Sodexo', active: true }]
    const calls = fakeHub(() => json({ id: list[0]?.id, custom_methods: list }))
    const { floor } = await open()
    const method = { name: 'Sodexo', active: true }
    await expect(floor.saveCustomMethod(method)).resolves.toEqual(list)
    expect(forRoute(calls, '/api/register/custom-methods')[0]).toMatchObject({
      token: 'token-caja',
      body: { method },
    })
  })

  it('a hub error (no permission, duplicate name) arrives as an error with its code', async () => {
    fakeHub(() => json({ error: 'no_permission', message: 'No tienes permiso' }, 403))
    const { floor } = await open()
    await expect(floor.savePaymentMethods(['cash'])).rejects.toMatchObject({
      code: 'no_permission',
    })
    await expect(floor.suggestedTip(500)).rejects.toMatchObject({ code: 'no_permission' })
    await expect(floor.registerConfig()).rejects.toMatchObject({ code: 'no_permission' })
    fakeHub(() =>
      json({ error: 'invalid_data', message: 'Ya hay un datáfono con ese nombre' }, 400),
    )
    const another = await open()
    await expect(
      another.floor.saveCardTerminal({ name: 'Bold 1', provider: 'bold', active: true }),
    ).rejects.toMatchObject({
      code: 'invalid_data',
      message: 'Ya hay un datáfono con ese nombre',
    })
  })

  it('an invalid session signs the device out', async () => {
    fakeHub(() => json({ error: 'invalid_session', message: 'Vuelve a entrar' }, 401))
    const { floor } = await open()
    await expect(floor.registerConfig()).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.snapshot().session).toBeNull()
  })

  it('with no connection to the register, all fail with offline and do not call the hub', async () => {
    const calls = fakeHub()
    const { floor } = await open(true)
    const before = calls.length
    for (const f of [
      () => floor.registerConfig(),
      () => floor.savePaymentMethods(['cash']),
      () => floor.suggestedTip(0),
      () => floor.preBillPrinter(null),
      () => floor.saveCardTerminal({ name: 'B', provider: 'other', active: true }),
      () => floor.saveCustomMethod({ name: 'S', active: true }),
    ])
      await expect(f()).rejects.toMatchObject({ code: 'offline' })
    expect(calls.length).toBe(before)
  })

  it('without a session they fail without calling the hub', async () => {
    const calls = fakeHub()
    const { floor } = await open()
    await floor.exit()
    const before = calls.length
    await expect(floor.registerConfig()).rejects.toThrow(/Sin sesión/)
    expect(calls.length).toBe(before)
  })
})

describe('Floor.openShift', () => {
  it('saves a signed ShiftOpened, of the register_shift aggregate, with this device as the register and the base', async () => {
    fakeHub()
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

  it('the shift shows in the projection (pending confirmation) before the hub responds', async () => {
    fakeHub()
    const { floor } = await open(true)
    const shiftId = await floor.openShift(50_000)
    expect(shiftOfRegister(await locals(floor), device.deviceId)).toMatchObject({
      id: shiftId,
      base: 50_000,
      pendingConfirmation: true,
    })
  })

  it('a $0 base is valid; a negative one or one with decimals is not saved', async () => {
    fakeHub()
    const { floor } = await open(true)
    await expect(floor.openShift(0)).resolves.toBeTruthy()
    await expect(floor.openShift(-1)).rejects.toThrow(/Evento inválido/)
    await expect(floor.openShift(10.5)).rejects.toThrow(/Evento inválido/)
    expect(await locals(floor)).toHaveLength(1)
  })

  it('without a session it does not open a shift', async () => {
    fakeHub()
    const { floor } = await open(true)
    await floor.exit()
    await expect(floor.openShift(1_000)).rejects.toThrow(/Sin sesión/)
  })

  it('each call is a new shift with its own id', async () => {
    fakeHub()
    const { floor } = await open(true)
    const a = await floor.openShift(1)
    const b = await floor.openShift(2)
    expect(a).not.toBe(b)
  })
})
