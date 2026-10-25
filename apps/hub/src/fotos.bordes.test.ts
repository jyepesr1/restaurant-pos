import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configCompleta, jsonCanonico, nuevoId } from '@pos/core'
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
const comoDato = (tipo: string, b: Buffer) => `data:image/${tipo};base64,${b.toString('base64')}`
/** Un JPEG de ese tamaño exacto, con un relleno que cambia según `semilla`. */
const jpgDe = (bytes: number, semilla = 0) => {
  const b = Buffer.alloc(bytes, semilla)
  JPG.copy(b)
  return b
}

async function montar(
  opciones: { dirFotos?: string | null; m?: ReturnType<typeof montarCarta> } = {},
) {
  const m = opciones.m ?? montarCarta()
  const dirFotos = opciones.dirFotos === null ? undefined : (opciones.dirFotos ?? carpeta())
  const avisadas: number[] = []
  const app = crearServidor({
    acceso: m.acceso,
    catalogo: {
      db: m.db,
      restauranteId: m.restauranteId,
      acceso: m.acceso,
      alCambiar: (v) => avisadas.push(v),
      reloj: m.reloj,
      ...(dirFotos ? { dirFotos } : {}),
    },
  })
  await app.ready()
  const caja = m.emparejar('caja')
  const sesion = (quien: 'admin' | 'gerente' | 'cajero' | 'mesero', conexion = caja.conexion) => {
    const s = m.entrar(conexion, quien)
    return { sesion_id: s.sesionId, secreto: s.secreto }
  }
  const post = (url: string, payload: unknown, token: string | null = caja.token) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  const subir = (quien: Parameters<typeof sesion>[0], productoId: string, imagen: string | null) =>
    post('/api/catalogo/fotos', { ...sesion(quien), producto_id: productoId, imagen })
  const obtener = (url: string) => app.inject({ method: 'GET', url })
  return { ...m, app, dirFotos, avisadas, caja, sesion, post, subir, obtener }
}

/** Un segundo restaurante en la misma base, con un producto suyo. */
function agregarOtroRestaurante(m: ReturnType<typeof montarCarta>, config = '{}') {
  const id = nuevoId()
  const ahora = m.reloj()
  m.db
    .prepare(
      `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
       VALUES (?, ?, ?, ?, 1, 'Otro restaurante', ?)`,
    )
    .run(id, id, ahora, ahora, config)
  m.db
    .prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)")
    .run(id)
  const impuesto = insertarVersionado(
    m.db,
    'impuesto',
    id,
    { nombre: 'INC', tipo: 'inc', tarifa: 800 },
    SISTEMA,
    ahora,
  )
  const categoria = insertarVersionado(
    m.db,
    'categoria',
    id,
    { nombre: 'Otra', orden: 0, estacion_id: null, foto: null },
    SISTEMA,
    ahora,
  )
  const producto = insertarVersionado(
    m.db,
    'producto',
    id,
    {
      categoria_id: categoria,
      nombre: 'Plato ajeno',
      descripcion: null,
      precio: 10_000,
      impuesto_id: impuesto,
      foto: null,
      favorito: 0,
    },
    SISTEMA,
    ahora,
  )
  const fotoDe = (productoId: string) =>
    m.db.prepare('SELECT foto FROM producto WHERE id = ?').get(productoId)?.foto
  return { id, producto, fotoDe }
}

const versionDe = (m: { db: ReturnType<typeof montarCarta>['db'] }, restauranteId: string) =>
  Number(
    m.db
      .prepare("SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = 'catalogo'")
      .get(restauranteId)?.valor,
  )

