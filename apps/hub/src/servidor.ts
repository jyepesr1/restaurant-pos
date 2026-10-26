import { existsSync } from 'node:fs'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { rutasAcceso } from './acceso/rutas'
import { rutasPersonal } from './acceso/rutas-personal'
import type { ServicioAcceso } from './acceso/servicio'
import { type OpcionesCatalogo, rutasCatalogo } from './catalogo'
import { type OpcionesDiagnostico, rutasDiagnostico } from './diagnostico'
import { type OpcionesImpresion, rutasImpresion } from './impresion/rutas'
import { rutasReportes } from './reportes/rutas'
import { type OpcionesSincronizacion, rutasSincronizacion } from './sincronizacion'

export interface OpcionesServidor {
  /** Carpeta con la app compilada (`apps/pos/dist`). Sin ella, el hub solo expone la API. */
  dirApp?: string
  /** Sin esta opción no se exponen las rutas de diagnóstico. */
  diagnostico?: OpcionesDiagnostico
  /** Sin esta opción no se exponen emparejamiento, sesiones ni autorizaciones. */
  access?: ServicioAcceso
  /** Sin esta opción no hay WebSocket de sincronización. */
  sincronizacion?: OpcionesSincronizacion
  /** Sin esta opción no se entrega el catálogo ni se administra el personal. */
  catalog?: OpcionesCatalogo
  /** Sin esta opción no hay impresoras, cola de comandas ni pantallas de cocina (ADR-015). */
  impresion?: OpcionesImpresion
  /** Versión de la base, para mostrarla en el chequeo de salud. */
  versionBase?: number
  logger?: boolean
}

export function crearServidor({
  dirApp,
  diagnostico,
  access,
  sincronizacion,
  catalog,
  impresion,
  versionBase,
  logger = false,
}: OpcionesServidor = {}): FastifyInstance {
  const app = Fastify({ logger })
  // Un lote son 100 eventos de pocos cientos de bytes: 1 MB sobra y frena mensajes absurdos.
  app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } })

  if (diagnostico) {
    app.register(rutasDiagnostico, diagnostico)
  }
  if (access) {
    app.register(rutasAcceso, { access })
  }
  if (sincronizacion) {
    app.register(rutasSincronizacion, sincronizacion)
  }
  if (catalog) {
    app.register(rutasCatalogo, catalog)
    app.register(rutasPersonal, catalog)
  }
  if (impresion) {
    app.register(rutasImpresion, impresion)
    app.register(rutasReportes, impresion)
  }

  // Un error interno no se le muestra al equipo (podría llevar SQL o rutas del PC): queda en el
  // log del hub y el equipo recibe un mensaje claro. Los errores de la petición (400, 413) siguen
  // con su respuesta de siempre.
  app.setErrorHandler((error, req, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status < 500) return reply.send(error)
    req.log.error(error)
    return reply
      .code(500)
      .send({ error: 'internal', message: 'Algo falló en la caja. Intenta de nuevo.' })
  })

  // Cada dispositivo consulta la salud cada pocos segundos: no llenar el log con eso.
  app.get('/api/health', { logLevel: 'silent' }, async () => ({
    status: 'ok',
    service: 'hub',
    time: new Date().toISOString(),
    ...(versionBase === undefined ? {} : { version_base: versionBase }),
  }))

  if (dirApp && existsSync(dirApp)) {
    app.register(fastifyStatic, { root: dirApp })

    // La app es de una sola página: las rutas de la app devuelven index.html. Un archivo
    // que no existe (p. ej. un JS de una versión anterior) responde 404, no HTML.
    app.setNotFoundHandler((req, reply) => {
      const route = req.url.split('?')[0] ?? ''
      const esApi = route === '/api' || route.startsWith('/api/')
      const esArchivo = /\.[a-z0-9]+$/i.test(route)
      const esLectura = req.method === 'GET' || req.method === 'HEAD'

      if (esLectura && !esApi && !esArchivo) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'No encontrado' })
    })
  }

  return app
}
