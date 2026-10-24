import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { esIdValido, nuevoId } from '@pos/core'
import { aplicarMigraciones, type BaseSqlite, TABLAS_VERSIONADAS } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { asegurarRoles } from '../acceso/inicial'
import type { Cambio } from '../acceso/registros'
import { idEstable, insertarVersionado, SISTEMA } from '../acceso/registros'
import { ServicioAcceso } from '../acceso/servicio'
import { leerCarta, reglasSinPlato } from './carta'
import { MESAS, PERSONAL, sembrar } from './sembrar'

// Pruebas adicionales de la tarea 0.8: repetir el seed, varios hubs y restaurantes, registros
// archivados, cambios en la carta, variantes, sabores, secciones ocultas e interrupciones.

const TEXTO_CARTA = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const AHORA = '2026-10-24T20:00:00.000Z'
const MAS_TARDE = '2026-10-25T09:30:00.000Z'

/** Tablas que el seed llena con IDs estables (sin personal ni roles, que crea el hub). */
const TABLAS_SEED = [
  'restaurante',
  'zona',
  'mesa',
  'estacion',
  'impuesto',
  'categoria',
  'producto',
  'variante',
  'grupo_modificador',
  'modificador',
  'producto_grupo_modificador',
] as const

const volcar = (db: BaseSqlite, tablas: readonly string[]) =>
  Object.fromEntries(tablas.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]))

const contar = (db: BaseSqlite, sql: string, ...p: string[]) => Number(db.prepare(sql).get(...p)?.n)

/**
 * Un hub recién instalado con un restaurante de ID dado (o nuevo). La sede también lleva un ID
 * estable para poder comparar dos hubs del mismo restaurante fila por fila.
 */
function hub(restauranteId = nuevoId(), compartida?: BaseSqlite) {
  const db = compartida ?? abrirBase(':memory:')
  if (!compartida) aplicarMigraciones(db)
  agregarRestaurante(db, restauranteId)
  const roles = asegurarRoles(db, restauranteId, AHORA)
  const acceso = new ServicioAcceso({
    db,
    restauranteId,
    clave: Buffer.alloc(32, 3),
    reloj: () => AHORA,
  })
  const cargar = (texto = TEXTO_CARTA, ahora = AHORA, con: ServicioAcceso = acceso) =>
    sembrar(db, con, { restauranteId, roles, carta: leerCarta(texto) }, ahora)
  return { db, acceso, roles, restauranteId, cargar }
}

function agregarRestaurante(db: BaseSqlite, id: string) {
  db.prepare(
    `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
     VALUES (?, ?, ?, ?, 1, 'Mi restaurante', '{}')`,
  ).run(id, id, AHORA, AHORA)
  db.prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)").run(
    id,
  )
  insertarVersionado(
    db,
    'sede',
    id,
    { nombre: 'Principal', direccion: null, zona_horaria: 'America/Bogota' },
    SISTEMA,
    AHORA,
    idEstable(id, 'sede:principal'),
  )
}

// Cartas pequeñas para los casos borde.
const plato = (nombre: string, precio: number, descripcion?: string) => ({
  nombre: { es: nombre },
  descripcion: descripcion === undefined ? undefined : { es: descripcion },
  precio,
})
const seccion = (clave: string, platos: ReturnType<typeof plato>[], extra = {}) => ({
  clave,
  nombre: clave,
  grupo: 'barra',
  boton: { es: clave },
  platos,
  ...extra,
})
const cartaDe = (...secciones: ReturnType<typeof seccion>[]) => stringify({ secciones })

const ID_FIJO = '01JB0000000000000000000000'

