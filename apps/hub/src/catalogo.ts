import { configCompleta } from '@pos/core'
import type { BaseSqlite, Fila } from '@pos/db'
import type { Catalogo } from '@pos/sync'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ServicioAcceso } from './acceso/servicio'
import {
  aplicarCambios,
  catalogoParaEditar,
  ErrorEdicion,
  PedidoEdicion,
  soloPrecios,
} from './edicion-catalogo'

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

  return {
    version,
    restaurante: {
      nombre: texto(restaurante?.nombre ?? ''),
      sesionInactividadMin: config.sesion_inactividad_min,
    },
    zonas: activos('zona').map((f) => ({ id: texto(f.id), nombre: texto(f.nombre) })),
    mesas: activos('mesa', 'zona_id, y, x').map((f) => ({
      id: texto(f.id),
      zonaId: texto(f.zona_id),
      nombre: texto(f.nombre),
      x: numero(f.x),
      y: numero(f.y),
      forma: texto(f.forma),
      capacidad: numero(f.capacidad),
    })),
    estaciones: activos('estacion').map((f) => ({ id: texto(f.id), nombre: texto(f.nombre) })),
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
    reloj = () => new Date().toISOString(),
  }: OpcionesCatalogo,
) {
  const equipo = (req: FastifyRequest, reply: FastifyReply) => {
    const [esquema, token] = (req.headers.authorization ?? '').split(' ')
    const conexion = esquema === 'Bearer' && token ? acceso.autenticar(token) : null
    if (conexion && !conexion.revocadoEn) return conexion
    reply.code(401).send({ error: 'token_invalido', mensaje: 'Este equipo no está emparejado' })
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
      )
      if (cambiados > 0) alCambiar?.(version)
      return reply.code(200).send({ version, cambiados })
    } catch (error) {
      if (error instanceof ErrorEdicion)
        return reply.code(400).send({ error: 'datos_invalidos', mensaje: error.message })
      throw error
    }
  })
}
