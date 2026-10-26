import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { leerCatalogo } from './catalogo'
import { ErrorFoto, guardarFoto, leerFoto, urlFoto } from './fotos'
import { montarCarta } from './pruebas-catalogo'
import { crearServidor } from './servidor'

// Fotos de los productos y marca del restaurante (tarea 1.3c).

const carpetas: string[] = []
afterEach(() => {
  for (const c of carpetas.splice(0)) rmSync(c, { recursive: true, force: true })
})
const folder = () => {
  const c = mkdtempSync(join(tmpdir(), 'pos-fotos-'))
  carpetas.push(c)
  return c
}

/** Bytes mínimos con la firma de cada tipo (no hace falta una imagen que se vea). */
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(8),
])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const comoDato = (type: string, b: Buffer) => `data:image/${type};base64,${b.toString('base64')}`

describe('guardar fotos', () => {
  it('guarda WebP, JPEG y PNG con la huella del contenido como nombre; la misma foto, el mismo nombre', () => {
    const dir = folder()
    const webp = guardarFoto(dir, comoDato('webp', WEBP))
    expect(webp).toMatch(/^[a-f0-9]{24}\.webp$/)
    expect(guardarFoto(dir, comoDato('webp', WEBP))).toBe(webp)
    expect(guardarFoto(dir, comoDato('jpeg', JPG))).toMatch(/\.jpg$/)
    expect(guardarFoto(dir, comoDato('png', PNG))).toMatch(/\.png$/)
    expect(readdirSync(dir)).toHaveLength(3)
    expect(leerFoto(dir, webp)).toMatchObject({ mime: 'image/webp' })
  })

  it('se juzga por sus bytes: un archivo que dice ser imagen y no lo es no se guarda', () => {
    const dir = folder()
    expect(() =>
      guardarFoto(dir, comoDato('png', Buffer.from('<script>alert(1)</script>'))),
    ).toThrow(ErrorFoto)
    expect(() => guardarFoto(dir, 'data:text/html;base64,PGI+')).toThrow(/WebP, JPEG o PNG/)
    expect(() => guardarFoto(dir, comoDato('webp', Buffer.alloc(0)))).toThrow(ErrorFoto)
    expect(() =>
      guardarFoto(dir, comoDato('jpeg', Buffer.concat([JPG, Buffer.alloc(1024 * 1024)]))),
    ).toThrow(/1 MB/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('solo lee nombres que el hub pudo crear, nunca una ruta', () => {
    const dir = folder()
    for (const name of ['../clave-pin', 'pin-key', 'a'.repeat(24), `${'a'.repeat(24)}.svg`])
      expect(leerFoto(dir, name), name).toBeNull()
    expect(urlFoto('../x')).toBeNull()
    expect(urlFoto(`${'b'.repeat(24)}.webp`)).toBe(`/photos/${'b'.repeat(24)}.webp`)
  })
})

describe('API de fotos y marca', () => {
  async function setup() {
    const m = montarCarta()
    const dirFotos = folder()
    const alerts: number[] = []
    const app = crearServidor({
      access: m.access,
      catalog: {
        db: m.db,
        restaurantId: m.restaurantId,
        access: m.access,
        onChange: (v) => alerts.push(v),
        clock: m.clock,
        dirFotos,
      },
    })
    await app.ready()
    const register = m.emparejar('register')
    const session = (who: 'admin' | 'waiter') => {
      const s = m.entrar(register.connection, who)
      return { session_id: s.sesionId, secret: s.secret }
    }
    const post = (url: string, payload: object) =>
      app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${register.token}` },
      })
    return { ...m, app, dirFotos, alerts, session, post }
  }

  it('el administrador sube la foto de un producto: la carta la trae y el hub la sirve sin token', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const r = await m.post('/api/catalog/photos', {
      ...m.session('admin'),
      product_id: burrata.id,
      imagen: comoDato('webp', WEBP),
    })
    expect(r.statusCode).toBe(200)
    const url = r.json().photo as string
    expect(url).toMatch(/^\/photos\/[a-f0-9]{24}\.webp$/)
    expect(m.product('Burrata Spritz').photo).toBe(url)
    expect(m.alerts).toHaveLength(1)

    const photo = await m.app.inject({ method: 'GET', url })
    expect(photo.statusCode).toBe(200)
    expect(photo.headers['content-type']).toBe('image/webp')
    expect(photo.headers['cache-control']).toMatch(/immutable/)
    expect((await m.app.inject({ method: 'GET', url: '/photos/..%2Fclave-pin' })).statusCode).toBe(
      404,
    )

    // Quitarla.
    const remove = await m.post('/api/catalog/photos', {
      ...m.session('admin'),
      product_id: burrata.id,
      imagen: null,
    })
    expect(remove.json()).toEqual({ photo: null })
    expect(m.product('Burrata Spritz').photo).toBeNull()
  })

  it('sin el permiso de editar la carta, 403; un archivo que no es imagen, 400', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const waiter = await m.post('/api/catalog/photos', {
      ...m.session('waiter'),
      product_id: burrata.id,
      imagen: comoDato('webp', WEBP),
    })
    expect(waiter.statusCode).toBe(403)
    const falsa = await m.post('/api/catalog/photos', {
      ...m.session('admin'),
      product_id: burrata.id,
      imagen: comoDato('png', Buffer.from('no soy una imagen')),
    })
    expect(falsa.statusCode).toBe(400)
    expect(readdirSync(m.dirFotos)).toEqual([])
  })

  it('el administrador cambia la marca del restaurante y los equipos la reciben en la carta', async () => {
    const m = await setup()
    expect(leerCatalogo(m.db, m.restaurantId).restaurant.brand).toBe('la-spritzzeria')
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(leerCatalogo(m.db, m.restaurantId).restaurant.brand).toBe('faro')
    expect(m.alerts).toHaveLength(1)
    const another = await m.post('/api/restaurant/brand', {
      ...m.session('admin'),
      brand: 'inventada',
    })
    expect(another.statusCode).toBe(400)
    const waiter = await m.post('/api/restaurant/brand', { ...m.session('waiter'), brand: 'faro' })
    expect(waiter.statusCode).toBe(403)
  })
})
