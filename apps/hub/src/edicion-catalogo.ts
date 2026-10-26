import { BasisPoints, isValidId, Price } from '@pos/core'
import { inTransaction, type SqliteDatabase, type SqlValue } from '@pos/db'
import { z } from 'zod'
import { type Autor, actualizarVersionado, insertVersioned } from './acceso/registros'

// Edición del catálogo y del plano del salón desde la caja (tareas 1.1 y 1.2). Un pedido de edición trae una lista de cambios
// que se aplican juntos o ninguno: así, crear un producto con sus variantes no deja nunca un
// producto a medias. Cada registro tocado sube de versión y queda en el historial
// (`catalog_changes`), del que sale la revisión del precio copiado.
//
// Un registro que no existe se crea (el id lo genera el equipo, ADR-006) y pide todos sus
// campos; uno que existe se actualiza con los campos que traiga. Nada se borra: se archiva con
// `activo: false`.

const Id = z.string().refine(isValidId, 'Debe ser un ULID')
const Nombre = z.string().trim().min(1).max(80)
const Orden = z.int().min(0).max(10_000)
const Activo = z.boolean()
/** Posición en el plano, en centímetros (un salón de hasta 100 m). */
const Coordenada = z.int().min(-10_000).max(10_000)
const Medida = z.int().min(5).max(10_000)
const Rotacion = z.int().min(0).max(359)

const ENTITIES = {
  // La sede la pone el hub al crear la zona: por ahora hay una sola.
  zones: z.strictObject({
    name: Nombre,
    position: Orden,
    level: z.int().min(-5).max(100),
    active: Activo,
  }),
  dining_tables: z.strictObject({
    zone_id: Id,
    name: z.string().trim().min(1).max(20),
    shape: z.enum(['round', 'square', 'rectangular', 'bar']),
    x: Coordenada,
    y: Coordenada,
    width: Medida,
    height: Medida,
    rotation: Rotacion,
    capacity: z.int().min(1).max(100),
    active: Activo,
  }),
  floor_plan_elements: z.strictObject({
    zone_id: Id,
    type: z.enum(['wall', 'door', 'plant', 'bar', 'text']),
    text: z.string().trim().max(60).nullable(),
    x: Coordenada,
    y: Coordenada,
    width: Medida,
    height: Medida,
    rotation: Rotacion,
    active: Activo,
  }),
  taxes: z.strictObject({
    name: Nombre,
    type: z.enum(['inc', 'iva', 'exempt']),
    rate: BasisPoints,
    active: Activo,
  }),
  stations: z.strictObject({ name: Nombre, position: Orden, active: Activo }),
  categories: z.strictObject({
    name: Nombre,
    position: Orden,
    station_id: Id.nullable(),
    active: Activo,
  }),
  products: z.strictObject({
    category_id: Id,
    name: Nombre,
    description: z.string().trim().max(300).nullable(),
    price: Price,
    tax_id: Id,
    favorite: z.boolean(),
    active: Activo,
  }),
  variants: z.strictObject({
    product_id: Id,
    name: Nombre,
    price: Price,
    position: Orden,
    active: Activo,
  }),
  modifier_groups: z.strictObject({
    name: Nombre,
    minimum: z.int().min(0).max(20),
    maximum: z.int().min(1).max(20),
    active: Activo,
  }),
  product_modifier_groups: z.strictObject({
    product_id: Id,
    group_id: Id,
    position: Orden,
    active: Activo,
  }),
  modifiers: z.strictObject({
    group_id: Id,
    name: Nombre,
    extra_price: Price,
    position: Orden,
    active: Activo,
  }),
} as const

export type EntidadEditable = keyof typeof ENTITIES
const NOMBRES = Object.keys(ENTITIES) as [EntidadEditable, ...EntidadEditable[]]

/** A qué tabla apunta cada campo que es una referencia. */
const REFERENCIAS: Record<string, string> = {
  zone_id: 'zones',
  station_id: 'stations',
  category_id: 'categories',
  tax_id: 'taxes',
  product_id: 'products',
  group_id: 'modifier_groups',
}

/** Solo estos campos cambian con el permiso `edit_prices`; todo lo demás pide `edit_catalog`. */
const CAMPOS_DE_PRECIO: Partial<Record<EntidadEditable, readonly string[]>> = {
  products: ['price'],
  variants: ['price'],
  modifiers: ['extra_price'],
}

