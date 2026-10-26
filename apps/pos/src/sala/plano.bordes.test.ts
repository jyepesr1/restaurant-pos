import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type CatalogoEdicion, completarCatalogo, completarEdicion } from './motor'
import {
  type BorradorZona,
  borradorDeZona,
  cambiosDeZona,
  FORMAS,
  nuevaMesa,
  problemasDeZona,
  variasMesas,
  zonaNueva,
} from './plano'

// Bordes del plano (tarea 1.2): varias mesas de una vez y qué hace el editor con un catálogo de
// edición sin zonas. Semilla fija.

const SEMILLA = 20_261_024
const vacia = (): CatalogoEdicion => ({
  version: 0,
  zones: [],
  tables: [],
  elements: [],
  taxes: [],
  stations: [],
  categories: [],
  products: [],
  variants: [],
  groups: [],
  links: [],
  modifiers: [],
})
const formas = Object.keys(FORMAS) as (keyof typeof FORMAS)[]

describe('variasMesas', () => {
  it('cuenta, nombres seguidos que no chocan, cuadrícula y sin encimarse', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...formas),
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 1, max: 15 }),
        fc.array(fc.integer({ min: 1, max: 80 }).map(String), { maxLength: 20 }),
        fc.integer({ min: 0, max: 5 }),
        (shape, quantity, porFila, usados, previas) => {
          const b = zonaNueva(vacia())
          for (let i = 0; i < previas; i++)
            b.tables.push(
              nuevaMesa(
                b,
                'round',
                b.tables.map((m) => m.name),
              ),
            )
          const newOnes = variasMesas(b, shape, quantity, porFila, usados)
          expect(newOnes).toHaveLength(quantity)
          const names = newOnes.map((m) => m.name)
          expect(new Set(names).size).toBe(quantity)
          for (const n of names) expect(usados).not.toContain(n)
          // Los más chicos libres, en orden creciente.
          expect(names.map(Number)).toEqual([...names.map(Number)].sort((a, c) => a - c))
          for (const m of newOnes) {
            expect(m.x % 10).toBe(0)
            expect(m.y % 10).toBe(0)
            expect(m.fresh && m.active).toBe(true)
          }
          expect(new Set(newOnes.map((m) => m.y)).size).toBe(Math.ceil(quantity / porFila))
          // Ninguna encima de otra ni de lo que había.
          const allRows = [...b.tables, ...newOnes]
          for (const [i, a] of allRows.entries())
            for (const c of allRows.slice(i + 1))
              expect(
                a.x < c.x + c.width &&
                  c.x < a.x + a.width &&
                  a.y < c.y + c.height &&
                  c.y < a.y + a.height,
              ).toBe(false)
        },
      ),
      { seed: SEMILLA, numRuns: 200 },
    )
  })

  it('cero mesas da una lista vacía', () => {
    expect(variasMesas(zonaNueva(vacia()), 'square', 0, 5, [])).toEqual([])
  })

  it('una fila de una sola mesa por fila apila hacia abajo', () => {
    const m = variasMesas(zonaNueva(vacia()), 'square', 3, 1, [])
    expect(new Set(m.map((x) => x.x)).size).toBe(1)
    expect(new Set(m.map((x) => x.y)).size).toBe(3)
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: Baja prioridad: la pantalla limita "Por
  // fila" a 1..20, pero `variasMesas(…, 0, …)` da x = NaN (división entre cero).
  it('con porFila 0 las mesas no quedan con coordenadas inválidas', () => {
    // Un campo vacío en la pantalla podría dar 0: ninguna posición debe ser NaN o infinita.
    const m = variasMesas(zonaNueva(vacia()), 'square', 3, 0, [])
    for (const x of m) {
      expect(Number.isFinite(x.x)).toBe(true)
      expect(Number.isFinite(x.y)).toBe(true)
    }
  })

  it('las mesas de varias a la vez se guardan juntas en una sola edición', () => {
    const c = vacia()
    const b: BorradorZona = { ...zonaNueva(c), name: 'Patio' }
    b.tables.push(...variasMesas(b, 'round', 12, 4, []))
    expect(problemasDeZona(c, b)).toEqual([])
    const changes = cambiosDeZona(c, b)
    expect(changes).toHaveLength(13)
    expect(changes[0]?.entity).toBe('zones')
  })
})

