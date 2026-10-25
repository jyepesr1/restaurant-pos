import 'fake-indexeddb/auto'
import { nuevoId } from '@pos/core'
import type { Canal, Catalogo } from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { ErrorApi } from './api'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba } from './pruebas'

// Subir la foto de un producto y cambiar la marca desde el motor de la app (tarea 1.3c). El hub
// es un `fetch` falso: se prueba lo que el equipo manda, lo que guarda y cómo se queda cuando la
// red o la sesión fallan. Sin esperas fijas ni red real.

const salas: Sala[] = []
const bases: BaseDispositivo[] = []

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  for (const b of bases.splice(0)) await b.delete()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const sinRed = (): Canal => ({ enviar: () => {}, cerrar: () => {} })
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

const PRODUCTO = 'P'.repeat(26)
const OTRO_PRODUCTO = 'Q'.repeat(26)
const FOTO = `/fotos/${'a'.repeat(24)}.webp`
const IMAGEN = 'data:image/webp;base64,UklGRgAAAABXRUJQ'

function carta(
  version: number,
  marca: string | null = 'faro',
  foto: string | null = null,
): Catalogo {
  return catalogoDePrueba({
    version,
    restaurante: { nombre: 'Prueba', sesionInactividadMin: 30, marca },
    categorias: [
      {
        id: nuevoId(),
        nombre: 'Platos',
        estacionId: null,
        productos: [PRODUCTO, OTRO_PRODUCTO].map((id) => ({
          id,
          nombre: id === PRODUCTO ? 'Burrata' : 'Pasta',
          descripcion: null,
          favorito: false,
          foto: id === PRODUCTO ? foto : null,
          precio: 10_000,
          impuesto: { tipo: 'inc' as const, tarifa: 800 },
          variantes: [],
          grupos: [],
        })),
      },
    ],
  })
}

interface Llamada {
  metodo: string
  ruta: string
  token: string | null
  cuerpo: Record<string, unknown> | null
}
type Respuesta = Response | Error | Promise<Response | Error>
type Hub = (llamada: Llamada) => Respuesta | undefined

/** HTTP simulado: `responder` decide cada ruta; lo que no decide, es 404. */
function hubFalso(responder: Hub) {
  const llamadas: Llamada[] = []
  const fetchFalso = vi.fn(async (ruta: string, init: RequestInit = {}) => {
    const cabeceras = (init.headers ?? {}) as Record<string, string>
    const llamada: Llamada = {
      metodo: String(init.method),
      ruta,
      token: cabeceras.authorization?.replace('Bearer ', '') ?? null,
      cuerpo: init.body ? JSON.parse(String(init.body)) : null,
    }
    llamadas.push(llamada)
    const r = await (responder(llamada) ?? json({ error: 'no_encontrado' }, 404))
    if (r instanceof Error) throw r
    return r
  })
  vi.stubGlobal('fetch', fetchFalso)
  return {
    llamadas,
    fetchFalso,
    deRuta: (ruta: string) => llamadas.filter((l) => l.ruta === ruta),
  }
}

const equipo: Equipo = {
  dispositivoId: nuevoId(),
  token: 'token-del-equipo',
  nombre: 'Caja',
  tipo: 'caja',
}
const unaSesion = (campos: Partial<Sesion> = {}): Sesion => ({
  sesionId: nuevoId(),
  secreto: 'secreto-de-la-sesion',
  usuario: { id: nuevoId(), nombre: 'Gloria', rol: 'Administrador' },
  permisos: ['editar_catalogo', 'administrar_usuarios'],
  ultimoUso: Date.now(),
  ...campos,
})

async function abrir(opciones: { sesion?: Sesion | null; catalogo?: Catalogo | null } = {}) {
  const db = new BaseDispositivo(`prueba-${nuevoId()}`)
  bases.push(db)
  const sesion = opciones.sesion === undefined ? unaSesion() : opciones.sesion
  const catalogo = opciones.catalogo === undefined ? carta(5) : opciones.catalogo
  await db.guardarAjuste('equipo', equipo)
  if (sesion) await db.guardarAjuste('sesion', sesion)
  if (catalogo) await db.guardarAjuste('catalogo', catalogo)
  const sala = new Sala({ db, abrir: sinRed })
  salas.push(sala)
  await sala.cargar()
  return { sala, db, sesion }
}

const productoDe = (sala: Sala, id = PRODUCTO) =>
  sala
    .instantanea()
    .catalogo?.categorias.flatMap((c) => c.productos)
    .find((p) => p.id === id)

