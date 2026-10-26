import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { testCatalog } from './testing'

// Sign in without pairing (task 1.3b, ADR-013): a browser with no device signs in with a PIN or a
// username and password and the hub gives it its token; with a device, it signs in with its token.
// The hub is a fake `fetch`.

const floors: Floor[] = []
afterEach(() => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  vi.unstubAllGlobals()
})

/** A channel that connects to nothing: here only what gets saved matters. */
const noNetwork = (): Channel => ({ send: () => {}, close: () => {} })

const json = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function response(device: Partial<Device> | null, type = 'waiter') {
  return {
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
  }
}

/** The fake hub: records each call and answers whatever `respond` says (the menu, always same). */
function fakeHub(respond: (body: unknown, token: string | null) => Response) {
  const calls: { url: string; body: unknown; token: string | null }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const token =
        (init?.headers as Record<string, string> | undefined)?.authorization?.replace(
          'Bearer ',
          '',
        ) ?? null
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url, body, token })
      if (url === '/api/catalog') return json(testCatalog(), 200)
      return respond(body, token)
    }),
  )
  return calls
}

async function open() {
  const db = new DeviceDatabase(`prueba-${newId()}`)
  const floor = new Floor({ db, open: noNetwork })
  floors.push(floor)
  await floor.load()
  return { floor, db }
}

describe('Floor.signIn', () => {
  it('without a device, with the PIN: saves the device the hub registered, the session and the menu', async () => {
    const device = {
      deviceId: newId(),
      token: 'token-nuevo',
      name: 'Equipo de Ana',
      type: 'waiter' as const,
    }
    const calls = fakeHub(() => json(response(device)))
    const { floor, db } = await open()

    await floor.signIn('4821')
    expect(calls[0]).toEqual({ url: '/api/sign-in', body: { pin: '4821' }, token: null })
    expect(floor.snapshot()).toMatchObject({ device, session: { user: { name: 'Ana' } } })
    expect(await db.readSetting<Device>('device')).toEqual(device)
    expect(await db.readSetting<Session>('session')).toMatchObject({ secret: 'secret' })
    expect(floor.snapshot().catalog).not.toBeNull()
  })

  it('a new device takes the hub menu even if the saved one has a higher version (another hub)', async () => {
    const device = {
      deviceId: newId(),
      token: 't',
      name: 'Equipo de Ana',
      type: 'waiter' as const,
    }
    fakeHub(() => json(response(device)))
    const { db } = await open()
    // The menu left by a previous hub, ahead of the new hub's.
    await db.saveSetting('catalog', { ...testCatalog(), version: 900 })
    const another = new Floor({ db, open: noNetwork })
    floors.push(another)
    await another.load()
    expect(another.snapshot().catalog?.version).toBe(900)

    await another.signIn('4821')
    expect(another.snapshot().catalog?.version).toBe(testCatalog().version)
  })

  it('with a device, uses its token and keeps the device; if it becomes a register, saves the new type', async () => {
    const device = {
      deviceId: newId(),
      token: 'token-viejo',
      name: 'Celular',
      type: 'waiter' as const,
    }
    const calls = fakeHub(() => json(response(null, 'register')))
    const { floor, db } = await open()
    await db.saveSetting('device', device)
    const another = new Floor({ db, open: noNetwork })
    floors.push(another)
    await another.load()

    await another.signIn({ user: 'caja', password: 'una-clave-larga' })
    expect(calls.find((l) => l.url === '/api/sign-in')).toEqual({
      url: '/api/sign-in',
      body: { user: 'caja', password: 'una-clave-larga' },
      token: 'token-viejo',
    })
    expect(another.snapshot().device).toEqual({ ...device, type: 'register' })
    expect(await db.readSetting<Device>('device')).toEqual({ ...device, type: 'register' })
    void floor
  })

  it('if the hub says no, it saves nothing and the error arrives with its wait', async () => {
    fakeHub(() => json({ error: 'wrong_pin', message: 'PIN incorrecto', wait_ms: 2000 }, 401))
    const { floor, db } = await open()
    await expect(floor.signIn('0001')).rejects.toMatchObject({
      code: 'wrong_pin',
      message: 'PIN incorrecto',
      waitMs: 2000,
    })
    expect(floor.snapshot()).toMatchObject({ device: null, session: null })
    expect(await db.readSetting('device')).toBeUndefined()
    expect(await db.readSetting('session')).toBeUndefined()
  })

  it('without a hub, it says there is no connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { floor } = await open()
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'offline' })
  })
})