export const PedidoEdicion = z.strictObject({
  changes: z
    .array(
      z.strictObject({
        entity: z.enum(NOMBRES),
        id: Id,
        // Se valida contra el esquema de la entidad al aplicar (completo al crear, parcial al
        // actualizar).
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(200),
})
export type CambioCatalogo = z.infer<typeof PedidoEdicion>['changes'][number]

/** Si todos los cambios son solo de precio de registros que ya existen. */
export function soloPrecios(db: SqliteDatabase, restaurantId: string, changes: CambioCatalogo[]) {
  return changes.every((c) => {
    const fields = CAMPOS_DE_PRECIO[c.entity]
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

const aSql = (data: Record<string, unknown>): Record<string, SqlValue> =>
  Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      typeof v === 'boolean' ? (v ? 1 : 0) : (v as SqlValue),
    ]),
  )

export class ErrorEdicion extends Error {}

/** El registro padre no se cambia: una variante no pasa a otro producto, ni una opción a otro grupo. */
const PADRES: Partial<Record<EntidadEditable, readonly string[]>> = {
  variants: ['product_id'],
  modifiers: ['group_id'],
  product_modifier_groups: ['product_id', 'group_id'],
}

/** Lo que no se puede archivar mientras algo activo lo use. */
const DEPENDIENTES: Partial<
  Record<EntidadEditable, { tableName: string; field: string; que: string }>
> = {
  zones: { tableName: 'dining_tables', field: 'zone_id', que: 'mesas' },
  taxes: { tableName: 'products', field: 'tax_id', que: 'productos' },
  categories: { tableName: 'products', field: 'category_id', que: 'productos' },
  stations: { tableName: 'categories', field: 'station_id', que: 'categorías' },
}

/** Las reglas de la base, dichas para la persona. Otros errores no son de los datos: se relanzan. */
function mensajeDeRestriccion(error: unknown): string | null {
  const text = error instanceof Error ? error.message : ''
  if (!/constraint/i.test(text)) return null
  if (/UNIQUE/i.test(text)) return 'Ese producto ya tiene ese grupo de opciones'
  if (/maximum/i.test(text)) return 'El máximo debe ser al menos 1 y no menor que el mínimo'
  if (/exempt/i.test(text)) return 'Un impuesto exento no lleva tarifa'
  if (/FOREIGN/i.test(text)) return 'Apunta a un registro que no existe'
  return 'No cumple las reglas de la carta'
}

function sedePrincipal(db: SqliteDatabase, restaurantId: string): string {
  const location = db
    .prepare(
      'SELECT id FROM locations WHERE restaurant_id = ? AND active = 1 ORDER BY created_at LIMIT 1',
    )
    .get(restaurantId)
  if (!location) throw new ErrorEdicion('El restaurante no tiene sede')
  return String(location.id)
}

const read = (db: SqliteDatabase, restaurantId: string, tableName: string, id: string) =>
  db.prepare(`SELECT * FROM ${tableName} WHERE restaurant_id = ? AND id = ?`).get(restaurantId, id)

/**
 * Aplica los cambios en una transacción. Devuelve la versión del catálogo que quedó y cuántos
 * registros cambiaron de verdad (un campo igual al guardado no cuenta: reintentar el mismo pedido
 * no sube la versión ni avisa a los equipos). Lanza `ErrorEdicion` con un mensaje para la persona
 * si algo no vale; entonces no se aplica nada.
 */
export function aplicarCambios(
  db: SqliteDatabase,
  restaurantId: string,
  changes: CambioCatalogo[],
  autor: Autor,
  now: string,
  /** Si la mesa tiene un pedido abierto: entonces no se archiva (el pedido quedaría sin mesa). */
  occupiedTable: (tableId: string) => boolean = () => false,
): { version: number; cambiados: number } {
  return inTransaction(db, () => {
    const tocados: { entity: EntidadEditable; id: string; donde: string }[] = []
    for (const [i, c] of changes.entries()) {
      const donde = `Cambio ${i + 1} (${c.entity})`
      if (Object.keys(c.data).length === 0) throw new ErrorEdicion(`${donde}: no cambia nada`)
      // Un id es de un solo tipo de registro: el historial no debe confundirlos.
      const other = db
        .prepare(
          'SELECT entity FROM catalog_changes WHERE restaurant_id = ? AND record_id = ? AND entity <> ? LIMIT 1',
        )
        .get(restaurantId, c.id, c.entity)
      if (other) throw new ErrorEdicion(`${donde}: ese id ya es de otro tipo de registro`)

      const current = read(db, restaurantId, c.entity, c.id)
      const esquema = ENTITIES[c.entity]
      const parsed = (current ? esquema.partial() : esquema).safeParse(c.data)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new ErrorEdicion(`${donde}: ${issue?.path.join('.') || 'datos'}: ${issue?.message}`)
      }
      let data = aSql(parsed.data as Record<string, unknown>)
      for (const [field, tableName] of Object.entries(REFERENCIAS)) {
        const value = data[field]
        if (typeof value === 'string' && !read(db, restaurantId, tableName, value))
          throw new ErrorEdicion(`${donde}: ${field} no existe`)
      }
      if (current) {
        for (const field of PADRES[c.entity] ?? [])
          if (field in data && data[field] !== current[field])
            throw new ErrorEdicion(`${donde}: no se puede pasar a otro ${field.replace('_id', '')}`)
        data = Object.fromEntries(Object.entries(data).filter(([k, v]) => current[k] !== v))
        if (Object.keys(data).length === 0) continue
      }
      if (!current && c.entity === 'zones') data.location_id = sedePrincipal(db, restaurantId)
      try {
        if (current) actualizarVersionado(db, c.entity, restaurantId, c.id, data, autor, now)
        else insertVersioned(db, c.entity, restaurantId, data, autor, now, c.id)
      } catch (error) {
        const message = mensajeDeRestriccion(error)
        if (!message) throw error
        throw new ErrorEdicion(`${donde}: ${message}`)
      }
      tocados.push({ entity: c.entity, id: c.id, donde })
    }

    // Con todo aplicado (un mismo pedido puede archivar productos y luego su categoría):
    for (const t of tocados) {
      const row = read(db, restaurantId, t.entity, t.id)
      if (!row) continue
      if (row.active === 1) {
        // Lo activo no apunta a algo archivado: no desaparecería de la carta sin avisar.
        for (const [field, tableName] of Object.entries(REFERENCIAS)) {
          const ref = row[field]
          if (typeof ref === 'string' && read(db, restaurantId, tableName, ref)?.active !== 1)
            throw new ErrorEdicion(`${t.donde}: ${field.replace('_id', '')} está archivado`)
        }
        continue
      }
      if (t.entity === 'dining_tables' && occupiedTable(t.id))
        throw new ErrorEdicion(`${t.donde}: la mesa ${row.name} tiene un pedido abierto`)
      const dep = DEPENDIENTES[t.entity]
      if (dep) {
        const usan = db
          .prepare(
            `SELECT count(*) AS n FROM ${dep.tableName} WHERE restaurant_id = ? AND ${dep.field} = ? AND active = 1`,
          )
          .get(restaurantId, t.id)
        const n = Number(usan?.n ?? 0)
        if (n > 0) throw new ErrorEdicion(`${t.donde}: lo usan ${n} ${dep.que}; cámbialos primero`)
      }
      if (t.entity === 'modifier_groups') {
        // Archivar un grupo lo quita de los productos que lo usaban.
        const links = db
          .prepare(
            'SELECT id FROM product_modifier_groups WHERE restaurant_id = ? AND group_id = ? AND active = 1',
          )
          .all(restaurantId, t.id)
        for (const e of links)
          actualizarVersionado(
            db,
            'product_modifier_groups',
            restaurantId,
            String(e.id),
            { active: 0 },
            autor,
            now,
          )
      }
    }
    // El mesero dice "la 12": dos mesas activas no se llaman igual, aunque estén en zonas distintas.
    // En JavaScript y no con lower() de SQLite, que no conoce tildes ni eñes ("Ñandú" = "ñandú").
    if (tocados.some((t) => t.entity === 'dining_tables')) {
      const seenSet = new Set<string>()
      const names = db
        .prepare('SELECT name FROM dining_tables WHERE restaurant_id = ? AND active = 1')
        .all(restaurantId)
        .map((f) => String(f.name))
      for (const name of names) {
        const key = name.trim().normalize('NFC').toLocaleLowerCase('es')
        if (seenSet.has(key)) throw new ErrorEdicion(`Hay dos mesas que se llaman «${name}»`)
        seenSet.add(key)
      }
    }
    const row = db
      .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
      .get(restaurantId)
    return { version: Number(row?.value ?? 0), cambiados: tocados.length }
  })
}

/** Todo el catálogo, también lo archivado, para el editor. */
export function catalogoParaEditar(db: SqliteDatabase, restaurantId: string) {
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
