import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nuevoId } from '@pos/core'
import type { BaseSqlite } from '@pos/db'
import { afterEach, describe, expect, it } from 'vitest'
import { ABRIR, hubEnCarpeta, montarHub } from '../acceso/montaje-hub'
import { leerCarta } from './carta'
import { sembrar } from './sembrar'

// El pedido usa lo que sembró la tarea 0.8: cada ítem copia producto, precio, impuesto y
// modificadores del catálogo y viaja por el hub de sincronización con su `catalogo_version`.

const TEXTO_CARTA = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const AHORA = '2026-10-24T20:00:00.000Z'

const una = (db: BaseSqlite, sql: string, ...p: string[]) => {
  const fila = db.prepare(sql).get(...p)
  if (!fila) throw new Error(`Sin resultado: ${sql}`)
  return fila
}
const versionCatalogo = (db: BaseSqlite) =>
  Number(una(db, "SELECT valor FROM contador WHERE nombre = 'catalogo'").valor)

/** El ítem que armaría la app al tocar ese producto: todo copiado de la base sembrada. */
function itemDelCatalogo(
  db: BaseSqlite,
  producto: string,
  opciones: { variante?: string; modificadores?: string[] } = {},
) {
  const p = una(
    db,
    `SELECT p.id, p.nombre, p.precio, i.tipo, i.tarifa FROM producto p
     JOIN impuesto i ON i.id = p.impuesto_id WHERE p.nombre = ? AND p.activo = 1`,
    producto,
  )
  const v = opciones.variante
    ? una(
        db,
        'SELECT id, precio FROM variante WHERE producto_id = ? AND nombre = ?',
        String(p.id),
        opciones.variante,
      )
    : null
  const modificadores = (opciones.modificadores ?? []).map((nombre) => {
    const m = una(
      db,
      `SELECT m.id, m.nombre, m.precio_extra FROM modificador m
       JOIN producto_grupo_modificador pg ON pg.grupo_id = m.grupo_id
       WHERE pg.producto_id = ? AND m.nombre = ?`,
      String(p.id),
      nombre,
    )
    return {
      modificador_id: String(m.id),
      nombre: String(m.nombre),
      precio_extra: Number(m.precio_extra),
    }
  })
  return {
    item_id: nuevoId(),
    producto_id: String(p.id),
    variante_id: v ? String(v.id) : null,
    nombre: opciones.variante ? `${producto} (${opciones.variante})` : producto,
    precio_unitario: Number(v ? v.precio : p.precio),
    impuesto_tipo: String(p.tipo) as 'inc',
    tarifa: Number(p.tarifa),
    cantidad: 1,
    comensal: null,
    curso: null,
    modificadores,
    notas: null,
    catalogo_version: versionCatalogo(db),
    precio_canal_id: null,
  }
}

function hubSembrado() {
  const m = montarHub()
  const r = sembrar(
    m.db,
    m.acceso,
    { restauranteId: m.restauranteId, roles: m.roles, carta: leerCarta(TEXTO_CARTA) },
    AHORA,
  )
  const pinMesero = r.pines.find((p) => p.nombre === 'Mesero 1')?.pin as string
  const { conexion } = m.emparejar('mesero')
  const sesion = m.acceso.iniciarSesion(conexion, pinMesero)
  if (!sesion.ok) throw new Error(sesion.mensaje)
  return { m, conexion, sesion, r }
}

