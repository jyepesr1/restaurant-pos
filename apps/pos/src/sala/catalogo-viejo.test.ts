import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala } from './motor'

// Una actualización de la app no debe dejar el salón en blanco: la carta guardada en IndexedDB
// por una versión anterior (sin plano, sin elementos, sin personal) se completa al abrir, y la
// que llega de un hub viejo también. Sin red: el equipo no se conecta.

const bases: BaseDispositivo[] = []
const salas: Sala[] = []

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const b of bases.splice(0)) await b.delete()
  salas.length = 0
})

/** Guarda `catalogo` tal cual en una base nueva y abre la sala sobre ella. */
async function abrirCon(catalog: unknown, extra: { device?: Equipo } = {}) {
  const db = new BaseDispositivo(`viejo-${newId()}`)
  bases.push(db)
  if (catalog !== undefined) await db.saveSetting('catalog', catalog)
  if (extra.device) await db.saveSetting('device', extra.device)
  // Un canal que nunca abre: no hay conexión ni mensajes.
  const sala = new Sala({ db, open: () => ({ send: () => {}, close: () => {} }) })
  salas.push(sala)
  await sala.cargar()
  return { sala, db }
}

const base = {
  version: 3,
  restaurant: { name: 'La Spritzzería', sesionInactividadMin: 30 },
  stations: [{ id: 'E', name: 'Cocina' }],
  categories: [],
}

describe('Sala.cargar() con una carta guardada por una versión anterior', () => {
  it.each([
    [
      'la de la tarea 0.9: zonas sin piso, mesas sin medidas ni giro, sin elementos ni personal',
      {
        ...base,
        zones: [{ id: 'Z', name: 'Salón' }],
        tables: [{ id: 'M', zonaId: 'Z', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 }],
      },
    ],
    ['sin zonas ni mesas', { ...base, zones: [], tables: [] }],
    ['sin las claves zonas y mesas', { ...base }],
    [
      'con mesas pero sin zonas (dato a medias)',
      {
        ...base,
        tables: [{ id: 'M', zonaId: 'Z', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 }],
      },
    ],
    [
      'con una forma que ya no existe',
      {
        ...base,
        zones: [{ id: 'Z', name: 'Salón' }],
        tables: [{ id: 'M', zonaId: 'Z', name: '1', x: 0, y: 0, shape: 'hexagonal', capacity: 4 }],
      },
    ],
    [
      'con campos nuevos sueltos y desconocidos',
      {
        ...base,
        zones: [{ id: 'Z', name: 'Salón', level: 1, futuro: true }],
        tables: [],
        algoMas: [1, 2, 3],
      },
    ],
  ])('%s: carga sin fallar y queda con todo lo que la pantalla lee', async (_case, vieja) => {
    const { sala } = await abrirCon(vieja)
    const c = sala.instantanea().catalog
    expect(sala.instantanea().cargado).toBe(true)
    expect(c).not.toBeNull()
    // Lo que lee Mesas.tsx sin protegerse.
    expect(Array.isArray(c?.zones)).toBe(true)
    expect(Array.isArray(c?.tables)).toBe(true)
    expect(Array.isArray(c?.elements)).toBe(true)
    expect(Array.isArray(c?.staff)).toBe(true)
    for (const z of c?.zones ?? []) expect(typeof z.level).toBe('number')
    for (const m of c?.tables ?? []) {
      expect(typeof m.width).toBe('number')
      expect(typeof m.height).toBe('number')
      expect(typeof m.rotation).toBe('number')
    }
    // Lo viejo se conserva.
    expect(c?.version).toBe(3)
    expect(c?.restaurant.name).toBe('La Spritzzería')
  })

  it('conserva las mesas de siempre con medidas por defecto de 80 × 80 y sin giro', async () => {
    const { sala } = await abrirCon({
      ...base,
      zones: [{ id: 'Z', name: 'Salón' }],
      tables: [
        { id: 'M1', zonaId: 'Z', name: '1', x: 120, y: 240, shape: 'square', capacity: 4 },
        { id: 'M2', zonaId: 'Z', name: '2', x: 0, y: 0, shape: 'square', capacity: 2 },
      ],
    })
    expect(sala.instantanea().catalog?.tables).toEqual([
      expect.objectContaining({ id: 'M1', x: 120, y: 240, width: 80, height: 80, rotation: 0 }),
      expect.objectContaining({ id: 'M2', width: 80, height: 80, rotation: 0 }),
    ])
    expect(sala.instantanea().catalog?.zones[0]).toMatchObject({ id: 'Z', level: 1 })
  })

  it('sin carta guardada, la carta es nula (no inventa una)', async () => {
    const { sala } = await abrirCon(undefined)
    expect(sala.instantanea().cargado).toBe(true)
    expect(sala.instantanea().catalog).toBeNull()
  })

  it('abrir dos veces la misma base da la misma carta completa (no se rompe al repetir)', async () => {
    const db = new BaseDispositivo(`viejo-${newId()}`)
    bases.push(db)
    await db.saveSetting('catalog', {
      ...base,
      zones: [{ id: 'Z', name: 'Salón' }],
      tables: [],
    })
    const open = () => new Sala({ db, open: () => ({ send: () => {}, close: () => {} }) })
    const a = open()
    await a.cargar()
    const b = open()
    await b.cargar()
    expect(b.instantanea().catalog).toEqual(a.instantanea().catalog)
    // Llamar cargar() de nuevo en la misma sala devuelve la misma carga.
    await a.cargar()
  })
})

describe('Sala.actualizarCatalogo() con la respuesta de un hub anterior', () => {
  const device: Equipo = { dispositivoId: newId(), token: 'token', name: 'Caja', type: 'register' }
  const responder = (cuerpo: unknown, status = 200) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(cuerpo), { status })),
    )

  it('completa lo que falta, lo guarda ya completo y lo muestra', async () => {
    const { sala, db } = await abrirCon(undefined, { device })
    responder({
      ...base,
      version: 5,
      zones: [{ id: 'Z', name: 'Salón' }],
      tables: [{ id: 'M', zonaId: 'Z', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 }],
    })
    await sala.actualizarCatalogo()
    const mostrada = sala.instantanea().catalog
    expect(mostrada?.version).toBe(5)
    expect(mostrada?.elements).toEqual([])
    expect(mostrada?.tables[0]).toMatchObject({ width: 80, height: 80, rotation: 0 })
    const guardada = await db.leerAjuste<typeof mostrada>('catalog')
    expect(guardada).toEqual(mostrada)
  })

  it('una respuesta sin mesas (no es la carta) no reemplaza la buena', async () => {
    const { sala } = await abrirCon(
      { ...base, version: 7, zones: [], tables: [], elements: [], staff: [] },
      { device },
    )
    responder({ error: 'algo' })
    await expect(sala.actualizarCatalogo()).rejects.toMatchObject({ code: 'invalid_response' })
    expect(sala.instantanea().catalog?.version).toBe(7)
  })

  it('una respuesta de versión anterior a la guardada no la pisa', async () => {
    const { sala } = await abrirCon(
      { ...base, version: 7, zones: [], tables: [], elements: [], staff: [] },
      { device },
    )
    responder({ ...base, version: 4, zones: [], tables: [] })
    await sala.actualizarCatalogo()
    expect(sala.instantanea().catalog?.version).toBe(7)
  })
})
