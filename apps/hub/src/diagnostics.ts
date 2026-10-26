import { appendFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'

export interface DiagnosticsOptions {
  /** Folder where the results sent by devices are stored. */
  dataDir: string
  /** How often the hub sends a heartbeat over WebSocket. */
  heartbeatIntervalMs?: number
  /** Maximum size of the results file, so the register PC's disk does not fill up. */
  byteLimit?: number
}

export const DIAGNOSTICS_FILE = 'diagnostics.jsonl'

/**
 * Routes for device diagnostics: they measure whether a phone keeps its connection
 * to the hub (WebSocket with heartbeats and latency echo) and store the results.
 * Requires `@fastify/websocket` to be registered first.
 */
export async function diagnosticsRoutes(
  app: FastifyInstance,
  { dataDir, heartbeatIntervalMs = 5000, byteLimit = 5 * 1024 * 1024 }: DiagnosticsOptions,
) {
  app.get('/api/diagnostics/ws', { websocket: true }, (socket) => {
    let heartbeats = 0
    const heartbeat = setInterval(
      () => socket.send(`heartbeat:${++heartbeats}`),
      heartbeatIntervalMs,
    )

    // Minimal text protocol: "ping:<mark>" is answered with "pong:<mark>".
    socket.on('message', (message) => {
      const text = message.toString()
      if (text.startsWith('ping:')) socket.send(`pong:${text.slice('ping:'.length)}`)
    })
    socket.on('close', () => clearInterval(heartbeat))
  })

  app.post('/api/diagnostics', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const data = req.body
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return reply.code(400).send({ error: 'Se esperaba un objeto JSON' })
    }

    const file = join(dataDir, DIAGNOSTICS_FILE)
    const size = await stat(file).then(
      (info) => info.size,
      () => 0,
    )
    if (size >= byteLimit) {
      return reply.code(507).send({ error: 'Se llenó el espacio para diagnósticos en el hub' })
    }

    await mkdir(dataDir, { recursive: true })
    const entry = { receivedAt: new Date().toISOString(), ip: req.ip, data }
    await appendFile(file, `${JSON.stringify(entry)}\n`)
    req.log.info({ ip: req.ip }, 'Diagnóstico recibido')

    return { saved: true }
  })
}
