import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { DIAGNOSTICS_FILE } from './diagnostics'
import { createAppServer } from './server'

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())))
}

describe('device diagnostics', () => {
  let app: ReturnType<typeof createAppServer> | undefined

  afterEach(async () => {
    await app?.close()
  })

  function create(heartbeatIntervalMs = 60_000) {
    const dataDir = mkdtempSync(join(tmpdir(), 'pos-data-'))
    app = createAppServer({ diagnostics: { dataDir, heartbeatIntervalMs } })
    return { app, dataDir }
  }

  it('answers the WebSocket ping with the same mark', async () => {
    const { app } = create()
    await app.ready()
    const socket = await app.injectWS('/api/diagnostics/ws')

    const response = nextMessage(socket)
    socket.send('ping:1234')

    expect(await response).toBe('pong:1234')
    socket.terminate()
  })

  it('sends numbered heartbeats while the socket is open', async () => {
    const { app } = create(10)
    await app.ready()
    const socket = await app.injectWS('/api/diagnostics/ws')

    expect(await nextMessage(socket)).toBe('heartbeat:1')
    expect(await nextMessage(socket)).toBe('heartbeat:2')
    socket.terminate()
  })

  it('saves each result as a JSON line with the time it was received', async () => {
    const { app, dataDir } = create()

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagnostics',
      payload: { device: 'Pixel 7', secureContext: false },
    })

    expect(res.statusCode).toBe(200)
    const lines = readFileSync(join(dataDir, DIAGNOSTICS_FILE), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0] ?? '')
    expect(entry.data).toEqual({ device: 'Pixel 7', secureContext: false })
    expect(typeof entry.receivedAt).toBe('string')
  })

  it('rejects a body that is not a JSON object', async () => {
    const { app } = create()

    const res = await app.inject({ method: 'POST', url: '/api/diagnostics', payload: [1, 2] })

    expect(res.statusCode).toBe(400)
  })

  it('stops saving when the file reaches the size limit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pos-data-'))
    app = createAppServer({ diagnostics: { dataDir, byteLimit: 50 } })
    const send = () =>
      app?.inject({ method: 'POST', url: '/api/diagnostics', payload: { padding: 'x'.repeat(60) } })

    expect((await send())?.statusCode).toBe(200)
    expect((await send())?.statusCode).toBe(507)
    const lines = readFileSync(join(dataDir, DIAGNOSTICS_FILE), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  it('does not expose the routes without the diagnostics option', async () => {
    app = createAppServer()

    const res = await app.inject({ method: 'POST', url: '/api/diagnostics', payload: {} })

    expect(res.statusCode).toBe(404)
  })
})
