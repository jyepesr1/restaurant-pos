import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { OpcionesCatalogo } from '../catalogo'
import { ErrorPersonal, guardarPersona, guardarRol, leerPersonal } from './personal'

// API de personal y roles (tarea 1.3b): solo con una sesión abierta cuyo rol tenga
// `manage_users`. Las contraseñas van en el cuerpo, que Fastify no registra en el log.

const Sesion = { session_id: z.string().length(26), secret: z.string().min(1).max(100) }
const Id = z.string().length(26)

const Cuerpos = {
  read: z.strictObject(Sesion),
  role: z.strictObject({
    ...Sesion,
    role: z.strictObject({
      id: Id.optional(),
      name: z.string().max(100),
      permissions: z.array(z.string().max(50)).max(100),
      active: z.boolean().optional(),
    }),
  }),
  person: z.strictObject({
    ...Sesion,
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
      regenerar_pin: z.boolean().optional(),
    }),
  }),
}

export async function rutasPersonal(
  app: FastifyInstance,
  { db, restaurantId, access, onChange, clock = () => new Date().toISOString() }: OpcionesCatalogo,
) {
  /** Quién hace el cambio, o responde el error. */
  const administrador = <T extends z.ZodType<{ session_id: string; secret: string }>>(
    esquema: T,
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
    const cuerpo = esquema.safeParse(req.body)
    if (!cuerpo.success) {
      reply.code(400).send({ error: 'invalid_data', message: 'Datos con formato inesperado' })
      return null
    }
    const who = access.usuarioConPermiso(
      connection,
      { sesionId: cuerpo.data.session_id, secret: cuerpo.data.secret },
      'manage_users',
    )
    if (!who.ok) {
      reply
        .code(who.code === 'no_permission' ? 403 : 401)
        .send({ error: who.code, message: who.message })
      return null
    }
    return {
      data: cuerpo.data as z.infer<T>,
      autor: { userId: who.userId, deviceId: connection.deviceId },
    }
  }

  /** Los equipos traen la carta de nuevo: ahí va el nombre de cada persona. */
  const notify = () => {
    const f = db
      .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
      .get(restaurantId)
    onChange?.(Number(f?.value ?? 0))
  }

  const conErrores = async (reply: FastifyReply, job: () => unknown) => {
    try {
      const r = job()
      notify()
      return reply.code(200).send(r)
    } catch (e) {
      if (e instanceof ErrorPersonal)
        return reply.code(400).send({ error: 'invalid_data', message: e.message })
      throw e
    }
  }

  app.post('/api/staff/read', async (req, reply) => {
    if (!administrador(Cuerpos.read, req, reply)) return reply
    return leerPersonal(db, restaurantId, access)
  })

  app.post('/api/staff/roles', async (req, reply) => {
    const a = administrador(Cuerpos.role, req, reply)
    if (!a) return reply
    return conErrores(reply, () => ({
      id: guardarRol(db, restaurantId, access, a.data.role, a.autor, clock()),
    }))
  })

  app.post('/api/staff/people', async (req, reply) => {
    const a = administrador(Cuerpos.person, req, reply)
    if (!a) return reply
    const p = a.data.person
    return conErrores(reply, () => {
      const r = guardarPersona(
        db,
        restaurantId,
        access,
        {
          id: p.id,
          name: p.name,
          rolId: p.role_id,
          active: p.active,
          access: p.access,
          regenerarPin: p.regenerar_pin,
        },
        a.autor,
        clock(),
      )
      return { id: r.userId, pin: r.pin }
    })
  })
}
