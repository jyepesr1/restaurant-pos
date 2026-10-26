import type { Conexion } from '@pos/sync'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { CodigoAcceso, ErrorAcceso, ServicioAcceso } from './servicio'

// API de acceso del hub. El token del dispositivo va en `Authorization: Bearer …`. Fastify no
// registra los cuerpos en el log: ni el PIN ni la contraseña quedan escritos en ninguna parte.

export interface OpcionesRutasAcceso {
  access: ServicioAcceso
}

const ESTADO: Record<CodigoAcceso, number> = {
  wrong_pin: 401,
  invalid_credentials: 401,
  invalid_session: 401,
  unpaired_device: 401,
  invalid_code: 400,
  invalid_data: 400,
  wait: 429,
  no_permission: 403,
  self_authorization: 403,
  revoked_device: 403,
  already_authorized: 409,
}

const Id = z.string().length(26)
const Pin = z.string().max(20)
const Secreto = z.string().min(1).max(100)

const Cuerpos = {
  emparejamiento: z.strictObject({
    pin: Pin,
    name: z.string().max(100),
    type: z.string().max(20),
  }),
  emparejar: z.strictObject({ code: z.string().max(20) }),
  session: z.strictObject({ pin: Pin }),
  entrar: z.union([
    z.strictObject({ pin: Pin }),
    z.strictObject({ user: z.string().max(100), password: z.string().max(200) }),
  ]),
  close: z.strictObject({ session_id: Id, secret: Secreto }),
  authorization: z.strictObject({
    session_id: Id,
    secret: Secreto,
    pin: Pin,
    action: z.string().max(50),
    aggregate_id: Id,
    event_id: Id,
    fingerprint: z.string().max(64),
  }),
  revoke: z.strictObject({ session_id: Id, secret: Secreto }),
}

function enviarError(reply: FastifyReply, e: ErrorAcceso) {
  if (e.esperaMs) reply.header('retry-after', Math.ceil(e.esperaMs / 1000))
  return reply.code(ESTADO[e.code]).send({
    error: e.code,
    message: e.message,
    ...(e.esperaMs ? { espera_ms: e.esperaMs } : {}),
  })
}

function leer<T>(esquema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null {
  const r = esquema.safeParse(req.body)
  if (r.success) return r.data
  reply.code(400).send({ error: 'invalid_data', message: 'Datos con formato inesperado' })
  return null
}

export async function rutasAcceso(app: FastifyInstance, { access }: OpcionesRutasAcceso) {
  const delToken = (req: FastifyRequest): Conexion | null => {
    const [esquema, token] = (req.headers.authorization ?? '').split(' ')
    return esquema === 'Bearer' && token ? access.authenticate(token) : null
  }

  /** El dispositivo del token, o responde 401. */
  const device = (req: FastifyRequest, reply: FastifyReply): Conexion | null => {
    const connection = delToken(req)
    if (!connection)
      reply.code(401).send({
        error: 'invalid_token',
        message: 'Este equipo ya no tiene acceso: vuelve a entrar',
      })
    return connection
  }

  app.post('/api/pairings', async (req, reply) => {
    const cuerpo = leer(Cuerpos.emparejamiento, req, reply)
    if (!cuerpo) return reply
    // Desde ADR-013 los celulares y la caja entran sin emparejar (`/api/entrar`): esto queda solo
    // para la pantalla de cocina (tarea 1.4), aprobado desde un equipo que ya está registrado.
    const connection = device(req, reply)
    if (!connection) return reply
    if (cuerpo.type !== 'kds')
      return reply.code(400).send({
        error: 'invalid_data',
        message: 'Celulares y cajas no se emparejan: entran con PIN o con usuario y contraseña',
      })
    const r = access.crearEmparejamiento(cuerpo, connection)
    if (!r.ok) return enviarError(reply, r)
    return reply.code(201).send({ code: r.code, expires_at: r.venceEn })
  })

  app.post('/api/pair', async (req, reply) => {
    const cuerpo = leer(Cuerpos.emparejar, req, reply)
    if (!cuerpo) return reply
    const r = access.emparejar(cuerpo.code, req.ip)
    if (!r.ok) return enviarError(reply, r)
    return reply
      .code(201)
      .send({ device_id: r.dispositivoId, token: r.token, name: r.name, type: r.type })
  })

  // Entrar desde cualquier navegador de la red (ADR-013). Sin token, con el acierto el hub
  // registra el navegador como equipo y devuelve su token, que se ve solo esta vez.
  app.post('/api/sign-in', async (req, reply) => {
    const authorization = req.headers.authorization
    const connection = authorization ? device(req, reply) : null
    if (authorization && !connection) return reply
    const cuerpo = leer(Cuerpos.entrar, req, reply)
    if (!cuerpo) return reply
    const r = access.entrar(cuerpo, connection, req.ip)
    if (!r.ok) return enviarError(reply, r)
    return reply.code(201).send({
      device: r.device && {
        device_id: r.device.dispositivoId,
        token: r.device.token,
        name: r.device.name,
        type: r.device.type,
      },
      type: r.type,
      session_id: r.sesionId,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
    })
  })

  app.post('/api/sessions', async (req, reply) => {
    const connection = device(req, reply)
    if (!connection) return reply
    const cuerpo = leer(Cuerpos.session, req, reply)
    if (!cuerpo) return reply
    const r = access.startSession(connection, cuerpo.pin)
    if (!r.ok) return enviarError(reply, r)
    return reply.code(201).send({
      session_id: r.sesionId,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
    })
  })

  app.post('/api/sessions/close', async (req, reply) => {
    const connection = device(req, reply)
    if (!connection) return reply
    const cuerpo = leer(Cuerpos.close, req, reply)
    if (!cuerpo) return reply
    const r = access.cerrarSesion(connection, {
      sesionId: cuerpo.session_id,
      secret: cuerpo.secret,
    })
    if (!r.ok) return enviarError(reply, r)
    return reply.code(204).send()
  })

  app.post('/api/authorizations', async (req, reply) => {
    const connection = device(req, reply)
    if (!connection) return reply
    const c = leer(Cuerpos.authorization, req, reply)
    if (!c) return reply
    const r = access.autorizar(connection, {
      sesionId: c.session_id,
      secret: c.secret,
      pin: c.pin,
      action: c.action,
      agregadoId: c.aggregate_id,
      eventId: c.event_id,
      fingerprint: c.fingerprint,
    })
    if (!r.ok) return enviarError(reply, r)
    return reply.code(201).send({ authorization_id: r.autorizacionId, supervisor: r.supervisor })
  })

  app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (req, reply) => {
    const connection = device(req, reply)
    if (!connection) return reply
    const cuerpo = leer(Cuerpos.revoke, req, reply)
    if (!cuerpo) return reply
    const r = access.revocarDispositivo(connection, {
      sesionId: cuerpo.session_id,
      secret: cuerpo.secret,
      dispositivoId: req.params.id,
    })
    if (!r.ok) return enviarError(reply, r)
    return reply.send({ revoked_at: r.revocadoEn })
  })
}
