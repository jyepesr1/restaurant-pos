import { vi } from 'vitest'

// The parts of the Workers runtime the live panel's Durable Object uses, faked for the Node tests
// (no workerd): server sockets that record what they send, a `ctx` with the Hibernation API, the
// `WebSocketPair` and `WebSocketRequestResponsePair` globals, and a Response that accepts 101.

export class FakeSocket implements HibernatableWebSocket {
  sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  attachment: unknown = null
  tags: string[] = []
  broken = false
  send(message: string) {
    if (this.broken) throw new Error('socket broken')
    this.sent.push(message)
  }
  close(code?: number, reason?: string) {
    if (this.broken) throw new Error('socket broken')
    this.closed = { code, reason }
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value)
  }
  deserializeAttachment() {
    return this.attachment
  }
}

export class FakeState implements DurableObjectState {
  sockets: FakeSocket[] = []
  autoResponse: { request: string; response: string } | undefined
  acceptWebSocket(ws: HibernatableWebSocket, tags: string[] = []) {
    const socket = ws as FakeSocket
    socket.tags = tags
    this.sockets.push(socket)
  }
  getWebSockets(tag?: string) {
    return this.sockets.filter((s) => !s.closed && (tag === undefined || s.tags.includes(tag)))
  }
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair) {
    this.autoResponse = pair && { request: pair.request, response: pair.response }
  }
}

/** What a 101 looks like here: Node's Response refuses that status; the runtime's carries the socket. */
export interface RuntimeResponse {
  status: number
  webSocket: unknown
  headers: Headers
}

/** Installs the fakes; `vi.unstubAllGlobals()` takes them away. */
export function stubRuntime() {
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = new FakeSocket()
      1 = new FakeSocket()
    },
  )
  vi.stubGlobal(
    'WebSocketRequestResponsePair',
    class {
      request: string
      response: string
      constructor(request: string, response: string) {
        this.request = request
        this.response = response
      }
    },
  )
  // Node's Response refuses status 101: a 101 becomes a plain object with the socket, anything
  // else is a real Response (same prototype, so `instanceof Response` still holds).
  const NodeResponse = globalThis.Response
  function RuntimeResponseCtor(body?: BodyInit | null, init?: ResponseInit): unknown {
    if (init?.status === 101)
      return { status: 101, webSocket: init.webSocket ?? null, headers: new Headers() }
    return new NodeResponse(body, init)
  }
  Object.setPrototypeOf(RuntimeResponseCtor, NodeResponse)
  RuntimeResponseCtor.prototype = NodeResponse.prototype
  vi.stubGlobal('Response', RuntimeResponseCtor)
}
