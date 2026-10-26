import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { type CatalogoEdicion, completarCatalogo } from './motor'
import {
  ajustar,
  borradorDeZona,
  cambiosDeZona,
  limites,
  measure,
  move,
  nuevaMesa,
  nuevoElemento,
  problemasDeZona,
  rotate,
  siguienteNombre,
  variasMesas,
  zonaNueva,
} from './plano'

const reg = { version: 1, active: true }
const geo = (x: number, y: number, width = 80, height = 80) => ({
  x,
  y,
  width,
  height,
  rotation: 0,
})

function edicion(): CatalogoEdicion {
  const diningRoom = newId()
  const terraza = newId()
  return {
    version: 5,
    zones: [
      { ...reg, id: diningRoom, name: 'Salón', position: 0, level: 1 },
      { ...reg, id: terraza, name: 'Terraza', position: 1, level: 1 },
    ],
    tables: [
      {
        ...reg,
        ...geo(0, 0),
        id: newId(),
        zone_id: diningRoom,
        name: '1',
        shape: 'square',
        capacity: 4,
      },
      {
        ...reg,
        ...geo(120, 0),
        id: newId(),
        zone_id: diningRoom,
        name: '2',
        shape: 'square',
        capacity: 4,
      },
      {
        ...reg,
        ...geo(0, 0),
        id: newId(),
        zone_id: terraza,
        name: '10',
        shape: 'round',
        capacity: 2,
      },
    ],
    elements: [
      {
        ...reg,
        ...geo(0, 200, 300, 20),
        id: newId(),
        zone_id: diningRoom,
        type: 'wall',
        text: null,
      },
    ],
    taxes: [],
    stations: [],
    categories: [],
    products: [],
    variants: [],
    groups: [],
    links: [],
    modifiers: [],
  }
}

const salonDe = (c: CatalogoEdicion) => c.zones[0]?.id as string

describe('geometría', () => {
  it('todo va a la cuadrícula de 10 cm', () => {
    expect(ajustar(84)).toBe(80)
    expect(ajustar(85)).toBe(90)
    expect(move(geo(0, 0), 123, -7)).toMatchObject({ x: 120, y: -10 })
  })

  it('girar da siempre entre 0 y 359', () => {
    expect(rotate(geo(0, 0), 45).rotation).toBe(45)
    expect(rotate({ ...geo(0, 0), rotation: 330 }, 45).rotation).toBe(15)
    expect(rotate(geo(0, 0), -15).rotation).toBe(345)
  })

  it('las medidas tienen un mínimo y van a la cuadrícula', () => {
    expect(measure(geo(0, 0), 3, 154)).toMatchObject({ width: 20, height: 150 })
  })

  it('los límites cubren todo, también lo girado, con margen', () => {
    expect(limites([geo(0, 0), geo(200, 100)], 0)).toEqual({ x: 0, y: 0, width: 280, height: 180 })
    const girada = limites([{ ...geo(0, 0, 100, 20), rotation: 90 }], 0)
    expect(girada.width).toBeGreaterThan(100)
    expect(limites([], 0).width).toBeGreaterThan(0)
  })
})

