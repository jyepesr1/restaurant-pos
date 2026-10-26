import { createServer, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { readEscpos } from '@pos/printing'

// A fake network printer: it listens like a thermal printer (port 9100, «RAW») and keeps what it
// receives. Useful for tests and for trying the hub without paper:
//   pnpm --filter @pos/hub test-printer        (port 9100)
//   pnpm --filter @pos/hub test-printer 9101   (another port, for a second printer)
// Each ticket that arrives is shown in the window as text.

export interface TestPrinter {
  port: number
  /** What was received on each connection (one per job). */
  received: Uint8Array[]
  /** When off it stops listening: the hub gets «connection refused», as with a real one off. */
  shutDown(yes: boolean): Promise<void>
  /** Waits until at least `n` jobs were received (what is received arrives a moment later). */
  wait(n: number): Promise<void>
  close(): Promise<void>
}

export function openTestPrinter(
  port = 0,
  onReceive?: (bytes: Uint8Array) => void,
): Promise<TestPrinter> {
  const received: Uint8Array[] = []
  const connections = new Set<Socket>()
  const server = createServer((socket) => {
    connections.add(socket)
    const parts: Buffer[] = []
    socket.on('data', (d) => parts.push(d))
    socket.on('end', () => {
      const bytes = new Uint8Array(Buffer.concat(parts))
      received.push(bytes)
      onReceive?.(bytes)
      socket.end()
    })
    socket.on('error', () => {})
    socket.on('close', () => connections.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const real = typeof address === 'object' && address ? address.port : port
      resolve({
        port: real,
        received,
        shutDown: (yes) =>
          new Promise((end) => {
            if (yes) server.close(() => end())
            else server.listen(real, '127.0.0.1', () => end())
          }),
        wait: async (n) => {
          const limit = Date.now() + 3000
          while (received.length < n && Date.now() < limit)
            await new Promise((r) => setTimeout(r, 10))
        },
        close: () =>
          new Promise((end) => {
            for (const s of connections) s.destroy()
            if (server.listening) server.close(() => end())
            else end()
          }),
      })
    })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 9100)
  const printer = await openTestPrinter(port, (bytes) => {
    const { text } = readEscpos(bytes)
    console.log(`\n${text}\n`)
  })
  console.log(
    `Impresora de prueba lista en 127.0.0.1:${printer.port}. En «Cocina e impresoras» ponle la IP 127.0.0.1 y el puerto ${printer.port}.`,
  )
}
