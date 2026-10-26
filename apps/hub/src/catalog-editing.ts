import { BasisPoints, isValidId, Price } from '@pos/core'
import { inTransaction, type SqliteDatabase, type SqlValue } from '@pos/db'
import { z } from 'zod'
import { type Author, insertVersioned, updateVersioned } from './access/records'

// Editing the catalog and the dining room floor plan from the register (tasks 1.1 and 1.2). An
// edit request brings a list of changes that are applied all together or not at all: that way,
// creating a product with its variants never leaves a half-made product. Each touched record
// bumps its version and goes into the history (`catalog_changes`), which the copied-price
// check comes from.
//
// A record that does not exist is created (the device generates the id, ADR-006) and requires all
// its fields; one that exists is updated with the fields it brings. Nothing is deleted: it is
// archived with `active: false`.

const Id = z.string().refine(isValidId, 'Debe ser un ULID')
const Name = z.string().trim().min(1).max(80)
const Position = z.int().min(0).max(10_000)
const Active = z.boolean()
/** Position on the floor plan, in centimeters (a dining room up to 100 m). */
const Coordinate = z.int().min(-10_000).max(10_000)
const Size = z.int().min(5).max(10_000)
const Rotation = z.int().min(0).max(359)

const ENTITIES = {
  // The hub sets the location when creating the zone: for now there is only one.
  zones: z.strictObject({
    name: Name,
    position: Position,
    level: z.int().min(-5).max(100),
    active: Active,
  }),
  dining_tables: z.strictObject({
    zone_id: Id,
    name: z.string().trim().min(1).max(20),
    shape: z.enum(['round', 'square', 'rectangular', 'bar']),
    x: Coordinate,
    y: Coordinate,
    width: Size,
    height: Size,
    rotation: Rotation,
    capacity: z.int().min(1).max(100),
    active: Active,
  }),
  floor_plan_elements: z.strictObject({
    zone_id: Id,
    type: z.enum(['wall', 'door', 'plant', 'bar', 'text']),
    text: z.string().trim().max(60).nullable(),
    x: Coordinate,
    y: Coordinate,
    width: Size,
    height: Size,
    rotation: Rotation,
    active: Active,
  }),
  taxes: z.strictObject({
    name: Name,
    type: z.enum(['inc', 'iva', 'exempt']),
    rate: BasisPoints,
    active: Active,
  }),
  stations: z.strictObject({ name: Name, position: Position, active: Active }),
  categories: z.strictObject({
    name: Name,
    position: Position,
    station_id: Id.nullable(),
    active: Active,
  }),
  products: z.strictObject({
    category_id: Id,
    name: Name,
    description: z.string().trim().max(300).nullable(),
    price: Price,
    tax_id: Id,
    favorite: z.boolean(),
    active: Active,
  }),
  variants: z.strictObject({
    product_id: Id,
    name: Name,
    price: Price,
    position: Position,
    active: Active,
  }),
  modifier_groups: z.strictObject({
    name: Name,
    minimum: z.int().min(0).max(20),
    maximum: z.int().min(1).max(20),
    active: Active,
  }),
  product_modifier_groups: z.strictObject({
    product_id: Id,
    group_id: Id,
    position: Position,
    active: Active,
  }),
  modifiers: z.strictObject({
    group_id: Id,
    name: Name,
    extra_price: Price,
    position: Position,
    active: Active,
  }),
} as const

export type EditableEntity = keyof typeof ENTITIES
const NAMES = Object.keys(ENTITIES) as [EditableEntity, ...EditableEntity[]]

/** Which table each reference field points to. */
const REFERENCES: Record<string, string> = {
  zone_id: 'zones',
  station_id: 'stations',
  category_id: 'categories',
  tax_id: 'taxes',
  product_id: 'products',
  group_id: 'modifier_groups',
}

/** Only these fields change with the `edit_prices` permission; the rest needs `edit_catalog`. */
const PRICE_FIELDS: Partial<Record<EditableEntity, readonly string[]>> = {
  products: ['price'],
  variants: ['price'],
  modifiers: ['extra_price'],
}

