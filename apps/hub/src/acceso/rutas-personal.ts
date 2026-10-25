import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { OpcionesCatalogo } from '../catalogo'
import { ErrorPersonal, guardarPersona, guardarRol, leerPersonal } from './personal'

// API de personal y roles (tarea 1.3b): solo con una sesión abierta cuyo rol tenga
// `administrar_usuarios`. Las contraseñas van en el cuerpo, que Fastify no registra en el log.

const Sesion = { sesion_id: z.string().length(26), secreto: z.string().min(1).max(100) }
const Id = z.string().length(26)

const Cuerpos = {
  leer: z.strictObject(Sesion),
  rol: z.strictObject({
    ...Sesion,
    rol: z.strictObject({
      id: Id.optional(),
      nombre: z.string().max(100),
      permisos: z.array(z.string().max(50)).max(100),
      activo: z.boolean().optional(),
    }),
  }),
  persona: z.strictObject({
    ...Sesion,
    persona: z.strictObject({
      id: Id.optional(),
      nombre: z.string().max(100),
      rol_id: Id,
      activo: z.boolean().optional(),
      acceso: z
        .union([
          z.strictObject({ tipo: z.literal('pin') }),
          z.strictObject({
            tipo: z.literal('contrasena'),
            usuario: z.string().max(100),
            contrasena: z.string().max(200).optional(),
          }),
        ])
        .optional(),
      regenerar_pin: z.boolean().optional(),
    }),
  }),
}

export async function rutasPersonal(
  app: FastifyInstance,
  {
    db,
    restauranteId,
    acceso,
    alCambiar,
    reloj = () => new Date().toISOString(),
  }: OpcionesCatalogo,
) {
  /** Quién hace el cambio, o responde el error. */
  const administrador = <T extends z.ZodType<{ sesion_id: string; secreto: string }>>(
    esquema: T,
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const [tipo, token] = (req.headers.authorization ?? '').split(' ')
    const conexion = tipo === 'Bearer' && token ? acceso.autenticar(token) : null
    if (!conexion) {
      reply.code(401).send({
        error: 'token_invalido',
        mensaje: 'Este equipo ya no tiene acceso: vuelve a entrar',
      })
      return null
    }
    const cuerpo = esquema.safeParse(req.body)
    if (!cuerpo.success) {
      reply.code(400).send({ error: 'datos_invalidos', mensaje: 'Datos con formato inesperado' })
      return null
    }
    const quien = acceso.usuarioConPermiso(
      conexion,
      { sesionId: cuerpo.data.sesion_id, secreto: cuerpo.data.secreto },
      'administrar_usuarios',
    )
    if (!quien.ok) {
      reply
        .code(quien.codigo === 'sin_permiso' ? 403 : 401)
        .send({ error: quien.codigo, mensaje: quien.mensaje })
      return null
    }
    return {
      datos: cuerpo.data as z.infer<T>,
      autor: { usuarioId: quien.usuarioId, dispositivoId: conexion.dispositivoId },
    }
  }

  /** Los equipos traen la carta de nuevo: ahí va el nombre de cada persona. */
  const avisar = () => {
    const f = db
      .prepare("SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = 'catalogo'")
      .get(restauranteId)
    alCambiar?.(Number(f?.valor ?? 0))
  }

  const conErrores = async (reply: FastifyReply, trabajo: () => unknown) => {
    try {
      const r = trabajo()
      avisar()
      return reply.code(200).send(r)
    } catch (e) {
      if (e instanceof ErrorPersonal)
        return reply.code(400).send({ error: 'datos_invalidos', mensaje: e.message })
      throw e
    }
  }

  app.post('/api/personal/leer', async (req, reply) => {
    if (!administrador(Cuerpos.leer, req, reply)) return reply
    return leerPersonal(db, restauranteId, acceso)
  })

  app.post('/api/personal/roles', async (req, reply) => {
    const a = administrador(Cuerpos.rol, req, reply)
    if (!a) return reply
    return conErrores(reply, () => ({
      id: guardarRol(db, restauranteId, acceso, a.datos.rol, a.autor, reloj()),
    }))
  })

  app.post('/api/personal/personas', async (req, reply) => {
    const a = administrador(Cuerpos.persona, req, reply)
    if (!a) return reply
    const p = a.datos.persona
    return conErrores(reply, () => {
      const r = guardarPersona(
        db,
        restauranteId,
        acceso,
        {
          id: p.id,
          nombre: p.nombre,
          rolId: p.rol_id,
          activo: p.activo,
          acceso: p.acceso,
          regenerarPin: p.regenerar_pin,
        },
        a.autor,
        reloj(),
      )
      return { id: r.usuarioId, pin: r.pin }
    })
  })
}