describe('el pedido usa lo sembrado', () => {
  it('el mesero del seed entra con su PIN y agrega vino por botella, un plato sin opciones y un sabor', () => {
    const { m, conexion, sesion } = hubSembrado()
    const pedido = nuevoId()
    const botella = itemDelCatalogo(m.db, 'Ramón Bilbao Crianza', { variante: 'Botella' })
    const copa = itemDelCatalogo(m.db, 'Ramón Bilbao Crianza', { variante: 'Copa' })
    const pizza = itemDelCatalogo(m.db, 'Quattro Formaggi')
    const te = itemDelCatalogo(m.db, 'Té Hatsu', { modificadores: ['Rojo'] })
    expect([botella.precio_unitario, copa.precio_unitario, pizza.precio_unitario]).toEqual([
      129_900, 30_900, 44_900,
    ])
    expect(te.modificadores).toHaveLength(1)

    const en = { agregado_id: pedido }
    const r = m.hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, en),
      ...[botella, copa, pizza, te].map((it, i) =>
        m.evento(conexion, sesion, 'ItemAgregado', it, { ...en, secuencia_base: i + 1 }),
      ),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(Array(5).fill('confirmado'))

    const items = m.hub.pedido(pedido)?.items ?? {}
    expect(items[botella.item_id]).toMatchObject({
      varianteId: botella.variante_id,
      precioUnitario: 129_900,
      impuestoTipo: 'inc',
      tarifa: 800,
    })
    expect(items[pizza.item_id]).toMatchObject({
      productoId: pizza.producto_id,
      precioUnitario: 44_900,
    })
    expect(items[te.item_id]?.modificadores).toEqual([
      expect.objectContaining({ nombre: 'Rojo', precioExtra: 0 }),
    ])
  })

  it('un plato con término lleva el término elegido como modificador sin costo', () => {
    const { m, conexion, sesion } = hubSembrado()
    const pedido = nuevoId()
    const burger = itemDelCatalogo(m.db, 'Spritz Burguer', { modificadores: ['Tres cuartos'] })
    const r = m.hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, { agregado_id: pedido }),
      m.evento(conexion, sesion, 'ItemAgregado', burger, {
        agregado_id: pedido,
        secuencia_base: 1,
      }),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado'])
    expect(m.hub.pedido(pedido)?.items[burger.item_id]?.modificadores[0]).toMatchObject({
      nombre: 'Tres cuartos',
      precioExtra: 0,
    })
  })

  it('el evento guardado conserva el `catalogo_version` con que se agregó, y una carta nueva no lo cambia', () => {
    const { m, conexion, sesion } = hubSembrado()
    const pedido = nuevoId()
    const antes = itemDelCatalogo(m.db, 'Quattro Formaggi')
    m.hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, { agregado_id: pedido }),
      m.evento(conexion, sesion, 'ItemAgregado', antes, { agregado_id: pedido, secuencia_base: 1 }),
    ])

    // El restaurante sube el precio: el seed corre otra vez y el contador avanza.
    sembrar(
      m.db,
      m.acceso,
      {
        restauranteId: m.restauranteId,
        roles: m.roles,
        carta: leerCarta(TEXTO_CARTA.replace('precio: 44900', 'precio: 46900')),
      },
      '2026-10-25T09:00:00.000Z',
    )
    const despues = itemDelCatalogo(m.db, 'Quattro Formaggi')
    expect(despues.catalogo_version).toBeGreaterThan(antes.catalogo_version)
    expect(despues.precio_unitario).toBe(46_900)
    expect(despues.producto_id).toBe(antes.producto_id)

    const r = m.hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'ItemAgregado', despues, {
        agregado_id: pedido,
        secuencia_base: 2,
      }),
    ])
    expect(r.resultados[0]?.estado).toBe('confirmado')

    const guardados = m.db
      .prepare("SELECT datos FROM evento WHERE tipo = 'ItemAgregado' ORDER BY secuencia")
      .all()
      .map((f) => JSON.parse(String(f.datos)))
    expect(guardados.map((d) => [d.catalogo_version, d.precio_unitario])).toEqual([
      [antes.catalogo_version, 44_900],
      [despues.catalogo_version, 46_900],
    ])
    // El ítem viejo conserva su precio: lo cobrado es lo que vio el cliente al pedir.
    expect(m.hub.pedido(pedido)?.items[antes.item_id]?.precioUnitario).toBe(44_900)
  })

  it('un ítem con precio de variante distinto al de otra variante no se mezcla: cada una lleva su ID', () => {
    const { m } = hubSembrado()
    const botella = itemDelCatalogo(m.db, 'Ramón Bilbao Verdejo', { variante: 'Botella' })
    const copa = itemDelCatalogo(m.db, 'Ramón Bilbao Verdejo', { variante: 'Copa' })
    expect(botella.producto_id).toBe(copa.producto_id)
    expect(botella.variante_id).not.toBe(copa.variante_id)
    expect(botella.precio_unitario).toBeGreaterThan(copa.precio_unitario)
  })
})

describe('el hub arranca después del seed', () => {
  let carpeta = ''
  afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

  it('reabrir la carpeta de datos deja todo intacto: mismo restaurante, mismos PIN y un seed sin cambios', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-seed-hub-'))
    const hubs = hubEnCarpeta(join(carpeta, 'datos'))
    try {
      const a = hubs.levantar()
      const r = sembrar(
        a.db,
        a.acceso,
        { restauranteId: a.restauranteId, roles: a.roles, carta: leerCarta(TEXTO_CARTA) },
        hubs.reloj(),
      )
      const codigo = a.acceso.crearEmparejamiento(
        { pin: a.admin.pin as string, nombre: 'Celular', tipo: 'mesero' },
        null,
      )
      if (!codigo.ok) throw new Error(codigo.mensaje)
      const emparejado = a.acceso.emparejar(codigo.codigo, '10.0.0.9')
      if (!emparejado.ok) throw new Error(emparejado.mensaje)
      const token = emparejado.token
      const productos = una(a.db, 'SELECT count(*) AS n FROM producto').n
      const versiones = versionCatalogo(a.db)
      hubs.apagar()
      hubs.avanzar(60_000)

      const b = hubs.levantar()
      expect(b.restauranteId).toBe(a.restauranteId)
      expect(b.admin).toEqual({ pin: null, avisos: [] })
      expect(b.claveNueva).toBe(false)
      expect(una(b.db, 'SELECT count(*) AS n FROM producto').n).toBe(productos)
      expect(una(b.db, 'SELECT count(*) AS n FROM usuario WHERE activo = 1').n).toBe(8)
      expect(una(b.db, 'SELECT nombre FROM restaurante').nombre).toBe('La Spritzzería')
      expect(versionCatalogo(b.db)).toBe(versiones)

      // El equipo emparejado y el PIN de un mesero del seed siguen valiendo con el hub reiniciado.
      const conexion = b.acceso.autenticar(token)
      expect(conexion).not.toBeNull()
      const mesero = r.pines.find((p) => p.nombre === 'Mesero 2')?.pin as string
      expect(
        b.acceso.iniciarSesion(conexion as NonNullable<typeof conexion>, mesero),
      ).toMatchObject({
        ok: true,
      })

      // Y un seed nuevo no cambia nada.
      const otra = sembrar(
        b.db,
        b.acceso,
        { restauranteId: b.restauranteId, roles: b.roles, carta: leerCarta(TEXTO_CARTA) },
        hubs.reloj(),
      )
      for (const [tabla, cambios] of Object.entries(otra.tablas))
        expect({ tabla, creado: cambios.creado, actualizado: cambios.actualizado }).toEqual({
          tabla,
          creado: 0,
          actualizado: 0,
        })
      expect(otra.pines).toEqual([])
      expect(versionCatalogo(b.db)).toBe(versiones)
    } finally {
      hubs.apagar()
    }
  })
})
