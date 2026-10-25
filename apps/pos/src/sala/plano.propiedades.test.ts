import { nuevoId } from '@pos/core'
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
  girar,
  limites,
  MEDIDA_MINIMA,
  medir,
  mover,
  nuevaMesa,
  nuevoElemento,
  problemasDeZona,
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
  Number.isInteger(g.ancho) &&
  Number.isInteger(g.alto) &&
  g.ancho >= MEDIDA_MINIMA &&
  g.ancho <= LIMITE &&
  g.alto >= MEDIDA_MINIMA &&
  g.alto <= LIMITE &&
  Number.isInteger(g.rotacion) &&
  g.rotacion >= 0 &&
  g.rotacion <= 359

const arbGeometria: fc.Arbitrary<Geometria> = fc.record({
  x: fc.integer({ min: -LIMITE, max: LIMITE }).map((n) => ajustar(n)),
  y: fc.integer({ min: -LIMITE, max: LIMITE }).map((n) => ajustar(n)),
  ancho: fc.integer({ min: 2, max: 1000 }).map((n) => Math.max(MEDIDA_MINIMA, ajustar(n * 5))),
  alto: fc.integer({ min: 2, max: 1000 }).map((n) => Math.max(MEDIDA_MINIMA, ajustar(n * 5))),
  rotacion: fc.integer({ min: 0, max: 359 }),
})
// Valores de pantalla: con decimales, negativos y absurdos.
const arbPantalla = fc.oneof(
  fc.double({ min: -50_000, max: 50_000, noNaN: true }),
  fc.integer({ min: -50_000, max: 50_000 }),
  fc.constantFrom(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, 4.99, 5, 5.01),
)

type Orden =
  | { t: 'mover'; x: number; y: number }
  | { t: 'girar'; g: number }
  | { t: 'medir'; a: number; h: number }
const arbOrden: fc.Arbitrary<Orden> = fc.oneof(
  fc.record({ t: fc.constant('mover' as const), x: arbPantalla, y: arbPantalla }),
  fc.record({
    t: fc.constant('girar' as const),
    g: fc.constantFrom(-90, -15, 15, 45, 90, 180, 360, -360, 1000),
  }),
  fc.record({ t: fc.constant('medir' as const), a: arbPantalla, h: arbPantalla }),
)
const hacer = (g: Geometria, o: Orden): Geometria =>
  o.t === 'mover' ? mover(g, o.x, o.y) : o.t === 'girar' ? girar(g, o.g) : medir(g, o.a, o.h)

