import { newId } from '@pos/core'
import { add, diferencias } from './borradores'
import type { CatalogChange, CatalogoEdicion, FormaMesa, Geometria, TipoElemento } from './motor'

// El plano del salón (tarea 1.2): la geometría va en centímetros (x, y de la esquina superior
// izquierda, ancho, alto y giro alrededor del centro). El editor trabaja sobre un borrador de cada
// zona; al guardar salen solo los cambios. Lo que se quita se archiva.

/** Cuadrícula del editor: todo se mueve y se mide de 10 en 10 cm. */
export const CUADRICULA = 10
export const MEDIDA_MINIMA = 20
const LIMITE = 10_000

export const ajustar = (n: number, step = CUADRICULA) => Math.round(n / step) * step
const acotar = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

export interface MesaPlano extends Geometria {
  id: string
  fresh: boolean
  name: string
  shape: FormaMesa
  capacity: number
  active: boolean
}

export interface ElementoPlano extends Geometria {
  id: string
  fresh: boolean
  type: TipoElemento
  text: string | null
  active: boolean
}

export interface BorradorZona {
  id: string
  fresh: boolean
  name: string
  level: number
  position: number
  active: boolean
  tables: MesaPlano[]
  elements: ElementoPlano[]
}

const geometria = (g: Geometria): Geometria => ({
  x: g.x,
  y: g.y,
  width: g.width,
  height: g.height,
  rotation: g.rotation,
})

export function borradorDeZona(c: CatalogoEdicion, id: string): BorradorZona {
  const z = c.zones.find((x) => x.id === id)
  if (!z) throw new Error('Esa zona no existe')
  return {
    id,
    fresh: false,
    name: z.name,
    level: z.level,
    position: z.position,
    active: z.active,
    tables: c.tables
      .filter((m) => m.zone_id === id && m.active)
      .map((m) => ({
        id: m.id,
        fresh: false,
        name: m.name,
        shape: m.shape,
        capacity: m.capacity,
        active: true,
        ...geometria(m),
      })),
    elements: c.elements
      .filter((e) => e.zone_id === id && e.active)
      .map((e) => ({
        id: e.id,
        fresh: false,
        type: e.type,
        text: e.text,
        active: true,
        ...geometria(e),
      })),
  }
}

export const newZone = (c: CatalogoEdicion): BorradorZona => ({
  id: newId(),
  fresh: true,
  name: '',
  level: 1,
  position: c.zones.length,
  active: true,
  tables: [],
  elements: [],
})

