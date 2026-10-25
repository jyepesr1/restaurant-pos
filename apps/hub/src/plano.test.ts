import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { leerCatalogo } from './catalogo'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Edición del plano del salón (tarea 1.2): zonas, mesas y elementos, con sus reglas.

const CARTA = leerCarta(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

async function montar(ocupadas: string[] = []) {
  const m = montarAcceso()
  sembrar(
    m.db,
    m.acceso,
    { restauranteId: m.restauranteId, roles: m.roles, carta: CARTA, sinPersonal: true },
    m.reloj(),
  )
  const app = crearServidor({
    acceso: m.acceso,
    catalogo: {
      db: m.db,
      restauranteId: m.restauranteId,
      acceso: m.acceso,
      reloj: m.reloj,
      mesaOcupada: (id) => ocupadas.includes(id),
    },
  })
  await app.ready()
  const caja = m.emparejar('caja')
  const s = m.entrar(caja.conexion, 'gerente')
  const editar = async (cambios: unknown[]) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalogo/cambios',
      headers: { authorization: `Bearer ${caja.token}` },
      payload: { sesion_id: s.sesionId, secreto: s.secreto, cambios },
    })
    return { codigo: r.statusCode, cuerpo: r.json() }
  }
  const catalogo = () => leerCatalogo(m.db, m.restauranteId)
  return { ...m, editar, catalogo }
}

const mesa = (zonaId: string, nombre: string, campos: Record<string, unknown> = {}) => ({
  entidad: 'mesa',
  id: nuevoId(),
  datos: {
    zona_id: zonaId,
    nombre,
    forma: 'redonda',
    x: 0,
    y: 0,
    ancho: 90,
    alto: 90,
    rotacion: 0,
    capacidad: 2,
    activo: true,
    ...campos,
  },
})

describe('plano', () => {
  it('crea una zona con sus mesas y una pared en un solo guardado; la sede la pone el hub', async () => {
    const m = await montar()
    const zona = nuevoId()
    const r = await m.editar([
      { entidad: 'zona', id: zona, datos: { nombre: 'Terraza', orden: 1, piso: 1, activo: true } },
      mesa(zona, 'T1', { x: 100, rotacion: 45 }),
      mesa(zona, 'T2', { forma: 'rectangular', ancho: 160 }),
      {
        entidad: 'elemento_plano',
        id: nuevoId(),
        datos: {
          zona_id: zona,
          tipo: 'pared',
          texto: null,
          x: 0,
          y: 300,
          ancho: 500,
          alto: 20,
          rotacion: 0,
          activo: true,
        },
      },
    ])
    expect(r.codigo).toBe(200)
    const c = m.catalogo()
    expect(c.zonas.map((z) => z.nombre)).toEqual(['Salón', 'Terraza'])
    expect(
      c.mesas
        .filter((x) => x.zonaId === zona)
        .map((x) => [x.nombre, x.rotacion])
        .sort(),
    ).toEqual([
      ['T1', 45],
      ['T2', 0],
    ])
    expect(c.elementos).toEqual([
      expect.objectContaining({ zonaId: zona, tipo: 'pared', ancho: 500 }),
    ])
  })

  it('dos mesas activas no se llaman igual, aunque estén en zonas distintas', async () => {
    const m = await montar()
    const salon = m.catalogo().zonas[0]?.id as string
    const r = await m.editar([mesa(salon, '1')])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/dos mesas que se llaman «1»/)
    // Archivar la vieja y crear otra con su nombre, sí.
    const vieja = m.catalogo().mesas.find((x) => x.nombre === '1')
    const r2 = await m.editar([
      { entidad: 'mesa', id: vieja?.id, datos: { activo: false } },
      mesa(salon, '1'),
    ])
    expect(r2.codigo).toBe(200)
  })

  it('no se archiva una mesa con un pedido abierto, ni una zona con mesas activas', async () => {
    const ocupadas: string[] = []
    const m = await montar(ocupadas)
    const ocupada = m.catalogo().mesas[0]?.id as string
    ocupadas.push(ocupada)
    const r = await m.editar([{ entidad: 'mesa', id: ocupada, datos: { activo: false } }])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/tiene un pedido abierto/)
    const salon = m.catalogo().zonas[0]?.id as string
    const r2 = await m.editar([{ entidad: 'zona', id: salon, datos: { activo: false } }])
    expect(r2.cuerpo.mensaje).toMatch(/lo usan 25 mesas/)
  })

  it('archivar la zona junto con sus mesas la saca, con sus mesas y elementos, de la carta de los equipos', async () => {
    const m = await montar()
    const c = m.catalogo()
    const salon = c.zonas[0]?.id as string
    const r = await m.editar([
      ...c.mesas.map((x) => ({ entidad: 'mesa', id: x.id, datos: { activo: false } })),
      { entidad: 'zona', id: salon, datos: { activo: false } },
    ])
    expect(r.codigo).toBe(200)
    expect(m.catalogo()).toMatchObject({ zonas: [], mesas: [], elementos: [] })
  })

  it('rechaza geometría fuera de rango o con decimales, y formas o tipos desconocidos', async () => {
    const m = await montar()
    const salon = m.catalogo().zonas[0]?.id as string
    for (const campos of [
      { x: 0.5 },
      { ancho: 2 },
      { rotacion: 360 },
      { forma: 'triangular' },
      { capacidad: 0 },
    ])
      expect((await m.editar([mesa(salon, 'X', campos)])).codigo).toBe(400)
  })

  it('el catálogo entrega el personal activo con nombre y nada más', async () => {
    const m = await montar()
    const personal = m.catalogo().personal
    expect(personal.length).toBeGreaterThan(0)
    for (const p of personal) expect(Object.keys(p).sort()).toEqual(['id', 'nombre'])
  })
})
