import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import type { Catalog, Channel } from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { testCatalog } from './testing'

// Uploading a product's photo and changing the brand from the app engine (task 1.3c). The hub
// is a fake `fetch`: this tests what the device sends, what it saves and how it is left when the
// network or the session fail. No fixed waits and no real network.

const floors: Floor[] = []
const databases: DeviceDatabase[] = []

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  for (const b of databases.splice(0)) await b.delete()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const noNetwork = (): Channel => ({ send: () => {}, close: () => {} })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const PRODUCT = 'P'.repeat(26)
const OTHER_PRODUCT = 'Q'.repeat(26)
const PHOTO = `/photos/${'a'.repeat(24)}.webp`
const IMAGE = 'data:image/webp;base64,UklGRgAAAABXRUJQ'

function menu(
  version: number,
  brand: string | null = 'faro',
  photo: string | null = null,
): Catalog {
  return testCatalog({
    version,
    restaurant: { name: 'Prueba', sessionIdleMin: 30, brand },
    categories: [
      {
        id: newId(),
        name: 'Platos',
        stationId: null,
        products: [PRODUCT, OTHER_PRODUCT].map((id) => ({
          id,
          name: id === PRODUCT ? 'Burrata' : 'Pasta',
          description: null,
          favorite: false,
          photo: id === PRODUCT ? photo : null,
          price: 10_000,
          tax: { type: 'inc' as const, rate: 800 },
          variants: [],
          groups: [],
        })),
      },
    ],
  })
}

interface Call {
  httpMethod: string
  route: string
  token: string | null
  body: Record<string, unknown> | null
}
type ApiResponse = Response | Error | Promise<Response | Error>
type Hub = (call: Call) => ApiResponse | undefined

/** Simulated HTTP: `respond` decides each route; whatever it does not decide is a 404. */
function fakeHub(respond: Hub) {
  const calls: Call[] = []
  const fakeFetch = vi.fn(async (route: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    const call: Call = {
      httpMethod: String(init.method),
      route,
      token: headers.authorization?.replace('Bearer ', '') ?? null,
      body: init.body ? JSON.parse(String(init.body)) : null,
    }
    calls.push(call)
    const r = await (respond(call) ?? json({ error: 'not_found' }, 404))
    if (r instanceof Error) throw r
    return r
  })
  vi.stubGlobal('fetch', fakeFetch)
  return {
    calls,
    fakeFetch,
    forRoute: (route: string) => calls.filter((l) => l.route === route),
  }
}

const device: Device = {
  deviceId: newId(),
  token: 'token-del-equipo',
  name: 'Caja',
  type: 'register',
}
const oneSession = (fields: Partial<Session> = {}): Session => ({
  sessionId: newId(),
  secret: 'secreto-de-la-sesion',
  user: { id: newId(), name: 'Gloria', role: 'Administrador' },
  permissions: ['edit_catalog', 'manage_users'],
  lastUsed: Date.now(),
  ...fields,
})

async function open(options: { session?: Session | null; catalog?: Catalog | null } = {}) {
  const db = new DeviceDatabase(`prueba-${newId()}`)
  databases.push(db)
  const session = options.session === undefined ? oneSession() : options.session
  const catalog = options.catalog === undefined ? menu(5) : options.catalog
  await db.saveSetting('device', device)
  if (session) await db.saveSetting('session', session)
  if (catalog) await db.saveSetting('catalog', catalog)
  const floor = new Floor({ db, open: noNetwork })
  floors.push(floor)
  await floor.load()
  return { floor, db, session }
}

const productOf = (floor: Floor, id = PRODUCT) =>
  floor
    .snapshot()
    .catalog?.categories.flatMap((c) => c.products)
    .find((p) => p.id === id)

