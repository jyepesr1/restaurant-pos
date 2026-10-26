import { PRICE_LIMIT } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type GroupDraft,
  groupChanges,
  groupDraft,
  groupIssues,
  newGroup,
  newProduct,
  type ProductDraft,
  productChanges,
  productDraft,
  productIssues,
  readPesos,
} from './drafts'
import type { CatalogChange, EditableCatalog } from './engine'

// Core property of the menu editor: applying to the catalog the changes that come out of a draft
// leaves a draft equal to the edited one. To "apply" we use a reference hub that follows the rules
// of `apps/hub/src/catalog-editing.ts` (all fields on create, the parent does not change, one link
// per pair, nothing active points to something archived). Fixed seed: deterministic.

const SEED = 20_261_024
const RUNS = 300

// ── Reference hub ────────────────────────────────────────────────────────────────────────────

type Entity = CatalogChange['entity']
type Registration = Record<string, string | number | boolean | null>

const TABLE: Record<Entity, keyof Omit<EditableCatalog, 'version'>> = {
  zones: 'zones',
  dining_tables: 'tables',
  floor_plan_elements: 'elements',
  taxes: 'taxes',
  stations: 'stations',
  categories: 'categories',
  products: 'products',
  variants: 'variants',
  modifier_groups: 'groups',
  product_modifier_groups: 'links',
  modifiers: 'modifiers',
}

const FIELDS: Record<Entity, string[]> = {
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
  taxes: ['name', 'type', 'rate', 'active'],
  stations: ['name', 'position', 'active'],
  categories: ['name', 'position', 'station_id', 'active'],
  products: ['category_id', 'name', 'description', 'price', 'tax_id', 'favorite', 'active'],
  variants: ['product_id', 'name', 'price', 'position', 'active'],
  modifier_groups: ['name', 'minimum', 'maximum', 'active'],
  product_modifier_groups: ['product_id', 'group_id', 'position', 'active'],
  modifiers: ['group_id', 'name', 'extra_price', 'position', 'active'],
}

const PARENTS: Partial<Record<Entity, string[]>> = {
  variants: ['product_id'],
  modifiers: ['group_id'],
  product_modifier_groups: ['product_id', 'group_id'],
}

const REFERENCES: Record<string, keyof Omit<EditableCatalog, 'version'>> = {
  station_id: 'stations',
  category_id: 'categories',
  tax_id: 'taxes',
  product_id: 'products',
  group_id: 'groups',
}

const whole = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

function validate(entity: Entity, r: Registration, where: string) {
  const badCase = (field: string) => {
    throw new Error(`${where}: invalid ${field} (${String(r[field])})`)
  }
  if ('name' in r) {
    const n = String(r.name)
    if (n !== n.trim() || n.length < 1 || n.length > 80) badCase('name')
  }
  for (const field of ['price', 'extra_price'])
    if (field in r && !whole(r[field], 0, PRICE_LIMIT)) badCase(field)
  if ('position' in r && !whole(r.position, 0, 10_000)) badCase('position')
  if (
    typeof r.description === 'string' &&
    (r.description !== r.description.trim() || r.description.length > 300)
  )
    badCase('description')
  if (typeof r.active !== 'boolean') badCase('active')
  if (entity === 'modifier_groups') {
    if (!whole(r.minimum, 0, 20)) badCase('minimum')
    if (!whole(r.maximum, 1, 20) || (r.maximum as number) < (r.minimum as number))
      badCase('maximum')
  }
}

