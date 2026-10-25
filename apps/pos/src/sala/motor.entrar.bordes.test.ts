import 'fake-indexeddb/auto'
import { nuevoId } from '@pos/core'
import type { Canal } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba } from './pruebas'

// El motor de la app al entrar (tarea 1.3b, ADR-013) cuando el hub no está, el token no sirve o el
// equipo fue retirado. El hub es un `fetch` falso que se puede cambiar sobre la marcha.

const salas: Sala[] = []
afterEach(() => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  vi.unstubAllGlobals()
})

const sinRed = (): Canal => ({ enviar: () => {}, cerrar: () => {} })
const json = (cuerpo: unknown, status = 201) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

const equipoNuevo = (n = 'a'): Equipo => ({
  dispositivoId: nuevoId(),
  token: `token-${n}`,
  nombre: 'Equipo de Ana',
  tipo: 'mesero',
})
const entrada = (equipo: Equipo | null, tipo = 'mesero') => ({
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
})

type Responder = (
  url: string,
  cuerpo: unknown,
  token: string | null,
) => Response | Promise<Response>
function hubFalso(responder: Responder) {
  const llamadas: { url: string; cuerpo: unknown; token: string | null }[] = []
  const fetchFalso = vi.fn(async (url: string, init?: RequestInit) => {
    const token =
      (init?.headers as Record<string, string> | undefined)?.authorization?.replace(
        'Bearer ',
        '',
      ) ?? null
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
    llamadas.push({ url, cuerpo, token })
    if (url === '/api/catalogo') return json(catalogoDePrueba(), 200)
    return responder(url, cuerpo, token)
  })
  vi.stubGlobal('fetch', fetchFalso)
  return { llamadas, fetchFalso }
}

async function abrir(equipo?: Equipo, sesion?: Sesion) {
  const db = new BaseDispositivo(`prueba-${nuevoId()}`)
  if (equipo) await db.guardarAjuste('equipo', equipo)
  if (sesion) await db.guardarAjuste('sesion', sesion)
  const sala = new Sala({ db, abrir: sinRed })
  salas.push(sala)
  await sala.cargar()
  return { sala, db }
}

const unaSesion = (): Sesion => ({
  sesionId: nuevoId(),
  secreto: 'secreto-viejo',
  usuario: { id: nuevoId(), nombre: 'Luis', rol: 'Mesero' },
  permisos: ['tomar_pedido'],
  ultimoUso: Date.now(),
})

describe('entrar sin conexión', () => {
  it('con el hub caído: «sin conexión», sin guardar equipo ni sesión, y se puede reintentar', async () => {
    let caido = true
    const { fetchFalso } = hubFalso(() => {
      if (caido) throw new TypeError('Failed to fetch')
      return json(entrada(equipoNuevo()))
    })
    const { sala, db } = await abrir()
    await expect(sala.entrar('4821')).rejects.toMatchObject({ codigo: 'sin_conexion' })
    expect(sala.instantanea()).toMatchObject({ equipo: null, sesion: null })
    expect(await db.leerAjuste('equipo')).toBeUndefined()
    expect(await db.leerAjuste('sesion')).toBeUndefined()
    caido = false
    await sala.entrar('4821')
    expect(sala.instantanea().sesion).not.toBeNull()
    expect(fetchFalso).toHaveBeenCalled()
  })

  it('con el corte simulado ni siquiera llama al hub, con PIN o con contraseña', async () => {
    const { fetchFalso } = hubFalso(() => json(entrada(equipoNuevo())))
    const { sala } = await abrir()
    sala.simularSinConexion(true)
    await expect(sala.entrar('4821')).rejects.toMatchObject({ codigo: 'sin_conexion' })
    await expect(
      sala.entrar({ usuario: 'caja', contrasena: 'una-clave-larga' }),
    ).rejects.toMatchObject({
      codigo: 'sin_conexion',
    })
    expect(fetchFalso).not.toHaveBeenCalled()
  })

  it('un hub que no contesta a tiempo (timeout) también es «sin conexión»', async () => {
    hubFalso(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })
    const { sala } = await abrir()
    await expect(sala.entrar('4821')).rejects.toMatchObject({ codigo: 'sin_conexion' })
  })

  it('si ya había sesión y el hub no está, la sesión anterior no se pierde ni se cambia', async () => {
    const equipo = equipoNuevo()
    const vieja = unaSesion()
    hubFalso(() => {
      throw new TypeError('Failed to fetch')
    })
    const { sala, db } = await abrir(equipo, vieja)
    await expect(sala.entrar('4821')).rejects.toMatchObject({ codigo: 'sin_conexion' })
    expect(sala.instantanea().sesion?.sesionId).toBe(vieja.sesionId)
    expect((await db.leerAjuste<Sesion>('sesion'))?.sesionId).toBe(vieja.sesionId)
  })

  it('personal y guardar personas sin conexión: «sin conexión», y la sesión sigue abierta', async () => {
    let caido = false
    const equipo = equipoNuevo()
    hubFalso((url) => {
      if (caido) throw new TypeError('Failed to fetch')
      return url === '/api/entrar' ? json(entrada(null)) : json({ roles: [], personas: [] }, 200)
    })
    const { sala } = await abrir(equipo)
    await sala.entrar('4821')
    caido = true
    await expect(sala.personal()).rejects.toMatchObject({ codigo: 'sin_conexion' })
    await expect(sala.guardarPersona({ nombre: 'Bruno', rol_id: nuevoId() })).rejects.toMatchObject(
      { codigo: 'sin_conexion' },
    )
    expect(sala.instantanea().sesion).not.toBeNull()
  })
})

