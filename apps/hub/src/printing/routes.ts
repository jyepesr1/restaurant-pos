import {
  canonicalJson,
  fullConfig,
  newId,
  PaymentMethod,
  type Permission,
  type RestaurantConfig,
} from '@pos/core'
import { inTransaction, type Row, type SqliteDatabase } from '@pos/db'
import { CODE_PAGES } from '@pos/printing'
import type { Connection } from '@pos/sync'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { insertVersioned, updateVersioned } from '../access/records'
import type { AccessService } from '../access/service'
import type { PrintQueue, PrintTest } from './queue'

// Kitchen and printers (ADR-015): which printer and which screen each station gets, the test
// page, the queue of what has not printed and turning a device into a kitchen screen. Everything
// requires a device with a token and a session with permission; the session goes in the body,
// as everywhere else.

export interface PrintingOptions {
  db: SqliteDatabase
  restaurantId: string
  access: AccessService
  queue: PrintQueue
  timeZone: string
  /** Something devices read with the menu changed (stations, screens, times). */
  onChange?: (version: number) => void
  clock?: () => string
  /**
   * Accepts printers on this same machine (127.0.0.1) and on any port: only for the test
   * printer (`TEST_PRINTER=1`). At the location, only private IPs and ports 9100 to 9109.
   */
  allowLocal?: boolean
  /** Whether the request comes from the hub's own PC (that machine is not turned into a screen). */
  isHubDevice?: (ip: string) => boolean
}

/**
 * A network printer must be on the location's network: a private IPv4 written as is. That way a
 * printer address cannot be used to probe internet hosts or services on the PC.
 */
export function validAddress(address: string, port: number | null, locals: boolean): string | null {
  // No leading zeros: «010.0.0.1» is read as octal and would go to 8.0.0.1.
  const octet = '(0|[1-9]\\d{0,2})'
  const m = new RegExp(`^${octet}\\.${octet}\\.${octet}\\.${octet}$`).exec(address)
  const parts = m ? m.slice(1).map(Number) : null
  if (!parts || parts.some((n) => n > 255))
    return 'Escribe la IP de la impresora, por ejemplo 192.168.1.50'
  const [a, b] = parts as [number, number]
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  const local = a === 127
  if (!isPrivate && !(locals && local))
    return 'Esa IP no es de la red del local: debe empezar por 192.168, 10 o 172.16 a 172.31'
  const p = port ?? 9100
  if (!locals && (p < 9100 || p > 9109))
    return 'Las impresoras de red usan el puerto 9100 (hasta 9109)'
  return null
}

const Session = z.strictObject({
  session_id: z.string().length(26),
  secret: z.string().min(1).max(100),
})
const Id = z.string().length(26)
const Stations = z.array(Id).max(50)

/** An IP or a host name on the local network (no scheme or path). */

const Printer = z.strictObject({
  id: Id.optional(),
  name: z.string().trim().min(1).max(60),
  connection: z.enum(['network', 'usb']),
  address: z.string().trim().min(1).max(255),
  port: z.int().min(1).max(65535).nullable(),
  width: z.union([z.literal(58), z.literal(80)]),
  code_page: z.enum(CODE_PAGES),
  fallback_id: Id.nullable(),
  station_ids: Stations,
  active: z.boolean(),
})

const list = (v: unknown): string[] => {
  const l = JSON.parse(String(v ?? '[]'))
  return Array.isArray(l) ? l.map(String) : []
}

/**
 * What the routes of a paired device share: the device token is checked before reading the
 * body, and each action requires the session of someone with permission.
 */
