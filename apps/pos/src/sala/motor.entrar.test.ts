import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Device, Sala, type Session } from './motor'
import { catalogoDePrueba } from './pruebas'

// Entrar sin emparejar (tarea 1.3b, ADR-013): el navegador sin equipo entra con PIN o con usuario
// y contraseña y el hub le da su token; con equipo, entra con su token. El hub es un `fetch` falso.

const salas: Sala[] = []
afterEach(() => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  vi.unstubAllGlobals()
})

/** Un canal que no conecta a nada: aquí solo importa qué se guarda. */
const sinRed = (): Channel => ({ send: () => {}, close: () => {} })

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

/** El hub falso: anota cada llamada y responde lo que diga `responder` (la carta, siempre igual). */
function hubFalso(responder: (body: unknown, token: string | null) => Response) {
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
      if (url === '/api/catalog') return json(catalogoDePrueba(), 200)
      return responder(body, token)
    }),
  )
  return calls
}

async function open() {
  const db = new BaseDispositivo(`prueba-${newId()}`)
  const floor = new Sala({ db, open: sinRed })
  salas.push(floor)
  await floor.load()
  return { floor, db }
}

describe('Sala.entrar', () => {
  it('sin equipo, con el PIN: guarda el equipo que registró el hub, la sesión y la carta', async () => {
    const device = {
      deviceId: newId(),
      token: 'token-nuevo',
      name: 'Equipo de Ana',
      type: 'waiter' as const,
    }
    const calls = hubFalso(() => json(response(device)))
    const { floor, db } = await open()

    await floor.signIn('4821')
    expect(calls[0]).toEqual({ url: '/api/sign-in', body: { pin: '4821' }, token: null })
    expect(floor.instantanea()).toMatchObject({ device, session: { user: { name: 'Ana' } } })
    expect(await db.leerAjuste<Device>('device')).toEqual(device)
    expect(await db.leerAjuste<Session>('session')).toMatchObject({ secret: 'secret' })
    expect(floor.instantanea().catalog).not.toBeNull()
  })

  it('un equipo nuevo toma la carta del hub aunque la guardada tenga una versión mayor (otro hub)', async () => {
    const device = {
      deviceId: newId(),
      token: 't',
      name: 'Equipo de Ana',
      type: 'waiter' as const,
    }
    hubFalso(() => json(response(device)))
    const { db } = await open()
    // La carta que dejó un hub anterior, más adelantada que la del hub nuevo.
    await db.saveSetting('catalog', { ...catalogoDePrueba(), version: 900 })
    const another = new Sala({ db, open: sinRed })
    salas.push(another)
    await another.load()
    expect(another.instantanea().catalog?.version).toBe(900)

    await another.signIn('4821')
    expect(another.instantanea().catalog?.version).toBe(catalogoDePrueba().version)
  })

  it('con equipo, usa su token y no cambia el equipo; si pasa a caja, guarda el tipo nuevo', async () => {
    const device = {
      deviceId: newId(),
      token: 'token-viejo',
      name: 'Celular',
      type: 'waiter' as const,
    }
    const calls = hubFalso(() => json(response(null, 'register')))
    const { floor, db } = await open()
    await db.saveSetting('device', device)
    const another = new Sala({ db, open: sinRed })
    salas.push(another)
    await another.load()

    await another.signIn({ user: 'caja', password: 'una-clave-larga' })
    expect(calls.find((l) => l.url === '/api/sign-in')).toEqual({
      url: '/api/sign-in',
      body: { user: 'caja', password: 'una-clave-larga' },
      token: 'token-viejo',
    })
    expect(another.instantanea().device).toEqual({ ...device, type: 'register' })
    expect(await db.leerAjuste<Device>('device')).toEqual({ ...device, type: 'register' })
    void floor
  })

  it('si el hub dice que no, no guarda nada y el error llega con su espera', async () => {
    hubFalso(() => json({ error: 'wrong_pin', message: 'PIN incorrecto', wait_ms: 2000 }, 401))
    const { floor, db } = await open()
    await expect(floor.signIn('0001')).rejects.toMatchObject({
      code: 'wrong_pin',
      message: 'PIN incorrecto',
      waitMs: 2000,
    })
    expect(floor.instantanea()).toMatchObject({ device: null, session: null })
    expect(await db.leerAjuste('device')).toBeUndefined()
    expect(await db.leerAjuste('session')).toBeUndefined()
  })

  it('sin hub, dice que no hay conexión', async () => {
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
