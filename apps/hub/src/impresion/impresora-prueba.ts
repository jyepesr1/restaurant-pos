import { createServer, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { leerEscpos } from '@pos/printing'

// Una impresora de red de mentira: escucha como una térmica (puerto 9100, «RAW») y guarda lo que
// recibe. Sirve para las pruebas y para probar el hub sin papel:
//   pnpm --filter @pos/hub impresora-prueba        (puerto 9100)
//   pnpm --filter @pos/hub impresora-prueba 9101   (otro puerto, para una segunda impresora)
// Cada comanda que llega se muestra en la ventana como texto.

export interface ImpresoraDePrueba {
  puerto: number
  /** Lo recibido en cada conexión (una por trabajo). */
  recibidos: Uint8Array[]
  /** Apagada deja de escuchar: el hub recibe «conexión rechazada», como con una real apagada. */
  apagar(si: boolean): Promise<void>
  /** Espera a tener al menos `n` trabajos recibidos (lo recibido llega un instante después). */
  esperar(n: number): Promise<void>
  cerrar(): Promise<void>
}

export function abrirImpresoraDePrueba(
  puerto = 0,
  alRecibir?: (bytes: Uint8Array) => void,
): Promise<ImpresoraDePrueba> {
  const recibidos: Uint8Array[] = []
  const conexiones = new Set<Socket>()
  const servidor = createServer((socket) => {
    conexiones.add(socket)
    const partes: Buffer[] = []
    socket.on('data', (d) => partes.push(d))
    socket.on('end', () => {
      const bytes = new Uint8Array(Buffer.concat(partes))
      recibidos.push(bytes)
      alRecibir?.(bytes)
      socket.end()
    })
    socket.on('error', () => {})
    socket.on('close', () => conexiones.delete(socket))
  })
  return new Promise((resolver, rechazar) => {
    servidor.once('error', rechazar)
    servidor.listen(puerto, '127.0.0.1', () => {
      const direccion = servidor.address()
      const real = typeof direccion === 'object' && direccion ? direccion.port : puerto
      resolver({
        puerto: real,
        recibidos,
        apagar: (si) =>
          new Promise((fin) => {
            if (si) servidor.close(() => fin())
            else servidor.listen(real, '127.0.0.1', () => fin())
          }),
        esperar: async (n) => {
          const limite = Date.now() + 3000
          while (recibidos.length < n && Date.now() < limite)
            await new Promise((r) => setTimeout(r, 10))
        },
        cerrar: () =>
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
  const puerto = Number(process.argv[2] ?? 9100)
  const impresora = await abrirImpresoraDePrueba(puerto, (bytes) => {
    const { texto } = leerEscpos(bytes)
    console.log(`\n${texto}\n`)
  })
  console.log(
    `Impresora de prueba lista en 127.0.0.1:${impresora.puerto}. En «Cocina e impresoras» ponle la IP 127.0.0.1 y el puerto ${impresora.puerto}.`,
  )
}
