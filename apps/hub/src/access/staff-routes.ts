import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { CatalogOptions } from '../catalog'
import { readStaff, StaffError, saveRole, saveStaffMember } from './staff'

// Staff and roles API (task 1.3b): only with an open session whose role has
// `manage_users`. Passwords go in the body, which Fastify does not write to the log.

const Session = { session_id: z.string().length(26), secret: z.string().min(1).max(100) }
const Id = z.string().length(26)

const Bodies = {
  read: z.strictObject(Session),
  role: z.strictObject({
    ...Session,
    role: z.strictObject({
      id: Id.optional(),
      name: z.string().max(100),
      permissions: z.array(z.string().max(50)).max(100),
      active: z.boolean().optional(),
    }),
  }),
  person: z.strictObject({
    ...Session,
    person: z.strictObject({
      id: Id.optional(),
      name: z.string().max(100),
      role_id: Id,
      active: z.boolean().optional(),
      access: z
        .union([
          z.strictObject({ type: z.literal('pin') }),
          z.strictObject({
            type: z.literal('password'),
            user: z.string().max(100),
            password: z.string().max(200).optional(),
          }),
        ])
        .optional(),
      regenerate_pin: z.boolean().optional(),
    }),
  }),
}

export async function staffRoutes(
  app: FastifyInstance,
  { db, restaurantId, access, onChange, clock = () => new Date().toISOString() }: CatalogOptions,
) {
  /** Who makes the change, or replies with the error. */
  const admin = <T extends z.ZodType<{ session_id: string; secret: string }>>(
    schema: T,
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const [type, token] = (req.headers.authorization ?? '').split(' ')
    const connection = type === 'Bearer' && token ? access.authenticate(token) : null
    if (!connection) {
      reply.code(401).send({
        error: 'invalid_token',
        message: 'Este equipo ya no tiene acceso: vuelve a entrar',
      })
      return null
    }
    const body = schema.safeParse(req.body)
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_data', message: 'Datos con formato inesperado' })
      return null
    }
    const who = access.userWithPermission(
      connection,
      { sessionId: body.data.session_id, secret: body.data.secret },
      'manage_users',
    )
    if (!who.ok) {
      reply
        .code(who.code === 'no_permission' ? 403 : 401)
        .send({ error: who.code, message: who.message })
      return null
    }
    return {
      data: body.data as z.infer<T>,
      author: { userId: who.userId, deviceId: connection.deviceId },
    }
  }

  /** Devices fetch the menu again: that is where each person's name goes. */
  const notify = () => {
    const f = db
      .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
      .get(restaurantId)
    onChange?.(Number(f?.value ?? 0))
  }

  const withErrors = async (reply: FastifyReply, job: () => unknown) => {
    try {
      const r = job()
      notify()
      return reply.code(200).send(r)
    } catch (e) {
      if (e instanceof StaffError)
        return reply.code(400).send({ error: 'invalid_data', message: e.message })
      throw e
    }
  }

  app.post('/api/staff/read', async (req, reply) => {
    if (!admin(Bodies.read, req, reply)) return reply
    return readStaff(db, restaurantId, access)
  })

  app.post('/api/staff/roles', async (req, reply) => {
    const a = admin(Bodies.role, req, reply)
    if (!a) return reply
    return withErrors(reply, () => ({
      id: saveRole(db, restaurantId, access, a.data.role, a.author, clock()),
    }))
  })

  app.post('/api/staff/people', async (req, reply) => {
    const a = admin(Bodies.person, req, reply)
    if (!a) return reply
    const p = a.data.person
    return withErrors(reply, () => {
      const r = saveStaffMember(
        db,
        restaurantId,
        access,
        {
          id: p.id,
          name: p.name,
          roleId: p.role_id,
          active: p.active,
          access: p.access,
          regeneratePin: p.regenerate_pin,
        },
        a.author,
        clock(),
      )
      return { id: r.userId, pin: r.pin }
    })
  })
}
