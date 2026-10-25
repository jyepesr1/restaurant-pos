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
  zonas: [],
  mesas: [],
  elementos: [],
  impuestos: [],
  estaciones: [],
  categorias: [],
  productos: [],
  variantes: [],
  grupos: [],
  enlaces: [],
  modificadores: [],
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
        (forma, cantidad, porFila, usados, previas) => {
          const b = zonaNueva(vacia())
          for (let i = 0; i < previas; i++)
            b.mesas.push(
              nuevaMesa(
                b,
                'redonda',
                b.mesas.map((m) => m.nombre),
              ),
            )
          const nuevas = variasMesas(b, forma, cantidad, porFila, usados)
          expect(nuevas).toHaveLength(cantidad)
          const nombres = nuevas.map((m) => m.nombre)
          expect(new Set(nombres).size).toBe(cantidad)
          for (const n of nombres) expect(usados).not.toContain(n)
          // Los más chicos libres, en orden creciente.
          expect(nombres.map(Number)).toEqual([...nombres.map(Number)].sort((a, c) => a - c))
          for (const m of nuevas) {
            expect(m.x % 10).toBe(0)
            expect(m.y % 10).toBe(0)
            expect(m.nuevo && m.activo).toBe(true)
          }
          expect(new Set(nuevas.map((m) => m.y)).size).toBe(Math.ceil(cantidad / porFila))
          // Ninguna encima de otra ni de lo que había.
          const todas = [...b.mesas, ...nuevas]
          for (const [i, a] of todas.entries())
            for (const c of todas.slice(i + 1))
              expect(
                a.x < c.x + c.ancho &&
                  c.x < a.x + a.ancho &&
                  a.y < c.y + c.alto &&
                  c.y < a.y + a.alto,
              ).toBe(false)
        },
      ),
      { seed: SEMILLA, numRuns: 200 },
    )
  })

  it('cero mesas da una lista vacía', () => {
    expect(variasMesas(zonaNueva(vacia()), 'cuadrada', 0, 5, [])).toEqual([])
  })

  it('una fila de una sola mesa por fila apila hacia abajo', () => {
    const m = variasMesas(zonaNueva(vacia()), 'cuadrada', 3, 1, [])
    expect(new Set(m.map((x) => x.x)).size).toBe(1)
    expect(new Set(m.map((x) => x.y)).size).toBe(3)
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: Baja prioridad: la pantalla limita "Por
  // fila" a 1..20, pero `variasMesas(…, 0, …)` da x = NaN (división entre cero).
  it('con porFila 0 las mesas no quedan con coordenadas inválidas', () => {
    // Un campo vacío en la pantalla podría dar 0: ninguna posición debe ser NaN o infinita.
    const m = variasMesas(zonaNueva(vacia()), 'cuadrada', 3, 0, [])
    for (const x of m) {
      expect(Number.isFinite(x.x)).toBe(true)
      expect(Number.isFinite(x.y)).toBe(true)
    }
  })

  it('las mesas de varias a la vez se guardan juntas en una sola edición', () => {
    const c = vacia()
    const b: BorradorZona = { ...zonaNueva(c), nombre: 'Patio' }
    b.mesas.push(...variasMesas(b, 'redonda', 12, 4, []))
    expect(problemasDeZona(c, b)).toEqual([])
    const cambios = cambiosDeZona(c, b)
    expect(cambios).toHaveLength(13)
    expect(cambios[0]?.entidad).toBe('zona')
  })
})

