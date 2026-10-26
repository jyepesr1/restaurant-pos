import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Device, Sala, type Session } from './motor'
import { catalogoDePrueba } from './pruebas'

// El motor de la app al entrar (tarea 1.3b, ADR-013) cuando el hub no está, el token no sirve o el
// equipo fue retirado. El hub es un `fetch` falso que se puede cambiar sobre la marcha.

const salas: Sala[] = []
afterEach(() => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  vi.unstubAllGlobals()
})

const sinRed = (): Channel => ({ send: () => {}, close: () => {} })
const json = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const equipoNuevo = (n = 'a'): Device => ({
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
function hubFalso(responder: Responder) {
  const calls: { url: string; body: unknown; token: string | null }[] = []
  const fetchFalso = vi.fn(async (url: string, init?: RequestInit) => {
    const token =
      (init?.headers as Record<string, string> | undefined)?.authorization?.replace(
        'Bearer ',
        '',
      ) ?? null
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body, token })
    if (url === '/api/catalog') return json(catalogoDePrueba(), 200)
    return responder(url, body, token)
  })
  vi.stubGlobal('fetch', fetchFalso)
  return { calls, fetchFalso }
}

async function open(device?: Device, session?: Session) {
  const db = new BaseDispositivo(`prueba-${newId()}`)
  if (device) await db.saveSetting('device', device)
  if (session) await db.saveSetting('session', session)
  const floor = new Sala({ db, open: sinRed })
  salas.push(floor)
  await floor.load()
  return { floor, db }
}

const unaSesion = (): Session => ({
  sessionId: newId(),
  secret: 'secreto-viejo',
  user: { id: newId(), name: 'Luis', role: 'Mesero' },
  permissions: ['take_order'],
  lastUsed: Date.now(),
})

describe('entrar sin conexión', () => {
  it('con el hub caído: «sin conexión», sin guardar equipo ni sesión, y se puede reintentar', async () => {
    let down = true
    const { fetchFalso } = hubFalso(() => {
      if (down) throw new TypeError('Failed to fetch')
      return json(entry(equipoNuevo()))
    })
    const { floor, db } = await open()
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'offline' })
    expect(floor.instantanea()).toMatchObject({ device: null, session: null })
    expect(await db.leerAjuste('device')).toBeUndefined()
    expect(await db.leerAjuste('session')).toBeUndefined()
    down = false
    await floor.signIn('4821')
    expect(floor.instantanea().session).not.toBeNull()
    expect(fetchFalso).toHaveBeenCalled()
  })

  it('con el corte simulado ni siquiera llama al hub, con PIN o con contraseña', async () => {
    const { fetchFalso } = hubFalso(() => json(entry(equipoNuevo())))
    const { floor } = await open()
    floor.simularSinConexion(true)
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'offline' })
    await expect(floor.signIn({ user: 'caja', password: 'una-clave-larga' })).rejects.toMatchObject(
      {
        code: 'offline',
      },
    )
    expect(fetchFalso).not.toHaveBeenCalled()
  })

  it('un hub que no contesta a tiempo (timeout) también es «sin conexión»', async () => {
    hubFalso(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })
    const { floor } = await open()
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'offline' })
  })

  it('si ya había sesión y el hub no está, la sesión anterior no se pierde ni se cambia', async () => {
    const device = equipoNuevo()
    const old = unaSesion()
    hubFalso(() => {
      throw new TypeError('Failed to fetch')
    })
    const { floor, db } = await open(device, old)
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'offline' })
    expect(floor.instantanea().session?.sessionId).toBe(old.sessionId)
    expect((await db.leerAjuste<Session>('session'))?.sessionId).toBe(old.sessionId)
  })

  it('personal y guardar personas sin conexión: «sin conexión», y la sesión sigue abierta', async () => {
    let down = false
    const device = equipoNuevo()
    hubFalso((url) => {
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
    expect(floor.instantanea().session).not.toBeNull()
  })
})