describe('repetir el seed', () => {
  it('cinco corridas con relojes distintos dejan la base idéntica, con versiones y PIN', () => {
    const h = hub()
    h.cargar(TEXTO_CARTA, AHORA)
    const tablas = [...TABLAS_VERSIONADAS, 'contador', 'usuario_credencial']
    const referencia = volcar(h.db, tablas)

    for (const hora of [MAS_TARDE, '2026-10-26T01:00:00.000Z', '2027-01-01T00:00:00.000Z']) {
      const r = h.cargar(TEXTO_CARTA, hora)
      expect(r.pines).toEqual([])
      for (const [tabla, c] of Object.entries(r.tablas))
        expect({ tabla, ...c, igual: 0, respetado: 0 }).toEqual({
          tabla,
          creado: 0,
          actualizado: 0,
          igual: 0,
          respetado: 0,
          archivado: 0,
        })
    }
    h.cargar(TEXTO_CARTA, '2027-06-30T12:00:00.000Z')
    expect(volcar(h.db, tablas)).toEqual(referencia)
  })

  it('el resumen de la primera corrida cuenta todo como creado y el de la segunda todo como igual', () => {
    const h = hub()
    const primera = h.cargar()
    const segunda = h.cargar(TEXTO_CARTA, MAS_TARDE)
    const cuentas = (c: Partial<Record<Cambio, number>>) => ({
      creado: 0,
      actualizado: 0,
      igual: 0,
      respetado: 0,
      archivado: 0,
      ...c,
    })

    expect(primera.tablas.mesa).toEqual(cuentas({ creado: MESAS }))
    expect(primera.tablas.producto).toEqual(cuentas({ creado: 98 }))
    expect(primera.tablas.usuario).toEqual(cuentas({ creado: PERSONAL.length }))
    expect(primera.tablas.impuesto).toEqual(cuentas({ creado: 1 }))
    expect(segunda.tablas.mesa).toEqual(cuentas({ igual: MESAS }))
    expect(segunda.tablas.producto).toEqual(cuentas({ igual: 98 }))
    expect(segunda.tablas.usuario).toEqual(cuentas({ igual: PERSONAL.length }))
    expect(segunda.tablas.restaurante).toEqual(cuentas({ igual: 1 }))
    // El impuesto se crea una sola vez: después el seed lo respeta, no lo compara.
    expect(segunda.tablas.impuesto).toEqual(cuentas({ respetado: 1 }))
  })

  it('el contador de catálogo es el mayor `version` y ninguna versión se repite', () => {
    const h = hub()
    h.cargar()
    const versiones = TABLAS_VERSIONADAS.flatMap((t) =>
      h.db
        .prepare(`SELECT version FROM ${t}`)
        .all()
        .map((f) => Number(f.version)),
    )
    const contador = Number(
      h.db.prepare("SELECT valor FROM contador WHERE nombre = 'catalogo'").get()?.valor,
    )
    expect(Math.max(...versiones)).toBe(contador)
    // Una versión por cambio: dos filas con la misma versión harían ambiguo el "cambios desde N".
    expect(new Set(versiones).size).toBe(versiones.length)
  })

  it('el mismo restaurante en dos hubs distintos da exactamente las mismas filas', () => {
    const a = hub(ID_FIJO)
    const b = hub(ID_FIJO)
    a.cargar()
    b.cargar()
    expect(volcar(a.db, TABLAS_SEED)).toEqual(volcar(b.db, TABLAS_SEED))
    // Y las personas del seed tienen los mismos IDs (no los PIN).
    expect(volcar(a.db, ['sede'])).toEqual(volcar(b.db, ['sede']))
    const ids = (h: ReturnType<typeof hub>) =>
      h.db
        .prepare("SELECT id FROM usuario WHERE nombre <> 'Administrador' ORDER BY id")
        .all()
        .map((f) => f.id)
    expect(ids(a)).toEqual(ids(b))
  })

  it('el orden de la carta no cambia los IDs de los productos', () => {
    const original = leerCarta(TEXTO_CARTA)
    const barajada = stringify({
      secciones: (parse(TEXTO_CARTA) as { secciones: { platos: unknown[] }[] }).secciones
        .reverse()
        .map((s) => ({ ...s, platos: [...s.platos].reverse() })),
    })
    const a = hub(ID_FIJO)
    const b = hub(ID_FIJO)
    a.cargar(TEXTO_CARTA)
    b.cargar(barajada)
    const idsProductos = (h: ReturnType<typeof hub>) =>
      h.db
        .prepare('SELECT id, nombre, precio FROM producto ORDER BY id')
        .all()
        .map((f) => `${f.id}:${f.nombre}:${f.precio}`)
    expect(idsProductos(b)).toEqual(idsProductos(a))
    expect(original.flatMap((c) => c.productos)).toHaveLength(98)
  })

  it('todos los IDs del seed son ULID válidos y no se repiten entre tablas', () => {
    const h = hub()
    h.cargar()
    const ids = TABLAS_VERSIONADAS.flatMap((t) =>
      h.db
        .prepare(`SELECT id FROM ${t}`)
        .all()
        .map((f) => String(f.id)),
    )
    for (const id of ids) expect(esIdValido(id)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('restaurantes distintos', () => {
  it('dos restaurantes con la misma marca de tiempo en la misma base no chocan en ningún ID', () => {
    const otro = `${ID_FIJO.slice(0, 10)}ZZZZZZZZZZZZZZZZ`
    const a = hub(ID_FIJO)
    const b = hub(otro, a.db)
    a.cargar()
    b.cargar()

    expect(
      contar(a.db, 'SELECT count(*) AS n FROM producto WHERE restaurante_id = ?', ID_FIJO),
    ).toBe(98)
    expect(contar(a.db, 'SELECT count(*) AS n FROM producto WHERE restaurante_id = ?', otro)).toBe(
      98,
    )
    for (const tabla of TABLAS_VERSIONADAS) {
      const ids = a.db
        .prepare(`SELECT id FROM ${tabla}`)
        .all()
        .map((f) => String(f.id))
      expect(new Set(ids).size).toBe(ids.length)
    }
    // Repetir el seed de uno no toca al otro.
    const antes = volcar(a.db, ['producto'])
    b.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(volcar(a.db, ['producto'])).toEqual(antes)
  })

  it('con ULID de restaurantes distintos, la misma clave da IDs distintos aunque el prefijo sea igual', () => {
    const a = idEstable(ID_FIJO, 'mesa:1')
    const b = idEstable(`${ID_FIJO.slice(0, 10)}ZZZZZZZZZZZZZZZZ`, 'mesa:1')
    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(a).not.toBe(b)
    expect(esIdValido(a)).toBe(true)
    expect(esIdValido(b)).toBe(true)
  })

  it('el ID depende de la clave exacta: mayúsculas y espacios dan IDs distintos', () => {
    const ids = ['mesa:1', 'mesa:01', 'Mesa:1', 'mesa: 1', 'mesa:1 '].map((c) =>
      idEstable(ID_FIJO, c),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('registros archivados a mano', () => {
  const idDe = (h: ReturnType<typeof hub>, clave: string) => idEstable(h.restauranteId, clave)
  const estado = (h: ReturnType<typeof hub>, tabla: string, id: string) =>
    h.db.prepare(`SELECT activo, version FROM ${tabla} WHERE id = ?`).get(id)

  it('el seed reactiva un producto, una mesa, una categoría y una opción archivados', () => {
    const h = hub()
    h.cargar()
    const objetivos = [
      ['producto', idDe(h, 'producto:PIZZAS:quattro-formaggi')],
      ['mesa', idDe(h, 'mesa:7')],
      ['categoria', idDe(h, 'categoria:PIZZAS')],
      ['modificador', idDe(h, 'modificador:sabor:BEBIDAS:te-hatsu:Rojo')],
    ] as const
    const contadorAntes = Number(
      h.db.prepare("SELECT valor FROM contador WHERE nombre = 'catalogo'").get()?.valor,
    )
    for (const [tabla, id] of objetivos)
      h.db.prepare(`UPDATE ${tabla} SET activo = 0 WHERE id = ?`).run(id)

    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    for (const [tabla, id] of objetivos) {
      expect({ tabla, ...estado(h, tabla, id) }).toMatchObject({ tabla, activo: 1 })
      expect(Number(estado(h, tabla, id)?.version)).toBeGreaterThan(contadorAntes)
    }
    expect(r.tablas.producto).toMatchObject({ creado: 0, actualizado: 1 })
    expect(r.tablas.mesa).toMatchObject({ creado: 0, actualizado: 1 })
    // No se duplicó nada.
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto')).toBe(98)
    expect(contar(h.db, 'SELECT count(*) AS n FROM mesa')).toBe(MESAS)

    // La corrida siguiente ya no cambia nada.
    const tercera = h.cargar(TEXTO_CARTA, '2026-10-26T09:00:00.000Z')
    expect(tercera.tablas.producto).toMatchObject({ actualizado: 0 })
  })

  it('un producto archivado que además cambió de precio vuelve con el precio de la carta', () => {
    const h = hub()
    h.cargar()
    const id = idDe(h, 'producto:PIZZAS:quattro-formaggi')
    h.db.prepare('UPDATE producto SET activo = 0, precio = 1 WHERE id = ?').run(id)
    h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(h.db.prepare('SELECT activo, precio FROM producto WHERE id = ?').get(id)).toEqual({
      activo: 1,
      precio: 44_900,
    })
  })

  it('un usuario archivado del seed no se recrea ni choca su ID, y no se le da PIN nuevo', () => {
    const h = hub()
    h.cargar()
    const id = idDe(h, 'usuario:caja')
    const huella = h.db
      .prepare('SELECT pin_huella FROM usuario_credencial WHERE usuario_id = ?')
      .get(id)
    h.db.prepare('UPDATE usuario SET activo = 0 WHERE id = ?').run(id)

    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(r.pines).toEqual([])
    expect(r.tablas.usuario?.creado).toBe(0)
    expect(contar(h.db, 'SELECT count(*) AS n FROM usuario WHERE id = ?', id)).toBe(1)
    expect(
      h.db.prepare('SELECT pin_huella FROM usuario_credencial WHERE usuario_id = ?').get(id),
    ).toEqual(huella)
  })
})

describe('cambios en la carta', () => {
  const nombres = (
    h: ReturnType<typeof hub>,
    sql = 'SELECT nombre FROM producto WHERE activo = 1',
  ) =>
    h.db
      .prepare(sql)
      .all()
      .map((f) => String(f.nombre))

  it('cambiar solo mayúsculas o acentos del nombre conserva el producto y actualiza el nombre', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const r = h.cargar(
      TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Quattro formaggi'),
      MAS_TARDE,
    )
    expect(h.db.prepare('SELECT nombre FROM producto WHERE id = ?').get(id)?.nombre).toBe(
      'Quattro formaggi',
    )
    expect(r.tablas.producto).toMatchObject({ creado: 0, actualizado: 1 })
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto')).toBe(98)

    // "Té Hatsu" → "Te Hatsu": mismo producto (la clave quita los acentos), con sus sabores.
    const hatsu = idEstable(h.restauranteId, 'producto:BEBIDAS:te-hatsu')
    h.cargar(TEXTO_CARTA.replace('es: Té Hatsu', 'es: Te Hatsu'), '2026-10-26T09:00:00.000Z')
    expect(h.db.prepare('SELECT nombre FROM producto WHERE id = ?').get(hatsu)?.nombre).toBe(
      'Te Hatsu',
    )
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto')).toBe(98)
  })

  it('renombrar un plato crea el nuevo y archiva el viejo: la carta del mesero no queda duplicada', () => {
    const h = hub()
    h.cargar()
    const viejo = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const antes = Number(
      h.db.prepare('SELECT version FROM producto WHERE id = ?').get(viejo)?.version,
    )
    const r = h.cargar(TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'), MAS_TARDE)

    expect(r.tablas.producto).toMatchObject({ creado: 1, actualizado: 0, archivado: 1 })
    const fila = h.db
      .prepare('SELECT activo, precio, version FROM producto WHERE id = ?')
      .get(viejo)
    expect(fila).toMatchObject({ activo: 0, precio: 44_900 })
    // Archivar es un cambio más del catálogo: sube la versión para que los dispositivos lo reciban.
    expect(Number(fila?.version)).toBeGreaterThan(antes)
    expect(nombres(h)).toContain('Cuatro Quesos')
    expect(nombres(h)).not.toContain('Quattro Formaggi')
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto WHERE activo = 1')).toBe(98)

    // Y la corrida siguiente ya no archiva nada más.
    const otra = h.cargar(
      TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'),
      '2026-10-26T09:00:00.000Z',
    )
    expect(otra.tablas.producto).toMatchObject({ creado: 0, actualizado: 0, archivado: 0 })
  })

  it('si el nombre vuelve a ser el de antes, el producto archivado se reactiva con su mismo ID', () => {
    const h = hub()
    h.cargar()
    const viejo = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    h.cargar(TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'), MAS_TARDE)
    h.cargar(TEXTO_CARTA, '2026-10-26T09:00:00.000Z')
    expect(h.db.prepare('SELECT activo FROM producto WHERE id = ?').get(viejo)?.activo).toBe(1)
    expect(
      contar(
        h.db,
        "SELECT count(*) AS n FROM producto WHERE nombre = 'Cuatro Quesos' AND activo = 1",
      ),
    ).toBe(0)
  })

  it('quitar un sabor, un plato o una sección de la carta archiva lo ya sembrado', () => {
    const h = hub()
    h.cargar()
    const recortada = TEXTO_CARTA.replace('es: Rojo/Amarillo/Blanco', 'es: Rojo/Amarillo/Verde')
    const r = h.cargar(recortada, MAS_TARDE)
    const sabores = (activo: number) =>
      nombres(
        h,
        `SELECT m.nombre FROM modificador m JOIN grupo_modificador g ON g.id = m.grupo_id
         WHERE g.nombre = 'Sabor' AND m.activo = ${activo} AND m.nombre IN ('Rojo','Amarillo','Blanco','Verde')`,
      ).sort()
    expect(sabores(1)).toEqual(['Amarillo', 'Rojo', 'Verde'])
    expect(sabores(0)).toEqual(['Blanco'])
    expect(r.tablas.modificador).toMatchObject({ creado: 1, archivado: 1 })

    const carta = parse(TEXTO_CARTA) as { secciones: { clave: string; platos: unknown[] }[] }
    const pizzas = carta.secciones.find((s) => s.clave === 'PIZZAS')?.platos.length ?? 0
    const sinPizzas = stringify({ secciones: carta.secciones.filter((s) => s.clave !== 'PIZZAS') })
    const r2 = h.cargar(sinPizzas, '2026-10-26T09:00:00.000Z')
    expect(
      contar(h.db, "SELECT count(*) AS n FROM categoria WHERE nombre = 'Pizzas' AND activo = 1"),
    ).toBe(0)
    expect(r2.tablas.categoria).toMatchObject({ archivado: 1 })
    expect(r2.tablas.producto).toMatchObject({ archivado: pizzas })
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto WHERE activo = 1')).toBe(98 - pizzas)
    // Nada se borró: sigue todo en la base, archivado.
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto')).toBe(98)
  })

  it('lo que una persona editó o creó (usuario_id) no se pisa ni se archiva', () => {
    const h = hub()
    h.cargar()
    const quattro = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const margarita = idEstable(h.restauranteId, 'producto:PIZZAS:garden-margarita')
    const gerente = idEstable(h.restauranteId, 'usuario:gerente')
    // El gerente cambió un precio desde el editor; el seed no debe devolverlo.
    h.db
      .prepare('UPDATE producto SET precio = 50000, usuario_id = ? WHERE id = ?')
      .run(gerente, quattro)
    // Y creó un producto propio que no está en la carta.
    const propio = nuevoId()
    h.db
      .prepare(
        `INSERT INTO producto (id, restaurante_id, creado_en, actualizado_en, version, usuario_id, categoria_id, nombre, precio, impuesto_id)
         SELECT ?, restaurante_id, creado_en, actualizado_en, 9999, ?, categoria_id, 'Plato del día', 25000, impuesto_id FROM producto WHERE id = ?`,
      )
      .run(propio, gerente, quattro)

    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(h.db.prepare('SELECT precio, activo FROM producto WHERE id = ?').get(quattro)).toEqual({
      precio: 50_000,
      activo: 1,
    })
    expect(h.db.prepare('SELECT activo FROM producto WHERE id = ?').get(propio)?.activo).toBe(1)
    expect(r.tablas.producto).toMatchObject({ respetado: 1, archivado: 0, actualizado: 0 })
    expect(h.db.prepare('SELECT activo FROM producto WHERE id = ?').get(margarita)?.activo).toBe(1)

    // Un producto de una persona que sale de la carta tampoco se archiva.
    h.cargar(
      TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'),
      '2026-10-26T09:00:00.000Z',
    )
    expect(h.db.prepare('SELECT activo FROM producto WHERE id = ?').get(quattro)?.activo).toBe(1)
  })

  it('el impuesto que el contador cambió no se devuelve a la tarifa del seed', () => {
    const h = hub()
    h.cargar()
    h.db.prepare("UPDATE impuesto SET tarifa = 1900 WHERE tipo = 'inc'").run()
    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(h.db.prepare('SELECT tarifa FROM impuesto').get()?.tarifa).toBe(1900)
    expect(r.tablas.impuesto).toMatchObject({ respetado: 1, actualizado: 0 })
  })

  it('un plato con disponible: false no se carga, y si ya estaba se archiva', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const texto = (carta: string) => carta
    const agotado = texto(
      TEXTO_CARTA.replace(/(es: Quattro Formaggi[\s\S]*?disponible: )true/, '$1false'),
    )
    expect(agotado).not.toBe(TEXTO_CARTA)
    expect(leerCarta(agotado).flatMap((c) => c.productos)).toHaveLength(97)
    const r = h.cargar(agotado, MAS_TARDE)
    expect(r.tablas.producto).toMatchObject({ archivado: 1, creado: 0 })
    expect(h.db.prepare('SELECT activo FROM producto WHERE id = ?').get(id)?.activo).toBe(0)

    // En un hub limpio ni siquiera se crea.
    const limpio = hub()
    limpio.cargar(agotado)
    expect(contar(limpio.db, 'SELECT count(*) AS n FROM producto')).toBe(97)
  })

  it('mover un plato a otra sección lo siembra en la nueva y archiva el de la vieja', () => {
    const h = hub()
    h.cargar(cartaDe(seccion('A', [plato('Agua', 3000)]), seccion('B', [plato('Jugo', 5000)])))
    const r = h.cargar(
      cartaDe(seccion('A', []), seccion('B', [plato('Jugo', 5000), plato('Agua', 3000)])),
      MAS_TARDE,
    )
    expect(r.tablas.producto).toMatchObject({ creado: 1, archivado: 1 })
    expect(
      contar(h.db, "SELECT count(*) AS n FROM producto WHERE nombre = 'Agua' AND activo = 1"),
    ).toBe(1)
    expect(
      h.db
        .prepare(
          `SELECT c.nombre FROM producto p JOIN categoria c ON c.id = p.categoria_id
           WHERE p.nombre = 'Agua' AND p.activo = 1`,
        )
        .get()?.nombre,
    ).toBe('B')
  })

  it('cambiar el precio de una variante actualiza la variante y el precio base solo si era la más barata', () => {
    const texto = cartaDe(
      seccion('VINOS', [plato('Malbec Botella', 120_000), plato('Malbec Copa', 30_000)]),
    )
    const h = hub()
    h.cargar(texto)
    const producto = idEstable(h.restauranteId, 'producto:VINOS:malbec')

    const subeBotella = h.cargar(texto.replace('120000', '125000'), MAS_TARDE)
    expect(subeBotella.tablas.variante).toMatchObject({ actualizado: 1, igual: 1 })
    expect(subeBotella.tablas.producto).toMatchObject({ actualizado: 0 })

    const subeCopa = h.cargar(
      texto.replace('120000', '125000').replace('30000', '31000'),
      '2026-10-26T09:00:00.000Z',
    )
    expect(subeCopa.tablas.variante).toMatchObject({ actualizado: 1, igual: 1 })
    expect(subeCopa.tablas.producto).toMatchObject({ actualizado: 1 })
    expect(h.db.prepare('SELECT precio FROM producto WHERE id = ?').get(producto)?.precio).toBe(
      31_000,
    )
  })
})

describe('variantes copa y botella', () => {
  const productosDe = (texto: string) => leerCarta(texto).flatMap((c) => c.productos)

  it('una copa sola, sin su botella, queda como producto suelto con su nombre completo', () => {
    const [p] = productosDe(cartaDe(seccion('VINOS', [plato('Malbec Copa', 30_000)])))
    expect(p).toMatchObject({ nombre: 'Malbec Copa', precio: 30_000, variantes: [] })
  })

  it('una botella sola queda como producto suelto, con el tamaño al inicio o al final', () => {
    const ps = productosDe(
      cartaDe(
        seccion('VINOS', [plato('Botella Lambrusco', 99_000), plato('Merlot Botella', 90_000)]),
      ),
    )
    expect(ps.map((p) => [p.nombre, p.variantes.length])).toEqual([
      ['Botella Lambrusco', 0],
      ['Merlot Botella', 0],
    ])
  })

  it('el tamaño al inicio también junta copa y botella en un producto', () => {
    const [p] = productosDe(
      cartaDe(seccion('VINOS', [plato('Botella Malbec', 120_000), plato('Copa Malbec', 30_000)])),
    )
    expect(p).toMatchObject({
      nombre: 'Malbec',
      precio: 30_000,
      variantes: [
        { nombre: 'Copa', precio: 30_000 },
        { nombre: 'Botella', precio: 120_000 },
      ],
    })
  })

  it('el vino sin tamaño más su copa y su botella no se junta: tres productos', () => {
    const ps = productosDe(
      cartaDe(
        seccion('VINOS', [
          plato('Malbec', 10_000),
          plato('Malbec Copa', 30_000),
          plato('Malbec Botella', 120_000),
        ]),
      ),
    )
    expect(ps.map((p) => p.nombre)).toEqual(['Malbec', 'Malbec Copa', 'Malbec Botella'])
    expect(ps.every((p) => p.variantes.length === 0)).toBe(true)
  })

  it('dos copas del mismo vino son un plato repetido y la lectura falla', () => {
    expect(() =>
      leerCarta(
        cartaDe(seccion('VINOS', [plato('Malbec Copa', 30_000), plato('Malbec Copa', 31_000)])),
      ),
    ).toThrow(/repetido/)
  })

  it('dos platos que solo difieren en mayúsculas o acentos son un plato repetido', () => {
    expect(() =>
      leerCarta(cartaDe(seccion('X', [plato('Café', 1000), plato('cafe', 2000)]))),
    ).toThrow(/repetido/)
  })

  it('la carta lista botella primero pero en la base la copa queda con orden 0', () => {
    const h = hub()
    h.cargar(
      cartaDe(seccion('VINOS', [plato('Malbec Botella', 120_000), plato('Malbec Copa', 30_000)])),
    )
    expect(h.db.prepare('SELECT nombre, orden FROM variante ORDER BY orden').all()).toEqual([
      { nombre: 'Copa', orden: 0 },
      { nombre: 'Botella', orden: 1 },
    ])
  })

  it('si la carta deja de tener la botella, el producto con variantes se archiva con sus dos variantes', () => {
    const h = hub()
    h.cargar(
      cartaDe(seccion('VINOS', [plato('Malbec Botella', 120_000), plato('Malbec Copa', 30_000)])),
    )
    const r = h.cargar(cartaDe(seccion('VINOS', [plato('Malbec Copa', 30_000)])), MAS_TARDE)
    // La copa suelta es otro producto ("Malbec Copa"); el viejo, con sus variantes, se archiva.
    expect(r.tablas.producto).toMatchObject({ creado: 1, archivado: 1 })
    expect(r.tablas.variante).toMatchObject({ archivado: 2 })
    expect(contar(h.db, 'SELECT count(*) AS n FROM variante WHERE activo = 1')).toBe(0)
    expect(
      h.db
        .prepare('SELECT nombre FROM producto WHERE activo = 1')
        .all()
        .map((f) => f.nombre),
    ).toEqual(['Malbec Copa'])
  })

  it('con variantes, la descripción es la del primer plato que la traiga', () => {
    const [p] = leerCarta(
      cartaDe(
        seccion('VINOS', [
          plato('Malbec Copa', 30_000),
          plato('Malbec Botella', 120_000, 'Mendoza, 2021'),
        ]),
      ),
    ).flatMap((c) => c.productos)
    expect(p?.variantes).toHaveLength(2)
    expect(p?.descripcion).toBe('Mendoza, 2021')
  })
})

describe('sabores', () => {
  const hatsu = (descripcion: string, nombre = 'Té Hatsu') =>
    cartaDe(seccion('BEBIDAS', [plato(nombre, 13_900, descripcion)]))

  it('los sabores con acentos son opciones del grupo, estables entre corridas', () => {
    const h = hub()
    const texto = hatsu('Limón/Piña/Maracuyá', 'Soda Hatsu')
    h.cargar(texto)
    const nombres = h.db
      .prepare('SELECT nombre FROM modificador ORDER BY orden')
      .all()
      .map((f) => f.nombre)
    expect(nombres).toEqual(['Limón', 'Piña', 'Maracuyá'])
    const r = h.cargar(texto, MAS_TARDE)
    expect(r.tablas.modificador).toEqual({
      creado: 0,
      actualizado: 0,
      igual: 3,
      respetado: 0,
      archivado: 0,
    })
  })

  it('los espacios alrededor de la barra se ignoran: "Rojo / Amarillo" vale', () => {
    const [p] = leerCarta(hatsu('  Rojo / Amarillo /Blanco ')).flatMap((c) => c.productos)
    expect(p?.grupos[0]?.opciones.map((o) => o.nombre)).toEqual(['Rojo', 'Amarillo', 'Blanco'])
    expect(p?.descripcion).toBeNull()
  })

  it('un sabor con espacio interno es un solo sabor', () => {
    const [p] = leerCarta(hatsu('Fresa Limón/Maracuyá')).flatMap((c) => c.productos)
    expect(p?.grupos[0]?.opciones.map((o) => o.nombre)).toEqual(['Fresa Limón', 'Maracuyá'])
  })

  it('sabores obligatorios y sin costo', () => {
    const [p] = leerCarta(hatsu('Rojo/Blanco')).flatMap((c) => c.productos)
    expect(p?.grupos[0]).toMatchObject({ minimo: 1, maximo: 1 })
    expect(p?.grupos[0]?.opciones.every((o) => o.precioExtra === 0)).toBe(true)
  })

  it('el Té Hatsu o la Soda Hatsu con menos de dos sabores es un error de la carta', () => {
    for (const descripcion of ['Natural', 'Rojo', 'Rojo/', '/Rojo', 'Rojo//', ' / ', ''])
      expect(() => leerCarta(hatsu(descripcion)), descripcion).toThrow(/sabores/)
    expect(() => leerCarta(cartaDe(seccion('B', [plato('Té Hatsu', 1)])))).toThrow(/sabores/)
    expect(() => leerCarta(hatsu('Rojo', 'Soda Hatsu'))).toThrow(/sabores/)
  })

  it('un sabor repetido ("Rojo/Rojo") es un error de la carta, con o sin acentos y mayúsculas', () => {
    for (const descripcion of ['Rojo/Rojo/Blanco', 'Rojo/rojo', 'Limón/Limon', ' Rojo /Rojo '])
      expect(() => leerCarta(hatsu(descripcion)), descripcion).toThrow(/repite/)
  })

  it('otro plato con barras en la descripción no se vuelve sabor', () => {
    for (const descripcion of ['Jamón/Queso', 'Rojo/Amarillo', 'Aguacate / Tomate']) {
      const [p] = leerCarta(cartaDe(seccion('S', [plato('Sándwich', 9000, descripcion)]))).flatMap(
        (c) => c.productos,
      )
      expect({ descripcion, grupos: p?.grupos.length, texto: p?.descripcion }).toEqual({
        descripcion,
        grupos: 0,
        texto: descripcion,
      })
    }
  })

  it('si la carta ya no trae el Té Hatsu o la Tagliata, `reglasSinPlato` lo avisa', () => {
    expect(reglasSinPlato(leerCarta(TEXTO_CARTA))).toEqual([])
    expect(reglasSinPlato(leerCarta(cartaDe(seccion('S', [plato('Agua', 1)]))))).toEqual([
      'Tagliata di Manzo',
      'Té Hatsu',
      'Soda Hatsu',
    ])
  })

  it('el grupo de término de la carne se comparte entre productos y se crea una sola vez', () => {
    const h = hub()
    h.cargar()
    expect(
      contar(
        h.db,
        "SELECT count(*) AS n FROM grupo_modificador WHERE nombre = 'Término de la carne'",
      ),
    ).toBe(1)
    expect(
      contar(
        h.db,
        'SELECT count(*) AS n FROM modificador WHERE grupo_id = ?',
        idEstable(h.restauranteId, 'grupo:termino'),
      ),
    ).toBe(4)
    expect(
      contar(
        h.db,
        'SELECT count(*) AS n FROM producto_grupo_modificador WHERE grupo_id = ?',
        idEstable(h.restauranteId, 'grupo:termino'),
      ),
    ).toBeGreaterThan(1)
  })
})

describe('secciones ocultas', () => {
  const dosSecciones = (visibleA: boolean, visibleB = true) =>
    cartaDe(
      seccion('A', [plato('Agua', 3000)], { visible: visibleA }),
      seccion('B', [plato('Jugo', 5000)], { visible: visibleB }),
    )

  it('una sección invisible no se siembra y el orden de las visibles queda seguido', () => {
    const carta = leerCarta(
      cartaDe(
        seccion('A', [plato('a', 1)], { visible: false }),
        seccion('B', [plato('b', 1)]),
        seccion('C', [plato('c', 1)], { visible: false }),
        seccion('D', [plato('d', 1)]),
      ),
    )
    expect(carta.map((c) => [c.clave, c.orden])).toEqual([
      ['B', 0],
      ['D', 1],
    ])
    const h = hub()
    h.cargar(
      cartaDe(seccion('A', [plato('a', 1)], { visible: false }), seccion('B', [plato('b', 1)])),
    )
    expect(contar(h.db, 'SELECT count(*) AS n FROM categoria')).toBe(1)
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto')).toBe(1)
  })

  it('las claves de sección son únicas en toda la carta, también las de secciones invisibles', () => {
    expect(() =>
      leerCarta(
        cartaDe(seccion('A', [plato('x', 1)], { visible: false }), seccion('A', [plato('y', 1)])),
      ),
    ).toThrow(/repetida/)
  })

  it('una clave de sección con espacios, ":" o "|" se rechaza porque va dentro de los IDs', () => {
    for (const clave of ['A B', 'A:B', 'A|B', '', ' A'])
      expect(() => leerCarta(cartaDe(seccion(clave, [plato('x', 1)]))), clave).toThrow()
  })

  it('una sección invisible con un precio inválido sí falla: la carta se valida entera', () => {
    expect(() =>
      leerCarta(
        cartaDe(seccion('A', [plato('x', 1.5)], { visible: false }), seccion('B', [plato('y', 1)])),
      ),
    ).toThrow()
  })

  it('ocultar una sección ya sembrada la archiva con sus productos y deja el orden seguido', () => {
    const h = hub()
    h.cargar(dosSecciones(true))
    const r = h.cargar(dosSecciones(false), MAS_TARDE)
    expect(r.tablas.categoria).toMatchObject({ archivado: 1, actualizado: 1 })
    expect(r.tablas.producto).toMatchObject({ archivado: 1 })
    expect(contar(h.db, 'SELECT count(*) AS n FROM categoria WHERE activo = 1')).toBe(1)
    expect(h.db.prepare("SELECT orden FROM categoria WHERE nombre = 'B'").get()?.orden).toBe(0)
    expect(h.db.prepare("SELECT activo FROM producto WHERE nombre = 'Agua'").get()?.activo).toBe(0)
    // Mostrarla otra vez la reactiva.
    h.cargar(dosSecciones(true), '2026-10-26T09:00:00.000Z')
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto WHERE activo = 1')).toBe(2)
  })

  it('una carta con todas las secciones ocultas no deja categorías ni productos', () => {
    const h = hub()
    h.cargar(dosSecciones(true))
    h.cargar(dosSecciones(false, false), MAS_TARDE)
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto WHERE activo = 1')).toBe(0)
    expect(contar(h.db, 'SELECT count(*) AS n FROM categoria WHERE activo = 1')).toBe(0)
    expect(contar(h.db, 'SELECT count(*) AS n FROM mesa WHERE activo = 1')).toBe(MESAS)
  })
})

describe('seed interrumpido', () => {
  /** La base que lanza al preparar la sentencia que cumpla `cuando`: el proceso murió ahí. */
  function conFalla(db: BaseSqlite, cuando: (sql: string) => boolean): BaseSqlite {
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        if (cuando(sql)) throw new Error('el proceso murió')
        return db.prepare(sql)
      },
      close: () => db.close(),
    }
  }

  it('si muere a mitad del catálogo no queda nada a medias y la siguiente corrida deja el resultado limpio', () => {
    const h = hub(ID_FIJO)
    const todas = [...TABLAS_VERSIONADAS, 'contador', 'usuario_credencial']
    const antes = volcar(h.db, todas)

    let insertados = 0
    const roto = conFalla(
      h.db,
      (sql) => sql.startsWith('INSERT INTO producto ') && ++insertados === 50,
    )
    expect(() =>
      sembrar(
        roto,
        h.acceso,
        { restauranteId: h.restauranteId, roles: h.roles, carta: leerCarta(TEXTO_CARTA) },
        AHORA,
      ),
    ).toThrow('el proceso murió')

    // Ni salón, ni estaciones, ni impuesto, ni el nombre del restaurante: nada se guardó.
    expect(volcar(h.db, todas)).toEqual(antes)
    expect(h.db.prepare('SELECT nombre FROM restaurante').get()?.nombre).toBe('Mi restaurante')
    expect(contar(h.db, 'SELECT count(*) AS n FROM mesa')).toBe(0)

    // Sin restos que estorben: queda igual que en un hub que corrió el seed sin interrupción.
    const limpio = hub(ID_FIJO)
    limpio.cargar()
    h.cargar()
    expect(volcar(h.db, TABLAS_SEED)).toEqual(volcar(limpio.db, TABLAS_SEED))
  })

  it('si falla al crear al personal no queda nada: ni catálogo ni usuarios, y la siguiente corrida lo crea todo', () => {
    const h = hub(ID_FIJO)
    const todas = [...TABLAS_VERSIONADAS, 'contador', 'usuario_credencial']
    const antes = volcar(h.db, todas)
    let llamadas = 0
    const quebradiza = {
      insertarUsuario: (...args: Parameters<ServicioAcceso['insertarUsuario']>) => {
        if (++llamadas === 4) throw new Error('el proceso murió')
        return h.acceso.insertarUsuario(...args)
      },
    } as unknown as ServicioAcceso

    expect(() => h.cargar(TEXTO_CARTA, AHORA, quebradiza)).toThrow('el proceso murió')
    expect(llamadas).toBe(4)
    // Los tres usuarios que se alcanzaron a crear también se deshicieron, con sus PIN.
    expect(volcar(h.db, todas)).toEqual(antes)

    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(r.pines.map((p) => p.nombre)).toEqual(PERSONAL.map((p) => p.nombre))
    expect(contar(h.db, 'SELECT count(*) AS n FROM usuario')).toBe(PERSONAL.length)
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto')).toBe(98)
    const limpio = hub(ID_FIJO)
    limpio.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(volcar(h.db, TABLAS_SEED)).toEqual(volcar(limpio.db, TABLAS_SEED))
  })

  it('con `sinPersonal` se carga el catálogo sin crear a nadie ni entregar PIN', () => {
    const h = hub()
    const r = sembrar(
      h.db,
      h.acceso,
      {
        restauranteId: h.restauranteId,
        roles: h.roles,
        carta: leerCarta(TEXTO_CARTA),
        sinPersonal: true,
      },
      AHORA,
    )
    expect(r.pines).toEqual([])
    expect(r.tablas.usuario).toBeUndefined()
    expect(contar(h.db, 'SELECT count(*) AS n FROM usuario')).toBe(0)
    expect(contar(h.db, 'SELECT count(*) AS n FROM producto')).toBe(98)
    // Y una corrida normal después completa el personal.
    expect(h.cargar(TEXTO_CARTA, MAS_TARDE).pines).toHaveLength(PERSONAL.length)
  })

  it('una configuración del restaurante inválida detiene el seed sin escribir nada', () => {
    const h = hub()
    h.db.prepare('UPDATE restaurante SET config = \'{"campo_raro":1}\'').run()
    const todas = [...TABLAS_VERSIONADAS, 'contador']
    const antes = volcar(h.db, todas)
    expect(() => h.cargar()).toThrow()
    expect(volcar(h.db, todas)).toEqual(antes)
  })

  it('un restaurante sin sede detiene el seed con un mensaje claro y sin cambiar su nombre', () => {
    const h = hub()
    h.db.exec('DROP TRIGGER sede_sin_delete')
    h.db.exec('DELETE FROM sede')
    expect(() => h.cargar()).toThrow(/sede/)
    expect(h.db.prepare('SELECT nombre FROM restaurante').get()?.nombre).toBe('Mi restaurante')
    expect(contar(h.db, 'SELECT count(*) AS n FROM mesa')).toBe(0)
  })

  it('una carta con un precio inválido falla antes de tocar la base', () => {
    const h = hub()
    const antes = volcar(h.db, TABLAS_VERSIONADAS)
    expect(() => h.cargar(TEXTO_CARTA.replace('precio: 44900', 'precio: 44900.5'))).toThrow()
    expect(volcar(h.db, TABLAS_VERSIONADAS)).toEqual(antes)
  })
})
