import { createServer, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { readEscpos } from '@pos/printing'

// Una impresora de red de mentira: escucha como una térmica (puerto 9100, «RAW») y guarda lo que
// recibe. Sirve para las pruebas y para probar el hub sin papel:
//   pnpm --filter @pos/hub impresora-prueba        (puerto 9100)
//   pnpm --filter @pos/hub impresora-prueba 9101   (otro puerto, para una segunda impresora)
// Cada comanda que llega se muestra en la ventana como texto.

export interface ImpresoraDePrueba {
  port: number
  /** Lo recibido en cada conexión (una por trabajo). */
  received: Uint8Array[]
  /** Apagada deja de escuchar: el hub recibe «conexión rechazada», como con una real apagada. */
  apagar(yes: boolean): Promise<void>
  /** Espera a tener al menos `n` trabajos recibidos (lo recibido llega un instante después). */
  esperar(n: number): Promise<void>
  close(): Promise<void>
}

export function abrirImpresoraDePrueba(
  port = 0,
  alRecibir?: (bytes: Uint8Array) => void,
): Promise<ImpresoraDePrueba> {
  const received: Uint8Array[] = []
  const conexiones = new Set<Socket>()
  const servidor = createServer((socket) => {
    conexiones.add(socket)
    const parts: Buffer[] = []
    socket.on('data', (d) => parts.push(d))
    socket.on('end', () => {
      const bytes = new Uint8Array(Buffer.concat(parts))
      received.push(bytes)
      alRecibir?.(bytes)
      socket.end()
    })
    socket.on('error', () => {})
    socket.on('close', () => conexiones.delete(socket))
  })
  return new Promise((resolve, reject) => {
    servidor.once('error', reject)
    servidor.listen(port, '127.0.0.1', () => {
      const address = servidor.address()
      const real = typeof address === 'object' && address ? address.port : port
      resolve({
        port: real,
        received,
        apagar: (yes) =>
          new Promise((fin) => {
            if (yes) servidor.close(() => fin())
            else servidor.listen(real, '127.0.0.1', () => fin())
          }),
        esperar: async (n) => {
          const limit = Date.now() + 3000
          while (received.length < n && Date.now() < limit)
            await new Promise((r) => setTimeout(r, 10))
        },
        close: () =>
          new Promise((fin) => {
            for (const s of conexiones) s.destroy()
            if (servidor.listening) servidor.close(() => fin())
            else fin()
          }),
      })
    })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 9100)
  const printer = await abrirImpresoraDePrueba(port, (bytes) => {
    const { text } = readEscpos(bytes)
    console.log(`\n${text}\n`)
  })
  console.log(
    `Impresora de prueba lista en 127.0.0.1:${printer.port}. En «Cocina e impresoras» ponle la IP 127.0.0.1 y el puerto ${printer.port}.`,
  )
}
