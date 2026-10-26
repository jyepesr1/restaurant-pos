import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { testCatalog } from './testing'

// The app engine on sign-in (task 1.3b, ADR-013) when the hub is missing, the token is invalid or
// the device was removed. The hub is a fake `fetch` that can be changed on the fly.

const floors: Floor[] = []
afterEach(() => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  vi.unstubAllGlobals()
})

const noNetwork = (): Channel => ({ send: () => {}, close: () => {} })
const json = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const newDevice = (n = 'a'): Device => ({
  deviceId: newId(),
  token: `token-${n}`,
  name: 'Equipo de Ana',
  type: 'waiter',
})
const entry = (device: Device | null, type = 'waiter') => ({
  device: device && {
    device_id: device.deviceId,
    token: device.token,
    name: device.name,
    type: device.type,
  },
  type,
  session_id: newId(),
  secret: 'secret',
  user: { id: newId(), name: 'Ana', role: 'Mesero' },
  permissions: ['take_order'],
})

type Responder = (url: string, body: unknown, token: string | null) => Response | Promise<Response>
function fakeHub(respond: Responder) {
  const calls: { url: string; body: unknown; token: string | null }[] = []
  const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const token =
      (init?.headers as Record<string, string> | undefined)?.authorization?.replace(
        'Bearer ',
        '',
      ) ?? null
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body, token })
    if (url === '/api/catalog') return json(testCatalog(), 200)
    return respond(url, body, token)
  })
  vi.stubGlobal('fetch', fakeFetch)
  return { calls, fakeFetch }
}

async function open(device?: Device, session?: Session) {
  const db = new DeviceDatabase(`prueba-${newId()}`)
  if (device) await db.saveSetting('device', device)
  if (session) await db.saveSetting('session', session)
  const floor = new Floor({ db, open: noNetwork })
  floors.push(floor)
  await floor.load()
  return { floor, db }
}

const oneSession = (): Session => ({
  sessionId: newId(),
  secret: 'secreto-viejo',
  user: { id: newId(), name: 'Luis', role: 'Mesero' },
  permissions: ['take_order'],
  lastUsed: Date.now(),
})

describe('signing in offline', () => {
  it('with the hub down: «offline», without saving device or session, and it can retry', async () => {
    let down = true
    const { fakeFetch } = fakeHub(() => {
      if (down) throw new TypeError('Failed to fetch')
      return json(entry(newDevice()))
    })
    const { floor, db } = await open()
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'offline' })
    expect(floor.snapshot()).toMatchObject({ device: null, session: null })
    expect(await db.readSetting('device')).toBeUndefined()
    expect(await db.readSetting('session')).toBeUndefined()
    down = false
    await floor.signIn('4821')
    expect(floor.snapshot().session).not.toBeNull()
    expect(fakeFetch).toHaveBeenCalled()
  })

  it('with the simulated outage it does not even call the hub, with PIN or with password', async () => {
    const { fakeFetch } = fakeHub(() => json(entry(newDevice())))
    const { floor } = await open()
    floor.simulateOffline(true)
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'offline' })
    await expect(floor.signIn({ user: 'caja', password: 'una-clave-larga' })).rejects.toMatchObject(
      {
        code: 'offline',
      },
    )
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('a hub that does not answer in time (timeout) is also «offline»', async () => {
    fakeHub(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })
    const { floor } = await open()
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'offline' })
  })

  it('if there was already a session and the hub is not there, the previous session is not lost or changed', async () => {
    const device = newDevice()
    const old = oneSession()
    fakeHub(() => {
      throw new TypeError('Failed to fetch')
    })
    const { floor, db } = await open(device, old)
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'offline' })
    expect(floor.snapshot().session?.sessionId).toBe(old.sessionId)
    expect((await db.readSetting<Session>('session'))?.sessionId).toBe(old.sessionId)
  })

  it('staff and saving people offline: «offline», and the session stays open', async () => {
    let down = false
    const device = newDevice()
    fakeHub((url) => {
      if (down) throw new TypeError('Failed to fetch')
      return url === '/api/sign-in' ? json(entry(null)) : json({ roles: [], people: [] }, 200)
    })
    const { floor } = await open(device)
    await floor.signIn('4821')
    down = true
    await expect(floor.staff()).rejects.toMatchObject({ code: 'offline' })
    await expect(floor.saveStaffMember({ name: 'Bruno', role_id: newId() })).rejects.toMatchObject({
      code: 'offline',
    })
    expect(floor.snapshot().session).not.toBeNull()
  })
})