describe('subirFoto', () => {
  it('manda la imagen con la sesión y el token del equipo, y deja la carta nueva guardada', async () => {
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/catalogo/fotos') return json({ foto: FOTO })
      if (l.ruta === '/api/catalogo') return json(carta(6, 'faro', FOTO))
      return undefined
    })
    const { sala, db, sesion } = await abrir()
    const url = await sala.subirFoto(PRODUCTO, IMAGEN)
    expect(url).toBe(FOTO)

    const [subida] = hub.deRuta('/api/catalogo/fotos')
    expect(subida).toMatchObject({
      metodo: 'POST',
      token: equipo.token,
      cuerpo: {
        sesion_id: sesion?.sesionId,
        secreto: sesion?.secreto,
        producto_id: PRODUCTO,
        imagen: IMAGEN,
      },
    })
    // Después de subir se trae la carta, y el producto ya muestra su foto, en pantalla y guardada.
    expect(productoDe(sala)?.foto).toBe(FOTO)
    expect(sala.instantanea().catalogo?.version).toBe(6)
    expect(((await db.leerAjuste('catalogo')) as Catalogo).version).toBe(6)
    // La foto de otro producto no se toca.
    expect(productoDe(sala, OTRO_PRODUCTO)?.foto).toBeNull()
  })

  it('quitar la foto manda imagen: null y devuelve null', async () => {
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/catalogo/fotos') return json({ foto: null })
      if (l.ruta === '/api/catalogo') return json(carta(7, 'faro', null))
      return undefined
    })
    const { sala } = await abrir({ catalogo: carta(6, 'faro', FOTO) })
    expect(productoDe(sala)?.foto).toBe(FOTO)
    expect(await sala.subirFoto(PRODUCTO, null)).toBeNull()
    expect(hub.deRuta('/api/catalogo/fotos')[0]?.cuerpo).toMatchObject({ imagen: null })
    expect(productoDe(sala)?.foto).toBeNull()
  })

  it('sin conexión (el hub no contesta): «sin_conexion», la carta, la sesión y lo guardado quedan igual', async () => {
    const hub = hubFalso(() => new TypeError('Failed to fetch'))
    const { sala, db } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toMatchObject({
      codigo: 'sin_conexion',
    })
    expect(hub.deRuta('/api/catalogo')).toEqual([])
    expect(sala.instantanea().sesion).not.toBeNull()
    expect(productoDe(sala)?.foto).toBeNull()
    expect(((await db.leerAjuste('catalogo')) as Catalogo).version).toBe(5)
    expect(await db.leerAjuste('sesion')).not.toBeUndefined()
  })

  it('con el corte simulado ni siquiera llama al hub', async () => {
    const hub = hubFalso(() => json({ foto: FOTO }))
    const { sala } = await abrir()
    sala.simularSinConexion(true)
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toMatchObject({
      codigo: 'sin_conexion',
    })
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('un hub que no contesta a tiempo (timeout) también es «sin conexión»', async () => {
    hubFalso(() => new DOMException('The operation timed out.', 'TimeoutError'))
    const { sala } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toMatchObject({
      codigo: 'sin_conexion',
    })
  })

  it('un corte justo después de subir: la foto quedó en el hub, la carta local se queda con la anterior y no falla', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/catalogo/fotos') return json({ foto: FOTO })
      if (l.ruta === '/api/catalogo') return new TypeError('Failed to fetch')
      return undefined
    })
    const { sala, db } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).resolves.toBe(FOTO)
    expect(productoDe(sala)?.foto).toBeNull()
    expect(((await db.leerAjuste('catalogo')) as Catalogo).version).toBe(5)
    expect(console.error).toHaveBeenCalled()
  })

  it('sesión vencida en el hub (401 sesion_invalida): se cierra la sesión aquí, borrada también de lo guardado', async () => {
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/catalogo/fotos')
        return json(
          { error: 'sesion_invalida', mensaje: 'La sesión se cerró: vuelve a entrar' },
          401,
        )
      if (l.ruta === '/api/sesiones/cerrar') return new Response(null, { status: 204 })
      return undefined
    })
    const { sala, db } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toMatchObject({
      codigo: 'sesion_invalida',
      message: 'La sesión se cerró: vuelve a entrar',
    })
    expect(sala.instantanea().sesion).toBeNull()
    expect(await db.leerAjuste('sesion')).toBeUndefined()
    // Ya no se intenta traer la carta con una sesión muerta, y el equipo sigue emparejado.
    expect(hub.deRuta('/api/catalogo')).toEqual([])
    expect(sala.instantanea().equipo).not.toBeNull()
    expect(productoDe(sala)?.foto).toBeNull()
  })

  it('sesión vencida y además sin red: igual se cierra aquí (no se queda abierta por no poder avisar)', async () => {
    let primera = true
    hubFalso((l) => {
      if (l.ruta === '/api/catalogo/fotos' && primera) {
        primera = false
        return json({ error: 'sesion_invalida', mensaje: 'La sesión se cerró' }, 401)
      }
      return new TypeError('Failed to fetch')
    })
    const { sala } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toMatchObject({
      codigo: 'sesion_invalida',
    })
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('sesión que venció por inactividad antes de tocar: no sale ningún pedido y se pide el PIN', async () => {
    const hub = hubFalso(() => json({ foto: FOTO }))
    const vieja = unaSesion({ ultimoUso: Date.now() - 40 * 60_000 })
    const { sala } = await abrir({ sesion: vieja, catalogo: carta(5) })
    // La carga ya la cerró; si no (carrera), `usar()` la cierra al primer toque.
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toThrow(/Sin sesión/)
    expect(hub.fetchFalso).not.toHaveBeenCalledWith('/api/catalogo/fotos', expect.anything())
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('sin sesión: «Sin sesión», sin llamar al hub', async () => {
    const hub = hubFalso(() => json({ foto: FOTO }))
    const { sala } = await abrir({ sesion: null })
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toThrow(/Sin sesión/)
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('sin equipo emparejado: pide entrar, sin llamar al hub', async () => {
    const hub = hubFalso(() => json({ foto: FOTO }))
    const db = new BaseDispositivo(`prueba-${nuevoId()}`)
    bases.push(db)
    await db.guardarAjuste('sesion', unaSesion())
    const sala = new Sala({ db, abrir: sinRed })
    salas.push(sala)
    await sala.cargar()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toThrow()
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('sin permiso (403): el error del hub llega tal cual y la sesión sigue abierta', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalogo/fotos'
        ? json({ error: 'sin_permiso', mensaje: 'Tu rol no tiene permiso para esto' }, 403)
        : undefined,
    )
    const { sala } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toMatchObject({
      codigo: 'sin_permiso',
      message: 'Tu rol no tiene permiso para esto',
    })
    expect(sala.instantanea().sesion).not.toBeNull()
  })

  it('un archivo que el hub rechaza (400): se ve su mensaje y nada cambia', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalogo/fotos'
        ? json({ error: 'datos_invalidos', mensaje: 'La foto pesa más de 1 MB' }, 400)
        : undefined,
    )
    const { sala } = await abrir()
    const error = await sala.subirFoto(PRODUCTO, IMAGEN).catch((e) => e)
    expect(error).toBeInstanceOf(ErrorApi)
    expect(error).toMatchObject({ codigo: 'datos_invalidos', message: 'La foto pesa más de 1 MB' })
    expect(productoDe(sala)?.foto).toBeNull()
    expect(sala.instantanea().sesion).not.toBeNull()
  })

  it('un 413 (cuerpo demasiado grande, sin nuestro formato de error) da un mensaje claro', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalogo/fotos'
        ? json(
            { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE', error: 'Payload Too Large' },
            413,
          )
        : undefined,
    )
    const { sala } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toMatchObject({
      message: expect.stringContaining('413'),
    })
    expect(sala.instantanea().sesion).not.toBeNull()
  })

  it('una respuesta que no es JSON (un proxy que devuelve HTML) no rompe nada', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalogo/fotos'
        ? new Response('<html>Bad Gateway</html>', { status: 502 })
        : undefined,
    )
    const { sala } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toMatchObject({
      message: expect.stringContaining('502'),
    })
    expect(sala.instantanea().sesion).not.toBeNull()
  })

  it('el equipo retirado (401 token_invalido) recibe el error; la sesión no se borra por esto', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalogo/fotos'
        ? json({ error: 'token_invalido', mensaje: 'Este equipo ya no tiene acceso' }, 401)
        : undefined,
    )
    const { sala } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).rejects.toMatchObject({
      codigo: 'token_invalido',
    })
    expect(sala.instantanea().equipo).not.toBeNull()
  })

  it('dos fotos seguidas de productos distintos: cada una va con su producto y la carta nueva no se pierde', async () => {
    let version = 5
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/catalogo/fotos') {
        version += 1
        return json({ foto: `/fotos/${String(version).repeat(24)}.webp` })
      }
      if (l.ruta === '/api/catalogo') return json(carta(version, 'faro', FOTO))
      return undefined
    })
    const { sala } = await abrir()
    await sala.subirFoto(PRODUCTO, IMAGEN)
    await sala.subirFoto(OTRO_PRODUCTO, IMAGEN)
    expect(hub.deRuta('/api/catalogo/fotos').map((l) => l.cuerpo?.producto_id)).toEqual([
      PRODUCTO,
      OTRO_PRODUCTO,
    ])
    expect(sala.instantanea().catalogo?.version).toBe(7)
  })

  it('una carta más vieja que la local (llegó tarde) no la reemplaza', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/catalogo/fotos') return json({ foto: FOTO })
      if (l.ruta === '/api/catalogo') return json(carta(3, 'faro', null))
      return undefined
    })
    const { sala } = await abrir({ catalogo: carta(9, 'faro', null) })
    await sala.subirFoto(PRODUCTO, IMAGEN)
    expect(sala.instantanea().catalogo?.version).toBe(9)
  })

  it('una respuesta rara en vez de la carta no pisa la buena', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/catalogo/fotos') return json({ foto: FOTO })
      if (l.ruta === '/api/catalogo') return json({ hola: 'mundo' })
      return undefined
    })
    const { sala } = await abrir()
    await expect(sala.subirFoto(PRODUCTO, IMAGEN)).resolves.toBe(FOTO)
    expect(sala.instantanea().catalogo?.version).toBe(5)
  })
})

