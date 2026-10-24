import type { Conexion } from '@pos/sync'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { CodigoAcceso, ErrorAcceso, ServicioAcceso } from './servicio'

// API de acceso del hub. El token del dispositivo va en `Authorization: Bearer …`. Fastify no
// registra los cuerpos en el log: el PIN no queda escrito en ninguna parte.

export interface OpcionesRutasAcceso {
  acceso: ServicioAcceso
}

const ESTADO: Record<CodigoAcceso, number> = {
  pin_incorrecto: 401,
  sesion_invalida: 401,
  equipo_no_emparejado: 401,
  codigo_invalido: 400,
  datos_invalidos: 400,
  espera: 429,
  sin_permiso: 403,
  autoautorizacion: 403,
  dispositivo_revocado: 403,
  ya_autorizado: 409,
}

const Id = z.string().length(26)
const Pin = z.string().max(20)
const Secreto = z.string().min(1).max(100)

const Cuerpos = {
  emparejamiento: z.strictObject({
    pin: Pin,
    nombre: z.string().max(100),
    tipo: z.string().max(20),
  }),
  emparejar: z.strictObject({ codigo: z.string().max(20) }),
  sesion: z.strictObject({ pin: Pin }),
  cerrar: z.strictObject({ sesion_id: Id, secreto: Secreto }),
  autorizacion: z.strictObject({
    sesion_id: Id,
    secreto: Secreto,
    pin: Pin,
    accion: z.string().max(50),
    agregado_id: Id,
    evento_id: Id,
    huella: z.string().max(64),
  }),
  revocar: z.strictObject({ sesion_id: Id, secreto: Secreto }),
}

function enviarError(reply: FastifyReply, e: ErrorAcceso) {
  if (e.esperaMs) reply.header('retry-after', Math.ceil(e.esperaMs / 1000))
  return reply.code(ESTADO[e.codigo]).send({
    error: e.codigo,
    mensaje: e.mensaje,
    ...(e.esperaMs ? { espera_ms: e.esperaMs } : {}),
  })
}

function leer<T>(esquema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null {
  const r = esquema.safeParse(req.body)
  if (r.success) return r.data
  reply.code(400).send({ error: 'datos_invalidos', mensaje: 'Datos con formato inesperado' })
  return null
}

export async function rutasAcceso(app: FastifyInstance, { acceso }: OpcionesRutasAcceso) {
  const delToken = (req: FastifyRequest): Conexion | null => {
    const [esquema, token] = (req.headers.authorization ?? '').split(' ')
    return esquema === 'Bearer' && token ? acceso.autenticar(token) : null
  }

  /** El dispositivo del token, o responde 401. */
  const dispositivo = (req: FastifyRequest, reply: FastifyReply): Conexion | null => {
    const conexion = delToken(req)
    if (!conexion)
      reply.code(401).send({ error: 'token_invalido', mensaje: 'Este equipo no está emparejado' })
    return conexion
  }

  app.post('/api/emparejamientos', async (req, reply) => {
    const cuerpo = leer(Cuerpos.emparejamiento, req, reply)
    if (!cuerpo) return reply
    // Sin token solo vale para el primer equipo (la caja de un hub recién instalado).
    const r = acceso.crearEmparejamiento(cuerpo, delToken(req))
    if (!r.ok) return enviarError(reply, r)
    return reply.code(201).send({ codigo: r.codigo, vence_en: r.venceEn })
  })

  app.post('/api/emparejar', async (req, reply) => {
    const cuerpo = leer(Cuerpos.emparejar, req, reply)
    if (!cuerpo) return reply
    const r = acceso.emparejar(cuerpo.codigo, req.ip)
    if (!r.ok) return enviarError(reply, r)
    return reply
      .code(201)
      .send({ dispositivo_id: r.dispositivoId, token: r.token, nombre: r.nombre, tipo: r.tipo })
  })

  app.post('/api/sesiones', async (req, reply) => {
    const conexion = dispositivo(req, reply)
    if (!conexion) return reply
    const cuerpo = leer(Cuerpos.sesion, req, reply)
    if (!cuerpo) return reply
    const r = acceso.iniciarSesion(conexion, cuerpo.pin)
    if (!r.ok) return enviarError(reply, r)
    return reply.code(201).send({
      sesion_id: r.sesionId,
      secreto: r.secreto,
      usuario: r.usuario,
      permisos: r.permisos,
    })
  })

  app.post('/api/sesiones/cerrar', async (req, reply) => {
    const conexion = dispositivo(req, reply)
    if (!conexion) return reply
    const cuerpo = leer(Cuerpos.cerrar, req, reply)
    if (!cuerpo) return reply
    const r = acceso.cerrarSesion(conexion, { sesionId: cuerpo.sesion_id, secreto: cuerpo.secreto })
    if (!r.ok) return enviarError(reply, r)
    return reply.code(204).send()
  })

  app.post('/api/autorizaciones', async (req, reply) => {
    const conexion = dispositivo(req, reply)
    if (!conexion) return reply
    const c = leer(Cuerpos.autorizacion, req, reply)
    if (!c) return reply
    const r = acceso.autorizar(conexion, {
      sesionId: c.sesion_id,
      secreto: c.secreto,
      pin: c.pin,
      accion: c.accion,
      agregadoId: c.agregado_id,
      eventoId: c.evento_id,
      huella: c.huella,
    })
    if (!r.ok) return enviarError(reply, r)
    return reply.code(201).send({ autorizacion_id: r.autorizacionId, supervisor: r.supervisor })
  })

  app.post<{ Params: { id: string } }>('/api/dispositivos/:id/revocar', async (req, reply) => {
    const conexion = dispositivo(req, reply)
    if (!conexion) return reply
    const cuerpo = leer(Cuerpos.revocar, req, reply)
    if (!cuerpo) return reply
    const r = acceso.revocarDispositivo(conexion, {
      sesionId: cuerpo.sesion_id,
      secreto: cuerpo.secreto,
      dispositivoId: req.params.id,
    })
    if (!r.ok) return enviarError(reply, r)
    return reply.send({ revocado_en: r.revocadoEn })
  })
}
