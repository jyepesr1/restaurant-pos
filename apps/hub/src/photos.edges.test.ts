import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, fullConfig, newId } from '@pos/core'
import { afterEach, describe, expect, it } from 'vitest'
import { insertVersioned, SYSTEM } from './access/records'
import { readCatalog } from './catalog'
import { MENU, setupMenu } from './catalog-fixtures'
import { MAX_PHOTO_SIZE, PHOTO_NAME, photoUrl, readPhoto, savePhoto } from './photos'
import { seed } from './seed/seed'
import { createAppServer } from './server'

// Product photos and restaurant brand: edge cases (task 1.3c). The basics are in photos.test.ts;
// here, odd names, limits, deduplication, several restaurants in the same database, hub restarts,
// cache headers and invalid sessions.

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})
const folder = () => {
  const c = mkdtempSync(join(tmpdir(), 'pos-fotos-bordes-'))
  folders.push(c)
  return c
}

const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(8),
])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const asData = (type: string, b: Buffer) => `data:image/${type};base64,${b.toString('base64')}`
/** A JPEG of that exact size, with padding that changes with `seedValue`. */
const jpgOf = (bytes: number, seedValue = 0) => {
  const b = Buffer.alloc(bytes, seedValue)
  JPG.copy(b)
  return b
}

async function setup(
  options: { photosDir?: string | null; m?: ReturnType<typeof setupMenu> } = {},
) {
  const m = options.m ?? setupMenu()
  const photosDir = options.photosDir === null ? undefined : (options.photosDir ?? folder())
  const notified: number[] = []
  const app = createAppServer({
    access: m.access,
    catalog: {
      db: m.db,
      restaurantId: m.restaurantId,
      access: m.access,
      onChange: (v) => notified.push(v),
      clock: m.clock,
      ...(photosDir ? { photosDir } : {}),
    },
  })
  await app.ready()
  const register = m.pair('register')
  const session = (
    who: 'admin' | 'manager' | 'cashier' | 'waiter',
    connection = register.connection,
  ) => {
    const s = m.signIn(connection, who)
    return { session_id: s.sessionId, secret: s.secret }
  }
  const post = (url: string, payload: unknown, token: string | null = register.token) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  const upload = (who: Parameters<typeof session>[0], productId: string, image: string | null) =>
    post('/api/catalog/photos', { ...session(who), product_id: productId, image })
  const get = (url: string) => app.inject({ method: 'GET', url })
  return { ...m, app, photosDir, notified, register, session, post, upload, get }
}

/** A second restaurant in the same database, with a product of its own. */
function addAnotherRestaurant(m: ReturnType<typeof setupMenu>, config = '{}') {
  const id = newId()
  const now = m.clock()
  m.db
    .prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Otro restaurante', ?)`,
    )
    .run(id, id, now, now, config)
  m.db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)").run(id)
  const tax = insertVersioned(
    m.db,
    'taxes',
    id,
    { name: 'INC', type: 'inc', rate: 800 },
    SYSTEM,
    now,
  )
  const category = insertVersioned(
    m.db,
    'categories',
    id,
    { name: 'Otra', position: 0, station_id: null, photo: null },
    SYSTEM,
    now,
  )
  const product = insertVersioned(
    m.db,
    'products',
    id,
    {
      category_id: category,
      name: 'Plato ajeno',
      description: null,
      price: 10_000,
      tax_id: tax,
      photo: null,
      favorite: 0,
    },
    SYSTEM,
    now,
  )
  const photoOf = (productId: string) =>
    m.db.prepare('SELECT photo FROM products WHERE id = ?').get(productId)?.photo
  return { id, product, photoOf }
}

const versionOf = (m: { db: ReturnType<typeof setupMenu>['db'] }, restaurantId: string) =>
  Number(
    m.db
      .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
      .get(restaurantId)?.value,
  )