describe('nombres raros y path traversal', () => {
  // Un archivo "secreto" junto a la carpeta de fotos, con un nombre que sí pasaría el patrón.
  function conSecreto() {
    const raiz = carpeta()
    const dirFotos = join(raiz, 'fotos')
    mkdirSync(dirFotos)
    const secreto = `${'a'.repeat(24)}.png`
    writeFileSync(join(raiz, secreto), 'CONTENIDO-SECRETO')
    writeFileSync(join(raiz, 'clave-pin'), 'CONTENIDO-SECRETO')
    return { raiz, dirFotos, secreto }
  }

  it('leerFoto rechaza cualquier nombre que no sea la huella con su extensión', () => {
    const { dirFotos, secreto } = conSecreto()
    const h = 'a'.repeat(24)
    const raros = [
      '',
      '.',
      '..',
      '/',
      `../${secreto}`,
      `..\\${secreto}`,
      `./${secreto}`,
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
      'clave-pin',
      '__proto__',
      'constructor',
      'toString',
      '𝟏𝟐𝟑',
    ]
    for (const nombre of raros) {
      expect(NOMBRE_FOTO.test(nombre), JSON.stringify(nombre)).toBe(false)
      expect(leerFoto(dirFotos, nombre), JSON.stringify(nombre)).toBeNull()
      expect(urlFoto(nombre), JSON.stringify(nombre)).toBeNull()
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
    expect(urlFoto(`${'0'.repeat(24)}.jpg`)).toBe(`/fotos/${'0'.repeat(24)}.jpg`)
    expect(urlFoto(`${'f'.repeat(24)}.png`)).toBe(`/fotos/${'f'.repeat(24)}.png`)
  })

  it('por HTTP, ninguna forma de subir un nivel (ni codificada, ni doble) llega a un archivo de fuera', async () => {
    const { raiz, dirFotos, secreto } = conSecreto()
    const m = await montar({ dirFotos })
    const h = 'a'.repeat(24)
    const urls = [
      `/fotos/..%2F${secreto}`,
      `/fotos/%2e%2e%2f${secreto}`,
      `/fotos/%2E%2E%2F${secreto}`,
      `/fotos/..%5C${secreto}`,
      `/fotos/%252e%252e%252f${secreto}`,
      `/fotos/..%252F${secreto}`,
      `/fotos/%2e%2e/${secreto}`,
      `/fotos/../${secreto}`,
      `/fotos/./${h}.png`,
      `/fotos/${h}.png%00`,
      `/fotos/${h}.png%00.webp`,
      `/fotos/${h}.png%0A`,
      `/fotos/${h}.png%20`,
      `/fotos/%20${h}.png`,
      `/fotos/${h}.PNG`,
      `/fotos/${h.toUpperCase()}.png`,
      `/fotos/${h}.png/`,
      `/fotos/${h}.png/extra`,
      `/fotos/${h}.svg`,
      '/fotos/',
      '/fotos',
      '/fotos/clave-pin',
      '/fotos/..%2Fclave-pin',
      `/fotos//${secreto}`,
      `/fotos/%2F${secreto}`,
      `/fotos/${encodeURIComponent(join(raiz, secreto))}`,
    ]
    for (const url of urls) {
      const r = await m.obtener(url)
      expect(r.statusCode, url).toBeGreaterThanOrEqual(400)
      expect(r.statusCode, url).toBeLessThan(500)
      expect(r.body, url).not.toContain('CONTENIDO-SECRETO')
    }
    // La misma foto, bien pedida, sí existe (el arnés sí puede leer lo que está en la carpeta).
    const nombre = guardarFoto(dirFotos, comoDato('png', PNG))
    expect((await m.obtener(`/fotos/${nombre}`)).statusCode).toBe(200)
  })

  it('una URL mal codificada responde un error de petición, no un 500', async () => {
    const m = await montar()
    for (const url of ['/fotos/%', '/fotos/%zz', '/fotos/%E0%A4%A']) {
      const r = await m.obtener(url)
      expect([400, 404], url).toContain(r.statusCode)
    }
  })

  it('el nombre del archivo en disco no depende de nada que mande el cliente', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const r = await m.post('/api/catalogo/fotos', {
      ...m.sesion('admin'),
      producto_id: burrata.id,
      imagen: comoDato('png', PNG),
    })
    expect(r.statusCode).toBe(200)
    const archivos = readdirSync(m.dirFotos as string)
    expect(archivos).toHaveLength(1)
    expect(archivos[0]).toMatch(NOMBRE_FOTO)
    // Un campo extra (nombre, ruta) hace inválido el pedido: no se acepta nada que lo influya.
    for (const extra of [{ nombre: '../x.png' }, { ruta: '/etc/passwd' }, { extension: 'svg' }]) {
      const mala = await m.post('/api/catalogo/fotos', {
        ...m.sesion('admin'),
        producto_id: burrata.id,
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
    for (const tipo of ['gif', 'svg+xml', 'bmp', 'avif', 'heic', 'jpg', 'x-icon', 'WEBP', ''])
      expect(() => guardarFoto(dir, comoDato(tipo, PNG)), tipo).toThrow(/WebP, JPEG o PNG/)
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
    for (const malo of [
      `data:image/png;base64,${b64}\n`,
      `data:image/png;base64, ${b64}`,
      `data:image/png;base64,${b64.slice(0, 4)}\n${b64.slice(4)}`,
      `data:image/png;base64,${b64}!`,
      `data:image/png;base64,${b64}<script>`,
      `data:image/png;base64,${b64.replace(/\+|\//g, '-')}-_`,
      'data:image/png;base64,',
      'data:image/png;base64,====',
    ])
      expect(() => guardarFoto(dir, malo), JSON.stringify(malo.slice(0, 40))).toThrow()
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
    const nombre = guardarFoto(dir, comoDato('png', sucio))
    // Se sirve siempre con su content-type de imagen: el navegador no lo ejecuta.
    expect(leerFoto(dir, nombre)).toMatchObject({ mime: 'image/png' })
    expect(leerFoto(dir, nombre)?.bytes.equals(sucio)).toBe(true)
  })

  it('los bytes servidos son exactamente los subidos, con los 256 valores de byte', () => {
    const dir = carpeta()
    const todos = Buffer.concat([PNG, Buffer.from(Array.from({ length: 256 }, (_, i) => i))])
    const nombre = guardarFoto(dir, comoDato('png', todos))
    expect(leerFoto(dir, nombre)?.bytes.equals(todos)).toBe(true)
  })
})

describe('tamaño en el límite', () => {
  it('una foto de exactamente 1 MiB se guarda; de 1 MiB + 1 byte no', () => {
    const dir = carpeta()
    const justa = jpgDe(TAMANO_MAXIMO_FOTO)
    const nombre = guardarFoto(dir, comoDato('jpeg', justa))
    expect(readFileSync(join(dir, nombre)).length).toBe(TAMANO_MAXIMO_FOTO)
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
    const burrata = m.producto('Burrata Spritz')
    const pedir = (imagen: string) =>
      m.post('/api/catalogo/fotos', {
        ...m.sesion('admin'),
        producto_id: burrata.id,
        imagen,
      })
    const justa = await pedir(comoDato('jpeg', jpgDe(TAMANO_MAXIMO_FOTO)))
    expect(justa.statusCode).toBe(200)

    const pasada = await pedir(comoDato('jpeg', jpgDe(TAMANO_MAXIMO_FOTO + 1, 2)))
    expect(pasada.statusCode).toBe(400)
    expect(pasada.json().mensaje).toMatch(/1 MB/)

    // Más de 1,5 millones de caracteres: lo frena el esquema.
    const enorme = await pedir(`data:image/jpeg;base64,${'A'.repeat(1_600_000)}`)
    expect(enorme.statusCode).toBe(400)

    // Más de 2 MB de cuerpo: lo frena Fastify antes de leerlo.
    const absurdo = await pedir(`data:image/jpeg;base64,${'A'.repeat(2_200_000)}`)
    expect(absurdo.statusCode).toBe(413)

    // Nada de lo rechazado dejó archivo ni cambió la foto.
    expect(readdirSync(m.dirFotos as string)).toHaveLength(1)
    expect(m.producto('Burrata Spritz').foto).toMatch(/^\/fotos\//)
  })

  it('el límite de 2 MB solo vale para la ruta de fotos: las demás conservan el de Fastify', async () => {
    const m = await montar()
    const grande = { ...m.sesion('admin'), cambios: [], relleno: 'x'.repeat(1_100_000) }
    const r = await m.post('/api/catalogo/cambios', grande)
    expect(r.statusCode).toBe(413)
  })
})

describe('deduplicación', () => {
  it('la misma foto subida dos veces deja un solo archivo, una sola versión y un solo aviso', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
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
    const burrata = m.producto('Burrata Spritz')
    const cuerpo = (s: object) => ({
      ...s,
      producto_id: burrata.id,
      imagen: comoDato('webp', WEBP),
    })
    // Una sola sesión: entrar de nuevo con el mismo usuario cerraría la anterior.
    const sesion = m.sesion('admin')
    const [x, y] = await Promise.all([
      m.post('/api/catalogo/fotos', cuerpo(sesion)),
      m.post('/api/catalogo/fotos', cuerpo(sesion)),
    ])
    expect([x.statusCode, y.statusCode]).toEqual([200, 200])
    expect(readdirSync(m.dirFotos as string)).toHaveLength(1)
    expect(m.avisadas).toHaveLength(1)
  })

  it('dos productos con la misma imagen comparten archivo; quitarla de uno no la borra para el otro', async () => {
    const m = await montar()
    const a = m.producto('Burrata Spritz')
    const b = m.productos().find((p) => p.id !== a.id) as typeof a
    const ra = await m.subir('admin', a.id, comoDato('png', PNG))
    const rb = await m.subir('admin', b.id, comoDato('png', PNG))
    expect(ra.json().foto).toBe(rb.json().foto)
    expect(readdirSync(m.dirFotos as string)).toHaveLength(1)
    await m.subir('admin', a.id, null)
    expect(
      m
        .catalogo()
        .categorias.flatMap((c) => c.productos)
        .find((p) => p.id === a.id)?.foto,
    ).toBeNull()
    const quedaba = (await m.obtener(rb.json().foto)).statusCode
    expect(quedaba).toBe(200)
  })

  it('cambiar la foto deja la anterior en disco (otro producto o un equipo con caché podría usarla)', async () => {
    const m = await montar()
    const a = m.producto('Burrata Spritz')
    const primera = (await m.subir('admin', a.id, comoDato('png', PNG))).json().foto
    const segunda = (await m.subir('admin', a.id, comoDato('webp', WEBP))).json().foto
    expect(primera).not.toBe(segunda)
    expect(readdirSync(m.dirFotos as string)).toHaveLength(2)
    expect((await m.obtener(primera)).statusCode).toBe(200)
    expect(m.avisadas).toHaveLength(2)
  })

  it('quitar la foto de un producto que no tiene no cambia nada ni avisa', async () => {
    const m = await montar()
    const a = m.producto('Burrata Spritz')
    const version = versionDe(m, m.restauranteId)
    const r = await m.subir('admin', a.id, null)
    expect(r.json()).toEqual({ foto: null })
    expect(m.avisadas).toEqual([])
    expect(versionDe(m, m.restauranteId)).toBe(version)
  })

  it('contenidos distintos dan nombres distintos y el mismo contenido, siempre el mismo', () => {
    const dir = carpeta()
    const nombres = new Set<string>()
    for (let i = 0; i < 50; i++) nombres.add(guardarFoto(dir, comoDato('jpeg', jpgDe(64, i))))
    expect(nombres.size).toBe(50)
    const otra = carpeta()
    expect(guardarFoto(otra, comoDato('jpeg', jpgDe(64, 3)))).toBe(
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
    const nombre = guardarFoto(dir, comoDato('jpeg', bytes))
    writeFileSync(join(dir, nombre), bytes.subarray(0, 100))
    guardarFoto(dir, comoDato('jpeg', bytes))
    expect(readFileSync(join(dir, nombre)).equals(bytes)).toBe(true)
  })

  it('no deja temporales en la carpeta, y un temporal viejo (corte de luz) nunca se sirve', async () => {
    const m = await montar()
    const dir = m.dirFotos as string
    mkdirSync(dir, { recursive: true })
    const huerfano = `${'b'.repeat(24)}.png.123.tmp`
    writeFileSync(join(dir, huerfano), 'MEDIO-ESCRITO')
    const nombre = guardarFoto(dir, comoDato('png', PNG))
    expect(readdirSync(dir).sort()).toEqual([huerfano, nombre].sort())
    expect(leerFoto(dir, huerfano)).toBeNull()
    expect((await m.obtener(`/fotos/${huerfano}`)).statusCode).toBe(404)
  })
})

describe('productos de otro restaurante, archivados y datos raros', () => {
  it('un producto de otro restaurante de la misma base no existe para este hub', async () => {
    const m = await montar()
    const otro = agregarOtroRestaurante(m)
    const r = await m.subir('admin', otro.producto, comoDato('png', PNG))
    expect(r.statusCode).toBe(400)
    expect(r.json().mensaje).toMatch(/no existe/)
    expect(otro.fotoDe(otro.producto)).toBeNull()
    expect(readdirSync(m.dirFotos as string)).toEqual([])
    expect(m.avisadas).toEqual([])
    // Tampoco se puede quitar la foto de un producto ajeno.
    const quitar = await m.subir('admin', otro.producto, null)
    expect(quitar.statusCode).toBe(400)
  })

  it('subir la foto de un producto propio no toca el otro restaurante ni su versión', async () => {
    const m = await montar()
    const otro = agregarOtroRestaurante(m)
    const versionOtro = versionDe(m, otro.id)
    const burrata = m.producto('Burrata Spritz')
    expect((await m.subir('admin', burrata.id, comoDato('png', PNG))).statusCode).toBe(200)
    expect(otro.fotoDe(otro.producto)).toBeNull()
    expect(versionDe(m, otro.id)).toBe(versionOtro)
    expect(leerCatalogo(m.db, otro.id).categorias.flatMap((c) => c.productos)).toEqual([
      expect.objectContaining({ nombre: 'Plato ajeno', foto: null }),
    ])
  })

  it('la carta de un restaurante no trae productos ni fotos del otro', async () => {
    const m = await montar()
    const otro = agregarOtroRestaurante(m)
    const nombre = guardarFoto(m.dirFotos as string, comoDato('png', PNG))
    m.db.prepare('UPDATE producto SET foto = ? WHERE id = ?').run(nombre, otro.producto)
    const propia = m.catalogo().categorias.flatMap((c) => c.productos)
    expect(propia.map((p) => p.nombre)).not.toContain('Plato ajeno')
    expect(propia.every((p) => p.foto === null)).toBe(true)
    const ajena = leerCatalogo(m.db, otro.id).categorias.flatMap((c) => c.productos)
    expect(ajena.map((p) => p.foto)).toEqual([`/fotos/${nombre}`])
  })

  it('un id con forma rara no llega a la base: 400, nunca 500', async () => {
    const m = await montar()
    const sesion = m.sesion('admin')
    for (const id of [
      '',
      'x',
      "'; DROP TABLE producto; --",
      'A'.repeat(25),
      'A'.repeat(27),
      '0'.repeat(26),
      nuevoId(),
    ]) {
      const r = await m.post('/api/catalogo/fotos', { ...sesion, producto_id: id, imagen: null })
      expect(r.statusCode, id).toBe(400)
    }
    expect(m.productos().length).toBeGreaterThan(0)
  })

  it('el pedido incompleto o con tipos equivocados es 400', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const s = m.sesion('admin')
    const malos: unknown[] = [
      null,
      [],
      {},
      { ...s },
      { ...s, producto_id: burrata.id },
      { ...s, producto_id: burrata.id, imagen: 5 },
      { ...s, producto_id: burrata.id, imagen: '' },
      { ...s, producto_id: burrata.id, imagen: {} },
      { ...s, producto_id: 5, imagen: null },
      { producto_id: burrata.id, imagen: null },
      { sesion_id: s.sesion_id, producto_id: burrata.id, imagen: null },
      { ...s, secreto: '', producto_id: burrata.id, imagen: null },
    ]
    for (const cuerpo of malos) {
      const r = await m.post('/api/catalogo/fotos', cuerpo)
      expect(r.statusCode, JSON.stringify(cuerpo)).toBe(400)
    }
    const sinTipo = await m.app.inject({
      method: 'POST',
      url: '/api/catalogo/fotos',
      payload: 'imagen=1',
      headers: { authorization: `Bearer ${m.caja.token}`, 'content-type': 'text/plain' },
    })
    expect(sinTipo.statusCode).toBeLessThan(500)
    expect(sinTipo.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('un producto archivado: la carta no lo muestra, su foto se conserva y vuelve al reactivarlo', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const foto = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().foto as string
    const archivar = (activo: 0 | 1) =>
      m.db
        .prepare('UPDATE producto SET activo = ?, version = version + 1000 WHERE id = ?')
        .run(activo, burrata.id)
    archivar(0)
    expect(m.productos().map((p) => p.id)).not.toContain(burrata.id)
    // La foto sigue disponible (un pedido viejo o un equipo con la carta anterior la puede pedir).
    expect((await m.obtener(foto)).statusCode).toBe(200)
    archivar(1)
    expect(m.producto('Burrata Spritz').foto).toBe(foto)
  })

  it('subir la foto de un producto ya archivado se acepta y queda oculta hasta reactivarlo', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    m.db.prepare('UPDATE producto SET activo = 0 WHERE id = ?').run(burrata.id)
    const r = await m.subir('admin', burrata.id, comoDato('webp', WEBP))
    expect(r.statusCode).toBe(200)
    expect(m.productos().map((p) => p.id)).not.toContain(burrata.id)
    const fila = m.db.prepare('SELECT foto, activo FROM producto WHERE id = ?').get(burrata.id)
    expect(fila).toMatchObject({ foto: r.json().foto.replace('/fotos/', ''), activo: 0 })
  })

  it('un valor guardado en la base que no es un nombre de foto sale como sin foto', () => {
    const m = montarCarta()
    const p = m.producto('Burrata Spritz')
    for (const raro of [
      '../../etc/passwd',
      'foto.png',
      '',
      'http://x.co/a.png',
      `${'A'.repeat(24)}.png`,
      '<img src=x onerror=alert(1)>',
    ]) {
      m.db.prepare('UPDATE producto SET foto = ? WHERE id = ?').run(raro, p.id)
      expect(m.producto('Burrata Spritz').foto, raro).toBeNull()
    }
  })

  it('el historial del catálogo anota quién cambió la foto, desde qué equipo, y cómo estaba', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const foto = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().foto as string
    const fila = m.db
      .prepare(
        "SELECT * FROM catalogo_cambio WHERE entidad = 'producto' AND registro_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(burrata.id) as Record<string, string | null>
    expect(JSON.parse(String(fila.despues)).foto).toBe(foto.replace('/fotos/', ''))
    expect(JSON.parse(String(fila.antes)).foto).toBeNull()
    expect(fila.usuario_id).toBe(m.personas.admin.usuarioId)
    expect(fila.dispositivo_id).toBe(m.caja.conexion.dispositivoId)
  })

  it('el seed que corre después no borra la foto de un producto que alguien ya editó', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const foto = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().foto
    for (let i = 0; i < 2; i++)
      sembrar(
        m.db,
        m.acceso,
        { restauranteId: m.restauranteId, roles: m.roles, carta: CARTA, sinPersonal: true },
        m.reloj(),
      )
    expect(m.producto('Burrata Spritz').foto).toBe(foto)
  })
})

describe('sin carpeta de fotos (dirFotos sin definir)', () => {
  it('no hay ruta para subir ni para leer: 404; el resto de la carta sigue funcionando', async () => {
    const m = await montar({ dirFotos: null })
    const burrata = m.producto('Burrata Spritz')
    const subir = await m.subir('admin', burrata.id, comoDato('png', PNG))
    expect(subir.statusCode).toBe(404)
    expect((await m.obtener(`/fotos/${'a'.repeat(24)}.png`)).statusCode).toBe(404)
    const carta = await m.app.inject({
      method: 'GET',
      url: '/api/catalogo',
      headers: { authorization: `Bearer ${m.caja.token}` },
    })
    expect(carta.statusCode).toBe(200)
    expect(carta.json().categorias.length).toBeGreaterThan(0)
  })

  it('la ruta de la marca sí existe aunque no haya carpeta de fotos', async () => {
    const m = await montar({ dirFotos: null })
    const r = await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(leerCatalogo(m.db, m.restauranteId).restaurante.marca).toBe('faro')
  })

  it('las fotos que ya estén en la base salen en la carta como ruta, aunque no se sirvan', async () => {
    const m = await montar({ dirFotos: null })
    const nombre = `${'c'.repeat(24)}.webp`
    m.db
      .prepare('UPDATE producto SET foto = ? WHERE id = ?')
      .run(nombre, m.producto('Burrata Spritz').id)
    expect(m.producto('Burrata Spritz').foto).toBe(`/fotos/${nombre}`)
    expect((await m.obtener(`/fotos/${nombre}`)).statusCode).toBe(404)
  })

  it('la carpeta se crea al primer uso, aunque no exista ni su carpeta madre', async () => {
    const dir = join(carpeta(), 'datos', 'fotos')
    const m = await montar({ dirFotos: dir })
    const r = await m.subir('admin', m.producto('Burrata Spritz').id, comoDato('png', PNG))
    expect(r.statusCode).toBe(200)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('si la carpeta no se puede crear (ocupada por un archivo), 500 limpio y la foto no cambia', async () => {
    const raiz = carpeta()
    const ocupada = join(raiz, 'fotos')
    writeFileSync(ocupada, 'soy un archivo')
    const m = await montar({ dirFotos: ocupada })
    const burrata = m.producto('Burrata Spritz')
    const r = await m.subir('admin', burrata.id, comoDato('png', PNG))
    expect(r.statusCode).toBe(500)
    expect(r.body).not.toContain(raiz)
    expect(m.producto('Burrata Spritz').foto).toBeNull()
    expect(m.avisadas).toEqual([])
  })

  it('leer de una carpeta que no existe es 404, no 500', async () => {
    const m = await montar({ dirFotos: join(carpeta(), 'no-existe') })
    expect((await m.obtener(`/fotos/${'d'.repeat(24)}.png`)).statusCode).toBe(404)
  })
})

describe('reinicio del hub con fotos ya guardadas', () => {
  it('un servidor nuevo sobre la misma base y carpeta sirve las fotos y las trae en la carta', async () => {
    const dir = carpeta()
    const antes = await montar({ dirFotos: dir })
    const burrata = antes.producto('Burrata Spritz')
    const foto = (await antes.subir('admin', burrata.id, comoDato('webp', WEBP))).json()
      .foto as string
    await antes.app.close()

    const despues = await montar({ dirFotos: dir, m: antes })
    expect(despues.producto('Burrata Spritz').foto).toBe(foto)
    const r = await despues.obtener(foto)
    expect(r.statusCode).toBe(200)
    expect(r.rawPayload.equals(WEBP)).toBe(true)
  })

  it('tras reiniciar, volver a subir la misma foto no reescribe el archivo ni crea otra versión', async () => {
    const dir = carpeta()
    const antes = await montar({ dirFotos: dir })
    const burrata = antes.producto('Burrata Spritz')
    const foto = (await antes.subir('admin', burrata.id, comoDato('webp', WEBP))).json()
      .foto as string
    await antes.app.close()

    const despues = await montar({ dirFotos: dir, m: antes })
    const version = versionDe(despues, despues.restauranteId)
    const otra = await despues.subir('admin', burrata.id, comoDato('webp', WEBP))
    expect(otra.json().foto).toBe(foto)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(despues.avisadas).toEqual([])
    expect(versionDe(despues, despues.restauranteId)).toBe(version)
  })

  it('si la carpeta se perdió pero la base conserva el nombre, la carta lo trae y la foto da 404 hasta volver a subirla', async () => {
    const dir = carpeta()
    const antes = await montar({ dirFotos: dir })
    const burrata = antes.producto('Burrata Spritz')
    const foto = (await antes.subir('admin', burrata.id, comoDato('png', PNG))).json()
      .foto as string
    rmSync(dir, { recursive: true, force: true })
    expect((await antes.obtener(foto)).statusCode).toBe(404)
    expect(antes.producto('Burrata Spritz').foto).toBe(foto)
    // Volver a subirla la repone con el mismo nombre (la huella no cambia). La base ya tenía ese nombre.
    const otra = await antes.subir('admin', burrata.id, comoDato('png', PNG))
    expect(otra.json().foto).toBe(foto)
    expect((await antes.obtener(foto)).statusCode).toBe(200)
  })

  it('las fotos y la marca sobreviven a volver a correr el seed', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const foto = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().foto
    await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'faro' })
    sembrar(
      m.db,
      m.acceso,
      { restauranteId: m.restauranteId, roles: m.roles, carta: CARTA, sinPersonal: true },
      m.reloj(),
    )
    expect(m.producto('Burrata Spritz').foto).toBe(foto)
    expect(m.catalogo().restaurante.marca).toBe('faro')
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
    for (const [tipo, bytes, mime] of casos) {
      const nombre = guardarFoto(m.dirFotos as string, comoDato(tipo, bytes))
      const r = await m.obtener(`/fotos/${nombre}`)
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
    const nombre = guardarFoto(m.dirFotos as string, comoDato('png', PNG))
    const r = await m.app.inject({ method: 'HEAD', url: `/fotos/${nombre}` })
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toMatch(/immutable/)
    expect(r.headers['content-type']).toBe('image/png')
    expect(r.rawPayload.length).toBe(0)
  })

  it('no hace falta token ni sesión para pedir una foto, y uno inválido tampoco estorba', async () => {
    const m = await montar()
    const nombre = guardarFoto(m.dirFotos as string, comoDato('png', PNG))
    for (const authorization of [undefined, 'Bearer basura', 'Basic xx']) {
      const r = await m.app.inject({
        method: 'GET',
        url: `/fotos/${nombre}`,
        headers: authorization ? { authorization } : {},
      })
      expect(r.statusCode).toBe(200)
    }
  })

  it('un 404 nunca lleva caché inmutable (si no, el equipo recordaría «no existe» para siempre)', async () => {
    const m = await montar()
    const r = await m.obtener(`/fotos/${'e'.repeat(24)}.png`)
    expect(r.statusCode).toBe(404)
    expect(r.headers['cache-control'] ?? '').not.toMatch(/immutable|max-age=\d{5,}/)
    const mala = await m.obtener('/fotos/..%2Fx')
    expect(mala.headers['cache-control'] ?? '').not.toMatch(/immutable/)
  })

  it('la respuesta a una subida (POST) no se guarda en caché', async () => {
    const m = await montar()
    const r = await m.subir('admin', m.producto('Burrata Spritz').id, comoDato('png', PNG))
    expect(r.headers['cache-control'] ?? '').not.toMatch(/immutable|public/)
  })

  it('el mismo nombre siempre da los mismos bytes (por eso la caché inmutable es segura)', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const foto = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().foto as string
    const a = await m.obtener(foto)
    // Otra foto distinta después no cambia lo que hay bajo el nombre anterior.
    await m.subir('admin', burrata.id, comoDato('webp', WEBP))
    const b = await m.obtener(foto)
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true)
    expect(b.headers['content-type']).toBe(a.headers['content-type'])
  })
})

describe('sesión, equipo y permisos al subir fotos', () => {
  it('sin token, con token inventado o de un equipo retirado: 401, y no se guarda nada', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const cuerpo = { ...m.sesion('admin'), producto_id: burrata.id, imagen: comoDato('png', PNG) }
    expect((await m.post('/api/catalogo/fotos', cuerpo, null)).statusCode).toBe(401)
    expect((await m.post('/api/catalogo/fotos', cuerpo, 'token-inventado')).statusCode).toBe(401)

    const segundo = m.emparejar('mesero')
    const admin2 = m.entrar(segundo.conexion, 'admin')
    const retirar = m.acceso.revocarDispositivo(segundo.conexion, {
      sesionId: admin2.sesionId,
      secreto: admin2.secreto,
      dispositivoId: m.caja.conexion.dispositivoId,
    })
    expect(retirar.ok).toBe(true)
    // El equipo retirado ya no sube fotos, aunque su sesión fuera de administrador.
    const retirado = await m.post('/api/catalogo/fotos', cuerpo)
    expect(retirado.statusCode).toBe(401)
    expect(retirado.json().error).toBe('token_invalido')
    expect(readdirSync(m.dirFotos as string)).toEqual([])
  })

  it('con el secreto equivocado, con una sesión cerrada o de otro equipo: 401 sesion_invalida', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const buena = m.sesion('admin')
    const base = { producto_id: burrata.id, imagen: comoDato('png', PNG) }

    const secretoMalo = await m.post('/api/catalogo/fotos', { ...buena, secreto: 'otro', ...base })
    expect(secretoMalo.statusCode).toBe(401)
    expect(secretoMalo.json().error).toBe('sesion_invalida')

    const inexistente = await m.post('/api/catalogo/fotos', {
      ...buena,
      sesion_id: nuevoId(),
      ...base,
    })
    expect(inexistente.statusCode).toBe(401)

    const cerrada = m.sesion('admin')
    m.acceso.cerrarSesion(m.caja.conexion, {
      sesionId: cerrada.sesion_id,
      secreto: cerrada.secreto,
    })
    expect((await m.post('/api/catalogo/fotos', { ...cerrada, ...base })).statusCode).toBe(401)

    const otroEquipo = m.emparejar('mesero')
    const deOtro = m.sesion('admin', otroEquipo.conexion)
    const cruzada = await m.post('/api/catalogo/fotos', { ...deOtro, ...base }, m.caja.token)
    expect(cruzada.statusCode).toBe(401)

    expect(readdirSync(m.dirFotos as string)).toEqual([])
    expect(m.avisadas).toEqual([])
  })

  it('la sesión de una persona que ya no está activa no sube fotos', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const s = m.sesion('gerente')
    m.db.prepare('UPDATE usuario SET activo = 0 WHERE id = ?').run(m.personas.gerente.usuarioId)
    const r = await m.post('/api/catalogo/fotos', {
      ...s,
      producto_id: burrata.id,
      imagen: comoDato('png', PNG),
    })
    expect(r.statusCode).toBe(401)
    expect(readdirSync(m.dirFotos as string)).toEqual([])
  })

  it('mesero y cajero no tienen editar_catalogo (403); el gerente sí', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    for (const quien of ['mesero', 'cajero'] as const) {
      const r = await m.subir(quien, burrata.id, comoDato('png', PNG))
      expect(r.statusCode, quien).toBe(403)
    }
    expect(readdirSync(m.dirFotos as string)).toEqual([])
    const g = await m.subir('gerente', burrata.id, comoDato('png', PNG))
    expect(g.statusCode).toBe(200)
  })

  it('el permiso se revisa antes de guardar: un 403 no deja archivo aunque la imagen sea válida', async () => {
    const m = await montar()
    await m.subir('mesero', m.producto('Burrata Spritz').id, comoDato('webp', WEBP))
    expect(readdirSync(m.dirFotos as string)).toEqual([])
  })
})

