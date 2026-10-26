import type { Connection } from '@pos/sync'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AccessCode, AccessError, AccessService } from './service'

// Hub access API. The device token goes in `Authorization: Bearer …`. Fastify does not log
// request bodies: neither the PIN nor the password is written anywhere.

export interface AccessRoutesOptions {
  access: AccessService
}

const STATUS: Record<AccessCode, number> = {
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
const Secret = z.string().min(1).max(100)

const Bodies = {
  pairing: z.strictObject({
    pin: Pin,
    name: z.string().max(100),
    type: z.string().max(20),
  }),
  pair: z.strictObject({ code: z.string().max(20) }),
  session: z.strictObject({ pin: Pin }),
  signIn: z.union([
    z.strictObject({ pin: Pin }),
    z.strictObject({ user: z.string().max(100), password: z.string().max(200) }),
  ]),
  close: z.strictObject({ session_id: Id, secret: Secret }),
  authorization: z.strictObject({
    session_id: Id,
    secret: Secret,
    pin: Pin,
    action: z.string().max(50),
    aggregate_id: Id,
    event_id: Id,
    fingerprint: z.string().max(64),
  }),
  revoke: z.strictObject({ session_id: Id, secret: Secret }),
}

function sendError(reply: FastifyReply, e: AccessError) {
  if (e.waitMs) reply.header('retry-after', Math.ceil(e.waitMs / 1000))
  return reply.code(STATUS[e.code]).send({
    error: e.code,
    message: e.message,
    ...(e.waitMs ? { wait_ms: e.waitMs } : {}),
  })
}

function read<T>(schema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null {
  const r = schema.safeParse(req.body)
  if (r.success) return r.data
  reply.code(400).send({ error: 'invalid_data', message: 'Datos con formato inesperado' })
  return null
}

export async function accessRoutes(app: FastifyInstance, { access }: AccessRoutesOptions) {
  const fromToken = (req: FastifyRequest): Connection | null => {
    const [schema, token] = (req.headers.authorization ?? '').split(' ')
    return schema === 'Bearer' && token ? access.authenticate(token) : null
  }

  /** The token's device, or replies 401. */
  const device = (req: FastifyRequest, reply: FastifyReply): Connection | null => {
    const connection = fromToken(req)
    if (!connection)
      reply.code(401).send({
        error: 'invalid_token',
        message: 'Este equipo ya no tiene acceso: vuelve a entrar',
      })
    return connection
  }

  app.post('/api/pairings', async (req, reply) => {
    const body = read(Bodies.pairing, req, reply)
    if (!body) return reply
    // Since ADR-013 phones and the register sign in without pairing (`/api/sign-in`): this remains
    // only for the kitchen screen (task 1.4), approved from a device that is already registered.
    const connection = device(req, reply)
    if (!connection) return reply
    if (body.type !== 'kds')
      return reply.code(400).send({
        error: 'invalid_data',
        message: 'Celulares y cajas no se emparejan: entran con PIN o con usuario y contraseña',
      })
    const r = access.createPairing(body, connection)
    if (!r.ok) return sendError(reply, r)
    return reply.code(201).send({ code: r.code, expires_at: r.expiresAt })
  })

  app.post('/api/pair', async (req, reply) => {
    const body = read(Bodies.pair, req, reply)
    if (!body) return reply
    const r = access.pair(body.code, req.ip)
    if (!r.ok) return sendError(reply, r)
    return reply
      .code(201)
      .send({ device_id: r.deviceId, token: r.token, name: r.name, type: r.type })
  })

  // Sign in from any browser on the network (ADR-013). Without a token, on success the hub
  // registers the browser as a device and returns its token, which is shown only this once.
  app.post('/api/sign-in', async (req, reply) => {
    const authorization = req.headers.authorization
    const connection = authorization ? device(req, reply) : null
    if (authorization && !connection) return reply
    const body = read(Bodies.signIn, req, reply)
    if (!body) return reply
    const r = access.signIn(body, connection, req.ip)
    if (!r.ok) return sendError(reply, r)
    return reply.code(201).send({
      device: r.device && {
        device_id: r.device.deviceId,
        token: r.device.token,
        name: r.device.name,
        type: r.device.type,
      },
      type: r.type,
      session_id: r.sessionId,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
    })
  })

  app.post('/api/sessions', async (req, reply) => {
    const connection = device(req, reply)
    if (!connection) return reply
    const body = read(Bodies.session, req, reply)
    if (!body) return reply
    const r = access.startSession(connection, body.pin)
    if (!r.ok) return sendError(reply, r)
    return reply.code(201).send({
      session_id: r.sessionId,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
    })
  })

  app.post('/api/sessions/close', async (req, reply) => {
    const connection = device(req, reply)
    if (!connection) return reply
    const body = read(Bodies.close, req, reply)
    if (!body) return reply
    const r = access.closeSession(connection, {
      sessionId: body.session_id,
      secret: body.secret,
    })
    if (!r.ok) return sendError(reply, r)
    return reply.code(204).send()
  })

  app.post('/api/authorizations', async (req, reply) => {
    const connection = device(req, reply)
    if (!connection) return reply
    const c = read(Bodies.authorization, req, reply)
    if (!c) return reply
    const r = access.authorize(connection, {
      sessionId: c.session_id,
      secret: c.secret,
      pin: c.pin,
      action: c.action,
      aggregateId: c.aggregate_id,
      eventId: c.event_id,
      fingerprint: c.fingerprint,
    })
    if (!r.ok) return sendError(reply, r)
    return reply.code(201).send({ authorization_id: r.authorizationId, supervisor: r.supervisor })
  })

  app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (req, reply) => {
    const connection = device(req, reply)
    if (!connection) return reply
    const body = read(Bodies.revoke, req, reply)
    if (!body) return reply
    const r = access.revokeDevice(connection, {
      sessionId: body.session_id,
      secret: body.secret,
      deviceId: req.params.id,
    })
    if (!r.ok) return sendError(reply, r)
    return reply.send({ revoked_at: r.revokedAt })
  })
}