/** Applies the changes as the hub would; throws if the hub would reject them (or if extra). */
function apply(source: EditableCatalog, changes: CatalogChange[]): EditableCatalog {
  const c = structuredClone(source)
  let version = c.version
  const touched: { entity: Entity; id: string; where: string }[] = []
  const tableName = (e: Entity) => c[TABLE[e]] as unknown as (Registration & { id: string })[]

  for (const [i, change] of changes.entries()) {
    const where = `Cambio ${i + 1} (${change.entity})`
    const keys = Object.keys(change.data)
    if (keys.length === 0) throw new Error(`${where}: changes nothing`)
    for (const k of keys)
      if (!FIELDS[change.entity].includes(k)) throw new Error(`${where}: field ${k} does not exist`)
    for (const [field, target] of Object.entries(REFERENCES)) {
      const value = change.data[field]
      if (typeof value === 'string' && !(c[target] as { id: string }[]).some((x) => x.id === value))
        throw new Error(`${where}: ${field} does not exist`)
    }
    const rows = tableName(change.entity)
    const current = rows.find((f) => f.id === change.id)
    if (!current) {
      for (const k of FIELDS[change.entity])
        if (!(k in change.data)) throw new Error(`${where}: missing ${k} on create`)
      const newOne = { id: change.id, version: ++version, ...change.data } as Registration & {
        id: string
      }
      validate(change.entity, newOne, where)
      rows.push(newOne)
    } else {
      for (const k of PARENTS[change.entity] ?? [])
        if (k in change.data && change.data[k] !== current[k])
          throw new Error(`${where}: cannot change ${k}`)
      const changing = Object.entries(change.data).filter(([k, v]) => current[k] !== v)
      // The hub would tolerate it, but a draft must not send fields that did not change.
      if (changing.length !== keys.length) throw new Error(`${where}: sends unchanged fields`)
      Object.assign(current, change.data, { version: ++version })
      validate(change.entity, current, where)
    }
    if (change.entity === 'product_modifier_groups') {
      const pair = (f: Registration) => `${f.product_id}|${f.group_id}`
      const sameOnes = tableName('product_modifier_groups').filter(
        (f) =>
          pair(f) ===
          pair(
            tableName('product_modifier_groups').find((x) => x.id === change.id) as Registration,
          ),
      )
      if (sameOnes.length > 1) throw new Error(`${where}: that product already has that group`)
    }
    touched.push({ entity: change.entity, id: change.id, where })
  }

  for (const t of touched) {
    const row = tableName(t.entity).find((f) => f.id === t.id) as Registration
    if (row.active === true) {
      for (const [field, target] of Object.entries(REFERENCES)) {
        const ref = row[field]
        const parent =
          typeof ref === 'string'
            ? (c[target] as unknown as Registration[]).find((x) => x.id === ref)
            : null
        if (typeof ref === 'string' && parent?.active !== true)
          throw new Error(`${t.where}: ${field.replace('_id', '')} is archived`)
      }
    } else if (t.entity === 'modifier_groups') {
      for (const e of c.links) if (e.group_id === t.id && e.active) e.active = false
    }
  }
  c.version = version
  return c
}

// ── Generators ───────────────────────────────────────────────────────────────────────────────

const arbBase = fc.stringMatching(/^[A-Za-zñÑáéíóú]{1,12}$/)
const arbSpaces = fc.constantFrom('', ' ', '  ', '\t')
/** A valid name with extra spaces on the sides: the draft trims them on save. */
const arbName = fc.tuple(arbSpaces, arbBase, arbSpaces).map(([a, b, c]) => `${a}${b}${c}`)
const arbDescription = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.stringMatching(/^[A-Za-z ,.]{1,40}$/),
)
const arbPrice = fc.integer({ min: 0, max: 400_000 })
const arbPositivePrice = fc.integer({ min: 1, max: 400_000 })
const reg = (id: string, active: boolean) => ({ id, version: 1, active })

interface EditSeed {
  activeTaxes: boolean[]
  activeCategories: boolean[]
  products: {
    active: boolean
    price: number
    desc: string | null
    variants: { price: number; active: boolean }[]
  }[]
  groups: {
    active: boolean
    min: number
    max: number
    options: { active: boolean; extra: number }[]
  }[]
  links: { active: boolean; uses: boolean }[][]
}

