import { PRICE_LIMIT } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type BorradorGrupo,
  type BorradorProducto,
  borradorDeGrupo,
  borradorDeProducto,
  cambiosDeGrupo,
  cambiosDeProducto,
  grupoNuevo,
  leerPesos,
  problemasDeGrupo,
  problemasDeProducto,
  productoNuevo,
} from './borradores'
import type { CambioCatalogo, CatalogoEdicion } from './motor'

// Propiedad central del editor de la carta: aplicar al catálogo los cambios que salen de un
// borrador deja un borrador igual al editado. Para "aplicar" se usa un hub de referencia que
// sigue las reglas de `apps/hub/src/edicion-catalogo.ts` (campos completos al crear, el padre no
// cambia, un enlace por par, nada activo apunta a algo archivado). Semilla fija: determinista.

const SEMILLA = 20_261_024
const CORRIDAS = 300

// ── Hub de referencia ────────────────────────────────────────────────────────────────────────

type Entidad = CambioCatalogo['entity']
type Registro = Record<string, string | number | boolean | null>

const TABLA: Record<Entidad, keyof Omit<CatalogoEdicion, 'version'>> = {
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

const CAMPOS: Record<Entidad, string[]> = {
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

const PADRES: Partial<Record<Entidad, string[]>> = {
  variants: ['product_id'],
  modifiers: ['group_id'],
  product_modifier_groups: ['product_id', 'group_id'],
}

const REFERENCIAS: Record<string, keyof Omit<CatalogoEdicion, 'version'>> = {
  station_id: 'stations',
  category_id: 'categories',
  tax_id: 'taxes',
  product_id: 'products',
  group_id: 'groups',
}

const entero = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

function validar(entity: Entidad, r: Registro, donde: string) {
  const badCase = (field: string) => {
    throw new Error(`${donde}: ${field} inválido (${String(r[field])})`)
  }
  if ('name' in r) {
    const n = String(r.name)
    if (n !== n.trim() || n.length < 1 || n.length > 80) badCase('name')
  }
  for (const field of ['price', 'extra_price'])
    if (field in r && !entero(r[field], 0, PRICE_LIMIT)) badCase(field)
  if ('position' in r && !entero(r.position, 0, 10_000)) badCase('position')
  if (
    typeof r.description === 'string' &&
    (r.description !== r.description.trim() || r.description.length > 300)
  )
    badCase('description')
  if (typeof r.active !== 'boolean') badCase('active')
  if (entity === 'modifier_groups') {
    if (!entero(r.minimum, 0, 20)) badCase('minimum')
    if (!entero(r.maximum, 1, 20) || (r.maximum as number) < (r.minimum as number))
      badCase('maximum')
  }
}

/** Aplica los cambios como lo haría el hub; lanza si el hub los rechazaría (o si sobra algo). */
function apply(source: CatalogoEdicion, changes: CambioCatalogo[]): CatalogoEdicion {
  const c = structuredClone(source)
  let version = c.version
  const tocados: { entity: Entidad; id: string; donde: string }[] = []
  const tableName = (e: Entidad) => c[TABLA[e]] as unknown as (Registro & { id: string })[]

  for (const [i, change] of changes.entries()) {
    const donde = `Cambio ${i + 1} (${change.entity})`
    const keys = Object.keys(change.data)
    if (keys.length === 0) throw new Error(`${donde}: no cambia nada`)
    for (const k of keys)
      if (!CAMPOS[change.entity].includes(k)) throw new Error(`${donde}: campo ${k} no existe`)
    for (const [field, target] of Object.entries(REFERENCIAS)) {
      const value = change.data[field]
      if (typeof value === 'string' && !(c[target] as { id: string }[]).some((x) => x.id === value))
        throw new Error(`${donde}: ${field} no existe`)
    }
    const rows = tableName(change.entity)
    const current = rows.find((f) => f.id === change.id)
    if (!current) {
      for (const k of CAMPOS[change.entity])
        if (!(k in change.data)) throw new Error(`${donde}: falta ${k} al crear`)
      const newOne = { id: change.id, version: ++version, ...change.data } as Registro & {
        id: string
      }
      validar(change.entity, newOne, donde)
      rows.push(newOne)
    } else {
      for (const k of PADRES[change.entity] ?? [])
        if (k in change.data && change.data[k] !== current[k])
          throw new Error(`${donde}: no se puede cambiar ${k}`)
      const cambia = Object.entries(change.data).filter(([k, v]) => current[k] !== v)
      // El hub lo toleraría, pero un borrador no debe mandar campos que no cambiaron.
      if (cambia.length !== keys.length) throw new Error(`${donde}: manda campos sin cambio`)
      Object.assign(current, change.data, { version: ++version })
      validar(change.entity, current, donde)
    }
    if (change.entity === 'product_modifier_groups') {
      const pair = (f: Registro) => `${f.product_id}|${f.group_id}`
      const mismos = tableName('product_modifier_groups').filter(
        (f) =>
          pair(f) ===
          pair(tableName('product_modifier_groups').find((x) => x.id === change.id) as Registro),
      )
      if (mismos.length > 1) throw new Error(`${donde}: ese producto ya tiene ese grupo`)
    }
    tocados.push({ entity: change.entity, id: change.id, donde })
  }

  for (const t of tocados) {
    const row = tableName(t.entity).find((f) => f.id === t.id) as Registro
    if (row.active === true) {
      for (const [field, target] of Object.entries(REFERENCIAS)) {
        const ref = row[field]
        const parent =
          typeof ref === 'string'
            ? (c[target] as unknown as Registro[]).find((x) => x.id === ref)
            : null
        if (typeof ref === 'string' && parent?.active !== true)
          throw new Error(`${t.donde}: ${field.replace('_id', '')} está archivado`)
      }
    } else if (t.entity === 'modifier_groups') {
      for (const e of c.links) if (e.group_id === t.id && e.active) e.active = false
    }
  }
  c.version = version
  return c
}

// ── Generadores ──────────────────────────────────────────────────────────────────────────────

const arbBase = fc.stringMatching(/^[A-Za-zñÑáéíóú]{1,12}$/)
const arbEspacios = fc.constantFrom('', ' ', '  ', '\t')
/** Un nombre válido con espacios de sobra a los lados: el borrador los recorta al guardar. */
const arbNombre = fc.tuple(arbEspacios, arbBase, arbEspacios).map(([a, b, c]) => `${a}${b}${c}`)
const arbDescripcion = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.stringMatching(/^[A-Za-z ,.]{1,40}$/),
)
const arbPrecio = fc.integer({ min: 0, max: 400_000 })
const arbPrecioPositivo = fc.integer({ min: 1, max: 400_000 })
const reg = (id: string, active: boolean) => ({ id, version: 1, active })

interface SemillaEdicion {
  activosImp: boolean[]
  activasCat: boolean[]
  products: {
    active: boolean
    price: number
    desc: string | null
    variants: { price: number; activa: boolean }[]
  }[]
  groups: {
    active: boolean
    min: number
    max: number
    options: { activa: boolean; extra: number }[]
  }[]
  links: { active: boolean; usa: boolean }[][]
}

const arbSemilla: fc.Arbitrary<SemillaEdicion> = fc.record({
  activosImp: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  activasCat: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  products: fc.array(
    fc.record({
      active: fc.boolean(),
      price: arbPrecio,
      desc: fc.option(fc.stringMatching(/^[A-Za-z]{1,10}$/), { nil: null }),
      variants: fc.array(fc.record({ price: arbPrecioPositivo, activa: fc.boolean() }), {
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
      options: fc.array(fc.record({ activa: fc.boolean(), extra: arbPrecio }), {
        minLength: 1,
        maxLength: 5,
      }),
    }),
    { minLength: 3, maxLength: 3 },
  ),
  links: fc.array(
    fc.array(fc.record({ active: fc.boolean(), usa: fc.boolean() }), {
      minLength: 3,
      maxLength: 3,
    }),
    { minLength: 4, maxLength: 4 },
  ),
})

/**
 * Un catálogo coherente: lo activo apunta a lo activo, siempre hay un impuesto y una categoría
 * activos. Con `contiguo` (lo normal), el `orden` de lo activo es 0, 1, 2… y lo archivado va al
 * final; sin él, lo archivado queda en su lugar (como tras archivar un tamaño del medio).
 */
function edicionDe(s: SemillaEdicion, contiguo = true): CatalogoEdicion {
  const acomodar = <T extends { activa: boolean }>(list: T[]) =>
    contiguo ? [...list.filter((x) => x.activa), ...list.filter((x) => !x.activa)] : list
  const taxes = s.activosImp.map((a, i) => ({
    ...reg(`IMP${i}`, i === 0 || a),
    name: `INC ${i}`,
    type: 'inc' as const,
    rate: 800,
  }))
  const categories = s.activasCat.map((a, i) => ({
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
    acomodar(g.options).map((o, oi) => ({
      ...reg(`MOD${gi}_${oi}`, o.activa && groups[gi]?.active === true),
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
    // Con tamaños activos, el precio del producto es el del más barato (docs/DINERO.md).
    const from = p.variants.filter((v) => v.activa && active).map((v) => v.price)
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
    acomodar(p.variants).map((v, vi) => ({
      ...reg(`VAR${pi}_${vi}`, v.activa && products[pi]?.active === true),
      product_id: `PRO${pi}`,
      name: `Tamaño ${vi}`,
      price: v.price,
      position: vi,
    })),
  )
  const links = s.links.flatMap((row, pi) =>
    acomodar(
      row
        .map((e, gi) => ({
          e,
          gi,
          activa: e.active && products[pi]?.active === true && groups[gi]?.active === true,
        }))
        .filter(({ e }) => e.usa),
    ).map(({ gi, activa }, position) => ({
      ...reg(`ENL${pi}_${gi}`, activa),
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

// ── Cómo queda un borrador después de guardarlo ──────────────────────────────────────────────

/** El borrador tal como se vuelve a leer tras guardar: recortado, sin lo archivado, con el precio "desde". */
function comoQuedaProducto(b: BorradorProducto): BorradorProducto {
  const activas = b.variants.filter((v) => v.active)
  return {
    id: b.id,
    fresh: false,
    name: b.name.trim(),
    description: b.description.trim(),
    categoriaId: b.categoriaId,
    price: activas.length > 0 ? Math.min(...activas.map((v) => v.price)) : b.price,
    impuestoId: b.impuestoId,
    favorite: b.favorite,
    active: b.active,
    variants: activas.map((v) => ({
      id: v.id,
      fresh: false,
      name: v.name.trim(),
      price: v.price,
      active: true,
    })),
    groups: [...b.groups],
  }
}

function comoQuedaGrupo(g: BorradorGrupo): BorradorGrupo {
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

const ordenar = <T>(list: T[], keys: number[]): T[] =>
  list
    .map((x, i) => ({ x, k: keys[i % Math.max(keys.length, 1)] ?? 0, i }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map(({ x }) => x)

// ── Producto ─────────────────────────────────────────────────────────────────────────────────

interface EdicionProducto {
  indice: number
  name: string | null
  description: string | null
  price: number | null
  categories: number | null
  taxes: number | null
  active: boolean | null
  variants: { name: string | null; price: number | null; active: boolean | null }[]
  newOnes: { price: number; active: boolean }[]
  clavesVariantes: number[]
  groups: boolean[]
  clavesGrupos: number[]
}

const arbEdicionProducto: fc.Arbitrary<EdicionProducto> = fc.record({
  indice: fc.integer({ min: 0, max: 3 }),
  name: fc.option(arbNombre, { nil: null }),
  description: fc.option(arbDescripcion, { nil: null }),
  price: fc.option(arbPrecio, { nil: null }),
  categories: fc.option(fc.nat(5), { nil: null }),
  taxes: fc.option(fc.nat(5), { nil: null }),
  active: fc.option(fc.boolean(), { nil: null }),
  variants: fc.array(
    fc.record({
      name: fc.option(arbBase, { nil: null }),
      price: fc.option(arbPrecioPositivo, { nil: null }),
      active: fc.option(fc.boolean(), { nil: null }),
    }),
    { maxLength: 4 },
  ),
  newOnes: fc.array(fc.record({ price: arbPrecioPositivo, active: fc.boolean() }), {
    maxLength: 3,
  }),
  clavesVariantes: fc.array(fc.nat(3), { maxLength: 8 }),
  groups: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  clavesGrupos: fc.array(fc.nat(3), { maxLength: 3 }),
})

/** Edita el borrador de un producto existente como lo haría la persona en pantalla. */
function editarProducto(c: CatalogoEdicion, e: EdicionProducto): BorradorProducto {
  const b = borradorDeProducto(c, `PRO${e.indice}`)
  const taxes = c.taxes.filter((x) => x.active)
  const categories = c.categories.filter((x) => x.active)
  if (e.name !== null) b.name = e.name
  if (e.description !== null) b.description = e.description
  if (e.price !== null) b.price = e.price
  if (e.categories !== null)
    b.categoriaId = categories[e.categories % categories.length]?.id ?? b.categoriaId
  if (e.taxes !== null) b.impuestoId = taxes[e.taxes % taxes.length]?.id ?? b.impuestoId
  if (e.active !== null) b.active = e.active
  b.variants.forEach((v, i) => {
    const ed = e.variants[i]
    if (!ed) return
    // Nombres distintos por tamaño: el borrador no deja guardar dos iguales.
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
  b.variants = ordenar(b.variants, e.clavesVariantes)
  const groups = c.groups.filter((g) => g.active)
  b.groups = ordenar(
    groups.filter((_, i) => e.groups[i]).map((g) => g.id),
    e.clavesGrupos,
  )
  // Un producto archivado no se toca por dentro (el hub no deja cambiar lo activo bajo algo
  // archivado): ver «archivar y cambiar un tamaño a la vez» en los tests del hub.
  if (!b.active) {
    const original = borradorDeProducto(c, b.id)
    b.variants = original.variants
    b.groups = original.groups
  }
  return b
}

describe('producto: lo que se guarda es lo que se editó', () => {
  it('aplicar los cambios deja un borrador igual al editado', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionProducto, (seedValue, edicion) => {
        const c = edicionDe(seedValue)
        const b = editarProducto(c, edicion)
        fc.pre(problemasDeProducto(b).length === 0)

        const after = apply(c, cambiosDeProducto(c, b))

        expect(borradorDeProducto(after, b.id)).toEqual(comoQuedaProducto(b))
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('sin tocar nada no hay cambios, en cualquier catálogo', () => {
    fc.assert(
      fc.property(arbSemilla, fc.integer({ min: 0, max: 3 }), (seedValue, i) => {
        const c = edicionDe(seedValue)
        expect(cambiosDeProducto(c, borradorDeProducto(c, `PRO${i}`))).toEqual([])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('un producto no queda con dos enlaces al mismo grupo ni toca lo que no es suyo', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionProducto, (seedValue, edicion) => {
        const c = edicionDe(seedValue)
        const b = editarProducto(c, edicion)
        fc.pre(problemasDeProducto(b).length === 0)
        const changes = cambiosDeProducto(c, b)
        const after = apply(c, changes)

        const pares = after.links.map((e) => `${e.product_id}|${e.group_id}`)
        expect(new Set(pares).size).toBe(pares.length)
        // Los cambios solo tocan este producto, sus variantes y sus enlaces.
        for (const change of changes) {
          if (change.entity === 'products') expect(change.id).toBe(b.id)
          else if (change.entity === 'variants' || change.entity === 'product_modifier_groups') {
            const row = (change.entity === 'variants' ? after.variants : after.links).find(
              (x) => x.id === change.id,
            )
            expect(row?.product_id).toBe(b.id)
          } else throw new Error(`Cambio inesperado: ${change.entity}`)
        }
        // Los demás productos quedan igual.
        for (const p of c.products.filter((x) => x.id !== b.id))
          expect(borradorDeProducto(after, p.id).name).toBe(borradorDeProducto(c, p.id).name)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('un producto nuevo, con tamaños y grupos, se guarda completo', () => {
    fc.assert(
      fc.property(
        arbSemilla,
        arbNombre,
        arbDescripcion,
        arbPrecioPositivo,
        fc.array(fc.record({ price: arbPrecioPositivo, activa: fc.boolean() }), { maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        (seedValue, name, description, price, sizes, groups) => {
          const c = edicionDe(seedValue)
          const category = c.categories.find((x) => x.active)?.id as string
          const b = productoNuevo(c, category)
          b.name = name
          b.description = description
          b.price = price
          b.variants = sizes.map((t, i) => ({
            id: `NV${i}`,
            fresh: true,
            name: `Tamaño nuevo ${i}`,
            price: t.price,
            active: t.activa,
          }))
          b.groups = c.groups.filter((g, i) => g.active && groups[i]).map((g) => g.id)
          expect(problemasDeProducto(b)).toEqual([])

          const changes = cambiosDeProducto(c, b)
          const after = apply(c, changes)

          expect(borradorDeProducto(after, b.id)).toEqual(comoQuedaProducto(b))
          // Lo primero es el producto: sus variantes y enlaces lo necesitan.
          expect(changes[0]).toMatchObject({ entity: 'products', id: b.id })
          // Una variante nueva que se quitó antes de guardar no viaja.
          const quitadas = b.variants.filter((v) => !v.active).map((v) => v.id)
          expect(changes.some((x) => quitadas.includes(x.id))).toBe(false)
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('volver a poner un grupo que se había quitado reactiva su enlace, no crea otro', () => {
    fc.assert(
      fc.property(arbSemilla, fc.integer({ min: 0, max: 3 }), (seedValue, i) => {
        const c = edicionDe(seedValue)
        const id = `PRO${i}`
        const before = borradorDeProducto(c, id)
        // Se quitan todos los grupos y se guarda; luego se vuelven a poner los mismos.
        const without = { ...before, groups: [] }
        const c2 = apply(c, cambiosDeProducto(c, without))
        const de_nuevo = { ...borradorDeProducto(c2, id), groups: before.groups }
        const c3 = apply(c2, cambiosDeProducto(c2, de_nuevo))

        expect(borradorDeProducto(c3, id).groups).toEqual(before.groups)
        expect(c3.links.length).toBe(c.links.length)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })
})

// ── Grupo de opciones ────────────────────────────────────────────────────────────────────────

interface EdicionGrupo {
  indice: number
  name: string | null
  minimum: number | null
  maximum: number | null
  active: boolean | null
  options: { name: string | null; extra: number | null; activa: boolean | null }[]
  newOnes: { extra: number; activa: boolean }[]
  keys: number[]
}

const arbEdicionGrupo: fc.Arbitrary<EdicionGrupo> = fc.record({
  indice: fc.integer({ min: 0, max: 2 }),
  name: fc.option(arbNombre, { nil: null }),
  minimum: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  maximum: fc.option(fc.integer({ min: 1, max: 8 }), { nil: null }),
  active: fc.option(fc.boolean(), { nil: null }),
  options: fc.array(
    fc.record({
      name: fc.option(arbBase, { nil: null }),
      extra: fc.option(arbPrecio, { nil: null }),
      activa: fc.option(fc.boolean(), { nil: null }),
    }),
    { maxLength: 5 },
  ),
  newOnes: fc.array(fc.record({ extra: arbPrecio, activa: fc.boolean() }), { maxLength: 3 }),
  keys: fc.array(fc.nat(3), { maxLength: 8 }),
})

function editarGrupo(c: CatalogoEdicion, e: EdicionGrupo): BorradorGrupo {
  const g = borradorDeGrupo(c, `GRP${e.indice}`)
  if (e.name !== null) g.name = e.name
  if (e.minimum !== null) g.minimum = e.minimum
  if (e.maximum !== null) g.maximum = e.maximum
  if (e.active !== null) g.active = e.active
  g.options.forEach((o, i) => {
    const ed = e.options[i]
    if (!ed) return
    if (ed.name !== null) o.name = `${ed.name} ${i}`
    if (ed.extra !== null) o.extraPrice = ed.extra
    if (ed.activa !== null) o.active = ed.activa
  })
  for (const [i, n] of e.newOnes.entries())
    g.options.push({
      id: `NUEVAOP${i}`,
      fresh: true,
      name: `Nueva ${i}`,
      extraPrice: n.extra,
      active: n.activa,
    })
  g.options = ordenar(g.options, e.keys)
  // Un grupo archivado no se toca por dentro (ver «archivar y cambiar a la vez» más abajo).
  if (!g.active) g.options = borradorDeGrupo(c, g.id).options
  return g
}

describe('grupo de opciones: lo que se guarda es lo que se editó', () => {
  it('aplicar los cambios deja un borrador igual al editado', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionGrupo, (seedValue, edicion) => {
        const c = edicionDe(seedValue)
        const g = editarGrupo(c, edicion)
        fc.pre(problemasDeGrupo(g).length === 0)

        const after = apply(c, cambiosDeGrupo(c, g))

        expect(borradorDeGrupo(after, g.id)).toEqual(comoQuedaGrupo(g))
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('sin tocar nada no hay cambios', () => {
    fc.assert(
      fc.property(arbSemilla, fc.integer({ min: 0, max: 2 }), (seedValue, i) => {
        const c = edicionDe(seedValue)
        expect(cambiosDeGrupo(c, borradorDeGrupo(c, `GRP${i}`))).toEqual([])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('un grupo nuevo con opciones se guarda completo y no deja opciones quitadas', () => {
    fc.assert(
      fc.property(
        arbSemilla,
        arbNombre,
        fc.array(fc.record({ extra: arbPrecio, activa: fc.boolean() }), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 1, max: 5 }),
        (seedValue, name, options, minimum, maximum) => {
          const c = edicionDe(seedValue)
          const g = grupoNuevo()
          g.name = name
          g.options = options.map((o, i) => ({
            id: `OP${i}`,
            fresh: true,
            name: `Opción ${i}`,
            extraPrice: o.extra,
            active: o.activa,
          }))
          g.minimum = minimum
          g.maximum = Math.max(maximum, minimum, 1)
          fc.pre(problemasDeGrupo(g).length === 0)

          const changes = cambiosDeGrupo(c, g)
          const after = apply(c, changes)

          expect(borradorDeGrupo(after, g.id)).toEqual(comoQuedaGrupo(g))
          expect(changes[0]).toMatchObject({ entity: 'modifier_groups', id: g.id })
          const quitadas = g.options.filter((o) => !o.active).map((o) => o.id)
          expect(changes.some((x) => quitadas.includes(x.id))).toBe(false)
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('el orden de las opciones se conserva tras guardar', () => {
    fc.assert(
      fc.property(
        arbSemilla,
        fc.array(fc.nat(9), { minLength: 1, maxLength: 8 }),
        (seedValue, keys) => {
          const c = edicionDe(seedValue)
          const g = borradorDeGrupo(c, 'GRP0')
          g.options = ordenar(g.options, keys)
          const after = apply(c, cambiosDeGrupo(c, g))
          expect(borradorDeGrupo(after, g.id).options.map((o) => o.id)).toEqual(
            g.options.map((o) => o.id),
          )
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })
})

// ── Hallazgos: el orden tras archivar ────────────────────────────────────────────────────────
// Estas pruebas dicen cómo DEBE comportarse el editor; hoy fallan (ver el informe de QA).

describe('orden de tamaños y opciones cuando hay archivados en medio', () => {
  /** Un producto con tres tamaños; el del medio fue archivado antes (orden 0, 1 archivado, 2). */
  function conTamanoArchivado(): CatalogoEdicion {
    const c = edicionDe(
      fc.sample(arbSemilla, { seed: SEMILLA, numRuns: 1 })[0] as SemillaEdicion,
      false,
    )
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

  it('abrir un producto con un tamaño archivado antes y guardar sin editar no manda nada', () => {
    const c = conTamanoArchivado()
    expect(cambiosDeProducto(c, borradorDeProducto(c, 'PRO0'))).toEqual([])
  })

  it('archivar ese producto no toca sus tamaños (el hub no deja tocar lo activo bajo algo archivado)', () => {
    const c = conTamanoArchivado()
    const b = borradorDeProducto(c, 'PRO0')
    b.active = false
    const changes = cambiosDeProducto(c, b)
    expect(changes.map((x) => x.entity)).toEqual(['products'])
    expect(() => apply(c, changes)).not.toThrow()
  })

  it('archivar un producto y cambiar el precio de un tamaño a la vez no manda lo que el hub rechaza', () => {
    const c = edicionDe(fc.sample(arbSemilla, { seed: SEMILLA, numRuns: 1 })[0] as SemillaEdicion)
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
    const b = borradorDeProducto(c, 'PRO0')
    b.active = false
    const glass = b.variants[0]
    if (!glass) throw new Error('falta')
    glass.price = 12
    expect(() => apply(c, cambiosDeProducto(c, b))).not.toThrow()
  })

  it('archivar un grupo y cambiar el precio de una opción a la vez no manda lo que el hub rechaza', () => {
    const c = edicionDe(fc.sample(arbSemilla, { seed: SEMILLA, numRuns: 1 })[0] as SemillaEdicion)
    const g = borradorDeGrupo(c, 'GRP0')
    g.active = false
    const option = g.options[0]
    if (!option) throw new Error('falta')
    option.extraPrice += 500
    expect(() => apply(c, cambiosDeGrupo(c, g))).not.toThrow()
  })

  it('guardar dos veces: la segunda no manda nada, aunque se haya archivado un tamaño del medio', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionProducto, (seedValue, edicion) => {
        const c = edicionDe(seedValue)
        const b = editarProducto(c, edicion)
        fc.pre(problemasDeProducto(b).length === 0)
        const after = apply(c, cambiosDeProducto(c, b))

        expect(cambiosDeProducto(after, borradorDeProducto(after, b.id))).toEqual([])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('lo mismo con las opciones de un grupo', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionGrupo, (seedValue, edicion) => {
        const c = edicionDe(seedValue)
        const g = editarGrupo(c, edicion)
        fc.pre(problemasDeGrupo(g).length === 0)
        const after = apply(c, cambiosDeGrupo(c, g))

        expect(cambiosDeGrupo(after, borradorDeGrupo(after, g.id))).toEqual([])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })
})

describe('leerPesos', () => {
  const conPuntos = (n: number) => n.toLocaleString('es-CO').replace(/\s/g, '')

  it('lee lo que escribe la persona: el número con puntos de miles, con $ o con espacios', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: PRICE_LIMIT }), (n) => {
        const base = conPuntos(n)
        expect(leerPesos(base)).toBe(n)
        expect(leerPesos(`$ ${base}`)).toBe(n)
        expect(leerPesos(`  $${base}  `)).toBe(n)
        expect(leerPesos(String(n))).toBe(n)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('nunca devuelve algo que no sea un monto entero válido', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (text) => {
        const v = leerPesos(text)
        if (v === null) return
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(PRICE_LIMIT)
      }),
      { seed: SEMILLA, numRuns: 1_000 },
    )
  })

  it('no confunde decimales con miles ni acepta coma, signo o notación científica', () => {
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
      expect(leerPesos(t), t).toBeNull()
  })
})

describe('el generador y el hub de referencia', () => {
  it('rechaza lo que el hub rechazaría: crear sin todos los campos y cambiar el padre', () => {
    const c = edicionDe(fc.sample(arbSemilla, { seed: SEMILLA, numRuns: 1 })[0] as SemillaEdicion)
    expect(() => apply(c, [{ entity: 'variants', id: 'X', data: { product_id: 'PRO0' } }])).toThrow(
      /falta/,
    )
    expect(() =>
      apply(c, [{ entity: 'variants', id: 'VAR0_0', data: { product_id: 'PRO1' } }]),
    ).toThrow()
    expect(() => apply(c, [{ entity: 'products', id: 'PRO0', data: { name: ' x' } }])).toThrow(
      /name inválido/,
    )
  })
})
