import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { leerCatalogo } from './catalogo'
import { catalogoParaEditar } from './edicion-catalogo'
import { CARTA } from './pruebas-catalogo'
import { seed } from './seed/sembrar'
import { crearServidor } from './servidor'

// Reglas del plano (tarea 1.2) más allá del camino feliz: cambiar de zona, reactivar, nombres que
// casi se repiten, lotes grandes y qué pasa con el seed después de que alguien dibuja el salón.

// El tipo que devuelve `catalogoParaEditar` pierde las columnas al desestructurar: aquí se declara.
type Row = { id: string; name: string; version: number; active: boolean; zone_id: string }
type Edicion = { version: number; zones: Row[]; tables: Row[]; elements: Row[] }

async function setup() {
  const m = montarAcceso()
  const sembrarSalon = () =>
    seed(
      m.db,
      m.access,
      { restaurantId: m.restaurantId, roles: m.roles, menu: CARTA, sinPersonal: true },
      m.clock(),
    )
  sembrarSalon()
  const alerts: number[] = []
  const app = crearServidor({
    access: m.access,
    catalog: {
      db: m.db,
      restaurantId: m.restaurantId,
      access: m.access,
      clock: m.clock,
      onChange: (v) => alerts.push(v),
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
  const catalog = () => leerCatalogo(m.db, m.restaurantId)
  const edicion = () => catalogoParaEditar(m.db, m.restaurantId) as unknown as Edicion
  const diningRoom = () => catalog().zones[0]?.id as string
  return { ...m, app, editar, catalog, edicion, diningRoom, alerts, sembrarSalon }
}

const GEO = { x: 0, y: 0, width: 90, height: 90, rotation: 0 }
const table = (zoneId: string, name: string, fields: Record<string, unknown> = {}) => ({
  entity: 'dining_tables',
  id: newId(),
  data: {
    zone_id: zoneId,
    name,
    shape: 'round',
    capacity: 2,
    active: true,
    ...GEO,
    ...fields,
  },
})
const zone = (name: string, fields: Record<string, unknown> = {}) => ({
  entity: 'zones',
  id: newId(),
  data: { name, position: 1, level: 1, active: true, ...fields },
})
const element = (zoneId: string, fields: Record<string, unknown> = {}) => ({
  entity: 'floor_plan_elements',
  id: newId(),
  data: { zone_id: zoneId, type: 'wall', text: null, ...GEO, active: true, ...fields },
})

describe('mover una mesa o un elemento a otra zona', () => {
  it('la mesa pasa a la otra zona con su nombre y geometría, y cada zona la ve en su lado', async () => {
    const m = await setup()
    const terraza = zone('Terraza')
    expect((await m.editar([terraza])).code).toBe(200)
    const one = m.catalog().tables.find((x) => x.name === '1')
    expect(one).toBeDefined()
    const r = await m.editar([
      { entity: 'dining_tables', id: one?.id, data: { zone_id: terraza.id } },
    ])
    expect(r.code).toBe(200)
    const movida = m.catalog().tables.find((x) => x.id === one?.id)
    expect(movida).toMatchObject({ zoneId: terraza.id, name: '1', x: one?.x, y: one?.y })
    expect(m.catalog().tables.filter((x) => x.zoneId === m.diningRoom())).toHaveLength(24)
    expect(m.catalog().tables.filter((x) => x.zoneId === terraza.id)).toHaveLength(1)
  })

  it('moverla y cambiarle la geometría en un solo guardado también vale, y sube su versión', async () => {
    const m = await setup()
    const terraza = zone('Terraza')
    await m.editar([terraza])
    const before = m.edicion().tables.find((x) => x.name === '2')
    const r = await m.editar([
      {
        entity: 'dining_tables',
        id: before?.id,
        data: { zone_id: terraza.id, x: 500, rotation: 90 },
      },
    ])
    expect(r).toMatchObject({ code: 200, cuerpo: { cambiados: 1 } })
    const after = m.edicion().tables.find((x) => x.id === before?.id)
    expect(after).toMatchObject({ zone_id: terraza.id, x: 500, rotation: 90 })
    expect(Number(after?.version)).toBeGreaterThan(Number(before?.version))
  })

  it('no se puede mover a una zona archivada ni a una que no existe', async () => {
    const m = await setup()
    const vacia = zone('Vacía')
    await m.editar([vacia])
    await m.editar([{ entity: 'zones', id: vacia.id, data: { active: false } }])
    const one = m.catalog().tables[0]?.id
    const aArchivada = await m.editar([
      { entity: 'dining_tables', id: one, data: { zone_id: vacia.id } },
    ])
    expect(aArchivada.code).toBe(400)
    expect(aArchivada.cuerpo.message).toMatch(/zone está archivado/)
    const aNinguna = await m.editar([
      { entity: 'dining_tables', id: one, data: { zone_id: newId() } },
    ])
    expect(aNinguna.cuerpo.message).toMatch(/zone_id no existe/)
    // Nada se movió.
    expect(m.catalog().tables.find((x) => x.id === one)?.zoneId).toBe(m.diningRoom())
  })

  it('un mismo guardado puede vaciar la zona vieja: pasar sus mesas y archivarla', async () => {
    const m = await setup()
    const newOne = zone('Nueva', { position: 0 })
    const diningRoom = m.diningRoom()
    const r = await m.editar([
      newOne,
      ...m.catalog().tables.map((x) => ({
        entity: 'dining_tables',
        id: x.id,
        data: { zone_id: newOne.id },
      })),
      { entity: 'zones', id: diningRoom, data: { active: false } },
    ])
    expect(r.code).toBe(200)
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Nueva'])
    expect(m.catalog().tables).toHaveLength(25)
  })

  it('un elemento del plano también cambia de zona', async () => {
    const m = await setup()
    const a = zone('A')
    const wall = element(a.data.name === 'A' ? m.diningRoom() : '')
    await m.editar([a, wall])
    expect(
      (await m.editar([{ entity: 'floor_plan_elements', id: wall.id, data: { zone_id: a.id } }]))
        .code,
    ).toBe(200)
    expect(m.catalog().elements.find((e) => e.id === wall.id)?.zoneId).toBe(a.id)
  })
})

describe('reactivar lo archivado', () => {
  it('una zona archivada vuelve sola, vacía: sus mesas siguen archivadas hasta que se reactiven', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    const wall = element(t.id)
    await m.editar([t, t1, wall])
    await m.editar([
      { entity: 'dining_tables', id: t1.id, data: { active: false } },
      { entity: 'floor_plan_elements', id: wall.id, data: { active: false } },
      { entity: 'zones', id: t.id, data: { active: false } },
    ])
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Salón'])

    expect((await m.editar([{ entity: 'zones', id: t.id, data: { active: true } }])).code).toBe(200)
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Salón', 'Terraza'])
    expect(m.catalog().tables.filter((x) => x.zoneId === t.id)).toEqual([])
    expect(m.catalog().elements).toEqual([])

    // Reactivar mesa y elemento, ahora que la zona está activa.
    const r = await m.editar([
      { entity: 'dining_tables', id: t1.id, data: { active: true } },
      { entity: 'floor_plan_elements', id: wall.id, data: { active: true } },
    ])
    expect(r.code).toBe(200)
    expect(
      m
        .catalog()
        .tables.filter((x) => x.zoneId === t.id)
        .map((x) => x.name),
    ).toEqual(['T1'])
    expect(m.catalog().elements.map((e) => e.id)).toEqual([wall.id])
  })

  it('reactivar la zona y sus mesas en un solo guardado vale', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    await m.editar([t, t1])
    await m.editar([
      { entity: 'dining_tables', id: t1.id, data: { active: false } },
      { entity: 'zones', id: t.id, data: { active: false } },
    ])
    const r = await m.editar([
      { entity: 'dining_tables', id: t1.id, data: { active: true } },
      { entity: 'zones', id: t.id, data: { active: true } },
    ])
    expect(r.code).toBe(200)
    expect(m.catalog().tables.some((x) => x.id === t1.id)).toBe(true)
  })

  it('no se reactiva una mesa dentro de una zona que sigue archivada', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    await m.editar([t, t1])
    await m.editar([
      { entity: 'dining_tables', id: t1.id, data: { active: false } },
      { entity: 'zones', id: t.id, data: { active: false } },
    ])
    const r = await m.editar([{ entity: 'dining_tables', id: t1.id, data: { active: true } }])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/zone está archivado/)
  })

  it('no se reactiva una mesa cuyo nombre ya tomó otra mesa activa', async () => {
    const m = await setup()
    const s = m.diningRoom()
    const vieja = table(s, 'Barra 1')
    await m.editar([vieja])
    await m.editar([{ entity: 'dining_tables', id: vieja.id, data: { active: false } }])
    await m.editar([table(s, 'barra 1')])
    const r = await m.editar([{ entity: 'dining_tables', id: vieja.id, data: { active: true } }])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/dos mesas que se llaman/)
    expect(m.edicion().tables.find((x) => x.id === vieja.id)?.active).toBe(false)
  })

  it('reactivar algo que ya está activo no cambia nada ni avisa a los equipos', async () => {
    const m = await setup()
    const before = m.catalog().version
    const r = await m.editar([{ entity: 'zones', id: m.diningRoom(), data: { active: true } }])
    expect(r).toMatchObject({ code: 200, cuerpo: { cambiados: 0, version: before } })
    expect(m.alerts).toEqual([])
  })
})

