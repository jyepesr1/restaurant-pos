import { Socket } from 'node:net'

// Cómo llegan los bytes a la impresora. Por red es una conexión TCP directa al puerto de la
// impresora (9100, «RAW»): se abre, se escribe y se cierra. USB va por la cola de Windows y
// llega con el instalador (tarea 1.10).

export interface Destino {
  connection: 'network' | 'usb'
  address: string
  port: number | null
}

export type Enviar = (target: Destino, bytes: Uint8Array) => Promise<void>

export const PUERTO_IMPRESORA = 9100
const ESPERA_MS = 5000

/** Un fallo de impresión en palabras para la caja. */
export class ErrorImpresora extends Error {}

const MENSAJES: Record<string, string> = {
  ECONNREFUSED: 'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
  EHOSTUNREACH: 'No se encuentra la impresora en la red: revisa el cable y que esté encendida.',
  ENETUNREACH: 'Este equipo no ve la red de la impresora: revisa el cable o el Wi-Fi de la caja.',
  ETIMEDOUT: 'La impresora no responde: revisa que esté encendida y con el cable de red.',
  ENOTFOUND: 'No existe esa dirección: revisa la IP de la impresora.',
  ECONNRESET: 'La impresora cortó la conexión: revisa que tenga papel y la tapa cerrada.',
  EPIPE: 'La impresora cortó la conexión: revisa que tenga papel y la tapa cerrada.',
}

/** Envía por TCP. Falla con `ErrorImpresora` si no conecta o no termina en 5 s. */
export const enviarPorRed: Enviar = (target, bytes) => {
  if (target.connection === 'usb')
    return Promise.reject(
      new ErrorImpresora(
        'Las impresoras USB llegan con el programa de instalación para Windows: por ahora, conéctala con cable de red.',
      ),
    )
  return new Promise((resolver, reject) => {
    const socket = new Socket()
    let terminado = false
    const fin = (error?: Error) => {
      if (terminado) return
      terminado = true
      socket.destroy()
      if (error) reject(error)
      else resolver()
    }
    socket.setTimeout(ESPERA_MS, () => fin(new ErrorImpresora(MENSAJES.ETIMEDOUT)))
    socket.once('error', (e: NodeJS.ErrnoException) =>
      fin(
        new ErrorImpresora(
          MENSAJES[e.code ?? ''] ?? `La impresora no recibió la comanda (${e.code ?? e.message}).`,
        ),
      ),
    )
    socket.connect(target.port ?? PUERTO_IMPRESORA, target.address, () => {
      // Se cierra al terminar de escribir: la impresora imprime lo que recibió.
      socket.end(Buffer.from(bytes), () => fin())
    })
  })
}
