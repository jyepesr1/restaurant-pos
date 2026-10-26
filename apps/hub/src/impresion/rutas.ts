import {
  canonicalJson,
  fullConfig,
  newId,
  PaymentMethod,
  type Permission,
  type RestaurantConfig,
} from '@pos/core'
import { type BaseSqlite, enTransaccion, type Fila } from '@pos/db'
import { CODE_PAGES } from '@pos/printing'
import type { Conexion } from '@pos/sync'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { actualizarVersionado, insertarVersionado } from '../acceso/registros'
import type { ServicioAcceso } from '../acceso/servicio'
import type { ColaImpresion, PruebaImpresion } from './cola'

// Cocina e impresoras (ADR-015): qué impresora y qué pantalla recibe cada estación, la página de
// prueba, la cola de lo que no ha salido y convertir un equipo en pantalla de cocina. Todo pide
// un equipo con token y una sesión con permiso; la sesión va en el cuerpo, como en el resto.

export interface OpcionesImpresion {
  db: BaseSqlite
  restauranteId: string
  access: ServicioAcceso
  cola: ColaImpresion
  timeZone: string
  /** Cambió algo que los equipos leen con la carta (estaciones, pantallas, tiempos). */
  onChange?: (version: number) => void
  clock?: () => string
  /**
   * Acepta impresoras en este mismo equipo (127.0.0.1) y en cualquier puerto: solo para la
   * impresora de prueba (`IMPRESORA_PRUEBA=1`). En el local, solo IP privadas y puertos 9100 a 9109.
   */
  permitirLocales?: boolean
  /** Si la petición viene del propio PC del hub (ese equipo no se convierte en pantalla). */
  esEquipoDelHub?: (ip: string) => boolean
}

/**
 * Una impresora de red debe estar en la red del local: una IPv4 privada escrita tal cual. Así la
 * dirección de una impresora no sirve para tantear equipos de internet ni servicios del PC.
 */
export function direccionValida(
  address: string,
  port: number | null,
  locales: boolean,
): string | null {
  // Sin ceros a la izquierda: «010.0.0.1» se lee en octal y saldría a 8.0.0.1.
  const octeto = '(0|[1-9]\\d{0,2})'
  const m = new RegExp(`^${octeto}\\.${octeto}\\.${octeto}\\.${octeto}$`).exec(address)
  const parts = m ? m.slice(1).map(Number) : null
  if (!parts || parts.some((n) => n > 255))
    return 'Escribe la IP de la impresora, por ejemplo 192.168.1.50'
  const [a, b] = parts as [number, number]
  const privada = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  const local = a === 127
  if (!privada && !(locales && local))
    return 'Esa IP no es de la red del local: debe empezar por 192.168, 10 o 172.16 a 172.31'
  const p = port ?? 9100
  if (!locales && (p < 9100 || p > 9109))
    return 'Las impresoras de red usan el puerto 9100 (hasta 9109)'
  return null
}

const Sesion = z.strictObject({
  session_id: z.string().length(26),
  secret: z.string().min(1).max(100),
})
const Id = z.string().length(26)
const Estaciones = z.array(Id).max(50)

/** Una IP o un nombre de equipo de la red local (sin esquema ni ruta). */

const Impresora = z.strictObject({
  id: Id.optional(),
  name: z.string().trim().min(1).max(60),
  connection: z.enum(['network', 'usb']),
  address: z.string().trim().min(1).max(255),
  port: z.int().min(1).max(65535).nullable(),
  width: z.union([z.literal(58), z.literal(80)]),
  code_page: z.enum(CODE_PAGES),
  fallback_id: Id.nullable(),
  station_ids: Estaciones,
  active: z.boolean(),
})

const list = (v: unknown): string[] => {
  const l = JSON.parse(String(v ?? '[]'))
  return Array.isArray(l) ? l.map(String) : []
}

/**
 * Lo que comparten las rutas de un equipo emparejado: el token del equipo se revisa antes de leer
 * el cuerpo, y cada acción pide la sesión de alguien con permiso.
 */
