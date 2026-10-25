import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { type CatalogoEdicion, completarCatalogo } from './motor'
import {
  ajustar,
  borradorDeZona,
  cambiosDeZona,
  girar,
  limites,
  medir,
  mover,
  nuevaMesa,
  nuevoElemento,
  problemasDeZona,
  siguienteNombre,
  variasMesas,
  zonaNueva,
} from './plano'

const reg = { version: 1, activo: true }
const geo = (x: number, y: number, ancho = 80, alto = 80) => ({ x, y, ancho, alto, rotacion: 0 })

function edicion(): CatalogoEdicion {
  const salon = nuevoId()
  const terraza = nuevoId()
  return {
    version: 5,
    zonas: [
      { ...reg, id: salon, nombre: 'Salón', orden: 0, piso: 1 },
      { ...reg, id: terraza, nombre: 'Terraza', orden: 1, piso: 1 },
    ],
    mesas: [
      {
        ...reg,
        ...geo(0, 0),
        id: nuevoId(),
        zona_id: salon,
        nombre: '1',
        forma: 'cuadrada',
        capacidad: 4,
      },
      {
        ...reg,
        ...geo(120, 0),
        id: nuevoId(),
        zona_id: salon,
        nombre: '2',
        forma: 'cuadrada',
        capacidad: 4,
      },
      {
        ...reg,
        ...geo(0, 0),
        id: nuevoId(),
        zona_id: terraza,
        nombre: '10',
        forma: 'redonda',
        capacidad: 2,
      },
    ],
    elementos: [
      {
        ...reg,
        ...geo(0, 200, 300, 20),
        id: nuevoId(),
        zona_id: salon,
        tipo: 'pared',
        texto: null,
      },
    ],
    impuestos: [],
    estaciones: [],
    categorias: [],
    productos: [],
    variantes: [],
    grupos: [],
    enlaces: [],
    modificadores: [],
  }
}

const salonDe = (c: CatalogoEdicion) => c.zonas[0]?.id as string