describe('odd names and path traversal', () => {
  // A "secret" file next to the photos folder, with a name that would pass the pattern.
  function withSecret() {
    const root = folder()
    const photosDir = join(root, 'photos')
    mkdirSync(photosDir)
    const secret = `${'a'.repeat(24)}.png`
    writeFileSync(join(root, secret), 'CONTENIDO-SECRETO')
    writeFileSync(join(root, 'pin-key'), 'CONTENIDO-SECRETO')
    return { root, photosDir, secret }
  }

  it('readPhoto rejects any name that is not the hash with its extension', () => {
    const { photosDir, secret } = withSecret()
    const h = 'a'.repeat(24)
    const oddOnes = [
      '',
      '.',
      '..',
      '/',
      `../${secret}`,
      `..\\${secret}`,
      `./${secret}`,
      `${h}.png/`,
      `/${h}.png`,
      `${h}.png\n`,
      `${h}.png\0`,
      `${h}.png\0.svg`,
      `${h}.PNG`,
      `${h.toUpperCase()}.png`,
      ` ${h}.png`,
      `${h}.png `,
      `${h}.gif`,
      `${h}.svg`,
      `${h}.html`,
      `${h}.png.php`,
      `${h}..png`,
      `${'a'.repeat(23)}.png`,
      `${'a'.repeat(25)}.png`,
      `${'g'.repeat(24)}.png`,
      `${h}`,
      `${h}.`,
      '%2e%2e%2f',
      'pin-key',
      '__proto__',
      'constructor',
      'toString',
      '𝟏𝟐𝟑',
    ]
    for (const name of oddOnes) {
      expect(PHOTO_NAME.test(name), JSON.stringify(name)).toBe(false)
      expect(readPhoto(photosDir, name), JSON.stringify(name)).toBeNull()
      expect(photoUrl(name), JSON.stringify(name)).toBeNull()
    }
  })

  it('photoUrl only accepts text shaped like a photo name', () => {
    for (const v of [
      null,
      undefined,
      0,
      1,
      true,
      {},
      [],
      [`${'a'.repeat(24)}.png`],
      Symbol.iterator,
    ])
      expect(photoUrl(v)).toBeNull()
    expect(photoUrl(`${'0'.repeat(24)}.jpg`)).toBe(`/photos/${'0'.repeat(24)}.jpg`)
    expect(photoUrl(`${'f'.repeat(24)}.png`)).toBe(`/photos/${'f'.repeat(24)}.png`)
  })

  it('over HTTP, no way of going up a level (encoded or double-encoded) reaches a file outside', async () => {
    const { root, photosDir, secret } = withSecret()
    const m = await setup({ photosDir })
    const h = 'a'.repeat(24)
    const urls = [
      `/photos/..%2F${secret}`,
      `/photos/%2e%2e%2f${secret}`,
      `/photos/%2E%2E%2F${secret}`,
      `/photos/..%5C${secret}`,
      `/photos/%252e%252e%252f${secret}`,
      `/photos/..%252F${secret}`,
      `/photos/%2e%2e/${secret}`,
      `/photos/../${secret}`,
      `/photos/./${h}.png`,
      `/photos/${h}.png%00`,
      `/photos/${h}.png%00.webp`,
      `/photos/${h}.png%0A`,
      `/photos/${h}.png%20`,
      `/photos/%20${h}.png`,
      `/photos/${h}.PNG`,
      `/photos/${h.toUpperCase()}.png`,
      `/photos/${h}.png/`,
      `/photos/${h}.png/extra`,
      `/photos/${h}.svg`,
      '/photos/',
      '/photos',
      '/photos/pin-key',
      '/photos/..%2Fclave-pin',
      `/photos//${secret}`,
      `/photos/%2F${secret}`,
      `/photos/${encodeURIComponent(join(root, secret))}`,
    ]
    for (const url of urls) {
      const r = await m.get(url)
      expect(r.statusCode, url).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, url).toBeLessThan(500)
      expect(r.body, url).not.toContain('CONTENIDO-SECRETO')
    }
    // The same photo, requested properly, does exist (the harness can read what is in the folder).
    const name = savePhoto(photosDir, asData('png', PNG))
    expect((await m.get(`/photos/${name}`)).statusCode).toBe(200)
  })

  it('a badly encoded URL returns a request error, not a 500', async () => {
    const m = await setup()
    for (const url of ['/photos/%', '/photos/%zz', '/photos/%E0%A4%A']) {
      const r = await m.get(url)
      expect([400, 404], url).toContain(r.statusCode)
    }
  })

  it('the file name on disk does not depend on anything the client sends', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const r = await m.post('/api/catalog/photos', {
      ...m.session('admin'),
      product_id: burrata.id,
      image: asData('png', PNG),
    })
    expect(r.statusCode).toBe(200)
    const files = readdirSync(m.photosDir as string)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(PHOTO_NAME)
    // An extra field (name, path) makes the request invalid: nothing that could influence it is
    // accepted.
    for (const extra of [{ name: '../x.png' }, { route: '/etc/passwd' }, { extension: 'svg' }]) {
      const bad = await m.post('/api/catalog/photos', {
        ...m.session('admin'),
        product_id: burrata.id,
        image: asData('png', PNG),
        ...extra,
      })
      expect(bad.statusCode).toBe(400)
    }
    expect(readdirSync(m.photosDir as string)).toEqual(files)
  })
})

