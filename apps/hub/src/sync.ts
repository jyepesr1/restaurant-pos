import type { FloorSync } from '@pos/sync'
import type { FastifyInstance } from 'fastify'

// Sync WebSocket (docs/SYNC.md#mensajes-por-websocket): each connection is a participant of the
// floor. Messages are JSON; whatever is not understood gets an error reply from the floor, it
// does not drop the connection.

export interface SyncOptions {
  floor: FloorSync
  /** How often the floor sends a heartbeat to those connected (docs/SYNC.md: 5 s). */
  heartbeatIntervalMs?: number
  /** A connection that says nothing in this time is closed: no slot without a hello. */
  helloWaitMs?: number
  onFailure?: (error: unknown) => void
}

const OPEN = 1

export async function syncRoutes(
  app: FastifyInstance,
  { floor, heartbeatIntervalMs = 5000, helloWaitMs = 10_000, onFailure }: SyncOptions,
) {
  const heartbeat = setInterval(() => floor.beat(), heartbeatIntervalMs)
  app.addHook('onClose', async () => clearInterval(heartbeat))

  app.get('/api/sync/ws', { websocket: true }, (socket) => {
    const link = floor.connect((message) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(message))
    })
    const helloTimeout = setTimeout(() => socket.close(1008, 'Sin saludo'), helloWaitMs)
    socket.on('message', (data) => {
      clearTimeout(helloTimeout)
      let raw: unknown = null
      try {
        raw = JSON.parse(data.toString())
      } catch {
        // The floor replies "invalid_message" to anything that is not a message.
      }
      try {
        link.receive(raw)
      } catch (error) {
        // The hub store is not responding (HubSync already rejected what was an event's fault):
        // this connection is cut; the device reconnects and resends.
        onFailure?.(error)
        socket.close(1011, 'Error del hub')
      }
    })
    socket.on('close', () => {
      clearTimeout(helloTimeout)
      link.close()
    })
  })
}