describe('mover, girar y medir', () => {
  it('cualquier secuencia deja la figura en la cuadrícula, dentro de los límites y con medidas enteras', () => {
    fc.assert(
      fc.property(arbGeometria, fc.array(arbOrden, { maxLength: 12 }), (g0, ordenes) => {
        let g = g0
        for (const o of ordenes) {
          g = hacer(g, o)
          expect(geometriaValida(g)).toBe(true)
        }
        if (ordenes.some((o) => o.t === 'mover')) {
          expect(enCuadricula(g.x)).toBe(true)
          expect(enCuadricula(g.y)).toBe(true)
        }
        if (ordenes.some((o) => o.t === 'medir')) {
          expect(enCuadricula(g.ancho)).toBe(true)
          expect(enCuadricula(g.alto)).toBe(true)
        }
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('cada operación solo toca lo suyo', () => {
    fc.assert(
      fc.property(arbGeometria, arbPantalla, arbPantalla, (g, a, b) => {
        const movida = mover(g, a, b)
        expect([movida.ancho, movida.alto, movida.rotacion]).toEqual([g.ancho, g.alto, g.rotacion])
        const medida = medir(g, a, b)
        expect([medida.x, medida.y, medida.rotacion]).toEqual([g.x, g.y, g.rotacion])
        const girada = girar(g, 90)
        expect([girada.x, girada.y, girada.ancho, girada.alto]).toEqual([g.x, g.y, g.ancho, g.alto])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('mover y medir son idempotentes: repetir con el resultado no cambia nada', () => {
    fc.assert(
      fc.property(arbGeometria, arbPantalla, arbPantalla, (g, a, b) => {
        const m = mover(g, a, b)
        expect(mover(m, m.x, m.y)).toEqual(m)
        const t = medir(g, a, b)
        expect(medir(t, t.ancho, t.alto)).toEqual(t)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('un punto de la cuadrícula dentro del salón se queda donde está', () => {
    fc.assert(
      fc.property(arbGeometria, (g) => {
        expect(mover(g, g.x, g.y)).toEqual(g)
        expect(medir(g, g.ancho, g.alto)).toEqual(g)
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
          expect(girar(girar(g, a), b).rotacion).toBe(girar(g, a + b).rotacion)
          expect(girar(g, 360).rotacion).toBe(g.rotacion)
          expect(girar(girar(g, a), -a).rotacion).toBe(g.rotacion)
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('arrastrar a un lugar absurdo se frena en el borde del salón', () => {
    const g = { x: 0, y: 0, ancho: 80, alto: 80, rotacion: 0 }
    expect(mover(g, 1e12, -1e12)).toMatchObject({ x: LIMITE, y: -LIMITE })
    expect(mover(g, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toMatchObject({
      x: LIMITE,
      y: -LIMITE,
    })
    expect(medir(g, 1e12, -5)).toMatchObject({ ancho: LIMITE, alto: MEDIDA_MINIMA })
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: `mover` y `medir` dejan pasar NaN
  // (Math.round(NaN) = NaN y Math.min/max lo propagan). El editor no lo produce hoy (se detiene con
  // escala 0), pero un NaN guardado en el borrador viajaría como null y el hub rechazaría todo el
  // guardado.
  it('un número de pantalla que no es número (NaN) no se cuela como posición ni medida', () => {
    const g = { x: 0, y: 0, ancho: 80, alto: 80, rotacion: 0 }
    expect(Number.isFinite(mover(g, Number.NaN, 0).x)).toBe(true)
    expect(Number.isFinite(medir(g, Number.NaN, 0).ancho)).toBe(true)
  })
})

// ── limites ──────────────────────────────────────────────────────────────────────────────────

/** Las cuatro esquinas de una figura, giradas alrededor de su centro. */
function esquinas(g: Geometria) {
  const cx = g.x + g.ancho / 2
  const cy = g.y + g.alto / 2
  const rad = (g.rotacion * Math.PI) / 180
  return [
    [-g.ancho / 2, -g.alto / 2],
    [g.ancho / 2, -g.alto / 2],
    [g.ancho / 2, g.alto / 2],
    [-g.ancho / 2, g.alto / 2],
  ].map(([dx, dy]) => ({
    x: cx + (dx as number) * Math.cos(rad) - (dy as number) * Math.sin(rad),
    y: cy + (dx as number) * Math.sin(rad) + (dy as number) * Math.cos(rad),
  }))
}

const arbFigura: fc.Arbitrary<Geometria> = fc.record({
  x: fc.integer({ min: -2000, max: 2000 }),
  y: fc.integer({ min: -2000, max: 2000 }),
  ancho: fc.integer({ min: 20, max: 600 }),
  alto: fc.integer({ min: 20, max: 600 }),
  rotacion: fc.integer({ min: 0, max: 359 }),
})
const EPS = 1e-6

describe('limites', () => {
  it('contiene las cuatro esquinas de cada figura, con cualquier giro, más el margen', () => {
    fc.assert(
      fc.property(
        fc.array(arbFigura, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 200 }),
        (figuras, margen) => {
          const caja = limites(figuras, margen)
          for (const f of figuras)
            for (const p of esquinas(f)) {
              expect(p.x).toBeGreaterThanOrEqual(caja.x + margen - EPS)
              expect(p.y).toBeGreaterThanOrEqual(caja.y + margen - EPS)
              expect(p.x).toBeLessThanOrEqual(caja.x + caja.ancho - margen + EPS)
              expect(p.y).toBeLessThanOrEqual(caja.y + caja.alto - margen + EPS)
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
          arbFigura.map((f) => ({ ...f, rotacion: 0 })),
          { minLength: 1, maxLength: 8 },
        ),
        fc.constantFrom(0, 180),
        (figuras, giro) => {
          const g = figuras.map((f) => ({ ...f, rotacion: giro }))
          const caja = limites(g, 0)
          expect(caja.x).toBe(Math.min(...g.map((f) => f.x)))
          expect(caja.y).toBe(Math.min(...g.map((f) => f.y)))
          expect(caja.x + caja.ancho).toBe(Math.max(...g.map((f) => f.x + f.ancho)))
          expect(caja.y + caja.alto).toBe(Math.max(...g.map((f) => f.y + f.alto)))
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
        (figuras, otra) => {
          const antes = limites(figuras, 0)
          const despues = limites([...figuras, otra], 0)
          expect(despues.x).toBeLessThanOrEqual(antes.x + EPS)
          expect(despues.y).toBeLessThanOrEqual(antes.y + EPS)
          expect(despues.x + despues.ancho).toBeGreaterThanOrEqual(antes.x + antes.ancho - EPS)
          expect(despues.y + despues.alto).toBeGreaterThanOrEqual(antes.y + antes.alto - EPS)
          const conMargen = limites(figuras, 40)
          expect(conMargen.ancho).toBeCloseTo(antes.ancho + 80)
          expect(conMargen.alto).toBeCloseTo(antes.alto + 80)
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
    const caja = limites([{ x: 0, y: 0, ancho: 300, alto: 20, rotacion: 90 }], 0)
    expect(caja.alto).toBeGreaterThanOrEqual(300)
    expect(caja.ancho).toBeGreaterThanOrEqual(20)
    // Y es la misma para 90° y 270°.
    expect(limites([{ x: 0, y: 0, ancho: 300, alto: 20, rotacion: 270 }], 0)).toEqual(caja)
  })

  it('sin figuras da un plano en blanco de tamaño fijo, con o sin margen', () => {
    expect(limites([])).toEqual({ x: 0, y: 0, ancho: 600, alto: 400 })
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
      fc.property(fc.array(arbNombre, { maxLength: 60 }), (nombres) => {
        const n = siguienteNombre(nombres)
        expect(n).toMatch(/^[1-9][0-9]*$/)
        const usados = new Set(nombres.map((x) => x.trim().toLowerCase()))
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

const cruzan = (a: Geometria, b: Omit<Geometria, 'rotacion'>) =>
  a.x < b.x + b.ancho && b.x < a.x + a.ancho && a.y < b.y + b.alto && b.y < a.y + a.alto

describe('lugarLibre: poner mesas y elementos nuevos en un salón que se llena', () => {
  const FORMAS_MESA = Object.keys(FORMAS) as FormaMesa[]
  const TIPOS = Object.keys(TIPOS_ELEMENTO) as TipoElemento[]

  function llenar(
    veces: { mesa: FormaMesa } | { elemento: TipoElemento },
    n: number,
    b = zonaNueva({ zonas: [] } as unknown as CatalogoEdicion),
  ) {
    for (let i = 0; i < n; i++) {
      if ('mesa' in veces)
        b.mesas.push(
          nuevaMesa(
            b,
            veces.mesa,
            b.mesas.map((m) => m.nombre),
          ),
        )
      else b.elementos.push(nuevoElemento(b, veces.elemento))
    }
    return b
  }

  it('lo primero va al origen', () => {
    const b = zonaNueva({ zonas: [] } as unknown as CatalogoEdicion)
    expect(nuevaMesa(b, 'cuadrada', [])).toMatchObject({ x: 0, y: 0 })
    expect(nuevoElemento(b, 'pared')).toMatchObject({ x: 0, y: 0 })
  })

  it('lo nuevo nunca se encima con lo que ya hay, en la cuadrícula y dentro del salón', () => {
    const arbPaso = fc.oneof(
      fc.constantFrom(...FORMAS_MESA).map((forma) => ({ mesa: forma })),
      fc.constantFrom(...TIPOS).map((tipo) => ({ elemento: tipo })),
    )
    fc.assert(
      fc.property(
        fc.array(arbPaso, { minLength: 1, maxLength: 40 }),
        fc.array(arbFigura, { maxLength: 4 }),
        (pasos, previas) => {
          const b = zonaNueva({ zonas: [] } as unknown as CatalogoEdicion)
          // Algo ya dibujado, quizá girado.
          for (const [i, f] of previas.entries())
            b.mesas.push({
              ...nuevaMesa(b, 'cuadrada', []),
              ...f,
              id: nuevoId(),
              nombre: `P${i}`,
              nuevo: false,
            })
          for (const p of pasos) {
            const antes = [...b.mesas, ...b.elementos]
            const nuevo =
              'mesa' in p
                ? nuevaMesa(
                    b,
                    p.mesa,
                    b.mesas.map((m) => m.nombre),
                  )
                : nuevoElemento(b, p.elemento)
            expect(enCuadricula(nuevo.x) && enCuadricula(nuevo.y)).toBe(true)
            expect(Math.abs(nuevo.x)).toBeLessThanOrEqual(LIMITE)
            expect(Math.abs(nuevo.y)).toBeLessThanOrEqual(LIMITE)
            // Lo girado ocupa el círculo que lo contiene (como `limites`): el lugar nuevo debe
            // quedar fuera de la caja de `limites`, o sea, fuera de cualquier figura previa.
            for (const otra of antes) {
              const caja = limites([otra], 0)
              expect(cruzan(nuevo, caja)).toBe(false)
            }
            if ('mesa' in p) b.mesas.push(nuevo as (typeof b.mesas)[number])
            else b.elementos.push(nuevo as (typeof b.elementos)[number])
          }
        },
      ),
      { seed: SEMILLA, numRuns: 100 },
    )
  })

  it('pone varias mesas por fila hasta unos 15 m y luego baja a la fila siguiente', () => {
    const b = llenar({ mesa: 'redonda' }, 11)
    // Redondas de 90 cm con 40 de separación: 11 caben en una fila de 15 m.
    expect(new Set(b.mesas.map((m) => m.y))).toEqual(new Set([0]))
    expect(Math.max(...b.mesas.map((m) => m.x + m.ancho))).toBeLessThanOrEqual(1500)
    const siguiente = nuevaMesa(
      b,
      'redonda',
      b.mesas.map((m) => m.nombre),
    )
    expect(siguiente.y).toBeGreaterThan(0)
    expect(siguiente.x).toBe(0)
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: `lugarLibre` mide la caja de TODO lo
  // dibujado; en cuanto la primera fila llena el ancho habitual, la caja ya es más ancha que 1500 y
  // ninguna mesa más cabe "a la derecha": cada una baja a una fila nueva de a una, en una sola
  // columna.
  it('al llenarse, las filas siguientes también se llenan de a varias mesas, no de a una', () => {
    // 40 mesas redondas: con 11 por fila bastan 4 filas; no una columna de 30.
    const b = llenar({ mesa: 'redonda' }, 40)
    const filas = new Set(b.mesas.map((m) => m.y)).size
    expect(filas).toBeLessThanOrEqual(6)
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: con ~78 mesas nuevas en una zona la
  // columna pasa de y = 10 000 y el hub rechaza todo el guardado ("y: Too big"), sin que la
  // pantalla lo avise antes.
  it('100 mesas nuevas en una zona caben dentro de los límites del salón que acepta el hub', () => {
    const b = llenar({ mesa: 'redonda' }, 100)
    for (const m of b.mesas) {
      expect(Math.abs(m.x)).toBeLessThanOrEqual(LIMITE)
      expect(Math.abs(m.y)).toBeLessThanOrEqual(LIMITE)
    }
  })

  it('un elemento ancho que no cabe a la derecha baja de fila en vez de salirse del salón habitual', () => {
    const b = llenar({ elemento: 'pared' }, 1)
    const segunda = nuevoElemento(b, 'pared')
    b.elementos.push(segunda)
    const tercera = nuevoElemento(b, 'pared')
    // 300 + 40 + 300 + 40 + 300 > 1500 no cabe una tercera en la misma fila.
    expect(segunda.y).toBe(0)
    expect(tercera.x + tercera.ancho).toBeLessThanOrEqual(1500)
  })

  it('lo archivado no ocupa lugar', () => {
    const b = llenar({ mesa: 'cuadrada' }, 5)
    for (const m of b.mesas) m.activo = false
    expect(nuevaMesa(b, 'cuadrada', [])).toMatchObject({ x: 0, y: 0 })
  })
})

// ── Guardar y volver a abrir ─────────────────────────────────────────────────────────────────

type Registro = Record<string, string | number | boolean | null>
const CAMPOS: Record<'zona' | 'mesa' | 'elemento_plano', string[]> = {
  zona: ['nombre', 'orden', 'piso', 'activo'],
  mesa: [
    'zona_id',
    'nombre',
    'forma',
    'x',
    'y',
    'ancho',
    'alto',
    'rotacion',
    'capacidad',
    'activo',
  ],
  elemento_plano: ['zona_id', 'tipo', 'texto', 'x', 'y', 'ancho', 'alto', 'rotacion', 'activo'],
}
const TABLA = { zona: 'zonas', mesa: 'mesas', elemento_plano: 'elementos' } as const

const entero = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** Aplica los cambios como lo haría el hub (`edicion-catalogo.ts`); lanza si los rechazaría. */
function aplicar(origen: CatalogoEdicion, enviados: CambioCatalogo[]): CatalogoEdicion {
  const c = structuredClone(origen)
  // Viajan por la red como JSON (así -0 llega como 0).
  const cambios: CambioCatalogo[] = JSON.parse(JSON.stringify(enviados))
  let version = c.version
  const tocados: { entidad: 'zona' | 'mesa' | 'elemento_plano'; id: string; donde: string }[] = []
  const tabla = (e: keyof typeof TABLA) => c[TABLA[e]] as unknown as (Registro & { id: string })[]

  for (const [i, cambio] of cambios.entries()) {
    const e = cambio.entidad as keyof typeof TABLA
    const donde = `Cambio ${i + 1} (${e})`
    if (!(e in TABLA)) throw new Error(`${donde}: no es del plano`)
    const claves = Object.keys(cambio.datos)
    if (claves.length === 0) throw new Error(`${donde}: no cambia nada`)
    for (const k of claves)
      if (!CAMPOS[e].includes(k)) throw new Error(`${donde}: campo ${k} no existe`)
    const zonaRef = cambio.datos.zona_id
    if (typeof zonaRef === 'string' && !c.zonas.some((z) => z.id === zonaRef))
      throw new Error(`${donde}: zona_id no existe`)
    const actual = tabla(e).find((f) => f.id === cambio.id)
    if (!actual) {
      for (const k of CAMPOS[e])
        if (!(k in cambio.datos)) throw new Error(`${donde}: falta ${k} al crear`)
      tabla(e).push({ id: cambio.id, version: ++version, ...cambio.datos } as Registro & {
        id: string
      })
    } else {
      const cambia = Object.entries(cambio.datos).filter(([k, v]) => actual[k] !== v)
      if (cambia.length !== claves.length) throw new Error(`${donde}: manda campos sin cambio`)
      Object.assign(actual, cambio.datos, { version: ++version })
    }
    const fila = tabla(e).find((f) => f.id === cambio.id) as Registro
    const malo = (campo: string) => {
      throw new Error(`${donde}: ${campo} inválido (${String(fila[campo])})`)
    }
    if (typeof fila.nombre === 'string') {
      const max = e === 'zona' ? 80 : 20
      if (fila.nombre !== fila.nombre.trim() || fila.nombre.length < 1 || fila.nombre.length > max)
        malo('nombre')
    }
    if (e !== 'zona') {
      if (!entero(fila.x, -LIMITE, LIMITE)) malo('x')
      if (!entero(fila.y, -LIMITE, LIMITE)) malo('y')
      if (!entero(fila.ancho, 5, LIMITE)) malo('ancho')
      if (!entero(fila.alto, 5, LIMITE)) malo('alto')
      if (!entero(fila.rotacion, 0, 359)) malo('rotacion')
    }
    if (e === 'mesa' && !entero(fila.capacidad, 1, 100)) malo('capacidad')
    if (e === 'zona' && (!entero(fila.piso, -5, 100) || !entero(fila.orden, 0, 10_000)))
      malo('piso')
    if (e === 'elemento_plano') {
      if (
        typeof fila.texto === 'string' &&
        (fila.texto !== fila.texto.trim() || fila.texto.length > 60)
      )
        malo('texto')
    }
    tocados.push({ entidad: e, id: cambio.id, donde })
  }

  for (const t of tocados) {
    const fila = tabla(t.entidad).find((f) => f.id === t.id) as Registro
    if (fila.activo === true && t.entidad !== 'zona') {
      const zona = c.zonas.find((z) => z.id === fila.zona_id)
      if (zona?.activo !== true) throw new Error(`${t.donde}: zona está archivado`)
    }
    if (fila.activo === false && t.entidad === 'zona')
      if (c.mesas.some((m) => m.zona_id === t.id && m.activo))
        throw new Error(`${t.donde}: lo usan mesas; cámbialos primero`)
  }
  if (tocados.some((t) => t.entidad === 'mesa')) {
    const vistos = new Set<string>()
    for (const m of c.mesas.filter((x) => x.activo)) {
      const n = m.nombre.toLowerCase()
      if (vistos.has(n)) throw new Error(`Hay dos mesas que se llaman «${m.nombre}»`)
      vistos.add(n)
    }
  }
  c.version = version
  return c
}

const reg = { version: 1, activo: true }
const geo = (x: number, y: number) => ({ x, y, ancho: 80, alto: 80, rotacion: 0 })

function salon(): CatalogoEdicion {
  const a = 'ZONA-SALON'
  const t = 'ZONA-TERRAZA'
  return {
    version: 10,
    zonas: [
      { ...reg, id: a, nombre: 'Salón', orden: 0, piso: 1 },
      { ...reg, id: t, nombre: 'Terraza', orden: 1, piso: 1 },
    ],
    mesas: [
      { ...reg, ...geo(0, 0), id: 'M1', zona_id: a, nombre: '1', forma: 'cuadrada', capacidad: 4 },
      { ...reg, ...geo(120, 0), id: 'M2', zona_id: a, nombre: '2', forma: 'redonda', capacidad: 2 },
      {
        ...reg,
        ...geo(0, 120),
        id: 'M3',
        zona_id: a,
        nombre: '3',
        forma: 'rectangular',
        capacidad: 6,
      },
      { ...reg, ...geo(0, 0), id: 'M10', zona_id: t, nombre: '10', forma: 'redonda', capacidad: 2 },
      // Archivadas: no están en el editor, pero sus nombres no cuentan.
      {
        ...reg,
        ...geo(0, 0),
        id: 'M4',
        zona_id: a,
        nombre: '4',
        forma: 'barra',
        capacidad: 1,
        activo: false,
      },
    ],
    elementos: [
      {
        ...reg,
        ...geo(0, 300),
        id: 'E1',
        zona_id: a,
        tipo: 'pared',
        texto: null,
        ancho: 400,
        alto: 20,
        rotacion: 30,
      },
      { ...reg, ...geo(500, 0), id: 'E2', zona_id: a, tipo: 'texto', texto: 'Baños' },
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

type Edicion =
  | { t: 'mesa'; forma: FormaMesa }
  | { t: 'elemento'; tipo: TipoElemento }
  | { t: 'mover'; i: number; x: number; y: number }
  | { t: 'medir'; i: number; a: number; h: number }
  | { t: 'girar'; i: number; g: number }
  | { t: 'quitar'; i: number }
  | { t: 'quitarElemento'; i: number }
  | { t: 'renombrar'; i: number; nombre: string }
  | { t: 'puestos'; i: number; n: number }
  | { t: 'forma'; i: number; forma: FormaMesa }
  | { t: 'texto'; i: number; texto: string }
  | { t: 'duplicar'; i: number }
  | { t: 'zona'; nombre: string; piso: number }

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
      .map((forma) => ({ t: 'mesa' as const, forma })),
  },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom(...(Object.keys(TIPOS_ELEMENTO) as TipoElemento[]))
      .map((tipo) => ({ t: 'elemento' as const, tipo })),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('mover' as const),
      i: fc.nat(20),
      x: fc.integer({ min: -3000, max: 3000 }),
      y: fc.integer({ min: -3000, max: 3000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('medir' as const),
      i: fc.nat(20),
      a: fc.integer({ min: -100, max: 2000 }),
      h: fc.integer({ min: -100, max: 2000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('girar' as const),
      i: fc.nat(20),
      g: fc.constantFrom(-15, 15, 90),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('quitar' as const), i: fc.nat(20) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('quitarElemento' as const), i: fc.nat(20) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('renombrar' as const),
      i: fc.nat(20),
      nombre: arbNumeroMesa,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('puestos' as const),
      i: fc.nat(20),
      n: fc.integer({ min: 0, max: 100 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('forma' as const),
      i: fc.nat(20),
      forma: fc.constantFrom(...(Object.keys(FORMAS) as FormaMesa[])),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('texto' as const),
      i: fc.nat(20),
      texto: fc.oneof(arbTexto, fc.constant('')),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('duplicar' as const), i: fc.nat(20) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('zona' as const),
      nombre: arbTexto,
      piso: fc.integer({ min: -5, max: 100 }),
    }),
  },
)

/** Lo que haría el editor con cada gesto (mismas funciones de `plano.ts`). */
function editar(c: CatalogoEdicion, b: BorradorZona, e: Edicion): BorradorZona {
  const mesas = b.mesas.filter((m) => m.activo)
  const elementos = b.elementos.filter((x) => x.activo)
  const mesa = mesas.length ? mesas[e && 'i' in e ? e.i % mesas.length : 0] : undefined
  const elem = elementos.length ? elementos[e && 'i' in e ? e.i % elementos.length : 0] : undefined
  const usados = [
    ...c.mesas.filter((m) => m.activo && m.zona_id !== b.id).map((m) => m.nombre),
    ...mesas.map((m) => m.nombre),
  ]
  const cambiarMesa = (
    id: string,
    f: (m: (typeof b.mesas)[number]) => (typeof b.mesas)[number],
  ) => ({
    ...b,
    mesas: b.mesas.map((m) => (m.id === id ? f(m) : m)),
  })
  const cambiarElem = (
    id: string,
    f: (m: (typeof b.elementos)[number]) => (typeof b.elementos)[number],
  ) => ({
    ...b,
    elementos: b.elementos.map((m) => (m.id === id ? f(m) : m)),
  })
  switch (e.t) {
    case 'mesa':
      return { ...b, mesas: [...b.mesas, nuevaMesa(b, e.forma, usados)] }
    case 'elemento':
      return { ...b, elementos: [...b.elementos, nuevoElemento(b, e.tipo)] }
    case 'mover':
      if (mesa) return cambiarMesa(mesa.id, (m) => mover(m, e.x, e.y))
      return elem ? cambiarElem(elem.id, (m) => mover(m, e.x, e.y)) : b
    case 'medir':
      if (mesa) return cambiarMesa(mesa.id, (m) => medir(m, e.a, e.h))
      return elem ? cambiarElem(elem.id, (m) => medir(m, e.a, e.h)) : b
    case 'girar':
      if (mesa) return cambiarMesa(mesa.id, (m) => girar(m, e.g))
      return elem ? cambiarElem(elem.id, (m) => girar(m, e.g)) : b
    case 'quitar':
      return mesa ? cambiarMesa(mesa.id, (m) => ({ ...m, activo: false })) : b
    case 'quitarElemento':
      return elem ? cambiarElem(elem.id, (m) => ({ ...m, activo: false })) : b
    case 'renombrar':
      return mesa ? cambiarMesa(mesa.id, (m) => ({ ...m, nombre: e.nombre })) : b
    case 'puestos':
      return mesa ? cambiarMesa(mesa.id, (m) => ({ ...m, capacidad: e.n })) : b
    case 'forma':
      return mesa ? cambiarMesa(mesa.id, (m) => ({ ...m, forma: e.forma })) : b
    case 'texto':
      return elem?.tipo === 'texto' ? cambiarElem(elem.id, (m) => ({ ...m, texto: e.texto })) : b
    case 'duplicar': {
      if (mesa) {
        const lado = mover(mesa, mesa.x + mesa.ancho + CUADRICULA * 2, mesa.y)
        return {
          ...b,
          mesas: [
            ...b.mesas,
            { ...lado, id: nuevoId(), nuevo: true, nombre: siguienteNombre(usados) },
          ],
        }
      }
      if (elem)
        return {
          ...b,
          elementos: [
            ...b.elementos,
            {
              ...mover(elem, elem.x + elem.ancho + CUADRICULA * 2, elem.y),
              id: nuevoId(),
              nuevo: true,
            },
          ],
        }
      return b
    }
    case 'zona':
      return { ...b, nombre: e.nombre, piso: e.piso }
  }
}

/** Cómo debe quedar el borrador al volver a abrirlo: solo lo activo, ya guardado y recortado. */
function esperado(b: BorradorZona): BorradorZona {
  const porId = <T extends { id: string }>(lista: T[]) =>
    [...lista].sort((p, q) => p.id.localeCompare(q.id))
  return {
    ...b,
    nuevo: false,
    nombre: b.nombre.trim(),
    mesas: porId(
      b.mesas.filter((m) => m.activo).map((m) => ({ ...m, nuevo: false, nombre: m.nombre.trim() })),
    ),
    elementos: porId(
      b.elementos
        .filter((x) => x.activo)
        .map((x) => ({
          ...x,
          nuevo: false,
          texto: x.tipo === 'texto' ? (x.texto?.trim() ?? '') : null,
        })),
    ),
  }
}
const ordenado = (b: BorradorZona): BorradorZona => ({
  ...b,
  mesas: [...b.mesas].sort((p, q) => p.id.localeCompare(q.id)),
  elementos: [...b.elementos].sort((p, q) => p.id.localeCompare(q.id)),
})

describe('guardar una zona y volver a abrirla', () => {
  const arbDonde = fc.constantFrom('salon' as const, 'terraza' as const, 'nueva' as const)

  it('aplicar al catálogo los cambios de un borrador editado y reabrir da el mismo borrador; guardar otra vez no cambia nada', () => {
    let comprobadas = 0
    fc.assert(
      fc.property(arbDonde, fc.array(arbEdicion, { maxLength: 25 }), (donde, ediciones) => {
        const c = salon()
        let b: BorradorZona =
          donde === 'nueva'
            ? { ...zonaNueva(c), nombre: 'Primer piso', piso: 2 }
            : borradorDeZona(c, donde === 'salon' ? 'ZONA-SALON' : 'ZONA-TERRAZA')
        for (const e of ediciones) b = editar(c, b, e)

        const problemas = problemasDeZona(c, b)
        const cambios = cambiosDeZona(c, b)
        if (problemas.length > 0) return // La pantalla no deja guardar: nada que comprobar.
        comprobadas += 1

        // Lo que la pantalla deja guardar, el hub lo acepta.
        const c2 = aplicar(c, cambios)
        const vuelto = borradorDeZona(c2, b.id)
        expect(ordenado(vuelto)).toEqual(JSON.parse(JSON.stringify(esperado(b))))
        // Y guardar otra vez lo mismo no manda nada.
        expect(cambiosDeZona(c2, vuelto)).toEqual([])
        // Las demás zonas no se tocan.
        for (const z of c.zonas.filter((z) => z.id !== b.id))
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
        const c = salon()
        let b: BorradorZona = { ...zonaNueva(c), nombre: 'Azotea', piso: 3 }
        for (const e of ediciones) b = editar(c, b, e)
        const cambios = cambiosDeZona(c, b)
        for (const x of cambios) expect(Object.keys(x.datos).length).toBeGreaterThan(0)
        expect(new Set(cambios.map((x) => x.id)).size).toBe(cambios.length)
        const iZona = cambios.findIndex((x) => x.entidad === 'zona')
        expect(iZona).toBe(0)
        // Archivar lo quitado no manda lo nuevo ya quitado.
        for (const x of cambios.filter((x) => x.entidad !== 'zona'))
          expect(x.datos.activo).toBe(true)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('si la pantalla deja guardar, no quedan dos mesas con el mismo nombre en todo el restaurante', () => {
    fc.assert(
      fc.property(arbDonde, fc.array(arbEdicion, { maxLength: 25 }), (donde, ediciones) => {
        const c = salon()
        let b: BorradorZona =
          donde === 'nueva'
            ? { ...zonaNueva(c), nombre: 'Patio' }
            : borradorDeZona(c, donde === 'salon' ? 'ZONA-SALON' : 'ZONA-TERRAZA')
        for (const e of ediciones) b = editar(c, b, e)
        if (problemasDeZona(c, b).length > 0) return
        const c2 = aplicar(c, cambiosDeZona(c, b))
        const nombres = c2.mesas.filter((m) => m.activo).map((m) => m.nombre.trim().toLowerCase())
        expect(new Set(nombres).size).toBe(nombres.length)
      }),
      { seed: SEMILLA, numRuns: 400 },
    )
  })

  it('archivar la zona con ediciones encima archiva todo lo suyo y no manda nada nuevo', () => {
    fc.assert(
      fc.property(fc.array(arbEdicion, { maxLength: 15 }), (ediciones) => {
        const c = salon()
        let b = borradorDeZona(c, 'ZONA-SALON')
        for (const e of ediciones) b = editar(c, b, e)
        b = { ...b, activo: false }
        const cambios = cambiosDeZona(c, b)
        // Solo existentes: lo creado en esta sesión y no guardado no viaja.
        const nuevos = new Set([...b.mesas, ...b.elementos].filter((x) => x.nuevo).map((x) => x.id))
        expect(cambios.some((x) => nuevos.has(x.id))).toBe(false)
        expect(cambios.at(-1)).toMatchObject({ entidad: 'zona', datos: { activo: false } })
        if (problemasDeZona(c, b).length > 0) return
        const c2 = aplicar(c, cambios)
        expect(c2.mesas.filter((m) => m.zona_id === 'ZONA-SALON' && m.activo)).toEqual([])
        expect(c2.elementos.filter((x) => x.zona_id === 'ZONA-SALON' && x.activo)).toEqual([])
        expect(c2.zonas.find((z) => z.id === 'ZONA-SALON')?.activo).toBe(false)
      }),
      { seed: SEMILLA, numRuns: 200 },
    )
  })
})
