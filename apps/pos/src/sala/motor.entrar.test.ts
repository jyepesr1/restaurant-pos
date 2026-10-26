import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
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

const json = (cuerpo: unknown, status = 201) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

function respuesta(device: Partial<Equipo> | null, type = 'waiter') {
  return {
    device: device && {
      device_id: device.dispositivoId,
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
function hubFalso(responder: (cuerpo: unknown, token: string | null) => Response) {
  const llamadas: { url: string; cuerpo: unknown; token: string | null }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const token =
        (init?.headers as Record<string, string> | undefined)?.authorization?.replace(
          'Bearer ',
          '',
        ) ?? null
      const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
      llamadas.push({ url, cuerpo, token })
      if (url === '/api/catalog') return json(catalogoDePrueba(), 200)
      return responder(cuerpo, token)
    }),
  )
  return llamadas
}

async function open() {
  const db = new BaseDispositivo(`prueba-${newId()}`)
  const sala = new Sala({ db, open: sinRed })
  salas.push(sala)
  await sala.cargar()
  return { sala, db }
}

describe('Sala.entrar', () => {
  it('sin equipo, con el PIN: guarda el equipo que registró el hub, la sesión y la carta', async () => {
    const device = {
      dispositivoId: newId(),
      token: 'token-nuevo',
      name: 'Equipo de Ana',
      type: 'waiter' as const,
    }
    const llamadas = hubFalso(() => json(respuesta(device)))
    const { sala, db } = await open()

    await sala.entrar('4821')
    expect(llamadas[0]).toEqual({ url: '/api/sign-in', cuerpo: { pin: '4821' }, token: null })
    expect(sala.instantanea()).toMatchObject({ device, session: { user: { name: 'Ana' } } })
    expect(await db.leerAjuste<Equipo>('device')).toEqual(device)
    expect(await db.leerAjuste<Sesion>('session')).toMatchObject({ secret: 'secret' })
    expect(sala.instantanea().catalog).not.toBeNull()
  })

  it('un equipo nuevo toma la carta del hub aunque la guardada tenga una versión mayor (otro hub)', async () => {
    const device = {
      dispositivoId: newId(),
      token: 't',
      name: 'Equipo de Ana',
      type: 'waiter' as const,
    }
    hubFalso(() => json(respuesta(device)))
    const { db } = await open()
    // La carta que dejó un hub anterior, más adelantada que la del hub nuevo.
    await db.saveSetting('catalog', { ...catalogoDePrueba(), version: 900 })
    const another = new Sala({ db, open: sinRed })
    salas.push(another)
    await another.cargar()
    expect(another.instantanea().catalog?.version).toBe(900)

    await another.entrar('4821')
    expect(another.instantanea().catalog?.version).toBe(catalogoDePrueba().version)
  })

  it('con equipo, usa su token y no cambia el equipo; si pasa a caja, guarda el tipo nuevo', async () => {
    const device = {
      dispositivoId: newId(),
      token: 'token-viejo',
      name: 'Celular',
      type: 'waiter' as const,
    }
    const llamadas = hubFalso(() => json(respuesta(null, 'register')))
    const { sala, db } = await open()
    await db.saveSetting('device', device)
    const another = new Sala({ db, open: sinRed })
    salas.push(another)
    await another.cargar()

    await another.entrar({ user: 'caja', password: 'una-clave-larga' })
    expect(llamadas.find((l) => l.url === '/api/sign-in')).toEqual({
      url: '/api/sign-in',
      cuerpo: { user: 'caja', password: 'una-clave-larga' },
      token: 'token-viejo',
    })
    expect(another.instantanea().device).toEqual({ ...device, type: 'register' })
    expect(await db.leerAjuste<Equipo>('device')).toEqual({ ...device, type: 'register' })
    void sala
  })

  it('si el hub dice que no, no guarda nada y el error llega con su espera', async () => {
    hubFalso(() => json({ error: 'wrong_pin', message: 'PIN incorrecto', espera_ms: 2000 }, 401))
    const { sala, db } = await open()
    await expect(sala.entrar('0001')).rejects.toMatchObject({
      code: 'wrong_pin',
      message: 'PIN incorrecto',
      esperaMs: 2000,
    })
    expect(sala.instantanea()).toMatchObject({ device: null, session: null })
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
    const { sala } = await open()
    await expect(sala.entrar('4821')).rejects.toMatchObject({ code: 'offline' })
  })
})
