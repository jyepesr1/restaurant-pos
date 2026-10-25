import { existsSync } from 'node:fs'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { rutasAcceso } from './acceso/rutas'
import type { ServicioAcceso } from './acceso/servicio'
import { type OpcionesCatalogo, rutasCatalogo } from './catalogo'
import { type OpcionesDiagnostico, rutasDiagnostico } from './diagnostico'
import { type OpcionesSincronizacion, rutasSincronizacion } from './sincronizacion'

export interface OpcionesServidor {
  /** Carpeta con la app compilada (`apps/pos/dist`). Sin ella, el hub solo expone la API. */
  dirApp?: string
  /** Sin esta opción no se exponen las rutas de diagnóstico. */
  diagnostico?: OpcionesDiagnostico
  /** Sin esta opción no se exponen emparejamiento, sesiones ni autorizaciones. */
  acceso?: ServicioAcceso
  /** Sin esta opción no hay WebSocket de sincronización. */
  sincronizacion?: OpcionesSincronizacion
  /** Sin esta opción no se entrega el catálogo. */
  catalogo?: OpcionesCatalogo
  /** Versión de la base, para mostrarla en el chequeo de salud. */
  versionBase?: number
  logger?: boolean
}

export function crearServidor({
  dirApp,
  diagnostico,
  acceso,
  sincronizacion,
  catalogo,
  versionBase,
  logger = false,
}: OpcionesServidor = {}): FastifyInstance {
  const app = Fastify({ logger })
  // Un lote son 100 eventos de pocos cientos de bytes: 1 MB sobra y frena mensajes absurdos.
  app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } })

  if (diagnostico) {
    app.register(rutasDiagnostico, diagnostico)
  }
  if (acceso) {
    app.register(rutasAcceso, { acceso })
  }
  if (sincronizacion) {
    app.register(rutasSincronizacion, sincronizacion)
  }
  if (catalogo) {
    app.register(rutasCatalogo, catalogo)
  }

  // Cada dispositivo consulta la salud cada pocos segundos: no llenar el log con eso.
  app.get('/api/salud', { logLevel: 'silent' }, async () => ({
    estado: 'ok',
    servicio: 'hub',
    hora: new Date().toISOString(),
    ...(versionBase === undefined ? {} : { version_base: versionBase }),
  }))

  if (dirApp && existsSync(dirApp)) {
    app.register(fastifyStatic, { root: dirApp })

    // La app es de una sola página: las rutas de la app devuelven index.html. Un archivo
    // que no existe (p. ej. un JS de una versión anterior) responde 404, no HTML.
    app.setNotFoundHandler((req, reply) => {
      const ruta = req.url.split('?')[0] ?? ''
      const esApi = ruta === '/api' || ruta.startsWith('/api/')
      const esArchivo = /\.[a-z0-9]+$/i.test(ruta)
      const esLectura = req.method === 'GET' || req.method === 'HEAD'

      if (esLectura && !esApi && !esArchivo) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'No encontrado' })
    })
  }

  return app
}