export const EditRequest = z.strictObject({
  changes: z
    .array(
      z.strictObject({
        entity: z.enum(NAMES),
        id: Id,
        // Validated against the entity's schema when applying (complete when creating, partial
        // when updating).
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(200),
})
export type CatalogChange = z.infer<typeof EditRequest>['changes'][number]

/** Whether all changes are only price changes to records that already exist. */
export function pricesOnly(db: SqliteDatabase, restaurantId: string, changes: CatalogChange[]) {
  return changes.every((c) => {
    const fields = PRICE_FIELDS[c.entity]
    return (
      fields !== undefined &&
      exists(db, restaurantId, c.entity, c.id) &&
      Object.keys(c.data).every((k) => fields.includes(k))
    )
  })
}

const exists = (db: SqliteDatabase, restaurantId: string, tableName: string, id: string) =>
  db
    .prepare(`SELECT 1 FROM ${tableName} WHERE restaurant_id = ? AND id = ?`)
    .get(restaurantId, id) !== undefined

const toSql = (data: Record<string, unknown>): Record<string, SqlValue> =>
  Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      typeof v === 'boolean' ? (v ? 1 : 0) : (v as SqlValue),
    ]),
  )

export class EditError extends Error {}

/** The parent record does not change: a variant does not move to another product, nor an option to
 * another group. */
const PARENTS: Partial<Record<EditableEntity, readonly string[]>> = {
  variants: ['product_id'],
  modifiers: ['group_id'],
  product_modifier_groups: ['product_id', 'group_id'],
}

/** What cannot be archived while something active uses it. */
const DEPENDENTS: Partial<
  Record<EditableEntity, { tableName: string; field: string; what: string }>
> = {
  zones: { tableName: 'dining_tables', field: 'zone_id', what: 'mesas' },
  taxes: { tableName: 'products', field: 'tax_id', what: 'productos' },
  categories: { tableName: 'products', field: 'category_id', what: 'productos' },
  stations: { tableName: 'categories', field: 'station_id', what: 'categorías' },
}

/** The database rules, worded for the person. Other errors are not about the data: rethrown. */
function constraintMessage(error: unknown): string | null {
  const text = error instanceof Error ? error.message : ''
  if (!/constraint/i.test(text)) return null
  if (/UNIQUE/i.test(text)) return 'Ese producto ya tiene ese grupo de opciones'
  if (/maximum/i.test(text)) return 'El máximo debe ser al menos 1 y no menor que el mínimo'
  if (/exempt/i.test(text)) return 'Un impuesto exento no lleva tarifa'
  if (/FOREIGN/i.test(text)) return 'Apunta a un registro que no existe'
  return 'No cumple las reglas de la carta'
}

function mainLocation(db: SqliteDatabase, restaurantId: string): string {
  const location = db
    .prepare(
      'SELECT id FROM locations WHERE restaurant_id = ? AND active = 1 ORDER BY created_at LIMIT 1',
    )
    .get(restaurantId)
  if (!location) throw new EditError('El restaurante no tiene sede')
  return String(location.id)
}

const read = (db: SqliteDatabase, restaurantId: string, tableName: string, id: string) =>
  db.prepare(`SELECT * FROM ${tableName} WHERE restaurant_id = ? AND id = ?`).get(restaurantId, id)

/**
 * Applies the changes in a transaction. Returns the resulting catalog version and how many
 * records actually changed (a field equal to the saved one does not count: retrying the same
 * request does not bump the version or notify devices). Throws `EditError` with a message for the
 * person if something is invalid; then nothing is applied.
 */
