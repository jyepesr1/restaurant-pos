import { newId, PRICE_LIMIT } from '@pos/core'
import type { CambioCatalogo, CatalogoEdicion } from './motor'

// El editor de la carta trabaja sobre un borrador de cada producto o grupo de opciones; al
// guardar, el borrador se compara con lo que había y salen solo los cambios (un registro nuevo
// lleva todos sus campos). Nada se borra: quitar una variante o una opción la archiva.

/**
 * "40.900", "$ 40900" o "40 900" → 40900. `null` si no es un monto en pesos enteros válido. El
 * punto solo vale como separador de miles en su lugar: "1.5" o "40.90" son errores (no 15 ni
 * 4.090), y la coma nunca vale (no hay centavos).
 */
export function leerPesos(text: string): number | null {
  const clean = text.trim().replace(/^\$\s*/, '')
  if (!/^\d+$/.test(clean) && !/^\d{1,3}([. ]\d{3})+$/.test(clean)) return null
  const digitos = clean.replace(/[. ]/g, '')
  if (digitos.length > 9) return null
  const value = Number(digitos)
  return value <= PRICE_LIMIT ? value : null
}

export interface BorradorVariante {
  id: string
  fresh: boolean
  name: string
  price: number
  active: boolean
}

export interface BorradorProducto {
  id: string
  fresh: boolean
  name: string
  description: string
  categoriaId: string
  /** El precio si no tiene variantes; con variantes, el del producto es el de la más barata. */
  price: number
  impuestoId: string
  /** Sale en "Favoritos" al tomar el pedido. */
  favorite: boolean
  active: boolean
  variants: BorradorVariante[]
  /** Grupos de opciones, en el orden en que se muestran. */
  groups: string[]
}

export function borradorDeProducto(c: CatalogoEdicion, id: string): BorradorProducto {
  const p = c.products.find((x) => x.id === id)
  if (!p) throw new Error('Ese producto no existe')
  return {
    id,
    fresh: false,
    name: p.name,
    description: p.description ?? '',
    categoriaId: p.category_id,
    price: p.price,
    impuestoId: p.tax_id,
    favorite: p.favorite,
    active: p.active,
    variants: c.variants
      .filter((v) => v.product_id === id && v.active)
      .sort((a, b) => a.position - b.position)
      .map((v) => ({ id: v.id, fresh: false, name: v.name, price: v.price, active: true })),
    groups: c.links
      .filter((e) => e.product_id === id && e.active)
      .sort((a, b) => a.position - b.position)
      .map((e) => e.group_id),
  }
}

export function productoNuevo(c: CatalogoEdicion, categoriaId: string): BorradorProducto {
  return {
    id: newId(),
    fresh: true,
    name: '',
    description: '',
    categoriaId,
    price: 0,
    impuestoId: c.taxes.find((i) => i.active)?.id ?? '',
    favorite: false,
    active: true,
    variants: [],
    groups: [],
  }
}

/** Qué le falta al borrador para poder guardarlo, en palabras para la persona. */
export function problemasDeProducto(b: BorradorProducto): string[] {
  const issues: string[] = []
  if (!b.name.trim()) issues.push('Falta el nombre')
  if (b.fresh && b.price === 0 && !b.variants.some((v) => v.active))
    issues.push('Escribe el precio')
  if (!b.categoriaId) issues.push('Falta la categoría')
  if (!b.impuestoId) issues.push('Falta el impuesto')
  const variants = b.variants.filter((v) => v.active)
  if (variants.some((v) => !v.name.trim())) issues.push('Cada tamaño lleva nombre')
  if (new Set(variants.map((v) => v.name.trim().toLowerCase())).size !== variants.length)
    issues.push('Hay dos tamaños con el mismo nombre')
  if (new Set(b.groups).size !== b.groups.length) issues.push('Un grupo de opciones está dos veces')
  return issues
}

