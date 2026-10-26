import { z } from 'zod'
import { PRICE_LIMIT } from '../money'

// La Spritzzería's exported menu (docs/datos/carta-la-spritzzeria.yaml, already parsed from YAML)
// converted to the POS catalog. Used by the hub seed and the app mockups; the caller reads the
// YAML (no file or text format dependencies here). Per ADR-011: a glass and a bottle of the
// same wine are a single product with options; a free flavor is a required option; meat takes
// doneness. Prices are whole pesos with INC included: a price with decimals fails parsing.
//
// Dropped on purpose: the English texts, `picante` (nowhere to store it yet) and dishes with
// `disponible: false` (not loaded; if they already existed, the seed archives them).

const LocalizedText = z.object({ es: z.string(), en: z.string().optional() })

const Dish = z.object({
  nombre: LocalizedText,
  descripcion: LocalizedText.optional(),
  precio: z.int().min(0).max(PRICE_LIMIT),
  disponible: z.boolean().default(true),
})

const Section = z.object({
  // Goes inside the IDs: without the key separators.
  clave: z.string().regex(/^[^:|\s]+$/, 'Clave de sección sin espacios ni ":"'),
  nombre: z.string(),
  grupo: z.enum(['comida', 'barra']),
  boton: LocalizedText,
  foto: z.string().optional(),
  visible: z.boolean().default(true),
  platos: z.array(Dish),
})

const Menu = z.object({ secciones: z.array(Section).min(1) })

export type Station = 'cocina' | 'barra'

export interface MenuGroup {
  /** Stable key of the group (the same group can serve several products). */
  key: string
  name: string
  minimum: number
  maximum: number
  options: { name: string; extraPrice: number }[]
}

export interface MenuProduct {
  key: string
  name: string
  description: string | null
  /** With variants, the cheapest one's (the one shown first). */
  price: number
  variants: { name: string; price: number }[]
  groups: MenuGroup[]
}

export interface MenuCategory {
  key: string
  name: string
  position: number
  station: Station
  photo: string | null
  products: MenuProduct[]
}

/**
 * Meat doneness: free, exactly one required. Usual options in Colombia; the restaurant
 * adjusts them in the catalog.
 */
export const DONENESS: MenuGroup = {
  key: 'termino',
  name: 'Término de la carne',
  minimum: 1,
  maximum: 1,
  options: ['Rojo', 'Medio', 'Tres cuartos', 'Bien asado'].map((name) => ({
    name,
    extraPrice: 0,
  })),
}

/** Meat products ordered with doneness (whole sections or individual dishes). */
export const WITH_DONENESS = { sections: ['HAMBURGUESAS'], dishes: ['Tagliata di Manzo'] }

/**
 * Products whose flavor is required and free; the description carries the list ("Rojo/Amarillo").
 * Explicit list: guessing it from the description's shape would turn ingredients into flavors.
 */
export const WITH_FLAVOR = ['Té Hatsu', 'Soda Hatsu']

const SIZES = ['Copa', 'Botella'] as const

/** "Ramón Bilbao Crianza Copa" → { base: "Ramón Bilbao Crianza", size: "Copa" }. */
function splitSize(name: string): { base: string; size: (typeof SIZES)[number] | null } {
  for (const size of SIZES) {
    if (name.endsWith(` ${size}`)) return { base: name.slice(0, -size.length - 1), size }
    if (name.startsWith(`${size} `)) return { base: name.slice(size.length + 1), size }
  }
  return { base: name, size: null }
}

const clean = (text: string | undefined) => {
  const t = text?.trim() ?? ''
  return t === '' ? null : t
}

const keyOf = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Converts the exported menu (already parsed from YAML) into categories and products. Throws if
 * anything is off.
 */
