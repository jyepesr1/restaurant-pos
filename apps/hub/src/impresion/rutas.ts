import {
  type ConfigRestaurante,
  configCompleta,
  jsonCanonico,
  MedioPago,
  nuevoId,
  type Permiso,
} from '@pos/core'
import { type BaseSqlite, enTransaccion, type Fila } from '@pos/db'
import { PAGINAS_CODIGOS } from '@pos/printing'
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
  acceso: ServicioAcceso
  cola: ColaImpresion
  zonaHoraria: string
  /** Cambió algo que los equipos leen con la carta (estaciones, pantallas, tiempos). */
  alCambiar?: (version: number) => void
  reloj?: () => string
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
  direccion: string,
  puerto: number | null,
  locales: boolean,
): string | null {
  // Sin ceros a la izquierda: «010.0.0.1» se lee en octal y saldría a 8.0.0.1.
  const octeto = '(0|[1-9]\\d{0,2})'
  const m = new RegExp(`^${octeto}\\.${octeto}\\.${octeto}\\.${octeto}$`).exec(direccion)
  const partes = m ? m.slice(1).map(Number) : null
  if (!partes || partes.some((n) => n > 255))
    return 'Escribe la IP de la impresora, por ejemplo 192.168.1.50'
  const [a, b] = partes as [number, number]
  const privada = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  const local = a === 127
  if (!privada && !(locales && local))
    return 'Esa IP no es de la red del local: debe empezar por 192.168, 10 o 172.16 a 172.31'
  const p = puerto ?? 9100
  if (!locales && (p < 9100 || p > 9109))
    return 'Las impresoras de red usan el puerto 9100 (hasta 9109)'
  return null
}

const Sesion = z.strictObject({
  sesion_id: z.string().length(26),
  secreto: z.string().min(1).max(100),
})
const Id = z.string().length(26)
const Estaciones = z.array(Id).max(50)

/** Una IP o un nombre de equipo de la red local (sin esquema ni ruta). */

const Impresora = z.strictObject({
  id: Id.optional(),
  nombre: z.string().trim().min(1).max(60),
  conexion: z.enum(['red', 'usb']),
  direccion: z.string().trim().min(1).max(255),
  puerto: z.int().min(1).max(65535).nullable(),
  ancho: z.union([z.literal(58), z.literal(80)]),
  pagina_codigos: z.enum(PAGINAS_CODIGOS),
  respaldo_id: Id.nullable(),
  estacion_ids: Estaciones,
  activo: z.boolean(),
})

const lista = (v: unknown): string[] => {
  const l = JSON.parse(String(v ?? '[]'))
  return Array.isArray(l) ? l.map(String) : []
}