describe('uploadPhoto', () => {
  it("sends the image with the session and the device's token, and leaves the new menu saved", async () => {
    const hub = fakeHub((l) => {
      if (l.route === '/api/catalog/photos') return json({ photo: PHOTO })
      if (l.route === '/api/catalog') return json(menu(6, 'faro', PHOTO))
      return undefined
    })
    const { floor, db, session } = await open()
    const url = await floor.uploadPhoto(PRODUCT, IMAGE)
    expect(url).toBe(PHOTO)

    const [uploadRequest] = hub.forRoute('/api/catalog/photos')
    expect(uploadRequest).toMatchObject({
      httpMethod: 'POST',
      token: device.token,
      body: {
        session_id: session?.sessionId,
        secret: session?.secret,
        product_id: PRODUCT,
        image: IMAGE,
      },
    })
    // After uploading the menu is fetched, and the product shows its photo, on screen and saved.
    expect(productOf(floor)?.photo).toBe(PHOTO)
    expect(floor.snapshot().catalog?.version).toBe(6)
    expect(((await db.readSetting('catalog')) as Catalog).version).toBe(6)
    // Another product's photo is not touched.
    expect(productOf(floor, OTHER_PRODUCT)?.photo).toBeNull()
  })

  it('removing the photo sends image: null and returns null', async () => {
    const hub = fakeHub((l) => {
      if (l.route === '/api/catalog/photos') return json({ photo: null })
      if (l.route === '/api/catalog') return json(menu(7, 'faro', null))
      return undefined
    })
    const { floor } = await open({ catalog: menu(6, 'faro', PHOTO) })
    expect(productOf(floor)?.photo).toBe(PHOTO)
    expect(await floor.uploadPhoto(PRODUCT, null)).toBeNull()
    expect(hub.forRoute('/api/catalog/photos')[0]?.body).toMatchObject({ image: null })
    expect(productOf(floor)?.photo).toBeNull()
  })

  it('offline (the hub does not answer): «offline», the menu, the session and what is saved stay the same', async () => {
    const hub = fakeHub(() => new TypeError('Failed to fetch'))
    const { floor, db } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toMatchObject({
      code: 'offline',
    })
    expect(hub.forRoute('/api/catalog')).toEqual([])
    expect(floor.snapshot().session).not.toBeNull()
    expect(productOf(floor)?.photo).toBeNull()
    expect(((await db.readSetting('catalog')) as Catalog).version).toBe(5)
    expect(await db.readSetting('session')).not.toBeUndefined()
  })

  it('with the simulated outage it does not even call the hub', async () => {
    const hub = fakeHub(() => json({ photo: PHOTO }))
    const { floor } = await open()
    floor.simulateOffline(true)
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toMatchObject({
      code: 'offline',
    })
    expect(hub.fakeFetch).not.toHaveBeenCalled()
  })

  it('a hub that does not answer in time (timeout) is also «offline»', async () => {
    fakeHub(() => new DOMException('The operation timed out.', 'TimeoutError'))
    const { floor } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toMatchObject({
      code: 'offline',
    })
  })

  it('an outage right after uploading: the photo stayed on the hub, the local menu keeps the previous one and does not fail', async () => {
    fakeHub((l) => {
      if (l.route === '/api/catalog/photos') return json({ photo: PHOTO })
      if (l.route === '/api/catalog') return new TypeError('Failed to fetch')
      return undefined
    })
    const { floor, db } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).resolves.toBe(PHOTO)
    expect(productOf(floor)?.photo).toBeNull()
    expect(((await db.readSetting('catalog')) as Catalog).version).toBe(5)
    expect(console.error).toHaveBeenCalled()
  })

  it('session expired on the hub (401 invalid_session): the session is closed here, also deleted from storage', async () => {
    const hub = fakeHub((l) => {
      if (l.route === '/api/catalog/photos')
        return json(
          { error: 'invalid_session', message: 'La sesión se cerró: vuelve a entrar' },
          401,
        )
      if (l.route === '/api/sessions/close') return new Response(null, { status: 204 })
      return undefined
    })
    const { floor, db } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toMatchObject({
      code: 'invalid_session',
      message: 'La sesión se cerró: vuelve a entrar',
    })
    expect(floor.snapshot().session).toBeNull()
    expect(await db.readSetting('session')).toBeUndefined()
    // The menu is no longer fetched with a dead session, and the device stays paired.
    expect(hub.forRoute('/api/catalog')).toEqual([])
    expect(floor.snapshot().device).not.toBeNull()
    expect(productOf(floor)?.photo).toBeNull()
  })

  it('session expired and also offline: it is closed here anyway (it does not stay open for being unable to notify)', async () => {
    let first = true
    fakeHub((l) => {
      if (l.route === '/api/catalog/photos' && first) {
        first = false
        return json({ error: 'invalid_session', message: 'La sesión se cerró' }, 401)
      }
      return new TypeError('Failed to fetch')
    })
    const { floor } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toMatchObject({
      code: 'invalid_session',
    })
    expect(floor.snapshot().session).toBeNull()
  })

  it('session that expired from inactivity before tapping: no request goes out and the PIN is asked for', async () => {
    const hub = fakeHub(() => json({ photo: PHOTO }))
    const old = oneSession({ lastUsed: Date.now() - 40 * 60_000 })
    const { floor } = await open({ session: old, catalog: menu(5) })
    // Loading already closed it; if not (race), `enabled()` closes it on the first tap.
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toThrow(/Sin sesión/)
    expect(hub.fakeFetch).not.toHaveBeenCalledWith('/api/catalog/photos', expect.anything())
    expect(floor.snapshot().session).toBeNull()
  })

  it('without a session: «Sin sesión», without calling the hub', async () => {
    const hub = fakeHub(() => json({ photo: PHOTO }))
    const { floor } = await open({ session: null })
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toThrow(/Sin sesión/)
    expect(hub.fakeFetch).not.toHaveBeenCalled()
  })

  it('without a paired device: asks to sign in, without calling the hub', async () => {
    const hub = fakeHub(() => json({ photo: PHOTO }))
    const db = new DeviceDatabase(`prueba-${newId()}`)
    databases.push(db)
    await db.saveSetting('session', oneSession())
    const floor = new Floor({ db, open: noNetwork })
    floors.push(floor)
    await floor.load()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toThrow()
    expect(hub.fakeFetch).not.toHaveBeenCalled()
  })

  it("without permission (403): the hub's error arrives as is and the session stays open", async () => {
    fakeHub((l) =>
      l.route === '/api/catalog/photos'
        ? json({ error: 'no_permission', message: 'Tu rol no tiene permiso para esto' }, 403)
        : undefined,
    )
    const { floor } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toMatchObject({
      code: 'no_permission',
      message: 'Tu rol no tiene permiso para esto',
    })
    expect(floor.snapshot().session).not.toBeNull()
  })

  it('a file the hub rejects (400): its message is shown and nothing changes', async () => {
    fakeHub((l) =>
      l.route === '/api/catalog/photos'
        ? json({ error: 'invalid_data', message: 'La foto pesa más de 1 MB' }, 400)
        : undefined,
    )
    const { floor } = await open()
    const error = await floor.uploadPhoto(PRODUCT, IMAGE).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'invalid_data', message: 'La foto pesa más de 1 MB' })
    expect(productOf(floor)?.photo).toBeNull()
    expect(floor.snapshot().session).not.toBeNull()
  })

  it('a 413 (body too large, without our error format) gives a clear message', async () => {
    fakeHub((l) =>
      l.route === '/api/catalog/photos'
        ? json(
            { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE', error: 'Payload Too Large' },
            413,
          )
        : undefined,
    )
    const { floor } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toMatchObject({
      message: expect.stringContaining('413'),
    })
    expect(floor.snapshot().session).not.toBeNull()
  })

  it('a response that is not JSON (a proxy returning HTML) breaks nothing', async () => {
    fakeHub((l) =>
      l.route === '/api/catalog/photos'
        ? new Response('<html>Bad Gateway</html>', { status: 502 })
        : undefined,
    )
    const { floor } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toMatchObject({
      message: expect.stringContaining('502'),
    })
    expect(floor.snapshot().session).not.toBeNull()
  })

  it('the removed device (401 invalid_token) gets the error; the session is not deleted because of this', async () => {
    fakeHub((l) =>
      l.route === '/api/catalog/photos'
        ? json({ error: 'invalid_token', message: 'Este equipo ya no tiene acceso' }, 401)
        : undefined,
    )
    const { floor } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).rejects.toMatchObject({
      code: 'invalid_token',
    })
    expect(floor.snapshot().device).not.toBeNull()
  })

  it('two photos in a row for different products: each goes with its product and the new menu is not lost', async () => {
    let version = 5
    const hub = fakeHub((l) => {
      if (l.route === '/api/catalog/photos') {
        version += 1
        return json({ photo: `/photos/${String(version).repeat(24)}.webp` })
      }
      if (l.route === '/api/catalog') return json(menu(version, 'faro', PHOTO))
      return undefined
    })
    const { floor } = await open()
    await floor.uploadPhoto(PRODUCT, IMAGE)
    await floor.uploadPhoto(OTHER_PRODUCT, IMAGE)
    expect(hub.forRoute('/api/catalog/photos').map((l) => l.body?.product_id)).toEqual([
      PRODUCT,
      OTHER_PRODUCT,
    ])
    expect(floor.snapshot().catalog?.version).toBe(7)
  })

  it('a menu older than the local one (arrived late) does not replace it', async () => {
    fakeHub((l) => {
      if (l.route === '/api/catalog/photos') return json({ photo: PHOTO })
      if (l.route === '/api/catalog') return json(menu(3, 'faro', null))
      return undefined
    })
    const { floor } = await open({ catalog: menu(9, 'faro', null) })
    await floor.uploadPhoto(PRODUCT, IMAGE)
    expect(floor.snapshot().catalog?.version).toBe(9)
  })

  it('an odd response instead of the menu does not overwrite the good one', async () => {
    fakeHub((l) => {
      if (l.route === '/api/catalog/photos') return json({ photo: PHOTO })
      if (l.route === '/api/catalog') return json({ hello: 'mundo' })
      return undefined
    })
    const { floor } = await open()
    await expect(floor.uploadPhoto(PRODUCT, IMAGE)).resolves.toBe(PHOTO)
    expect(floor.snapshot().catalog?.version).toBe(5)
  })
})

