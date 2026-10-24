import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { esIdValido } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from '../acceso/inicial'
import { idEstable } from '../acceso/registros'
import { ServicioAcceso } from '../acceso/servicio'
import { leerCarta, TERMINO } from './carta'
import { MESAS, PERSONAL, sembrar } from './sembrar'

const RUTA_CARTA = fileURLToPath(
  new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url),
)
const TEXTO_CARTA = readFileSync(RUTA_CARTA, 'utf8')
const AHORA = '2026-10-24T20:00:00.000Z'

function hub() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = asegurarRestaurante(db, AHORA)
  const roles = asegurarRoles(db, restauranteId, AHORA)
  const acceso = new ServicioAcceso({
    db,
    restauranteId,
    clave: Buffer.alloc(32, 3),
    reloj: () => AHORA,
  })
  asegurarAdministrador(db, acceso, roles.admin, false)
  const cargar = (texto = TEXTO_CARTA, ahora = AHORA) =>
    sembrar(db, acceso, { restauranteId, roles, carta: leerCarta(texto) }, ahora)
  const filas = (sql: string, ...p: string[]) => db.prepare(sql).all(...p)
  return { db, acceso, restauranteId, cargar, filas }
}

describe('lectura de la carta', () => {
  const carta = leerCarta(TEXTO_CARTA)
  const productos = carta.flatMap((c) => c.productos)
  const buscar = (nombre: string) => productos.find((p) => p.nombre === nombre)

  it('trae las 15 secciones con su estación: comida a cocina, bebidas a barra', () => {
    expect(carta.map((c) => c.nombre)).toEqual([
      'Entradas',
      'Pizzas',
      'Pastas',
      'Lasañas',
      'Hamburguesas',
      'Spritz',
      'Postres',
      'De Autor',
      'Clásicos',
      'Mocktails',
      'Sangrías',
      'Vinos',
      'Tragos',
      'Sodas',
      'Refrescos',
    ])
    expect(carta.find((c) => c.clave === 'PIZZAS')?.estacion).toBe('cocina')
    expect(carta.find((c) => c.clave === 'SPRITZ')?.estacion).toBe('barra')
  })

  it('copa y botella del mismo vino son un producto con dos opciones; una botella sola queda igual', () => {
    expect(buscar('Ramón Bilbao Crianza')).toMatchObject({
      precio: 30_900,
      variantes: [
        { nombre: 'Copa', precio: 30_900 },
        { nombre: 'Botella', precio: 129_900 },
      ],
    })
    expect(buscar('Ramón Bilbao Verdejo')?.variantes).toHaveLength(2)
    expect(buscar('Botella Lambrusco Rosé')).toMatchObject({ precio: 99_900, variantes: [] })
    expect(productos).toHaveLength(98)
  })

  it('el sabor del Té Hatsu es obligatorio y sin costo; la carne lleva término', () => {
    expect(buscar('Té Hatsu')).toMatchObject({
      descripcion: null,
      grupos: [
        {
          nombre: 'Sabor',
          minimo: 1,
          maximo: 1,
          opciones: [
            { nombre: 'Rojo', precioExtra: 0 },
            { nombre: 'Amarillo', precioExtra: 0 },
            { nombre: 'Blanco', precioExtra: 0 },
          ],
        },
      ],
    })
    expect(buscar('Soda Hatsu')?.grupos[0]?.opciones.map((o) => o.nombre)).toEqual([
      'Limon',
      'Sandía',
    ])
    expect(buscar('Tagliata di Manzo')?.grupos).toEqual([TERMINO])
    expect(buscar('Spritz Burguer')?.grupos).toEqual([TERMINO])
    expect(buscar('Quattro Formaggi')?.grupos).toEqual([])
  })

  it('ningún precio se pierde ni cambia: cada plato está como producto o como opción', () => {
    const original = TEXTO_CARTA.match(/precio: (\d+)/g)?.map((t) => Number(t.slice(8))) ?? []
    const cargados = productos.flatMap((p) =>
      p.variantes.length > 0 ? p.variantes.map((v) => v.precio) : [p.precio],
    )
    expect(cargados.sort((a, b) => a - b)).toEqual(original.sort((a, b) => a - b))
    for (const precio of cargados) expect(Number.isInteger(precio)).toBe(true)
  })

  it('rechaza precios con decimales, negativos o en texto, y secciones repetidas', () => {
    const una = (precio: unknown, clave = 'A') => ({
      clave,
      nombre: 'X',
      grupo: 'comida',
      boton: { es: 'X' },
      platos: [{ nombre: { es: 'Plato' }, precio }],
    })
    for (const precio of [20_900.5, -1, '20900', 200_000_000])
      expect(() => leerCarta(stringify({ secciones: [una(precio)] }))).toThrow()
    expect(() => leerCarta(stringify({ secciones: [una(1), una(2)] }))).toThrow(/repetida/)
    expect(() => leerCarta('secciones: []')).toThrow()
    expect(() => leerCarta('no es: [una carta')).toThrow()
  })
})

