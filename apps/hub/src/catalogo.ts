import { configCompleta, jsonCanonico, MARCAS } from '@pos/core'
import type { BaseSqlite, Fila } from '@pos/db'
import type { Catalogo } from '@pos/sync'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { actualizarVersionado } from './acceso/registros'
import type { ServicioAcceso } from './acceso/servicio'
import {
  aplicarCambios,
  catalogoParaEditar,
  ErrorEdicion,
  PedidoEdicion,
  soloPrecios,
} from './edicion-catalogo'
import { ErrorFoto, guardarFoto, leerFoto, urlFoto } from './fotos'

// El catálogo y el salón para los dispositivos (lo activo de las tablas versionadas). En la Fase
// 1 se sincroniza por versión (`catalogo desde: N`, docs/SYNC.md#catálogo-y-configuración); por
// ahora se entrega entero: es pequeño.

const texto = (v: unknown) => String(v)
const numero = (v: unknown) => Number(v)

export function leerCatalogo(db: BaseSqlite, restauranteId: string): Catalogo {
  const todas = (sql: string): Fila[] => db.prepare(sql).all(restauranteId)
  const activos = (tabla: string, orden = 'orden, nombre') =>
    todas(`SELECT * FROM ${tabla} WHERE restaurante_id = ? AND activo = 1 ORDER BY ${orden}`)

  const version = numero(
    db
      .prepare("SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = 'catalogo'")
      .get(restauranteId)?.valor ?? 0,
  )
  const restaurante = db
    .prepare('SELECT nombre, config FROM restaurante WHERE id = ?')
    .get(restauranteId)
  const config = configCompleta(JSON.parse(String(restaurante?.config ?? '{}')))
  const impuestos = new Map(activos('impuesto', 'nombre').map((f) => [texto(f.id), f]))
  const variantes = activos('variante')
  const enlaces = activos('producto_grupo_modificador', 'orden')
  const grupos = new Map(activos('grupo_modificador', 'nombre').map((f) => [texto(f.id), f]))
  const modificadores = activos('modificador')
  const productos = activos('producto', 'nombre')
  const zonas = activos('zona', 'piso, orden, nombre')
  const idsZonas = new Set(zonas.map((f) => texto(f.id)))
  const listaJson = (v: unknown): string[] => {
    const lista = JSON.parse(String(v ?? '[]'))
    return Array.isArray(lista) ? lista.map(String) : []
  }
  const impresas = new Set(activos('impresora', 'nombre').flatMap((f) => listaJson(f.estacion_ids)))
  const pantallas = todas(
    `SELECT id, nombre, estacion_ids FROM dispositivo
     WHERE restaurante_id = ? AND activo = 1 AND tipo = 'kds' AND revocado_en IS NULL
     ORDER BY nombre, id`,
  ).map((f) => ({
    dispositivoId: texto(f.id),
    nombre: texto(f.nombre),
    estacionIds: listaJson(f.estacion_ids),
  }))

  return {
    version,
    restaurante: {
      nombre: texto(restaurante?.nombre ?? ''),
      sesionInactividadMin: config.sesion_inactividad_min,
      marca: config.marca,
      cocinaAmarilloMin: config.cocina_amarillo_min,
      cocinaRojoMin: config.cocina_rojo_min,
      usarCursos: config.usar_cursos,
      cobro: {
        mediosPago: config.medios_pago,
        mediosPropios: config.medios_propios
          .filter((m) => m.activo)
          .map(({ id, nombre }) => ({ id, nombre })),
        propinaSugerida: config.propina_sugerida,
        redondeoModo: config.redondeo_modo,
        redondeoEfectivo: config.redondeo_efectivo,
        redondeoEfectivoModo: config.redondeo_efectivo_modo,
        // Solo si la impresora elegida sigue activa.
        imprimePrecuenta:
          config.impresora_precuenta_id !== null &&
          todas('SELECT id FROM impresora WHERE restaurante_id = ? AND activo = 1').some(
            (f) => texto(f.id) === config.impresora_precuenta_id,
          ),
      },
    },
    datafonos: activos('datafono', 'nombre').map((f) => ({
      id: texto(f.id),
      nombre: texto(f.nombre),
    })),
    zonas: zonas.map((f) => ({ id: texto(f.id), nombre: texto(f.nombre), piso: numero(f.piso) })),
    mesas: activos('mesa', 'zona_id, y, x')
      .filter((f) => idsZonas.has(texto(f.zona_id)))
      .map((f) => ({
        id: texto(f.id),
        zonaId: texto(f.zona_id),
        nombre: texto(f.nombre),
        x: numero(f.x),
        y: numero(f.y),
        ancho: numero(f.ancho),
        alto: numero(f.alto),
        rotacion: numero(f.rotacion),
        forma: texto(f.forma) as Catalogo['mesas'][number]['forma'],
        capacidad: numero(f.capacidad),
      })),
    elementos: activos('elemento_plano', 'zona_id, version')
      .filter((f) => idsZonas.has(texto(f.zona_id)))
      .map((f) => ({
        id: texto(f.id),
        zonaId: texto(f.zona_id),
        tipo: texto(f.tipo) as Catalogo['elementos'][number]['tipo'],
        texto: f.texto === null ? null : texto(f.texto),
        x: numero(f.x),
        y: numero(f.y),
        ancho: numero(f.ancho),
        alto: numero(f.alto),
        rotacion: numero(f.rotacion),
      })),
    personal: activos('usuario', 'nombre')
      .filter((f) => f.pantalla !== 1)
      .map((f) => ({
        id: texto(f.id),
        nombre: texto(f.nombre),
      })),
    estaciones: activos('estacion').map((f) => ({
      id: texto(f.id),
      nombre: texto(f.nombre),
      imprime: impresas.has(texto(f.id)),
      pantalla: pantallas.some((p) => p.estacionIds.includes(texto(f.id))),
    })),
    pantallas,
    categorias: activos('categoria').map((c) => ({
      id: texto(c.id),
      nombre: texto(c.nombre),
      estacionId: c.estacion_id === null ? null : texto(c.estacion_id),
      productos: productos
        .filter((p) => p.categoria_id === c.id && impuestos.has(texto(p.impuesto_id)))
        .map((p) => {
          const impuesto = impuestos.get(texto(p.impuesto_id)) as Fila
          return {
            id: texto(p.id),
            nombre: texto(p.nombre),
            descripcion: p.descripcion === null ? null : texto(p.descripcion),
            favorito: p.favorito === 1,
            foto: urlFoto(p.foto),
            precio: numero(p.precio),
            impuesto: {
              tipo: texto(impuesto.tipo) as 'inc' | 'iva' | 'exento',
              tarifa: numero(impuesto.tarifa),
            },
            variantes: variantes
              .filter((v) => v.producto_id === p.id)
              .map((v) => ({ id: texto(v.id), nombre: texto(v.nombre), precio: numero(v.precio) })),
            grupos: enlaces
              .filter((e) => e.producto_id === p.id && grupos.has(texto(e.grupo_id)))
              .map((e) => {
                const g = grupos.get(texto(e.grupo_id)) as Fila
                return {
                  id: texto(g.id),
                  nombre: texto(g.nombre),
                  minimo: numero(g.minimo),
                  maximo: numero(g.maximo),
                  opciones: modificadores
                    .filter((m) => m.grupo_id === g.id)
                    .map((m) => ({
                      id: texto(m.id),
                      nombre: texto(m.nombre),
                      precioExtra: numero(m.precio_extra),
                    })),
                }
              }),
          }
        }),
    })),
  }
}