describe('changeBrand', () => {
  it('sends the brand with the session and the token, and the new menu brings the brand to this device', async () => {
    const hub = fakeHub((l) => {
      if (l.route === '/api/restaurant/brand') return json({ brand: 'la-spritzzeria' })
      if (l.route === '/api/catalog') return json(menu(6, 'la-spritzzeria'))
      return undefined
    })
    const { floor, db, session } = await open()
    expect(floor.snapshot().catalog?.restaurant.brand).toBe('faro')
    await floor.changeBrand('la-spritzzeria')
    expect(hub.forRoute('/api/restaurant/brand')[0]).toMatchObject({
      httpMethod: 'POST',
      token: device.token,
      body: { session_id: session?.sessionId, secret: session?.secret, brand: 'la-spritzzeria' },
    })
    expect(floor.snapshot().catalog?.restaurant.brand).toBe('la-spritzzeria')
    expect(((await db.readSetting('catalog')) as Catalog).restaurant.brand).toBe('la-spritzzeria')
  })

  it('an old hub that sends no brand in the menu does not break: it is left without a brand (it will look like Faro)', async () => {
    const old = menu(6)
    // A menu from a hub older than the task: the restaurant object has no `brand`.
    old.restaurant = { name: 'Prueba', sessionIdleMin: 30 }
    fakeHub((l) => {
      if (l.route === '/api/restaurant/brand') return json({ brand: 'faro' })
      if (l.route === '/api/catalog') return json(old)
      return undefined
    })
    const { floor } = await open()
    await floor.changeBrand('faro')
    expect(floor.snapshot().catalog?.restaurant.brand ?? null).toBeNull()
    expect(floor.snapshot().catalog?.version).toBe(6)
  })

  it('offline: «offline» and the local brand does not change', async () => {
    const hub = fakeHub(() => new TypeError('Failed to fetch'))
    const { floor, db } = await open()
    await expect(floor.changeBrand('la-spritzzeria')).rejects.toMatchObject({
      code: 'offline',
    })
    expect(hub.forRoute('/api/catalog')).toEqual([])
    expect(floor.snapshot().catalog?.restaurant.brand).toBe('faro')
    expect(((await db.readSetting('catalog')) as Catalog).restaurant.brand).toBe('faro')
    expect(floor.snapshot().session).not.toBeNull()
  })

  it('with the simulated outage it does not call the hub', async () => {
    const hub = fakeHub(() => json({ brand: 'faro' }))
    const { floor } = await open()
    floor.simulateOffline(true)
    await expect(floor.changeBrand('faro')).rejects.toMatchObject({ code: 'offline' })
    expect(hub.fakeFetch).not.toHaveBeenCalled()
  })

  it('the network drops right after changing it: it does not fail, the new brand shows here and storage catches up with the next menu', async () => {
    let cutOff = true
    fakeHub((l) => {
      if (l.route === '/api/restaurant/brand') return json({ brand: 'la-spritzzeria' })
      if (l.route === '/api/catalog')
        return cutOff ? new TypeError('Failed to fetch') : json(menu(6, 'la-spritzzeria'))
      return undefined
    })
    const { floor, db } = await open()
    await expect(floor.changeBrand('la-spritzzeria')).resolves.toBeUndefined()
    // The hub already accepted it: this device shows it right away, with the same menu version.
    expect(floor.snapshot().catalog?.restaurant.brand).toBe('la-spritzzeria')
    expect(floor.snapshot().catalog?.version).toBe(5)
    // What is saved on the device is still the previous menu until the new one arrives.
    expect(((await db.readSetting('catalog')) as Catalog).restaurant.brand).toBe('faro')
    cutOff = false
    await floor.updateCatalog()
    expect(floor.snapshot().catalog?.version).toBe(6)
    expect(((await db.readSetting('catalog')) as Catalog).restaurant.brand).toBe('la-spritzzeria')
  })

  it('session expired (401): the session is closed here and the brand does not change', async () => {
    fakeHub((l) => {
      if (l.route === '/api/restaurant/brand')
        return json({ error: 'invalid_session', message: 'La sesión se cerró' }, 401)
      if (l.route === '/api/sessions/close') return new Response(null, { status: 204 })
      return undefined
    })
    const { floor, db } = await open()
    await expect(floor.changeBrand('faro')).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.snapshot().session).toBeNull()
    expect(await db.readSetting('session')).toBeUndefined()
    expect(floor.snapshot().catalog?.restaurant.brand).toBe('faro')
  })

  it('someone who does not administer (403): the reason arrives and the session stays', async () => {
    fakeHub((l) =>
      l.route === '/api/restaurant/brand'
        ? json({ error: 'no_permission', message: 'Tu rol no tiene permiso para esto' }, 403)
        : undefined,
    )
    const { floor } = await open({ session: oneSession({ permissions: ['take_order'] }) })
    await expect(floor.changeBrand('faro')).rejects.toMatchObject({
      code: 'no_permission',
      message: 'Tu rol no tiene permiso para esto',
    })
    expect(floor.snapshot().session).not.toBeNull()
  })

  it('a brand the hub does not know (400) is reported and nothing changes', async () => {
    const hub = fakeHub((l) =>
      l.route === '/api/restaurant/brand'
        ? json({ error: 'invalid_data', message: 'Esa marca no existe' }, 400)
        : undefined,
    )
    const { floor } = await open()
    await expect(floor.changeBrand('inventada')).rejects.toMatchObject({
      code: 'invalid_data',
      message: 'Esa marca no existe',
    })
    expect(hub.forRoute('/api/restaurant/brand')[0]?.body?.brand).toBe('inventada')
    expect(floor.snapshot().catalog?.restaurant.brand).toBe('faro')
  })

  it('without a session: it does not call the hub', async () => {
    const hub = fakeHub(() => json({ brand: 'faro' }))
    const { floor } = await open({ session: null })
    await expect(floor.changeBrand('faro')).rejects.toThrow(/Sin sesión/)
    expect(hub.fakeFetch).not.toHaveBeenCalled()
  })

  it('choosing the same brand again is harmless: the menu that comes back is the same', async () => {
    fakeHub((l) => {
      if (l.route === '/api/restaurant/brand') return json({ brand: 'faro' })
      if (l.route === '/api/catalog') return json(menu(5, 'faro'))
      return undefined
    })
    const { floor } = await open()
    await floor.changeBrand('faro')
    await floor.changeBrand('faro')
    expect(floor.snapshot().catalog?.restaurant.brand).toBe('faro')
    expect(floor.snapshot().catalog?.version).toBe(5)
  })

  it('when reopening the app offline, the brand and the photos of the last menu are still there', async () => {
    fakeHub((l) => {
      if (l.route === '/api/restaurant/brand') return json({ brand: 'la-spritzzeria' })
      if (l.route === '/api/catalog') return json(menu(6, 'la-spritzzeria', PHOTO))
      return undefined
    })
    const { floor, db } = await open()
    await floor.changeBrand('la-spritzzeria')
    floor.simulateOffline(true)

    fakeHub(() => new TypeError('Failed to fetch'))
    const reopenedInstance = new Floor({ db, open: noNetwork })
    floors.push(reopenedInstance)
    await reopenedInstance.load()
    expect(reopenedInstance.snapshot().catalog?.restaurant.brand).toBe('la-spritzzeria')
    expect(productOf(reopenedInstance)?.photo).toBe(PHOTO)
  })
})