/** Los campos de `despues` que cambian respecto a `antes` (todos si no había `antes`). */
export function diferencias<T extends Record<string, unknown>>(
  before: object | undefined,
  after: T,
): Partial<T> {
  if (!before) return after
  const previous = before as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(after).filter(([k, v]) => previous[k] !== v),
  ) as Partial<T>
}

export function add(
  changes: CambioCatalogo[],
  entity: CambioCatalogo['entity'],
  id: string,
  data: CambioCatalogo['data'],
) {
  if (Object.keys(data).length > 0) changes.push({ entity, id, data })
}

/**
 * El `orden` de cada elemento activo, en el orden de la lista. Se conserva el que ya tenían
 * mientras sigan en orden creciente (lo archivado deja huecos que no importan) y lo nuevo va
 * después del anterior: abrir y guardar sin tocar nada no cambia nada. Si así no se puede
 * (alguien reordenó), se numera de nuevo desde 0.
 */
export function ordenes(previos: readonly (number | undefined)[]): number[] {
  const result: number[] = []
  let ultimo = -1
  for (const [i, previous] of previos.entries()) {
    if (previous !== undefined && previous > ultimo) {
      result.push(previous)
      ultimo = previous
      continue
    }
    if (previous === undefined) {
      const next = previos.slice(i + 1).find((x) => x !== undefined)
      if (next === undefined || ultimo + 1 < next) {
        ultimo += 1
        result.push(ultimo)
        continue
      }
    }
    return previos.map((_, j) => j)
  }
  return result
}

/**
 * Enlaces de un producto con sus grupos (o de un grupo con sus productos): reusa el enlace que
 * ya existía (la base exige uno solo por par), lo reactiva o lo archiva.
 */
function cambiosDeEnlaces(
  c: CatalogoEdicion,
  productId: string,
  groups: string[],
  changes: CambioCatalogo[],
) {
  const deProducto = c.links.filter((e) => e.product_id === productId)
  const lugar = ordenes(
    groups.map((g) => deProducto.find((e) => e.group_id === g && e.active)?.position),
  )
  groups.forEach((grupoId, i) => {
    const position = lugar[i] as number
    const e = deProducto.find((x) => x.group_id === grupoId)
    if (!e)
      add(changes, 'product_modifier_groups', newId(), {
        product_id: productId,
        group_id: grupoId,
        position,
        active: true,
      })
    else add(changes, 'product_modifier_groups', e.id, diferencias(e, { position, active: true }))
  })
  for (const e of deProducto)
    if (e.active && !groups.includes(e.group_id))
      add(changes, 'product_modifier_groups', e.id, { active: false })
}

/** Los cambios para dejar el producto como el borrador. */
export function cambiosDeProducto(c: CatalogoEdicion, b: BorradorProducto): CambioCatalogo[] {
  const changes: CambioCatalogo[] = []
  const variants = b.variants.filter((v) => v.active)
  const original = b.fresh ? undefined : c.products.find((p) => p.id === b.id)
  add(
    changes,
    'products',
    b.id,
    diferencias(original, {
      category_id: b.categoriaId,
      name: b.name.trim(),
      description: b.description.trim() || null,
      // Con variantes, el precio del producto solo sirve para mostrar "desde" (DINERO.md).
      price: variants.length > 0 ? Math.min(...variants.map((v) => v.price)) : b.price,
      tax_id: b.impuestoId,
      favorite: b.favorite,
      active: b.active,
    }),
  )
  // Archivar el producto no toca sus tamaños ni sus grupos: el hub rechaza lo activo que
  // apunta a algo archivado, y al volver a ponerlo en la carta vuelven como estaban.
  if (!b.active && !b.fresh) return changes
  const lugar = new Map(
    ordenes(variants.map((v) => c.variants.find((x) => x.id === v.id)?.position)).map((o, i) => [
      variants[i]?.id,
      o,
    ]),
  )
  for (const v of b.variants) {
    if (v.fresh && !v.active) continue
    const before = v.fresh ? undefined : c.variants.find((x) => x.id === v.id)
    add(
      changes,
      'variants',
      v.id,
      diferencias(before, {
        product_id: b.id,
        name: v.name.trim(),
        price: v.price,
        position: v.active ? (lugar.get(v.id) ?? 0) : (before?.position ?? 0),
        active: v.active,
      }),
    )
  }
  cambiosDeEnlaces(c, b.id, b.groups, changes)
  return changes
}