export function convertMenu(data: unknown): MenuCategory[] {
  const menu = Menu.parse(data)
  const keys = new Set<string>()
  for (const section of menu.secciones) {
    if (keys.has(section.clave)) throw new Error(`Sección repetida: ${section.clave}`)
    keys.add(section.clave)
  }
  const categories = menu.secciones
    .filter((s) => s.visible)
    .map((section, position): MenuCategory => {
      return {
        key: section.clave,
        name: section.boton.es.trim(),
        position,
        station: section.grupo === 'comida' ? 'cocina' : 'barra',
        photo: clean(section.foto),
        products: productsOf(section),
      }
    })

  return categories
}

/**
 * Dishes with their own rules (doneness, flavor) that the menu no longer has: if it changed, the
 * rule would silently stop applying. The seed command warns about it.
 */
export function rulesWithoutDish(categories: readonly MenuCategory[]): string[] {
  const names = new Set(categories.flatMap((c) => c.products.map((p) => p.name)))
  return [...WITH_DONENESS.dishes, ...WITH_FLAVOR].filter((name) => !names.has(name))
}

/** "Rojo/Amarillo/Blanco" → its flavors. Throws if the list has fewer than two or repeats one. */
function flavorsOf(name: string, description: string | null): string[] {
  const flavors = (description ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (flavors.length < 2)
    throw new Error(`«${name}» debe traer sus sabores en la descripción (A/B)`)
  if (new Set(flavors.map(keyOf)).size !== flavors.length)
    throw new Error(`«${name}» repite un sabor: ${description}`)
  return flavors
}

function productsOf(section: z.infer<typeof Section>): MenuProduct[] {
  // Glass and bottle of the same wine are merged if both exist; otherwise the dish stays as is.
  const byBase = new Map<string, z.infer<typeof Dish>[]>()
  for (const dish of section.platos.filter((p) => p.disponible)) {
    const { base, size } = splitSize(dish.nombre.es.trim())
    const key = size ? base : dish.nombre.es.trim()
    byBase.set(key, [...(byBase.get(key) ?? []), dish])
  }

  const products: MenuProduct[] = []
  const seenSet = new Set<string>()
  for (const [base, dishes] of byBase) {
    const sizes = dishes.map((p) => splitSize(p.nombre.es.trim()).size)
    const withVariants =
      dishes.length > 1 && !sizes.includes(null) && new Set(sizes).size === dishes.length
    const list = withVariants
      ? [{ base, dishes }]
      : dishes.map((p) => ({ base: p.nombre.es.trim(), dishes: [p] }))

    for (const { base: name, dishes: group } of list) {
      const key = `${section.clave}:${keyOf(name)}`
      if (seenSet.has(key)) throw new Error(`Plato repetido en ${section.clave}: ${name}`)
      seenSet.add(key)
      const firstOne = group[0] as z.infer<typeof Dish>
      const variants = withVariants
        ? group
            .map((p) => ({
              name: splitSize(p.nombre.es.trim()).size as string,
              price: p.precio,
            }))
            .sort((a, b) => SIZES.indexOf(a.name as never) - SIZES.indexOf(b.name as never))
        : []
      // With variants, the description of the first one that has it.
      const description = group.map((p) => clean(p.descripcion?.es)).find((d) => d !== null) ?? null
      const flavors = WITH_FLAVOR.includes(name) ? flavorsOf(name, description) : null
      const groups: MenuGroup[] = []
      if (flavors)
        groups.push({
          key: `sabor:${key}`,
          name: 'Sabor',
          minimum: 1,
          maximum: 1,
          options: flavors.map((s) => ({ name: s, extraPrice: 0 })),
        })
      if (WITH_DONENESS.sections.includes(section.clave) || WITH_DONENESS.dishes.includes(name))
        groups.push(DONENESS)

      products.push({
        key,
        name,
        description: flavors ? null : description,
        price: variants.length > 0 ? Math.min(...variants.map((v) => v.price)) : firstOne.precio,
        variants,
        groups,
      })
    }
  }
  return products
}