describe('nombres de mesa que casi se repiten', () => {
  it.each([
    ['solo difiere en mayúsculas', 'T1', 't1'],
    ['solo difiere en mayúsculas (todas)', 'MESA A', 'mesa a'],
    ['con espacios al principio y al final', '70', '  70  '],
    ['con espacios y mayúsculas', 'Barra', ' BARRA '],
  ])('%s: se rechaza', async (_case, firstOne, secondOne) => {
    const m = await setup()
    const s = m.diningRoom()
    expect((await m.editar([table(s, firstOne)])).code).toBe(200)
    const r = await m.editar([table(s, secondOne)])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/dos mesas que se llaman/)
  })

  it('en el mismo guardado también se detecta, y no se aplica ninguna de las dos', async () => {
    const m = await setup()
    const before = m.catalog().tables.length
    const r = await m.editar([table(m.diningRoom(), 'X1'), table(m.diningRoom(), 'x1')])
    expect(r.code).toBe(400)
    expect(m.catalog().tables).toHaveLength(before)
  })

  it('cambiar los nombres entre dos mesas en un mismo guardado vale (se revisa al final)', async () => {
    const m = await setup()
    const [a, b] = m.catalog().tables
    const r = await m.editar([
      { entity: 'dining_tables', id: a?.id, data: { name: b?.name } },
      { entity: 'dining_tables', id: b?.id, data: { name: a?.name } },
    ])
    expect(r.code).toBe(200)
    const now = m.catalog().tables
    expect(now.find((x) => x.id === a?.id)?.name).toBe(b?.name)
    expect(now.find((x) => x.id === b?.id)?.name).toBe(a?.name)
  })

  it('renombrar una mesa con el nombre de otra se rechaza; con el de una archivada, no', async () => {
    const m = await setup()
    const [a, b] = m.catalog().tables
    const mayusculas = await m.editar([
      { entity: 'dining_tables', id: a?.id, data: { name: `${b?.name} ` } },
    ])
    expect(mayusculas.code).toBe(400)
    await m.editar([{ entity: 'dining_tables', id: b?.id, data: { active: false } }])
    const free = await m.editar([
      { entity: 'dining_tables', id: a?.id, data: { name: String(b?.name) } },
    ])
    expect(free.code).toBe(200)
  })

  it('un nombre solo de espacios, vacío o de más de 20 caracteres se rechaza; de 20 vale', async () => {
    const m = await setup()
    const s = m.diningRoom()
    for (const name of ['', '   ', 'x'.repeat(21)])
      expect((await m.editar([table(s, name)])).code, name).toBe(400)
    expect((await m.editar([table(s, 'y'.repeat(20))])).code).toBe(200)
    // El nombre se guarda sin los espacios de los lados.
    expect((await m.editar([table(s, '  Alta  ')])).code).toBe(200)
    expect(m.catalog().tables.some((x) => x.name === 'Alta')).toBe(true)
  })

  it('espacios en medio sí hacen otro nombre (no se normalizan)', async () => {
    const m = await setup()
    const s = m.diningRoom()
    expect((await m.editar([table(s, 'Mesa 1')])).code).toBe(200)
    expect((await m.editar([table(s, 'Mesa  1')])).code).toBe(200)
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: lower() de SQLite solo conoce ASCII, así
  // que «Ñandú» y «ñandú» no chocaban en el hub aunque la pantalla sí las viera iguales.
  it('acentos y eñes en mayúscula y minúscula también chocan', async () => {
    const m = await setup()
    const s = m.diningRoom()
    expect((await m.editar([table(s, 'Ñandú')])).code).toBe(200)
    expect((await m.editar([table(s, 'ñandú')])).code).toBe(400)
  })

  it('las zonas pueden llamarse igual que una mesa y dos zonas pueden compartir nombre', async () => {
    // Documenta lo que hoy permite el hub: el nombre único es solo de las mesas.
    const m = await setup()
    expect((await m.editar([zone('Salón')])).code).toBe(200)
    expect((await m.editar([zone('1')])).code).toBe(200)
  })
})

describe('lote grande de cambios', () => {
  it('200 mesas en un solo guardado, con sus números, quedan todas y avisan una sola vez', async () => {
    const m = await setup()
    const s = m.diningRoom()
    const zonaNueva = zone('Eventos')
    const tables = Array.from({ length: 199 }, (_, i) =>
      table(zonaNueva.id, `E${i + 1}`, { x: (i % 20) * 100, y: Math.floor(i / 20) * 100 }),
    )
    const before = m.catalog().version
    const r = await m.editar([zonaNueva, ...tables])
    expect(r).toMatchObject({ code: 200, cuerpo: { cambiados: 200 } })
    expect(r.cuerpo.version).toBe(before + 200)
    expect(m.alerts).toEqual([before + 200])
    const guardadas = m.catalog().tables.filter((x) => x.zoneId === zonaNueva.id)
    expect(guardadas).toHaveLength(199)
    expect(new Set(guardadas.map((x) => x.name)).size).toBe(199)
    expect(m.catalog().tables.filter((x) => x.zoneId === s)).toHaveLength(25)
    // El mismo guardado otra vez no cambia nada.
    const another = await m.editar([zonaNueva, ...tables])
    expect(another).toMatchObject({ code: 200, cuerpo: { cambiados: 0 } })
  })

  it('201 cambios se rechazan enteros', async () => {
    const m = await setup()
    const before = m.catalog().version
    const r = await m.editar(Array.from({ length: 201 }, (_, i) => table(m.diningRoom(), `Z${i}`)))
    expect(r.code).toBe(400)
    expect(m.catalog().version).toBe(before)
  })

  it('un solo cambio malo al final de 150 buenos deja todo como estaba', async () => {
    const m = await setup()
    const before = { version: m.catalog().version, tables: m.edicion().tables.length }
    const buenas = Array.from({ length: 150 }, (_, i) => table(m.diningRoom(), `B${i}`))
    const r = await m.editar([...buenas, table(m.diningRoom(), 'Mala', { rotation: 360 })])
    expect(r.code).toBe(400)
    expect(m.catalog().version).toBe(before.version)
    expect(m.edicion().tables).toHaveLength(before.tables)
  })

  it('un nombre repetido escondido entre 150 mesas nuevas tumba todo el lote', async () => {
    const m = await setup()
    const before = m.edicion().tables.length
    const buenas = Array.from({ length: 150 }, (_, i) => table(m.diningRoom(), `B${i}`))
    const r = await m.editar([...buenas, table(m.diningRoom(), 'b77')])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/dos mesas que se llaman «B77»|«b77»/i)
    expect(m.edicion().tables).toHaveLength(before)
  })

  it('archivar las 25 mesas de golpe y crear 25 nuevas con los mismos nombres vale', async () => {
    const m = await setup()
    const s = m.diningRoom()
    const viejas = m.catalog().tables
    const r = await m.editar([
      ...viejas.map((x) => ({ entity: 'dining_tables', id: x.id, data: { active: false } })),
      ...viejas.map((x) => table(s, x.name, { x: x.x, y: x.y })),
    ])
    expect(r.code).toBe(200)
    expect(m.catalog().tables).toHaveLength(25)
    expect(m.edicion().tables).toHaveLength(50)
    expect(new Set(m.catalog().tables.map((x) => x.id)).size).toBe(25)
  })

  it('cada registro tocado del lote sube de versión una sola vez y las versiones son distintas', async () => {
    const m = await setup()
    const newOnes = Array.from({ length: 40 }, (_, i) => table(m.diningRoom(), `V${i}`))
    await m.editar(newOnes)
    const versiones = m.edicion().tables.map((x) => Number(x.version))
    expect(new Set(versiones).size).toBe(versiones.length)
    expect(Math.max(...versiones)).toBe(m.catalog().version)
  })
})

