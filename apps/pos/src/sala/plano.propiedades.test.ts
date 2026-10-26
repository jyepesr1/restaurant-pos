import { newId } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CambioCatalogo, CatalogoEdicion, FormaMesa, Geometria, TipoElemento } from './motor'
import {
  ajustar,
  type BorradorZona,
  borradorDeZona,
  CUADRICULA,
  cambiosDeZona,
  FORMAS,
  limites,
  MEDIDA_MINIMA,
  measure,
  move,
  nuevaMesa,
  nuevoElemento,
  problemasDeZona,
  rotate,
  siguienteNombre,
  TIPOS_ELEMENTO,
  zonaNueva,
} from './plano'

// Propiedades del plano (tarea 1.2). Semilla fija: determinista.
// - Mover, girar y medir (en cualquier orden) mantienen la cuadrícula y los límites que exige el
//   hub (`apps/hub/src/edicion-catalogo.ts`).
// - Aplicar al catálogo los cambios de una zona deja un borrador igual al editado.
// - `limites` contiene las cuatro esquinas de cada figura, girada o no.
// - `siguienteNombre` da el menor número libre.

const SEMILLA = 20_261_024
const CORRIDAS = 300

// ── Geometría ────────────────────────────────────────────────────────────────────────────────

const LIMITE = 10_000
const enCuadricula = (n: number) => Math.abs(n % CUADRICULA) === 0
const geometriaValida = (g: Geometria) =>
  Number.isInteger(g.x) &&
  Number.isInteger(g.y) &&
  g.x >= -LIMITE &&
  g.x <= LIMITE &&
  g.y >= -LIMITE &&
  g.y <= LIMITE &&
  Number.isInteger(g.width) &&
  Number.isInteger(g.height) &&
  g.width >= MEDIDA_MINIMA &&
  g.width <= LIMITE &&
  g.height >= MEDIDA_MINIMA &&
  g.height <= LIMITE &&
  Number.isInteger(g.rotation) &&
  g.rotation >= 0 &&
  g.rotation <= 359

const arbGeometria: fc.Arbitrary<Geometria> = fc.record({
  x: fc.integer({ min: -LIMITE, max: LIMITE }).map((n) => ajustar(n)),
  y: fc.integer({ min: -LIMITE, max: LIMITE }).map((n) => ajustar(n)),
  width: fc.integer({ min: 2, max: 1000 }).map((n) => Math.max(MEDIDA_MINIMA, ajustar(n * 5))),
  height: fc.integer({ min: 2, max: 1000 }).map((n) => Math.max(MEDIDA_MINIMA, ajustar(n * 5))),
  rotation: fc.integer({ min: 0, max: 359 }),
})
// Valores de pantalla: con decimales, negativos y absurdos.
const arbPantalla = fc.oneof(
  fc.double({ min: -50_000, max: 50_000, noNaN: true }),
  fc.integer({ min: -50_000, max: 50_000 }),
  fc.constantFrom(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, 4.99, 5, 5.01),
)

type Orden =
  | { t: 'move'; x: number; y: number }
  | { t: 'rotate'; g: number }
  | { t: 'measure'; a: number; h: number }
const arbOrden: fc.Arbitrary<Orden> = fc.oneof(
  fc.record({ t: fc.constant('move' as const), x: arbPantalla, y: arbPantalla }),
  fc.record({
    t: fc.constant('rotate' as const),
    g: fc.constantFrom(-90, -15, 15, 45, 90, 180, 360, -360, 1000),
  }),
  fc.record({ t: fc.constant('measure' as const), a: arbPantalla, h: arbPantalla }),
)
const hacer = (g: Geometria, o: Orden): Geometria =>
  o.t === 'move' ? move(g, o.x, o.y) : o.t === 'rotate' ? rotate(g, o.g) : measure(g, o.a, o.h)

