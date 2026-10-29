import { BRANDS, canonicalJson, fullConfig } from '@pos/core'
import type { Row, SqliteDatabase } from '@pos/db'
import type { Catalog } from '@pos/sync'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { updateVersioned } from './access/records'
import type { AccessService } from './access/service'
import {
  applyChanges,
  catalogForEditing,
  EditError,
  EditRequest,
  pricesOnly,
} from './catalog-editing'
import { PhotoError, photoUrl, readPhoto, savePhoto } from './photos'
import { timeZoneOf } from './startup'

// The catalog and the dining room for the devices (what is active in the versioned tables). In
// Phase 1 it syncs by version (`catalog since: N`, docs/SYNC.md#catálogo-y-configuración); for
// now it is sent whole: it is small.

const text = (v: unknown) => String(v)
const number = (v: unknown) => Number(v)

export function readCatalog(db: SqliteDatabase, restaurantId: string): Catalog {
  const allRows = (sql: string): Row[] => db.prepare(sql).all(restaurantId)
  const activeRows = (tableName: string, position = 'position, name') =>
    allRows(
      `SELECT * FROM ${tableName} WHERE restaurant_id = ? AND active = 1 ORDER BY ${position}`,
    )

  const version = number(
    db
      .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
      .get(restaurantId)?.value ?? 0,
  )
  const restaurant = db
    .prepare('SELECT name, config FROM restaurants WHERE id = ?')
    .get(restaurantId)
  const config = fullConfig(JSON.parse(String(restaurant?.config ?? '{}')))
  const taxes = new Map(activeRows('taxes', 'name').map((f) => [text(f.id), f]))
  const variants = activeRows('variants')
  const links = activeRows('product_modifier_groups', 'position')
  const groups = new Map(activeRows('modifier_groups', 'name').map((f) => [text(f.id), f]))
  const modifiers = activeRows('modifiers')
  const products = activeRows('products', 'name')
  const zones = activeRows('zones', 'level, position, name')
  const zoneIds = new Set(zones.map((f) => text(f.id)))
  const jsonList = (v: unknown): string[] => {
    const list = JSON.parse(String(v ?? '[]'))
    return Array.isArray(list) ? list.map(String) : []
  }
  const printedStations = new Set(
    activeRows('printers', 'name').flatMap((f) => jsonList(f.station_ids)),
  )
  const screens = allRows(
    `SELECT id, name, station_ids FROM devices
     WHERE restaurant_id = ? AND active = 1 AND type = 'kds' AND revoked_at IS NULL
     ORDER BY name, id`,
  ).map((f) => ({
    deviceId: text(f.id),
    name: text(f.name),
    stationIds: jsonList(f.station_ids),
  }))

  return {
    version,
    restaurant: {
      name: text(restaurant?.name ?? ''),
      sessionIdleMin: config.session_idle_min,
      brand: config.brand,
      kitchenYellowMin: config.kitchen_yellow_min,
      kitchenRedMin: config.kitchen_red_min,
      coursesEnabled: config.courses_enabled,
      checkout: {
        paymentMethods: config.payment_methods,
        customMethods: config.custom_methods
          .filter((m) => m.active)
          .map(({ id, name }) => ({ id, name })),
        archivedCustomMethods: config.custom_methods
          .filter((m) => !m.active)
          .map(({ id, name }) => ({ id, name })),
        suggestedTip: config.suggested_tip,
        roundingMode: config.rounding_mode,
        cashRounding: config.cash_rounding,
        cashRoundingMode: config.cash_rounding_mode,
        varianceThreshold: config.register_variance_threshold,
        timeZone: timeZoneOf(db, restaurantId),
        businessDayStart: config.business_day_start,
        // Only if the chosen printer is still active.
        printsPreBill:
          config.pre_bill_printer_id !== null &&
          allRows('SELECT id FROM printers WHERE restaurant_id = ? AND active = 1').some(
            (f) => text(f.id) === config.pre_bill_printer_id,
          ),
      },
    },
    cardTerminals: activeRows('card_terminals', 'name').map((f) => ({
      id: text(f.id),
      name: text(f.name),
      provider: text(f.provider),
    })),
    zones: zones.map((f) => ({ id: text(f.id), name: text(f.name), level: number(f.level) })),
    tables: activeRows('dining_tables', 'zone_id, y, x')
      .filter((f) => zoneIds.has(text(f.zone_id)))
      .map((f) => ({
        id: text(f.id),
        zoneId: text(f.zone_id),
        name: text(f.name),
        x: number(f.x),
        y: number(f.y),
        width: number(f.width),
        height: number(f.height),
        rotation: number(f.rotation),
        shape: text(f.shape) as Catalog['tables'][number]['shape'],
        capacity: number(f.capacity),
      })),
    elements: activeRows('floor_plan_elements', 'zone_id, version')
      .filter((f) => zoneIds.has(text(f.zone_id)))
      .map((f) => ({
        id: text(f.id),
        zoneId: text(f.zone_id),
        type: text(f.type) as Catalog['elements'][number]['type'],
        text: f.text === null ? null : text(f.text),
        x: number(f.x),
        y: number(f.y),
        width: number(f.width),
        height: number(f.height),
        rotation: number(f.rotation),
      })),
    staff: activeRows('users', 'name')
      .filter((f) => f.screen !== 1)
      .map((f) => ({
        id: text(f.id),
        name: text(f.name),
      })),
    stations: activeRows('stations').map((f) => ({
      id: text(f.id),
      name: text(f.name),
      prints: printedStations.has(text(f.id)),
      screen: screens.some((p) => p.stationIds.includes(text(f.id))),
    })),
    screens,
    categories: activeRows('categories').map((c) => ({
      id: text(c.id),
      name: text(c.name),
      stationId: c.station_id === null ? null : text(c.station_id),
      products: products
        .filter((p) => p.category_id === c.id && taxes.has(text(p.tax_id)))
        .map((p) => {
          const tax = taxes.get(text(p.tax_id)) as Row
          return {
            id: text(p.id),
            name: text(p.name),
            description: p.description === null ? null : text(p.description),
            favorite: p.favorite === 1,
            photo: photoUrl(p.photo),
            price: number(p.price),
            tax: {
              type: text(tax.type) as 'inc' | 'iva' | 'exempt',
              rate: number(tax.rate),
            },
            variants: variants
              .filter((v) => v.product_id === p.id)
              .map((v) => ({ id: text(v.id), name: text(v.name), price: number(v.price) })),
            groups: links
              .filter((e) => e.product_id === p.id && groups.has(text(e.group_id)))
              .map((e) => {
                const g = groups.get(text(e.group_id)) as Row
                return {
                  id: text(g.id),
                  name: text(g.name),
                  minimum: number(g.minimum),
                  maximum: number(g.maximum),
                  options: modifiers
                    .filter((m) => m.group_id === g.id)
                    .map((m) => ({
                      id: text(m.id),
                      name: text(m.name),
                      extraPrice: number(m.extra_price),
                    })),
                }
              }),
          }
        }),
    })),
  }
}