describe('image format', () => {
  it('the type is decided by the bytes, not by what the data: header says', () => {
    const dir = folder()
    expect(savePhoto(dir, asData('webp', PNG))).toMatch(/\.png$/)
    expect(savePhoto(dir, asData('png', JPG))).toMatch(/\.jpg$/)
    expect(savePhoto(dir, asData('jpeg', WEBP))).toMatch(/\.webp$/)
  })

  it('rejects other declared types, even if the bytes are good', () => {
    const dir = folder()
    for (const type of ['gif', 'svg+xml', 'bmp', 'avif', 'heic', 'jpg', 'x-icon', 'WEBP', ''])
      expect(() => savePhoto(dir, asData(type, PNG)), type).toThrow(/WebP, JPEG o PNG/)
    expect(() => savePhoto(dir, `DATA:image/png;base64,${PNG.toString('base64')}`)).toThrow()
    expect(() =>
      savePhoto(dir, `data:image/png;charset=utf-8;base64,${PNG.toString('base64')}`),
    ).toThrow()
    expect(() => savePhoto(dir, `data:image/png,${PNG.toString('base64')}`)).toThrow()
    expect(() => savePhoto(dir, PNG.toString('base64'))).toThrow()
    expect(() => savePhoto(dir, '')).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('rejects base64 with spaces, line breaks, extra text or no content', () => {
    const dir = folder()
    const b64 = PNG.toString('base64')
    for (const badCase of [
      `data:image/png;base64,${b64}\n`,
      `data:image/png;base64, ${b64}`,
      `data:image/png;base64,${b64.slice(0, 4)}\n${b64.slice(4)}`,
      `data:image/png;base64,${b64}!`,
      `data:image/png;base64,${b64}<script>`,
      `data:image/png;base64,${b64.replace(/\+|\//g, '-')}-_`,
      'data:image/png;base64,',
      'data:image/png;base64,====',
    ])
      expect(() => savePhoto(dir, badCase), JSON.stringify(badCase.slice(0, 40))).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('incomplete or look-alike signatures are not accepted', () => {
    const dir = folder()
    const fakes = [
      Buffer.from([0xff]),
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xd8, 0x00]),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]),
      Buffer.from('RIFF\0\0\0\0WAVEfmt '),
      Buffer.from('RIFF\0\0\0\0WEB'),
      Buffer.from('GIF89a'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('<!doctype html>'),
      Buffer.from('%PDF-1.7'),
      Buffer.from('PK\x03\x04'),
    ]
    for (const b of fakes) expect(() => savePhoto(dir, asData('png', b))).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('a file with the signature at the start but odd padding is stored as is (not interpreted)', () => {
    const dir = folder()
    const dirty = Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')])
    const name = savePhoto(dir, asData('png', dirty))
    // It is always served with its image content-type: the browser does not run it.
    expect(readPhoto(dir, name)).toMatchObject({ mime: 'image/png' })
    expect(readPhoto(dir, name)?.bytes.equals(dirty)).toBe(true)
  })

  it('the bytes served are exactly the ones uploaded, with all 256 byte values', () => {
    const dir = folder()
    const all = Buffer.concat([PNG, Buffer.from(Array.from({ length: 256 }, (_, i) => i))])
    const name = savePhoto(dir, asData('png', all))
    expect(readPhoto(dir, name)?.bytes.equals(all)).toBe(true)
  })
})

describe('size at the limit', () => {
  it('a photo of exactly 1 MiB is saved; one of 1 MiB + 1 byte is not', () => {
    const dir = folder()
    const exactSize = jpgOf(MAX_PHOTO_SIZE)
    const name = savePhoto(dir, asData('jpeg', exactSize))
    expect(readFileSync(join(dir, name)).length).toBe(MAX_PHOTO_SIZE)
    expect(() => savePhoto(dir, asData('jpeg', jpgOf(MAX_PHOTO_SIZE + 1)))).toThrow(/1 MB/)
    expect(() => savePhoto(dir, asData('jpeg', jpgOf(MAX_PHOTO_SIZE - 1, 1)))).not.toThrow()
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('size is measured in decoded bytes, not in base64 characters', () => {
    const dir = folder()
    // Base64 of a 1 MiB file is ~1.33 million characters: it passes.
    const image = asData('jpeg', jpgOf(MAX_PHOTO_SIZE, 7))
    expect(image.length).toBeGreaterThan(MAX_PHOTO_SIZE)
    expect(() => savePhoto(dir, image)).not.toThrow()
  })

  it('over HTTP, the 1 MiB limit goes through the schema and the body limit', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const request = (image: string) =>
      m.post('/api/catalog/photos', {
        ...m.session('admin'),
        product_id: burrata.id,
        image,
      })
    const exactSize = await request(asData('jpeg', jpgOf(MAX_PHOTO_SIZE)))
    expect(exactSize.statusCode).toBe(200)

    const overLimit = await request(asData('jpeg', jpgOf(MAX_PHOTO_SIZE + 1, 2)))
    expect(overLimit.statusCode).toBe(400)
    expect(overLimit.json().message).toMatch(/1 MB/)

    // More than 1.5 million characters: the schema stops it.
    const huge = await request(`data:image/jpeg;base64,${'A'.repeat(1_600_000)}`)
    expect(huge.statusCode).toBe(400)

    // More than 2 MB of body: Fastify stops it before reading it.
    const absurd = await request(`data:image/jpeg;base64,${'A'.repeat(2_200_000)}`)
    expect(absurd.statusCode).toBe(413)

    // Nothing rejected left a file or changed the photo.
    expect(readdirSync(m.photosDir as string)).toHaveLength(1)
    expect(m.product('Burrata Spritz').photo).toMatch(/^\/photos\//)
  })

  it("the 2 MB limit only applies to the photos route: the others keep Fastify's", async () => {
    const m = await setup()
    const large = { ...m.session('admin'), changes: [], padding: 'x'.repeat(1_100_000) }
    const r = await m.post('/api/catalog/changes', large)
    expect(r.statusCode).toBe(413)
  })
})

describe('deduplication', () => {
  it('the same photo uploaded twice leaves a single file, a single version and a single alert', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const a = await m.upload('admin', burrata.id, asData('webp', WEBP))
    const version = versionOf(m, m.restaurantId)
    const b = await m.upload('admin', burrata.id, asData('webp', WEBP))
    expect(a.json()).toEqual(b.json())
    expect(readdirSync(m.photosDir as string)).toHaveLength(1)
    expect(m.notified).toHaveLength(1)
    expect(versionOf(m, m.restaurantId)).toBe(version)
  })

  it('two simultaneous uploads of the same photo leave a single file and a single change', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const body = (s: object) => ({
      ...s,
      product_id: burrata.id,
      image: asData('webp', WEBP),
    })
    // A single session: signing in again with the same user would close the previous one.
    const session = m.session('admin')
    const [x, y] = await Promise.all([
      m.post('/api/catalog/photos', body(session)),
      m.post('/api/catalog/photos', body(session)),
    ])
    expect([x.statusCode, y.statusCode]).toEqual([200, 200])
    expect(readdirSync(m.photosDir as string)).toHaveLength(1)
    expect(m.notified).toHaveLength(1)
  })

  it('two products with the same image share a file; removing it from one does not delete it for the other', async () => {
    const m = await setup()
    const a = m.product('Burrata Spritz')
    const b = m.products().find((p) => p.id !== a.id) as typeof a
    const ra = await m.upload('admin', a.id, asData('png', PNG))
    const rb = await m.upload('admin', b.id, asData('png', PNG))
    expect(ra.json().photo).toBe(rb.json().photo)
    expect(readdirSync(m.photosDir as string)).toHaveLength(1)
    await m.upload('admin', a.id, null)
    expect(
      m
        .catalog()
        .categories.flatMap((c) => c.products)
        .find((p) => p.id === a.id)?.photo,
    ).toBeNull()
    const remained = (await m.get(rb.json().photo)).statusCode
    expect(remained).toBe(200)
  })

  it('changing the photo leaves the previous one on disk (another product or a device with cache could use it)', async () => {
    const m = await setup()
    const a = m.product('Burrata Spritz')
    const first = (await m.upload('admin', a.id, asData('png', PNG))).json().photo
    const second = (await m.upload('admin', a.id, asData('webp', WEBP))).json().photo
    expect(first).not.toBe(second)
    expect(readdirSync(m.photosDir as string)).toHaveLength(2)
    expect((await m.get(first)).statusCode).toBe(200)
    expect(m.notified).toHaveLength(2)
  })

  it('removing the photo from a product that has none changes nothing and does not alert', async () => {
    const m = await setup()
    const a = m.product('Burrata Spritz')
    const version = versionOf(m, m.restaurantId)
    const r = await m.upload('admin', a.id, null)
    expect(r.json()).toEqual({ photo: null })
    expect(m.notified).toEqual([])
    expect(versionOf(m, m.restaurantId)).toBe(version)
  })

  it('different content gives different names, and the same content always the same one', () => {
    const dir = folder()
    const names = new Set<string>()
    for (let i = 0; i < 50; i++) names.add(savePhoto(dir, asData('jpeg', jpgOf(64, i))))
    expect(names.size).toBe(50)
    const another = folder()
    expect(savePhoto(another, asData('jpeg', jpgOf(64, 3)))).toBe(
      savePhoto(dir, asData('jpeg', jpgOf(64, 3))),
    )
  })

  it('the hash does not change with the declared type: same image, same file', () => {
    const dir = folder()
    expect(savePhoto(dir, asData('png', PNG))).toBe(savePhoto(dir, asData('webp', PNG)))
    expect(readdirSync(dir)).toHaveLength(1)
  })

  // A power cut on the register PC midway through the write leaves a truncated file with the right
  // name: uploading the photo again repairs it, and writes go through a temporary file.
  it('a file truncated by a cut midway through writing is repaired by uploading the photo again', () => {
    const dir = folder()
    const bytes = jpgOf(4096, 9)
    const name = savePhoto(dir, asData('jpeg', bytes))
    writeFileSync(join(dir, name), bytes.subarray(0, 100))
    savePhoto(dir, asData('jpeg', bytes))
    expect(readFileSync(join(dir, name)).equals(bytes)).toBe(true)
  })

  it('it leaves no temporary files in the folder, and an old temporary file (power cut) is never served', async () => {
    const m = await setup()
    const dir = m.photosDir as string
    mkdirSync(dir, { recursive: true })
    const orphan = `${'b'.repeat(24)}.png.123.tmp`
    writeFileSync(join(dir, orphan), 'MEDIO-ESCRITO')
    const name = savePhoto(dir, asData('png', PNG))
    expect(readdirSync(dir).sort()).toEqual([orphan, name].sort())
    expect(readPhoto(dir, orphan)).toBeNull()
    expect((await m.get(`/photos/${orphan}`)).statusCode).toBe(404)
  })
})

describe("another restaurant's products, archived ones and odd data", () => {
  it('a product from another restaurant in the same database does not exist for this hub', async () => {
    const m = await setup()
    const other = addAnotherRestaurant(m)
    const r = await m.upload('admin', other.product, asData('png', PNG))
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toMatch(/no existe/)
    expect(other.photoOf(other.product)).toBeNull()
    expect(readdirSync(m.photosDir as string)).toEqual([])
    expect(m.notified).toEqual([])
    // Nor can the photo be removed from someone else's product.
    const remove = await m.upload('admin', other.product, null)
    expect(remove.statusCode).toBe(400)
  })

  it('uploading the photo of an own product does not touch the other restaurant or its version', async () => {
    const m = await setup()
    const other = addAnotherRestaurant(m)
    const otherVersion = versionOf(m, other.id)
    const burrata = m.product('Burrata Spritz')
    expect((await m.upload('admin', burrata.id, asData('png', PNG))).statusCode).toBe(200)
    expect(other.photoOf(other.product)).toBeNull()
    expect(versionOf(m, other.id)).toBe(otherVersion)
    expect(readCatalog(m.db, other.id).categories.flatMap((c) => c.products)).toEqual([
      expect.objectContaining({ name: 'Plato ajeno', photo: null }),
    ])
  })

  it("one restaurant's menu does not bring the other's products or photos", async () => {
    const m = await setup()
    const other = addAnotherRestaurant(m)
    const name = savePhoto(m.photosDir as string, asData('png', PNG))
    m.db.prepare('UPDATE products SET photo = ? WHERE id = ?').run(name, other.product)
    const ownItem = m.catalog().categories.flatMap((c) => c.products)
    expect(ownItem.map((p) => p.name)).not.toContain('Plato ajeno')
    expect(ownItem.every((p) => p.photo === null)).toBe(true)
    const foreign = readCatalog(m.db, other.id).categories.flatMap((c) => c.products)
    expect(foreign.map((p) => p.photo)).toEqual([`/photos/${name}`])
  })

  it('an oddly shaped id does not reach the database: 400, never 500', async () => {
    const m = await setup()
    const session = m.session('admin')
    for (const id of [
      '',
      'x',
      "'; DROP TABLE producto; --",
      'A'.repeat(25),
      'A'.repeat(27),
      '0'.repeat(26),
      newId(),
    ]) {
      const r = await m.post('/api/catalog/photos', { ...session, product_id: id, image: null })
      expect(r.statusCode, id).toBe(400)
    }
    expect(m.products().length).toBeGreaterThan(0)
  })

  it('an incomplete request or one with wrong types is 400', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const s = m.session('admin')
    const badOnes: unknown[] = [
      null,
      [],
      {},
      { ...s },
      { ...s, product_id: burrata.id },
      { ...s, product_id: burrata.id, image: 5 },
      { ...s, product_id: burrata.id, image: '' },
      { ...s, product_id: burrata.id, image: {} },
      { ...s, product_id: 5, image: null },
      { product_id: burrata.id, image: null },
      { session_id: s.session_id, product_id: burrata.id, image: null },
      { ...s, secret: '', product_id: burrata.id, image: null },
    ]
    for (const body of badOnes) {
      const r = await m.post('/api/catalog/photos', body)
      expect(r.statusCode, JSON.stringify(body)).toBe(400)
    }
    const withoutType = await m.app.inject({
      method: 'POST',
      url: '/api/catalog/photos',
      payload: 'imagen=1',
      headers: { authorization: `Bearer ${m.register.token}`, 'content-type': 'text/plain' },
    })
    expect(withoutType.statusCode).toBeLessThan(500)
    expect(withoutType.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('an archived product: the menu does not show it, its photo is kept and comes back on reactivation', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.upload('admin', burrata.id, asData('png', PNG))).json().photo as string
    const archive = (active: 0 | 1) =>
      m.db
        .prepare('UPDATE products SET active = ?, version = version + 1000 WHERE id = ?')
        .run(active, burrata.id)
    archive(0)
    expect(m.products().map((p) => p.id)).not.toContain(burrata.id)
    // The photo is still available (an old order or a device with the old menu may request it).
    expect((await m.get(photo)).statusCode).toBe(200)
    archive(1)
    expect(m.product('Burrata Spritz').photo).toBe(photo)
  })

  it('uploading the photo of an already archived product is accepted and stays hidden until reactivation', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    m.db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(burrata.id)
    const r = await m.upload('admin', burrata.id, asData('webp', WEBP))
    expect(r.statusCode).toBe(200)
    expect(m.products().map((p) => p.id)).not.toContain(burrata.id)
    const row = m.db.prepare('SELECT photo, active FROM products WHERE id = ?').get(burrata.id)
    expect(row).toMatchObject({ photo: r.json().photo.replace('/photos/', ''), active: 0 })
  })

  it('a value stored in the database that is not a photo name comes out as no photo', () => {
    const m = setupMenu()
    const p = m.product('Burrata Spritz')
    for (const odd of [
      '../../etc/passwd',
      'foto.png',
      '',
      'http://x.co/a.png',
      `${'A'.repeat(24)}.png`,
      '<img src=x onerror=alert(1)>',
    ]) {
      m.db.prepare('UPDATE products SET photo = ? WHERE id = ?').run(odd, p.id)
      expect(m.product('Burrata Spritz').photo, odd).toBeNull()
    }
  })

  it('the catalog history records who changed the photo, from which device, and how it was', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.upload('admin', burrata.id, asData('png', PNG))).json().photo as string
    const row = m.db
      .prepare(
        "SELECT * FROM catalog_changes WHERE entity = 'products' AND record_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(burrata.id) as Record<string, string | null>
    expect(JSON.parse(String(row.after)).photo).toBe(photo.replace('/photos/', ''))
    expect(JSON.parse(String(row.before)).photo).toBeNull()
    expect(row.user_id).toBe(m.people.admin.userId)
    expect(row.device_id).toBe(m.register.connection.deviceId)
  })

  it('a later seed run does not delete the photo of a product someone already edited', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.upload('admin', burrata.id, asData('png', PNG))).json().photo
    for (let i = 0; i < 2; i++)
      seed(
        m.db,
        m.access,
        { restaurantId: m.restaurantId, roles: m.roles, menu: MENU, withoutStaff: true },
        m.clock(),
      )
    expect(m.product('Burrata Spritz').photo).toBe(photo)
  })
})

