import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, fullConfig, newId } from '@pos/core'
import { afterEach, describe, expect, it } from 'vitest'
import { insertarVersionado, SISTEMA } from './acceso/registros'
import { leerCatalogo } from './catalogo'
import { guardarFoto, leerFoto, NOMBRE_FOTO, TAMANO_MAXIMO_FOTO, urlFoto } from './fotos'
import { CARTA, montarCarta } from './pruebas-catalogo'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Fotos de los productos y marca del restaurante: bordes (tarea 1.3c). Lo básico está en
// fotos.test.ts; aquí, nombres raros, límites, deduplicación, varios restaurantes en la misma
// base, reinicios del hub, cabeceras de caché y sesiones inválidas.

const carpetas: string[] = []
afterEach(() => {
  for (const c of carpetas.splice(0)) rmSync(c, { recursive: true, force: true })
})
const carpeta = () => {
  const c = mkdtempSync(join(tmpdir(), 'pos-fotos-bordes-'))
  carpetas.push(c)
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
const comoDato = (type: string, b: Buffer) => `data:image/${type};base64,${b.toString('base64')}`
/** Un JPEG de ese tamaño exacto, con un relleno que cambia según `semilla`. */
const jpgDe = (bytes: number, seedValue = 0) => {
  const b = Buffer.alloc(bytes, seedValue)
  JPG.copy(b)
  return b
}

async function montar(
  options: { dirFotos?: string | null; m?: ReturnType<typeof montarCarta> } = {},
) {
  const m = options.m ?? montarCarta()
  const dirFotos = options.dirFotos === null ? undefined : (options.dirFotos ?? carpeta())
  const avisadas: number[] = []
  const app = crearServidor({
    access: m.access,
    catalog: {
      db: m.db,
      restauranteId: m.restauranteId,
      access: m.access,
      onChange: (v) => avisadas.push(v),
      clock: m.clock,
      ...(dirFotos ? { dirFotos } : {}),
    },
  })
  await app.ready()
  const register = m.emparejar('register')
  const session = (
    quien: 'admin' | 'manager' | 'cashier' | 'waiter',
    connection = register.connection,
  ) => {
    const s = m.entrar(connection, quien)
    return { session_id: s.sesionId, secret: s.secret }
  }
  const post = (url: string, payload: unknown, token: string | null = register.token) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  const subir = (quien: Parameters<typeof session>[0], productId: string, imagen: string | null) =>
    post('/api/catalog/photos', { ...session(quien), product_id: productId, imagen })
  const obtener = (url: string) => app.inject({ method: 'GET', url })
  return { ...m, app, dirFotos, avisadas, register, session, post, subir, obtener }
}

/** Un segundo restaurante en la misma base, con un producto suyo. */
function agregarOtroRestaurante(m: ReturnType<typeof montarCarta>, config = '{}') {
  const id = newId()
  const ahora = m.clock()
  m.db
    .prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Otro restaurante', ?)`,
    )
    .run(id, id, ahora, ahora, config)
  m.db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)").run(id)
  const tax = insertarVersionado(
    m.db,
    'taxes',
    id,
    { name: 'INC', type: 'inc', rate: 800 },
    SISTEMA,
    ahora,
  )
  const category = insertarVersionado(
    m.db,
    'categories',
    id,
    { name: 'Otra', position: 0, station_id: null, photo: null },
    SISTEMA,
    ahora,
  )
  const product = insertarVersionado(
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
    SISTEMA,
    ahora,
  )
  const fotoDe = (productId: string) =>
    m.db.prepare('SELECT photo FROM products WHERE id = ?').get(productId)?.photo
  return { id, product, fotoDe }
}

const versionDe = (m: { db: ReturnType<typeof montarCarta>['db'] }, restauranteId: string) =>
  Number(
    m.db
      .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
      .get(restauranteId)?.value,
  )

describe('nombres raros y path traversal', () => {
  // Un archivo "secreto" junto a la carpeta de fotos, con un nombre que sí pasaría el patrón.
  function conSecreto() {
    const root = carpeta()
    const dirFotos = join(root, 'photos')
    mkdirSync(dirFotos)
    const secret = `${'a'.repeat(24)}.png`
    writeFileSync(join(root, secret), 'CONTENIDO-SECRETO')
    writeFileSync(join(root, 'pin-key'), 'CONTENIDO-SECRETO')
    return { root, dirFotos, secret }
  }

  it('leerFoto rechaza cualquier nombre que no sea la huella con su extensión', () => {
    const { dirFotos, secret } = conSecreto()
    const h = 'a'.repeat(24)
    const raros = [
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
    for (const name of raros) {
      expect(NOMBRE_FOTO.test(name), JSON.stringify(name)).toBe(false)
      expect(leerFoto(dirFotos, name), JSON.stringify(name)).toBeNull()
      expect(urlFoto(name), JSON.stringify(name)).toBeNull()
    }
  })

  it('urlFoto solo acepta texto con forma de nombre de foto', () => {
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
      expect(urlFoto(v)).toBeNull()
    expect(urlFoto(`${'0'.repeat(24)}.jpg`)).toBe(`/photos/${'0'.repeat(24)}.jpg`)
    expect(urlFoto(`${'f'.repeat(24)}.png`)).toBe(`/photos/${'f'.repeat(24)}.png`)
  })

  it('por HTTP, ninguna forma de subir un nivel (ni codificada, ni doble) llega a un archivo de fuera', async () => {
    const { root, dirFotos, secret } = conSecreto()
    const m = await montar({ dirFotos })
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
      const r = await m.obtener(url)
      expect(r.statusCode, url).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, url).toBeLessThan(500)
      expect(r.body, url).not.toContain('CONTENIDO-SECRETO')
    }
    // La misma foto, bien pedida, sí existe (el arnés sí puede leer lo que está en la carpeta).
    const name = guardarFoto(dirFotos, comoDato('png', PNG))
    expect((await m.obtener(`/photos/${name}`)).statusCode).toBe(200)
  })

  it('una URL mal codificada responde un error de petición, no un 500', async () => {
    const m = await montar()
    for (const url of ['/photos/%', '/photos/%zz', '/photos/%E0%A4%A']) {
      const r = await m.obtener(url)
      expect([400, 404], url).toContain(r.statusCode)
    }
  })

  it('el nombre del archivo en disco no depende de nada que mande el cliente', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const r = await m.post('/api/catalog/photos', {
      ...m.session('admin'),
      product_id: burrata.id,
      imagen: comoDato('png', PNG),
    })
    expect(r.statusCode).toBe(200)
    const archivos = readdirSync(m.dirFotos as string)
    expect(archivos).toHaveLength(1)
    expect(archivos[0]).toMatch(NOMBRE_FOTO)
    // Un campo extra (nombre, ruta) hace inválido el pedido: no se acepta nada que lo influya.
    for (const extra of [{ name: '../x.png' }, { ruta: '/etc/passwd' }, { extension: 'svg' }]) {
      const mala = await m.post('/api/catalog/photos', {
        ...m.session('admin'),
        product_id: burrata.id,
        imagen: comoDato('png', PNG),
        ...extra,
      })
      expect(mala.statusCode).toBe(400)
    }
    expect(readdirSync(m.dirFotos as string)).toEqual(archivos)
  })
})