describe('el seed después de dibujar el salón', () => {
  it('lo que una persona movió, renombró o archivó no se pisa al repetir el seed', async () => {
    const m = await setup()
    const [a, b, c] = m.catalog().tables
    await m.editar([
      { entity: 'dining_tables', id: a?.id, data: { x: 777, name: 'Esquina' } },
      { entity: 'dining_tables', id: b?.id, data: { active: false } },
    ])
    m.sembrarSalon()
    const now = m.edicion().tables
    expect(now.find((x) => x.id === a?.id)).toMatchObject({ x: 777, name: 'Esquina' })
    expect(now.find((x) => x.id === b?.id)?.active).toBe(false)
    // La que nadie tocó sigue donde el seed la dejó.
    expect(now.find((x) => x.id === c?.id)).toMatchObject({ x: c?.x, y: c?.y, active: true })
  })

  it('una zona con mesas y elementos dibujada por una persona no se archiva al repetir el seed', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    const plant = element(t.id, { type: 'plant' })
    await m.editar([t, t1, plant])
    const before = m.catalog()
    const r = m.sembrarSalon()
    expect(r.sqlTables.zones).toMatchObject({ archived: 0 })
    const after = m.catalog()
    expect(after.zones.map((z) => z.name)).toEqual(before.zones.map((z) => z.name))
    expect(after.tables.map((x) => x.id).sort()).toEqual(before.tables.map((x) => x.id).sort())
    expect(after.elements).toEqual(before.elements)
  })

  it('si la persona archivó el salón del seed (con sus mesas) y dibujó otro, el seed no lo devuelve', async () => {
    const m = await setup()
    const viejas = m.catalog().tables
    const newOne = zone('Nuevo salón', { position: 0 })
    await m.editar([
      newOne,
      ...viejas.map((x) => ({ entity: 'dining_tables', id: x.id, data: { active: false } })),
      { entity: 'zones', id: m.diningRoom(), data: { active: false } },
    ])
    m.sembrarSalon()
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Nuevo salón'])
    expect(m.catalog().tables).toEqual([])
  })
})