describe('without a photos folder (photosDir undefined)', () => {
  it('there is no route to upload or read: 404; the rest of the menu keeps working', async () => {
    const m = await setup({ photosDir: null })
    const burrata = m.product('Burrata Spritz')
    const upload = await m.upload('admin', burrata.id, asData('png', PNG))
    expect(upload.statusCode).toBe(404)
    expect((await m.get(`/photos/${'a'.repeat(24)}.png`)).statusCode).toBe(404)
    const menu = await m.app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { authorization: `Bearer ${m.register.token}` },
    })
    expect(menu.statusCode).toBe(200)
    expect(menu.json().categories.length).toBeGreaterThan(0)
  })

  it('the brand route exists even without a photos folder', async () => {
    const m = await setup({ photosDir: null })
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(readCatalog(m.db, m.restaurantId).restaurant.brand).toBe('faro')
  })

  it('photos already in the database show up in the menu as a path, even if they are not served', async () => {
    const m = await setup({ photosDir: null })
    const name = `${'c'.repeat(24)}.webp`
    m.db
      .prepare('UPDATE products SET photo = ? WHERE id = ?')
      .run(name, m.product('Burrata Spritz').id)
    expect(m.product('Burrata Spritz').photo).toBe(`/photos/${name}`)
    expect((await m.get(`/photos/${name}`)).statusCode).toBe(404)
  })

  it('the folder is created on first use, even if its parent folder does not exist', async () => {
    const dir = join(folder(), 'data', 'photos')
    const m = await setup({ photosDir: dir })
    const r = await m.upload('admin', m.product('Burrata Spritz').id, asData('png', PNG))
    expect(r.statusCode).toBe(200)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('if the folder cannot be created (a file is in the way), clean 500 and the photo does not change', async () => {
    const root = folder()
    const takenPath = join(root, 'photos')
    writeFileSync(takenPath, 'soy un archivo')
    const m = await setup({ photosDir: takenPath })
    const burrata = m.product('Burrata Spritz')
    const r = await m.upload('admin', burrata.id, asData('png', PNG))
    expect(r.statusCode).toBe(500)
    expect(r.body).not.toContain(root)
    expect(m.product('Burrata Spritz').photo).toBeNull()
    expect(m.notified).toEqual([])
  })

  it('reading from a folder that does not exist is 404, not 500', async () => {
    const m = await setup({ photosDir: join(folder(), 'no-existe') })
    expect((await m.get(`/photos/${'d'.repeat(24)}.png`)).statusCode).toBe(404)
  })
})

