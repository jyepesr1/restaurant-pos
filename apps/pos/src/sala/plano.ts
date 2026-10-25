import { nuevoId } from '@pos/core'
import { agregar, diferencias } from './borradores'
import type { CambioCatalogo, CatalogoEdicion, FormaMesa, Geometria, TipoElemento } from './motor'

// El plano del salón (tarea 1.2): la geometría va en centímetros (x, y de la esquina superior
// izquierda, ancho, alto y giro alrededor del centro). El editor trabaja sobre un borrador de cada
// zona; al guardar salen solo los cambios. Lo que se quita se archiva.

/** Cuadrícula del editor: todo se mueve y se mide de 10 en 10 cm. */
export const CUADRICULA = 10
export const MEDIDA_MINIMA = 20
const LIMITE = 10_000

export const ajustar = (n: number, paso = CUADRICULA) => Math.round(n / paso) * paso
const acotar = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

export interface MesaPlano extends Geometria {
  id: string
  nuevo: boolean
  nombre: string
  forma: FormaMesa
  capacidad: number
  activo: boolean
}

export interface ElementoPlano extends Geometria {
  id: string
  nuevo: boolean
  tipo: TipoElemento
  texto: string | null
  activo: boolean
}

export interface BorradorZona {
  id: string
  nuevo: boolean
  nombre: string
  piso: number
  orden: number
  activo: boolean
  mesas: MesaPlano[]
  elementos: ElementoPlano[]
}

const geometria = (g: Geometria): Geometria => ({
  x: g.x,
  y: g.y,
  ancho: g.ancho,
  alto: g.alto,
  rotacion: g.rotacion,
})

export function borradorDeZona(c: CatalogoEdicion, id: string): BorradorZona {
  const z = c.zonas.find((x) => x.id === id)
  if (!z) throw new Error('Esa zona no existe')
  return {
    id,
    nuevo: false,
    nombre: z.nombre,
    piso: z.piso,
    orden: z.orden,
    activo: z.activo,
    mesas: c.mesas
      .filter((m) => m.zona_id === id && m.activo)
      .map((m) => ({
        id: m.id,
        nuevo: false,
        nombre: m.nombre,
        forma: m.forma,
        capacidad: m.capacidad,
        activo: true,
        ...geometria(m),
      })),
    elementos: c.elementos
      .filter((e) => e.zona_id === id && e.activo)
      .map((e) => ({
        id: e.id,
        nuevo: false,
        tipo: e.tipo,
        texto: e.texto,
        activo: true,
        ...geometria(e),
      })),
  }
}

export const zonaNueva = (c: CatalogoEdicion): BorradorZona => ({
  id: nuevoId(),
  nuevo: true,
  nombre: '',
  piso: 1,
  orden: c.zonas.length,
  activo: true,
  mesas: [],
  elementos: [],
})

/** El rectángulo que ocupa todo lo activo, con margen: lo que muestra el lienzo. */
export function limites(cosas: readonly Geometria[], margen = 40) {
  if (cosas.length === 0) return { x: 0, y: 0, ancho: 600, alto: 400 }
  // Con giro, la caja que ocupa una figura crece; se toma el círculo que la contiene.
  const cajas = cosas.map((g) => {
    const giro = g.rotacion % 180 !== 0
    const lado = giro ? Math.hypot(g.ancho, g.alto) : 0
    const cx = g.x + g.ancho / 2
    const cy = g.y + g.alto / 2
    const medioAncho = giro ? lado / 2 : g.ancho / 2
    const medioAlto = giro ? lado / 2 : g.alto / 2
    return { x0: cx - medioAncho, y0: cy - medioAlto, x1: cx + medioAncho, y1: cy + medioAlto }
  })
  const x0 = Math.min(...cajas.map((c) => c.x0)) - margen
  const y0 = Math.min(...cajas.map((c) => c.y0)) - margen
  const x1 = Math.max(...cajas.map((c) => c.x1)) + margen
  const y1 = Math.max(...cajas.map((c) => c.y1)) + margen
  return { x: x0, y: y0, ancho: x1 - x0, alto: y1 - y0 }
}

/** Medidas iniciales de cada forma de mesa, en cm, y cuántos se sientan. */
export const FORMAS: Record<
  FormaMesa,
  { nombre: string; ancho: number; alto: number; capacidad: number }
