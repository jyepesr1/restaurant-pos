import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { insertarVersionado } from './acceso/registros'
import { leerCatalogo } from './catalogo'
import { HistorialCatalogo } from './precios'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Edición del catálogo desde la caja: permisos, todo o nada, historial y aviso a los equipos.

const CARTA = leerCarta(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

async function montar() {
  const m = montarAcceso()
  sembrar(
    m.db,
    m.acceso,
    { restauranteId: m.restauranteId, roles: m.roles, carta: CARTA, sinPersonal: true },
    m.reloj(),
  )
  const avisos: number[] = []
  const app = crearServidor({
    acceso: m.acceso,
    catalogo: {
      db: m.db,
      restauranteId: m.restauranteId,
      acceso: m.acceso,
      alCambiar: (v) => avisos.push(v),
      reloj: m.reloj,
    },
  })
  await app.ready()
  const caja = m.emparejar('caja')
  const sesionDe = (quien: keyof typeof m.personas) => {
    const s = m.entrar(caja.conexion, quien)
    return { sesion_id: s.sesionId, secreto: s.secreto }
  }
  const editar = async (sesion: { sesion_id: string; secreto: string }, cambios: unknown[]) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalogo/cambios',
      headers: { authorization: `Bearer ${caja.token}` },
      payload: { ...sesion, cambios },
    })
    return { codigo: r.statusCode, cuerpo: r.json() }
  }
  const catalogo = () => leerCatalogo(m.db, m.restauranteId)
  const productos = () => catalogo().categorias.flatMap((c) => c.productos)
  const impuestoId = String(m.db.prepare('SELECT id FROM impuesto LIMIT 1').get()?.id)
  const categoriaId = catalogo().categorias[0]?.id as string
  return { ...m, app, avisos, caja, sesionDe, editar, catalogo, productos, impuestoId, categoriaId }
}

