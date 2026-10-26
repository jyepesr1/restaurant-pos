import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import type { Catalogo, Channel } from '@pos/sync'
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

const sinRed = (): Channel => ({ send: () => {}, close: () => {} })
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

const PRODUCT = 'P'.repeat(26)
const OTRO_PRODUCTO = 'Q'.repeat(26)
const FOTO = `/photos/${'a'.repeat(24)}.webp`
const IMAGEN = 'data:image/webp;base64,UklGRgAAAABXRUJQ'

function menu(
  version: number,
  brand: string | null = 'faro',
  photo: string | null = null,
): Catalogo {
  return catalogoDePrueba({
    version,
    restaurant: { name: 'Prueba', sesionInactividadMin: 30, brand },
    categories: [
      {
        id: newId(),
        name: 'Platos',
        estacionId: null,
        products: [PRODUCT, OTRO_PRODUCTO].map((id) => ({
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
    const r = await (responder(llamada) ?? json({ error: 'not_found' }, 404))
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

const device: Equipo = {
  dispositivoId: newId(),
  token: 'token-del-equipo',
  name: 'Caja',
  type: 'register',
}
const unaSesion = (fields: Partial<Sesion> = {}): Sesion => ({
  sesionId: newId(),
  secret: 'secreto-de-la-sesion',
  user: { id: newId(), name: 'Gloria', role: 'Administrador' },
  permissions: ['edit_catalog', 'manage_users'],
  ultimoUso: Date.now(),
  ...fields,
})

async function open(options: { session?: Sesion | null; catalog?: Catalogo | null } = {}) {
  const db = new BaseDispositivo(`prueba-${newId()}`)
  bases.push(db)
  const session = options.session === undefined ? unaSesion() : options.session
  const catalog = options.catalog === undefined ? menu(5) : options.catalog
  await db.saveSetting('device', device)
  if (session) await db.saveSetting('session', session)
  if (catalog) await db.saveSetting('catalog', catalog)
  const sala = new Sala({ db, open: sinRed })
  salas.push(sala)
  await sala.cargar()
  return { sala, db, session }
}

const productoDe = (sala: Sala, id = PRODUCT) =>
  sala
    .instantanea()
    .catalog?.categories.flatMap((c) => c.products)
    .find((p) => p.id === id)

describe('subirFoto', () => {
  it('manda la imagen con la sesión y el token del equipo, y deja la carta nueva guardada', async () => {
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/catalog/photos') return json({ photo: FOTO })
      if (l.ruta === '/api/catalog') return json(menu(6, 'faro', FOTO))
      return undefined
    })
    const { sala, db, session } = await open()
    const url = await sala.subirFoto(PRODUCT, IMAGEN)
    expect(url).toBe(FOTO)

    const [subida] = hub.deRuta('/api/catalog/photos')
    expect(subida).toMatchObject({
      metodo: 'POST',
      token: device.token,
      cuerpo: {
        session_id: session?.sesionId,
        secret: session?.secret,
        product_id: PRODUCT,
        imagen: IMAGEN,
      },
    })
    // Después de subir se trae la carta, y el producto ya muestra su foto, en pantalla y guardada.
    expect(productoDe(sala)?.photo).toBe(FOTO)
    expect(sala.instantanea().catalog?.version).toBe(6)
    expect(((await db.leerAjuste('catalog')) as Catalogo).version).toBe(6)
    // La foto de otro producto no se toca.
    expect(productoDe(sala, OTRO_PRODUCTO)?.photo).toBeNull()
  })

  it('quitar la foto manda imagen: null y devuelve null', async () => {
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/catalog/photos') return json({ photo: null })
      if (l.ruta === '/api/catalog') return json(menu(7, 'faro', null))
      return undefined
    })
    const { sala } = await open({ catalog: menu(6, 'faro', FOTO) })
    expect(productoDe(sala)?.photo).toBe(FOTO)
    expect(await sala.subirFoto(PRODUCT, null)).toBeNull()
    expect(hub.deRuta('/api/catalog/photos')[0]?.cuerpo).toMatchObject({ imagen: null })
    expect(productoDe(sala)?.photo).toBeNull()
  })

  it('sin conexión (el hub no contesta): «sin_conexion», la carta, la sesión y lo guardado quedan igual', async () => {
    const hub = hubFalso(() => new TypeError('Failed to fetch'))
    const { sala, db } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toMatchObject({
      code: 'offline',
    })
    expect(hub.deRuta('/api/catalog')).toEqual([])
    expect(sala.instantanea().session).not.toBeNull()
    expect(productoDe(sala)?.photo).toBeNull()
    expect(((await db.leerAjuste('catalog')) as Catalogo).version).toBe(5)
    expect(await db.leerAjuste('session')).not.toBeUndefined()
  })

  it('con el corte simulado ni siquiera llama al hub', async () => {
    const hub = hubFalso(() => json({ photo: FOTO }))
    const { sala } = await open()
    sala.simularSinConexion(true)
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toMatchObject({
      code: 'offline',
    })
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('un hub que no contesta a tiempo (timeout) también es «sin conexión»', async () => {
    hubFalso(() => new DOMException('The operation timed out.', 'TimeoutError'))
    const { sala } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toMatchObject({
      code: 'offline',
    })
  })

  it('un corte justo después de subir: la foto quedó en el hub, la carta local se queda con la anterior y no falla', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/catalog/photos') return json({ photo: FOTO })
      if (l.ruta === '/api/catalog') return new TypeError('Failed to fetch')
      return undefined
    })
    const { sala, db } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).resolves.toBe(FOTO)
    expect(productoDe(sala)?.photo).toBeNull()
    expect(((await db.leerAjuste('catalog')) as Catalogo).version).toBe(5)
    expect(console.error).toHaveBeenCalled()
  })

  it('sesión vencida en el hub (401 sesion_invalida): se cierra la sesión aquí, borrada también de lo guardado', async () => {
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/catalog/photos')
        return json(
          { error: 'invalid_session', message: 'La sesión se cerró: vuelve a entrar' },
          401,
        )
      if (l.ruta === '/api/sessions/close') return new Response(null, { status: 204 })
      return undefined
    })
    const { sala, db } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toMatchObject({
      code: 'invalid_session',
      message: 'La sesión se cerró: vuelve a entrar',
    })
    expect(sala.instantanea().session).toBeNull()
    expect(await db.leerAjuste('session')).toBeUndefined()
    // Ya no se intenta traer la carta con una sesión muerta, y el equipo sigue emparejado.
    expect(hub.deRuta('/api/catalog')).toEqual([])
    expect(sala.instantanea().device).not.toBeNull()
    expect(productoDe(sala)?.photo).toBeNull()
  })

  it('sesión vencida y además sin red: igual se cierra aquí (no se queda abierta por no poder avisar)', async () => {
    let first = true
    hubFalso((l) => {
      if (l.ruta === '/api/catalog/photos' && first) {
        first = false
        return json({ error: 'invalid_session', message: 'La sesión se cerró' }, 401)
      }
      return new TypeError('Failed to fetch')
    })
    const { sala } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toMatchObject({
      code: 'invalid_session',
    })
    expect(sala.instantanea().session).toBeNull()
  })

  it('sesión que venció por inactividad antes de tocar: no sale ningún pedido y se pide el PIN', async () => {
    const hub = hubFalso(() => json({ photo: FOTO }))
    const vieja = unaSesion({ ultimoUso: Date.now() - 40 * 60_000 })
    const { sala } = await open({ session: vieja, catalog: menu(5) })
    // La carga ya la cerró; si no (carrera), `usar()` la cierra al primer toque.
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toThrow(/Sin sesión/)
    expect(hub.fetchFalso).not.toHaveBeenCalledWith('/api/catalog/photos', expect.anything())
    expect(sala.instantanea().session).toBeNull()
  })

  it('sin sesión: «Sin sesión», sin llamar al hub', async () => {
    const hub = hubFalso(() => json({ photo: FOTO }))
    const { sala } = await open({ session: null })
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toThrow(/Sin sesión/)
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('sin equipo emparejado: pide entrar, sin llamar al hub', async () => {
    const hub = hubFalso(() => json({ photo: FOTO }))
    const db = new BaseDispositivo(`prueba-${newId()}`)
    bases.push(db)
    await db.saveSetting('session', unaSesion())
    const sala = new Sala({ db, open: sinRed })
    salas.push(sala)
    await sala.cargar()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toThrow()
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('sin permiso (403): el error del hub llega tal cual y la sesión sigue abierta', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalog/photos'
        ? json({ error: 'no_permission', message: 'Tu rol no tiene permiso para esto' }, 403)
        : undefined,
    )
    const { sala } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toMatchObject({
      code: 'no_permission',
      message: 'Tu rol no tiene permiso para esto',
    })
    expect(sala.instantanea().session).not.toBeNull()
  })

  it('un archivo que el hub rechaza (400): se ve su mensaje y nada cambia', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalog/photos'
        ? json({ error: 'invalid_data', message: 'La foto pesa más de 1 MB' }, 400)
        : undefined,
    )
    const { sala } = await open()
    const error = await sala.subirFoto(PRODUCT, IMAGEN).catch((e) => e)
    expect(error).toBeInstanceOf(ErrorApi)
    expect(error).toMatchObject({ code: 'invalid_data', message: 'La foto pesa más de 1 MB' })
    expect(productoDe(sala)?.photo).toBeNull()
    expect(sala.instantanea().session).not.toBeNull()
  })

  it('un 413 (cuerpo demasiado grande, sin nuestro formato de error) da un mensaje claro', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalog/photos'
        ? json(
            { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE', error: 'Payload Too Large' },
            413,
          )
        : undefined,
    )
    const { sala } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toMatchObject({
      message: expect.stringContaining('413'),
    })
    expect(sala.instantanea().session).not.toBeNull()
  })

  it('una respuesta que no es JSON (un proxy que devuelve HTML) no rompe nada', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalog/photos'
        ? new Response('<html>Bad Gateway</html>', { status: 502 })
        : undefined,
    )
    const { sala } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toMatchObject({
      message: expect.stringContaining('502'),
    })
    expect(sala.instantanea().session).not.toBeNull()
  })

  it('el equipo retirado (401 token_invalido) recibe el error; la sesión no se borra por esto', async () => {
    hubFalso((l) =>
      l.ruta === '/api/catalog/photos'
        ? json({ error: 'invalid_token', message: 'Este equipo ya no tiene acceso' }, 401)
        : undefined,
    )
    const { sala } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).rejects.toMatchObject({
      code: 'invalid_token',
    })
    expect(sala.instantanea().device).not.toBeNull()
  })

  it('dos fotos seguidas de productos distintos: cada una va con su producto y la carta nueva no se pierde', async () => {
    let version = 5
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/catalog/photos') {
        version += 1
        return json({ photo: `/photos/${String(version).repeat(24)}.webp` })
      }
      if (l.ruta === '/api/catalog') return json(menu(version, 'faro', FOTO))
      return undefined
    })
    const { sala } = await open()
    await sala.subirFoto(PRODUCT, IMAGEN)
    await sala.subirFoto(OTRO_PRODUCTO, IMAGEN)
    expect(hub.deRuta('/api/catalog/photos').map((l) => l.cuerpo?.product_id)).toEqual([
      PRODUCT,
      OTRO_PRODUCTO,
    ])
    expect(sala.instantanea().catalog?.version).toBe(7)
  })

  it('una carta más vieja que la local (llegó tarde) no la reemplaza', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/catalog/photos') return json({ photo: FOTO })
      if (l.ruta === '/api/catalog') return json(menu(3, 'faro', null))
      return undefined
    })
    const { sala } = await open({ catalog: menu(9, 'faro', null) })
    await sala.subirFoto(PRODUCT, IMAGEN)
    expect(sala.instantanea().catalog?.version).toBe(9)
  })

  it('una respuesta rara en vez de la carta no pisa la buena', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/catalog/photos') return json({ photo: FOTO })
      if (l.ruta === '/api/catalog') return json({ hello: 'mundo' })
      return undefined
    })
    const { sala } = await open()
    await expect(sala.subirFoto(PRODUCT, IMAGEN)).resolves.toBe(FOTO)
    expect(sala.instantanea().catalog?.version).toBe(5)
  })
})