describe('hub restart with photos already saved', () => {
  it('a new server on the same database and folder serves the photos and includes them in the menu', async () => {
    const dir = folder()
    const before = await setup({ photosDir: dir })
    const burrata = before.product('Burrata Spritz')
    const photo = (await before.upload('admin', burrata.id, asData('webp', WEBP))).json()
      .photo as string
    await before.app.close()

    const after = await setup({ photosDir: dir, m: before })
    expect(after.product('Burrata Spritz').photo).toBe(photo)
    const r = await after.get(photo)
    expect(r.statusCode).toBe(200)
    expect(r.rawPayload.equals(WEBP)).toBe(true)
  })

  it('after a restart, uploading the same photo again neither rewrites the file nor creates another version', async () => {
    const dir = folder()
    const before = await setup({ photosDir: dir })
    const burrata = before.product('Burrata Spritz')
    const photo = (await before.upload('admin', burrata.id, asData('webp', WEBP))).json()
      .photo as string
    await before.app.close()

    const after = await setup({ photosDir: dir, m: before })
    const version = versionOf(after, after.restaurantId)
    const another = await after.upload('admin', burrata.id, asData('webp', WEBP))
    expect(another.json().photo).toBe(photo)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(after.notified).toEqual([])
    expect(versionOf(after, after.restaurantId)).toBe(version)
  })

  it('if the folder was lost but the database keeps the name, the menu includes it and the photo returns 404 until uploaded again', async () => {
    const dir = folder()
    const before = await setup({ photosDir: dir })
    const burrata = before.product('Burrata Spritz')
    const photo = (await before.upload('admin', burrata.id, asData('png', PNG))).json()
      .photo as string
    rmSync(dir, { recursive: true, force: true })
    expect((await before.get(photo)).statusCode).toBe(404)
    expect(before.product('Burrata Spritz').photo).toBe(photo)
    // Uploading it again restores it with the same name (the hash does not change). The database
    // already had that name.
    const another = await before.upload('admin', burrata.id, asData('png', PNG))
    expect(another.json().photo).toBe(photo)
    expect((await before.get(photo)).statusCode).toBe(200)
  })

  it('photos and brand survive running the seed again', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.upload('admin', burrata.id, asData('png', PNG))).json().photo
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    seed(
      m.db,
      m.access,
      { restaurantId: m.restaurantId, roles: m.roles, menu: MENU, withoutStaff: true },
      m.clock(),
    )
    expect(m.product('Burrata Spritz').photo).toBe(photo)
    expect(m.catalog().restaurant.brand).toBe('faro')
  })
})

