import type { SalaSync } from '@pos/sync'
import type { FastifyInstance } from 'fastify'

// WebSocket de sincronización (docs/SYNC.md#mensajes-por-websocket): cada conexión es un
// participante de la sala. Los mensajes van en JSON; lo que no se entiende lo responde la sala
// con un error, no tumba la conexión.

export interface OpcionesSincronizacion {
  sala: SalaSync
  /** Cada cuánto la sala manda un latido a los conectados (docs/SYNC.md: 5 s). */
  intervaloLatidoMs?: number
  /** Una conexión que no dice nada en este tiempo se cierra: no ocupa un lugar sin saludar. */
  esperaSaludoMs?: number
  alFallo?: (error: unknown) => void
}

const ABIERTO = 1

export async function rutasSincronizacion(
  app: FastifyInstance,
  { sala, intervaloLatidoMs = 5000, esperaSaludoMs = 10_000, alFallo }: OpcionesSincronizacion,
) {
  const latido = setInterval(() => sala.latir(), intervaloLatidoMs)
  app.addHook('onClose', async () => clearInterval(latido))

  app.get('/api/sync/ws', { websocket: true }, (socket) => {
    const enlace = sala.conectar((mensaje) => {
      if (socket.readyState === ABIERTO) socket.send(JSON.stringify(mensaje))
    })
    const sinSaludo = setTimeout(() => socket.close(1008, 'Sin saludo'), esperaSaludoMs)
    socket.on('message', (datos) => {
      clearTimeout(sinSaludo)
      let crudo: unknown = null
      try {
        crudo = JSON.parse(datos.toString())
      } catch {
        // La sala responde "mensaje_invalido" a lo que no es un mensaje.
      }
      try {
        enlace.recibir(crudo)
      } catch (error) {
        // El almacén del hub no responde (HubSync ya rechazó lo que era culpa de un evento): se
        // corta esta conexión; el dispositivo reconecta y reenvía.
        alFallo?.(error)
        socket.close(1011, 'Error del hub')
      }
    })
    socket.on('close', () => {
      clearTimeout(sinSaludo)
      enlace.cerrar()
    })
  })
}