describe('el editor ante un catálogo de edición sin zonas', () => {
  // `PlanoEditor.abrirZona` toma la primera zona activa o, si no hay, arma una nueva llamada
  // «Salón». Aquí se comprueba esa lógica con las funciones de `plano.ts`.
  const abrir = (c: CatalogoEdicion) => {
    const zona = c.zonas.find((z) => z.activo)
    return zona ? borradorDeZona(c, zona.id) : { ...zonaNueva(c), nombre: 'Salón' }
  }

  it('sin zonas arma un «Salón» nuevo, vacío, que no se puede guardar sin tocar', () => {
    const c = vacia()
    const b = abrir(c)
    expect(b).toMatchObject({
      nuevo: true,
      nombre: 'Salón',
      orden: 0,
      piso: 1,
      mesas: [],
      elementos: [],
    })
    expect(problemasDeZona(c, b)).toEqual([])
    // «Sucio» lo decide la pantalla por mesas/elementos/nombre distinto del inicial: aquí hay
    // 0 mesas y el nombre es el inicial.
    expect(b.mesas.length + b.elementos.length).toBe(0)
  })

  it('con una mesa puesta, guardar crea la zona antes que la mesa', () => {
    const c = vacia()
    const b = abrir(c)
    b.mesas.push(nuevaMesa(b, 'cuadrada', []))
    const cambios = cambiosDeZona(c, b)
    expect(cambios.map((x) => x.entidad)).toEqual(['zona', 'mesa'])
    expect(cambios[0]?.datos).toEqual({ nombre: 'Salón', piso: 1, orden: 0, activo: true })
  })

  it('con todas las zonas archivadas también arma una nueva, sin abrir la archivada', () => {
    const c = vacia()
    c.zonas.push({ id: 'Z', version: 3, activo: false, nombre: 'Vieja', orden: 0, piso: 1 })
    const b = abrir(c)
    expect(b.nuevo).toBe(true)
    expect(b.orden).toBe(1)
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
    const sinPlano = completarEdicion({ version: 3, impuestos: [], categorias: [] })
    expect(() => abrir(sinPlano)).not.toThrow()
    expect(() => zonaNueva(sinPlano)).not.toThrow()
  })
})

describe('completarCatalogo', () => {
  const buena = {
    version: 9,
    restaurante: { nombre: 'X', sesionInactividadMin: 30 },
    zonas: [{ id: 'Z', nombre: 'Salón', piso: 2 }],
    mesas: [
      {
        id: 'M',
        zonaId: 'Z',
        nombre: '1',
        x: 10,
        y: 20,
        ancho: 100,
        alto: 60,
        rotacion: 45,
        forma: 'redonda',
        capacidad: 2,
      },
    ],
    elementos: [
      {
        id: 'E',
        zonaId: 'Z',
        tipo: 'pared',
        texto: null,
        x: 0,
        y: 0,
        ancho: 300,
        alto: 20,
        rotacion: 0,
      },
    ],
    personal: [{ id: 'U', nombre: 'Ana' }],
    estaciones: [],
    categorias: [],
  } as unknown as Parameters<typeof completarCatalogo>[0]

  it('una carta completa queda igual y no se modifica el original', () => {
    const copia = structuredClone(buena)
    expect(completarCatalogo(buena)).toEqual(buena)
    expect(buena).toEqual(copia)
  })

  it('es idempotente y respeta ceros (rotación 0, ancho 0 no se cambian por el valor por defecto)', () => {
    const vieja = {
      ...buena,
      mesas: [{ ...(buena.mesas[0] as object), ancho: 0, alto: 0, rotacion: 0 }],
    } as unknown as typeof buena
    const una = completarCatalogo(vieja)
    expect(una.mesas[0]).toMatchObject({ ancho: 0, alto: 0, rotacion: 0 })
    expect(completarCatalogo(una)).toEqual(una)
  })

  it('completa solo lo que falta, mesa por mesa', () => {
    const mixta = {
      ...buena,
      zonas: [
        { id: 'A', nombre: 'A' },
        { id: 'B', nombre: 'B', piso: 3 },
      ],
      mesas: [
        { id: '1', zonaId: 'A', nombre: '1', x: 0, y: 0, forma: 'cuadrada', capacidad: 4 },
        {
          id: '2',
          zonaId: 'B',
          nombre: '2',
          x: 0,
          y: 0,
          ancho: 200,
          alto: 50,
          rotacion: 90,
          forma: 'barra',
          capacidad: 1,
        },
      ],
    } as unknown as typeof buena
    const c = completarCatalogo(mixta)
    expect(c.zonas.map((z) => z.piso)).toEqual([1, 3])
    expect(c.mesas[0]).toMatchObject({ ancho: 80, alto: 80, rotacion: 0 })
    expect(c.mesas[1]).toMatchObject({ ancho: 200, alto: 50, rotacion: 90 })
  })

  it('valores null (de un guardado raro) también se completan', () => {
    const raro = {
      ...buena,
      zonas: null,
      mesas: [
        {
          id: '1',
          zonaId: 'A',
          nombre: '1',
          x: 0,
          y: 0,
          ancho: null,
          alto: null,
          rotacion: null,
          forma: 'cuadrada',
          capacidad: 4,
        },
      ],
      elementos: null,
      personal: null,
    } as unknown as typeof buena
    const c = completarCatalogo(raro)
    expect(c.zonas).toEqual([])
    expect(c.elementos).toEqual([])
    expect(c.personal).toEqual([])
    expect(c.mesas[0]).toMatchObject({ ancho: 80, alto: 80, rotacion: 0 })
  })
})