export interface BorradorOpcion {
  id: string
  fresh: boolean
  name: string
  extraPrice: number
  active: boolean
}

export interface BorradorGrupo {
  id: string
  fresh: boolean
  name: string
  minimum: number
  maximum: number
  active: boolean
  options: BorradorOpcion[]
}

export function borradorDeGrupo(c: CatalogoEdicion, id: string): BorradorGrupo {
  const g = c.groups.find((x) => x.id === id)
  if (!g) throw new Error('Ese grupo no existe')
  return {
    id,
    fresh: false,
    name: g.name,
    minimum: g.minimum,
    maximum: g.maximum,
    active: g.active,
    options: c.modifiers
      .filter((m) => m.group_id === id && m.active)
      .sort((a, b) => a.position - b.position)
      .map((m) => ({
        id: m.id,
        fresh: false,
        name: m.name,
        extraPrice: m.extra_price,
        active: true,
      })),
  }
}

export const grupoNuevo = (): BorradorGrupo => ({
  id: newId(),
  fresh: true,
  name: '',
  minimum: 0,
  maximum: 1,
  active: true,
  options: [],
})

export function problemasDeGrupo(g: BorradorGrupo): string[] {
  const issues: string[] = []
  const options = g.options.filter((o) => o.active)
  if (!g.name.trim()) issues.push('Falta el nombre')
  if (options.length === 0) issues.push('Agrega al menos una opción')
  if (options.some((o) => !o.name.trim())) issues.push('Cada opción lleva nombre')
  if (g.maximum < 1) issues.push('Se debe poder elegir al menos una')
  if (g.minimum > g.maximum) issues.push('El mínimo no puede pasar del máximo')
  if (g.minimum > options.length && options.length > 0)
    issues.push(`El mínimo (${g.minimum}) es mayor que las opciones que hay (${options.length})`)
  return issues
}

export function cambiosDeGrupo(c: CatalogoEdicion, g: BorradorGrupo): CambioCatalogo[] {
  const changes: CambioCatalogo[] = []
  const original = g.fresh ? undefined : c.groups.find((x) => x.id === g.id)
  add(
    changes,
    'modifier_groups',
    g.id,
    diferencias(original, {
      name: g.name.trim(),
      minimum: g.minimum,
      maximum: g.maximum,
      active: g.active,
    }),
  )
  // Como con el producto: archivar el grupo no toca sus opciones.
  if (!g.active && !g.fresh) return changes
  const activas = g.options.filter((o) => o.active)
  const lugar = new Map(
    ordenes(activas.map((o) => c.modifiers.find((x) => x.id === o.id)?.position)).map(
      (position, i) => [activas[i]?.id, position],
    ),
  )
  for (const o of g.options) {
    if (o.fresh && !o.active) continue
    const before = o.fresh ? undefined : c.modifiers.find((x) => x.id === o.id)
    add(
      changes,
      'modifiers',
      o.id,
      diferencias(before, {
        group_id: g.id,
        name: o.name.trim(),
        extra_price: o.extraPrice,
        position: o.active ? (lugar.get(o.id) ?? 0) : (before?.position ?? 0),
        active: o.active,
      }),
    )
  }
  return changes
}

/** Los productos activos que usan el grupo: para avisar antes de cambiarlo o archivarlo. */
export const productosDeGrupo = (c: CatalogoEdicion, grupoId: string) =>
  c.products.filter(
    (p) =>
      p.active && c.links.some((e) => e.group_id === grupoId && e.active && e.product_id === p.id),
  )

export const productosConGrupo = (c: CatalogoEdicion, grupoId: string) =>
  productosDeGrupo(c, grupoId).length