export function guardasDeEquipo(access: ServicioAcceso) {
  const conexionDe = (req: FastifyRequest): Conexion | null => {
    const [esquema, token] = (req.headers.authorization ?? '').split(' ')
    const connection = esquema === 'Bearer' && token ? access.authenticate(token) : null
    return connection && !connection.revocadoEn ? connection : null
  }
  // El equipo se comprueba antes de leer el cuerpo: sin token no se recibe ni se valida nada.
  const conEquipo = {
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!conexionDe(req))
        return reply.code(401).send({
          error: 'invalid_token',
          message: 'Este equipo ya no tiene acceso: vuelve a entrar',
        })
    },
  }
  const datosInvalidos = (reply: FastifyReply, message = 'Datos con formato inesperado') =>
    reply.code(400).send({ error: 'invalid_data', message })

  /** Quién lo pide, si su sesión tiene alguno de esos permisos; si no, responde el error. */
  const quien = (
    req: FastifyRequest,
    reply: FastifyReply,
    session: { session_id: string; secret: string },
    permissions: Permission[],
  ) => {
    const connection = conexionDe(req) as Conexion
    let r = access.usuarioConPermiso(
      connection,
      { sesionId: session.session_id, secret: session.secret },
      permissions[0] as Permission,
    )
    for (const p of permissions.slice(1)) {
      if (r.ok || r.code !== 'no_permission') break
      r = access.usuarioConPermiso(
        connection,
        { sesionId: session.session_id, secret: session.secret },
        p,
      )
    }
    if (!r.ok) {
      reply.code(r.code === 'no_permission' ? 403 : 401).send({ error: r.code, message: r.message })
      return null
    }
    return { userId: r.userId, dispositivoId: connection.dispositivoId }
  }
  return { conexionDe, conEquipo, datosInvalidos, quien }
}

