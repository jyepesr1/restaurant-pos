import { LIMITE_PRECIO } from '@pos/core'
import { parse } from 'yaml'
import { z } from 'zod'

// La carta de La Spritzzería (docs/datos/carta-la-spritzzeria.yaml) convertida al catálogo del POS
// según ADR-011: copa y botella del mismo vino son un solo producto con opciones; un sabor sin
// costo es una opción obligatoria; la carne lleva el término. Los precios son pesos enteros con
// INC incluido: un precio con decimales hace fallar la lectura.
//
// Se descartan a propósito: los textos en inglés, `picante` (no hay dónde guardarlo aún) y los
// platos con `disponible: false` (no se cargan; si ya estaban, el seed los archiva).

const Texto = z.object({ es: z.string(), en: z.string().optional() })

const Plato = z.object({
  nombre: Texto,
  descripcion: Texto.optional(),
  precio: z.int().min(0).max(LIMITE_PRECIO),
  disponible: z.boolean().default(true),
})

const Seccion = z.object({
  // Va dentro de los IDs: sin los separadores de las claves.
  clave: z.string().regex(/^[^:|\s]+$/, 'Clave de sección sin espacios ni ":"'),
  nombre: z.string(),
  grupo: z.enum(['comida', 'barra']),
  boton: Texto,
  foto: z.string().optional(),
  visible: z.boolean().default(true),
  platos: z.array(Plato),
})

const Carta = z.object({ secciones: z.array(Seccion).min(1) })

export type Estacion = 'cocina' | 'barra'

export interface GrupoCarta {
  /** Clave estable del grupo (un mismo grupo puede servir a varios productos). */
  clave: string
  nombre: string
  minimo: number
  maximo: number
  opciones: { nombre: string; precioExtra: number }[]
}

export interface ProductoCarta {
  clave: string
  nombre: string
  descripcion: string | null
  /** Con variantes, el de la más barata (la que se muestra primero). */
  precio: number
  variantes: { nombre: string; precio: number }[]
  grupos: GrupoCarta[]
}

export interface CategoriaCarta {
  clave: string
  nombre: string
  orden: number
  estacion: Estacion
  foto: string | null
  productos: ProductoCarta[]
}

/**
 * Término de la carne: sin costo, uno obligatorio. Opciones habituales en Colombia; el
 * restaurante las ajusta en el catálogo.
 */
export const TERMINO: GrupoCarta = {
  clave: 'termino',
  nombre: 'Término de la carne',
  minimo: 1,
  maximo: 1,
  opciones: ['Rojo', 'Medio', 'Tres cuartos', 'Bien asado'].map((nombre) => ({
    nombre,
    precioExtra: 0,
  })),
}

/** Productos de carne que se piden con término (secciones enteras o platos sueltos). */
export const CON_TERMINO = { secciones: ['HAMBURGUESAS'], platos: ['Tagliata di Manzo'] }

/**
 * Productos cuyo sabor es obligatorio y sin costo; la descripción trae la lista ("Rojo/Amarillo").
 * Lista explícita: adivinarlo por la forma de la descripción convertiría ingredientes en sabores.
 */
export const CON_SABOR = ['Té Hatsu', 'Soda Hatsu']

const TAMANOS = ['Copa', 'Botella'] as const

/** "Ramón Bilbao Crianza Copa" → { base: "Ramón Bilbao Crianza", tamano: "Copa" }. */
function separarTamano(nombre: string): { base: string; tamano: (typeof TAMANOS)[number] | null } {
  for (const tamano of TAMANOS) {
    if (nombre.endsWith(` ${tamano}`)) return { base: nombre.slice(0, -tamano.length - 1), tamano }
    if (nombre.startsWith(`${tamano} `)) return { base: nombre.slice(tamano.length + 1), tamano }
  }
  return { base: nombre, tamano: null }
}

const limpio = (texto: string | undefined) => {
  const t = texto?.trim() ?? ''
  return t === '' ? null : t
}

