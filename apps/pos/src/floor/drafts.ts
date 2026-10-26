import { newId, PRICE_LIMIT } from '@pos/core'
import type { CatalogChange, EditableCatalog } from './engine'

// The menu editor works on a draft of each product or option group; on save, the draft is
// compared with what was there and only the changes come out (a new record carries all its
// fields). Nothing is deleted: removing a variant or an option archives it.

/**
 * "40.900", "$ 40900" or "40 900" → 40900. `null` if it is not a valid whole-peso amount. The
 * dot is only valid as a thousands separator in its place: "1.5" or "40.90" are errors (not 15 or
 * 4.090), and the comma is never valid (there are no cents).
 */
export function readPesos(text: string): number | null {
  const clean = text.trim().replace(/^\$\s*/, '')
  if (!/^\d+$/.test(clean) && !/^\d{1,3}([. ]\d{3})+$/.test(clean)) return null
  const digits = clean.replace(/[. ]/g, '')
  if (digits.length > 9) return null
  const value = Number(digits)
  return value <= PRICE_LIMIT ? value : null
}

export interface VariantDraft {
  id: string
  fresh: boolean
  name: string
  price: number
  active: boolean
}

export interface ProductDraft {
  id: string
  fresh: boolean
  name: string
  description: string
  categoryId: string
  /** The price if it has no variants; with variants, the product's is the cheapest one's. */
  price: number
  taxId: string
  /** Shows in "Favoritos" during order entry. */
  favorite: boolean
  active: boolean
  variants: VariantDraft[]
  /** Option groups, in the order they are shown. */
  groups: string[]
}