describe('signing in with a fake or removed token', () => {
  it('made-up token (401): the error arrives with its code; the saved device is not deleted by itself and neither is the old session', async () => {
    const device = newDevice('inventado')
    const old = oneSession()
    fakeHub(() => json({ error: 'invalid_token', message: 'Este equipo no está emparejado' }, 401))
    const { floor, db } = await open(device, old)
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'invalid_token' })
    expect(floor.snapshot().device).toEqual(device)
    expect(await db.readSetting<Device>('device')).toEqual(device)
    expect(floor.snapshot().session?.sessionId).toBe(old.sessionId)
  })

  it('after an invalid token, forgetDevice() and signing in again registers a new one, without sending the old token', async () => {
    const fresh = newDevice('nuevo')
    const { calls } = fakeHub((_url, _c, token) =>
      token === 'token-viejo'
        ? json({ error: 'invalid_token', message: 'Este equipo no está emparejado' }, 401)
        : json(entry(fresh)),
    )
    const { floor, db } = await open(newDevice('viejo'))
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'invalid_token' })
    await floor.forgetDevice()
    expect(floor.snapshot().device).toBeNull()
    await floor.signIn('4821')
    expect(calls.filter((l) => l.url === '/api/sign-in').at(-1)?.token).toBeNull()
    expect(floor.snapshot().device).toEqual(fresh)
    expect(await db.readSetting<Device>('device')).toEqual(fresh)
  })

  it('removed device (403): «revoked_device» error, no session is opened and the device type does not change', async () => {
    const device = newDevice('retirado')
    fakeHub(() => json({ error: 'revoked_device', message: 'Este equipo fue retirado' }, 403))
    const { floor, db } = await open(device)
    await expect(floor.signIn({ user: 'caja', password: 'una-clave-larga' })).rejects.toMatchObject(
      {
        code: 'revoked_device',
        message: 'Este equipo fue retirado',
      },
    )
    expect(floor.snapshot().session).toBeNull()
    expect(await db.readSetting('session')).toBeUndefined()
    expect((await db.readSetting<Device>('device'))?.type).toBe('waiter')
  })

  it('the wrong password waits: the wait time arrives and nothing is saved', async () => {
    fakeHub(() =>
      json(
        {
          error: 'invalid_credentials',
          message: 'Usuario o contraseña incorrectos',
          wait_ms: 4000,
        },
        429,
      ),
    )
    const { floor, db } = await open()
    await expect(floor.signIn({ user: 'caja', password: 'incorrecta-xx' })).rejects.toMatchObject({
      code: 'invalid_credentials',
      waitMs: 4000,
    })
    expect(await db.readSetting('device')).toBeUndefined()
  })

  it('a 500 without a JSON body gives a readable error; a 201 that is not JSON leaves no device or session', async () => {
    let mode: 'cinco' | 'text' = 'cinco'
    fakeHub(() =>
      mode === 'cinco'
        ? new Response('<html>Bad gateway</html>', { status: 502 })
        : new Response('hello', { status: 201 }),
    )
    const { floor, db } = await open()
    await expect(floor.signIn('4821')).rejects.toMatchObject({
      code: 'error',
      message: expect.stringMatching(/502/),
    })
    mode = 'text'
    await expect(floor.signIn('4821')).rejects.toBeDefined()
    expect(await db.readSetting('device')).toBeUndefined()
    expect(await db.readSetting('session')).toBeUndefined()
    expect(floor.snapshot()).toMatchObject({ device: null, session: null })
  })
})

describe('persist before showing on sign-in', () => {
  it('if the session cannot be saved on the device, it is not shown as open', async () => {
    fakeHub(() => json(entry(newDevice())))
    const { floor, db } = await open()
    const original = db.saveSetting.bind(db)
    db.saveSetting = async (key: string, value: unknown) => {
      if (key === 'session') throw new Error('IndexedDB full')
      return original(key, value as never)
    }
    await expect(floor.signIn('4821')).rejects.toThrow('IndexedDB full')
    expect(floor.snapshot().session).toBeNull()
  })

  it('two taps in a row when signing in without a device: in the end the saved device and session come from the same response', async () => {
    const a = newDevice('a')
    const b = newDevice('b')
    const responses = [entry(a), entry(b)]
    fakeHub(() => json(responses.shift()))
    const { floor, db } = await open()
    await Promise.allSettled([floor.signIn('4821'), floor.signIn('4821')])
    const status = floor.snapshot()
    const saved = await db.readSetting<Device>('device')
    expect(status.device).toEqual(saved)
    expect([a.token, b.token]).toContain(status.device?.token)
    expect(status.session).not.toBeNull()
  })
})

describe("staff with the engine's session", () => {
  it("the hub's invalid_session closes the local session; no_permission does not", async () => {
    let response: Response = json(
      { error: 'no_permission', message: 'Tu rol no tiene permiso' },
      403,
    )
    fakeHub((url) => (url === '/api/sign-in' ? json(entry(null)) : response))
    const { floor } = await open(newDevice())
    await floor.signIn('4821')
    await expect(floor.staff()).rejects.toMatchObject({ code: 'no_permission' })
    expect(floor.snapshot().session).not.toBeNull()
    response = json(
      { error: 'invalid_session', message: 'La sesión se cerró: vuelve a entrar' },
      401,
    )
    await expect(floor.staff()).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.snapshot().session).toBeNull()
  })

  it('without an open session, staff() fails before calling the hub', async () => {
    const { fakeFetch } = fakeHub(() => json({}))
    const { floor } = await open(newDevice())
    await expect(floor.staff()).rejects.toThrow(/Sin sesión/)
    expect(fakeFetch).not.toHaveBeenCalled()
  })
})