describe('entrar con un token falso o retirado', () => {
  it('token inventado (401): el error llega con su código; el equipo guardado no se borra solo y la sesión vieja tampoco', async () => {
    const equipo = equipoNuevo('inventado')
    const vieja = unaSesion()
    hubFalso(() =>
      json({ error: 'token_invalido', mensaje: 'Este equipo no está emparejado' }, 401),
    )
    const { sala, db } = await abrir(equipo, vieja)
    await expect(sala.entrar('4821')).rejects.toMatchObject({ codigo: 'token_invalido' })
    expect(sala.instantanea().equipo).toEqual(equipo)
    expect(await db.leerAjuste<Equipo>('equipo')).toEqual(equipo)
    expect(sala.instantanea().sesion?.sesionId).toBe(vieja.sesionId)
  })

  it('tras un token inválido, «olvidar el equipo» y volver a entrar registra uno nuevo, sin mandar el token viejo', async () => {
    const nuevo = equipoNuevo('nuevo')
    const { llamadas } = hubFalso((_url, _c, token) =>
      token === 'token-viejo'
        ? json({ error: 'token_invalido', mensaje: 'Este equipo no está emparejado' }, 401)
        : json(entrada(nuevo)),
    )
    const { sala, db } = await abrir(equipoNuevo('viejo'))
    await expect(sala.entrar('4821')).rejects.toMatchObject({ codigo: 'token_invalido' })
    await sala.olvidarEquipo()
    expect(sala.instantanea().equipo).toBeNull()
    await sala.entrar('4821')
    expect(llamadas.filter((l) => l.url === '/api/entrar').at(-1)?.token).toBeNull()
    expect(sala.instantanea().equipo).toEqual(nuevo)
    expect(await db.leerAjuste<Equipo>('equipo')).toEqual(nuevo)
  })

  it('equipo retirado (403): error «dispositivo_revocado», no se abre sesión ni cambia el tipo del equipo', async () => {
    const equipo = equipoNuevo('retirado')
    hubFalso(() =>
      json({ error: 'dispositivo_revocado', mensaje: 'Este equipo fue retirado' }, 403),
    )
    const { sala, db } = await abrir(equipo)
    await expect(
      sala.entrar({ usuario: 'caja', contrasena: 'una-clave-larga' }),
    ).rejects.toMatchObject({
      codigo: 'dispositivo_revocado',
      message: 'Este equipo fue retirado',
    })
    expect(sala.instantanea().sesion).toBeNull()
    expect(await db.leerAjuste('sesion')).toBeUndefined()
    expect((await db.leerAjuste<Equipo>('equipo'))?.tipo).toBe('mesero')
  })

  it('la contraseña errada espera: llega el tiempo de espera y no se guarda nada', async () => {
    hubFalso(() =>
      json(
        {
          error: 'credenciales_incorrectas',
          mensaje: 'Usuario o contraseña incorrectos',
          espera_ms: 4000,
        },
        429,
      ),
    )
    const { sala, db } = await abrir()
    await expect(
      sala.entrar({ usuario: 'caja', contrasena: 'incorrecta-xx' }),
    ).rejects.toMatchObject({
      codigo: 'credenciales_incorrectas',
      esperaMs: 4000,
    })
    expect(await db.leerAjuste('equipo')).toBeUndefined()
  })

  it('un 500 sin cuerpo JSON da un error legible; un 201 que no es JSON no deja equipo ni sesión', async () => {
    let modo: 'cinco' | 'texto' = 'cinco'
    hubFalso(() =>
      modo === 'cinco'
        ? new Response('<html>Bad gateway</html>', { status: 502 })
        : new Response('hola', { status: 201 }),
    )
    const { sala, db } = await abrir()
    await expect(sala.entrar('4821')).rejects.toMatchObject({
      codigo: 'error',
      message: expect.stringMatching(/502/),
    })
    modo = 'texto'
    await expect(sala.entrar('4821')).rejects.toBeDefined()
    expect(await db.leerAjuste('equipo')).toBeUndefined()
    expect(await db.leerAjuste('sesion')).toBeUndefined()
    expect(sala.instantanea()).toMatchObject({ equipo: null, sesion: null })
  })
})