describe('cambiarMarca', () => {
  it('manda la marca con la sesión y el token, y la carta nueva trae la marca a este equipo', async () => {
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/restaurante/marca') return json({ marca: 'la-spritzzeria' })
      if (l.ruta === '/api/catalogo') return json(carta(6, 'la-spritzzeria'))
      return undefined
    })
    const { sala, db, sesion } = await abrir()
    expect(sala.instantanea().catalogo?.restaurante.marca).toBe('faro')
    await sala.cambiarMarca('la-spritzzeria')
    expect(hub.deRuta('/api/restaurante/marca')[0]).toMatchObject({
      metodo: 'POST',
      token: equipo.token,
      cuerpo: { sesion_id: sesion?.sesionId, secreto: sesion?.secreto, marca: 'la-spritzzeria' },
    })
    expect(sala.instantanea().catalogo?.restaurante.marca).toBe('la-spritzzeria')
    expect(((await db.leerAjuste('catalogo')) as Catalogo).restaurante.marca).toBe('la-spritzzeria')
  })

  it('un hub viejo que no manda marca en la carta no rompe: queda sin marca (se verá como Faro)', async () => {
    const vieja = carta(6)
    // Una carta de un hub anterior a la tarea: el objeto del restaurante no trae `marca`.
    vieja.restaurante = { nombre: 'Prueba', sesionInactividadMin: 30 }
    hubFalso((l) => {
      if (l.ruta === '/api/restaurante/marca') return json({ marca: 'faro' })
      if (l.ruta === '/api/catalogo') return json(vieja)
      return undefined
    })
    const { sala } = await abrir()
    await sala.cambiarMarca('faro')
    expect(sala.instantanea().catalogo?.restaurante.marca ?? null).toBeNull()
    expect(sala.instantanea().catalogo?.version).toBe(6)
  })

  it('sin conexión: «sin_conexion» y la marca local no cambia', async () => {
    const hub = hubFalso(() => new TypeError('Failed to fetch'))
    const { sala, db } = await abrir()
    await expect(sala.cambiarMarca('la-spritzzeria')).rejects.toMatchObject({
      codigo: 'sin_conexion',
    })
    expect(hub.deRuta('/api/catalogo')).toEqual([])
    expect(sala.instantanea().catalogo?.restaurante.marca).toBe('faro')
    expect(((await db.leerAjuste('catalogo')) as Catalogo).restaurante.marca).toBe('faro')
    expect(sala.instantanea().sesion).not.toBeNull()
  })

  it('con el corte simulado no llama al hub', async () => {
    const hub = hubFalso(() => json({ marca: 'faro' }))
    const { sala } = await abrir()
    sala.simularSinConexion(true)
    await expect(sala.cambiarMarca('faro')).rejects.toMatchObject({ codigo: 'sin_conexion' })
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('se corta la red justo después de cambiarla: no falla, aquí se ve la nueva marca y lo guardado se pone al día con la próxima carta', async () => {
    let cortada = true
    hubFalso((l) => {
      if (l.ruta === '/api/restaurante/marca') return json({ marca: 'la-spritzzeria' })
      if (l.ruta === '/api/catalogo')
        return cortada ? new TypeError('Failed to fetch') : json(carta(6, 'la-spritzzeria'))
      return undefined
    })
    const { sala, db } = await abrir()
    await expect(sala.cambiarMarca('la-spritzzeria')).resolves.toBeUndefined()
    // El hub ya la aceptó: este equipo se ve con ella de una vez, con la misma versión de carta.
    expect(sala.instantanea().catalogo?.restaurante.marca).toBe('la-spritzzeria')
    expect(sala.instantanea().catalogo?.version).toBe(5)
    // Lo guardado en el equipo todavía es la carta anterior hasta que llegue la nueva.
    expect(((await db.leerAjuste('catalogo')) as Catalogo).restaurante.marca).toBe('faro')
    cortada = false
    await sala.actualizarCatalogo()
    expect(sala.instantanea().catalogo?.version).toBe(6)
    expect(((await db.leerAjuste('catalogo')) as Catalogo).restaurante.marca).toBe('la-spritzzeria')
  })

  it('sesión vencida (401): se cierra la sesión aquí y la marca no cambia', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/restaurante/marca')
        return json({ error: 'sesion_invalida', mensaje: 'La sesión se cerró' }, 401)
      if (l.ruta === '/api/sesiones/cerrar') return new Response(null, { status: 204 })
      return undefined
    })
    const { sala, db } = await abrir()
    await expect(sala.cambiarMarca('faro')).rejects.toMatchObject({ codigo: 'sesion_invalida' })
    expect(sala.instantanea().sesion).toBeNull()
    expect(await db.leerAjuste('sesion')).toBeUndefined()
    expect(sala.instantanea().catalogo?.restaurante.marca).toBe('faro')
  })

  it('quien no administra (403): llega el motivo y la sesión sigue', async () => {
    hubFalso((l) =>
      l.ruta === '/api/restaurante/marca'
        ? json({ error: 'sin_permiso', mensaje: 'Tu rol no tiene permiso para esto' }, 403)
        : undefined,
    )
    const { sala } = await abrir({ sesion: unaSesion({ permisos: ['tomar_pedido'] }) })
    await expect(sala.cambiarMarca('faro')).rejects.toMatchObject({
      codigo: 'sin_permiso',
      message: 'Tu rol no tiene permiso para esto',
    })
    expect(sala.instantanea().sesion).not.toBeNull()
  })

  it('una marca que el hub no conoce (400) se informa y no cambia nada', async () => {
    const hub = hubFalso((l) =>
      l.ruta === '/api/restaurante/marca'
        ? json({ error: 'datos_invalidos', mensaje: 'Esa marca no existe' }, 400)
        : undefined,
    )
    const { sala } = await abrir()
    await expect(sala.cambiarMarca('inventada')).rejects.toMatchObject({
      codigo: 'datos_invalidos',
      message: 'Esa marca no existe',
    })
    expect(hub.deRuta('/api/restaurante/marca')[0]?.cuerpo?.marca).toBe('inventada')
    expect(sala.instantanea().catalogo?.restaurante.marca).toBe('faro')
  })

  it('sin sesión: no llama al hub', async () => {
    const hub = hubFalso(() => json({ marca: 'faro' }))
    const { sala } = await abrir({ sesion: null })
    await expect(sala.cambiarMarca('faro')).rejects.toThrow(/Sin sesión/)
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('elegir la misma marca otra vez es inofensivo: la carta que vuelve es la misma', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/restaurante/marca') return json({ marca: 'faro' })
      if (l.ruta === '/api/catalogo') return json(carta(5, 'faro'))
      return undefined
    })
    const { sala } = await abrir()
    await sala.cambiarMarca('faro')
    await sala.cambiarMarca('faro')
    expect(sala.instantanea().catalogo?.restaurante.marca).toBe('faro')
    expect(sala.instantanea().catalogo?.version).toBe(5)
  })

  it('al volver a abrir la app sin red, la marca y las fotos de la última carta siguen ahí', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/restaurante/marca') return json({ marca: 'la-spritzzeria' })
      if (l.ruta === '/api/catalogo') return json(carta(6, 'la-spritzzeria', FOTO))
      return undefined
    })
    const { sala, db } = await abrir()
    await sala.cambiarMarca('la-spritzzeria')
    sala.simularSinConexion(true)

    hubFalso(() => new TypeError('Failed to fetch'))
    const reabierta = new Sala({ db, abrir: sinRed })
    salas.push(reabierta)
    await reabierta.cargar()
    expect(reabierta.instantanea().catalogo?.restaurante.marca).toBe('la-spritzzeria')
    expect(productoDe(reabierta)?.foto).toBe(FOTO)
  })
})