/** El rectángulo que ocupa todo lo activo, con margen: lo que muestra el lienzo. */
export function limites(cosas: readonly Geometria[], margen = 40) {
  if (cosas.length === 0) return { x: 0, y: 0, width: 600, height: 400 }
  // Con giro, la caja que ocupa una figura crece; se toma el círculo que la contiene.
  const cajas = cosas.map((g) => {
    const giro = g.rotation % 180 !== 0
    const lado = giro ? Math.hypot(g.width, g.height) : 0
    const cx = g.x + g.width / 2
    const cy = g.y + g.height / 2
    const medioAncho = giro ? lado / 2 : g.width / 2
    const medioAlto = giro ? lado / 2 : g.height / 2
    return { x0: cx - medioAncho, y0: cy - medioAlto, x1: cx + medioAncho, y1: cy + medioAlto }
  })
  const x0 = Math.min(...cajas.map((c) => c.x0)) - margen
  const y0 = Math.min(...cajas.map((c) => c.y0)) - margen
  const x1 = Math.max(...cajas.map((c) => c.x1)) + margen
  const y1 = Math.max(...cajas.map((c) => c.y1)) + margen
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Medidas iniciales de cada forma de mesa, en cm, y cuántos se sientan. */
export const FORMAS: Record<
  FormaMesa,
  { name: string; width: number; height: number; capacity: number }
> = {
  square: { name: 'Cuadrada', width: 80, height: 80, capacity: 4 },
  round: { name: 'Redonda', width: 90, height: 90, capacity: 4 },
  rectangular: { name: 'Rectangular', width: 160, height: 80, capacity: 6 },
  bar: { name: 'Puesto de barra', width: 50, height: 50, capacity: 1 },
}

export const TIPOS_ELEMENTO: Record<TipoElemento, { name: string; width: number; height: number }> =
  {
    wall: { name: 'Pared', width: 300, height: 20 },
    door: { name: 'Puerta', width: 90, height: 20 },
    plant: { name: 'Planta', width: 50, height: 50 },
    bar: { name: 'Mostrador', width: 300, height: 60 },
    text: { name: 'Texto', width: 150, height: 40 },
  }

/** El primer número que no usa ninguna mesa activa del restaurante (en cualquier zona). */
export function siguienteNombre(names: readonly string[]): string {
  const usados = new Set(names.map((n) => n.trim().toLowerCase()))
  let n = 1
  while (usados.has(String(n))) n += 1
  return String(n)
}

/** Un salón típico mide unos 15 m: lo nuevo se acomoda en filas de ese ancho. */
const ANCHO_HABITUAL = 1500
const SEPARACION = 40

/**
 * Dónde poner algo nuevo de ese tamaño: el primer hueco libre, recorriendo filas de izquierda a
 * derecha y de arriba abajo, dejando 40 cm con lo que ya hay. Así un salón que se llena sigue
 * llenándose en filas (no en una sola columna) y nada se sale de los límites que acepta el hub.
 */
function lugarLibre(b: BorradorZona, width: number, height: number) {
  const taken = [...b.tables, ...b.elements]
    .filter((x) => x.active)
    .map((g) => {
      const c = limites([g], 0)
      return {
        x0: c.x - SEPARACION,
        y0: c.y - SEPARACION,
        x1: c.x + c.width + SEPARACION,
        y1: c.y + c.height + SEPARACION,
      }
    })
  if (taken.length === 0) return { x: 0, y: 0 }
  const x0 = ajustar(Math.min(...taken.map((o) => o.x0)) + SEPARACION)
  const y0 = ajustar(Math.min(...taken.map((o) => o.y0)) + SEPARACION)
  const free = (x: number, y: number) =>
    taken.every((o) => x + width <= o.x0 || x >= o.x1 || y + height <= o.y0 || y >= o.y1)
  const step = CUADRICULA * 2
  const hastaX = Math.max(x0 + ANCHO_HABITUAL, x0 + width)
  for (let y = y0; y + height <= LIMITE; y += step)
    for (let x = x0; x + width <= hastaX; x += step) if (free(x, y)) return { x, y }
  // El salón está lleno hasta el límite: se pone arriba a la izquierda y se acomoda a mano.
  return { x: x0, y: y0 }
}

export function nuevaMesa(
  b: BorradorZona,
  shape: FormaMesa,
  nombresUsados: readonly string[],
): MesaPlano {
  const f = FORMAS[shape]
  return {
    id: newId(),
    fresh: true,
    name: siguienteNombre(nombresUsados),
    shape,
    capacity: f.capacity,
    active: true,
    width: f.width,
    height: f.height,
    rotation: 0,
    ...lugarLibre(b, f.width, f.height),
  }
}

/**
 * Varias mesas iguales de una vez, en filas, con los números siguientes: dibujar un salón de 25
 * mesas son unos pocos toques y luego se acomodan las que no van en cuadrícula.
 */
export function variasMesas(
  b: BorradorZona,
  shape: FormaMesa,
  quantity: number,
  porFila: number,
  nombresUsados: readonly string[],
): MesaPlano[] {
  const f = FORMAS[shape]
  const separacion = SEPARACION
  const columns = Math.max(1, Math.min(porFila, quantity))
  const rows = Math.ceil(quantity / columns)
  // El bloque entero en un hueco libre, para que las mesas nuevas no caigan encima de otras.
  const start = lugarLibre(
    b,
    columns * (f.width + separacion) - separacion,
    rows * (f.height + separacion) - separacion,
  )
  const usados = [...nombresUsados]
  return Array.from({ length: quantity }, (_, i) => {
    const name = siguienteNombre(usados)
    usados.push(name)
    const row = Math.floor(i / columns)
    const column = i % columns
    return {
      id: newId(),
      fresh: true,
      name,
      shape,
      capacity: f.capacity,
      active: true,
      width: f.width,
      height: f.height,
      rotation: 0,
      x: ajustar(start.x + column * (f.width + separacion)),
      y: ajustar(start.y + row * (f.height + separacion)),
    }
  })
}

export function nuevoElemento(b: BorradorZona, type: TipoElemento): ElementoPlano {
  const t = TIPOS_ELEMENTO[type]
  return {
    id: newId(),
    fresh: true,
    type,
    text: type === 'text' ? 'Texto' : null,
    active: true,
    width: t.width,
    height: t.height,
    rotation: 0,
    ...lugarLibre(b, t.width, t.height),
  }
}

/** Mover, girar o cambiar el tamaño, siempre en la cuadrícula y dentro de los límites. */
/** Lo que no es número (p. ej. de un campo vacío) deja el valor como estaba; ±∞ se acota. */
const numeroO = (n: number, yes: number) => (Number.isNaN(n) ? yes : n)

export function move<T extends Geometria>(g: T, x: number, y: number): T {
  return {
    ...g,
    x: acotar(ajustar(numeroO(x, g.x)), -LIMITE, LIMITE),
    y: acotar(ajustar(numeroO(y, g.y)), -LIMITE, LIMITE),
  }
}

export function rotate<T extends Geometria>(g: T, grados: number): T {
  return { ...g, rotation: (((g.rotation + grados) % 360) + 360) % 360 }
}

export function measure<T extends Geometria>(g: T, width: number, height: number): T {
  return {
    ...g,
    width: acotar(ajustar(numeroO(width, g.width)), MEDIDA_MINIMA, LIMITE),
    height: acotar(ajustar(numeroO(height, g.height)), MEDIDA_MINIMA, LIMITE),
  }
}

/** Qué impide guardar la zona, en palabras para la persona. */
export function problemasDeZona(c: CatalogoEdicion, b: BorradorZona): string[] {
  const issues: string[] = []
  if (!b.name.trim()) issues.push('Falta el nombre de la zona')
  const tables = b.tables.filter((m) => m.active)
  if (tables.some((m) => !m.name.trim())) issues.push('Cada mesa lleva nombre')
  // El mesero dice "la 12": no puede haber dos, ni en esta zona ni en otra.
  const deOtras = c.tables.filter((m) => m.active && m.zone_id !== b.id).map((m) => m.name)
  const names = [...deOtras, ...tables.map((m) => m.name)].map((n) =>
    n.trim().normalize('NFC').toLocaleLowerCase('es'),
  )
  const duplicate = names.find((n, i) => n && names.indexOf(n) !== i)
  if (duplicate) issues.push(`Hay dos mesas que se llaman «${duplicate}»`)
  if (tables.some((m) => m.capacity < 1)) issues.push('Cada mesa es para al menos una persona')
  return issues
}

/** Los cambios para dejar la zona como el borrador. Archivar la zona archiva lo que tiene. */
export function cambiosDeZona(c: CatalogoEdicion, b: BorradorZona): CatalogChange[] {
  const changes: CatalogChange[] = []
  const original = b.fresh ? undefined : c.zones.find((z) => z.id === b.id)
  const archive = !b.active
  // Lo de adentro primero: el hub no deja archivar una zona con mesas activas.
  for (const m of b.tables) {
    if (m.fresh && (!m.active || archive)) continue
    const before = m.fresh ? undefined : c.tables.find((x) => x.id === m.id)
    add(
      changes,
      'dining_tables',
      m.id,
      diferencias(before, {
        zone_id: b.id,
        name: m.name.trim(),
        shape: m.shape,
        capacity: m.capacity,
        ...geometria(m),
        active: m.active && !archive,
      }),
    )
  }
  for (const e of b.elements) {
    if (e.fresh && (!e.active || archive)) continue
    const before = e.fresh ? undefined : c.elements.find((x) => x.id === e.id)
    add(
      changes,
      'floor_plan_elements',
      e.id,
      diferencias(before, {
        zone_id: b.id,
        type: e.type,
        text: e.type === 'text' ? (e.text?.trim() ?? '') : null,
        ...geometria(e),
        active: e.active && !archive,
      }),
    )
  }
  const zone = {
    entity: 'zones' as const,
    id: b.id,
    data: diferencias(original, {
      name: b.name.trim(),
      level: b.level,
      position: b.position,
      active: b.active,
    }),
  }
  // Una zona nueva va antes que sus mesas (la referencia debe existir); archivarla, después.
  if (Object.keys(zone.data).length > 0) {
    if (archive) changes.push(zone)
    else changes.unshift(zone)
  }
  return changes
}