export async function rutasImpresion(
  app: FastifyInstance,
  {
    db,
    restauranteId,
    acceso,
    cola,
    zonaHoraria,
    alCambiar,
    reloj = () => new Date().toISOString(),
    permitirLocales = false,
    esEquipoDelHub = () => false,
  }: OpcionesImpresion,
) {
  const conexionDe = (req: FastifyRequest): Conexion | null => {
    const [esquema, token] = (req.headers.authorization ?? '').split(' ')
    const conexion = esquema === 'Bearer' && token ? acceso.autenticar(token) : null
    return conexion && !conexion.revocadoEn ? conexion : null
  }
  // El equipo se comprueba antes de leer el cuerpo: sin token no se recibe ni se valida nada.
  const conEquipo = {
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!conexionDe(req))
        return reply.code(401).send({
          error: 'token_invalido',
          mensaje: 'Este equipo ya no tiene acceso: vuelve a entrar',
        })
    },
  }
  const datosInvalidos = (reply: FastifyReply, mensaje = 'Datos con formato inesperado') =>
    reply.code(400).send({ error: 'datos_invalidos', mensaje })

  /** Quién lo pide, si su sesión tiene alguno de esos permisos; si no, responde el error. */
  const quien = (
    req: FastifyRequest,
    reply: FastifyReply,
    sesion: { sesion_id: string; secreto: string },
    permisos: Permiso[],
  ) => {
    const conexion = conexionDe(req) as Conexion
    let r = acceso.usuarioConPermiso(
      conexion,
      { sesionId: sesion.sesion_id, secreto: sesion.secreto },
      permisos[0] as Permiso,
    )
    for (const p of permisos.slice(1)) {
      if (r.ok || r.codigo !== 'sin_permiso') break
      r = acceso.usuarioConPermiso(
        conexion,
        { sesionId: sesion.sesion_id, secreto: sesion.secreto },
        p,
      )
    }
    if (!r.ok) {
      reply
        .code(r.codigo === 'sin_permiso' ? 403 : 401)
        .send({ error: r.codigo, mensaje: r.mensaje })
      return null
    }
    return { usuarioId: r.usuarioId, dispositivoId: conexion.dispositivoId }
  }

  const estacionesActivas = () =>
    db
      .prepare(
        'SELECT id, nombre FROM estacion WHERE restaurante_id = ? AND activo = 1 ORDER BY orden, nombre',
      )
      .all(restauranteId)
      .map((f) => ({ id: String(f.id), nombre: String(f.nombre) }))
  /**
   * Las estaciones elegidas, sin repetir. Una archivada se quita sin error (la pantalla no la
   * muestra y no se podría desmarcar); una que no es de este restaurante, `null`.
   */
  const estacionesDe = (ids: readonly string[]): string[] | null => {
    const todas = new Map(
      db
        .prepare('SELECT id, activo FROM estacion WHERE restaurante_id = ?')
        .all(restauranteId)
        .map((f) => [String(f.id), f.activo === 1]),
    )
    if (ids.some((id) => !todas.has(id))) return null
    return [...new Set(ids)].filter((id) => todas.get(id))
  }
  const version = () =>
    Number(
      db
        .prepare("SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = 'catalogo'")
        .get(restauranteId)?.valor ?? 0,
    )
  const avisar = () => {
    alCambiar?.(version())
    cola.despertar()
  }

  // Todo lo de la pantalla «Cocina e impresoras».
  app.post('/api/cocina/configuracion', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['administrar_dispositivos'])) return reply
    const config = configCompleta(
      JSON.parse(
        String(
          db.prepare('SELECT config FROM restaurante WHERE id = ?').get(restauranteId)?.config ??
            '{}',
        ),
      ),
    )
    return {
      estaciones: estacionesActivas(),
      impresoras: db
        .prepare(
          'SELECT * FROM impresora WHERE restaurante_id = ? ORDER BY activo DESC, nombre, id',
        )
        .all(restauranteId)
        .map((f) => ({
          id: String(f.id),
          nombre: String(f.nombre),
          conexion: String(f.conexion),
          direccion: String(f.direccion),
          puerto: f.puerto === null ? null : Number(f.puerto),
          ancho: Number(f.ancho),
          pagina_codigos: String(f.pagina_codigos),
          respaldo_id: f.respaldo_id === null ? null : String(f.respaldo_id),
          estacion_ids: lista(f.estacion_ids),
          activo: f.activo === 1,
        })),
      estados: cola.estado(),
      pantallas: db
        .prepare(
          `SELECT d.id, d.nombre, d.estacion_ids, (SELECT max(ultimo_uso) FROM sesion s WHERE s.dispositivo_id = d.id) AS uso
           FROM dispositivo d WHERE d.restaurante_id = ? AND d.activo = 1 AND d.tipo = 'kds' AND d.revocado_en IS NULL
           ORDER BY d.nombre, d.id`,
        )
        .all(restauranteId)
        .map((f) => ({
          dispositivo_id: String(f.id),
          nombre: String(f.nombre),
          estacion_ids: lista(f.estacion_ids),
          ultimo_uso: f.uso === null ? null : String(f.uso),
        })),
      tiempos: { amarillo: config.cocina_amarillo_min, rojo: config.cocina_rojo_min },
      usar_cursos: config.usar_cursos,
      impresora_precuenta_id: config.impresora_precuenta_id,
    }
  })

  app.post('/api/impresoras', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ impresora: Impresora }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'Revisa los datos de la impresora')
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    const i = cuerpo.data.impresora
    if (i.conexion === 'red') {
      const problema = direccionValida(i.direccion, i.puerto, permitirLocales)
      if (problema) return datosInvalidos(reply, problema)
    }
    const estacionIds = estacionesDe(i.estacion_ids)
    if (!estacionIds) return datosInvalidos(reply, 'Esa estación no existe')
    const actual: Fila | undefined = i.id
      ? db
          .prepare('SELECT * FROM impresora WHERE restaurante_id = ? AND id = ?')
          .get(restauranteId, i.id)
      : undefined
    if (i.id && !actual) return datosInvalidos(reply, 'Esa impresora no existe')
    if (i.respaldo_id) {
      if (i.respaldo_id === i.id)
        return datosInvalidos(reply, 'Una impresora no puede ser su propio respaldo')
      const respaldo = db
        .prepare('SELECT activo FROM impresora WHERE restaurante_id = ? AND id = ?')
        .get(restauranteId, i.respaldo_id)
      if (respaldo?.activo !== 1) return datosInvalidos(reply, 'La impresora de respaldo no existe')
    }
    const campos = {
      nombre: i.nombre,
      conexion: i.conexion,
      direccion: i.direccion,
      puerto: i.conexion === 'red' ? (i.puerto ?? 9100) : null,
      ancho: i.ancho,
      pagina_codigos: i.pagina_codigos,
      respaldo_id: i.respaldo_id,
      estacion_ids: JSON.stringify(estacionIds),
      activo: i.activo ? 1 : 0,
    }
    const ahora = reloj()
    const id = enTransaccion(db, () => {
      if (actual) {
        actualizarVersionado(
          db,
          'impresora',
          restauranteId,
          String(actual.id),
          campos,
          autor,
          ahora,
        )
        // Archivar una impresora no deja a otra apuntándole como respaldo.
        if (!i.activo)
          for (const f of db
            .prepare('SELECT id FROM impresora WHERE restaurante_id = ? AND respaldo_id = ?')
            .all(restauranteId, String(actual.id)))
            actualizarVersionado(
              db,
              'impresora',
              restauranteId,
              String(f.id),
              { respaldo_id: null },
              autor,
              ahora,
            )
        return String(actual.id)
      }
      return insertarVersionado(db, 'impresora', restauranteId, campos, autor, ahora)
    })
    avisar()
    return reply.send({ id })
  })

  app.post('/api/impresoras/prueba', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ impresora_id: Id }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['administrar_dispositivos'])) return reply
    const impresora = db
      .prepare('SELECT * FROM impresora WHERE restaurante_id = ? AND id = ? AND activo = 1')
      .get(restauranteId, cuerpo.data.impresora_id)
    if (!impresora) return datosInvalidos(reply, 'Esa impresora no existe')
    const nombres = new Map(estacionesActivas().map((e) => [e.id, e.nombre]))
    const ahora = reloj()
    const contenido: PruebaImpresion = {
      impresora: String(impresora.nombre),
      estaciones: lista(impresora.estacion_ids).flatMap((e) => nombres.get(e) ?? []),
      hora: new Intl.DateTimeFormat('es-CO', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: zonaHoraria,
      }).format(new Date(ahora)),
    }
    const id = insertarTrabajo(db, restauranteId, String(impresora.id), contenido, ahora)
    cola.despertar()
    return reply.code(201).send({ trabajo_id: id })
  })

  // Lo que no ha salido, para la caja: ver por qué y descartar lo que ya no sirve.
  const PUEDE_COLA: Permiso[] = ['administrar_dispositivos', 'registrar_pago']

  app.post('/api/impresion/pendientes', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, PUEDE_COLA)) return reply
    return db
      .prepare(
        `SELECT t.id, t.tipo, t.contenido, t.intentos, t.ultimo_error, t.creado_en, i.nombre AS impresora
         FROM trabajo_impresion t JOIN impresora i ON i.id = t.impresora_id
         WHERE t.restaurante_id = ? AND t.estado = 'pendiente' ORDER BY t.creado_en, t.id LIMIT 200`,
      )
      .all(restauranteId)
      .map((f) => {
        const c = JSON.parse(String(f.contenido)) as {
          destino?: string
          estacion?: string
          numero?: number | null
        }
        return {
          id: String(f.id),
          impresora: String(f.impresora),
          que:
            f.tipo === 'prueba'
              ? 'Página de prueba'
              : f.tipo === 'precuenta'
                ? ['Precuenta', c.destino].filter(Boolean).join(' · ')
                : [c.estacion, c.destino, c.numero ? `#${c.numero}` : null]
                    .filter(Boolean)
                    .join(' · '),
          intentos: Number(f.intentos),
          error: f.ultimo_error === null ? null : String(f.ultimo_error),
          creado_en: String(f.creado_en),
        }
      })
  })

  app.post('/api/impresion/descartar', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ trabajo_id: Id }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    const autor = quien(req, reply, cuerpo.data, PUEDE_COLA)
    if (!autor) return reply
    const r = db
      .prepare(
        `UPDATE trabajo_impresion SET estado = 'descartado', terminado_en = ?, descartado_por_id = ?,
           descartado_dispositivo_id = ?
         WHERE restaurante_id = ? AND id = ? AND estado = 'pendiente'`,
      )
      .run(reloj(), autor.usuarioId, autor.dispositivoId, restauranteId, cuerpo.data.trabajo_id)
    if (Number(r.changes) === 0)
      return datosInvalidos(reply, 'Esa comanda ya salió o ya se descartó')
    cola.despertar()
    return reply.code(204).send()
  })

  // Convertir el equipo desde el que se pide en pantalla de cocina (ADR-015).
  app.post('/api/pantallas', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({
      nombre: z.string().max(100),
      estacion_ids: Estaciones,
    }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (esEquipoDelHub(req.ip))
      return datosInvalidos(
        reply,
        'Este es el PC de la caja, donde corre el sistema: no se convierte en pantalla. Hazlo desde la tablet de la cocina.',
      )
    const r = acceso.convertirEnPantalla(conexionDe(req) as Conexion, {
      sesionId: cuerpo.data.sesion_id,
      secreto: cuerpo.data.secreto,
      nombre: cuerpo.data.nombre,
      estacionIds: cuerpo.data.estacion_ids,
    })
    if (!r.ok)
      return reply
        .code(r.codigo === 'sin_permiso' ? 403 : r.codigo === 'datos_invalidos' ? 400 : 401)
        .send({ error: r.codigo, mensaje: r.mensaje })
    avisar()
    return reply.code(201).send({
      sesion_id: r.sesionId,
      secreto: r.secreto,
      usuario: r.usuario,
      permisos: r.permisos,
      tipo: 'kds',
    })
  })

  // Cambiar lo que muestra una pantalla, desde la caja.
  app.post('/api/pantallas/estaciones', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ dispositivo_id: Id, estacion_ids: Estaciones.min(1) }).safeParse(
      req.body,
    )
    if (!cuerpo.success) return datosInvalidos(reply, 'Elige al menos una estación')
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    const estacionIds = estacionesDe(cuerpo.data.estacion_ids)
    if (!estacionIds) return datosInvalidos(reply, 'Esa estación no existe')
    if (estacionIds.length === 0) return datosInvalidos(reply, 'Elige al menos una estación')
    const pantalla = db
      .prepare(
        "SELECT 1 FROM dispositivo WHERE restaurante_id = ? AND id = ? AND tipo = 'kds' AND activo = 1 AND revocado_en IS NULL",
      )
      .get(restauranteId, cuerpo.data.dispositivo_id)
    if (!pantalla) return datosInvalidos(reply, 'Esa pantalla no existe')
    actualizarVersionado(
      db,
      'dispositivo',
      restauranteId,
      cuerpo.data.dispositivo_id,
      { estacion_ids: JSON.stringify(estacionIds) },
      autor,
      reloj(),
    )
    avisar()
    return reply.code(204).send()
  })

  /**
   * Cambia campos de la configuración del restaurante (versionada: los equipos la leen con la
   * carta). Si no cambia nada, no escribe ni avisa.
   */
  const actualizarConfig = (
    cambios: Partial<ConfigRestaurante>,
    autor: { usuarioId: string; dispositivoId: string },
  ) => {
    const actual = JSON.parse(
      String(
        db.prepare('SELECT config FROM restaurante WHERE id = ?').get(restauranteId)?.config ??
          '{}',
      ),
    ) as Record<string, unknown>
    const antes = jsonCanonico(configCompleta(actual))
    const despues = jsonCanonico(configCompleta({ ...actual, ...cambios }))
    if (antes === despues) return
    actualizarVersionado(
      db,
      'restaurante',
      restauranteId,
      restauranteId,
      { config: despues },
      autor,
      reloj(),
    )
    avisar()
  }

  // Prender o apagar los cursos (entrada, fuerte, postre) en todo el restaurante.
  app.post('/api/cocina/cursos', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ usar: z.boolean() }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    actualizarConfig({ usar_cursos: cuerpo.data.usar }, autor)
    return reply.code(204).send()
  })

  // Minutos para el ámbar y el rojo de lo que se demora en cocina.
  app.post('/api/cocina/tiempos', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({
      amarillo: z.int().min(1).max(240),
      rojo: z.int().min(1).max(240),
    }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'Escribe minutos entre 1 y 240')
    if (cuerpo.data.rojo <= cuerpo.data.amarillo)
      return datosInvalidos(reply, '«Muy demorada» debe llegar después de «demorada»')
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    actualizarConfig(
      { cocina_amarillo_min: cuerpo.data.amarillo, cocina_rojo_min: cuerpo.data.rojo },
      autor,
    )
    return reply.code(204).send()
  })

  // ── Caja (tarea 1.6): impresora de precuentas, medios de pago y datáfonos ──

  // Dónde sale la precuenta; sin impresora, solo se ve en pantalla.
  app.post('/api/caja/precuenta', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ impresora_id: Id.nullable() }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    const id = cuerpo.data.impresora_id
    if (
      id &&
      !db
        .prepare('SELECT 1 FROM impresora WHERE restaurante_id = ? AND id = ? AND activo = 1')
        .get(restauranteId, id)
    )
      return datosInvalidos(reply, 'Esa impresora no existe o está archivada')
    actualizarConfig({ impresora_precuenta_id: id }, autor)
    return reply.code(204).send()
  })

  const datafonos = () =>
    db
      .prepare('SELECT * FROM datafono WHERE restaurante_id = ? ORDER BY activo DESC, nombre, id')
      .all(restauranteId)
      .map((f) => ({
        id: String(f.id),
        nombre: String(f.nombre),
        proveedor: String(f.proveedor),
        activo: f.activo === 1,
      }))

  // Lo de la pantalla «Caja y pagos».
  app.post('/api/caja/configuracion', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    if (!quien(req, reply, cuerpo.data, ['administrar_dispositivos'])) return reply
    const config = configCompleta(
      JSON.parse(
        String(
          db.prepare('SELECT config FROM restaurante WHERE id = ?').get(restauranteId)?.config ??
            '{}',
        ),
      ),
    )
    return {
      medios_pago: config.medios_pago,
      medios_propios: config.medios_propios,
      propina_sugerida: config.propina_sugerida,
      umbral_diferencia_caja: config.umbral_diferencia_caja,
      datafonos: datafonos(),
    }
  })

  app.post('/api/caja/medios', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ medios: z.array(MedioPago).min(1).max(10) }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply)
    const medios = [...new Set(cuerpo.data.medios)]
    if (medios.includes('otro'))
      return datosInvalidos(reply, 'Los medios propios se crean aparte, con su nombre')
    if (!medios.includes('efectivo')) return datosInvalidos(reply, 'El efectivo siempre se recibe')
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    actualizarConfig({ medios_pago: medios }, autor)
    return reply.code(204).send()
  })

  // Un medio propio del restaurante (Sodexo, QR del banco): crear, renombrar o archivar.
  app.post('/api/caja/medios-propios', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({
      medio: z.strictObject({
        id: Id.optional(),
        nombre: z.string().trim().min(1).max(30),
        activo: z.boolean(),
      }),
    }).safeParse(req.body)
    if (!cuerpo.success)
      return datosInvalidos(reply, 'Escribe el nombre del medio (hasta 30 letras)')
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    const actual = configCompleta(
      JSON.parse(
        String(
          db.prepare('SELECT config FROM restaurante WHERE id = ?').get(restauranteId)?.config ??
            '{}',
        ),
      ),
    )
    const m = cuerpo.data.medio
    if (m.id && !actual.medios_propios.some((x) => x.id === m.id))
      return datosInvalidos(reply, 'Ese medio no existe')
    const repetido = actual.medios_propios.some(
      (x) => x.activo && x.id !== m.id && x.nombre.toLowerCase() === m.nombre.toLowerCase(),
    )
    if (m.activo && repetido) return datosInvalidos(reply, 'Ya hay un medio con ese nombre')
    const id = m.id ?? nuevoId()
    const medios = m.id
      ? actual.medios_propios.map((x) =>
          x.id === id ? { id, nombre: m.nombre, activo: m.activo } : x,
        )
      : [...actual.medios_propios, { id, nombre: m.nombre, activo: m.activo }]
    if (medios.length > 20) return datosInvalidos(reply, 'Son máximo 20 medios propios')
    actualizarConfig({ medios_propios: medios }, autor)
    return { id, medios_propios: medios }
  })

  // El porcentaje de propina sugerida, en puntos básicos (1000 = 10 %). Tope del 10 % — (validar)
  // con el contador (Ley 1935 de 2018).
  app.post('/api/caja/propina', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ puntos: z.int().min(0).max(1000) }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'La propina sugerida va de 0 % a 10 %')
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    actualizarConfig({ propina_sugerida: cuerpo.data.puntos }, autor)
    return reply.code(204).send()
  })

  // Desde qué diferencia el cierre de caja pide justificación (tarea 1.7).
  app.post('/api/caja/umbral', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({ pesos: z.int().min(0).max(1_000_000) }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'Escribe un valor entre 0 y 1.000.000')
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    actualizarConfig({ umbral_diferencia_caja: cuerpo.data.pesos }, autor)
    return reply.code(204).send()
  })

  app.post('/api/datafonos', conEquipo, async (req, reply) => {
    const cuerpo = Sesion.extend({
      datafono: z.strictObject({
        id: Id.optional(),
        nombre: z.string().trim().min(1).max(60),
        proveedor: z.enum(['bold', 'redeban', 'credibanco', 'otro']),
        activo: z.boolean(),
      }),
    }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'Revisa los datos del datáfono')
    const autor = quien(req, reply, cuerpo.data, ['administrar_dispositivos'])
    if (!autor) return reply
    const d = cuerpo.data.datafono
    const repetido = db
      .prepare(
        'SELECT id FROM datafono WHERE restaurante_id = ? AND activo = 1 AND lower(nombre) = lower(?)',
      )
      .all(restauranteId, d.nombre)
      .some((f) => String(f.id) !== d.id)
    if (d.activo && repetido) return datosInvalidos(reply, 'Ya hay un datáfono con ese nombre')
    const campos = { nombre: d.nombre, proveedor: d.proveedor, activo: d.activo ? 1 : 0 }
    const id = enTransaccion(db, () => {
      if (!d.id) return insertarVersionado(db, 'datafono', restauranteId, campos, autor, reloj())
      const actual = db
        .prepare('SELECT id FROM datafono WHERE restaurante_id = ? AND id = ?')
        .get(restauranteId, d.id)
      if (!actual) return null
      actualizarVersionado(db, 'datafono', restauranteId, d.id, campos, autor, reloj())
      return d.id
    })
    if (!id) return datosInvalidos(reply, 'Ese datáfono no existe')
    avisar()
    return { id, datafonos: datafonos() }
  })
}

function insertarTrabajo(
  db: BaseSqlite,
  restauranteId: string,
  impresoraId: string,
  contenido: PruebaImpresion,
  ahora: string,
): string {
  const id = nuevoId()
  db.prepare(
    `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
     VALUES (?, ?, ?, 'prueba', ?, ?)`,
  ).run(id, restauranteId, impresoraId, JSON.stringify(contenido), ahora)
  return id
}
