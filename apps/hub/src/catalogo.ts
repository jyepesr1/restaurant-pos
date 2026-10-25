import { configCompleta } from '@pos/core'
import type { BaseSqlite, Fila } from '@pos/db'
import type { Catalogo } from '@pos/sync'
import type { FastifyInstance } from 'fastify'
import type { ServicioAcceso } from './acceso/servicio'

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
}

/** `GET /api/catalogo`, solo para dispositivos emparejados. */
export async function rutasCatalogo(
  app: FastifyInstance,
  { db, restauranteId, acceso }: OpcionesCatalogo,
) {
  app.get('/api/catalogo', async (req, reply) => {
    const [esquema, token] = (req.headers.authorization ?? '').split(' ')
    const conexion = esquema === 'Bearer' && token ? acceso.autenticar(token) : null
    if (!conexion || conexion.revocadoEn)
      return reply
        .code(401)
        .send({ error: 'token_invalido', mensaje: 'Este equipo no está emparejado' })
    return leerCatalogo(db, restauranteId)
  })
}