describe('entrar con un token falso o retirado', () => {
  it('token inventado (401): el error llega con su código; el equipo guardado no se borra solo y la sesión vieja tampoco', async () => {
    const device = equipoNuevo('inventado')
    const old = unaSesion()
    hubFalso(() => json({ error: 'invalid_token', message: 'Este equipo no está emparejado' }, 401))
    const { floor, db } = await open(device, old)
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'invalid_token' })
    expect(floor.instantanea().device).toEqual(device)
    expect(await db.leerAjuste<Device>('device')).toEqual(device)
    expect(floor.instantanea().session?.sessionId).toBe(old.sessionId)
  })

  it('tras un token inválido, «olvidar el equipo» y volver a entrar registra uno nuevo, sin mandar el token viejo', async () => {
    const fresh = equipoNuevo('nuevo')
    const { calls } = hubFalso((_url, _c, token) =>
      token === 'token-viejo'
        ? json({ error: 'invalid_token', message: 'Este equipo no está emparejado' }, 401)
        : json(entry(fresh)),
    )
    const { floor, db } = await open(equipoNuevo('viejo'))
    await expect(floor.signIn('4821')).rejects.toMatchObject({ code: 'invalid_token' })
    await floor.olvidarEquipo()
    expect(floor.instantanea().device).toBeNull()
    await floor.signIn('4821')
    expect(calls.filter((l) => l.url === '/api/sign-in').at(-1)?.token).toBeNull()
    expect(floor.instantanea().device).toEqual(fresh)
    expect(await db.leerAjuste<Device>('device')).toEqual(fresh)
  })

  it('equipo retirado (403): error «dispositivo_revocado», no se abre sesión ni cambia el tipo del equipo', async () => {
    const device = equipoNuevo('retirado')
    hubFalso(() => json({ error: 'revoked_device', message: 'Este equipo fue retirado' }, 403))
    const { floor, db } = await open(device)
    await expect(floor.signIn({ user: 'caja', password: 'una-clave-larga' })).rejects.toMatchObject(
      {
        code: 'revoked_device',
        message: 'Este equipo fue retirado',
      },
    )
    expect(floor.instantanea().session).toBeNull()
    expect(await db.leerAjuste('session')).toBeUndefined()
    expect((await db.leerAjuste<Device>('device'))?.type).toBe('waiter')
  })

  it('la contraseña errada espera: llega el tiempo de espera y no se guarda nada', async () => {
    hubFalso(() =>
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
    expect(await db.leerAjuste('device')).toBeUndefined()
  })

  it('un 500 sin cuerpo JSON da un error legible; un 201 que no es JSON no deja equipo ni sesión', async () => {
    let mode: 'cinco' | 'text' = 'cinco'
    hubFalso(() =>
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
    expect(await db.leerAjuste('device')).toBeUndefined()
    expect(await db.leerAjuste('session')).toBeUndefined()
    expect(floor.instantanea()).toMatchObject({ device: null, session: null })
  })
})

describe('persistir antes de mostrar al entrar', () => {
  it('si no se puede guardar la sesión en el dispositivo, no se muestra como abierta', async () => {
    hubFalso(() => json(entry(equipoNuevo())))
    const { floor, db } = await open()
    const original = db.saveSetting.bind(db)
    db.saveSetting = async (key: string, value: unknown) => {
      if (key === 'session') throw new Error('IndexedDB llena')
      return original(key, value as never)
    }
    await expect(floor.signIn('4821')).rejects.toThrow('IndexedDB llena')
    expect(floor.instantanea().session).toBeNull()
  })

  it('dos toques seguidos al entrar sin equipo: al final equipo y sesión guardados vienen de la misma respuesta', async () => {
    const a = equipoNuevo('a')
    const b = equipoNuevo('b')
    const responses = [entry(a), entry(b)]
    hubFalso(() => json(responses.shift()))
    const { floor, db } = await open()
    await Promise.allSettled([floor.signIn('4821'), floor.signIn('4821')])
    const status = floor.instantanea()
    const saved = await db.leerAjuste<Device>('device')
    expect(status.device).toEqual(saved)
    expect([a.token, b.token]).toContain(status.device?.token)
    expect(status.session).not.toBeNull()
  })
})

describe('personal con la sesión del motor', () => {
  it('«sesión inválida» del hub cierra la sesión local; «sin permiso» no', async () => {
    let response: Response = json(
      { error: 'no_permission', message: 'Tu rol no tiene permiso' },
      403,
    )
    hubFalso((url) => (url === '/api/sign-in' ? json(entry(null)) : response))
    const { floor } = await open(equipoNuevo())
    await floor.signIn('4821')
    await expect(floor.staff()).rejects.toMatchObject({ code: 'no_permission' })
    expect(floor.instantanea().session).not.toBeNull()
    response = json(
      { error: 'invalid_session', message: 'La sesión se cerró: vuelve a entrar' },
      401,
    )
    await expect(floor.staff()).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.instantanea().session).toBeNull()
  })

  it('sin sesión abierta, personal() falla antes de llamar al hub', async () => {
    const { fetchFalso } = hubFalso(() => json({}))
    const { floor } = await open(equipoNuevo())
    await expect(floor.staff()).rejects.toThrow(/Sin sesión/)
    expect(fetchFalso).not.toHaveBeenCalled()
  })
})
