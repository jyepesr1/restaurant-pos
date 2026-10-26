import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
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

async function montar(occupiedIds: string[] = []) {
  const m = montarAcceso()
  sembrar(
    m.db,
    m.access,
    { restauranteId: m.restauranteId, roles: m.roles, menu: CARTA, sinPersonal: true },
    m.clock(),
  )
  const app = crearServidor({
    access: m.access,
    catalog: {
      db: m.db,
      restauranteId: m.restauranteId,
      access: m.access,
      clock: m.clock,
      mesaOcupada: (id) => occupiedIds.includes(id),
    },
  })
  await app.ready()
  const register = m.emparejar('register')
  const s = m.entrar(register.connection, 'manager')
  const editar = async (changes: unknown[]) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${register.token}` },
      payload: { session_id: s.sesionId, secret: s.secret, changes },
    })
    return { code: r.statusCode, cuerpo: r.json() }
  }
  const catalog = () => leerCatalogo(m.db, m.restauranteId)
  return { ...m, editar, catalog }
}

const table = (zonaId: string, name: string, fields: Record<string, unknown> = {}) => ({
  entity: 'dining_tables',
  id: newId(),
  data: {
    zone_id: zonaId,
    name,
    shape: 'round',
    x: 0,
    y: 0,
    width: 90,
    height: 90,
    rotation: 0,
    capacity: 2,
    active: true,
    ...fields,
  },
})

describe('plano', () => {
  it('crea una zona con sus mesas y una pared en un solo guardado; la sede la pone el hub', async () => {
    const m = await montar()
    const zone = newId()
    const r = await m.editar([
      { entity: 'zones', id: zone, data: { name: 'Terraza', position: 1, level: 1, active: true } },
      table(zone, 'T1', { x: 100, rotation: 45 }),
      table(zone, 'T2', { shape: 'rectangular', width: 160 }),
      {
        entity: 'floor_plan_elements',
        id: newId(),
        data: {
          zone_id: zone,
          type: 'wall',
          text: null,
          x: 0,
          y: 300,
          width: 500,
          height: 20,
          rotation: 0,
          active: true,
        },
      },
    ])
    expect(r.code).toBe(200)
    const c = m.catalog()
    expect(c.zones.map((z) => z.name)).toEqual(['Salón', 'Terraza'])
    expect(
      c.tables
        .filter((x) => x.zonaId === zone)
        .map((x) => [x.name, x.rotation])
        .sort(),
    ).toEqual([
      ['T1', 45],
      ['T2', 0],
    ])
    expect(c.elements).toEqual([
      expect.objectContaining({ zonaId: zone, type: 'wall', width: 500 }),
    ])
  })

  it('dos mesas activas no se llaman igual, aunque estén en zonas distintas', async () => {
    const m = await montar()
    const diningRoom = m.catalog().zones[0]?.id as string
    const r = await m.editar([table(diningRoom, '1')])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/dos mesas que se llaman «1»/)
    // Archivar la vieja y crear otra con su nombre, sí.
    const vieja = m.catalog().tables.find((x) => x.name === '1')
    const r2 = await m.editar([
      { entity: 'dining_tables', id: vieja?.id, data: { active: false } },
      table(diningRoom, '1'),
    ])
    expect(r2.code).toBe(200)
  })

  it('no se archiva una mesa con un pedido abierto, ni una zona con mesas activas', async () => {
    const occupiedIds: string[] = []
    const m = await montar(occupiedIds)
    const ocupada = m.catalog().tables[0]?.id as string
    occupiedIds.push(ocupada)
    const r = await m.editar([{ entity: 'dining_tables', id: ocupada, data: { active: false } }])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/tiene un pedido abierto/)
    const diningRoom = m.catalog().zones[0]?.id as string
    const r2 = await m.editar([{ entity: 'zones', id: diningRoom, data: { active: false } }])
    expect(r2.cuerpo.message).toMatch(/lo usan 25 mesas/)
  })

  it('archivar la zona junto con sus mesas la saca, con sus mesas y elementos, de la carta de los equipos', async () => {
    const m = await montar()
    const c = m.catalog()
    const diningRoom = c.zones[0]?.id as string
    const r = await m.editar([
      ...c.tables.map((x) => ({ entity: 'dining_tables', id: x.id, data: { active: false } })),
      { entity: 'zones', id: diningRoom, data: { active: false } },
    ])
    expect(r.code).toBe(200)
    expect(m.catalog()).toMatchObject({ zones: [], tables: [], elements: [] })
  })

  it('rechaza geometría fuera de rango o con decimales, y formas o tipos desconocidos', async () => {
    const m = await montar()
    const diningRoom = m.catalog().zones[0]?.id as string
    for (const fields of [
      { x: 0.5 },
      { width: 2 },
      { rotation: 360 },
      { shape: 'triangular' },
      { capacity: 0 },
    ])
      expect((await m.editar([table(diningRoom, 'X', fields)])).code).toBe(400)
  })

  it('el catálogo entrega el personal activo con nombre y nada más', async () => {
    const m = await montar()
    const staff = m.catalog().staff
    expect(staff.length).toBeGreaterThan(0)
    for (const p of staff) expect(Object.keys(p).sort()).toEqual(['id', 'name'])
  })
})