const arbSeed: fc.Arbitrary<EditSeed> = fc.record({
  activeTaxes: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  activeCategories: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  products: fc.array(
    fc.record({
      active: fc.boolean(),
      price: arbPrice,
      desc: fc.option(fc.stringMatching(/^[A-Za-z]{1,10}$/), { nil: null }),
      variants: fc.array(fc.record({ price: arbPositivePrice, active: fc.boolean() }), {
        maxLength: 4,
      }),
    }),
    { minLength: 4, maxLength: 4 },
  ),
  groups: fc.array(
    fc.record({
      active: fc.boolean(),
      min: fc.integer({ min: 0, max: 2 }),
      max: fc.integer({ min: 2, max: 5 }),
      options: fc.array(fc.record({ active: fc.boolean(), extra: arbPrice }), {
        minLength: 1,
        maxLength: 5,
      }),
    }),
    { minLength: 3, maxLength: 3 },
  ),
  links: fc.array(
    fc.array(fc.record({ active: fc.boolean(), uses: fc.boolean() }), {
      minLength: 3,
      maxLength: 3,
    }),
    { minLength: 4, maxLength: 4 },
  ),
})

/**
 * A consistent catalog: active things point to active things, there is always an active tax and
 * an active category. With `contiguous` (the normal case), the `position` of active things is 0,
 * 1, 2… and archived ones go last; without it, archived ones stay in place (as after archiving a
 * middle size).
 */
function editOf(s: EditSeed, contiguous = true): EditableCatalog {
  const arrange = <T extends { active: boolean }>(list: T[]) =>
    contiguous ? [...list.filter((x) => x.active), ...list.filter((x) => !x.active)] : list
  const taxes = s.activeTaxes.map((a, i) => ({
    ...reg(`IMP${i}`, i === 0 || a),
    name: `INC ${i}`,
    type: 'inc' as const,
    rate: 800,
  }))
  const categories = s.activeCategories.map((a, i) => ({
    ...reg(`CAT${i}`, i === 0 || a),
    name: `Cat ${i}`,
    position: i,
    station_id: null,
  }))
  const groups = s.groups.map((g, i) => ({
    ...reg(`GRP${i}`, i === 0 || g.active),
    name: `Grupo ${i}`,
    minimum: 0,
    maximum: Math.max(g.max, g.min, 1),
  }))
  const modifiers = s.groups.flatMap((g, gi) =>
    arrange(g.options).map((o, oi) => ({
      ...reg(`MOD${gi}_${oi}`, o.active && groups[gi]?.active === true),
      group_id: `GRP${gi}`,
      name: `Opción ${gi}.${oi}`,
      extra_price: o.extra,
      position: oi,
    })),
  )
  const products = s.products.map((p, i) => {
    const activeRows = taxes.filter((x) => x.active)
    const cats = categories.filter((x) => x.active)
    const active = p.active
    // With active sizes, the product's price is the cheapest one's (docs/DINERO.md).
    const from = p.variants.filter((v) => v.active && active).map((v) => v.price)
    return {
      ...reg(`PRO${i}`, active),
      category_id: (cats[i % cats.length] ?? categories[0])?.id as string,
      name: `Producto ${i}`,
      description: p.desc,
      price: from.length > 0 ? Math.min(...from) : p.price,
      tax_id: (activeRows[i % activeRows.length] ?? taxes[0])?.id as string,
      favorite: false,
    }
  })
  const variants = s.products.flatMap((p, pi) =>
    arrange(p.variants).map((v, vi) => ({
      ...reg(`VAR${pi}_${vi}`, v.active && products[pi]?.active === true),
      product_id: `PRO${pi}`,
      name: `Tamaño ${vi}`,
      price: v.price,
      position: vi,
    })),
  )
  const links = s.links.flatMap((row, pi) =>
    arrange(
      row
        .map((e, gi) => ({
          e,
          gi,
          active: e.active && products[pi]?.active === true && groups[gi]?.active === true,
        }))
        .filter(({ e }) => e.uses),
    ).map(({ gi, active }, position) => ({
      ...reg(`ENL${pi}_${gi}`, active),
      product_id: `PRO${pi}`,
      group_id: `GRP${gi}`,
      position,
    })),
  )
  return {
    version: 100,
    zones: [],
    tables: [],
    elements: [],
    taxes,
    stations: [],
    categories,
    products,
    variants,
    groups,
    links,
    modifiers,
  }
}