export function deviceGuards(access: AccessService) {
  const connectionOf = (req: FastifyRequest): Connection | null => {
    const [schema, token] = (req.headers.authorization ?? '').split(' ')
    const connection = schema === 'Bearer' && token ? access.authenticate(token) : null
    return connection && !connection.revokedAt ? connection : null
  }
  // The device is checked before reading the body: without a token nothing is read or validated.
  const withDevice = {
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!connectionOf(req))
        return reply.code(401).send({
          error: 'invalid_token',
          message: 'Este equipo ya no tiene acceso: vuelve a entrar',
        })
    },
  }
  const invalidData = (reply: FastifyReply, message = 'Datos con formato inesperado') =>
    reply.code(400).send({ error: 'invalid_data', message })

  /** Who is asking, if their session has any of those permissions; otherwise it sends the error. */
  const who = (
    req: FastifyRequest,
    reply: FastifyReply,
    session: { session_id: string; secret: string },
    permissions: Permission[],
  ) => {
    const connection = connectionOf(req) as Connection
    let r = access.userWithPermission(
      connection,
      { sessionId: session.session_id, secret: session.secret },
      permissions[0] as Permission,
    )
    for (const p of permissions.slice(1)) {
      if (r.ok || r.code !== 'no_permission') break
      r = access.userWithPermission(
        connection,
        { sessionId: session.session_id, secret: session.secret },
        p,
      )
    }
    if (!r.ok) {
      reply.code(r.code === 'no_permission' ? 403 : 401).send({ error: r.code, message: r.message })
      return null
    }
    return { userId: r.userId, deviceId: connection.deviceId }
  }
  return { connectionOf, withDevice, invalidData, who }
}