describe('headers of the served photo', () => {
  it('each type comes with its content-type, its length and long immutable cache', async () => {
    const m = await setup()
    const cases = [
      ['webp', WEBP, 'image/webp'],
      ['jpeg', JPG, 'image/jpeg'],
      ['png', PNG, 'image/png'],
    ] as const
    for (const [type, bytes, mime] of cases) {
      const name = savePhoto(m.photosDir as string, asData(type, bytes))
      const r = await m.get(`/photos/${name}`)
      expect(r.statusCode).toBe(200)
      expect(r.headers['content-type']).toBe(mime)
      expect(r.headers['content-length']).toBe(String(bytes.length))
      expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(r.headers['set-cookie']).toBeUndefined()
      expect(r.rawPayload.equals(bytes)).toBe(true)
    }
  })

  it('HEAD responds the same as GET, without a body', async () => {
    const m = await setup()
    const name = savePhoto(m.photosDir as string, asData('png', PNG))
    const r = await m.app.inject({ method: 'HEAD', url: `/photos/${name}` })
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toMatch(/immutable/)
    expect(r.headers['content-type']).toBe('image/png')
    expect(r.rawPayload.length).toBe(0)
  })

  it('no token or session is needed to request a photo, and an invalid one does not get in the way', async () => {
    const m = await setup()
    const name = savePhoto(m.photosDir as string, asData('png', PNG))
    for (const authorization of [undefined, 'Bearer basura', 'Basic xx']) {
      const r = await m.app.inject({
        method: 'GET',
        url: `/photos/${name}`,
        headers: authorization ? { authorization } : {},
      })
      expect(r.statusCode).toBe(200)
    }
  })

  it('a 404 never carries immutable cache (otherwise the device would remember «does not exist» forever)', async () => {
    const m = await setup()
    const r = await m.get(`/photos/${'e'.repeat(24)}.png`)
    expect(r.statusCode).toBe(404)
    expect(r.headers['cache-control'] ?? '').not.toMatch(/immutable|max-age=\d{5,}/)
    const bad = await m.get('/photos/..%2Fx')
    expect(bad.headers['cache-control'] ?? '').not.toMatch(/immutable/)
  })

  it('the response to an upload (POST) is not cached', async () => {
    const m = await setup()
    const r = await m.upload('admin', m.product('Burrata Spritz').id, asData('png', PNG))
    expect(r.headers['cache-control'] ?? '').not.toMatch(/immutable|public/)
  })

  it('the same name always gives the same bytes (that is why immutable cache is safe)', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.upload('admin', burrata.id, asData('png', PNG))).json().photo as string
    const a = await m.get(photo)
    // A different photo afterwards does not change what is under the previous name.
    await m.upload('admin', burrata.id, asData('webp', WEBP))
    const b = await m.get(photo)
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true)
    expect(b.headers['content-type']).toBe(a.headers['content-type'])
  })
})