describe('lo que ve el editor y lo que ven los equipos', () => {
  it('el editor trae también lo archivado; los equipos, solo lo activo', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    const wall = element(t.id)
    await m.editar([t, t1, wall])
    await m.editar([
      { entity: 'dining_tables', id: t1.id, data: { active: false } },
      { entity: 'floor_plan_elements', id: wall.id, data: { active: false } },
      { entity: 'zones', id: t.id, data: { active: false } },
    ])
    const e = m.edicion()
    expect(e.zones.find((z) => z.id === t.id)).toMatchObject({ active: false })
    expect(e.tables.find((x) => x.id === t1.id)).toMatchObject({ active: false })
    expect(e.elements.find((x) => x.id === wall.id)).toMatchObject({ active: false })
    const c = m.catalog()
    expect(c.zones.some((z) => z.id === t.id)).toBe(false)
    expect(c.tables.some((x) => x.id === t1.id)).toBe(false)
    expect(c.elements).toEqual([])
  })

  it('el editor no entrega la sede, el autor ni la fecha de creación', async () => {
    const m = await setup()
    const e = m.edicion()
    for (const row of [...e.zones, ...e.tables, ...e.elements]) {
      for (const field of ['location_id', 'restaurant_id', 'user_id', 'device_id', 'created_at'])
        expect(Object.keys(row)).not.toContain(field)
    }
  })

  it('las zonas salen por piso, orden y nombre; las mesas de cada zona de arriba a abajo', async () => {
    const m = await setup()
    const alta = zone('Azotea', { level: 3, position: 0 })
    const sotano = zone('Sótano', { level: -1, position: 5 })
    await m.editar([alta, sotano])
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Sótano', 'Salón', 'Azotea'])
    const rows = m.catalog().tables.filter((x) => x.zoneId === m.diningRoom())
    const ordenadas = [...rows].sort((p, q) => p.y - q.y || p.x - q.x)
    expect(rows.map((x) => x.id)).toEqual(ordenadas.map((x) => x.id))
  })

  it('un elemento de una zona archivada con elementos activos no sale a los equipos', async () => {
    // El hub deja archivar una zona sin mesas aunque tenga elementos activos; los equipos no los ven.
    const m = await setup()
    const t = zone('Patio')
    const wall = element(t.id)
    await m.editar([t, wall])
    const r = await m.editar([{ entity: 'zones', id: t.id, data: { active: false } }])
    expect(r.code).toBe(200)
    expect(m.catalog().elements).toEqual([])
    expect(m.edicion().elements.find((e) => e.id === wall.id)?.active).toBe(true)
  })

  it('crear un elemento en una zona archivada se rechaza', async () => {
    const m = await setup()
    const t = zone('Patio')
    await m.editar([t])
    await m.editar([{ entity: 'zones', id: t.id, data: { active: false } }])
    const r = await m.editar([element(t.id)])
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/zone está archivado/)
  })
})