describe('mover, girar y medir', () => {
  it('cualquier secuencia deja la figura en la cuadrícula, dentro de los límites y con medidas enteras', () => {
    fc.assert(
      fc.property(arbGeometria, fc.array(arbOrden, { maxLength: 12 }), (g0, ordenes) => {
        let g = g0
        for (const o of ordenes) {
          g = hacer(g, o)
          expect(geometriaValida(g)).toBe(true)
        }
        if (ordenes.some((o) => o.t === 'move')) {
          expect(enCuadricula(g.x)).toBe(true)
          expect(enCuadricula(g.y)).toBe(true)
        }
        if (ordenes.some((o) => o.t === 'measure')) {
          expect(enCuadricula(g.width)).toBe(true)
          expect(enCuadricula(g.height)).toBe(true)
        }
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('cada operación solo toca lo suyo', () => {
    fc.assert(
      fc.property(arbGeometria, arbPantalla, arbPantalla, (g, a, b) => {
        const movida = move(g, a, b)
        expect([movida.width, movida.height, movida.rotation]).toEqual([
          g.width,
          g.height,
          g.rotation,
        ])
        const medida = measure(g, a, b)
        expect([medida.x, medida.y, medida.rotation]).toEqual([g.x, g.y, g.rotation])
        const girada = rotate(g, 90)
        expect([girada.x, girada.y, girada.width, girada.height]).toEqual([
          g.x,
          g.y,
          g.width,
          g.height,
        ])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('mover y medir son idempotentes: repetir con el resultado no cambia nada', () => {
    fc.assert(
      fc.property(arbGeometria, arbPantalla, arbPantalla, (g, a, b) => {
        const m = move(g, a, b)
        expect(move(m, m.x, m.y)).toEqual(m)
        const t = measure(g, a, b)
        expect(measure(t, t.width, t.height)).toEqual(t)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('un punto de la cuadrícula dentro del salón se queda donde está', () => {
    fc.assert(
      fc.property(arbGeometria, (g) => {
        expect(move(g, g.x, g.y)).toEqual(g)
        expect(measure(g, g.width, g.height)).toEqual(g)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('girar suma módulo 360: dar la vuelta entera vuelve al mismo ángulo', () => {
    fc.assert(
      fc.property(
        arbGeometria,
        fc.integer({ min: -2000, max: 2000 }),
        fc.integer({ min: -2000, max: 2000 }),
        (g, a, b) => {
          expect(rotate(rotate(g, a), b).rotation).toBe(rotate(g, a + b).rotation)
          expect(rotate(g, 360).rotation).toBe(g.rotation)
          expect(rotate(rotate(g, a), -a).rotation).toBe(g.rotation)
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('arrastrar a un lugar absurdo se frena en el borde del salón', () => {
    const g = { x: 0, y: 0, width: 80, height: 80, rotation: 0 }
    expect(move(g, 1e12, -1e12)).toMatchObject({ x: LIMITE, y: -LIMITE })
    expect(move(g, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toMatchObject({
      x: LIMITE,
      y: -LIMITE,
    })
    expect(measure(g, 1e12, -5)).toMatchObject({ width: LIMITE, height: MEDIDA_MINIMA })
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: `mover` y `medir` dejan pasar NaN
  // (Math.round(NaN) = NaN y Math.min/max lo propagan). El editor no lo produce hoy (se detiene con
  // escala 0), pero un NaN guardado en el borrador viajaría como null y el hub rechazaría todo el
  // guardado.
  it('un número de pantalla que no es número (NaN) no se cuela como posición ni medida', () => {
    const g = { x: 0, y: 0, width: 80, height: 80, rotation: 0 }
    expect(Number.isFinite(move(g, Number.NaN, 0).x)).toBe(true)
    expect(Number.isFinite(measure(g, Number.NaN, 0).width)).toBe(true)
  })
})

// ── limites ──────────────────────────────────────────────────────────────────────────────────

/** Las cuatro esquinas de una figura, giradas alrededor de su centro. */
function esquinas(g: Geometria) {
  const cx = g.x + g.width / 2
  const cy = g.y + g.height / 2
  const rad = (g.rotation * Math.PI) / 180
  return [
    [-g.width / 2, -g.height / 2],
    [g.width / 2, -g.height / 2],
    [g.width / 2, g.height / 2],
    [-g.width / 2, g.height / 2],
  ].map(([dx, dy]) => ({
    x: cx + (dx as number) * Math.cos(rad) - (dy as number) * Math.sin(rad),
    y: cy + (dx as number) * Math.sin(rad) + (dy as number) * Math.cos(rad),
  }))
}

const arbFigura: fc.Arbitrary<Geometria> = fc.record({
  x: fc.integer({ min: -2000, max: 2000 }),
  y: fc.integer({ min: -2000, max: 2000 }),
  width: fc.integer({ min: 20, max: 600 }),
  height: fc.integer({ min: 20, max: 600 }),
  rotation: fc.integer({ min: 0, max: 359 }),
})
const EPS = 1e-6

describe('limites', () => {
  it('contiene las cuatro esquinas de cada figura, con cualquier giro, más el margen', () => {
    fc.assert(
      fc.property(
        fc.array(arbFigura, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 200 }),
        (figuras, margen) => {
          const register = limites(figuras, margen)
          for (const f of figuras)
            for (const p of esquinas(f)) {
              expect(p.x).toBeGreaterThanOrEqual(register.x + margen - EPS)
              expect(p.y).toBeGreaterThanOrEqual(register.y + margen - EPS)
              expect(p.x).toBeLessThanOrEqual(register.x + register.width - margen + EPS)
              expect(p.y).toBeLessThanOrEqual(register.y + register.height - margen + EPS)
            }
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('sin giro (0° y 180°) es exacta: ni un centímetro de sobra', () => {
    fc.assert(
      fc.property(
        fc.array(
          arbFigura.map((f) => ({ ...f, rotation: 0 })),
          { minLength: 1, maxLength: 8 },
        ),
        fc.constantFrom(0, 180),
        (figuras, giro) => {
          const g = figuras.map((f) => ({ ...f, rotation: giro }))
          const register = limites(g, 0)
          expect(register.x).toBe(Math.min(...g.map((f) => f.x)))
          expect(register.y).toBe(Math.min(...g.map((f) => f.y)))
          expect(register.x + register.width).toBe(Math.max(...g.map((f) => f.x + f.width)))
          expect(register.y + register.height).toBe(Math.max(...g.map((f) => f.y + f.height)))
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('agregar una figura nunca achica la caja; el margen suma el doble al ancho y al alto', () => {
    fc.assert(
      fc.property(
        fc.array(arbFigura, { minLength: 1, maxLength: 6 }),
        arbFigura,
        (figuras, another) => {
          const before = limites(figuras, 0)
          const after = limites([...figuras, another], 0)
          expect(after.x).toBeLessThanOrEqual(before.x + EPS)
          expect(after.y).toBeLessThanOrEqual(before.y + EPS)
          expect(after.x + after.width).toBeGreaterThanOrEqual(before.x + before.width - EPS)
          expect(after.y + after.height).toBeGreaterThanOrEqual(before.y + before.height - EPS)
          const conMargen = limites(figuras, 40)
          expect(conMargen.width).toBeCloseTo(before.width + 80)
          expect(conMargen.height).toBeCloseTo(before.height + 80)
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('el orden de las figuras no importa', () => {
    fc.assert(
      fc.property(fc.array(arbFigura, { minLength: 1, maxLength: 8 }), (figuras) => {
        expect(limites([...figuras].reverse())).toEqual(limites(figuras))
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('una larga y delgada girada 90° ocupa más que la medida de su lado (se toma el círculo)', () => {
    // 300×20 a 90°: lo exacto serían 20 de ancho y 300 de alto; `limites` es conservador.
    const register = limites([{ x: 0, y: 0, width: 300, height: 20, rotation: 90 }], 0)
    expect(register.height).toBeGreaterThanOrEqual(300)
    expect(register.width).toBeGreaterThanOrEqual(20)
    // Y es la misma para 90° y 270°.
    expect(limites([{ x: 0, y: 0, width: 300, height: 20, rotation: 270 }], 0)).toEqual(register)
  })

  it('sin figuras da un plano en blanco de tamaño fijo, con o sin margen', () => {
    expect(limites([])).toEqual({ x: 0, y: 0, width: 600, height: 400 })
    expect(limites([], 500)).toEqual(limites([], 0))
  })
})

// ── siguienteNombre ──────────────────────────────────────────────────────────────────────────

describe('siguienteNombre', () => {
  it('es el menor número entero positivo que ningún nombre usa (sin mayúsculas ni espacios)', () => {
    const arbNombre = fc.oneof(
      fc.integer({ min: 1, max: 40 }).map(String),
      fc.integer({ min: 1, max: 40 }).map((n) => ` ${n} `),
      fc.stringMatching(/^[A-Za-z]{1,6}[0-9]{0,2}$/),
      fc.constantFrom('', '0', '-1', '01', '1.5', 'Terraza 1'),
    )
    fc.assert(
      fc.property(fc.array(arbNombre, { maxLength: 60 }), (names) => {
        const n = siguienteNombre(names)
        expect(n).toMatch(/^[1-9][0-9]*$/)
        const usados = new Set(names.map((x) => x.trim().toLowerCase()))
        expect(usados.has(n)).toBe(false)
        for (let k = 1; k < Number(n); k++) expect(usados.has(String(k))).toBe(true)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('casos concretos', () => {
    expect(siguienteNombre([])).toBe('1')
    expect(siguienteNombre(['2', '3'])).toBe('1')
    expect(siguienteNombre(['1', '2', '3'])).toBe('4')
    expect(siguienteNombre([' 1 ', '2'])).toBe('3')
    expect(siguienteNombre(['A1', '1a', '01', '0', '-1'])).toBe('1')
    expect(siguienteNombre(Array.from({ length: 500 }, (_, i) => String(i + 1)))).toBe('501')
  })
})

// ── Un salón que se llena ────────────────────────────────────────────────────────────────────

const cruzan = (a: Geometria, b: Omit<Geometria, 'rotation'>) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('lugarLibre: poner mesas y elementos nuevos en un salón que se llena', () => {
  const FORMAS_MESA = Object.keys(FORMAS) as FormaMesa[]
  const TYPES = Object.keys(TIPOS_ELEMENTO) as TipoElemento[]

  function llenar(
    veces: { table: FormaMesa } | { element: TipoElemento },
    n: number,
    b = zonaNueva({ zones: [] } as unknown as CatalogoEdicion),
  ) {
    for (let i = 0; i < n; i++) {
      if ('table' in veces)
        b.tables.push(
          nuevaMesa(
            b,
            veces.table,
            b.tables.map((m) => m.name),
          ),
        )
      else b.elements.push(nuevoElemento(b, veces.element))
    }
    return b
  }

  it('lo primero va al origen', () => {
    const b = zonaNueva({ zones: [] } as unknown as CatalogoEdicion)
    expect(nuevaMesa(b, 'square', [])).toMatchObject({ x: 0, y: 0 })
    expect(nuevoElemento(b, 'wall')).toMatchObject({ x: 0, y: 0 })
  })

  it('lo nuevo nunca se encima con lo que ya hay, en la cuadrícula y dentro del salón', () => {
    const arbPaso = fc.oneof(
      fc.constantFrom(...FORMAS_MESA).map((shape) => ({ table: shape })),
      fc.constantFrom(...TYPES).map((type) => ({ element: type })),
    )
    fc.assert(
      fc.property(
        fc.array(arbPaso, { minLength: 1, maxLength: 40 }),
        fc.array(arbFigura, { maxLength: 4 }),
        (steps, previas) => {
          const b = zonaNueva({ zones: [] } as unknown as CatalogoEdicion)
          // Algo ya dibujado, quizá girado.
          for (const [i, f] of previas.entries())
            b.tables.push({
              ...nuevaMesa(b, 'square', []),
              ...f,
              id: newId(),
              name: `P${i}`,
              fresh: false,
            })
          for (const p of steps) {
            const before = [...b.tables, ...b.elements]
            const fresh =
              'table' in p
                ? nuevaMesa(
                    b,
                    p.table,
                    b.tables.map((m) => m.name),
                  )
                : nuevoElemento(b, p.element)
            expect(enCuadricula(fresh.x) && enCuadricula(fresh.y)).toBe(true)
            expect(Math.abs(fresh.x)).toBeLessThanOrEqual(LIMITE)
            expect(Math.abs(fresh.y)).toBeLessThanOrEqual(LIMITE)
            // Lo girado ocupa el círculo que lo contiene (como `limites`): el lugar nuevo debe
            // quedar fuera de la caja de `limites`, o sea, fuera de cualquier figura previa.
            for (const another of before) {
              const register = limites([another], 0)
              expect(cruzan(fresh, register)).toBe(false)
            }
            if ('table' in p) b.tables.push(fresh as (typeof b.tables)[number])
            else b.elements.push(fresh as (typeof b.elements)[number])
          }
        },
      ),
      { seed: SEMILLA, numRuns: 100 },
    )
  })

  it('pone varias mesas por fila hasta unos 15 m y luego baja a la fila siguiente', () => {
    const b = llenar({ table: 'round' }, 11)
    // Redondas de 90 cm con 40 de separación: 11 caben en una fila de 15 m.
    expect(new Set(b.tables.map((m) => m.y))).toEqual(new Set([0]))
    expect(Math.max(...b.tables.map((m) => m.x + m.width))).toBeLessThanOrEqual(1500)
    const next = nuevaMesa(
      b,
      'round',
      b.tables.map((m) => m.name),
    )
    expect(next.y).toBeGreaterThan(0)
    expect(next.x).toBe(0)
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: `lugarLibre` mide la caja de TODO lo
  // dibujado; en cuanto la primera fila llena el ancho habitual, la caja ya es más ancha que 1500 y
  // ninguna mesa más cabe "a la derecha": cada una baja a una fila nueva de a una, en una sola
  // columna.
  it('al llenarse, las filas siguientes también se llenan de a varias mesas, no de a una', () => {
    // 40 mesas redondas: con 11 por fila bastan 4 filas; no una columna de 30.
    const b = llenar({ table: 'round' }, 40)
    const rows = new Set(b.tables.map((m) => m.y)).size
    expect(rows).toBeLessThanOrEqual(6)
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: con ~78 mesas nuevas en una zona la
  // columna pasa de y = 10 000 y el hub rechaza todo el guardado ("y: Too big"), sin que la
  // pantalla lo avise antes.
  it('100 mesas nuevas en una zona caben dentro de los límites del salón que acepta el hub', () => {
    const b = llenar({ table: 'round' }, 100)
    for (const m of b.tables) {
      expect(Math.abs(m.x)).toBeLessThanOrEqual(LIMITE)
      expect(Math.abs(m.y)).toBeLessThanOrEqual(LIMITE)
    }
  })

  it('un elemento ancho que no cabe a la derecha baja de fila en vez de salirse del salón habitual', () => {
    const b = llenar({ element: 'wall' }, 1)
    const segunda = nuevoElemento(b, 'wall')
    b.elements.push(segunda)
    const tercera = nuevoElemento(b, 'wall')
    // 300 + 40 + 300 + 40 + 300 > 1500 no cabe una tercera en la misma fila.
    expect(segunda.y).toBe(0)
    expect(tercera.x + tercera.width).toBeLessThanOrEqual(1500)
  })

  it('lo archivado no ocupa lugar', () => {
    const b = llenar({ table: 'square' }, 5)
    for (const m of b.tables) m.active = false
    expect(nuevaMesa(b, 'square', [])).toMatchObject({ x: 0, y: 0 })
  })
})

// ── Guardar y volver a abrir ─────────────────────────────────────────────────────────────────

type Registro = Record<string, string | number | boolean | null>
const CAMPOS: Record<'zones' | 'dining_tables' | 'floor_plan_elements', string[]> = {
  zones: ['name', 'position', 'level', 'active'],
  dining_tables: [
    'zone_id',
    'name',
    'shape',
    'x',
    'y',
    'width',
    'height',
    'rotation',
    'capacity',
    'active',
  ],
  floor_plan_elements: [
    'zone_id',
    'type',
    'text',
    'x',
    'y',
    'width',
    'height',
    'rotation',
    'active',
  ],
}
const TABLA = { zones: 'zones', dining_tables: 'tables', floor_plan_elements: 'elements' } as const

const entero = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** Aplica los cambios como lo haría el hub (`edicion-catalogo.ts`); lanza si los rechazaría. */
function apply(source: CatalogoEdicion, enviados: CambioCatalogo[]): CatalogoEdicion {
  const c = structuredClone(source)
  // Viajan por la red como JSON (así -0 llega como 0).
  const changes: CambioCatalogo[] = JSON.parse(JSON.stringify(enviados))
  let version = c.version
  const tocados: {
    entity: 'zones' | 'dining_tables' | 'floor_plan_elements'
    id: string
    donde: string
  }[] = []
  const tabla = (e: keyof typeof TABLA) => c[TABLA[e]] as unknown as (Registro & { id: string })[]

  for (const [i, change] of changes.entries()) {
    const e = change.entity as keyof typeof TABLA
    const donde = `Cambio ${i + 1} (${e})`
    if (!(e in TABLA)) throw new Error(`${donde}: no es del plano`)
    const keys = Object.keys(change.data)
    if (keys.length === 0) throw new Error(`${donde}: no cambia nada`)
    for (const k of keys)
      if (!CAMPOS[e].includes(k)) throw new Error(`${donde}: campo ${k} no existe`)
    const zonaRef = change.data.zone_id
    if (typeof zonaRef === 'string' && !c.zones.some((z) => z.id === zonaRef))
      throw new Error(`${donde}: zone_id no existe`)
    const current = tabla(e).find((f) => f.id === change.id)
    if (!current) {
      for (const k of CAMPOS[e])
        if (!(k in change.data)) throw new Error(`${donde}: falta ${k} al crear`)
      tabla(e).push({ id: change.id, version: ++version, ...change.data } as Registro & {
        id: string
      })
    } else {
      const cambia = Object.entries(change.data).filter(([k, v]) => current[k] !== v)
      if (cambia.length !== keys.length) throw new Error(`${donde}: manda campos sin cambio`)
      Object.assign(current, change.data, { version: ++version })
    }
    const fila = tabla(e).find((f) => f.id === change.id) as Registro
    const badCase = (field: string) => {
      throw new Error(`${donde}: ${field} inválido (${String(fila[field])})`)
    }
    if (typeof fila.name === 'string') {
      const max = e === 'zones' ? 80 : 20
      if (fila.name !== fila.name.trim() || fila.name.length < 1 || fila.name.length > max)
        badCase('name')
    }
    if (e !== 'zones') {
      if (!entero(fila.x, -LIMITE, LIMITE)) badCase('x')
      if (!entero(fila.y, -LIMITE, LIMITE)) badCase('y')
      if (!entero(fila.width, 5, LIMITE)) badCase('width')
      if (!entero(fila.height, 5, LIMITE)) badCase('height')
      if (!entero(fila.rotation, 0, 359)) badCase('rotation')
    }
    if (e === 'dining_tables' && !entero(fila.capacity, 1, 100)) badCase('capacity')
    if (e === 'zones' && (!entero(fila.level, -5, 100) || !entero(fila.position, 0, 10_000)))
      badCase('level')
    if (e === 'floor_plan_elements') {
      if (
        typeof fila.text === 'string' &&
        (fila.text !== fila.text.trim() || fila.text.length > 60)
      )
        badCase('text')
    }
    tocados.push({ entity: e, id: change.id, donde })
  }

  for (const t of tocados) {
    const fila = tabla(t.entity).find((f) => f.id === t.id) as Registro
    if (fila.active === true && t.entity !== 'zones') {
      const zone = c.zones.find((z) => z.id === fila.zone_id)
      if (zone?.active !== true) throw new Error(`${t.donde}: zona está archivado`)
    }
    if (fila.active === false && t.entity === 'zones')
      if (c.tables.some((m) => m.zone_id === t.id && m.active))
        throw new Error(`${t.donde}: lo usan mesas; cámbialos primero`)
  }
  if (tocados.some((t) => t.entity === 'dining_tables')) {
    const seenSet = new Set<string>()
    for (const m of c.tables.filter((x) => x.active)) {
      const n = m.name.toLowerCase()
      if (seenSet.has(n)) throw new Error(`Hay dos mesas que se llaman «${m.name}»`)
      seenSet.add(n)
    }
  }
  c.version = version
  return c
}

const reg = { version: 1, active: true }
const geo = (x: number, y: number) => ({ x, y, width: 80, height: 80, rotation: 0 })

function diningRoom(): CatalogoEdicion {
  const a = 'ZONA-SALON'
  const t = 'ZONA-TERRAZA'
  return {
    version: 10,
    zones: [
      { ...reg, id: a, name: 'Salón', position: 0, level: 1 },
      { ...reg, id: t, name: 'Terraza', position: 1, level: 1 },
    ],
    tables: [
      { ...reg, ...geo(0, 0), id: 'M1', zone_id: a, name: '1', shape: 'square', capacity: 4 },
      { ...reg, ...geo(120, 0), id: 'M2', zone_id: a, name: '2', shape: 'round', capacity: 2 },
      {
        ...reg,
        ...geo(0, 120),
        id: 'M3',
        zone_id: a,
        name: '3',
        shape: 'rectangular',
        capacity: 6,
      },
      { ...reg, ...geo(0, 0), id: 'M10', zone_id: t, name: '10', shape: 'round', capacity: 2 },
      // Archivadas: no están en el editor, pero sus nombres no cuentan.
      {
        ...reg,
        ...geo(0, 0),
        id: 'M4',
        zone_id: a,
        name: '4',
        shape: 'bar',
        capacity: 1,
        active: false,
      },
    ],
    elements: [
      {
        ...reg,
        ...geo(0, 300),
        id: 'E1',
        zone_id: a,
        type: 'wall',
        text: null,
        width: 400,
        height: 20,
        rotation: 30,
      },
      { ...reg, ...geo(500, 0), id: 'E2', zone_id: a, type: 'text', text: 'Baños' },
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

type Edicion =
  | { t: 'table'; shape: FormaMesa }
  | { t: 'element'; type: TipoElemento }
  | { t: 'move'; i: number; x: number; y: number }
  | { t: 'measure'; i: number; a: number; h: number }
  | { t: 'rotate'; i: number; g: number }
  | { t: 'remove'; i: number }
  | { t: 'removeElement'; i: number }
  | { t: 'rename'; i: number; name: string }
  | { t: 'places'; i: number; n: number }
  | { t: 'shape'; i: number; shape: FormaMesa }
  | { t: 'text'; i: number; text: string }
  | { t: 'duplicate'; i: number }
  | { t: 'zone'; name: string; level: number }

const arbEspacios = fc.constantFrom('', ' ', '  ')
const arbTexto = fc
  .tuple(arbEspacios, fc.stringMatching(/^[A-Za-zñÁ0-9]{1,10}$/), arbEspacios)
  .map(([a, b, c]) => `${a}${b}${c}`)
const arbNumeroMesa = fc.oneof(
  arbTexto,
  fc.integer({ min: 1, max: 12 }).map(String),
  fc.integer({ min: 1, max: 12 }).map((n) => ` ${n} `),
  fc.constantFrom('T', 't', 'T ', ' t'),
)
const arbEdicion: fc.Arbitrary<Edicion> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .constantFrom(...(Object.keys(FORMAS) as FormaMesa[]))
      .map((shape) => ({ t: 'table' as const, shape })),
  },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom(...(Object.keys(TIPOS_ELEMENTO) as TipoElemento[]))
      .map((type) => ({ t: 'element' as const, type })),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('move' as const),
      i: fc.nat(20),
      x: fc.integer({ min: -3000, max: 3000 }),
      y: fc.integer({ min: -3000, max: 3000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('measure' as const),
      i: fc.nat(20),
      a: fc.integer({ min: -100, max: 2000 }),
      h: fc.integer({ min: -100, max: 2000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('rotate' as const),
      i: fc.nat(20),
      g: fc.constantFrom(-15, 15, 90),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('remove' as const), i: fc.nat(20) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('removeElement' as const), i: fc.nat(20) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('rename' as const),
      i: fc.nat(20),
      name: arbNumeroMesa,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('places' as const),
      i: fc.nat(20),
      n: fc.integer({ min: 0, max: 100 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('shape' as const),
      i: fc.nat(20),
      shape: fc.constantFrom(...(Object.keys(FORMAS) as FormaMesa[])),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('text' as const),
      i: fc.nat(20),
      text: fc.oneof(arbTexto, fc.constant('')),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('duplicate' as const), i: fc.nat(20) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('zone' as const),
      name: arbTexto,
      level: fc.integer({ min: -5, max: 100 }),
    }),
  },
)

/** Lo que haría el editor con cada gesto (mismas funciones de `plano.ts`). */
function editar(c: CatalogoEdicion, b: BorradorZona, e: Edicion): BorradorZona {
  const tables = b.tables.filter((m) => m.active)
  const elements = b.elements.filter((x) => x.active)
  const table = tables.length ? tables[e && 'i' in e ? e.i % tables.length : 0] : undefined
  const elem = elements.length ? elements[e && 'i' in e ? e.i % elements.length : 0] : undefined
  const usados = [
    ...c.tables.filter((m) => m.active && m.zone_id !== b.id).map((m) => m.name),
    ...tables.map((m) => m.name),
  ]
  const cambiarMesa = (
    id: string,
    f: (m: (typeof b.tables)[number]) => (typeof b.tables)[number],
  ) => ({
    ...b,
    tables: b.tables.map((m) => (m.id === id ? f(m) : m)),
  })
  const cambiarElem = (
    id: string,
    f: (m: (typeof b.elements)[number]) => (typeof b.elements)[number],
  ) => ({
    ...b,
    elements: b.elements.map((m) => (m.id === id ? f(m) : m)),
  })
  switch (e.t) {
    case 'table':
      return { ...b, tables: [...b.tables, nuevaMesa(b, e.shape, usados)] }
    case 'element':
      return { ...b, elements: [...b.elements, nuevoElemento(b, e.type)] }
    case 'move':
      if (table) return cambiarMesa(table.id, (m) => move(m, e.x, e.y))
      return elem ? cambiarElem(elem.id, (m) => move(m, e.x, e.y)) : b
    case 'measure':
      if (table) return cambiarMesa(table.id, (m) => measure(m, e.a, e.h))
      return elem ? cambiarElem(elem.id, (m) => measure(m, e.a, e.h)) : b
    case 'rotate':
      if (table) return cambiarMesa(table.id, (m) => rotate(m, e.g))
      return elem ? cambiarElem(elem.id, (m) => rotate(m, e.g)) : b
    case 'remove':
      return table ? cambiarMesa(table.id, (m) => ({ ...m, active: false })) : b
    case 'removeElement':
      return elem ? cambiarElem(elem.id, (m) => ({ ...m, active: false })) : b
    case 'rename':
      return table ? cambiarMesa(table.id, (m) => ({ ...m, name: e.name })) : b
    case 'places':
      return table ? cambiarMesa(table.id, (m) => ({ ...m, capacity: e.n })) : b
    case 'shape':
      return table ? cambiarMesa(table.id, (m) => ({ ...m, shape: e.shape })) : b
    case 'text':
      return elem?.type === 'text' ? cambiarElem(elem.id, (m) => ({ ...m, text: e.text })) : b
    case 'duplicate': {
      if (table) {
        const lado = move(table, table.x + table.width + CUADRICULA * 2, table.y)
        return {
          ...b,
          tables: [
            ...b.tables,
            { ...lado, id: newId(), fresh: true, name: siguienteNombre(usados) },
          ],
        }
      }
      if (elem)
        return {
          ...b,
          elements: [
            ...b.elements,
            {
              ...move(elem, elem.x + elem.width + CUADRICULA * 2, elem.y),
              id: newId(),
              fresh: true,
            },
          ],
        }
      return b
    }
    case 'zone':
      return { ...b, name: e.name, level: e.level }
  }
}

/** Cómo debe quedar el borrador al volver a abrirlo: solo lo activo, ya guardado y recortado. */
function expected(b: BorradorZona): BorradorZona {
  const porId = <T extends { id: string }>(list: T[]) =>
    [...list].sort((p, q) => p.id.localeCompare(q.id))
  return {
    ...b,
    fresh: false,
    name: b.name.trim(),
    tables: porId(
      b.tables.filter((m) => m.active).map((m) => ({ ...m, fresh: false, name: m.name.trim() })),
    ),
    elements: porId(
      b.elements
        .filter((x) => x.active)
        .map((x) => ({
          ...x,
          fresh: false,
          text: x.type === 'text' ? (x.text?.trim() ?? '') : null,
        })),
    ),
  }
}
const ordenado = (b: BorradorZona): BorradorZona => ({
  ...b,
  tables: [...b.tables].sort((p, q) => p.id.localeCompare(q.id)),
  elements: [...b.elements].sort((p, q) => p.id.localeCompare(q.id)),
})

describe('guardar una zona y volver a abrirla', () => {
  const arbDonde = fc.constantFrom('salon' as const, 'terraza' as const, 'nueva' as const)

  it('aplicar al catálogo los cambios de un borrador editado y reabrir da el mismo borrador; guardar otra vez no cambia nada', () => {
    let comprobadas = 0
    fc.assert(
      fc.property(arbDonde, fc.array(arbEdicion, { maxLength: 25 }), (donde, ediciones) => {
        const c = diningRoom()
        let b: BorradorZona =
          donde === 'nueva'
            ? { ...zonaNueva(c), name: 'Primer piso', level: 2 }
            : borradorDeZona(c, donde === 'salon' ? 'ZONA-SALON' : 'ZONA-TERRAZA')
        for (const e of ediciones) b = editar(c, b, e)

        const issues = problemasDeZona(c, b)
        const changes = cambiosDeZona(c, b)
        if (issues.length > 0) return // La pantalla no deja guardar: nada que comprobar.
        comprobadas += 1

        // Lo que la pantalla deja guardar, el hub lo acepta.
        const c2 = apply(c, changes)
        const vuelto = borradorDeZona(c2, b.id)
        expect(ordenado(vuelto)).toEqual(JSON.parse(JSON.stringify(expected(b))))
        // Y guardar otra vez lo mismo no manda nada.
        expect(cambiosDeZona(c2, vuelto)).toEqual([])
        // Las demás zonas no se tocan.
        for (const z of c.zones.filter((z) => z.id !== b.id))
          expect(borradorDeZona(c2, z.id)).toEqual(borradorDeZona(c, z.id))
      }),
      { seed: SEMILLA, numRuns: 400 },
    )
    // La propiedad no es vacía: la mayoría de las ediciones generadas se pueden guardar.
    expect(comprobadas).toBeGreaterThan(200)
  })

  it('cada cambio trae algo, ningún registro se repite y una zona nueva va antes que sus mesas', () => {
    fc.assert(
      fc.property(fc.array(arbEdicion, { maxLength: 25 }), (ediciones) => {
        const c = diningRoom()
        let b: BorradorZona = { ...zonaNueva(c), name: 'Azotea', level: 3 }
        for (const e of ediciones) b = editar(c, b, e)
        const changes = cambiosDeZona(c, b)
        for (const x of changes) expect(Object.keys(x.data).length).toBeGreaterThan(0)
        expect(new Set(changes.map((x) => x.id)).size).toBe(changes.length)
        const iZona = changes.findIndex((x) => x.entity === 'zones')
        expect(iZona).toBe(0)
        // Archivar lo quitado no manda lo nuevo ya quitado.
        for (const x of changes.filter((x) => x.entity !== 'zones'))
          expect(x.data.active).toBe(true)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('si la pantalla deja guardar, no quedan dos mesas con el mismo nombre en todo el restaurante', () => {
    fc.assert(
      fc.property(arbDonde, fc.array(arbEdicion, { maxLength: 25 }), (donde, ediciones) => {
        const c = diningRoom()
        let b: BorradorZona =
          donde === 'nueva'
            ? { ...zonaNueva(c), name: 'Patio' }
            : borradorDeZona(c, donde === 'salon' ? 'ZONA-SALON' : 'ZONA-TERRAZA')
        for (const e of ediciones) b = editar(c, b, e)
        if (problemasDeZona(c, b).length > 0) return
        const c2 = apply(c, cambiosDeZona(c, b))
        const names = c2.tables.filter((m) => m.active).map((m) => m.name.trim().toLowerCase())
        expect(new Set(names).size).toBe(names.length)
      }),
      { seed: SEMILLA, numRuns: 400 },
    )
  })

  it('archivar la zona con ediciones encima archiva todo lo suyo y no manda nada nuevo', () => {
    fc.assert(
      fc.property(fc.array(arbEdicion, { maxLength: 15 }), (ediciones) => {
        const c = diningRoom()
        let b = borradorDeZona(c, 'ZONA-SALON')
        for (const e of ediciones) b = editar(c, b, e)
        b = { ...b, active: false }
        const changes = cambiosDeZona(c, b)
        // Solo existentes: lo creado en esta sesión y no guardado no viaja.
        const nuevos = new Set([...b.tables, ...b.elements].filter((x) => x.fresh).map((x) => x.id))
        expect(changes.some((x) => nuevos.has(x.id))).toBe(false)
        expect(changes.at(-1)).toMatchObject({ entity: 'zones', data: { active: false } })
        if (problemasDeZona(c, b).length > 0) return
        const c2 = apply(c, changes)
        expect(c2.tables.filter((m) => m.zone_id === 'ZONA-SALON' && m.active)).toEqual([])
        expect(c2.elements.filter((x) => x.zone_id === 'ZONA-SALON' && x.active)).toEqual([])
        expect(c2.zones.find((z) => z.id === 'ZONA-SALON')?.active).toBe(false)
      }),
      { seed: SEMILLA, numRuns: 200 },
    )
  })
})