describe('cambiarMarca', () => {
  it('manda la marca con la sesión y el token, y la carta nueva trae la marca a este equipo', async () => {
    const hub = hubFalso((l) => {
      if (l.ruta === '/api/restaurant/brand') return json({ brand: 'la-spritzzeria' })
      if (l.ruta === '/api/catalog') return json(menu(6, 'la-spritzzeria'))
      return undefined
    })
    const { sala, db, session } = await open()
    expect(sala.instantanea().catalog?.restaurant.brand).toBe('faro')
    await sala.cambiarMarca('la-spritzzeria')
    expect(hub.deRuta('/api/restaurant/brand')[0]).toMatchObject({
      metodo: 'POST',
      token: device.token,
      cuerpo: { session_id: session?.sesionId, secret: session?.secret, brand: 'la-spritzzeria' },
    })
    expect(sala.instantanea().catalog?.restaurant.brand).toBe('la-spritzzeria')
    expect(((await db.leerAjuste('catalog')) as Catalogo).restaurant.brand).toBe('la-spritzzeria')
  })

  it('un hub viejo que no manda marca en la carta no rompe: queda sin marca (se verá como Faro)', async () => {
    const vieja = menu(6)
    // Una carta de un hub anterior a la tarea: el objeto del restaurante no trae `marca`.
    vieja.restaurant = { name: 'Prueba', sesionInactividadMin: 30 }
    hubFalso((l) => {
      if (l.ruta === '/api/restaurant/brand') return json({ brand: 'faro' })
      if (l.ruta === '/api/catalog') return json(vieja)
      return undefined
    })
    const { sala } = await open()
    await sala.cambiarMarca('faro')
    expect(sala.instantanea().catalog?.restaurant.brand ?? null).toBeNull()
    expect(sala.instantanea().catalog?.version).toBe(6)
  })

  it('sin conexión: «sin_conexion» y la marca local no cambia', async () => {
    const hub = hubFalso(() => new TypeError('Failed to fetch'))
    const { sala, db } = await open()
    await expect(sala.cambiarMarca('la-spritzzeria')).rejects.toMatchObject({
      code: 'offline',
    })
    expect(hub.deRuta('/api/catalog')).toEqual([])
    expect(sala.instantanea().catalog?.restaurant.brand).toBe('faro')
    expect(((await db.leerAjuste('catalog')) as Catalogo).restaurant.brand).toBe('faro')
    expect(sala.instantanea().session).not.toBeNull()
  })

  it('con el corte simulado no llama al hub', async () => {
    const hub = hubFalso(() => json({ brand: 'faro' }))
    const { sala } = await open()
    sala.simularSinConexion(true)
    await expect(sala.cambiarMarca('faro')).rejects.toMatchObject({ code: 'offline' })
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('se corta la red justo después de cambiarla: no falla, aquí se ve la nueva marca y lo guardado se pone al día con la próxima carta', async () => {
    let cortada = true
    hubFalso((l) => {
      if (l.ruta === '/api/restaurant/brand') return json({ brand: 'la-spritzzeria' })
      if (l.ruta === '/api/catalog')
        return cortada ? new TypeError('Failed to fetch') : json(menu(6, 'la-spritzzeria'))
      return undefined
    })
    const { sala, db } = await open()
    await expect(sala.cambiarMarca('la-spritzzeria')).resolves.toBeUndefined()
    // El hub ya la aceptó: este equipo se ve con ella de una vez, con la misma versión de carta.
    expect(sala.instantanea().catalog?.restaurant.brand).toBe('la-spritzzeria')
    expect(sala.instantanea().catalog?.version).toBe(5)
    // Lo guardado en el equipo todavía es la carta anterior hasta que llegue la nueva.
    expect(((await db.leerAjuste('catalog')) as Catalogo).restaurant.brand).toBe('faro')
    cortada = false
    await sala.actualizarCatalogo()
    expect(sala.instantanea().catalog?.version).toBe(6)
    expect(((await db.leerAjuste('catalog')) as Catalogo).restaurant.brand).toBe('la-spritzzeria')
  })

  it('sesión vencida (401): se cierra la sesión aquí y la marca no cambia', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/restaurant/brand')
        return json({ error: 'invalid_session', message: 'La sesión se cerró' }, 401)
      if (l.ruta === '/api/sessions/close') return new Response(null, { status: 204 })
      return undefined
    })
    const { sala, db } = await open()
    await expect(sala.cambiarMarca('faro')).rejects.toMatchObject({ code: 'invalid_session' })
    expect(sala.instantanea().session).toBeNull()
    expect(await db.leerAjuste('session')).toBeUndefined()
    expect(sala.instantanea().catalog?.restaurant.brand).toBe('faro')
  })

  it('quien no administra (403): llega el motivo y la sesión sigue', async () => {
    hubFalso((l) =>
      l.ruta === '/api/restaurant/brand'
        ? json({ error: 'no_permission', message: 'Tu rol no tiene permiso para esto' }, 403)
        : undefined,
    )
    const { sala } = await open({ session: unaSesion({ permissions: ['take_order'] }) })
    await expect(sala.cambiarMarca('faro')).rejects.toMatchObject({
      code: 'no_permission',
      message: 'Tu rol no tiene permiso para esto',
    })
    expect(sala.instantanea().session).not.toBeNull()
  })

  it('una marca que el hub no conoce (400) se informa y no cambia nada', async () => {
    const hub = hubFalso((l) =>
      l.ruta === '/api/restaurant/brand'
        ? json({ error: 'invalid_data', message: 'Esa marca no existe' }, 400)
        : undefined,
    )
    const { sala } = await open()
    await expect(sala.cambiarMarca('inventada')).rejects.toMatchObject({
      code: 'invalid_data',
      message: 'Esa marca no existe',
    })
    expect(hub.deRuta('/api/restaurant/brand')[0]?.cuerpo?.brand).toBe('inventada')
    expect(sala.instantanea().catalog?.restaurant.brand).toBe('faro')
  })

  it('sin sesión: no llama al hub', async () => {
    const hub = hubFalso(() => json({ brand: 'faro' }))
    const { sala } = await open({ session: null })
    await expect(sala.cambiarMarca('faro')).rejects.toThrow(/Sin sesión/)
    expect(hub.fetchFalso).not.toHaveBeenCalled()
  })

  it('elegir la misma marca otra vez es inofensivo: la carta que vuelve es la misma', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/restaurant/brand') return json({ brand: 'faro' })
      if (l.ruta === '/api/catalog') return json(menu(5, 'faro'))
      return undefined
    })
    const { sala } = await open()
    await sala.cambiarMarca('faro')
    await sala.cambiarMarca('faro')
    expect(sala.instantanea().catalog?.restaurant.brand).toBe('faro')
    expect(sala.instantanea().catalog?.version).toBe(5)
  })

  it('al volver a abrir la app sin red, la marca y las fotos de la última carta siguen ahí', async () => {
    hubFalso((l) => {
      if (l.ruta === '/api/restaurant/brand') return json({ brand: 'la-spritzzeria' })
      if (l.ruta === '/api/catalog') return json(menu(6, 'la-spritzzeria', FOTO))
      return undefined
    })
    const { sala, db } = await open()
    await sala.cambiarMarca('la-spritzzeria')
    sala.simularSinConexion(true)

    hubFalso(() => new TypeError('Failed to fetch'))
    const reabierta = new Sala({ db, open: sinRed })
    salas.push(reabierta)
    await reabierta.cargar()
    expect(reabierta.instantanea().catalog?.restaurant.brand).toBe('la-spritzzeria')
    expect(productoDe(reabierta)?.photo).toBe(FOTO)
  })
})