export function applyChanges(
  db: SqliteDatabase,
  restaurantId: string,
  changes: CatalogChange[],
  author: Author,
  now: string,
  /** Whether the table has an open order: then it is not archived (the order would lose it). */
  occupiedTable: (tableId: string) => boolean = () => false,
): { version: number; changedCount: number } {
  return inTransaction(db, () => {
    const touched: { entity: EditableEntity; id: string; where: string }[] = []
    for (const [i, c] of changes.entries()) {
      const where = `Cambio ${i + 1} (${c.entity})`
      if (Object.keys(c.data).length === 0) throw new EditError(`${where}: no cambia nada`)
      // An id belongs to a single record type: the history must not mix them up.
      const other = db
        .prepare(
          'SELECT entity FROM catalog_changes WHERE restaurant_id = ? AND record_id = ? AND entity <> ? LIMIT 1',
        )
        .get(restaurantId, c.id, c.entity)
      if (other) throw new EditError(`${where}: ese id ya es de otro tipo de registro`)

      const current = read(db, restaurantId, c.entity, c.id)
      const schema = ENTITIES[c.entity]
      const parsed = (current ? schema.partial() : schema).safeParse(c.data)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new EditError(`${where}: ${issue?.path.join('.') || 'datos'}: ${issue?.message}`)
      }
      let data = toSql(parsed.data as Record<string, unknown>)
      for (const [field, tableName] of Object.entries(REFERENCES)) {
        const value = data[field]
        if (typeof value === 'string' && !read(db, restaurantId, tableName, value))
          throw new EditError(`${where}: ${field} no existe`)
      }
      if (current) {
        for (const field of PARENTS[c.entity] ?? [])
          if (field in data && data[field] !== current[field])
            throw new EditError(`${where}: no se puede pasar a otro ${field.replace('_id', '')}`)
        data = Object.fromEntries(Object.entries(data).filter(([k, v]) => current[k] !== v))
        if (Object.keys(data).length === 0) continue
      }
      if (!current && c.entity === 'zones') data.location_id = mainLocation(db, restaurantId)
      try {
        if (current) updateVersioned(db, c.entity, restaurantId, c.id, data, author, now)
        else insertVersioned(db, c.entity, restaurantId, data, author, now, c.id)
      } catch (error) {
        const message = constraintMessage(error)
        if (!message) throw error
        throw new EditError(`${where}: ${message}`)
      }
      touched.push({ entity: c.entity, id: c.id, where })
    }

    // With everything applied (a single request can archive products and then their category):
    for (const t of touched) {
      const row = read(db, restaurantId, t.entity, t.id)
      if (!row) continue
      if (row.active === 1) {
        // Active records do not point to archived ones: they would vanish from the menu silently.
        for (const [field, tableName] of Object.entries(REFERENCES)) {
          const ref = row[field]
          if (typeof ref === 'string' && read(db, restaurantId, tableName, ref)?.active !== 1)
            throw new EditError(`${t.where}: ${field.replace('_id', '')} está archivado`)
        }
        continue
      }
      if (t.entity === 'dining_tables' && occupiedTable(t.id))
        throw new EditError(`${t.where}: la mesa ${row.name} tiene un pedido abierto`)
      const dep = DEPENDENTS[t.entity]
      if (dep) {
        const usage = db
          .prepare(
            `SELECT count(*) AS n FROM ${dep.tableName} WHERE restaurant_id = ? AND ${dep.field} = ? AND active = 1`,
          )
          .get(restaurantId, t.id)
        const n = Number(usage?.n ?? 0)
        if (n > 0) throw new EditError(`${t.where}: lo usan ${n} ${dep.what}; cámbialos primero`)
      }
      if (t.entity === 'modifier_groups') {
        // Archiving a group removes it from the products that used it.
        const links = db
          .prepare(
            'SELECT id FROM product_modifier_groups WHERE restaurant_id = ? AND group_id = ? AND active = 1',
          )
          .all(restaurantId, t.id)
        for (const e of links)
          updateVersioned(
            db,
            'product_modifier_groups',
            restaurantId,
            String(e.id),
            { active: 0 },
            author,
            now,
          )
      }
    }
    // The waiter says "la 12": no two active tables share a name, even in different zones.
    // In JavaScript, not SQLite's lower(), which knows no accents or ñ ("Ñandú" = "ñandú").
    if (touched.some((t) => t.entity === 'dining_tables')) {
      const seenSet = new Set<string>()
      const names = db
        .prepare('SELECT name FROM dining_tables WHERE restaurant_id = ? AND active = 1')
        .all(restaurantId)
        .map((f) => String(f.name))
      for (const name of names) {
        const key = name.trim().normalize('NFC').toLocaleLowerCase('es')
        if (seenSet.has(key)) throw new EditError(`Hay dos mesas que se llaman «${name}»`)
        seenSet.add(key)
      }
    }
    const row = db
      .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
      .get(restaurantId)
    return { version: Number(row?.value ?? 0), changedCount: touched.length }
  })
}

/** The whole catalog, archived records included, for the editor. */
export function catalogForEditing(db: SqliteDatabase, restaurantId: string) {
  const allRows = (tableName: string, position: string) =>
    db
      .prepare(`SELECT * FROM ${tableName} WHERE restaurant_id = ? ORDER BY ${position}`)
      .all(restaurantId)
      .map(({ restaurant_id: _r, created_at: _c, user_id: _u, device_id: _d, ...f }) => ({
        ...f,
        active: f.active === 1,
        ...('favorite' in f ? { favorite: f.favorite === 1 } : {}),
      }))
  const version = db
    .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
    .get(restaurantId)
  return {
    version: Number(version?.value ?? 0),
    zones: allRows('zones', 'level, position, name').map((z) => {
      const { location_id: _s, ...rest } = z as Record<string, unknown>
      return rest
    }),
    tables: allRows('dining_tables', 'zone_id, name'),
    elements: allRows('floor_plan_elements', 'zone_id, version'),
    taxes: allRows('taxes', 'name'),
    stations: allRows('stations', 'position, name'),
    categories: allRows('categories', 'position, name'),
    products: allRows('products', 'name'),
    variants: allRows('variants', 'position, name'),
    groups: allRows('modifier_groups', 'name'),
    links: allRows('product_modifier_groups', 'position'),
    modifiers: allRows('modifiers', 'position, name'),
  }
}
