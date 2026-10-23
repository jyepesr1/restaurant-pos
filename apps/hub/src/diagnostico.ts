import { appendFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'

export interface OpcionesDiagnostico {
  /** Carpeta donde se guardan los resultados que envían los dispositivos. */
  dirDatos: string
  /** Cada cuánto el hub envía un latido por WebSocket. */
  intervaloLatidoMs?: number
  /** Tamaño máximo del archivo de resultados, para no llenar el disco del PC de caja. */
  limiteBytes?: number
}

export const ARCHIVO_DIAGNOSTICOS = 'diagnosticos.jsonl'

/**
 * Rutas para el diagnóstico del dispositivo: miden si un celular mantiene la conexión
 * con el hub (WebSocket con latidos y eco de latencia) y guardan los resultados.
 * Requiere que `@fastify/websocket` esté registrado antes.
 */
export async function rutasDiagnostico(
  app: FastifyInstance,
  { dirDatos, intervaloLatidoMs = 5000, limiteBytes = 5 * 1024 * 1024 }: OpcionesDiagnostico,
) {
  app.get('/api/diagnostico/ws', { websocket: true }, (socket) => {
    let latidos = 0
    const latido = setInterval(() => socket.send(`latido:${++latidos}`), intervaloLatidoMs)

    // Protocolo de texto mínimo: "ping:<marca>" se responde con "pong:<marca>".
    socket.on('message', (mensaje) => {
      const texto = mensaje.toString()
      if (texto.startsWith('ping:')) socket.send(`pong:${texto.slice('ping:'.length)}`)
    })
    socket.on('close', () => clearInterval(latido))
  })

  app.post('/api/diagnostico', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const datos = req.body
    if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) {
      return reply.code(400).send({ error: 'Se esperaba un objeto JSON' })
    }

    const archivo = join(dirDatos, ARCHIVO_DIAGNOSTICOS)
    const tamano = await stat(archivo).then(
      (info) => info.size,
      () => 0,
    )
    if (tamano >= limiteBytes) {
      return reply.code(507).send({ error: 'Se llenó el espacio para diagnósticos en el hub' })
    }

    await mkdir(dirDatos, { recursive: true })
    const registro = { recibidoEn: new Date().toISOString(), ip: req.ip, datos }
    await appendFile(archivo, `${JSON.stringify(registro)}\n`)
    req.log.info({ ip: req.ip }, 'Diagnóstico recibido')

    return { guardado: true }
  })
}