describe('zona', () => {
  it('abrir y guardar sin tocar nada no cambia nada', () => {
    const c = edicion()
    expect(cambiosDeZona(c, borradorDeZona(c, salonDe(c)))).toEqual([])
  })

  it('mover una mesa solo manda su posición', () => {
    const c = edicion()
    const b = borradorDeZona(c, salonDe(c))
    const [first] = b.tables
    if (!first) throw new Error('falta')
    b.tables = b.tables.map((m) => (m.id === first.id ? move(m, 40, 300) : m))
    expect(cambiosDeZona(c, b)).toEqual([
      { entity: 'dining_tables', id: first.id, data: { x: 40, y: 300 } },
    ])
  })

  it('una mesa nueva toma el siguiente número libre del restaurante y va al primer hueco libre', () => {
    const c = edicion()
    const b = borradorDeZona(c, salonDe(c))
    const names = c.tables.map((m) => m.name)
    const table = nuevaMesa(b, 'rectangular', names)
    expect(table).toMatchObject({ name: '3', width: 160, height: 80, capacity: 6, rotation: 0 })
    // En el primer hueco libre de la fila, a 40 cm de la mesa 2 (que termina en x = 200).
    expect(table).toMatchObject({ x: 240, y: 0 })
    b.tables.push(table)
    const [change] = cambiosDeZona(c, b)
    expect(change).toMatchObject({
      entity: 'dining_tables',
      id: table.id,
      data: { zone_id: b.id, name: '3', shape: 'rectangular', capacity: 6, active: true },
    })
  })

  it('siguienteNombre salta los usados sin importar mayúsculas', () => {
    expect(siguienteNombre(['1', '2', '4'])).toBe('3')
    expect(siguienteNombre([])).toBe('1')
  })

  it('un elemento de texto lleva su texto; los demás, null', () => {
    const c = edicion()
    const b = borradorDeZona(c, salonDe(c))
    const t = nuevoElemento(b, 'text')
    const p = nuevoElemento(b, 'door')
    b.elements.push({ ...t, text: ' Baños ' }, p)
    const changes = cambiosDeZona(c, b)
    expect(changes.find((x) => x.id === t.id)?.data.text).toBe('Baños')
    expect(changes.find((x) => x.id === p.id)?.data.text).toBeNull()
  })

  it('quitar una mesa la archiva; una nueva quitada antes de guardar no viaja', () => {
    const c = edicion()
    const b = borradorDeZona(c, salonDe(c))
    const [first] = b.tables
    if (!first) throw new Error('falta')
    b.tables = b.tables.map((m) => (m.id === first.id ? { ...m, active: false } : m))
    b.tables.push({ ...nuevaMesa(b, 'square', []), active: false })
    expect(cambiosDeZona(c, b)).toEqual([
      { entity: 'dining_tables', id: first.id, data: { active: false } },
    ])
  })

  it('archivar la zona archiva antes sus mesas y elementos (el hub no deja una zona con mesas)', () => {
    const c = edicion()
    const b = { ...borradorDeZona(c, salonDe(c)), active: false }
    const changes = cambiosDeZona(c, b)
    expect(changes.map((x) => x.entity)).toEqual([
      'dining_tables',
      'dining_tables',
      'floor_plan_elements',
      'zones',
    ])
    expect(changes.every((x) => x.data.active === false)).toBe(true)
  })

  it('una zona nueva va antes que sus mesas', () => {
    const c = edicion()
    const b = zonaNueva(c)
    b.name = 'Segundo piso'
    b.level = 2
    b.tables.push(nuevaMesa(b, 'square', ['1']))
    const changes = cambiosDeZona(c, b)
    expect(changes[0]).toEqual({
      entity: 'zones',
      id: b.id,
      data: { name: 'Segundo piso', level: 2, position: 2, active: true },
    })
    expect(changes[1]?.entity).toBe('dining_tables')
  })

  it('no deja dos mesas con el mismo nombre, tampoco entre zonas', () => {
    const c = edicion()
    const b = borradorDeZona(c, salonDe(c))
    expect(problemasDeZona(c, b)).toEqual([])
    b.tables.push({ ...nuevaMesa(b, 'square', []), name: '10' })
    expect(problemasDeZona(c, b)).toEqual(['Hay dos mesas que se llaman «10»'])
    b.name = ' '
    expect(problemasDeZona(c, b)[0]).toBe('Falta el nombre de la zona')
  })
})

describe('carta guardada por una versión anterior de la app', () => {
  it('se completa con lo que le falta en vez de romper la pantalla', () => {
    const vieja = {
      version: 3,
      restaurant: { name: 'X', sessionIdleMin: 30 },
      zones: [{ id: 'Z', name: 'Salón' }],
      tables: [{ id: 'M', zoneId: 'Z', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 }],
      stations: [],
      categories: [],
    } as unknown as Parameters<typeof completarCatalogo>[0]
    const c = completarCatalogo(vieja)
    expect(c.elements).toEqual([])
    expect(c.staff).toEqual([])
    expect(c.zones[0]?.level).toBe(1)
    expect(c.tables[0]).toMatchObject({ width: 80, height: 80, rotation: 0 })
  })
})

describe('varias mesas de una vez', () => {
  it('pone N mesas en filas, con números seguidos que no chocan con los usados', () => {
    const c = edicion()
    const b = { ...zonaNueva(c), name: 'Patio' }
    const tables = variasMesas(b, 'square', 7, 3, ['1', '2', '4'])
    expect(tables.map((m) => m.name)).toEqual(['3', '5', '6', '7', '8', '9', '10'])
    expect(new Set(tables.map((m) => m.y)).size).toBe(3)
    expect(tables.filter((m) => m.y === tables[0]?.y)).toHaveLength(3)
    // Ninguna encima de otra.
    expect(new Set(tables.map((m) => `${m.x},${m.y}`)).size).toBe(7)
    expect(tables.every((m) => m.x % 10 === 0 && m.y % 10 === 0)).toBe(true)
  })
})