describe('formato de la imagen', () => {
  it('el tipo se decide por los bytes, no por lo que diga el encabezado data:', () => {
    const dir = carpeta()
    expect(guardarFoto(dir, comoDato('webp', PNG))).toMatch(/\.png$/)
    expect(guardarFoto(dir, comoDato('png', JPG))).toMatch(/\.jpg$/)
    expect(guardarFoto(dir, comoDato('jpeg', WEBP))).toMatch(/\.webp$/)
  })

  it('rechaza otros tipos declarados, aunque los bytes sean buenos', () => {
    const dir = carpeta()
    for (const type of ['gif', 'svg+xml', 'bmp', 'avif', 'heic', 'jpg', 'x-icon', 'WEBP', ''])
      expect(() => guardarFoto(dir, comoDato(type, PNG)), type).toThrow(/WebP, JPEG o PNG/)
    expect(() => guardarFoto(dir, `DATA:image/png;base64,${PNG.toString('base64')}`)).toThrow()
    expect(() =>
      guardarFoto(dir, `data:image/png;charset=utf-8;base64,${PNG.toString('base64')}`),
    ).toThrow()
    expect(() => guardarFoto(dir, `data:image/png,${PNG.toString('base64')}`)).toThrow()
    expect(() => guardarFoto(dir, PNG.toString('base64'))).toThrow()
    expect(() => guardarFoto(dir, '')).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('rechaza base64 con espacios, saltos de línea, texto extra o sin contenido', () => {
    const dir = carpeta()
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
      expect(() => guardarFoto(dir, badCase), JSON.stringify(badCase.slice(0, 40))).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('firmas incompletas o parecidas no se aceptan', () => {
    const dir = carpeta()
    const falsas = [
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
    for (const b of falsas) expect(() => guardarFoto(dir, comoDato('png', b))).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('un archivo con la firma al inicio pero con relleno raro se guarda tal cual (no se interpreta)', () => {
    const dir = carpeta()
    const sucio = Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')])
    const name = guardarFoto(dir, comoDato('png', sucio))
    // Se sirve siempre con su content-type de imagen: el navegador no lo ejecuta.
    expect(leerFoto(dir, name)).toMatchObject({ mime: 'image/png' })
    expect(leerFoto(dir, name)?.bytes.equals(sucio)).toBe(true)
  })

  it('los bytes servidos son exactamente los subidos, con los 256 valores de byte', () => {
    const dir = carpeta()
    const all = Buffer.concat([PNG, Buffer.from(Array.from({ length: 256 }, (_, i) => i))])
    const name = guardarFoto(dir, comoDato('png', all))
    expect(leerFoto(dir, name)?.bytes.equals(all)).toBe(true)
  })
})

describe('tamaño en el límite', () => {
  it('una foto de exactamente 1 MiB se guarda; de 1 MiB + 1 byte no', () => {
    const dir = carpeta()
    const justa = jpgDe(TAMANO_MAXIMO_FOTO)
    const name = guardarFoto(dir, comoDato('jpeg', justa))
    expect(readFileSync(join(dir, name)).length).toBe(TAMANO_MAXIMO_FOTO)
    expect(() => guardarFoto(dir, comoDato('jpeg', jpgDe(TAMANO_MAXIMO_FOTO + 1)))).toThrow(/1 MB/)
    expect(() => guardarFoto(dir, comoDato('jpeg', jpgDe(TAMANO_MAXIMO_FOTO - 1, 1)))).not.toThrow()
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('el tamaño se mide en bytes decodificados, no en caracteres de base64', () => {
    const dir = carpeta()
    // Base64 de un archivo de 1 MiB mide ~1,33 millones de caracteres: pasa.
    const imagen = comoDato('jpeg', jpgDe(TAMANO_MAXIMO_FOTO, 7))
    expect(imagen.length).toBeGreaterThan(TAMANO_MAXIMO_FOTO)
    expect(() => guardarFoto(dir, imagen)).not.toThrow()
  })

  it('por HTTP, el límite de 1 MiB pasa por el esquema y por el límite del cuerpo', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const request = (imagen: string) =>
      m.post('/api/catalog/photos', {
        ...m.session('admin'),
        product_id: burrata.id,
        imagen,
      })
    const justa = await request(comoDato('jpeg', jpgDe(TAMANO_MAXIMO_FOTO)))
    expect(justa.statusCode).toBe(200)

    const pasada = await request(comoDato('jpeg', jpgDe(TAMANO_MAXIMO_FOTO + 1, 2)))
    expect(pasada.statusCode).toBe(400)
    expect(pasada.json().message).toMatch(/1 MB/)

    // Más de 1,5 millones de caracteres: lo frena el esquema.
    const enorme = await request(`data:image/jpeg;base64,${'A'.repeat(1_600_000)}`)
    expect(enorme.statusCode).toBe(400)

    // Más de 2 MB de cuerpo: lo frena Fastify antes de leerlo.
    const absurdo = await request(`data:image/jpeg;base64,${'A'.repeat(2_200_000)}`)
    expect(absurdo.statusCode).toBe(413)

    // Nada de lo rechazado dejó archivo ni cambió la foto.
    expect(readdirSync(m.dirFotos as string)).toHaveLength(1)
    expect(m.product('Burrata Spritz').photo).toMatch(/^\/photos\//)
  })

  it('el límite de 2 MB solo vale para la ruta de fotos: las demás conservan el de Fastify', async () => {
    const m = await montar()
    const large = { ...m.session('admin'), changes: [], relleno: 'x'.repeat(1_100_000) }
    const r = await m.post('/api/catalog/changes', large)
    expect(r.statusCode).toBe(413)
  })
})

describe('deduplicación', () => {
  it('la misma foto subida dos veces deja un solo archivo, una sola versión y un solo aviso', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const a = await m.subir('admin', burrata.id, comoDato('webp', WEBP))
    const version = versionDe(m, m.restauranteId)
    const b = await m.subir('admin', burrata.id, comoDato('webp', WEBP))
    expect(a.json()).toEqual(b.json())
    expect(readdirSync(m.dirFotos as string)).toHaveLength(1)
    expect(m.avisadas).toHaveLength(1)
    expect(versionDe(m, m.restauranteId)).toBe(version)
  })

  it('dos subidas al mismo tiempo de la misma foto dejan un solo archivo y un solo cambio', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const cuerpo = (s: object) => ({
      ...s,
      product_id: burrata.id,
      imagen: comoDato('webp', WEBP),
    })
    // Una sola sesión: entrar de nuevo con el mismo usuario cerraría la anterior.
    const session = m.session('admin')
    const [x, y] = await Promise.all([
      m.post('/api/catalog/photos', cuerpo(session)),
      m.post('/api/catalog/photos', cuerpo(session)),
    ])
    expect([x.statusCode, y.statusCode]).toEqual([200, 200])
    expect(readdirSync(m.dirFotos as string)).toHaveLength(1)
    expect(m.avisadas).toHaveLength(1)
  })

  it('dos productos con la misma imagen comparten archivo; quitarla de uno no la borra para el otro', async () => {
    const m = await montar()
    const a = m.product('Burrata Spritz')
    const b = m.products().find((p) => p.id !== a.id) as typeof a
    const ra = await m.subir('admin', a.id, comoDato('png', PNG))
    const rb = await m.subir('admin', b.id, comoDato('png', PNG))
    expect(ra.json().photo).toBe(rb.json().photo)
    expect(readdirSync(m.dirFotos as string)).toHaveLength(1)
    await m.subir('admin', a.id, null)
    expect(
      m
        .catalog()
        .categories.flatMap((c) => c.products)
        .find((p) => p.id === a.id)?.photo,
    ).toBeNull()
    const quedaba = (await m.obtener(rb.json().photo)).statusCode
    expect(quedaba).toBe(200)
  })

  it('cambiar la foto deja la anterior en disco (otro producto o un equipo con caché podría usarla)', async () => {
    const m = await montar()
    const a = m.product('Burrata Spritz')
    const first = (await m.subir('admin', a.id, comoDato('png', PNG))).json().photo
    const segunda = (await m.subir('admin', a.id, comoDato('webp', WEBP))).json().photo
    expect(first).not.toBe(segunda)
    expect(readdirSync(m.dirFotos as string)).toHaveLength(2)
    expect((await m.obtener(first)).statusCode).toBe(200)
    expect(m.avisadas).toHaveLength(2)
  })

  it('quitar la foto de un producto que no tiene no cambia nada ni avisa', async () => {
    const m = await montar()
    const a = m.product('Burrata Spritz')
    const version = versionDe(m, m.restauranteId)
    const r = await m.subir('admin', a.id, null)
    expect(r.json()).toEqual({ photo: null })
    expect(m.avisadas).toEqual([])
    expect(versionDe(m, m.restauranteId)).toBe(version)
  })

  it('contenidos distintos dan nombres distintos y el mismo contenido, siempre el mismo', () => {
    const dir = carpeta()
    const names = new Set<string>()
    for (let i = 0; i < 50; i++) names.add(guardarFoto(dir, comoDato('jpeg', jpgDe(64, i))))
    expect(names.size).toBe(50)
    const another = carpeta()
    expect(guardarFoto(another, comoDato('jpeg', jpgDe(64, 3)))).toBe(
      guardarFoto(dir, comoDato('jpeg', jpgDe(64, 3))),
    )
  })

  it('la huella no cambia por el tipo declarado: misma imagen, mismo archivo', () => {
    const dir = carpeta()
    expect(guardarFoto(dir, comoDato('png', PNG))).toBe(guardarFoto(dir, comoDato('webp', PNG)))
    expect(readdirSync(dir)).toHaveLength(1)
  })

  // Un corte de luz del PC de caja a mitad de la escritura deja un archivo truncado con el nombre
  // correcto: volver a subir la foto lo repara, y lo que se escribe pasa por un temporal.
  it('un archivo truncado por un corte a mitad de escritura se repara al volver a subir la foto', () => {
    const dir = carpeta()
    const bytes = jpgDe(4096, 9)
    const name = guardarFoto(dir, comoDato('jpeg', bytes))
    writeFileSync(join(dir, name), bytes.subarray(0, 100))
    guardarFoto(dir, comoDato('jpeg', bytes))
    expect(readFileSync(join(dir, name)).equals(bytes)).toBe(true)
  })

  it('no deja temporales en la carpeta, y un temporal viejo (corte de luz) nunca se sirve', async () => {
    const m = await montar()
    const dir = m.dirFotos as string
    mkdirSync(dir, { recursive: true })
    const huerfano = `${'b'.repeat(24)}.png.123.tmp`
    writeFileSync(join(dir, huerfano), 'MEDIO-ESCRITO')
    const name = guardarFoto(dir, comoDato('png', PNG))
    expect(readdirSync(dir).sort()).toEqual([huerfano, name].sort())
    expect(leerFoto(dir, huerfano)).toBeNull()
    expect((await m.obtener(`/photos/${huerfano}`)).statusCode).toBe(404)
  })
})

describe('productos de otro restaurante, archivados y datos raros', () => {
  it('un producto de otro restaurante de la misma base no existe para este hub', async () => {
    const m = await montar()
    const other = agregarOtroRestaurante(m)
    const r = await m.subir('admin', other.product, comoDato('png', PNG))
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toMatch(/no existe/)
    expect(other.fotoDe(other.product)).toBeNull()
    expect(readdirSync(m.dirFotos as string)).toEqual([])
    expect(m.avisadas).toEqual([])
    // Tampoco se puede quitar la foto de un producto ajeno.
    const remove = await m.subir('admin', other.product, null)
    expect(remove.statusCode).toBe(400)
  })

  it('subir la foto de un producto propio no toca el otro restaurante ni su versión', async () => {
    const m = await montar()
    const other = agregarOtroRestaurante(m)
    const versionOtro = versionDe(m, other.id)
    const burrata = m.product('Burrata Spritz')
    expect((await m.subir('admin', burrata.id, comoDato('png', PNG))).statusCode).toBe(200)
    expect(other.fotoDe(other.product)).toBeNull()
    expect(versionDe(m, other.id)).toBe(versionOtro)
    expect(leerCatalogo(m.db, other.id).categories.flatMap((c) => c.products)).toEqual([
      expect.objectContaining({ name: 'Plato ajeno', photo: null }),
    ])
  })

  it('la carta de un restaurante no trae productos ni fotos del otro', async () => {
    const m = await montar()
    const other = agregarOtroRestaurante(m)
    const name = guardarFoto(m.dirFotos as string, comoDato('png', PNG))
    m.db.prepare('UPDATE products SET photo = ? WHERE id = ?').run(name, other.product)
    const propia = m.catalog().categories.flatMap((c) => c.products)
    expect(propia.map((p) => p.name)).not.toContain('Plato ajeno')
    expect(propia.every((p) => p.photo === null)).toBe(true)
    const ajena = leerCatalogo(m.db, other.id).categories.flatMap((c) => c.products)
    expect(ajena.map((p) => p.photo)).toEqual([`/photos/${name}`])
  })

  it('un id con forma rara no llega a la base: 400, nunca 500', async () => {
    const m = await montar()
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
      const r = await m.post('/api/catalog/photos', { ...session, product_id: id, imagen: null })
      expect(r.statusCode, id).toBe(400)
    }
    expect(m.products().length).toBeGreaterThan(0)
  })

  it('el pedido incompleto o con tipos equivocados es 400', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const s = m.session('admin')
    const malos: unknown[] = [
      null,
      [],
      {},
      { ...s },
      { ...s, product_id: burrata.id },
      { ...s, product_id: burrata.id, imagen: 5 },
      { ...s, product_id: burrata.id, imagen: '' },
      { ...s, product_id: burrata.id, imagen: {} },
      { ...s, product_id: 5, imagen: null },
      { product_id: burrata.id, imagen: null },
      { session_id: s.session_id, product_id: burrata.id, imagen: null },
      { ...s, secret: '', product_id: burrata.id, imagen: null },
    ]
    for (const cuerpo of malos) {
      const r = await m.post('/api/catalog/photos', cuerpo)
      expect(r.statusCode, JSON.stringify(cuerpo)).toBe(400)
    }
    const sinTipo = await m.app.inject({
      method: 'POST',
      url: '/api/catalog/photos',
      payload: 'imagen=1',
      headers: { authorization: `Bearer ${m.register.token}`, 'content-type': 'text/plain' },
    })
    expect(sinTipo.statusCode).toBeLessThan(500)
    expect(sinTipo.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('un producto archivado: la carta no lo muestra, su foto se conserva y vuelve al reactivarlo', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().photo as string
    const archive = (active: 0 | 1) =>
      m.db
        .prepare('UPDATE products SET active = ?, version = version + 1000 WHERE id = ?')
        .run(active, burrata.id)
    archive(0)
    expect(m.products().map((p) => p.id)).not.toContain(burrata.id)
    // La foto sigue disponible (un pedido viejo o un equipo con la carta anterior la puede pedir).
    expect((await m.obtener(photo)).statusCode).toBe(200)
    archive(1)
    expect(m.product('Burrata Spritz').photo).toBe(photo)
  })

  it('subir la foto de un producto ya archivado se acepta y queda oculta hasta reactivarlo', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    m.db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(burrata.id)
    const r = await m.subir('admin', burrata.id, comoDato('webp', WEBP))
    expect(r.statusCode).toBe(200)
    expect(m.products().map((p) => p.id)).not.toContain(burrata.id)
    const row = m.db.prepare('SELECT photo, active FROM products WHERE id = ?').get(burrata.id)
    expect(row).toMatchObject({ photo: r.json().photo.replace('/photos/', ''), active: 0 })
  })

  it('un valor guardado en la base que no es un nombre de foto sale como sin foto', () => {
    const m = montarCarta()
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

  it('el historial del catálogo anota quién cambió la foto, desde qué equipo, y cómo estaba', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().photo as string
    const row = m.db
      .prepare(
        "SELECT * FROM catalog_changes WHERE entity = 'products' AND record_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(burrata.id) as Record<string, string | null>
    expect(JSON.parse(String(row.after)).photo).toBe(photo.replace('/photos/', ''))
    expect(JSON.parse(String(row.before)).photo).toBeNull()
    expect(row.user_id).toBe(m.people.admin.userId)
    expect(row.device_id).toBe(m.register.connection.dispositivoId)
  })

  it('el seed que corre después no borra la foto de un producto que alguien ya editó', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().photo
    for (let i = 0; i < 2; i++)
      sembrar(
        m.db,
        m.access,
        { restauranteId: m.restauranteId, roles: m.roles, menu: CARTA, sinPersonal: true },
        m.clock(),
      )
    expect(m.product('Burrata Spritz').photo).toBe(photo)
  })
})

describe('sin carpeta de fotos (dirFotos sin definir)', () => {
  it('no hay ruta para subir ni para leer: 404; el resto de la carta sigue funcionando', async () => {
    const m = await montar({ dirFotos: null })
    const burrata = m.product('Burrata Spritz')
    const subir = await m.subir('admin', burrata.id, comoDato('png', PNG))
    expect(subir.statusCode).toBe(404)
    expect((await m.obtener(`/photos/${'a'.repeat(24)}.png`)).statusCode).toBe(404)
    const menu = await m.app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { authorization: `Bearer ${m.register.token}` },
    })
    expect(menu.statusCode).toBe(200)
    expect(menu.json().categories.length).toBeGreaterThan(0)
  })

  it('la ruta de la marca sí existe aunque no haya carpeta de fotos', async () => {
    const m = await montar({ dirFotos: null })
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(leerCatalogo(m.db, m.restauranteId).restaurant.brand).toBe('faro')
  })

  it('las fotos que ya estén en la base salen en la carta como ruta, aunque no se sirvan', async () => {
    const m = await montar({ dirFotos: null })
    const name = `${'c'.repeat(24)}.webp`
    m.db
      .prepare('UPDATE products SET photo = ? WHERE id = ?')
      .run(name, m.product('Burrata Spritz').id)
    expect(m.product('Burrata Spritz').photo).toBe(`/photos/${name}`)
    expect((await m.obtener(`/photos/${name}`)).statusCode).toBe(404)
  })

  it('la carpeta se crea al primer uso, aunque no exista ni su carpeta madre', async () => {
    const dir = join(carpeta(), 'data', 'photos')
    const m = await montar({ dirFotos: dir })
    const r = await m.subir('admin', m.product('Burrata Spritz').id, comoDato('png', PNG))
    expect(r.statusCode).toBe(200)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('si la carpeta no se puede crear (ocupada por un archivo), 500 limpio y la foto no cambia', async () => {
    const root = carpeta()
    const ocupada = join(root, 'photos')
    writeFileSync(ocupada, 'soy un archivo')
    const m = await montar({ dirFotos: ocupada })
    const burrata = m.product('Burrata Spritz')
    const r = await m.subir('admin', burrata.id, comoDato('png', PNG))
    expect(r.statusCode).toBe(500)
    expect(r.body).not.toContain(root)
    expect(m.product('Burrata Spritz').photo).toBeNull()
    expect(m.avisadas).toEqual([])
  })

  it('leer de una carpeta que no existe es 404, no 500', async () => {
    const m = await montar({ dirFotos: join(carpeta(), 'no-existe') })
    expect((await m.obtener(`/photos/${'d'.repeat(24)}.png`)).statusCode).toBe(404)
  })
})

describe('reinicio del hub con fotos ya guardadas', () => {
  it('un servidor nuevo sobre la misma base y carpeta sirve las fotos y las trae en la carta', async () => {
    const dir = carpeta()
    const before = await montar({ dirFotos: dir })
    const burrata = before.product('Burrata Spritz')
    const photo = (await before.subir('admin', burrata.id, comoDato('webp', WEBP))).json()
      .photo as string
    await before.app.close()

    const after = await montar({ dirFotos: dir, m: before })
    expect(after.product('Burrata Spritz').photo).toBe(photo)
    const r = await after.obtener(photo)
    expect(r.statusCode).toBe(200)
    expect(r.rawPayload.equals(WEBP)).toBe(true)
  })

  it('tras reiniciar, volver a subir la misma foto no reescribe el archivo ni crea otra versión', async () => {
    const dir = carpeta()
    const before = await montar({ dirFotos: dir })
    const burrata = before.product('Burrata Spritz')
    const photo = (await before.subir('admin', burrata.id, comoDato('webp', WEBP))).json()
      .photo as string
    await before.app.close()

    const after = await montar({ dirFotos: dir, m: before })
    const version = versionDe(after, after.restauranteId)
    const another = await after.subir('admin', burrata.id, comoDato('webp', WEBP))
    expect(another.json().photo).toBe(photo)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(after.avisadas).toEqual([])
    expect(versionDe(after, after.restauranteId)).toBe(version)
  })

  it('si la carpeta se perdió pero la base conserva el nombre, la carta lo trae y la foto da 404 hasta volver a subirla', async () => {
    const dir = carpeta()
    const before = await montar({ dirFotos: dir })
    const burrata = before.product('Burrata Spritz')
    const photo = (await before.subir('admin', burrata.id, comoDato('png', PNG))).json()
      .photo as string
    rmSync(dir, { recursive: true, force: true })
    expect((await before.obtener(photo)).statusCode).toBe(404)
    expect(before.product('Burrata Spritz').photo).toBe(photo)
    // Volver a subirla la repone con el mismo nombre (la huella no cambia). La base ya tenía ese nombre.
    const another = await before.subir('admin', burrata.id, comoDato('png', PNG))
    expect(another.json().photo).toBe(photo)
    expect((await before.obtener(photo)).statusCode).toBe(200)
  })

  it('las fotos y la marca sobreviven a volver a correr el seed', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().photo
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    sembrar(
      m.db,
      m.access,
      { restauranteId: m.restauranteId, roles: m.roles, menu: CARTA, sinPersonal: true },
      m.clock(),
    )
    expect(m.product('Burrata Spritz').photo).toBe(photo)
    expect(m.catalog().restaurant.brand).toBe('faro')
  })
})

describe('cabeceras de la foto servida', () => {
  it('cada tipo sale con su content-type, su largo y caché larga e inmutable', async () => {
    const m = await montar()
    const casos = [
      ['webp', WEBP, 'image/webp'],
      ['jpeg', JPG, 'image/jpeg'],
      ['png', PNG, 'image/png'],
    ] as const
    for (const [type, bytes, mime] of casos) {
      const name = guardarFoto(m.dirFotos as string, comoDato(type, bytes))
      const r = await m.obtener(`/photos/${name}`)
      expect(r.statusCode).toBe(200)
      expect(r.headers['content-type']).toBe(mime)
      expect(r.headers['content-length']).toBe(String(bytes.length))
      expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(r.headers['set-cookie']).toBeUndefined()
      expect(r.rawPayload.equals(bytes)).toBe(true)
    }
  })

  it('HEAD responde lo mismo que GET, sin cuerpo', async () => {
    const m = await montar()
    const name = guardarFoto(m.dirFotos as string, comoDato('png', PNG))
    const r = await m.app.inject({ method: 'HEAD', url: `/photos/${name}` })
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toMatch(/immutable/)
    expect(r.headers['content-type']).toBe('image/png')
    expect(r.rawPayload.length).toBe(0)
  })

  it('no hace falta token ni sesión para pedir una foto, y uno inválido tampoco estorba', async () => {
    const m = await montar()
    const name = guardarFoto(m.dirFotos as string, comoDato('png', PNG))
    for (const authorization of [undefined, 'Bearer basura', 'Basic xx']) {
      const r = await m.app.inject({
        method: 'GET',
        url: `/photos/${name}`,
        headers: authorization ? { authorization } : {},
      })
      expect(r.statusCode).toBe(200)
    }
  })

  it('un 404 nunca lleva caché inmutable (si no, el equipo recordaría «no existe» para siempre)', async () => {
    const m = await montar()
    const r = await m.obtener(`/photos/${'e'.repeat(24)}.png`)
    expect(r.statusCode).toBe(404)
    expect(r.headers['cache-control'] ?? '').not.toMatch(/immutable|max-age=\d{5,}/)
    const mala = await m.obtener('/photos/..%2Fx')
    expect(mala.headers['cache-control'] ?? '').not.toMatch(/immutable/)
  })

  it('la respuesta a una subida (POST) no se guarda en caché', async () => {
    const m = await montar()
    const r = await m.subir('admin', m.product('Burrata Spritz').id, comoDato('png', PNG))
    expect(r.headers['cache-control'] ?? '').not.toMatch(/immutable|public/)
  })

  it('el mismo nombre siempre da los mismos bytes (por eso la caché inmutable es segura)', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().photo as string
    const a = await m.obtener(photo)
    // Otra foto distinta después no cambia lo que hay bajo el nombre anterior.
    await m.subir('admin', burrata.id, comoDato('webp', WEBP))
    const b = await m.obtener(photo)
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true)
    expect(b.headers['content-type']).toBe(a.headers['content-type'])
  })
})

describe('sesión, equipo y permisos al subir fotos', () => {
  it('sin token, con token inventado o de un equipo retirado: 401, y no se guarda nada', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const cuerpo = { ...m.session('admin'), product_id: burrata.id, imagen: comoDato('png', PNG) }
    expect((await m.post('/api/catalog/photos', cuerpo, null)).statusCode).toBe(401)
    expect((await m.post('/api/catalog/photos', cuerpo, 'token-inventado')).statusCode).toBe(401)

    const secondOne = m.emparejar('waiter')
    const admin2 = m.entrar(secondOne.connection, 'admin')
    const retirar = m.access.revocarDispositivo(secondOne.connection, {
      sesionId: admin2.sesionId,
      secret: admin2.secret,
      dispositivoId: m.register.connection.dispositivoId,
    })
    expect(retirar.ok).toBe(true)
    // El equipo retirado ya no sube fotos, aunque su sesión fuera de administrador.
    const removed = await m.post('/api/catalog/photos', cuerpo)
    expect(removed.statusCode).toBe(401)
    expect(removed.json().error).toBe('invalid_token')
    expect(readdirSync(m.dirFotos as string)).toEqual([])
  })

  it('con el secreto equivocado, con una sesión cerrada o de otro equipo: 401 sesion_invalida', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const buena = m.session('admin')
    const base = { product_id: burrata.id, imagen: comoDato('png', PNG) }

    const secretoMalo = await m.post('/api/catalog/photos', { ...buena, secret: 'other', ...base })
    expect(secretoMalo.statusCode).toBe(401)
    expect(secretoMalo.json().error).toBe('invalid_session')

    const nonexistent = await m.post('/api/catalog/photos', {
      ...buena,
      session_id: newId(),
      ...base,
    })
    expect(nonexistent.statusCode).toBe(401)

    const cerrada = m.session('admin')
    m.access.cerrarSesion(m.register.connection, {
      sesionId: cerrada.session_id,
      secret: cerrada.secret,
    })
    expect((await m.post('/api/catalog/photos', { ...cerrada, ...base })).statusCode).toBe(401)

    const otroEquipo = m.emparejar('waiter')
    const fromOther = m.session('admin', otroEquipo.connection)
    const cruzada = await m.post('/api/catalog/photos', { ...fromOther, ...base }, m.register.token)
    expect(cruzada.statusCode).toBe(401)

    expect(readdirSync(m.dirFotos as string)).toEqual([])
    expect(m.avisadas).toEqual([])
  })

  it('la sesión de una persona que ya no está activa no sube fotos', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const s = m.session('manager')
    m.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(m.people.manager.userId)
    const r = await m.post('/api/catalog/photos', {
      ...s,
      product_id: burrata.id,
      imagen: comoDato('png', PNG),
    })
    expect(r.statusCode).toBe(401)
    expect(readdirSync(m.dirFotos as string)).toEqual([])
  })

  it('mesero y cajero no tienen editar_catalogo (403); el gerente sí', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    for (const quien of ['waiter', 'cashier'] as const) {
      const r = await m.subir(quien, burrata.id, comoDato('png', PNG))
      expect(r.statusCode, quien).toBe(403)
    }
    expect(readdirSync(m.dirFotos as string)).toEqual([])
    const g = await m.subir('manager', burrata.id, comoDato('png', PNG))
    expect(g.statusCode).toBe(200)
  })

  it('el permiso se revisa antes de guardar: un 403 no deja archivo aunque la imagen sea válida', async () => {
    const m = await montar()
    await m.subir('waiter', m.product('Burrata Spritz').id, comoDato('webp', WEBP))
    expect(readdirSync(m.dirFotos as string)).toEqual([])
  })
})

