import { Socket } from 'node:net'

// How the bytes reach the printer. Over the network it is a direct TCP connection to the printer's
// port (9100, "RAW"): open, write and close. USB goes through the Windows queue and comes with
// the installer (task 1.10).

export interface Target {
  connection: 'network' | 'usb'
  address: string
  port: number | null
}

export type Send = (target: Target, bytes: Uint8Array) => Promise<void>

export const PRINTER_PORT = 9100
const WAIT_MS = 5000

/** A printing failure in words for the register. */
export class PrinterError extends Error {}

const MESSAGES: Record<string, string> = {
  ECONNREFUSED: 'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
  EHOSTUNREACH: 'No se encuentra la impresora en la red: revisa el cable y que esté encendida.',
  ENETUNREACH: 'Este equipo no ve la red de la impresora: revisa el cable o el Wi-Fi de la caja.',
  ETIMEDOUT: 'La impresora no responde: revisa que esté encendida y con el cable de red.',
  ENOTFOUND: 'No existe esa dirección: revisa la IP de la impresora.',
  ECONNRESET: 'La impresora cortó la conexión: revisa que tenga papel y la tapa cerrada.',
  EPIPE: 'La impresora cortó la conexión: revisa que tenga papel y la tapa cerrada.',
}

/** Sends over TCP. Fails with `PrinterError` if it does not connect or finish within 5 s. */
export const sendOverNetwork: Send = (target, bytes) => {
  if (target.connection === 'usb')
    return Promise.reject(
      new PrinterError(
        'Las impresoras USB llegan con el programa de instalación para Windows: por ahora, conéctala con cable de red.',
      ),
    )
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    let finished = false
    const end = (error?: Error) => {
      if (finished) return
      finished = true
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.setTimeout(WAIT_MS, () => end(new PrinterError(MESSAGES.ETIMEDOUT)))
    socket.once('error', (e: NodeJS.ErrnoException) =>
      end(
        new PrinterError(
          MESSAGES[e.code ?? ''] ?? `La impresora no recibió la comanda (${e.code ?? e.message}).`,
        ),
      ),
    )
    socket.connect(target.port ?? PRINTER_PORT, target.address, () => {
      // Closed once writing finishes: the printer prints what it received.
      socket.end(Buffer.from(bytes), () => end())
    })
  })
}