export async function rutasImpresion(
  app: FastifyInstance,
  {
    db,
    restauranteId,
    access,
    cola,
    timeZone,
    onChange,
    clock = () => new Date().toISOString(),
    permitirLocales = false,
    esEquipoDelHub = () => false,
  }: OpcionesImpresion,
) {
  const { conexionDe, conEquipo, datosInvalidos, quien } = guardasDeEquipo(access)

  const estacionesActivas = () =>
    db
      .prepare(
        'SELECT id, name FROM stations WHERE restaurant_id = ? AND active = 1 ORDER BY position, name',
      )
      .all(restauranteId)
      .map((f) => ({ id: String(f.id), name: String(f.name) }))
  /**
   * Las estaciones elegidas, sin repetir. Una archivada se quita sin error (la pantalla no la
   * muestra y no se podría desmarcar); una que no es de este restaurante, `null`.
   */
  const estacionesDe = (ids: readonly string[]): string[] | null => {
    const allRows = new Map(
      db
        .prepare('SELECT id, active FROM stations WHERE restaurant_id = ?')
        .all(restauranteId)
        .map((f) => [String(f.id), f.active === 1]),
    )
    if (ids.some((id) => !allRows.has(id))) return null
    return [...new Set(ids)].filter((id) => allRows.get(id))
  }
  const version = () =>
    Number(
      db
        .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
        .get(restauranteId)?.value ?? 0,
    )
  const avisar = () => {
    onChange?.(version())
    cola.despertar()
  }

  // Todo lo de la pantalla «Cocina e impresoras».
  app.post('/api/kitchen/config', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['manage_devices'])) return reply
    const config = fullConfig(
      JSON.parse(
        String(
          db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restauranteId)?.config ??
            '{}',
        ),
      ),
    )
    return {
      stations: estacionesActivas(),
      printers: db
        .prepare('SELECT * FROM printers WHERE restaurant_id = ? ORDER BY active DESC, name, id')
        .all(restauranteId)
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
      statuses: cola.status(),
      pantallas: db
        .prepare(
          `SELECT d.id, d.name, d.station_ids, (SELECT max(last_used) FROM sessions s WHERE s.device_id = d.id) AS uso
           FROM devices d WHERE d.restaurant_id = ? AND d.active = 1 AND d.type = 'kds' AND d.revoked_at IS NULL
           ORDER BY d.name, d.id`,
        )
        .all(restauranteId)
        .map((f) => ({
          device_id: String(f.id),
          name: String(f.name),
          station_ids: list(f.station_ids),
          last_used: f.uso === null ? null : String(f.uso),
        })),
      tiempos: { amarillo: config.kitchen_yellow_min, rojo: config.kitchen_red_min },
      courses_enabled: config.courses_enabled,
      pre_bill_printer_id: config.pre_bill_printer_id,
    }
  })

  app.post('/api/printers', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ printer: Impresora }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'Revisa los datos de la impresora')
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    const i = cuerpo.data.printer
    if (i.connection === 'network') {
      const issue = direccionValida(i.address, i.port, permitirLocales)
      if (issue) return datosInvalidos(reply, issue)
    }
    const estacionIds = estacionesDe(i.station_ids)
    if (!estacionIds) return datosInvalidos(reply, 'Esa estación no existe')
    const current: Fila | undefined = i.id
      ? db
          .prepare('SELECT * FROM printers WHERE restaurant_id = ? AND id = ?')
          .get(restauranteId, i.id)
      : undefined
    if (i.id && !current) return datosInvalidos(reply, 'Esa impresora no existe')
    if (i.fallback_id) {
      if (i.fallback_id === i.id)
        return datosInvalidos(reply, 'Una impresora no puede ser su propio respaldo')
      const respaldo = db
        .prepare('SELECT active FROM printers WHERE restaurant_id = ? AND id = ?')
        .get(restauranteId, i.fallback_id)
      if (respaldo?.active !== 1) return datosInvalidos(reply, 'La impresora de respaldo no existe')
    }
    const fields = {
      name: i.name,
      connection: i.connection,
      address: i.address,
      port: i.connection === 'network' ? (i.port ?? 9100) : null,
      width: i.width,
      code_page: i.code_page,
      fallback_id: i.fallback_id,
      station_ids: JSON.stringify(estacionIds),
      active: i.active ? 1 : 0,
    }
    const ahora = clock()
    const id = enTransaccion(db, () => {
      if (current) {
        actualizarVersionado(
          db,
          'printers',
          restauranteId,
          String(current.id),
          fields,
          autor,
          ahora,
        )
        // Archivar una impresora no deja a otra apuntándole como respaldo.
        if (!i.active)
          for (const f of db
            .prepare('SELECT id FROM printers WHERE restaurant_id = ? AND fallback_id = ?')
            .all(restauranteId, String(current.id)))
            actualizarVersionado(
              db,
              'printers',
              restauranteId,
              String(f.id),
              { fallback_id: null },
              autor,
              ahora,
            )
        return String(current.id)
      }
      return insertarVersionado(db, 'printers', restauranteId, fields, autor, ahora)
    })
    avisar()
    return reply.send({ id })
  })

  app.post('/api/printers/test', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ printer_id: Id }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['manage_devices'])) return reply
    const printer = db
      .prepare('SELECT * FROM printers WHERE restaurant_id = ? AND id = ? AND active = 1')
      .get(restauranteId, cuerpo.data.printer_id)
    if (!printer) return datosInvalidos(reply, 'Esa impresora no existe')
    const names = new Map(estacionesActivas().map((e) => [e.id, e.name]))
    const ahora = clock()
    const content: PruebaImpresion = {
      printer: String(printer.name),
      stations: list(printer.station_ids).flatMap((e) => names.get(e) ?? []),
      time: new Intl.DateTimeFormat('es-CO', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timeZone,
      }).format(new Date(ahora)),
    }
    const id = insertarTrabajo(db, restauranteId, String(printer.id), content, ahora)
    cola.despertar()
    return reply.code(201).send({ trabajo_id: id })
  })

  // Lo que no ha salido, para la caja: ver por qué y descartar lo que ya no sirve.
  const PUEDE_COLA: Permission[] = ['manage_devices', 'record_payment']

  app.post('/api/printing/pending', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, PUEDE_COLA)) return reply
    return db
      .prepare(
        `SELECT t.id, t.type, t.content, t.attempts, t.last_error, t.created_at, i.name AS printer
         FROM print_jobs t JOIN printers i ON i.id = t.printer_id
         WHERE t.restaurant_id = ? AND t.status = 'pending' ORDER BY t.created_at, t.id LIMIT 200`,
      )
      .all(restauranteId)
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
          que:
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

  app.post('/api/printing/discard', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ trabajo_id: Id }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    const autor = quien(req, reply, cuerpo.data, PUEDE_COLA)
    if (!autor) return reply
    const r = db
      .prepare(
        `UPDATE print_jobs SET status = 'discarded', finished_at = ?, discarded_by_id = ?,
           discarded_device_id = ?
         WHERE restaurant_id = ? AND id = ? AND status = 'pending'`,
      )
      .run(clock(), autor.userId, autor.dispositivoId, restauranteId, cuerpo.data.trabajo_id)
    if (Number(r.changes) === 0)
      return datosInvalidos(reply, 'Esa comanda ya salió o ya se descartó')
    cola.despertar()
    return reply.code(204).send()
  })

  // Convertir el equipo desde el que se pide en pantalla de cocina (ADR-015).
  app.post('/api/screens', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({
      name: z.string().max(100),
      station_ids: Estaciones,
    }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (esEquipoDelHub(req.ip))
      return datosInvalidos(
        reply,
        'Este es el PC de la caja, donde corre el sistema: no se convierte en pantalla. Hazlo desde la tablet de la cocina.',
      )
    const r = access.convertirEnPantalla(conexionDe(req) as Conexion, {
      sesionId: cuerpo.data.session_id,
      secret: cuerpo.data.secret,
      name: cuerpo.data.name,
      estacionIds: cuerpo.data.station_ids,
    })
    if (!r.ok)
      return reply
        .code(r.code === 'no_permission' ? 403 : r.code === 'invalid_data' ? 400 : 401)
        .send({ error: r.code, message: r.message })
    avisar()
    return reply.code(201).send({
      session_id: r.sesionId,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
      type: 'kds',
    })
  })

  // Cambiar lo que muestra una pantalla, desde la caja.
  app.post('/api/screens/stations', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ device_id: Id, station_ids: Estaciones.min(1) }).safeParse(
      req.body,
    )
    if (!cuerpo.success) return datosInvalidos(reply, 'Elige al menos una estación')
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    const estacionIds = estacionesDe(cuerpo.data.station_ids)
    if (!estacionIds) return datosInvalidos(reply, 'Esa estación no existe')
    if (estacionIds.length === 0) return datosInvalidos(reply, 'Elige al menos una estación')
    const screen = db
      .prepare(
        "SELECT 1 FROM devices WHERE restaurant_id = ? AND id = ? AND type = 'kds' AND active = 1 AND revoked_at IS NULL",
      )
      .get(restauranteId, cuerpo.data.device_id)
    if (!screen) return datosInvalidos(reply, 'Esa pantalla no existe')
    actualizarVersionado(
      db,
      'devices',
      restauranteId,
      cuerpo.data.device_id,
      { station_ids: JSON.stringify(estacionIds) },
      autor,
      clock(),
    )
    avisar()
    return reply.code(204).send()
  })

  /**
   * Cambia campos de la configuración del restaurante (versionada: los equipos la leen con la
   * carta). Si no cambia nada, no escribe ni avisa.
   */
  const actualizarConfig = (
    changes: Partial<RestaurantConfig>,
    autor: { userId: string; dispositivoId: string },
  ) => {
    const current = JSON.parse(
      String(
        db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restauranteId)?.config ??
          '{}',
      ),
    ) as Record<string, unknown>
    const before = canonicalJson(fullConfig(current))
    const after = canonicalJson(fullConfig({ ...current, ...changes }))
    if (before === after) return
    actualizarVersionado(
      db,
      'restaurants',
      restauranteId,
      restauranteId,
      { config: after },
      autor,
      clock(),
    )
    avisar()
  }

  // Prender o apagar los cursos (entrada, fuerte, postre) en todo el restaurante.
  app.post('/api/kitchen/courses', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ usar: z.boolean() }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    actualizarConfig({ courses_enabled: cuerpo.data.usar }, autor)
    return reply.code(204).send()
  })

  // Minutos para el ámbar y el rojo de lo que se demora en cocina.
  app.post('/api/kitchen/timers', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({
      amarillo: z.int().min(1).max(240),
      rojo: z.int().min(1).max(240),
    }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'Escribe minutos entre 1 y 240')
    if (cuerpo.data.rojo <= cuerpo.data.amarillo)
      return datosInvalidos(reply, '«Muy demorada» debe llegar después de «demorada»')
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    actualizarConfig(
      { kitchen_yellow_min: cuerpo.data.amarillo, kitchen_red_min: cuerpo.data.rojo },
      autor,
    )
    return reply.code(204).send()
  })

  // ── Caja (tarea 1.6): impresora de precuentas, medios de pago y datáfonos ──

  // Dónde sale la precuenta; sin impresora, solo se ve en pantalla.
  app.post('/api/register/pre-bill', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ printer_id: Id.nullable() }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    const id = cuerpo.data.printer_id
    if (
      id &&
      !db
        .prepare('SELECT 1 FROM printers WHERE restaurant_id = ? AND id = ? AND active = 1')
        .get(restauranteId, id)
    )
      return datosInvalidos(reply, 'Esa impresora no existe o está archivada')
    actualizarConfig({ pre_bill_printer_id: id }, autor)
    return reply.code(204).send()
  })

  const cardTerminals = () =>
    db
      .prepare(
        'SELECT * FROM card_terminals WHERE restaurant_id = ? ORDER BY active DESC, name, id',
      )
      .all(restauranteId)
      .map((f) => ({
        id: String(f.id),
        name: String(f.name),
        provider: String(f.provider),
        active: f.active === 1,
      }))

  // Lo de la pantalla «Caja y pagos».
  app.post('/api/register/config', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['manage_devices'])) return reply
    const config = fullConfig(
      JSON.parse(
        String(
          db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restauranteId)?.config ??
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

  app.post('/api/register/payment-methods', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ medios: z.array(PaymentMethod).min(1).max(10) }).safeParse(
      req.body,
    )
    if (!cuerpo.success) return datosInvalidos(reply)
    const medios = [...new Set(cuerpo.data.medios)]
    if (medios.includes('other'))
      return datosInvalidos(reply, 'Los medios propios se crean aparte, con su nombre')
    if (!medios.includes('cash')) return datosInvalidos(reply, 'El efectivo siempre se recibe')
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    actualizarConfig({ payment_methods: medios }, autor)
    return reply.code(204).send()
  })

  // Un medio propio del restaurante (Sodexo, QR del banco): crear, renombrar o archivar.
  app.post('/api/register/custom-methods', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({
      method: z.strictObject({
        id: Id.optional(),
        name: z.string().trim().min(1).max(30),
        active: z.boolean(),
      }),
    }).safeParse(req.body)
    if (!cuerpo.success)
      return datosInvalidos(reply, 'Escribe el nombre del medio (hasta 30 letras)')
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    const current = fullConfig(
      JSON.parse(
        String(
          db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restauranteId)?.config ??
            '{}',
        ),
      ),
    )
    const m = cuerpo.data.method
    if (m.id && !current.custom_methods.some((x) => x.id === m.id))
      return datosInvalidos(reply, 'Ese medio no existe')
    const repetido = current.custom_methods.some(
      (x) => x.active && x.id !== m.id && x.name.toLowerCase() === m.name.toLowerCase(),
    )
    if (m.active && repetido) return datosInvalidos(reply, 'Ya hay un medio con ese nombre')
    const id = m.id ?? newId()
    const medios = m.id
      ? current.custom_methods.map((x) =>
          x.id === id ? { id, name: m.name, active: m.active } : x,
        )
      : [...current.custom_methods, { id, name: m.name, active: m.active }]
    if (medios.length > 20) return datosInvalidos(reply, 'Son máximo 20 medios propios')
    actualizarConfig({ custom_methods: medios }, autor)
    return { id, custom_methods: medios }
  })

  // El porcentaje de propina sugerida, en puntos básicos (1000 = 10 %). Tope del 10 % — (validar)
  // con el contador (Ley 1935 de 2018).
  app.post('/api/register/tip', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ puntos: z.int().min(0).max(1000) }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'La propina sugerida va de 0 % a 10 %')
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    actualizarConfig({ suggested_tip: cuerpo.data.puntos }, autor)
    return reply.code(204).send()
  })

  // Desde qué diferencia el cierre de caja pide justificación (tarea 1.7).
  app.post('/api/register/threshold', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ pesos: z.int().min(0).max(1_000_000) }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'Escribe un valor entre 0 y 1.000.000')
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    actualizarConfig({ register_variance_threshold: cuerpo.data.pesos }, autor)
    return reply.code(204).send()
  })

  app.post('/api/card-terminals', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({
      cardTerminal: z.strictObject({
        id: Id.optional(),
        name: z.string().trim().min(1).max(60),
        provider: z.enum(['bold', 'redeban', 'credibanco', 'other']),
        active: z.boolean(),
      }),
    }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'Revisa los datos del datáfono')
    const autor = quien(req, reply, cuerpo.data, ['manage_devices'])
    if (!autor) return reply
    const d = cuerpo.data.cardTerminal
    const repetido = db
      .prepare(
        'SELECT id FROM card_terminals WHERE restaurant_id = ? AND active = 1 AND lower(name) = lower(?)',
      )
      .all(restauranteId, d.name)
      .some((f) => String(f.id) !== d.id)
    if (d.active && repetido) return datosInvalidos(reply, 'Ya hay un datáfono con ese nombre')
    const fields = { name: d.name, provider: d.provider, active: d.active ? 1 : 0 }
    const id = enTransaccion(db, () => {
      if (!d.id)
        return insertarVersionado(db, 'card_terminals', restauranteId, fields, autor, clock())
      const current = db
        .prepare('SELECT id FROM card_terminals WHERE restaurant_id = ? AND id = ?')
        .get(restauranteId, d.id)
      if (!current) return null
      actualizarVersionado(db, 'card_terminals', restauranteId, d.id, fields, autor, clock())
      return d.id
    })
    if (!id) return datosInvalidos(reply, 'Ese datáfono no existe')
    avisar()
    return { id, cardTerminals: cardTerminals() }
  })
}

function insertarTrabajo(
  db: BaseSqlite,
  restauranteId: string,
  impresoraId: string,
  content: PruebaImpresion,
  ahora: string,
): string {
  const id = newId()
  db.prepare(
    `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(id, restauranteId, impresoraId, JSON.stringify(content), ahora)
  return id
}
