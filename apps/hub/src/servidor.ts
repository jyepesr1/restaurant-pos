import { existsSync } from 'node:fs'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { type OpcionesDiagnostico, rutasDiagnostico } from './diagnostico'

export interface OpcionesServidor {
  /** Carpeta con la app compilada (`apps/pos/dist`). Sin ella, el hub solo expone la API. */
  dirApp?: string
  /** Sin esta opción no se exponen las rutas de diagnóstico. */
  diagnostico?: OpcionesDiagnostico
  logger?: boolean
}

export function crearServidor({
  dirApp,
  diagnostico,
  logger = false,
}: OpcionesServidor = {}): FastifyInstance {
  const app = Fastify({ logger })
  app.register(fastifyWebsocket)

  if (diagnostico) {
    app.register(rutasDiagnostico, diagnostico)
  }

  // Cada dispositivo consulta la salud cada pocos segundos: no llenar el log con eso.
  app.get('/api/salud', { logLevel: 'silent' }, async () => ({
    estado: 'ok',
    servicio: 'hub',
    hora: new Date().toISOString(),
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