describe('marca del restaurante', () => {
  const sembrada = (m: ReturnType<typeof montarCarta>) =>
    sembrar(
      m.db,
      m.acceso,
      { restauranteId: m.restauranteId, roles: m.roles, carta: CARTA, sinPersonal: true },
      m.reloj(),
    )
  const configCruda = (m: ReturnType<typeof montarCarta>, id = m.restauranteId) =>
    JSON.parse(String(m.db.prepare('SELECT config FROM restaurante WHERE id = ?').get(id)?.config))

  it('un hub viejo, con la config vacía o sin la clave marca, entrega Faro y conserva el resto', () => {
    const m = montarCarta()
    for (const config of ['{}', '{"sesion_inactividad_min":10}', '{"propina_sugerida":1000}']) {
      m.db.prepare('UPDATE restaurante SET config = ? WHERE id = ?').run(config, m.restauranteId)
      const carta = leerCatalogo(m.db, m.restauranteId)
      expect(carta.restaurante.marca, config).toBe('faro')
    }
    m.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run('{"sesion_inactividad_min":10}', m.restauranteId)
    expect(leerCatalogo(m.db, m.restauranteId).restaurante.sesionInactividadMin).toBe(10)
  })

  it('un hub recién creado (sin seed) se ve como Faro', () => {
    const m = montarCarta()
    const solo = agregarOtroRestaurante(m)
    expect(leerCatalogo(m.db, solo.id).restaurante.marca).toBe('faro')
  })

  it('el seed pone la marca de La Spritzzería a un hub viejo y no la repite en cada corrida', () => {
    const m = montarCarta()
    expect(configCruda(m).marca).toBe('la-spritzzeria')
    const antes = versionDe(m, m.restauranteId)
    sembrada(m)
    sembrada(m)
    expect(versionDe(m, m.restauranteId)).toBe(antes)
    expect(m.catalogo().restaurante.marca).toBe('la-spritzzeria')
  })

  it('el seed conserva lo ya configurado y agrega solo la marca', () => {
    const m = montarCarta()
    m.db
      .prepare('UPDATE restaurante SET config = ?, usuario_id = NULL WHERE id = ?')
      .run('{"sesion_inactividad_min":7}', m.restauranteId)
    sembrada(m)
    expect(configCruda(m)).toMatchObject({ marca: 'la-spritzzeria', sesion_inactividad_min: 7 })
  })

  it('el seed respeta la marca que el restaurante eligió, aunque sea Faro (la de por defecto)', () => {
    const m = montarCarta()
    // Elegida a mano en la base, sin pasar por la API (usuario_id sin marcar).
    m.db
      .prepare('UPDATE restaurante SET config = ?, usuario_id = NULL WHERE id = ?')
      .run(jsonCanonico(configCompleta({ marca: 'faro' })), m.restauranteId)
    sembrada(m)
    expect(m.catalogo().restaurante.marca).toBe('faro')
    expect(configCruda(m).marca).toBe('faro')
  })

  it('el seed respeta una marca que el restaurante eligió con la API; y si guardó solo {"marca":"faro"}, también', async () => {
    const m = await montar()
    const r = await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'faro' })
    expect(r.statusCode).toBe(200)
    sembrada(m)
    sembrada(m)
    expect(m.catalogo().restaurante.marca).toBe('faro')

    const otro = montarCarta()
    otro.db
      .prepare('UPDATE restaurante SET config = ?, usuario_id = NULL WHERE id = ?')
      .run('{"marca":"faro"}', otro.restauranteId)
    sembrada(otro)
    expect(otro.catalogo().restaurante.marca).toBe('faro')
  })

  it('una marca elegida y luego devuelta a La Spritzzería queda así tras el seed', async () => {
    const m = await montar()
    await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'faro' })
    await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'la-spritzzeria' })
    sembrada(m)
    expect(m.catalogo().restaurante.marca).toBe('la-spritzzeria')
    expect(m.avisadas).toHaveLength(2)
  })

  it('dos restaurantes en la misma base tienen cada uno su marca', () => {
    const m = montarCarta()
    const otro = agregarOtroRestaurante(m, jsonCanonico(configCompleta({ marca: 'faro' })))
    expect(leerCatalogo(m.db, m.restauranteId).restaurante.marca).toBe('la-spritzzeria')
    expect(leerCatalogo(m.db, otro.id).restaurante.marca).toBe('faro')
    // El seed de este restaurante no toca el config del otro.
    sembrada(m)
    expect(configCruda(m, otro.id).marca).toBe('faro')
  })

  it('cambiar la marca de un restaurante no toca la del otro ni su versión', async () => {
    const m = await montar()
    const otro = agregarOtroRestaurante(
      m,
      jsonCanonico(configCompleta({ marca: 'la-spritzzeria' })),
    )
    const versionOtro = versionDe(m, otro.id)
    const r = await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(leerCatalogo(m.db, otro.id).restaurante.marca).toBe('la-spritzzeria')
    expect(versionDe(m, otro.id)).toBe(versionOtro)
  })

  it('dos hubs distintos (dos restaurantes) mantienen marcas distintas', async () => {
    const a = await montar()
    const b = await montar()
    await a.post('/api/restaurante/marca', { ...a.sesion('admin'), marca: 'faro' })
    expect(a.catalogo().restaurante.marca).toBe('faro')
    expect(b.catalogo().restaurante.marca).toBe('la-spritzzeria')
  })

  it('cambiar la marca sube la versión de la carta y avisa una sola vez; repetirla no hace nada', async () => {
    const m = await montar()
    const antes = m.catalogo().version
    await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'faro' })
    expect(m.catalogo().version).toBeGreaterThan(antes)
    expect(m.avisadas).toEqual([m.catalogo().version])
    const despues = m.catalogo().version
    const otra = await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'faro' })
    expect(otra.json()).toEqual({ marca: 'faro' })
    expect(m.catalogo().version).toBe(despues)
    expect(m.avisadas).toHaveLength(1)
  })

  it('elegir Faro en un hub viejo (sin marca en la config) sí queda escrito', async () => {
    const m = await montar()
    m.db.prepare('UPDATE restaurante SET config = ? WHERE id = ?').run('{}', m.restauranteId)
    const r = await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'faro' })
    expect(r.statusCode).toBe(200)
    expect(configCruda(m).marca).toBe('faro')
    expect(m.avisadas).toHaveLength(1)
  })

  it('al cambiar la marca se conserva el resto de la configuración y queda quién la cambió', async () => {
    const m = await montar()
    m.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run('{"sesion_inactividad_min":9,"marca":"la-spritzzeria"}', m.restauranteId)
    await m.post('/api/restaurante/marca', { ...m.sesion('admin'), marca: 'faro' })
    expect(configCruda(m)).toMatchObject({ sesion_inactividad_min: 9, marca: 'faro' })
    const fila = m.db
      .prepare('SELECT usuario_id, dispositivo_id FROM restaurante WHERE id = ?')
      .get(m.restauranteId)
    expect(fila).toEqual({
      usuario_id: m.personas.admin.usuarioId,
      dispositivo_id: m.caja.conexion.dispositivoId,
    })
  })

  it('valores de marca que no existen se rechazan con 400 y no cambian nada', async () => {
    const m = await montar()
    const antes = m.catalogo().version
    const s = m.sesion('admin')
    for (const marca of [
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
      const r = await m.post('/api/restaurante/marca', { ...s, marca })
      expect(r.statusCode, JSON.stringify(marca)).toBe(400)
    }
    const extra = await m.post('/api/restaurante/marca', { ...s, marca: 'faro', color: '#fff' })
    expect(extra.statusCode).toBe(400)
    expect(m.catalogo().version).toBe(antes)
    expect(m.avisadas).toEqual([])
    expect(m.catalogo().restaurante.marca).toBe('la-spritzzeria')
  })

  it('sin token, con sesión inválida, cerrada, de otro equipo o sin permiso: nada cambia', async () => {
    const m = await montar()
    const s = m.sesion('admin')
    const dev = (cuerpo: object, token: string | null = m.caja.token) =>
      m.post('/api/restaurante/marca', { marca: 'faro', ...cuerpo }, token)

    expect((await dev(s, null)).statusCode).toBe(401)
    expect((await dev(s, 'token-inventado')).statusCode).toBe(401)
    const malo = await dev({ ...s, secreto: 'incorrecto' })
    expect(malo.statusCode).toBe(401)
    expect(malo.json().error).toBe('sesion_invalida')
    expect((await dev({ ...s, sesion_id: nuevoId() })).statusCode).toBe(401)
    expect((await dev({ ...s, sesion_id: 'corto' })).statusCode).toBe(400)
    expect((await dev({ secreto: s.secreto })).statusCode).toBe(400)
    expect((await dev({})).statusCode).toBe(400)

    const cerrada = m.sesion('admin')
    m.acceso.cerrarSesion(m.caja.conexion, {
      sesionId: cerrada.sesion_id,
      secreto: cerrada.secreto,
    })
    expect((await dev(cerrada)).statusCode).toBe(401)

    const otroEquipo = m.emparejar('mesero')
    const deOtro = m.sesion('admin', otroEquipo.conexion)
    expect((await dev(deOtro)).statusCode).toBe(401)

    // Con sesión válida pero sin administrar_usuarios.
    for (const quien of ['mesero', 'cajero', 'gerente'] as const) {
      const r = await dev(m.sesion(quien))
      expect(r.statusCode, quien).toBe(403)
      expect(r.json().error).toBe('sin_permiso')
    }
    expect(m.catalogo().restaurante.marca).toBe('la-spritzzeria')
    expect(m.avisadas).toEqual([])
  })

  it('la persona dada de baja ya no cambia la marca', async () => {
    const m = await montar()
    const s = m.sesion('admin')
    m.db.prepare('UPDATE usuario SET activo = 0 WHERE id = ?').run(m.personas.admin.usuarioId)
    expect((await m.post('/api/restaurante/marca', { ...s, marca: 'faro' })).statusCode).toBe(401)
    m.db.prepare('UPDATE usuario SET activo = 1 WHERE id = ?').run(m.personas.admin.usuarioId)
    expect((await m.post('/api/restaurante/marca', { ...s, marca: 'faro' })).statusCode).toBe(200)
  })
})

describe('marca en la carta que reciben los equipos', () => {
  it('GET /api/catalogo trae restaurante.marca y la foto como ruta', async () => {
    const m = await montar()
    const burrata = m.producto('Burrata Spritz')
    const foto = (await m.subir('admin', burrata.id, comoDato('png', PNG))).json().foto
    const r = await m.app.inject({
      method: 'GET',
      url: '/api/catalogo',
      headers: { authorization: `Bearer ${m.caja.token}` },
    })
    const carta = r.json()
    expect(carta.restaurante.marca).toBe('la-spritzzeria')
    const producto = carta.categorias
      .flatMap((c: { productos: { id: string; foto: string | null }[] }) => c.productos)
      .find((p: { id: string }) => p.id === burrata.id)
    expect(producto.foto).toBe(foto)
    // Los demás productos traen foto null (no ausente): el contrato es estable.
    const sinFoto = carta.categorias
      .flatMap((c: { productos: { id: string; foto: string | null }[] }) => c.productos)
      .filter((p: { id: string }) => p.id !== burrata.id)
    expect(sinFoto.every((p: { foto: string | null }) => p.foto === null)).toBe(true)
  })
})