// ── What a draft looks like after saving it ──────────────────────────────────────────────────

/** The draft as read back after saving: trimmed, without archived things, with the "from" price. */
function resultingProduct(b: ProductDraft): ProductDraft {
  const activePrinters = b.variants.filter((v) => v.active)
  return {
    id: b.id,
    fresh: false,
    name: b.name.trim(),
    description: b.description.trim(),
    categoryId: b.categoryId,
    price: activePrinters.length > 0 ? Math.min(...activePrinters.map((v) => v.price)) : b.price,
    taxId: b.taxId,
    favorite: b.favorite,
    active: b.active,
    variants: activePrinters.map((v) => ({
      id: v.id,
      fresh: false,
      name: v.name.trim(),
      price: v.price,
      active: true,
    })),
    groups: [...b.groups],
  }
}

function resultingGroup(g: GroupDraft): GroupDraft {
  return {
    id: g.id,
    fresh: false,
    name: g.name.trim(),
    minimum: g.minimum,
    maximum: g.maximum,
    active: g.active,
    options: g.options
      .filter((o) => o.active)
      .map((o) => ({
        id: o.id,
        fresh: false,
        name: o.name.trim(),
        extraPrice: o.extraPrice,
        active: true,
      })),
  }
}

const sortBy = <T>(list: T[], keys: number[]): T[] =>
  list
    .map((x, i) => ({ x, k: keys[i % Math.max(keys.length, 1)] ?? 0, i }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map(({ x }) => x)

// ── Product ──────────────────────────────────────────────────────────────────────────────────

interface ProductEdit {
  index: number
  name: string | null
  description: string | null
  price: number | null
  categories: number | null
  taxes: number | null
  active: boolean | null
  variants: { name: string | null; price: number | null; active: boolean | null }[]
  newOnes: { price: number; active: boolean }[]
  variantKeys: number[]
  groups: boolean[]
  groupKeys: number[]
}

const arbProductEdit: fc.Arbitrary<ProductEdit> = fc.record({
  index: fc.integer({ min: 0, max: 3 }),
  name: fc.option(arbName, { nil: null }),
  description: fc.option(arbDescription, { nil: null }),
  price: fc.option(arbPrice, { nil: null }),
  categories: fc.option(fc.nat(5), { nil: null }),
  taxes: fc.option(fc.nat(5), { nil: null }),
  active: fc.option(fc.boolean(), { nil: null }),
  variants: fc.array(
    fc.record({
      name: fc.option(arbBase, { nil: null }),
      price: fc.option(arbPositivePrice, { nil: null }),
      active: fc.option(fc.boolean(), { nil: null }),
    }),
    { maxLength: 4 },
  ),
  newOnes: fc.array(fc.record({ price: arbPositivePrice, active: fc.boolean() }), {
    maxLength: 3,
  }),
  variantKeys: fc.array(fc.nat(3), { maxLength: 8 }),
  groups: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  groupKeys: fc.array(fc.nat(3), { maxLength: 3 }),
})

/** Edits the draft of an existing product as the person on screen would. */
function editProduct(c: EditableCatalog, e: ProductEdit): ProductDraft {
  const b = productDraft(c, `PRO${e.index}`)
  const taxes = c.taxes.filter((x) => x.active)
  const categories = c.categories.filter((x) => x.active)
  if (e.name !== null) b.name = e.name
  if (e.description !== null) b.description = e.description
  if (e.price !== null) b.price = e.price
  if (e.categories !== null)
    b.categoryId = categories[e.categories % categories.length]?.id ?? b.categoryId
  if (e.taxes !== null) b.taxId = taxes[e.taxes % taxes.length]?.id ?? b.taxId
  if (e.active !== null) b.active = e.active
  b.variants.forEach((v, i) => {
    const ed = e.variants[i]
    if (!ed) return
    // Distinct names per size: the draft does not allow saving two equal ones.
    if (ed.name !== null) v.name = `${ed.name} ${i}`
    if (ed.price !== null) v.price = ed.price
    if (ed.active !== null) v.active = ed.active
  })
  for (const [i, n] of e.newOnes.entries())
    b.variants.push({
      id: `NUEVA${i}`,
      fresh: true,
      name: `Nueva ${i}`,
      price: n.price,
      active: n.active,
    })
  b.variants = sortBy(b.variants, e.variantKeys)
  const groups = c.groups.filter((g) => g.active)
  b.groups = sortBy(
    groups.filter((_, i) => e.groups[i]).map((g) => g.id),
    e.groupKeys,
  )
  // An archived product is not touched inside (the hub does not allow changing active things under
  // something archived): see «archiving a product and touching one of its active sizes» in the
  // hub tests.
  if (!b.active) {
    const original = productDraft(c, b.id)
    b.variants = original.variants
    b.groups = original.groups
  }
  return b
}

describe('product: what is saved is what was edited', () => {
  it('applying the changes leaves a draft equal to the edited one', () => {
    fc.assert(
      fc.property(arbSeed, arbProductEdit, (seedValue, editView) => {
        const c = editOf(seedValue)
        const b = editProduct(c, editView)
        fc.pre(productIssues(b).length === 0)

        const after = apply(c, productChanges(c, b))

        expect(productDraft(after, b.id)).toEqual(resultingProduct(b))
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('without touching anything there are no changes, in any catalog', () => {
    fc.assert(
      fc.property(arbSeed, fc.integer({ min: 0, max: 3 }), (seedValue, i) => {
        const c = editOf(seedValue)
        expect(productChanges(c, productDraft(c, `PRO${i}`))).toEqual([])
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('a product does not end up with two links to the same group nor touches what is not its own', () => {
    fc.assert(
      fc.property(arbSeed, arbProductEdit, (seedValue, editView) => {
        const c = editOf(seedValue)
        const b = editProduct(c, editView)
        fc.pre(productIssues(b).length === 0)
        const changes = productChanges(c, b)
        const after = apply(c, changes)

        const pairs = after.links.map((e) => `${e.product_id}|${e.group_id}`)
        expect(new Set(pairs).size).toBe(pairs.length)
        // The changes only touch this product, its variants and its links.
        for (const change of changes) {
          if (change.entity === 'products') expect(change.id).toBe(b.id)
          else if (change.entity === 'variants' || change.entity === 'product_modifier_groups') {
            const row = (change.entity === 'variants' ? after.variants : after.links).find(
              (x) => x.id === change.id,
            )
            expect(row?.product_id).toBe(b.id)
          } else throw new Error(`Unexpected change: ${change.entity}`)
        }
        // The other products stay the same.
        for (const p of c.products.filter((x) => x.id !== b.id))
          expect(productDraft(after, p.id).name).toBe(productDraft(c, p.id).name)
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('a new product, with sizes and groups, is saved complete', () => {
    fc.assert(
      fc.property(
        arbSeed,
        arbName,
        arbDescription,
        arbPositivePrice,
        fc.array(fc.record({ price: arbPositivePrice, active: fc.boolean() }), { maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        (seedValue, name, description, price, sizes, groups) => {
          const c = editOf(seedValue)
          const category = c.categories.find((x) => x.active)?.id as string
          const b = newProduct(c, category)
          b.name = name
          b.description = description
          b.price = price
          b.variants = sizes.map((t, i) => ({
            id: `NV${i}`,
            fresh: true,
            name: `Tamaño nuevo ${i}`,
            price: t.price,
            active: t.active,
          }))
          b.groups = c.groups.filter((g, i) => g.active && groups[i]).map((g) => g.id)
          expect(productIssues(b)).toEqual([])

          const changes = productChanges(c, b)
          const after = apply(c, changes)

          expect(productDraft(after, b.id)).toEqual(resultingProduct(b))
          // The product goes first: its variants and links need it.
          expect(changes[0]).toMatchObject({ entity: 'products', id: b.id })
          // A new variant removed before saving is not sent.
          const removedIds = b.variants.filter((v) => !v.active).map((v) => v.id)
          expect(changes.some((x) => removedIds.includes(x.id))).toBe(false)
        },
      ),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('adding back a group that had been removed reactivates its link, does not create another', () => {
    fc.assert(
      fc.property(arbSeed, fc.integer({ min: 0, max: 3 }), (seedValue, i) => {
        const c = editOf(seedValue)
        const id = `PRO${i}`
        const before = productDraft(c, id)
        // All groups are removed and saved; then the same ones are added back.
        const without = { ...before, groups: [] }
        const c2 = apply(c, productChanges(c, without))
        const re_entry = { ...productDraft(c2, id), groups: before.groups }
        const c3 = apply(c2, productChanges(c2, re_entry))

        expect(productDraft(c3, id).groups).toEqual(before.groups)
        expect(c3.links.length).toBe(c.links.length)
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })
})

// ── Option group ─────────────────────────────────────────────────────────────────────────────

interface GroupEdit {
  index: number
  name: string | null
  minimum: number | null
  maximum: number | null
  active: boolean | null
  options: { name: string | null; extra: number | null; active: boolean | null }[]
  newOnes: { extra: number; active: boolean }[]
  keys: number[]
}

const arbGroupEdit: fc.Arbitrary<GroupEdit> = fc.record({
  index: fc.integer({ min: 0, max: 2 }),
  name: fc.option(arbName, { nil: null }),
  minimum: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  maximum: fc.option(fc.integer({ min: 1, max: 8 }), { nil: null }),
  active: fc.option(fc.boolean(), { nil: null }),
  options: fc.array(
    fc.record({
      name: fc.option(arbBase, { nil: null }),
      extra: fc.option(arbPrice, { nil: null }),
      active: fc.option(fc.boolean(), { nil: null }),
    }),
    { maxLength: 5 },
  ),
  newOnes: fc.array(fc.record({ extra: arbPrice, active: fc.boolean() }), { maxLength: 3 }),
  keys: fc.array(fc.nat(3), { maxLength: 8 }),
})

function editGroup(c: EditableCatalog, e: GroupEdit): GroupDraft {
  const g = groupDraft(c, `GRP${e.index}`)
  if (e.name !== null) g.name = e.name
  if (e.minimum !== null) g.minimum = e.minimum
  if (e.maximum !== null) g.maximum = e.maximum
  if (e.active !== null) g.active = e.active
  g.options.forEach((o, i) => {
    const ed = e.options[i]
    if (!ed) return
    if (ed.name !== null) o.name = `${ed.name} ${i}`
    if (ed.extra !== null) o.extraPrice = ed.extra
    if (ed.active !== null) o.active = ed.active
  })
  for (const [i, n] of e.newOnes.entries())
    g.options.push({
      id: `NUEVAOP${i}`,
      fresh: true,
      name: `Nueva ${i}`,
      extraPrice: n.extra,
      active: n.active,
    })
  g.options = sortBy(g.options, e.keys)
  // An archived group is not touched inside (see «archiving … at once» below).
  if (!g.active) g.options = groupDraft(c, g.id).options
  return g
}

describe('option group: what is saved is what was edited', () => {
  it('applying the changes leaves a draft equal to the edited one', () => {
    fc.assert(
      fc.property(arbSeed, arbGroupEdit, (seedValue, editView) => {
        const c = editOf(seedValue)
        const g = editGroup(c, editView)
        fc.pre(groupIssues(g).length === 0)

        const after = apply(c, groupChanges(c, g))

        expect(groupDraft(after, g.id)).toEqual(resultingGroup(g))
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('without touching anything there are no changes', () => {
    fc.assert(
      fc.property(arbSeed, fc.integer({ min: 0, max: 2 }), (seedValue, i) => {
        const c = editOf(seedValue)
        expect(groupChanges(c, groupDraft(c, `GRP${i}`))).toEqual([])
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('a new group with options is saved complete and leaves no removed options', () => {
    fc.assert(
      fc.property(
        arbSeed,
        arbName,
        fc.array(fc.record({ extra: arbPrice, active: fc.boolean() }), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 1, max: 5 }),
        (seedValue, name, options, minimum, maximum) => {
          const c = editOf(seedValue)
          const g = newGroup()
          g.name = name
          g.options = options.map((o, i) => ({
            id: `OP${i}`,
            fresh: true,
            name: `Opción ${i}`,
            extraPrice: o.extra,
            active: o.active,
          }))
          g.minimum = minimum
          g.maximum = Math.max(maximum, minimum, 1)
          fc.pre(groupIssues(g).length === 0)

          const changes = groupChanges(c, g)
          const after = apply(c, changes)

          expect(groupDraft(after, g.id)).toEqual(resultingGroup(g))
          expect(changes[0]).toMatchObject({ entity: 'modifier_groups', id: g.id })
          const removedIds = g.options.filter((o) => !o.active).map((o) => o.id)
          expect(changes.some((x) => removedIds.includes(x.id))).toBe(false)
        },
      ),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('the order of the options is kept after saving', () => {
    fc.assert(
      fc.property(
        arbSeed,
        fc.array(fc.nat(9), { minLength: 1, maxLength: 8 }),
        (seedValue, keys) => {
          const c = editOf(seedValue)
          const g = groupDraft(c, 'GRP0')
          g.options = sortBy(g.options, keys)
          const after = apply(c, groupChanges(c, g))
          expect(groupDraft(after, g.id).options.map((o) => o.id)).toEqual(
            g.options.map((o) => o.id),
          )
        },
      ),
      { seed: SEED, numRuns: RUNS },
    )
  })
})

// ── Findings: the order after archiving ──────────────────────────────────────────────────────
// These tests state how the editor MUST behave; today they fail (see the QA report).

describe('order of sizes and options when there are archived ones in between', () => {
  /** A product with three sizes; the middle one was archived before (position 0, 1 archived, 2). */
  function withArchivedSize(): EditableCatalog {
    const c = editOf(fc.sample(arbSeed, { seed: SEED, numRuns: 1 })[0] as EditSeed, false)
    c.variants = c.variants.filter((v) => v.product_id !== 'PRO0')
    c.variants.push(
      { ...reg('V0', true), product_id: 'PRO0', name: 'Copa', price: 10, position: 0 },
      { ...reg('V1', false), product_id: 'PRO0', name: 'Media', price: 20, position: 1 },
      { ...reg('V2', true), product_id: 'PRO0', name: 'Botella', price: 30, position: 2 },
    )
    const p = c.products.find((x) => x.id === 'PRO0')
    if (p) {
      p.active = true
      p.price = 10
    }
    return c
  }

  it('opening a product with a previously archived size and saving without editing sends nothing', () => {
    const c = withArchivedSize()
    expect(productChanges(c, productDraft(c, 'PRO0'))).toEqual([])
  })

  it('archiving that product does not touch its sizes (the hub forbids touching active things under archived ones)', () => {
    const c = withArchivedSize()
    const b = productDraft(c, 'PRO0')
    b.active = false
    const changes = productChanges(c, b)
    expect(changes.map((x) => x.entity)).toEqual(['products'])
    expect(() => apply(c, changes)).not.toThrow()
  })

  it('archiving a product and changing a size price at once does not send what the hub rejects', () => {
    const c = editOf(fc.sample(arbSeed, { seed: SEED, numRuns: 1 })[0] as EditSeed)
    c.variants = c.variants.filter((v) => v.product_id !== 'PRO0')
    c.variants.push({
      ...reg('V0', true),
      product_id: 'PRO0',
      name: 'Copa',
      price: 10,
      position: 0,
    })
    const p = c.products.find((x) => x.id === 'PRO0')
    if (p) {
      p.active = true
      p.price = 10
    }
    const b = productDraft(c, 'PRO0')
    b.active = false
    const glass = b.variants[0]
    if (!glass) throw new Error('missing')
    glass.price = 12
    expect(() => apply(c, productChanges(c, b))).not.toThrow()
  })

  it('archiving a group and changing an option price at once does not send what the hub rejects', () => {
    const c = editOf(fc.sample(arbSeed, { seed: SEED, numRuns: 1 })[0] as EditSeed)
    const g = groupDraft(c, 'GRP0')
    g.active = false
    const option = g.options[0]
    if (!option) throw new Error('missing')
    option.extraPrice += 500
    expect(() => apply(c, groupChanges(c, g))).not.toThrow()
  })

  it('saving twice: the second sends nothing, even if a middle size was archived', () => {
    fc.assert(
      fc.property(arbSeed, arbProductEdit, (seedValue, editView) => {
        const c = editOf(seedValue)
        const b = editProduct(c, editView)
        fc.pre(productIssues(b).length === 0)
        const after = apply(c, productChanges(c, b))

        expect(productChanges(after, productDraft(after, b.id))).toEqual([])
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('the same with the options of a group', () => {
    fc.assert(
      fc.property(arbSeed, arbGroupEdit, (seedValue, editView) => {
        const c = editOf(seedValue)
        const g = editGroup(c, editView)
        fc.pre(groupIssues(g).length === 0)
        const after = apply(c, groupChanges(c, g))

        expect(groupChanges(after, groupDraft(after, g.id))).toEqual([])
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })
})

describe('readPesos', () => {
  const withDots = (n: number) => n.toLocaleString('es-CO').replace(/\s/g, '')

  it('reads what the person types: the number with thousands dots, with $ or with spaces', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: PRICE_LIMIT }), (n) => {
        const base = withDots(n)
        expect(readPesos(base)).toBe(n)
        expect(readPesos(`$ ${base}`)).toBe(n)
        expect(readPesos(`  $${base}  `)).toBe(n)
        expect(readPesos(String(n))).toBe(n)
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('never returns anything other than a valid whole amount', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (text) => {
        const v = readPesos(text)
        if (v === null) return
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(PRICE_LIMIT)
      }),
      { seed: SEED, numRuns: 1_000 },
    )
  })

  it('does not confuse decimals with thousands nor accept comma, sign or scientific notation', () => {
    for (const t of [
      '1.5',
      '40.90',
      '1,5',
      '40,900',
      '-5',
      '+5',
      '1e3',
      '0x10',
      '1..000',
      '.500',
      '1.0000',
      '١٢٣',
    ])
      expect(readPesos(t), t).toBeNull()
  })
})

describe('the generator and the reference hub', () => {
  it('rejects what the hub would reject: creating without all fields and changing the parent', () => {
    const c = editOf(fc.sample(arbSeed, { seed: SEED, numRuns: 1 })[0] as EditSeed)
    expect(() => apply(c, [{ entity: 'variants', id: 'X', data: { product_id: 'PRO0' } }])).toThrow(
      /missing/,
    )
    expect(() =>
      apply(c, [{ entity: 'variants', id: 'VAR0_0', data: { product_id: 'PRO1' } }]),
    ).toThrow()
    expect(() => apply(c, [{ entity: 'products', id: 'PRO0', data: { name: ' x' } }])).toThrow(
      /invalid name/,
    )
  })
})