describe('el editor ante un catálogo de edición sin zonas', () => {
  // `PlanoEditor.abrirZona` toma la primera zona activa o, si no hay, arma una nueva llamada
  // «Salón». Aquí se comprueba esa lógica con las funciones de `plano.ts`.
  const open = (c: CatalogoEdicion) => {
    const zone = c.zones.find((z) => z.active)
    return zone ? borradorDeZona(c, zone.id) : { ...zonaNueva(c), name: 'Salón' }
  }

  it('sin zonas arma un «Salón» nuevo, vacío, que no se puede guardar sin tocar', () => {
    const c = vacia()
    const b = open(c)
    expect(b).toMatchObject({
      fresh: true,
      name: 'Salón',
      position: 0,
      level: 1,
      tables: [],
      elements: [],
    })
    expect(problemasDeZona(c, b)).toEqual([])
    // «Sucio» lo decide la pantalla por mesas/elementos/nombre distinto del inicial: aquí hay
    // 0 mesas y el nombre es el inicial.
    expect(b.tables.length + b.elements.length).toBe(0)
  })

  it('con una mesa puesta, guardar crea la zona antes que la mesa', () => {
    const c = vacia()
    const b = open(c)
    b.tables.push(nuevaMesa(b, 'square', []))
    const changes = cambiosDeZona(c, b)
    expect(changes.map((x) => x.entity)).toEqual(['zones', 'dining_tables'])
    expect(changes[0]?.data).toEqual({ name: 'Salón', level: 1, position: 0, active: true })
  })

  it('con todas las zonas archivadas también arma una nueva, sin abrir la archivada', () => {
    const c = vacia()
    c.zones.push({ id: 'Z', version: 3, active: false, name: 'Vieja', position: 0, level: 1 })
    const b = open(c)
    expect(b.fresh).toBe(true)
    expect(b.position).toBe(1)
    expect(() => borradorDeZona(c, 'Z')).not.toThrow()
  })

  it('pedir el borrador de una zona que no existe lanza un error claro', () => {
    expect(() => borradorDeZona(vacia(), 'NO-EXISTE')).toThrow('Esa zona no existe')
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: Un hub más viejo que la app (o una
  // respuesta cortada) puede no traer `zonas` ni `elementos`. `catalogoParaEditar` no pasa por
  // `completarCatalogo`, así que el editor mostraría el mensaje técnico del navegador en vez de
  // abrir un plano en blanco.
  it('un catálogo de edición sin las claves del plano se trata como uno vacío', () => {
    // Lo que hace `Sala.catalogoParaEditar` con la respuesta del hub antes de dársela al editor.
    const sinPlano = completarEdicion({ version: 3, taxes: [], categories: [] })
    expect(() => open(sinPlano)).not.toThrow()
    expect(() => zonaNueva(sinPlano)).not.toThrow()
  })
})

describe('completarCatalogo', () => {
  const buena = {
    version: 9,
    restaurant: { name: 'X', sesionInactividadMin: 30 },
    zones: [{ id: 'Z', name: 'Salón', level: 2 }],
    tables: [
      {
        id: 'M',
        zonaId: 'Z',
        name: '1',
        x: 10,
        y: 20,
        width: 100,
        height: 60,
        rotation: 45,
        shape: 'round',
        capacity: 2,
      },
    ],
    elements: [
      {
        id: 'E',
        zonaId: 'Z',
        type: 'wall',
        text: null,
        x: 0,
        y: 0,
        width: 300,
        height: 20,
        rotation: 0,
      },
    ],
    staff: [{ id: 'U', name: 'Ana' }],
    stations: [],
    categories: [],
  } as unknown as Parameters<typeof completarCatalogo>[0]

  it('una carta completa queda igual y no se modifica el original', () => {
    const copy = structuredClone(buena)
    expect(completarCatalogo(buena)).toEqual(buena)
    expect(buena).toEqual(copy)
  })

  it('es idempotente y respeta ceros (rotación 0, ancho 0 no se cambian por el valor por defecto)', () => {
    const vieja = {
      ...buena,
      tables: [{ ...(buena.tables[0] as object), width: 0, height: 0, rotation: 0 }],
    } as unknown as typeof buena
    const makeOne = completarCatalogo(vieja)
    expect(makeOne.tables[0]).toMatchObject({ width: 0, height: 0, rotation: 0 })
    expect(completarCatalogo(makeOne)).toEqual(makeOne)
  })

  it('completa solo lo que falta, mesa por mesa', () => {
    const mixta = {
      ...buena,
      zones: [
        { id: 'A', name: 'A' },
        { id: 'B', name: 'B', level: 3 },
      ],
      tables: [
        { id: '1', zonaId: 'A', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 },
        {
          id: '2',
          zonaId: 'B',
          name: '2',
          x: 0,
          y: 0,
          width: 200,
          height: 50,
          rotation: 90,
          shape: 'bar',
          capacity: 1,
        },
      ],
    } as unknown as typeof buena
    const c = completarCatalogo(mixta)
    expect(c.zones.map((z) => z.level)).toEqual([1, 3])
    expect(c.tables[0]).toMatchObject({ width: 80, height: 80, rotation: 0 })
    expect(c.tables[1]).toMatchObject({ width: 200, height: 50, rotation: 90 })
  })

  it('valores null (de un guardado raro) también se completan', () => {
    const odd = {
      ...buena,
      zones: null,
      tables: [
        {
          id: '1',
          zonaId: 'A',
          name: '1',
          x: 0,
          y: 0,
          width: null,
          height: null,
          rotation: null,
          shape: 'square',
          capacity: 4,
        },
      ],
      elements: null,
      staff: null,
    } as unknown as typeof buena
    const c = completarCatalogo(odd)
    expect(c.zones).toEqual([])
    expect(c.elements).toEqual([])
    expect(c.staff).toEqual([])
    expect(c.tables[0]).toMatchObject({ width: 80, height: 80, rotation: 0 })
  })
})