describe('session, device and permissions when uploading photos', () => {
  it('without a token, with a made-up token or one from a revoked device: 401, and nothing is saved', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const body = { ...m.session('admin'), product_id: burrata.id, image: asData('png', PNG) }
    expect((await m.post('/api/catalog/photos', body, null)).statusCode).toBe(401)
    expect((await m.post('/api/catalog/photos', body, 'token-inventado')).statusCode).toBe(401)

    const secondOne = m.pair('waiter')
    const admin2 = m.signIn(secondOne.connection, 'admin')
    const withdraw = m.access.revokeDevice(secondOne.connection, {
      sessionId: admin2.sessionId,
      secret: admin2.secret,
      deviceId: m.register.connection.deviceId,
    })
    expect(withdraw.ok).toBe(true)
    // The revoked device no longer uploads photos, even if its session was an admin's.
    const removed = await m.post('/api/catalog/photos', body)
    expect(removed.statusCode).toBe(401)
    expect(removed.json().error).toBe('invalid_token')
    expect(readdirSync(m.photosDir as string)).toEqual([])
  })

  it('with the wrong secret, with a closed session or one from another device: 401 invalid_session', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const goodOne = m.session('admin')
    const base = { product_id: burrata.id, image: asData('png', PNG) }

    const badSecret = await m.post('/api/catalog/photos', {
      ...goodOne,
      secret: 'other',
      ...base,
    })
    expect(badSecret.statusCode).toBe(401)
    expect(badSecret.json().error).toBe('invalid_session')

    const nonexistent = await m.post('/api/catalog/photos', {
      ...goodOne,
      session_id: newId(),
      ...base,
    })
    expect(nonexistent.statusCode).toBe(401)

    const closedSession = m.session('admin')
    m.access.closeSession(m.register.connection, {
      sessionId: closedSession.session_id,
      secret: closedSession.secret,
    })
    expect((await m.post('/api/catalog/photos', { ...closedSession, ...base })).statusCode).toBe(
      401,
    )

    const otherDevice = m.pair('waiter')
    const fromOther = m.session('admin', otherDevice.connection)
    const crossRequest = await m.post(
      '/api/catalog/photos',
      { ...fromOther, ...base },
      m.register.token,
    )
    expect(crossRequest.statusCode).toBe(401)

    expect(readdirSync(m.photosDir as string)).toEqual([])
    expect(m.notified).toEqual([])
  })

  it('the session of a person who is no longer active does not upload photos', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const s = m.session('manager')
    m.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(m.people.manager.userId)
    const r = await m.post('/api/catalog/photos', {
      ...s,
      product_id: burrata.id,
      image: asData('png', PNG),
    })
    expect(r.statusCode).toBe(401)
    expect(readdirSync(m.photosDir as string)).toEqual([])
  })

  it('waiter and cashier lack edit_catalog (403); the manager has it', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    for (const who of ['waiter', 'cashier'] as const) {
      const r = await m.upload(who, burrata.id, asData('png', PNG))
      expect(r.statusCode, who).toBe(403)
    }
    expect(readdirSync(m.photosDir as string)).toEqual([])
    const g = await m.upload('manager', burrata.id, asData('png', PNG))
    expect(g.statusCode).toBe(200)
  })

  it('the permission is checked before saving: a 403 leaves no file even if the image is valid', async () => {
    const m = await setup()
    await m.upload('waiter', m.product('Burrata Spritz').id, asData('webp', WEBP))
    expect(readdirSync(m.photosDir as string)).toEqual([])
  })
})

