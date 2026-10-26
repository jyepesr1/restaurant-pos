import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { OpcionesCatalogo } from '../catalogo'
import { ErrorPersonal, guardarPersona, guardarRol, leerPersonal } from './personal'

// API de personal y roles (tarea 1.3b): solo con una sesión abierta cuyo rol tenga
// `manage_users`. Las contraseñas van en el cuerpo, que Fastify no registra en el log.

const Sesion = { session_id: z.string().length(26), secret: z.string().min(1).max(100) }
const Id = z.string().length(26)

const Cuerpos = {
  leer: z.strictObject(Sesion),
  role: z.strictObject({
    ...Sesion,
    role: z.strictObject({
      id: Id.optional(),
      name: z.string().max(100),
      permissions: z.array(z.string().max(50)).max(100),
      active: z.boolean().optional(),
    }),
  }),
  persona: z.strictObject({
    ...Sesion,
    persona: z.strictObject({
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
  { db, restauranteId, access, onChange, clock = () => new Date().toISOString() }: OpcionesCatalogo,
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
    const quien = access.usuarioConPermiso(
      connection,
      { sesionId: cuerpo.data.session_id, secret: cuerpo.data.secret },
      'manage_users',
    )
    if (!quien.ok) {
      reply
        .code(quien.code === 'no_permission' ? 403 : 401)
        .send({ error: quien.code, message: quien.message })
      return null
    }
    return {
      data: cuerpo.data as z.infer<T>,
      autor: { userId: quien.userId, dispositivoId: connection.dispositivoId },
    }
  }

  /** Los equipos traen la carta de nuevo: ahí va el nombre de cada persona. */
  const avisar = () => {
    const f = db
      .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
      .get(restauranteId)
    onChange?.(Number(f?.value ?? 0))
  }

  const conErrores = async (reply: FastifyReply, trabajo: () => unknown) => {
    try {
      const r = trabajo()
      avisar()
      return reply.code(200).send(r)
    } catch (e) {
      if (e instanceof ErrorPersonal)
        return reply.code(400).send({ error: 'invalid_data', message: e.message })
      throw e
    }
  }

  app.post('/api/staff/read', async (req, reply) => {
    if (!administrador(Cuerpos.leer, req, reply)) return reply
    return leerPersonal(db, restauranteId, access)
  })

  app.post('/api/staff/roles', async (req, reply) => {
    const a = administrador(Cuerpos.role, req, reply)
    if (!a) return reply
    return conErrores(reply, () => ({
      id: guardarRol(db, restauranteId, access, a.data.role, a.autor, clock()),
    }))
  })

  app.post('/api/staff/people', async (req, reply) => {
    const a = administrador(Cuerpos.persona, req, reply)
    if (!a) return reply
    const p = a.data.persona
    return conErrores(reply, () => {
      const r = guardarPersona(
        db,
        restauranteId,
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
