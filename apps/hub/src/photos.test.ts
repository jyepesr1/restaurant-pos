import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCatalog } from './catalog'
import { setupMenu } from './catalog-fixtures'
import { PhotoError, photoUrl, readPhoto, savePhoto } from './photos'
import { createAppServer } from './server'

// Product photos and the restaurant brand (task 1.3c).

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})
const folder = () => {
  const c = mkdtempSync(join(tmpdir(), 'pos-fotos-'))
  folders.push(c)
  return c
}

/** Minimal bytes with each type's signature (no viewable image needed). */
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(8),
])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const asData = (type: string, b: Buffer) => `data:image/${type};base64,${b.toString('base64')}`

describe('save photos', () => {
  it('saves WebP, JPEG and PNG with the content fingerprint as name; same photo, same name', () => {
    const dir = folder()
    const webp = savePhoto(dir, asData('webp', WEBP))
    expect(webp).toMatch(/^[a-f0-9]{24}\.webp$/)
    expect(savePhoto(dir, asData('webp', WEBP))).toBe(webp)
    expect(savePhoto(dir, asData('jpeg', JPG))).toMatch(/\.jpg$/)
    expect(savePhoto(dir, asData('png', PNG))).toMatch(/\.png$/)
    expect(readdirSync(dir)).toHaveLength(3)
    expect(readPhoto(dir, webp)).toMatchObject({ mime: 'image/webp' })
  })

  it('judged by its bytes: a file that claims to be an image and is not is not saved', () => {
    const dir = folder()
    expect(() => savePhoto(dir, asData('png', Buffer.from('<script>alert(1)</script>')))).toThrow(
      PhotoError,
    )
    expect(() => savePhoto(dir, 'data:text/html;base64,PGI+')).toThrow(/WebP, JPEG o PNG/)
    expect(() => savePhoto(dir, asData('webp', Buffer.alloc(0)))).toThrow(PhotoError)
    expect(() =>
      savePhoto(dir, asData('jpeg', Buffer.concat([JPG, Buffer.alloc(1024 * 1024)]))),
    ).toThrow(/1 MB/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('only reads names the hub could have created, never a path', () => {
    const dir = folder()
    for (const name of ['../clave-pin', 'pin-key', 'a'.repeat(24), `${'a'.repeat(24)}.svg`])
      expect(readPhoto(dir, name), name).toBeNull()
    expect(photoUrl('../x')).toBeNull()
    expect(photoUrl(`${'b'.repeat(24)}.webp`)).toBe(`/photos/${'b'.repeat(24)}.webp`)
  })
})

describe('photos and brand API', () => {
  async function setup() {
    const m = setupMenu()
    const photosDir = folder()
    const alerts: number[] = []
    const app = createAppServer({
      access: m.access,
      catalog: {
        db: m.db,
        restaurantId: m.restaurantId,
        access: m.access,
        onChange: (v) => alerts.push(v),
        clock: m.clock,
        photosDir,
      },
    })
    await app.ready()
    const register = m.pair('register')
    const session = (who: 'admin' | 'waiter') => {
      const s = m.signIn(register.connection, who)
      return { session_id: s.sessionId, secret: s.secret }
    }
    const post = (url: string, payload: object) =>
      app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${register.token}` },
      })
    return { ...m, app, photosDir, alerts, session, post }
  }

  it('the admin uploads a product photo: the menu includes it and the hub serves it without a token', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const r = await m.post('/api/catalog/photos', {
      ...m.session('admin'),
      product_id: burrata.id,
      image: asData('webp', WEBP),
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

    // Remove it.
    const remove = await m.post('/api/catalog/photos', {
      ...m.session('admin'),
      product_id: burrata.id,
      image: null,
    })
    expect(remove.json()).toEqual({ photo: null })
    expect(m.product('Burrata Spritz').photo).toBeNull()
  })

  it('without the edit-menu permission, 403; a file that is not an image, 400', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const waiter = await m.post('/api/catalog/photos', {
      ...m.session('waiter'),
      product_id: burrata.id,
      image: asData('webp', WEBP),
    })
    expect(waiter.statusCode).toBe(403)
    const fake = await m.post('/api/catalog/photos', {
      ...m.session('admin'),
      product_id: burrata.id,
      image: asData('png', Buffer.from('no soy una imagen')),
    })
    expect(fake.statusCode).toBe(400)
    expect(readdirSync(m.photosDir)).toEqual([])
  })

  it('the admin changes the restaurant brand and devices receive it with the menu', async () => {
    const m = await setup()
    expect(readCatalog(m.db, m.restaurantId).restaurant.brand).toBe('la-spritzzeria')
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(readCatalog(m.db, m.restaurantId).restaurant.brand).toBe('faro')
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