const claveDe = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Lee la carta exportada y la convierte en categorías y productos. Lanza si algo no cuadra. */
export function leerCarta(texto: string): CategoriaCarta[] {
  const carta = Carta.parse(parse(texto))
  const claves = new Set<string>()
  for (const seccion of carta.secciones) {
    if (claves.has(seccion.clave)) throw new Error(`Sección repetida: ${seccion.clave}`)
    claves.add(seccion.clave)
  }
  const categorias = carta.secciones
    .filter((s) => s.visible)
    .map((seccion, orden): CategoriaCarta => {
      return {
        clave: seccion.clave,
        nombre: seccion.boton.es.trim(),
        orden,
        estacion: seccion.grupo === 'comida' ? 'cocina' : 'barra',
        foto: limpio(seccion.foto),
        productos: productosDe(seccion),
      }
    })

  return categorias
}

/**
 * Platos con reglas propias (término, sabor) que la carta ya no trae: si cambió, la regla deja de
 * aplicarse sin que nadie lo note. El comando del seed lo avisa.
 */
export function reglasSinPlato(categorias: readonly CategoriaCarta[]): string[] {
  const nombres = new Set(categorias.flatMap((c) => c.productos.map((p) => p.nombre)))
  return [...CON_TERMINO.platos, ...CON_SABOR].filter((nombre) => !nombres.has(nombre))
}

/** "Rojo/Amarillo/Blanco" → sus sabores. Lanza si la lista no tiene al menos dos o se repite uno. */
function saboresDe(nombre: string, descripcion: string | null): string[] {
  const sabores = (descripcion ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (sabores.length < 2)
    throw new Error(`«${nombre}» debe traer sus sabores en la descripción (A/B)`)
  if (new Set(sabores.map(claveDe)).size !== sabores.length)
    throw new Error(`«${nombre}» repite un sabor: ${descripcion}`)
  return sabores
}

function productosDe(seccion: z.infer<typeof Seccion>): ProductoCarta[] {
  // Copa y botella del mismo vino se juntan si están las dos; si no, el plato queda como está.
  const porBase = new Map<string, z.infer<typeof Plato>[]>()
  for (const plato of seccion.platos.filter((p) => p.disponible)) {
    const { base, tamano } = separarTamano(plato.nombre.es.trim())
    const clave = tamano ? base : plato.nombre.es.trim()
    porBase.set(clave, [...(porBase.get(clave) ?? []), plato])
  }

  const productos: ProductoCarta[] = []
  const vistos = new Set<string>()
  for (const [base, platos] of porBase) {
    const tamanos = platos.map((p) => separarTamano(p.nombre.es.trim()).tamano)
    const conVariantes =
      platos.length > 1 && !tamanos.includes(null) && new Set(tamanos).size === platos.length
    const lista = conVariantes
      ? [{ base, platos }]
      : platos.map((p) => ({ base: p.nombre.es.trim(), platos: [p] }))

    for (const { base: nombre, platos: grupo } of lista) {
      const clave = `${seccion.clave}:${claveDe(nombre)}`
      if (vistos.has(clave)) throw new Error(`Plato repetido en ${seccion.clave}: ${nombre}`)
      vistos.add(clave)
      const primero = grupo[0] as z.infer<typeof Plato>
      const variantes = conVariantes
        ? grupo
            .map((p) => ({
              nombre: separarTamano(p.nombre.es.trim()).tamano as string,
              precio: p.precio,
            }))
            .sort((a, b) => TAMANOS.indexOf(a.nombre as never) - TAMANOS.indexOf(b.nombre as never))
        : []
      // Con variantes, la descripción del primero que la traiga.
      const descripcion =
        grupo.map((p) => limpio(p.descripcion?.es)).find((d) => d !== null) ?? null
      const sabores = CON_SABOR.includes(nombre) ? saboresDe(nombre, descripcion) : null
      const grupos: GrupoCarta[] = []
      if (sabores)
        grupos.push({
          clave: `sabor:${clave}`,
          nombre: 'Sabor',
          minimo: 1,
          maximo: 1,
          opciones: sabores.map((s) => ({ nombre: s, precioExtra: 0 })),
        })
      if (CON_TERMINO.secciones.includes(seccion.clave) || CON_TERMINO.platos.includes(nombre))
        grupos.push(TERMINO)

      productos.push({
        clave,
        nombre,
        descripcion: sabores ? null : descripcion,
        precio: variantes.length > 0 ? Math.min(...variantes.map((v) => v.precio)) : primero.precio,
        variantes,
        grupos,
      })
    }
  }
  return productos
}