export function productDraft(c: EditableCatalog, id: string): ProductDraft {
  const p = c.products.find((x) => x.id === id)
  if (!p) throw new Error('Ese producto no existe')
  return {
    id,
    fresh: false,
    name: p.name,
    description: p.description ?? '',
    categoryId: p.category_id,
    price: p.price,
    taxId: p.tax_id,
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

export function newProduct(c: EditableCatalog, categoryId: string): ProductDraft {
  return {
    id: newId(),
    fresh: true,
    name: '',
    description: '',
    categoryId,
    price: 0,
    taxId: c.taxes.find((i) => i.active)?.id ?? '',
    favorite: false,
    active: true,
    variants: [],
    groups: [],
  }
}

/** What the draft is missing before it can be saved, in words for the person. */
export function productIssues(b: ProductDraft): string[] {
  const issues: string[] = []
  if (!b.name.trim()) issues.push('Falta el nombre')
  if (b.fresh && b.price === 0 && !b.variants.some((v) => v.active))
    issues.push('Escribe el precio')
  if (!b.categoryId) issues.push('Falta la categoría')
  if (!b.taxId) issues.push('Falta el impuesto')
  const variants = b.variants.filter((v) => v.active)
  if (variants.some((v) => !v.name.trim())) issues.push('Cada tamaño lleva nombre')
  if (new Set(variants.map((v) => v.name.trim().toLowerCase())).size !== variants.length)
    issues.push('Hay dos tamaños con el mismo nombre')
  if (new Set(b.groups).size !== b.groups.length) issues.push('Un grupo de opciones está dos veces')
  return issues
}

/** The fields of `after` that differ from `before` (all of them if there was no `before`). */
export function diffs<T extends Record<string, unknown>>(
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
  changes: CatalogChange[],
  entity: CatalogChange['entity'],
  id: string,
  data: CatalogChange['data'],
) {
  if (Object.keys(data).length > 0) changes.push({ entity, id, data })
}

/**
 * The `position` of each active element, in list order. The one they already had is kept while
 * they stay in increasing order (archived ones leave gaps that do not matter) and new ones go
 * after the previous one: opening and saving without touching anything changes nothing. If that
 * is not possible (someone reordered), they are renumbered from 0.
 */
export function ranks(priors: readonly (number | undefined)[]): number[] {
  const result: number[] = []
  let latest = -1
  for (const [i, previous] of priors.entries()) {
    if (previous !== undefined && previous > latest) {
      result.push(previous)
      latest = previous
      continue
    }
    if (previous === undefined) {
      const next = priors.slice(i + 1).find((x) => x !== undefined)
      if (next === undefined || latest + 1 < next) {
        latest += 1
        result.push(latest)
        continue
      }
    }
    return priors.map((_, j) => j)
  }
  return result
}

/**
 * Links of a product with its groups (or of a group with its products): reuses the link that
 * already existed (the database requires a single one per pair), reactivates it or archives it.
 */
function linkChanges(
  c: EditableCatalog,
  productId: string,
  groups: string[],
  changes: CatalogChange[],
) {
  const ofProduct = c.links.filter((e) => e.product_id === productId)
  const places = ranks(
    groups.map((g) => ofProduct.find((e) => e.group_id === g && e.active)?.position),
  )
  groups.forEach((groupId, i) => {
    const position = places[i] as number
    const e = ofProduct.find((x) => x.group_id === groupId)
    if (!e)
      add(changes, 'product_modifier_groups', newId(), {
        product_id: productId,
        group_id: groupId,
        position,
        active: true,
      })
    else add(changes, 'product_modifier_groups', e.id, diffs(e, { position, active: true }))
  })
  for (const e of ofProduct)
    if (e.active && !groups.includes(e.group_id))
      add(changes, 'product_modifier_groups', e.id, { active: false })
}

/** The changes to make the product match the draft. */
export function productChanges(c: EditableCatalog, b: ProductDraft): CatalogChange[] {
  const changes: CatalogChange[] = []
  const variants = b.variants.filter((v) => v.active)
  const original = b.fresh ? undefined : c.products.find((p) => p.id === b.id)
  add(
    changes,
    'products',
    b.id,
    diffs(original, {
      category_id: b.categoryId,
      name: b.name.trim(),
      description: b.description.trim() || null,
      // With variants, the product's price only serves to show "desde" (DINERO.md).
      price: variants.length > 0 ? Math.min(...variants.map((v) => v.price)) : b.price,
      tax_id: b.taxId,
      favorite: b.favorite,
      active: b.active,
    }),
  )
  // Archiving the product does not touch its sizes or groups: the hub rejects active things that
  // point to something archived, and when it goes back on the menu they return as they were.
  if (!b.active && !b.fresh) return changes
  const places = new Map(
    ranks(variants.map((v) => c.variants.find((x) => x.id === v.id)?.position)).map((o, i) => [
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
      diffs(before, {
        product_id: b.id,
        name: v.name.trim(),
        price: v.price,
        position: v.active ? (places.get(v.id) ?? 0) : (before?.position ?? 0),
        active: v.active,
      }),
    )
  }
  linkChanges(c, b.id, b.groups, changes)
  return changes
}

export interface OptionDraft {
  id: string
  fresh: boolean
  name: string
  extraPrice: number
  active: boolean
}

export interface GroupDraft {
  id: string
  fresh: boolean
  name: string
  minimum: number
  maximum: number
  active: boolean
  options: OptionDraft[]
}

export function groupDraft(c: EditableCatalog, id: string): GroupDraft {
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

export const newGroup = (): GroupDraft => ({
  id: newId(),
  fresh: true,
  name: '',
  minimum: 0,
  maximum: 1,
  active: true,
  options: [],
})

export function groupIssues(g: GroupDraft): string[] {
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

export function groupChanges(c: EditableCatalog, g: GroupDraft): CatalogChange[] {
  const changes: CatalogChange[] = []
  const original = g.fresh ? undefined : c.groups.find((x) => x.id === g.id)
  add(
    changes,
    'modifier_groups',
    g.id,
    diffs(original, {
      name: g.name.trim(),
      minimum: g.minimum,
      maximum: g.maximum,
      active: g.active,
    }),
  )
  // As with the product: archiving the group does not touch its options.
  if (!g.active && !g.fresh) return changes
  const activePrinters = g.options.filter((o) => o.active)
  const places = new Map(
    ranks(activePrinters.map((o) => c.modifiers.find((x) => x.id === o.id)?.position)).map(
      (position, i) => [activePrinters[i]?.id, position],
    ),
  )
  for (const o of g.options) {
    if (o.fresh && !o.active) continue
    const before = o.fresh ? undefined : c.modifiers.find((x) => x.id === o.id)
    add(
      changes,
      'modifiers',
      o.id,
      diffs(before, {
        group_id: g.id,
        name: o.name.trim(),
        extra_price: o.extraPrice,
        position: o.active ? (places.get(o.id) ?? 0) : (before?.position ?? 0),
        active: o.active,
      }),
    )
  }
  return changes
}

/** The active products that use the group: to warn before changing or archiving it. */
export const groupProducts = (c: EditableCatalog, groupId: string) =>
  c.products.filter(
    (p) =>
      p.active && c.links.some((e) => e.group_id === groupId && e.active && e.product_id === p.id),
  )

export const productsWithGroup = (c: EditableCatalog, groupId: string) =>
  groupProducts(c, groupId).length