describe('carga en la base', () => {
  it('crea el salón, la carta y el personal con IDs válidos', () => {
    const h = hub()
    const r = h.cargar()

    const cuenta = (tabla: string) =>
      Number(h.db.prepare(`SELECT count(*) AS n FROM ${tabla} WHERE activo = 1`).get()?.n)
    expect(cuenta('mesa')).toBe(MESAS)
    expect(cuenta('categoria')).toBe(15)
    expect(cuenta('producto')).toBe(98)
    expect(cuenta('variante')).toBe(4)
    expect(cuenta('estacion')).toBe(2)
    expect(cuenta('usuario')).toBe(PERSONAL.length + 1)
    expect(r.pines.map((p) => p.nombre)).toEqual(PERSONAL.map((p) => p.nombre))
    for (const { id } of h.filas('SELECT id FROM producto'))
      expect(esIdValido(String(id))).toBe(true)

    expect(h.filas('SELECT nombre FROM restaurante')).toEqual([{ nombre: 'La Spritzzería' }])
    expect(h.filas('SELECT tipo, tarifa FROM impuesto')).toEqual([{ tipo: 'inc', tarifa: 800 }])
    // Cada producto con su impuesto y su categoría, cada categoría con su estación.
    expect(
      h.filas(
        `SELECT count(*) AS n FROM producto p JOIN categoria c ON c.id = p.categoria_id
         JOIN estacion e ON e.id = c.estacion_id JOIN impuesto i ON i.id = p.impuesto_id`,
      ),
    ).toEqual([{ n: 98 }])
  })

  it('una segunda corrida no cambia nada: ni registros, ni versiones, ni PIN', () => {
    const h = hub()
    h.cargar()
    const antes = h.filas('SELECT id, version FROM producto ORDER BY id')
    const pinesAntes = h.filas('SELECT usuario_id, pin_huella FROM usuario_credencial ORDER BY 1')
    const r = h.cargar(TEXTO_CARTA, '2026-10-25T10:00:00.000Z')

    for (const [tabla, c] of Object.entries(r.tablas)) {
      expect({ tabla, creado: c.creado, actualizado: c.actualizado }).toEqual({
        tabla,
        creado: 0,
        actualizado: 0,
      })
    }
    expect(r.pines).toEqual([])
    expect(h.filas('SELECT id, version FROM producto ORDER BY id')).toEqual(antes)
    expect(h.filas('SELECT usuario_id, pin_huella FROM usuario_credencial ORDER BY 1')).toEqual(
      pinesAntes,
    )
  })

  it('si la carta cambia un precio, solo ese producto se actualiza y sube de versión', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const antes = h.db.prepare('SELECT precio, version FROM producto WHERE id = ?').get(id)
    const r = h.cargar(TEXTO_CARTA.replace('precio: 44900', 'precio: 46900'))

    const despues = h.db.prepare('SELECT precio, version FROM producto WHERE id = ?').get(id)
    expect(antes?.precio).toBe(44_900)
    expect(despues?.precio).toBe(46_900)
    expect(Number(despues?.version)).toBeGreaterThan(Number(antes?.version))
    expect(r.tablas.producto).toMatchObject({ actualizado: 1 })
  })

  it('respeta la configuración que el restaurante ya cambió', () => {
    const h = hub()
    h.db.prepare('UPDATE restaurante SET config = \'{"redondeo_efectivo":50}\'').run()
    h.cargar()
    const config = JSON.parse(String(h.db.prepare('SELECT config FROM restaurante').get()?.config))
    expect(config).toMatchObject({ redondeo_efectivo: 50, propina_sugerida: 1000 })
  })

  it('los IDs son los mismos en dos hubs con el mismo restaurante', () => {
    const a = idEstable('01JB0000000000000000000000', 'mesa:1')
    expect(a).toBe(idEstable('01JB0000000000000000000000', 'mesa:1'))
    expect(a).not.toBe(idEstable('01JB0000000000000000000000', 'mesa:2'))
    expect(a.slice(0, 10)).toBe('01JB000000')
    expect(esIdValido(a)).toBe(true)
  })
})