describe('persistir antes de mostrar al entrar', () => {
  it('si no se puede guardar la sesión en el dispositivo, no se muestra como abierta', async () => {
    hubFalso(() => json(entrada(equipoNuevo())))
    const { sala, db } = await abrir()
    const original = db.guardarAjuste.bind(db)
    db.guardarAjuste = async (clave: string, valor: unknown) => {
      if (clave === 'sesion') throw new Error('IndexedDB llena')
      return original(clave, valor as never)
    }
    await expect(sala.entrar('4821')).rejects.toThrow('IndexedDB llena')
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('dos toques seguidos al entrar sin equipo: al final equipo y sesión guardados vienen de la misma respuesta', async () => {
    const a = equipoNuevo('a')
    const b = equipoNuevo('b')
    const respuestas = [entrada(a), entrada(b)]
    hubFalso(() => json(respuestas.shift()))
    const { sala, db } = await abrir()
    await Promise.allSettled([sala.entrar('4821'), sala.entrar('4821')])
    const estado = sala.instantanea()
    const guardado = await db.leerAjuste<Equipo>('equipo')
    expect(estado.equipo).toEqual(guardado)
    expect([a.token, b.token]).toContain(estado.equipo?.token)
    expect(estado.sesion).not.toBeNull()
  })
})

describe('personal con la sesión del motor', () => {
  it('«sesión inválida» del hub cierra la sesión local; «sin permiso» no', async () => {
    let respuesta: Response = json(
      { error: 'sin_permiso', mensaje: 'Tu rol no tiene permiso' },
      403,
    )
    hubFalso((url) => (url === '/api/entrar' ? json(entrada(null)) : respuesta))
    const { sala } = await abrir(equipoNuevo())
    await sala.entrar('4821')
    await expect(sala.personal()).rejects.toMatchObject({ codigo: 'sin_permiso' })
    expect(sala.instantanea().sesion).not.toBeNull()
    respuesta = json(
      { error: 'sesion_invalida', mensaje: 'La sesión se cerró: vuelve a entrar' },
      401,
    )
    await expect(sala.personal()).rejects.toMatchObject({ codigo: 'sesion_invalida' })
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('sin sesión abierta, personal() falla antes de llamar al hub', async () => {
    const { fetchFalso } = hubFalso(() => json({}))
    const { sala } = await abrir(equipoNuevo())
    await expect(sala.personal()).rejects.toThrow(/Sin sesión/)
    expect(fetchFalso).not.toHaveBeenCalled()
  })
})