describe('POST /api/catalogo/cambios', () => {
  it('el gerente crea un producto con copa y botella y un grupo de opciones, en un solo paso', async () => {
    const m = await montar()
    const antes = m.catalogo().version
    const producto = nuevoId()
    const grupo = nuevoId()
    const r = await m.editar(m.sesionDe('gerente'), [
      {
        entidad: 'producto',
        id: producto,
        datos: {
          categoria_id: m.categoriaId,
          nombre: 'Prosecco de la casa',
          descripcion: null,
          precio: 18_000,
          impuesto_id: m.impuestoId,
          favorito: false,
          activo: true,
        },
      },
      {
        entidad: 'variante',
        id: nuevoId(),
        datos: { producto_id: producto, nombre: 'Copa', precio: 18_000, orden: 0, activo: true },
      },
      {
        entidad: 'variante',
        id: nuevoId(),
        datos: { producto_id: producto, nombre: 'Botella', precio: 95_000, orden: 1, activo: true },
      },
      {
        entidad: 'grupo_modificador',
        id: grupo,
        datos: { nombre: 'Hielo', minimo: 0, maximo: 1, activo: true },
      },
      {
        entidad: 'modificador',
        id: nuevoId(),
        datos: { grupo_id: grupo, nombre: 'Con hielo', precio_extra: 0, orden: 0, activo: true },
      },
      {
        entidad: 'producto_grupo_modificador',
        id: nuevoId(),
        datos: { producto_id: producto, grupo_id: grupo, orden: 0, activo: true },
      },
    ])
    expect(r.codigo).toBe(200)
    expect(r.cuerpo.version).toBeGreaterThan(antes)
    expect(m.avisos).toEqual([r.cuerpo.version])
    const nuevo = m.productos().find((p) => p.id === producto)
    expect(nuevo?.variantes.map((v) => [v.nombre, v.precio])).toEqual([
      ['Copa', 18_000],
      ['Botella', 95_000],
    ])
    expect(nuevo?.grupos.map((g) => g.nombre)).toEqual(['Hielo'])
    // Quedó en el historial con quién lo hizo.
    const cambio = m.db
      .prepare('SELECT usuario_id, antes FROM catalogo_cambio WHERE registro_id = ?')
      .get(producto)
    expect(cambio).toEqual({ usuario_id: m.personas.gerente.usuarioId, antes: null })
  })

  it('cambiar un precio sube la versión y el historial guarda el de antes', async () => {
    const m = await montar()
    const burrata = m.productos().find((p) => p.nombre === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    const antes = m.catalogo().version
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrata.id, datos: { precio: burrata.precio + 1_000 } },
    ])
    expect(r.codigo).toBe(200)
    const historial = new HistorialCatalogo(m.db, m.restauranteId)
    expect(historial.estadoEn('producto', burrata.id, antes)?.precio).toBe(burrata.precio)
    expect(historial.estadoEn('producto', burrata.id, r.cuerpo.version)?.precio).toBe(
      burrata.precio + 1_000,
    )
  })

  it('archivar saca de la carta de los equipos, pero el editor lo sigue viendo', async () => {
    const m = await montar()
    const burrata = m.productos().find((p) => p.nombre === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    expect(
      (
        await m.editar(m.sesionDe('gerente'), [
          { entidad: 'producto', id: burrata.id, datos: { activo: false } },
        ])
      ).codigo,
    ).toBe(200)
    expect(m.productos().some((p) => p.id === burrata.id)).toBe(false)
    const edicion = await m.app.inject({
      method: 'GET',
      url: '/api/catalogo/edicion',
      headers: { authorization: `Bearer ${m.caja.token}` },
    })
    const archivado = edicion.json().productos.find((p: { id: string }) => p.id === burrata.id)
    expect(archivado).toMatchObject({ activo: false, precio: burrata.precio })
  })

  it('todo o nada: un cambio inválido no deja aplicado ninguno', async () => {
    const m = await montar()
    const burrata = m.productos().find((p) => p.nombre === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    const antes = m.catalogo().version
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrata.id, datos: { precio: 1 } },
      {
        entidad: 'grupo_modificador',
        id: nuevoId(),
        datos: { nombre: 'Malo', minimo: 3, maximo: 1, activo: true },
      },
    ])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/Cambio 2/)
    expect(m.catalogo().version).toBe(antes)
    expect(m.productos().find((p) => p.id === burrata.id)?.precio).toBe(burrata.precio)
    expect(m.avisos).toEqual([])
  })

  it.each([
    ['precio con decimales', { precio: 1000.5 }],
    ['precio negativo', { precio: -1 }],
    ['campo desconocido', { costo: 5 }],
    ['categoría que no existe', { categoria_id: nuevoId() }],
    ['nada que cambiar', {}],
  ])('rechaza %s', async (_caso, datos) => {
    const m = await montar()
    const burrata = m.productos().find((p) => p.nombre === 'Burrata Spritz')
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrata?.id, datos },
    ])
    expect(r.codigo).toBe(400)
  })

  it('un producto nuevo pide todos sus campos; un exento no lleva tarifa', async () => {
    const m = await montar()
    expect(
      (
        await m.editar(m.sesionDe('gerente'), [
          { entidad: 'producto', id: nuevoId(), datos: { nombre: 'Sin precio' } },
        ])
      ).codigo,
    ).toBe(400)
    expect(
      (
        await m.editar(m.sesionDe('gerente'), [
          {
            entidad: 'impuesto',
            id: nuevoId(),
            datos: { nombre: 'Exento', tipo: 'exento', tarifa: 800, activo: true },
          },
        ])
      ).codigo,
    ).toBe(400)
  })

  it('el mesero y el cajero no editan; sin sesión válida, 401', async () => {
    const m = await montar()
    const burrata = m.productos().find((p) => p.nombre === 'Burrata Spritz')
    const cambio = [{ entidad: 'producto', id: burrata?.id, datos: { precio: 1_000 } }]
    expect((await m.editar(m.sesionDe('mesero'), cambio)).codigo).toBe(403)
    expect((await m.editar(m.sesionDe('cajero'), cambio)).codigo).toBe(403)
    const sesion = m.sesionDe('gerente')
    expect((await m.editar({ ...sesion, secreto: 'x' }, cambio)).codigo).toBe(401)
    const sinToken = await m.app.inject({
      method: 'POST',
      url: '/api/catalogo/cambios',
      payload: { ...sesion, cambios: cambio },
    })
    expect(sinToken.statusCode).toBe(401)
  })

  it('con solo `editar_precios` se cambian precios, nada más', async () => {
    const m = await montar()
    insertarVersionado(
      m.db,
      'rol_permiso',
      m.restauranteId,
      { rol_id: m.roles.cajero, permiso: 'editar_precios' },
      { usuarioId: null, dispositivoId: null },
      m.reloj(),
    )
    const burrata = m.productos().find((p) => p.nombre === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    const sesion = m.sesionDe('cajero')
    expect(
      (await m.editar(sesion, [{ entidad: 'producto', id: burrata.id, datos: { precio: 50_000 } }]))
        .codigo,
    ).toBe(200)
    expect(
      (await m.editar(sesion, [{ entidad: 'producto', id: burrata.id, datos: { nombre: 'Otra' } }]))
        .codigo,
    ).toBe(403)
    // Crear un producto no es "solo precios", aunque traiga precio.
    expect(
      (await m.editar(sesion, [{ entidad: 'producto', id: nuevoId(), datos: { precio: 1 } }]))
        .codigo,
    ).toBe(403)
  })

  it('el seed no pisa lo que editó una persona', async () => {
    const m = await montar()
    const burrata = m.productos().find((p) => p.nombre === 'Burrata Spritz')
    if (!burrata) throw new Error('falta')
    await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrata.id, datos: { precio: 77_000 } },
    ])
    sembrar(
      m.db,
      m.acceso,
      { restauranteId: m.restauranteId, roles: m.roles, carta: CARTA, sinPersonal: true },
      m.reloj(),
    )
    expect(m.productos().find((p) => p.id === burrata.id)?.precio).toBe(77_000)
  })

  it('no deja apuntar a algo archivado ni archivar lo que está en uso', async () => {
    const m = await montar()
    const g = m.sesionDe('gerente')
    const categoria = m.catalogo().categorias[0]
    if (!categoria) throw new Error('falta')
    // Archivar una categoría con productos activos: no (desaparecerían de la carta).
    const r1 = await m.editar(g, [
      { entidad: 'categoria', id: categoria.id, datos: { activo: false } },
    ])
    expect(r1.codigo).toBe(400)
    expect(r1.cuerpo.mensaje).toMatch(/lo usan \d+ productos/)
    // Archivar el impuesto de todos: tampoco.
    const r2 = await m.editar(g, [
      { entidad: 'impuesto', id: m.impuestoId, datos: { activo: false } },
    ])
    expect(r2.codigo).toBe(400)
    // Sí, si en el mismo pedido se archivan antes sus productos.
    const r3 = await m.editar(g, [
      ...categoria.productos.map((p) => ({
        entidad: 'producto',
        id: p.id,
        datos: { activo: false },
      })),
      { entidad: 'categoria', id: categoria.id, datos: { activo: false } },
    ])
    expect(r3.codigo).toBe(200)
    // Un producto nuevo en esa categoría archivada: no.
    const r4 = await m.editar(g, [
      {
        entidad: 'producto',
        id: nuevoId(),
        datos: {
          categoria_id: categoria.id,
          nombre: 'Nuevo',
          descripcion: null,
          precio: 1_000,
          impuesto_id: m.impuestoId,
          favorito: false,
          activo: true,
        },
      },
    ])
    expect(r4.codigo).toBe(400)
    expect(r4.cuerpo.mensaje).toMatch(/categoria está archivado/)
  })

  it('archivar un grupo lo quita de sus productos', async () => {
    const m = await montar()
    const tagliata = m.productos().find((p) => p.nombre === 'Tagliata di Manzo')
    const grupo = tagliata?.grupos[0]
    if (!grupo) throw new Error('falta')
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'grupo_modificador', id: grupo.id, datos: { activo: false } },
    ])
    expect(r.codigo).toBe(200)
    expect(m.productos().find((p) => p.nombre === 'Tagliata di Manzo')?.grupos).toEqual([])
  })

  it('repetir lo mismo no sube la versión ni avisa; un padre no se cambia; un id no cambia de tipo', async () => {
    const m = await montar()
    const g = m.sesionDe('gerente')
    const vino = m.productos().find((p) => p.nombre === 'Ramón Bilbao Crianza')
    const copa = vino?.variantes[0]
    const burrata = m.productos().find((p) => p.nombre === 'Burrata Spritz')
    if (!vino || !copa || !burrata) throw new Error('falta')
    const antes = m.catalogo().version
    const igual = await m.editar(g, [
      { entidad: 'producto', id: vino.id, datos: { precio: vino.precio } },
    ])
    expect(igual.cuerpo).toEqual({ version: antes, cambiados: 0 })
    expect(m.avisos).toEqual([])
    const mover = await m.editar(g, [
      { entidad: 'variante', id: copa.id, datos: { producto_id: burrata.id } },
    ])
    expect(mover.codigo).toBe(400)
    const disfrazado = await m.editar(g, [
      { entidad: 'estacion', id: copa.id, datos: { nombre: 'X', orden: 0, activo: true } },
    ])
    expect(disfrazado.codigo).toBe(400)
    expect(disfrazado.cuerpo.mensaje).toMatch(/otro tipo/)
  })

  it('las reglas de la base se dicen en palabras, sin el texto de SQLite', async () => {
    const m = await montar()
    const tagliata = m.productos().find((p) => p.nombre === 'Tagliata di Manzo')
    const grupo = tagliata?.grupos[0]
    if (!grupo) throw new Error('falta')
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'grupo_modificador', id: grupo.id, datos: { minimo: 3 } },
    ])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/máximo debe ser al menos 1 y no menor que el mínimo/)
    expect(r.cuerpo.mensaje).not.toMatch(/constraint/i)
  })
})
