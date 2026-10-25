import 'fake-indexeddb/auto'
import { nuevoId } from '@pos/core'
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
async function abrirCon(catalogo: unknown, extra: { equipo?: Equipo } = {}) {
  const db = new BaseDispositivo(`viejo-${nuevoId()}`)
  bases.push(db)
  if (catalogo !== undefined) await db.guardarAjuste('catalogo', catalogo)
  if (extra.equipo) await db.guardarAjuste('equipo', extra.equipo)
  // Un canal que nunca abre: no hay conexión ni mensajes.
  const sala = new Sala({ db, abrir: () => ({ enviar: () => {}, cerrar: () => {} }) })
  salas.push(sala)
  await sala.cargar()
  return { sala, db }
}

const base = {
  version: 3,
  restaurante: { nombre: 'La Spritzzería', sesionInactividadMin: 30 },
  estaciones: [{ id: 'E', nombre: 'Cocina' }],
  categorias: [],
}

describe('Sala.cargar() con una carta guardada por una versión anterior', () => {
  it.each([
    [
      'la de la tarea 0.9: zonas sin piso, mesas sin medidas ni giro, sin elementos ni personal',
      {
        ...base,
        zonas: [{ id: 'Z', nombre: 'Salón' }],
        mesas: [{ id: 'M', zonaId: 'Z', nombre: '1', x: 0, y: 0, forma: 'cuadrada', capacidad: 4 }],
      },
    ],
    ['sin zonas ni mesas', { ...base, zonas: [], mesas: [] }],
    ['sin las claves zonas y mesas', { ...base }],
    [
      'con mesas pero sin zonas (dato a medias)',
      {
        ...base,
        mesas: [{ id: 'M', zonaId: 'Z', nombre: '1', x: 0, y: 0, forma: 'cuadrada', capacidad: 4 }],
      },
    ],
    [
      'con una forma que ya no existe',
      {
        ...base,
        zonas: [{ id: 'Z', nombre: 'Salón' }],
        mesas: [
          { id: 'M', zonaId: 'Z', nombre: '1', x: 0, y: 0, forma: 'hexagonal', capacidad: 4 },
        ],
      },
    ],
    [
      'con campos nuevos sueltos y desconocidos',
      {
        ...base,
        zonas: [{ id: 'Z', nombre: 'Salón', piso: 1, futuro: true }],
        mesas: [],
        algoMas: [1, 2, 3],
      },
    ],
  ])('%s: carga sin fallar y queda con todo lo que la pantalla lee', async (_caso, vieja) => {
    const { sala } = await abrirCon(vieja)
    const c = sala.instantanea().catalogo
    expect(sala.instantanea().cargado).toBe(true)
    expect(c).not.toBeNull()
    // Lo que lee Mesas.tsx sin protegerse.
    expect(Array.isArray(c?.zonas)).toBe(true)
    expect(Array.isArray(c?.mesas)).toBe(true)
    expect(Array.isArray(c?.elementos)).toBe(true)
    expect(Array.isArray(c?.personal)).toBe(true)
    for (const z of c?.zonas ?? []) expect(typeof z.piso).toBe('number')
    for (const m of c?.mesas ?? []) {
      expect(typeof m.ancho).toBe('number')
      expect(typeof m.alto).toBe('number')
      expect(typeof m.rotacion).toBe('number')
    }
    // Lo viejo se conserva.
    expect(c?.version).toBe(3)
    expect(c?.restaurante.nombre).toBe('La Spritzzería')
  })

  it('conserva las mesas de siempre con medidas por defecto de 80 × 80 y sin giro', async () => {
    const { sala } = await abrirCon({
      ...base,
      zonas: [{ id: 'Z', nombre: 'Salón' }],
      mesas: [
        { id: 'M1', zonaId: 'Z', nombre: '1', x: 120, y: 240, forma: 'cuadrada', capacidad: 4 },
        { id: 'M2', zonaId: 'Z', nombre: '2', x: 0, y: 0, forma: 'cuadrada', capacidad: 2 },
      ],
    })
    expect(sala.instantanea().catalogo?.mesas).toEqual([
      expect.objectContaining({ id: 'M1', x: 120, y: 240, ancho: 80, alto: 80, rotacion: 0 }),
      expect.objectContaining({ id: 'M2', ancho: 80, alto: 80, rotacion: 0 }),
    ])
    expect(sala.instantanea().catalogo?.zonas[0]).toMatchObject({ id: 'Z', piso: 1 })
  })

  it('sin carta guardada, la carta es nula (no inventa una)', async () => {
    const { sala } = await abrirCon(undefined)
    expect(sala.instantanea().cargado).toBe(true)
    expect(sala.instantanea().catalogo).toBeNull()
  })

  it('abrir dos veces la misma base da la misma carta completa (no se rompe al repetir)', async () => {
    const db = new BaseDispositivo(`viejo-${nuevoId()}`)
    bases.push(db)
    await db.guardarAjuste('catalogo', {
      ...base,
      zonas: [{ id: 'Z', nombre: 'Salón' }],
      mesas: [],
    })
    const abrir = () => new Sala({ db, abrir: () => ({ enviar: () => {}, cerrar: () => {} }) })
    const a = abrir()
    await a.cargar()
    const b = abrir()
    await b.cargar()
    expect(b.instantanea().catalogo).toEqual(a.instantanea().catalogo)
    // Llamar cargar() de nuevo en la misma sala devuelve la misma carga.
    await a.cargar()
  })
})

describe('Sala.actualizarCatalogo() con la respuesta de un hub anterior', () => {
  const equipo: Equipo = { dispositivoId: nuevoId(), token: 'token', nombre: 'Caja', tipo: 'caja' }
  const responder = (cuerpo: unknown, status = 200) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(cuerpo), { status })),
    )

  it('completa lo que falta, lo guarda ya completo y lo muestra', async () => {
    const { sala, db } = await abrirCon(undefined, { equipo })
    responder({
      ...base,
      version: 5,
      zonas: [{ id: 'Z', nombre: 'Salón' }],
      mesas: [{ id: 'M', zonaId: 'Z', nombre: '1', x: 0, y: 0, forma: 'cuadrada', capacidad: 4 }],
    })
    await sala.actualizarCatalogo()
    const mostrada = sala.instantanea().catalogo
    expect(mostrada?.version).toBe(5)
    expect(mostrada?.elementos).toEqual([])
    expect(mostrada?.mesas[0]).toMatchObject({ ancho: 80, alto: 80, rotacion: 0 })
    const guardada = await db.leerAjuste<typeof mostrada>('catalogo')
    expect(guardada).toEqual(mostrada)
  })

  it('una respuesta sin mesas (no es la carta) no reemplaza la buena', async () => {
    const { sala } = await abrirCon(
      { ...base, version: 7, zonas: [], mesas: [], elementos: [], personal: [] },
      { equipo },
    )
    responder({ error: 'algo' })
    await expect(sala.actualizarCatalogo()).rejects.toMatchObject({ codigo: 'respuesta_invalida' })
    expect(sala.instantanea().catalogo?.version).toBe(7)
  })

  it('una respuesta de versión anterior a la guardada no la pisa', async () => {
    const { sala } = await abrirCon(
      { ...base, version: 7, zonas: [], mesas: [], elementos: [], personal: [] },
      { equipo },
    )
    responder({ ...base, version: 4, zonas: [], mesas: [] })
    await sala.actualizarCatalogo()
    expect(sala.instantanea().catalogo?.version).toBe(7)
  })
})