export async function printingRoutes(
  app: FastifyInstance,
  {
    db,
    restaurantId,
    access,
    queue,
    timeZone,
    onChange,
    clock = () => new Date().toISOString(),
    allowLocal = false,
    isHubDevice = () => false,
  }: PrintingOptions,
) {
  const { connectionOf, withDevice, invalidData, who } = deviceGuards(access)

  const activeStations = () =>
    db
      .prepare(
        'SELECT id, name FROM stations WHERE restaurant_id = ? AND active = 1 ORDER BY position, name',
      )
      .all(restaurantId)
      .map((f) => ({ id: String(f.id), name: String(f.name) }))
  /**
   * The chosen stations, without repeats. An archived one is dropped without error (the screen
   * does not show it and it could not be unchecked); one not from this restaurant gives `null`.
   */
  const stationsOf = (ids: readonly string[]): string[] | null => {
    const allRows = new Map(
      db
        .prepare('SELECT id, active FROM stations WHERE restaurant_id = ?')
        .all(restaurantId)
        .map((f) => [String(f.id), f.active === 1]),
    )
    if (ids.some((id) => !allRows.has(id))) return null
    return [...new Set(ids)].filter((id) => allRows.get(id))
  }
  const version = () =>
    Number(
      db
        .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
        .get(restaurantId)?.value ?? 0,
    )
  const notify = () => {
    onChange?.(version())
    queue.wake()
  }

  // Everything for the «Cocina e impresoras» screen.
  app.post('/api/kitchen/config', withDevice, async (req, reply) => {
    const body = Session.safeParse(req.body)
    if (!body.success) return invalidData(reply)
    if (!who(req, reply, body.data, ['manage_devices'])) return reply
    const config = fullConfig(
      JSON.parse(
        String(
          db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restaurantId)?.config ??
            '{}',
        ),
      ),
    )
    return {
      stations: activeStations(),
      printers: db
        .prepare('SELECT * FROM printers WHERE restaurant_id = ? ORDER BY active DESC, name, id')
        .all(restaurantId)
        .map((f) => ({
          id: String(f.id),
          name: String(f.name),
          connection: String(f.connection),
          address: String(f.address),
          port: f.port === null ? null : Number(f.port),
          width: Number(f.width),
          code_page: String(f.code_page),
          fallback_id: f.fallback_id === null ? null : String(f.fallback_id),
          station_ids: list(f.station_ids),
          active: f.active === 1,
        })),
      statuses: queue.status(),
      screens: db
        .prepare(
          `SELECT d.id, d.name, d.station_ids, (SELECT max(last_used) FROM sessions s WHERE s.device_id = d.id) AS use
           FROM devices d WHERE d.restaurant_id = ? AND d.active = 1 AND d.type = 'kds' AND d.revoked_at IS NULL
           ORDER BY d.name, d.id`,
        )
        .all(restaurantId)
        .map((f) => ({
          device_id: String(f.id),
          name: String(f.name),
          station_ids: list(f.station_ids),
          last_used: f.use === null ? null : String(f.use),
        })),
      timers: { yellow: config.kitchen_yellow_min, red: config.kitchen_red_min },
      courses_enabled: config.courses_enabled,
      pre_bill_printer_id: config.pre_bill_printer_id,
    }
  })

  app.post('/api/printers', withDevice, async (req, reply) => {
    const body = Session.extend({ printer: Printer }).safeParse(req.body)
    if (!body.success) return invalidData(reply, 'Revisa los datos de la impresora')
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    const i = body.data.printer
    if (i.connection === 'network') {
      const issue = validAddress(i.address, i.port, allowLocal)
      if (issue) return invalidData(reply, issue)
    }
    const stationIds = stationsOf(i.station_ids)
    if (!stationIds) return invalidData(reply, 'Esa estación no existe')
    const current: Row | undefined = i.id
      ? db
          .prepare('SELECT * FROM printers WHERE restaurant_id = ? AND id = ?')
          .get(restaurantId, i.id)
      : undefined
    if (i.id && !current) return invalidData(reply, 'Esa impresora no existe')
    if (i.fallback_id) {
      if (i.fallback_id === i.id)
        return invalidData(reply, 'Una impresora no puede ser su propio respaldo')
      const fallback = db
        .prepare('SELECT active FROM printers WHERE restaurant_id = ? AND id = ?')
        .get(restaurantId, i.fallback_id)
      if (fallback?.active !== 1) return invalidData(reply, 'La impresora de respaldo no existe')
    }
    const fields = {
      name: i.name,
      connection: i.connection,
      address: i.address,
      port: i.connection === 'network' ? (i.port ?? 9100) : null,
      width: i.width,
      code_page: i.code_page,
      fallback_id: i.fallback_id,
      station_ids: JSON.stringify(stationIds),
      active: i.active ? 1 : 0,
    }
    const now = clock()
    const id = inTransaction(db, () => {
      if (current) {
        updateVersioned(db, 'printers', restaurantId, String(current.id), fields, author, now)
        // Archiving a printer does not leave another one pointing to it as fallback.
        if (!i.active)
          for (const f of db
            .prepare('SELECT id FROM printers WHERE restaurant_id = ? AND fallback_id = ?')
            .all(restaurantId, String(current.id)))
            updateVersioned(
              db,
              'printers',
              restaurantId,
              String(f.id),
              { fallback_id: null },
              author,
              now,
            )
        return String(current.id)
      }
      return insertVersioned(db, 'printers', restaurantId, fields, author, now)
    })
    notify()
    return reply.send({ id })
  })

  app.post('/api/printers/test', withDevice, async (req, reply) => {
    const body = Session.extend({ printer_id: Id }).safeParse(req.body)
    if (!body.success) return invalidData(reply)
    if (!who(req, reply, body.data, ['manage_devices'])) return reply
    const printer = db
      .prepare('SELECT * FROM printers WHERE restaurant_id = ? AND id = ? AND active = 1')
      .get(restaurantId, body.data.printer_id)
    if (!printer) return invalidData(reply, 'Esa impresora no existe')
    const names = new Map(activeStations().map((e) => [e.id, e.name]))
    const now = clock()
    const content: PrintTest = {
      printer: String(printer.name),
      stations: list(printer.station_ids).flatMap((e) => names.get(e) ?? []),
      time: new Intl.DateTimeFormat('es-CO', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timeZone,
      }).format(new Date(now)),
    }
    const id = insertJob(db, restaurantId, String(printer.id), content, now)
    queue.wake()
    return reply.code(201).send({ job_id: id })
  })

  // What has not printed, for the register: see why and discard what is no longer needed.
  const QUEUE_PERMISSIONS: Permission[] = ['manage_devices', 'record_payment']

  app.post('/api/printing/pending', withDevice, async (req, reply) => {
    const body = Session.safeParse(req.body)
    if (!body.success) return invalidData(reply)
    if (!who(req, reply, body.data, QUEUE_PERMISSIONS)) return reply
    return db
      .prepare(
        `SELECT t.id, t.type, t.content, t.attempts, t.last_error, t.created_at, i.name AS printer
         FROM print_jobs t JOIN printers i ON i.id = t.printer_id
         WHERE t.restaurant_id = ? AND t.status = 'pending' ORDER BY t.created_at, t.id LIMIT 200`,
      )
      .all(restaurantId)
      .map((f) => {
        const c = JSON.parse(String(f.content)) as {
          target?: string
          reprinted?: string | null
          station?: string
          number?: number | null
        }
        return {
          id: String(f.id),
          printer: String(f.printer),
          what:
            f.type === 'test'
              ? 'Página de prueba'
              : f.type === 'preBill'
                ? ['Precuenta', c.target].filter(Boolean).join(' · ')
                : f.type === 'report'
                  ? c.reprinted
                    ? 'Cierre de caja (reimpresión)'
                    : 'Cierre de caja'
                  : [c.station, c.target, c.number ? `#${c.number}` : null]
                      .filter(Boolean)
                      .join(' · '),
          attempts: Number(f.attempts),
          error: f.last_error === null ? null : String(f.last_error),
          created_at: String(f.created_at),
        }
      })
  })

  app.post('/api/printing/discard', withDevice, async (req, reply) => {
    const body = Session.extend({ job_id: Id }).safeParse(req.body)
    if (!body.success) return invalidData(reply)
    const author = who(req, reply, body.data, QUEUE_PERMISSIONS)
    if (!author) return reply
    const r = db
      .prepare(
        `UPDATE print_jobs SET status = 'discarded', finished_at = ?, discarded_by_id = ?,
           discarded_device_id = ?
         WHERE restaurant_id = ? AND id = ? AND status = 'pending'`,
      )
      .run(clock(), author.userId, author.deviceId, restaurantId, body.data.job_id)
    if (Number(r.changes) === 0) return invalidData(reply, 'Esa comanda ya salió o ya se descartó')
    queue.wake()
    return reply.code(204).send()
  })

  // Turn the requesting device into a kitchen screen (ADR-015).
  app.post('/api/screens', withDevice, async (req, reply) => {
    const body = Session.extend({
      name: z.string().max(100),
      station_ids: Stations,
    }).safeParse(req.body)
    if (!body.success) return invalidData(reply)
    if (isHubDevice(req.ip))
      return invalidData(
        reply,
        'Este es el PC de la caja, donde corre el sistema: no se convierte en pantalla. Hazlo desde la tablet de la cocina.',
      )
    const r = access.convertToScreen(connectionOf(req) as Connection, {
      sessionId: body.data.session_id,
      secret: body.data.secret,
      name: body.data.name,
      stationIds: body.data.station_ids,
    })
    if (!r.ok)
      return reply
        .code(r.code === 'no_permission' ? 403 : r.code === 'invalid_data' ? 400 : 401)
        .send({ error: r.code, message: r.message })
    notify()
    return reply.code(201).send({
      session_id: r.sessionId,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
      type: 'kds',
    })
  })

  // Change what a screen shows, from the register.
  app.post('/api/screens/stations', withDevice, async (req, reply) => {
    const body = Session.extend({ device_id: Id, station_ids: Stations.min(1) }).safeParse(req.body)
    if (!body.success) return invalidData(reply, 'Elige al menos una estación')
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    const stationIds = stationsOf(body.data.station_ids)
    if (!stationIds) return invalidData(reply, 'Esa estación no existe')
    if (stationIds.length === 0) return invalidData(reply, 'Elige al menos una estación')
    const screen = db
      .prepare(
        "SELECT 1 FROM devices WHERE restaurant_id = ? AND id = ? AND type = 'kds' AND active = 1 AND revoked_at IS NULL",
      )
      .get(restaurantId, body.data.device_id)
    if (!screen) return invalidData(reply, 'Esa pantalla no existe')
    updateVersioned(
      db,
      'devices',
      restaurantId,
      body.data.device_id,
      { station_ids: JSON.stringify(stationIds) },
      author,
      clock(),
    )
    notify()
    return reply.code(204).send()
  })

  /**
   * Changes fields of the restaurant config (versioned: devices read it with the menu). If
   * nothing changes, it neither writes nor notifies.
   */
  const updateConfig = (
    changes: Partial<RestaurantConfig>,
    author: { userId: string; deviceId: string },
  ) => {
    const current = JSON.parse(
      String(
        db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restaurantId)?.config ?? '{}',
      ),
    ) as Record<string, unknown>
    const before = canonicalJson(fullConfig(current))
    const after = canonicalJson(fullConfig({ ...current, ...changes }))
    if (before === after) return
    updateVersioned(
      db,
      'restaurants',
      restaurantId,
      restaurantId,
      { config: after },
      author,
      clock(),
    )
    notify()
  }

  // Turn courses (starter, main, dessert) on or off for the whole restaurant.
  app.post('/api/kitchen/courses', withDevice, async (req, reply) => {
    const body = Session.extend({ enabled: z.boolean() }).safeParse(req.body)
    if (!body.success) return invalidData(reply)
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    updateConfig({ courses_enabled: body.data.enabled }, author)
    return reply.code(204).send()
  })

  // Minutes for amber and red on what is running late in the kitchen.
  app.post('/api/kitchen/timers', withDevice, async (req, reply) => {
    const body = Session.extend({
      yellow: z.int().min(1).max(240),
      red: z.int().min(1).max(240),
    }).safeParse(req.body)
    if (!body.success) return invalidData(reply, 'Escribe minutos entre 1 y 240')
    if (body.data.red <= body.data.yellow)
      return invalidData(reply, '«Muy demorada» debe llegar después de «demorada»')
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    updateConfig({ kitchen_yellow_min: body.data.yellow, kitchen_red_min: body.data.red }, author)
    return reply.code(204).send()
  })

  // ── Register (task 1.6): pre-bill printer, payment methods and card terminals ──

  // Where the pre-bill prints; without a printer, it is only shown on screen.
  app.post('/api/register/pre-bill', withDevice, async (req, reply) => {
    const body = Session.extend({ printer_id: Id.nullable() }).safeParse(req.body)
    if (!body.success) return invalidData(reply)
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    const id = body.data.printer_id
    if (
      id &&
      !db
        .prepare('SELECT 1 FROM printers WHERE restaurant_id = ? AND id = ? AND active = 1')
        .get(restaurantId, id)
    )
      return invalidData(reply, 'Esa impresora no existe o está archivada')
    updateConfig({ pre_bill_printer_id: id }, author)
    return reply.code(204).send()
  })

  const cardTerminals = () =>
    db
      .prepare(
        'SELECT * FROM card_terminals WHERE restaurant_id = ? ORDER BY active DESC, name, id',
      )
      .all(restaurantId)
      .map((f) => ({
        id: String(f.id),
        name: String(f.name),
        provider: String(f.provider),
        active: f.active === 1,
      }))

  // What the «Caja y pagos» screen needs.
  app.post('/api/register/config', withDevice, async (req, reply) => {
    const body = Session.safeParse(req.body)
    if (!body.success) return invalidData(reply)
    if (!who(req, reply, body.data, ['manage_devices'])) return reply
    const config = fullConfig(
      JSON.parse(
        String(
          db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restaurantId)?.config ??
            '{}',
        ),
      ),
    )
    return {
      payment_methods: config.payment_methods,
      custom_methods: config.custom_methods,
      suggested_tip: config.suggested_tip,
      register_variance_threshold: config.register_variance_threshold,
      cardTerminals: cardTerminals(),
    }
  })

  app.post('/api/register/payment-methods', withDevice, async (req, reply) => {
    const body = Session.extend({ methods: z.array(PaymentMethod).min(1).max(10) }).safeParse(
      req.body,
    )
    if (!body.success) return invalidData(reply)
    const methods = [...new Set(body.data.methods)]
    if (methods.includes('other'))
      return invalidData(reply, 'Los medios propios se crean aparte, con su nombre')
    if (!methods.includes('cash')) return invalidData(reply, 'El efectivo siempre se recibe')
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    updateConfig({ payment_methods: methods }, author)
    return reply.code(204).send()
  })

  // A restaurant's custom method (Sodexo, bank QR): create, rename or archive.
  app.post('/api/register/custom-methods', withDevice, async (req, reply) => {
    const body = Session.extend({
      method: z.strictObject({
        id: Id.optional(),
        name: z.string().trim().min(1).max(30),
        active: z.boolean(),
      }),
    }).safeParse(req.body)
    if (!body.success) return invalidData(reply, 'Escribe el nombre del medio (hasta 30 letras)')
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    const current = fullConfig(
      JSON.parse(
        String(
          db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restaurantId)?.config ??
            '{}',
        ),
      ),
    )
    const m = body.data.method
    if (m.id && !current.custom_methods.some((x) => x.id === m.id))
      return invalidData(reply, 'Ese medio no existe')
    const duplicate = current.custom_methods.some(
      (x) => x.active && x.id !== m.id && x.name.toLowerCase() === m.name.toLowerCase(),
    )
    if (m.active && duplicate) return invalidData(reply, 'Ya hay un medio con ese nombre')
    const id = m.id ?? newId()
    const methods = m.id
      ? current.custom_methods.map((x) =>
          x.id === id ? { id, name: m.name, active: m.active } : x,
        )
      : [...current.custom_methods, { id, name: m.name, active: m.active }]
    if (methods.length > 20) return invalidData(reply, 'Son máximo 20 medios propios')
    updateConfig({ custom_methods: methods }, author)
    return { id, custom_methods: methods }
  })

  // The suggested tip percentage, in basis points (1000 = 10 %). Capped at 10 % — (validate)
  // with the accountant (Ley 1935 de 2018).
  app.post('/api/register/tip', withDevice, async (req, reply) => {
    const body = Session.extend({ points: z.int().min(0).max(1000) }).safeParse(req.body)
    if (!body.success) return invalidData(reply, 'La propina sugerida va de 0 % a 10 %')
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    updateConfig({ suggested_tip: body.data.points }, author)
    return reply.code(204).send()
  })

  // From what variance the register close asks for a justification (task 1.7).
  app.post('/api/register/threshold', withDevice, async (req, reply) => {
    const body = Session.extend({ pesos: z.int().min(0).max(1_000_000) }).safeParse(req.body)
    if (!body.success) return invalidData(reply, 'Escribe un valor entre 0 y 1.000.000')
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    updateConfig({ register_variance_threshold: body.data.pesos }, author)
    return reply.code(204).send()
  })

  app.post('/api/card-terminals', withDevice, async (req, reply) => {
    const body = Session.extend({
      cardTerminal: z.strictObject({
        id: Id.optional(),
        name: z.string().trim().min(1).max(60),
        provider: z.enum(['bold', 'redeban', 'credibanco', 'other']),
        active: z.boolean(),
      }),
    }).safeParse(req.body)
    if (!body.success) return invalidData(reply, 'Revisa los datos del datáfono')
    const author = who(req, reply, body.data, ['manage_devices'])
    if (!author) return reply
    const d = body.data.cardTerminal
    const duplicate = db
      .prepare(
        'SELECT id FROM card_terminals WHERE restaurant_id = ? AND active = 1 AND lower(name) = lower(?)',
      )
      .all(restaurantId, d.name)
      .some((f) => String(f.id) !== d.id)
    if (d.active && duplicate) return invalidData(reply, 'Ya hay un datáfono con ese nombre')
    const fields = { name: d.name, provider: d.provider, active: d.active ? 1 : 0 }
    const id = inTransaction(db, () => {
      if (!d.id) return insertVersioned(db, 'card_terminals', restaurantId, fields, author, clock())
      const current = db
        .prepare('SELECT id FROM card_terminals WHERE restaurant_id = ? AND id = ?')
        .get(restaurantId, d.id)
      if (!current) return null
      updateVersioned(db, 'card_terminals', restaurantId, d.id, fields, author, clock())
      return d.id
    })
    if (!id) return invalidData(reply, 'Ese datáfono no existe')
    notify()
    return { id, cardTerminals: cardTerminals() }
  })
}

function insertJob(
  db: SqliteDatabase,
  restaurantId: string,
  printerId: string,
  content: PrintTest,
  now: string,
): string {
  const id = newId()
  db.prepare(
    `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(id, restaurantId, printerId, JSON.stringify(content), now)
  return id
}