describe('elementos del plano: validación', () => {
  it.each([
    ['tipo desconocido', { type: 'ventana' }],
    ['texto de más de 60 caracteres', { type: 'text', text: 'x'.repeat(61) }],
    ['ancho menor al mínimo', { width: 4 }],
    ['alto de más de 10 000', { height: 10_001 }],
    ['coordenada fuera del salón', { x: 10_001 }],
    ['coordenada con decimales', { y: 1.5 }],
    ['rotación negativa', { rotation: -1 }],
    ['campo que no existe', { color: 'rojo' }],
  ])('%s se rechaza', async (_case, fields) => {
    const m = await setup()
    const before = m.catalog().version
    expect((await m.editar([element(m.diningRoom(), fields)])).code).toBe(400)
    expect(m.catalog().version).toBe(before)
  })

  it('un elemento sin zona o sin ancho se rechaza al crearlo (pide todos los campos)', async () => {
    const m = await setup()
    const incompleto = { entity: 'floor_plan_elements', id: newId(), data: { type: 'wall' } }
    expect((await m.editar([incompleto])).code).toBe(400)
  })

  it('el id de un elemento puede coincidir con el de una mesa: son tablas distintas y no se cruzan', async () => {
    // Hoy el hub solo revisa que un id no sea de dos tipos en el historial del catálogo, y el
    // plano no entra en él. Se deja dicho para que un cambio futuro sea consciente.
    const m = await setup()
    const one = m.catalog().tables[0]
    const r = await m.editar([{ ...element(m.diningRoom()), id: one?.id }])
    expect(r.code).toBe(200)
    expect(m.catalog().tables.find((x) => x.id === one?.id)?.name).toBe(one?.name)
    expect(m.catalog().elements.some((e) => e.id === one?.id)).toBe(true)
  })

  it('se actualiza de a pedazos y se archiva', async () => {
    const m = await setup()
    const e = element(m.diningRoom(), { type: 'text', text: 'Baños' })
    await m.editar([e])
    expect(
      (await m.editar([{ entity: 'floor_plan_elements', id: e.id, data: { x: 40 } }])).code,
    ).toBe(200)
    expect(m.catalog().elements[0]).toMatchObject({ text: 'Baños', x: 40 })
    expect(
      (await m.editar([{ entity: 'floor_plan_elements', id: e.id, data: { active: false } }])).code,
    ).toBe(200)
    expect(m.catalog().elements).toEqual([])
  })

  it('el texto de un elemento llega sin espacios en los lados', async () => {
    const m = await setup()
    await m.editar([element(m.diningRoom(), { type: 'text', text: '  Baños  ' })])
    expect(m.catalog().elements[0]?.text).toBe('Baños')
  })
})