> = {
  cuadrada: { nombre: 'Cuadrada', ancho: 80, alto: 80, capacidad: 4 },
  redonda: { nombre: 'Redonda', ancho: 90, alto: 90, capacidad: 4 },
  rectangular: { nombre: 'Rectangular', ancho: 160, alto: 80, capacidad: 6 },
  barra: { nombre: 'Puesto de barra', ancho: 50, alto: 50, capacidad: 1 },
}

export const TIPOS_ELEMENTO: Record<TipoElemento, { nombre: string; ancho: number; alto: number }> =
  {
    pared: { nombre: 'Pared', ancho: 300, alto: 20 },
    puerta: { nombre: 'Puerta', ancho: 90, alto: 20 },
    planta: { nombre: 'Planta', ancho: 50, alto: 50 },
    barra: { nombre: 'Mostrador', ancho: 300, alto: 60 },
    texto: { nombre: 'Texto', ancho: 150, alto: 40 },
  }

/** El primer número que no usa ninguna mesa activa del restaurante (en cualquier zona). */
export function siguienteNombre(nombres: readonly string[]): string {
  const usados = new Set(nombres.map((n) => n.trim().toLowerCase()))
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
function lugarLibre(b: BorradorZona, ancho: number, alto: number) {
  const ocupado = [...b.mesas, ...b.elementos]
    .filter((x) => x.activo)
    .map((g) => {
      const c = limites([g], 0)
      return {
        x0: c.x - SEPARACION,
        y0: c.y - SEPARACION,
        x1: c.x + c.ancho + SEPARACION,
        y1: c.y + c.alto + SEPARACION,
      }
    })
  if (ocupado.length === 0) return { x: 0, y: 0 }
  const x0 = ajustar(Math.min(...ocupado.map((o) => o.x0)) + SEPARACION)
  const y0 = ajustar(Math.min(...ocupado.map((o) => o.y0)) + SEPARACION)
  const libre = (x: number, y: number) =>
    ocupado.every((o) => x + ancho <= o.x0 || x >= o.x1 || y + alto <= o.y0 || y >= o.y1)
  const paso = CUADRICULA * 2
  const hastaX = Math.max(x0 + ANCHO_HABITUAL, x0 + ancho)
  for (let y = y0; y + alto <= LIMITE; y += paso)
    for (let x = x0; x + ancho <= hastaX; x += paso) if (libre(x, y)) return { x, y }
  // El salón está lleno hasta el límite: se pone arriba a la izquierda y se acomoda a mano.
  return { x: x0, y: y0 }
}

export function nuevaMesa(
  b: BorradorZona,
  forma: FormaMesa,
  nombresUsados: readonly string[],
): MesaPlano {
  const f = FORMAS[forma]
  return {
    id: nuevoId(),
    nuevo: true,
    nombre: siguienteNombre(nombresUsados),
    forma,
    capacidad: f.capacidad,
    activo: true,
    ancho: f.ancho,
    alto: f.alto,
    rotacion: 0,
    ...lugarLibre(b, f.ancho, f.alto),
  }
}

/**
 * Varias mesas iguales de una vez, en filas, con los números siguientes: dibujar un salón de 25
 * mesas son unos pocos toques y luego se acomodan las que no van en cuadrícula.
 */
export function variasMesas(
  b: BorradorZona,
  forma: FormaMesa,
  cantidad: number,
  porFila: number,
  nombresUsados: readonly string[],
): MesaPlano[] {
  const f = FORMAS[forma]
  const separacion = SEPARACION
  const columnas = Math.max(1, Math.min(porFila, cantidad))
  const filas = Math.ceil(cantidad / columnas)
  // El bloque entero en un hueco libre, para que las mesas nuevas no caigan encima de otras.
  const inicio = lugarLibre(
    b,
    columnas * (f.ancho + separacion) - separacion,
    filas * (f.alto + separacion) - separacion,
  )
  const usados = [...nombresUsados]
  return Array.from({ length: cantidad }, (_, i) => {
    const nombre = siguienteNombre(usados)
    usados.push(nombre)
    const fila = Math.floor(i / columnas)
    const columna = i % columnas
    return {
      id: nuevoId(),
      nuevo: true,
      nombre,
      forma,
      capacidad: f.capacidad,
      activo: true,
      ancho: f.ancho,
      alto: f.alto,
      rotacion: 0,
      x: ajustar(inicio.x + columna * (f.ancho + separacion)),
      y: ajustar(inicio.y + fila * (f.alto + separacion)),
    }
  })
}

export function nuevoElemento(b: BorradorZona, tipo: TipoElemento): ElementoPlano {
  const t = TIPOS_ELEMENTO[tipo]
  return {
    id: nuevoId(),
    nuevo: true,
    tipo,
    texto: tipo === 'texto' ? 'Texto' : null,
    activo: true,
    ancho: t.ancho,
    alto: t.alto,
    rotacion: 0,
    ...lugarLibre(b, t.ancho, t.alto),
  }
}

/** Mover, girar o cambiar el tamaño, siempre en la cuadrícula y dentro de los límites. */
/** Lo que no es número (p. ej. de un campo vacío) deja el valor como estaba; ±∞ se acota. */
const numeroO = (n: number, si: number) => (Number.isNaN(n) ? si : n)

export function mover<T extends Geometria>(g: T, x: number, y: number): T {
  return {
    ...g,
    x: acotar(ajustar(numeroO(x, g.x)), -LIMITE, LIMITE),
    y: acotar(ajustar(numeroO(y, g.y)), -LIMITE, LIMITE),
  }
}

export function girar<T extends Geometria>(g: T, grados: number): T {
  return { ...g, rotacion: (((g.rotacion + grados) % 360) + 360) % 360 }
}

export function medir<T extends Geometria>(g: T, ancho: number, alto: number): T {
  return {
    ...g,
    ancho: acotar(ajustar(numeroO(ancho, g.ancho)), MEDIDA_MINIMA, LIMITE),
    alto: acotar(ajustar(numeroO(alto, g.alto)), MEDIDA_MINIMA, LIMITE),
  }
}

/** Qué impide guardar la zona, en palabras para la persona. */
export function problemasDeZona(c: CatalogoEdicion, b: BorradorZona): string[] {
  const problemas: string[] = []
  if (!b.nombre.trim()) problemas.push('Falta el nombre de la zona')
  const mesas = b.mesas.filter((m) => m.activo)
  if (mesas.some((m) => !m.nombre.trim())) problemas.push('Cada mesa lleva nombre')
  // El mesero dice "la 12": no puede haber dos, ni en esta zona ni en otra.
  const deOtras = c.mesas.filter((m) => m.activo && m.zona_id !== b.id).map((m) => m.nombre)
  const nombres = [...deOtras, ...mesas.map((m) => m.nombre)].map((n) =>
    n.trim().normalize('NFC').toLocaleLowerCase('es'),
  )
  const repetido = nombres.find((n, i) => n && nombres.indexOf(n) !== i)
  if (repetido) problemas.push(`Hay dos mesas que se llaman «${repetido}»`)
  if (mesas.some((m) => m.capacidad < 1)) problemas.push('Cada mesa es para al menos una persona')
  return problemas
}

/** Los cambios para dejar la zona como el borrador. Archivar la zona archiva lo que tiene. */
export function cambiosDeZona(c: CatalogoEdicion, b: BorradorZona): CambioCatalogo[] {
  const cambios: CambioCatalogo[] = []
  const original = b.nuevo ? undefined : c.zonas.find((z) => z.id === b.id)
  const archivar = !b.activo
  // Lo de adentro primero: el hub no deja archivar una zona con mesas activas.
  for (const m of b.mesas) {
    if (m.nuevo && (!m.activo || archivar)) continue
    const antes = m.nuevo ? undefined : c.mesas.find((x) => x.id === m.id)
    agregar(
      cambios,
      'mesa',
      m.id,
      diferencias(antes, {
        zona_id: b.id,
        nombre: m.nombre.trim(),
        forma: m.forma,
        capacidad: m.capacidad,
        ...geometria(m),
        activo: m.activo && !archivar,
      }),
    )
  }
  for (const e of b.elementos) {
    if (e.nuevo && (!e.activo || archivar)) continue
    const antes = e.nuevo ? undefined : c.elementos.find((x) => x.id === e.id)
    agregar(
      cambios,
      'elemento_plano',
      e.id,
      diferencias(antes, {
        zona_id: b.id,
        tipo: e.tipo,
        texto: e.tipo === 'texto' ? (e.texto?.trim() ?? '') : null,
        ...geometria(e),
        activo: e.activo && !archivar,
      }),
    )
  }
  const zona = {
    entidad: 'zona' as const,
    id: b.id,
    datos: diferencias(original, {
      nombre: b.nombre.trim(),
      piso: b.piso,
      orden: b.orden,
      activo: b.activo,
    }),
  }
  // Una zona nueva va antes que sus mesas (la referencia debe existir); archivarla, después.
  if (Object.keys(zona.datos).length > 0) {
    if (archivar) cambios.push(zona)
    else cambios.unshift(zona)
  }
  return cambios
}