export interface CatalogOptions {
  db: SqliteDatabase
  restaurantId: string
  access: AccessService
  /** The catalog changed (edited from the register): notify the connected devices. */
  onChange?: (version: number) => void
  /** Whether a table has an open order (it cannot be archived). */
  occupiedTable?: (tableId: string) => boolean
  /** Folder for product photos (`data/photos`). Without it they are neither uploaded nor served. */
  photosDir?: string
  clock?: () => string
}

const EditSession = z.strictObject({
  session_id: z.string().length(26),
  secret: z.string().min(1).max(100),
})

/**
 * `GET /api/catalog` (what is current, for taking orders), `GET /api/catalog/editing` (everything,
 * archived too, for the editor) and `POST /api/catalog/changes` (edit, with the session and the
 * `edit_catalog` permission, or `edit_prices` if only prices change). All of them require a
 * paired device.
 */
export async function catalogRoutes(
  app: FastifyInstance,
  {
    db,
    restaurantId,
    access,
    onChange,
    occupiedTable,
    photosDir,
    clock = () => new Date().toISOString(),
  }: CatalogOptions,
) {
  const device = (req: FastifyRequest, reply: FastifyReply) => {
    const [schema, token] = (req.headers.authorization ?? '').split(' ')
    const connection = schema === 'Bearer' && token ? access.authenticate(token) : null
    if (connection && !connection.revokedAt) return connection
    reply
      .code(401)
      .send({ error: 'invalid_token', message: 'Este equipo ya no tiene acceso: vuelve a entrar' })
    return null
  }

  app.get('/api/catalog', async (req, reply) => {
    if (!device(req, reply)) return reply
    return readCatalog(db, restaurantId)
  })

  app.get('/api/catalog/editing', async (req, reply) => {
    if (!device(req, reply)) return reply
    return catalogForEditing(db, restaurantId)
  })

  app.post('/api/catalog/changes', async (req, reply) => {
    const connection = device(req, reply)
    if (!connection) return reply
    const body = EditRequest.merge(EditSession).safeParse(req.body)
    if (!body.success)
      return reply
        .code(400)
        .send({ error: 'invalid_data', message: 'Datos con formato inesperado' })
    const { session_id, secret, changes } = body.data
    const permission = pricesOnly(db, restaurantId, changes) ? 'edit_prices' : 'edit_catalog'
    let who = access.userWithPermission(connection, { sessionId: session_id, secret }, permission)
    // Whoever edits the catalog can also change prices.
    if (!who.ok && who.code === 'no_permission' && permission === 'edit_prices')
      who = access.userWithPermission(connection, { sessionId: session_id, secret }, 'edit_catalog')
    if (!who.ok) {
      const status = who.code === 'no_permission' ? 403 : 401
      return reply.code(status).send({ error: who.code, message: who.message })
    }
    try {
      const { version, changedCount } = applyChanges(
        db,
        restaurantId,
        changes,
        { userId: who.userId, deviceId: connection.deviceId },
        clock(),
        occupiedTable,
      )
      if (changedCount > 0) onChange?.(version)
      return reply.code(200).send({ version, changedCount })
    } catch (error) {
      if (error instanceof EditError)
        return reply.code(400).send({ error: 'invalid_data', message: error.message })
      throw error
    }
  })

  /** Who makes the change, with their session and that permission; otherwise replies the error. */
  const withPermission = (
    req: FastifyRequest,
    reply: FastifyReply,
    body: { session_id: string; secret: string },
    permission: 'edit_catalog' | 'manage_users',
  ) => {
    const connection = device(req, reply)
    if (!connection) return null
    const who = access.userWithPermission(
      connection,
      { sessionId: body.session_id, secret: body.secret },
      permission,
    )
    if (!who.ok) {
      reply
        .code(who.code === 'no_permission' ? 403 : 401)
        .send({ error: who.code, message: who.message })
      return null
    }
    return { userId: who.userId, deviceId: connection.deviceId }
  }
  const currentVersion = () =>
    Number(
      db
        .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
        .get(restaurantId)?.value ?? 0,
    )
  const invalidData = (reply: FastifyReply, message = 'Datos con formato inesperado') =>
    reply.code(400).send({ error: 'invalid_data', message })

  // The brand the POS shows on every device (task 1.3c).
  // The device is checked before reading the body: without a token nothing is read or validated.
  const withDevice = {
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!device(req, reply)) return reply
    },
  }

  app.post('/api/restaurant/brand', withDevice, async (req, reply) => {
    const body = EditSession.extend({ brand: z.enum(BRANDS) }).safeParse(req.body)
    if (!body.success) return invalidData(reply, 'Esa marca no existe')
    const author = withPermission(req, reply, body.data, 'manage_users')
    if (!author) return reply
    const row = db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restaurantId)
    const current = JSON.parse(String(row?.config ?? '{}')) as Record<string, unknown>
    if (current.brand !== body.data.brand) {
      updateVersioned(
        db,
        'restaurants',
        restaurantId,
        restaurantId,
        { config: canonicalJson(fullConfig({ ...current, brand: body.data.brand })) },
        author,
        clock(),
      )
      onChange?.(currentVersion())
    }
    return reply.send({ brand: body.data.brand })
  })

  if (!photosDir) return

  // Upload or remove a product's photo, with the permission to edit the menu.
  app.post(
    '/api/catalog/photos',
    { ...withDevice, bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const body = EditSession.extend({
        product_id: z.string().length(26),
        image: z.string().max(1_500_000).nullable(),
      }).safeParse(req.body)
      if (!body.success) return invalidData(reply)
      const author = withPermission(req, reply, body.data, 'edit_catalog')
      if (!author) return reply
      const product = db
        .prepare('SELECT photo FROM products WHERE restaurant_id = ? AND id = ?')
        .get(restaurantId, body.data.product_id)
      if (!product) return invalidData(reply, 'Ese producto no existe')
      let name: string | null = null
      try {
        name = body.data.image === null ? null : savePhoto(photosDir, body.data.image)
      } catch (e) {
        if (e instanceof PhotoError) return invalidData(reply, e.message)
        throw e
      }
      if (product.photo !== name) {
        updateVersioned(
          db,
          'products',
          restaurantId,
          body.data.product_id,
          { photo: name },
          author,
          clock(),
        )
        onChange?.(currentVersion())
      }
      return reply.send({ photo: photoUrl(name) })
    },
  )

  // Photos belong to the menu, not to anyone: they are served without a token (an <img> cannot
  // send one) and never change, because their name is the fingerprint of their content.
  app.get<{ Params: { name: string } }>('/photos/:name', async (req, reply) => {
    const photo = readPhoto(photosDir, req.params.name)
    if (!photo) return reply.code(404).send({ error: 'No encontrado' })
    return reply
      .header('content-type', photo.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(photo.bytes)
  })
}