describe('restaurant brand', () => {
  const seeded = (m: ReturnType<typeof setupMenu>) =>
    seed(
      m.db,
      m.access,
      { restaurantId: m.restaurantId, roles: m.roles, menu: MENU, withoutStaff: true },
      m.clock(),
    )
  const rawConfig = (m: ReturnType<typeof setupMenu>, id = m.restaurantId) =>
    JSON.parse(String(m.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(id)?.config))

  it('an old hub, with an empty config or without the brand key, returns Faro and keeps the rest', () => {
    const m = setupMenu()
    for (const config of ['{}', '{"session_idle_min":10}', '{"suggested_tip":1000}']) {
      m.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run(config, m.restaurantId)
      const menu = readCatalog(m.db, m.restaurantId)
      expect(menu.restaurant.brand, config).toBe('faro')
    }
    m.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run('{"session_idle_min":10}', m.restaurantId)
    expect(readCatalog(m.db, m.restaurantId).restaurant.sessionIdleMin).toBe(10)
  })

  it('a freshly created hub (no seed) looks like Faro', () => {
    const m = setupMenu()
    const only = addAnotherRestaurant(m)
    expect(readCatalog(m.db, only.id).restaurant.brand).toBe('faro')
  })

  it('the seed sets the La Spritzzería brand on an old hub and does not repeat it on every run', () => {
    const m = setupMenu()
    expect(rawConfig(m).brand).toBe('la-spritzzeria')
    const before = versionOf(m, m.restaurantId)
    seeded(m)
    seeded(m)
    expect(versionOf(m, m.restaurantId)).toBe(before)
    expect(m.catalog().restaurant.brand).toBe('la-spritzzeria')
  })

  it('the seed keeps what is already configured and only adds the brand', () => {
    const m = setupMenu()
    m.db
      .prepare('UPDATE restaurants SET config = ?, user_id = NULL WHERE id = ?')
      .run('{"session_idle_min":7}', m.restaurantId)
    seeded(m)
    expect(rawConfig(m)).toMatchObject({ brand: 'la-spritzzeria', session_idle_min: 7 })
  })

  it('the seed respects the brand the restaurant chose, even if it is Faro (the default)', () => {
    const m = setupMenu()
    // Chosen by hand in the database, bypassing the API (user_id not set).
    m.db
      .prepare('UPDATE restaurants SET config = ?, user_id = NULL WHERE id = ?')
      .run(canonicalJson(fullConfig({ brand: 'faro' })), m.restaurantId)
    seeded(m)
    expect(m.catalog().restaurant.brand).toBe('faro')
    expect(rawConfig(m).brand).toBe('faro')
  })

  it('the seed respects a brand the restaurant chose through the API; and if it saved only {"brand":"faro"}, too', async () => {
    const m = await setup()
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    seeded(m)
    seeded(m)
    expect(m.catalog().restaurant.brand).toBe('faro')

    const other = setupMenu()
    other.db
      .prepare('UPDATE restaurants SET config = ?, user_id = NULL WHERE id = ?')
      .run('{"brand":"faro"}', other.restaurantId)
    seeded(other)
    expect(other.catalog().restaurant.brand).toBe('faro')
  })

  it('a brand chosen and then switched back to La Spritzzería stays that way after the seed', async () => {
    const m = await setup()
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'la-spritzzeria' })
    seeded(m)
    expect(m.catalog().restaurant.brand).toBe('la-spritzzeria')
    expect(m.notified).toHaveLength(2)
  })

  it('two restaurants in the same database each have their own brand', () => {
    const m = setupMenu()
    const other = addAnotherRestaurant(m, canonicalJson(fullConfig({ brand: 'faro' })))
    expect(readCatalog(m.db, m.restaurantId).restaurant.brand).toBe('la-spritzzeria')
    expect(readCatalog(m.db, other.id).restaurant.brand).toBe('faro')
    // This restaurant's seed does not touch the other's config.
    seeded(m)
    expect(rawConfig(m, other.id).brand).toBe('faro')
  })

  it("changing one restaurant's brand does not touch the other's or its version", async () => {
    const m = await setup()
    const other = addAnotherRestaurant(m, canonicalJson(fullConfig({ brand: 'la-spritzzeria' })))
    const otherVersion = versionOf(m, other.id)
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(readCatalog(m.db, other.id).restaurant.brand).toBe('la-spritzzeria')
    expect(versionOf(m, other.id)).toBe(otherVersion)
  })

  it('two different hubs (two restaurants) keep different brands', async () => {
    const a = await setup()
    const b = await setup()
    await a.post('/api/restaurant/brand', { ...a.session('admin'), brand: 'faro' })
    expect(a.catalog().restaurant.brand).toBe('faro')
    expect(b.catalog().restaurant.brand).toBe('la-spritzzeria')
  })

  it('changing the brand bumps the menu version and alerts once; repeating it does nothing', async () => {
    const m = await setup()
    const before = m.catalog().version
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.notified).toEqual([m.catalog().version])
    const after = m.catalog().version
    const another = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(another.json()).toEqual({ brand: 'faro' })
    expect(m.catalog().version).toBe(after)
    expect(m.notified).toHaveLength(1)
  })

  it('choosing Faro on an old hub (no brand in the config) does get written', async () => {
    const m = await setup()
    m.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run('{}', m.restaurantId)
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(rawConfig(m).brand).toBe('faro')
    expect(m.notified).toHaveLength(1)
  })

  it('changing the brand keeps the rest of the configuration and records who changed it', async () => {
    const m = await setup()
    m.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run('{"session_idle_min":9,"brand":"la-spritzzeria"}', m.restaurantId)
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(rawConfig(m)).toMatchObject({ session_idle_min: 9, brand: 'faro' })
    const row = m.db
      .prepare('SELECT user_id, device_id FROM restaurants WHERE id = ?')
      .get(m.restaurantId)
    expect(row).toEqual({
      user_id: m.people.admin.userId,
      device_id: m.register.connection.deviceId,
    })
  })

  it('brand values that do not exist are rejected with 400 and change nothing', async () => {
    const m = await setup()
    const before = m.catalog().version
    const s = m.session('admin')
    for (const brand of [
      '',
      'FARO',
      'Faro',
      ' faro',
      'faro ',
      'la_spritzzeria',
      'bagno',
      'taller',
      'noche',
      'neutra',
      null,
      0,
      true,
      {},
      ['faro'],
      undefined,
    ]) {
      const r = await m.post('/api/restaurant/brand', { ...s, brand })
      expect(r.statusCode, JSON.stringify(brand)).toBe(400)
    }
    const extra = await m.post('/api/restaurant/brand', { ...s, brand: 'faro', color: '#fff' })
    expect(extra.statusCode).toBe(400)
    expect(m.catalog().version).toBe(before)
    expect(m.notified).toEqual([])
    expect(m.catalog().restaurant.brand).toBe('la-spritzzeria')
  })

  it('without a token, with an invalid or closed session, one from another device or without permission: nothing changes', async () => {
    const m = await setup()
    const s = m.session('admin')
    const dev = (body: object, token: string | null = m.register.token) =>
      m.post('/api/restaurant/brand', { brand: 'faro', ...body }, token)

    expect((await dev(s, null)).statusCode).toBe(401)
    expect((await dev(s, 'token-inventado')).statusCode).toBe(401)
    const badCase = await dev({ ...s, secret: 'incorrecto' })
    expect(badCase.statusCode).toBe(401)
    expect(badCase.json().error).toBe('invalid_session')
    expect((await dev({ ...s, session_id: newId() })).statusCode).toBe(401)
    expect((await dev({ ...s, session_id: 'corto' })).statusCode).toBe(400)
    expect((await dev({ secret: s.secret })).statusCode).toBe(400)
    expect((await dev({})).statusCode).toBe(400)

    const closedSession = m.session('admin')
    m.access.closeSession(m.register.connection, {
      sessionId: closedSession.session_id,
      secret: closedSession.secret,
    })
    expect((await dev(closedSession)).statusCode).toBe(401)

    const otherDevice = m.pair('waiter')
    const fromOther = m.session('admin', otherDevice.connection)
    expect((await dev(fromOther)).statusCode).toBe(401)

    // With a valid session but without manage_users.
    for (const who of ['waiter', 'cashier', 'manager'] as const) {
      const r = await dev(m.session(who))
      expect(r.statusCode, who).toBe(403)
      expect(r.json().error).toBe('no_permission')
    }
    expect(m.catalog().restaurant.brand).toBe('la-spritzzeria')
    expect(m.notified).toEqual([])
  })

  it('a deactivated person can no longer change the brand', async () => {
    const m = await setup()
    const s = m.session('admin')
    m.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(m.people.admin.userId)
    expect((await m.post('/api/restaurant/brand', { ...s, brand: 'faro' })).statusCode).toBe(401)
    m.db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(m.people.admin.userId)
    expect((await m.post('/api/restaurant/brand', { ...s, brand: 'faro' })).statusCode).toBe(200)
  })
})

describe('brand in the menu the devices receive', () => {
  it('GET /api/catalog includes restaurant.brand and the photo as a path', async () => {
    const m = await setup()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.upload('admin', burrata.id, asData('png', PNG))).json().photo
    const r = await m.app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { authorization: `Bearer ${m.register.token}` },
    })
    const menu = r.json()
    expect(menu.restaurant.brand).toBe('la-spritzzeria')
    const product = menu.categories
      .flatMap((c: { products: { id: string; photo: string | null }[] }) => c.products)
      .find((p: { id: string }) => p.id === burrata.id)
    expect(product.photo).toBe(photo)
    // The other products have photo null (not missing): the contract is stable.
    const withoutPhoto = menu.categories
      .flatMap((c: { products: { id: string; photo: string | null }[] }) => c.products)
      .filter((p: { id: string }) => p.id !== burrata.id)
    expect(withoutPhoto.every((p: { photo: string | null }) => p.photo === null)).toBe(true)
  })
})