describe('marca del restaurante', () => {
  const sembrada = (m: ReturnType<typeof montarCarta>) =>
    sembrar(
      m.db,
      m.access,
      { restauranteId: m.restauranteId, roles: m.roles, menu: CARTA, sinPersonal: true },
      m.clock(),
    )
  const configCruda = (m: ReturnType<typeof montarCarta>, id = m.restauranteId) =>
    JSON.parse(String(m.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(id)?.config))

  it('un hub viejo, con la config vacía o sin la clave marca, entrega Faro y conserva el resto', () => {
    const m = montarCarta()
    for (const config of ['{}', '{"session_idle_min":10}', '{"suggested_tip":1000}']) {
      m.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run(config, m.restauranteId)
      const menu = leerCatalogo(m.db, m.restauranteId)
      expect(menu.restaurant.brand, config).toBe('faro')
    }
    m.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run('{"session_idle_min":10}', m.restauranteId)
    expect(leerCatalogo(m.db, m.restauranteId).restaurant.sesionInactividadMin).toBe(10)
  })

  it('un hub recién creado (sin seed) se ve como Faro', () => {
    const m = montarCarta()
    const only = agregarOtroRestaurante(m)
    expect(leerCatalogo(m.db, only.id).restaurant.brand).toBe('faro')
  })

  it('el seed pone la marca de La Spritzzería a un hub viejo y no la repite en cada corrida', () => {
    const m = montarCarta()
    expect(configCruda(m).brand).toBe('la-spritzzeria')
    const before = versionDe(m, m.restauranteId)
    sembrada(m)
    sembrada(m)
    expect(versionDe(m, m.restauranteId)).toBe(before)
    expect(m.catalog().restaurant.brand).toBe('la-spritzzeria')
  })

  it('el seed conserva lo ya configurado y agrega solo la marca', () => {
    const m = montarCarta()
    m.db
      .prepare('UPDATE restaurants SET config = ?, user_id = NULL WHERE id = ?')
      .run('{"session_idle_min":7}', m.restauranteId)
    sembrada(m)
    expect(configCruda(m)).toMatchObject({ brand: 'la-spritzzeria', session_idle_min: 7 })
  })

  it('el seed respeta la marca que el restaurante eligió, aunque sea Faro (la de por defecto)', () => {
    const m = montarCarta()
    // Elegida a mano en la base, sin pasar por la API (user_id sin marcar).
    m.db
      .prepare('UPDATE restaurants SET config = ?, user_id = NULL WHERE id = ?')
      .run(canonicalJson(fullConfig({ brand: 'faro' })), m.restauranteId)
    sembrada(m)
    expect(m.catalog().restaurant.brand).toBe('faro')
    expect(configCruda(m).brand).toBe('faro')
  })

  it('el seed respeta una marca que el restaurante eligió con la API; y si guardó solo {"marca":"faro"}, también', async () => {
    const m = await montar()
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    sembrada(m)
    sembrada(m)
    expect(m.catalog().restaurant.brand).toBe('faro')

    const other = montarCarta()
    other.db
      .prepare('UPDATE restaurants SET config = ?, user_id = NULL WHERE id = ?')
      .run('{"brand":"faro"}', other.restauranteId)
    sembrada(other)
    expect(other.catalog().restaurant.brand).toBe('faro')
  })

  it('una marca elegida y luego devuelta a La Spritzzería queda así tras el seed', async () => {
    const m = await montar()
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'la-spritzzeria' })
    sembrada(m)
    expect(m.catalog().restaurant.brand).toBe('la-spritzzeria')
    expect(m.avisadas).toHaveLength(2)
  })

  it('dos restaurantes en la misma base tienen cada uno su marca', () => {
    const m = montarCarta()
    const other = agregarOtroRestaurante(m, canonicalJson(fullConfig({ brand: 'faro' })))
    expect(leerCatalogo(m.db, m.restauranteId).restaurant.brand).toBe('la-spritzzeria')
    expect(leerCatalogo(m.db, other.id).restaurant.brand).toBe('faro')
    // El seed de este restaurante no toca el config del otro.
    sembrada(m)
    expect(configCruda(m, other.id).brand).toBe('faro')
  })

  it('cambiar la marca de un restaurante no toca la del otro ni su versión', async () => {
    const m = await montar()
    const other = agregarOtroRestaurante(m, canonicalJson(fullConfig({ brand: 'la-spritzzeria' })))
    const versionOtro = versionDe(m, other.id)
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(leerCatalogo(m.db, other.id).restaurant.brand).toBe('la-spritzzeria')
    expect(versionDe(m, other.id)).toBe(versionOtro)
  })

  it('dos hubs distintos (dos restaurantes) mantienen marcas distintas', async () => {
    const a = await montar()
    const b = await montar()
    await a.post('/api/restaurant/brand', { ...a.session('admin'), brand: 'faro' })
    expect(a.catalog().restaurant.brand).toBe('faro')
    expect(b.catalog().restaurant.brand).toBe('la-spritzzeria')
  })

  it('cambiar la marca sube la versión de la carta y avisa una sola vez; repetirla no hace nada', async () => {
    const m = await montar()
    const before = m.catalog().version
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.avisadas).toEqual([m.catalog().version])
    const after = m.catalog().version
    const another = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(another.json()).toEqual({ brand: 'faro' })
    expect(m.catalog().version).toBe(after)
    expect(m.avisadas).toHaveLength(1)
  })

  it('elegir Faro en un hub viejo (sin marca en la config) sí queda escrito', async () => {
    const m = await montar()
    m.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run('{}', m.restauranteId)
    const r = await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(configCruda(m).brand).toBe('faro')
    expect(m.avisadas).toHaveLength(1)
  })

  it('al cambiar la marca se conserva el resto de la configuración y queda quién la cambió', async () => {
    const m = await montar()
    m.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run('{"session_idle_min":9,"brand":"la-spritzzeria"}', m.restauranteId)
    await m.post('/api/restaurant/brand', { ...m.session('admin'), brand: 'faro' })
    expect(configCruda(m)).toMatchObject({ session_idle_min: 9, brand: 'faro' })
    const row = m.db
      .prepare('SELECT user_id, device_id FROM restaurants WHERE id = ?')
      .get(m.restauranteId)
    expect(row).toEqual({
      user_id: m.people.admin.userId,
      device_id: m.register.connection.dispositivoId,
    })
  })

  it('valores de marca que no existen se rechazan con 400 y no cambian nada', async () => {
    const m = await montar()
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
    expect(m.avisadas).toEqual([])
    expect(m.catalog().restaurant.brand).toBe('la-spritzzeria')
  })

  it('sin token, con sesión inválida, cerrada, de otro equipo o sin permiso: nada cambia', async () => {
    const m = await montar()
    const s = m.session('admin')
    const dev = (cuerpo: object, token: string | null = m.register.token) =>
      m.post('/api/restaurant/brand', { brand: 'faro', ...cuerpo }, token)

    expect((await dev(s, null)).statusCode).toBe(401)
    expect((await dev(s, 'token-inventado')).statusCode).toBe(401)
    const badCase = await dev({ ...s, secret: 'incorrecto' })
    expect(badCase.statusCode).toBe(401)
    expect(badCase.json().error).toBe('invalid_session')
    expect((await dev({ ...s, session_id: newId() })).statusCode).toBe(401)
    expect((await dev({ ...s, session_id: 'corto' })).statusCode).toBe(400)
    expect((await dev({ secret: s.secret })).statusCode).toBe(400)
    expect((await dev({})).statusCode).toBe(400)

    const cerrada = m.session('admin')
    m.access.cerrarSesion(m.register.connection, {
      sesionId: cerrada.session_id,
      secret: cerrada.secret,
    })
    expect((await dev(cerrada)).statusCode).toBe(401)

    const otroEquipo = m.emparejar('waiter')
    const fromOther = m.session('admin', otroEquipo.connection)
    expect((await dev(fromOther)).statusCode).toBe(401)

    // Con sesión válida pero sin manage_users.
    for (const quien of ['waiter', 'cashier', 'manager'] as const) {
      const r = await dev(m.session(quien))
      expect(r.statusCode, quien).toBe(403)
      expect(r.json().error).toBe('no_permission')
    }
    expect(m.catalog().restaurant.brand).toBe('la-spritzzeria')
    expect(m.avisadas).toEqual([])
  })

  it('la persona dada de baja ya no cambia la marca', async () => {
    const m = await montar()
    const s = m.session('admin')
    m.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(m.people.admin.userId)
    expect((await m.post('/api/restaurant/brand', { ...s, brand: 'faro' })).statusCode).toBe(401)
    m.db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(m.people.admin.userId)
    expect((await m.post('/api/restaurant/brand', { ...s, brand: 'faro' })).statusCode).toBe(200)
  })
})

describe('marca en la carta que reciben los equipos', () => {
  it('GET /api/catalogo trae restaurante.marca y la foto como ruta', async () => {
    const m = await montar()
    const burrata = m.product('Burrata Spritz')
    const photo = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().photo
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
    // Los demás productos traen foto null (no ausente): el contrato es estable.
    const sinFoto = menu.categories
      .flatMap((c: { products: { id: string; photo: string | null }[] }) => c.products)
      .filter((p: { id: string }) => p.id !== burrata.id)
    expect(sinFoto.every((p: { photo: string | null }) => p.photo === null)).toBe(true)
  })
})