describe('geometría', () => {
  it('todo va a la cuadrícula de 10 cm', () => {
    expect(ajustar(84)).toBe(80)
    expect(ajustar(85)).toBe(90)
    expect(mover(geo(0, 0), 123, -7)).toMatchObject({ x: 120, y: -10 })
  })

  it('girar da siempre entre 0 y 359', () => {
    expect(girar(geo(0, 0), 45).rotacion).toBe(45)
    expect(girar({ ...geo(0, 0), rotacion: 330 }, 45).rotacion).toBe(15)
    expect(girar(geo(0, 0), -15).rotacion).toBe(345)
  })

  it('las medidas tienen un mínimo y van a la cuadrícula', () => {
    expect(medir(geo(0, 0), 3, 154)).toMatchObject({ ancho: 20, alto: 150 })
  })

  it('los límites cubren todo, también lo girado, con margen', () => {
    expect(limites([geo(0, 0), geo(200, 100)], 0)).toEqual({ x: 0, y: 0, ancho: 280, alto: 180 })
    const girada = limites([{ ...geo(0, 0, 100, 20), rotacion: 90 }], 0)
    expect(girada.ancho).toBeGreaterThan(100)
    expect(limites([], 0).ancho).toBeGreaterThan(0)
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
    const [primera] = b.mesas
    if (!primera) throw new Error('falta')
    b.mesas = b.mesas.map((m) => (m.id === primera.id ? mover(m, 40, 300) : m))
    expect(cambiosDeZona(c, b)).toEqual([
      { entidad: 'mesa', id: primera.id, datos: { x: 40, y: 300 } },
    ])
  })

  it('una mesa nueva toma el siguiente número libre del restaurante y va al primer hueco libre', () => {
    const c = edicion()
    const b = borradorDeZona(c, salonDe(c))
    const nombres = c.mesas.map((m) => m.nombre)
    const mesa = nuevaMesa(b, 'rectangular', nombres)
    expect(mesa).toMatchObject({ nombre: '3', ancho: 160, alto: 80, capacidad: 6, rotacion: 0 })
    // En el primer hueco libre de la fila, a 40 cm de la mesa 2 (que termina en x = 200).
    expect(mesa).toMatchObject({ x: 240, y: 0 })
    b.mesas.push(mesa)
    const [cambio] = cambiosDeZona(c, b)
    expect(cambio).toMatchObject({
      entidad: 'mesa',
      id: mesa.id,
      datos: { zona_id: b.id, nombre: '3', forma: 'rectangular', capacidad: 6, activo: true },
    })
  })

  it('siguienteNombre salta los usados sin importar mayúsculas', () => {
    expect(siguienteNombre(['1', '2', '4'])).toBe('3')
    expect(siguienteNombre([])).toBe('1')
  })

  it('un elemento de texto lleva su texto; los demás, null', () => {
    const c = edicion()
    const b = borradorDeZona(c, salonDe(c))
    const t = nuevoElemento(b, 'texto')
    const p = nuevoElemento(b, 'puerta')
    b.elementos.push({ ...t, texto: ' Baños ' }, p)
    const cambios = cambiosDeZona(c, b)
    expect(cambios.find((x) => x.id === t.id)?.datos.texto).toBe('Baños')
    expect(cambios.find((x) => x.id === p.id)?.datos.texto).toBeNull()
  })

  it('quitar una mesa la archiva; una nueva quitada antes de guardar no viaja', () => {
    const c = edicion()
    const b = borradorDeZona(c, salonDe(c))
    const [primera] = b.mesas
    if (!primera) throw new Error('falta')
    b.mesas = b.mesas.map((m) => (m.id === primera.id ? { ...m, activo: false } : m))
    b.mesas.push({ ...nuevaMesa(b, 'cuadrada', []), activo: false })
    expect(cambiosDeZona(c, b)).toEqual([
      { entidad: 'mesa', id: primera.id, datos: { activo: false } },
    ])
  })

  it('archivar la zona archiva antes sus mesas y elementos (el hub no deja una zona con mesas)', () => {
    const c = edicion()
    const b = { ...borradorDeZona(c, salonDe(c)), activo: false }
    const cambios = cambiosDeZona(c, b)
    expect(cambios.map((x) => x.entidad)).toEqual(['mesa', 'mesa', 'elemento_plano', 'zona'])
    expect(cambios.every((x) => x.datos.activo === false)).toBe(true)
  })

  it('una zona nueva va antes que sus mesas', () => {
    const c = edicion()
    const b = zonaNueva(c)
    b.nombre = 'Segundo piso'
    b.piso = 2
    b.mesas.push(nuevaMesa(b, 'cuadrada', ['1']))
    const cambios = cambiosDeZona(c, b)
    expect(cambios[0]).toEqual({
      entidad: 'zona',
      id: b.id,
      datos: { nombre: 'Segundo piso', piso: 2, orden: 2, activo: true },
    })
    expect(cambios[1]?.entidad).toBe('mesa')
  })

  it('no deja dos mesas con el mismo nombre, tampoco entre zonas', () => {
    const c = edicion()
    const b = borradorDeZona(c, salonDe(c))
    expect(problemasDeZona(c, b)).toEqual([])
    b.mesas.push({ ...nuevaMesa(b, 'cuadrada', []), nombre: '10' })
    expect(problemasDeZona(c, b)).toEqual(['Hay dos mesas que se llaman «10»'])
    b.nombre = ' '
    expect(problemasDeZona(c, b)[0]).toBe('Falta el nombre de la zona')
  })
})

describe('carta guardada por una versión anterior de la app', () => {
  it('se completa con lo que le falta en vez de romper la pantalla', () => {
    const vieja = {
      version: 3,
      restaurante: { nombre: 'X', sesionInactividadMin: 30 },
      zonas: [{ id: 'Z', nombre: 'Salón' }],
      mesas: [{ id: 'M', zonaId: 'Z', nombre: '1', x: 0, y: 0, forma: 'cuadrada', capacidad: 4 }],
      estaciones: [],
      categorias: [],
    } as unknown as Parameters<typeof completarCatalogo>[0]
    const c = completarCatalogo(vieja)
    expect(c.elementos).toEqual([])
    expect(c.personal).toEqual([])
    expect(c.zonas[0]?.piso).toBe(1)
    expect(c.mesas[0]).toMatchObject({ ancho: 80, alto: 80, rotacion: 0 })
  })
})

describe('varias mesas de una vez', () => {
  it('pone N mesas en filas, con números seguidos que no chocan con los usados', () => {
    const c = edicion()
    const b = { ...zonaNueva(c), nombre: 'Patio' }
    const mesas = variasMesas(b, 'cuadrada', 7, 3, ['1', '2', '4'])
    expect(mesas.map((m) => m.nombre)).toEqual(['3', '5', '6', '7', '8', '9', '10'])
    expect(new Set(mesas.map((m) => m.y)).size).toBe(3)
    expect(mesas.filter((m) => m.y === mesas[0]?.y)).toHaveLength(3)
    // Ninguna encima de otra.
    expect(new Set(mesas.map((m) => `${m.x},${m.y}`)).size).toBe(7)
    expect(mesas.every((m) => m.x % 10 === 0 && m.y % 10 === 0)).toBe(true)
  })
})
