import 'fake-indexeddb/auto'
import { nuevoId } from '@pos/core'
import type { Canal } from '@pos/sync'
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
const sinRed = (): Canal => ({ enviar: () => {}, cerrar: () => {} })

const json = (cuerpo: unknown, status = 201) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

function respuesta(equipo: Partial<Equipo> | null, tipo = 'mesero') {
  return {
    equipo: equipo && {
      dispositivo_id: equipo.dispositivoId,
      token: equipo.token,
      nombre: equipo.nombre,
      tipo: equipo.tipo,
    },
    tipo,
    sesion_id: nuevoId(),
    secreto: 'secreto',
    usuario: { id: nuevoId(), nombre: 'Ana', rol: 'Mesero' },
    permisos: ['tomar_pedido'],
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
      if (url === '/api/catalogo') return json(catalogoDePrueba(), 200)
      return responder(cuerpo, token)
    }),
  )
  return llamadas
}

async function abrir() {
  const db = new BaseDispositivo(`prueba-${nuevoId()}`)
  const sala = new Sala({ db, abrir: sinRed })
  salas.push(sala)
  await sala.cargar()
  return { sala, db }
}

describe('Sala.entrar', () => {
  it('sin equipo, con el PIN: guarda el equipo que registró el hub, la sesión y la carta', async () => {
    const equipo = {
      dispositivoId: nuevoId(),
      token: 'token-nuevo',
      nombre: 'Equipo de Ana',
      tipo: 'mesero' as const,
    }
    const llamadas = hubFalso(() => json(respuesta(equipo)))
    const { sala, db } = await abrir()

    await sala.entrar('4821')
    expect(llamadas[0]).toEqual({ url: '/api/entrar', cuerpo: { pin: '4821' }, token: null })
    expect(sala.instantanea()).toMatchObject({ equipo, sesion: { usuario: { nombre: 'Ana' } } })
    expect(await db.leerAjuste<Equipo>('equipo')).toEqual(equipo)
    expect(await db.leerAjuste<Sesion>('sesion')).toMatchObject({ secreto: 'secreto' })
    expect(sala.instantanea().catalogo).not.toBeNull()
  })

  it('con equipo, usa su token y no cambia el equipo; si pasa a caja, guarda el tipo nuevo', async () => {
    const equipo = {
      dispositivoId: nuevoId(),
      token: 'token-viejo',
      nombre: 'Celular',
      tipo: 'mesero' as const,
    }
    const llamadas = hubFalso(() => json(respuesta(null, 'caja')))
    const { sala, db } = await abrir()
    await db.guardarAjuste('equipo', equipo)
    const otra = new Sala({ db, abrir: sinRed })
    salas.push(otra)
    await otra.cargar()

    await otra.entrar({ usuario: 'caja', contrasena: 'una-clave-larga' })
    expect(llamadas.find((l) => l.url === '/api/entrar')).toEqual({
      url: '/api/entrar',
      cuerpo: { usuario: 'caja', contrasena: 'una-clave-larga' },
      token: 'token-viejo',
    })
    expect(otra.instantanea().equipo).toEqual({ ...equipo, tipo: 'caja' })
    expect(await db.leerAjuste<Equipo>('equipo')).toEqual({ ...equipo, tipo: 'caja' })
    void sala
  })

  it('si el hub dice que no, no guarda nada y el error llega con su espera', async () => {
    hubFalso(() =>
      json({ error: 'pin_incorrecto', mensaje: 'PIN incorrecto', espera_ms: 2000 }, 401),
    )
    const { sala, db } = await abrir()
    await expect(sala.entrar('0001')).rejects.toMatchObject({
      codigo: 'pin_incorrecto',
      message: 'PIN incorrecto',
      esperaMs: 2000,
    })
    expect(sala.instantanea()).toMatchObject({ equipo: null, sesion: null })
    expect(await db.leerAjuste('equipo')).toBeUndefined()
    expect(await db.leerAjuste('sesion')).toBeUndefined()
  })

  it('sin hub, dice que no hay conexión', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { sala } = await abrir()
    await expect(sala.entrar('4821')).rejects.toMatchObject({ codigo: 'sin_conexion' })
  })
})
