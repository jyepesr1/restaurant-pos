import { existsSync } from 'node:fs'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { accessRoutes } from './access/routes'
import type { AccessService } from './access/service'
import { staffRoutes } from './access/staff-routes'
import { type CatalogOptions, catalogRoutes } from './catalog'
import { type DiagnosticsOptions, diagnosticsRoutes } from './diagnostics'
import { type PrintingOptions, printingRoutes } from './printing/routes'
import { reportRoutes } from './reports/routes'
import { type SyncOptions, syncRoutes } from './sync'

export interface ServerOptions {
  /** Folder with the built app (`apps/pos/dist`). Without it, the hub only exposes the API. */
  dirApp?: string
  /** Without this option the diagnostics routes are not exposed. */
  diagnostics?: DiagnosticsOptions
  /** Without this option pairing, sessions and authorizations are not exposed. */
  access?: AccessService
  /** Without this option there is no sync WebSocket. */
  sync?: SyncOptions
  /** Without this option the catalog is not served and staff is not managed. */
  catalog?: CatalogOptions
  /** Without this option there are no printers, ticket queue or kitchen screens (ADR-015). */
  printOptions?: PrintingOptions
  /** Database version, to show it in the health check. */
  dbVersion?: number
  logger?: boolean
}

export function createAppServer({
  dirApp,
  diagnostics,
  access,
  sync,
  catalog,
  printOptions,
  dbVersion,
  logger = false,
}: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger })
  // A batch is 100 events of a few hundred bytes: 1 MB is plenty and stops absurd messages.
  app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } })

  if (diagnostics) {
    app.register(diagnosticsRoutes, diagnostics)
  }
  if (access) {
    app.register(accessRoutes, { access })
  }
  if (sync) {
    app.register(syncRoutes, sync)
  }
  if (catalog) {
    app.register(catalogRoutes, catalog)
    app.register(staffRoutes, catalog)
  }
  if (printOptions) {
    app.register(printingRoutes, printOptions)
    app.register(reportRoutes, printOptions)
  }

  // An internal error is not shown to the device (it could carry SQL or PC paths): it stays in the
  // hub log and the device gets a clear message. Request errors (400, 413) keep their usual
  // response.
  app.setErrorHandler((error, req, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status < 500) return reply.send(error)
    req.log.error(error)
    return reply
      .code(500)
      .send({ error: 'internal', message: 'Algo falló en la caja. Intenta de nuevo.' })
  })

  // Each device checks health every few seconds: do not fill the log with that.
  app.get('/api/health', { logLevel: 'silent' }, async () => ({
    status: 'ok',
    service: 'hub',
    time: new Date().toISOString(),
    ...(dbVersion === undefined ? {} : { db_version: dbVersion }),
  }))

  if (dirApp && existsSync(dirApp)) {
    app.register(fastifyStatic, { root: dirApp })

    // The app is a single page: app routes return index.html. A file that does not exist
    // (e.g. a JS file from an earlier version) responds 404, not HTML.
    app.setNotFoundHandler((req, reply) => {
      const route = req.url.split('?')[0] ?? ''
      const isApi = route === '/api' || route.startsWith('/api/')
      const isFile = /\.[a-z0-9]+$/i.test(route)
      const isRead = req.method === 'GET' || req.method === 'HEAD'

      if (isRead && !isApi && !isFile) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'No encontrado' })
    })
  }

  return app
}