export interface OpcionesCatalogo {
  db: BaseSqlite
  restauranteId: string
  acceso: ServicioAcceso
  /** El catálogo cambió (lo editaron desde la caja): avisar a los equipos conectados. */
  alCambiar?: (version: number) => void
  /** Si una mesa tiene un pedido abierto (no se puede archivar). */
  mesaOcupada?: (mesaId: string) => boolean
  /** Carpeta de las fotos de los productos (`datos/fotos`). Sin ella no se suben ni se sirven. */
  dirFotos?: string
  reloj?: () => string
}

const SesionEdicion = z.strictObject({
  sesion_id: z.string().length(26),
  secreto: z.string().min(1).max(100),
})

/**
 * `GET /api/catalogo` (lo vigente, para tomar pedidos), `GET /api/catalogo/edicion` (todo, también
 * lo archivado, para el editor) y `POST /api/catalogo/cambios` (editar, con la sesión y el
 * permiso `editar_catalogo`, o `editar_precios` si solo cambian precios). Todo pide un equipo
 * emparejado.
 */
export async function rutasCatalogo(
  app: FastifyInstance,
  {
    db,
    restauranteId,
    acceso,
    alCambiar,
    mesaOcupada,
    dirFotos,
    reloj = () => new Date().toISOString(),
  }: OpcionesCatalogo,
) {
  const equipo = (req: FastifyRequest, reply: FastifyReply) => {
    const [esquema, token] = (req.headers.authorization ?? '').split(' ')
    const conexion = esquema === 'Bearer' && token ? acceso.autenticar(token) : null
    if (conexion && !conexion.revocadoEn) return conexion
    reply
      .code(401)
      .send({ error: 'token_invalido', mensaje: 'Este equipo ya no tiene acceso: vuelve a entrar' })
    return null
  }

  app.get('/api/catalogo', async (req, reply) => {
    if (!equipo(req, reply)) return reply
    return leerCatalogo(db, restauranteId)
  })

  app.get('/api/catalogo/edicion', async (req, reply) => {
    if (!equipo(req, reply)) return reply
    return catalogoParaEditar(db, restauranteId)
  })

  app.post('/api/catalogo/cambios', async (req, reply) => {
    const conexion = equipo(req, reply)
    if (!conexion) return reply
    const cuerpo = PedidoEdicion.merge(SesionEdicion).safeParse(req.body)
    if (!cuerpo.success)
      return reply
        .code(400)
        .send({ error: 'datos_invalidos', mensaje: 'Datos con formato inesperado' })
    const { sesion_id, secreto, cambios } = cuerpo.data
    const permiso = soloPrecios(db, restauranteId, cambios) ? 'editar_precios' : 'editar_catalogo'
    let quien = acceso.usuarioConPermiso(conexion, { sesionId: sesion_id, secreto }, permiso)
    // Quien edita el catálogo también puede cambiar precios.
    if (!quien.ok && quien.codigo === 'sin_permiso' && permiso === 'editar_precios')
      quien = acceso.usuarioConPermiso(
        conexion,
        { sesionId: sesion_id, secreto },
        'editar_catalogo',
      )
    if (!quien.ok) {
      const estado = quien.codigo === 'sin_permiso' ? 403 : 401
      return reply.code(estado).send({ error: quien.codigo, mensaje: quien.mensaje })
    }
    try {
      const { version, cambiados } = aplicarCambios(
        db,
        restauranteId,
        cambios,
        { usuarioId: quien.usuarioId, dispositivoId: conexion.dispositivoId },
        reloj(),
        mesaOcupada,
      )
      if (cambiados > 0) alCambiar?.(version)
      return reply.code(200).send({ version, cambiados })
    } catch (error) {
      if (error instanceof ErrorEdicion)
        return reply.code(400).send({ error: 'datos_invalidos', mensaje: error.message })
      throw error
    }
  })

  /** Quién hace el cambio, con su sesión y ese permiso; si no, responde el error. */
  const conPermiso = (
    req: FastifyRequest,
    reply: FastifyReply,
    cuerpo: { sesion_id: string; secreto: string },
    permiso: 'editar_catalogo' | 'administrar_usuarios',
  ) => {
    const conexion = equipo(req, reply)
    if (!conexion) return null
    const quien = acceso.usuarioConPermiso(
      conexion,
      { sesionId: cuerpo.sesion_id, secreto: cuerpo.secreto },
      permiso,
    )
    if (!quien.ok) {
      reply
        .code(quien.codigo === 'sin_permiso' ? 403 : 401)
        .send({ error: quien.codigo, mensaje: quien.mensaje })
      return null
    }
    return { usuarioId: quien.usuarioId, dispositivoId: conexion.dispositivoId }
  }
  const versionActual = () =>
    Number(
      db
        .prepare("SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = 'catalogo'")
        .get(restauranteId)?.valor ?? 0,
    )
  const datosInvalidos = (reply: FastifyReply, mensaje = 'Datos con formato inesperado') =>
    reply.code(400).send({ error: 'datos_invalidos', mensaje })

  // La marca con que se ve el POS en todos los equipos (tarea 1.3c).
  // El equipo se comprueba antes de leer el cuerpo: sin token no se recibe ni se valida nada.
  const conEquipo = {
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!equipo(req, reply)) return reply
    },
  }

  app.post('/api/restaurante/marca', conEquipo, async (req, reply) => {
    const cuerpo = SesionEdicion.extend({ marca: z.enum(MARCAS) }).safeParse(req.body)
    if (!cuerpo.success) return datosInvalidos(reply, 'Esa marca no existe')
    const autor = conPermiso(req, reply, cuerpo.data, 'administrar_usuarios')
    if (!autor) return reply
    const fila = db.prepare('SELECT config FROM restaurante WHERE id = ?').get(restauranteId)
    const actual = JSON.parse(String(fila?.config ?? '{}')) as Record<string, unknown>
    if (actual.marca !== cuerpo.data.marca) {
      actualizarVersionado(
        db,
        'restaurante',
        restauranteId,
        restauranteId,
        { config: jsonCanonico(configCompleta({ ...actual, marca: cuerpo.data.marca })) },
        autor,
        reloj(),
      )
      alCambiar?.(versionActual())
    }
    return reply.send({ marca: cuerpo.data.marca })
  })

  if (!dirFotos) return

  // Subir o quitar la foto de un producto, con el permiso de editar la carta.
  app.post(
    '/api/catalogo/fotos',
    { ...conEquipo, bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const cuerpo = SesionEdicion.extend({
        producto_id: z.string().length(26),
        imagen: z.string().max(1_500_000).nullable(),
      }).safeParse(req.body)
      if (!cuerpo.success) return datosInvalidos(reply)
      const autor = conPermiso(req, reply, cuerpo.data, 'editar_catalogo')
      if (!autor) return reply
      const producto = db
        .prepare('SELECT foto FROM producto WHERE restaurante_id = ? AND id = ?')
        .get(restauranteId, cuerpo.data.producto_id)
      if (!producto) return datosInvalidos(reply, 'Ese producto no existe')
      let nombre: string | null = null
      try {
        nombre = cuerpo.data.imagen === null ? null : guardarFoto(dirFotos, cuerpo.data.imagen)
      } catch (e) {
        if (e instanceof ErrorFoto) return datosInvalidos(reply, e.message)
        throw e
      }
      if (producto.foto !== nombre) {
        actualizarVersionado(
          db,
          'producto',
          restauranteId,
          cuerpo.data.producto_id,
          { foto: nombre },
          autor,
          reloj(),
        )
        alCambiar?.(versionActual())
      }
      return reply.send({ foto: urlFoto(nombre) })
    },
  )

  // Las fotos son de la carta, no de nadie: se sirven sin token (una <img> no lo puede mandar) y
  // nunca cambian, porque su nombre es la huella de su contenido.
  app.get<{ Params: { nombre: string } }>('/fotos/:nombre', async (req, reply) => {
    const foto = leerFoto(dirFotos, req.params.nombre)
    if (!foto) return reply.code(404).send({ error: 'No encontrado' })
    return reply
      .header('content-type', foto.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(foto.bytes)
  })
}
